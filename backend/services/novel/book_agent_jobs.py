"""全自动智能体的后台运行：每个任务是服务端的一个 asyncio 任务，切换页面、关闭书签页都不会中断。

每本书同时只跑一个任务；软件关闭时正在跑的任务停在“已中断”，作者可以继续。过程记录逐条存库，实时预览和状态只放在内存里供界面轮询。
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import suppress
from datetime import timedelta
from time import monotonic
from uuid import uuid4

from backend.api.error_protocol import DomainApiError
from backend.db.utils import get_utc_now
from backend.llm.exceptions import LLMAuthError, LLMError, LLMSchemaError
from backend.llm.usage import UsageMeter, usage_meter
from backend.services.novel import book_agent_store as store
from backend.services.novel import input_history
from backend.services.novel import agent_live
from backend.services.novel.agent_concurrency import AdjustableGate
from backend.services.novel.book_agent import AgentSettings, BookAgent, StartInput

logger = logging.getLogger(__name__)

MAX_RUNNING = 4
LIVE_CHARS = 4000
USAGE_SAVE_SECONDS = 10.0
# 检测到任务因连接问题没做完时自动接着做：每次运行最多自动继续这么多次，间隔逐次加长。
AUTO_RESUMES = 3
AUTO_RESUME_DELAYS = (30, 90, 180)
# 软件重新打开时，只自动继续这么久以内中断的任务，免得很久以前放下的任务突然又开始花费用量。
RESUME_WINDOW = timedelta(hours=24)
RESUME_STARTUP_DELAY = 5.0
# 这些错误重试也不会好，交给作者处理。
RETRY_CODES = {"BOOK_AGENT_STALLED"}
# Watchdog：任务有这么久没有任何过程记录、实时预览或状态更新，就判定为卡死并停下，交给作者继续。
# 单步模型调用另有 200 秒的无数据检测；这里兜住模型调用之外的卡死（数据库、工具死等）。
WATCHDOG_INTERVAL = 60.0
WATCHDOG_IDLE_SECONDS = 2700.0
_runners: dict[str, "Runner"] = {}
_background: set[asyncio.Task] = set()
_watchdog: asyncio.Task | None = None


def _retryable(exc: BaseException) -> bool:
    """连接、超时、限流和中转服务的临时错误，以及模型停着不动，换个上下文接着做通常能继续；密钥错误、拒绝和格式问题不重试。"""
    from pymongo.errors import AutoReconnect, NetworkTimeout
    if isinstance(exc, (LLMAuthError, LLMSchemaError)):
        return False
    if isinstance(exc, DomainApiError):
        return exc.code in RETRY_CODES
    return isinstance(exc, (AutoReconnect, NetworkTimeout)) or agent_live.retryable_model_error(exc)


class Runner:
    """一个正在运行的任务：智能体通过它记录过程、更新状态、取作者留言、提问。"""

    def __init__(self, job: dict, seq: int):
        self.job_id, self.novel_id = str(job["_id"]), str(job["novel_id"])
        self.seq = seq
        self.task: asyncio.Task | None = None
        self.stopping = False
        self.stalled = False
        self.last_active = monotonic()
        self.live_label, self.live_text, self.status_text = "", "", ""
        self.mail = asyncio.Event()
        self.mail.set()  # 继续运行时库里可能已有留言，第一次取信时查一次。
        self.question_id = ""
        self.question_reply: asyncio.Future[str] | None = None
        self.reply_lock = asyncio.Lock()
        self.meter = UsageMeter()
        self.base_usage = dict(job.get("usage") or {})
        self.usage_saved = monotonic()
        self.settings = AgentSettings.model_validate(job.get("settings") or {})
        limit = min(self.settings.parallel_agents, agent_live.MAX_CONCURRENT_TURNS)
        self.worker_gate = AdjustableGate(limit)
        self.turn_gate = AdjustableGate(limit)
        self.research_gate = AdjustableGate(limit)

    async def trace(self, event: dict) -> None:
        self.last_active = monotonic()
        self.seq += 1
        await store.append_event(self.job_id, self.seq, event)
        await self._usage()

    def live(self, label: str, text: str = "") -> None:
        self.last_active = monotonic()
        self.live_label, self.live_text = label, text[-LIVE_CHARS:]

    def status(self, text: str) -> None:
        self.last_active = monotonic()
        self.status_text = text

    async def save(self, fields: dict, inc: dict | None = None) -> None:
        await store.update_job(self.job_id, fields, inc)

    async def inbox(self) -> list[str]:
        if not self.mail.is_set():
            return []
        self.mail.clear()
        return await store.take_inbox(self.job_id)

    async def ask(self, question: str, options: list[str] | None = None, multi_select: bool = False) -> str:
        from backend.services.novel.author_questions import normalize_question
        fields = normalize_question(question, options, multi_select)
        question_id = uuid4().hex
        reply = asyncio.get_running_loop().create_future()
        self.question_id, self.question_reply = question_id, reply
        try:
            await store.update_job(self.job_id, {"status": "waiting", "question": fields["question"], "question_id": question_id,
                                                 "question_options": fields["options"], "question_multi_select": fields["multi_select"]})
            self.status("等待作者回复…")
            self.live("", "")
            # 已有 inbox 是普通留言，不能把提问之前的留言误认为作者选了某个方案。
            return await reply
        finally:
            self.question_id, self.question_reply = "", None
            answered = reply.done() and not reply.cancelled()
            if not reply.done():
                reply.cancel()
            # 未回答就停止/关闭时保留问题和选项，恢复任务可据此重新询问；旧 ID 必须失效。
            fields = {"question_id": ""}
            if answered:
                fields.update(question="", question_options=[], question_multi_select=False)
            if not self.stopping:
                fields.update(status="running")
            with suppress(Exception):
                await store.update_job(self.job_id, fields)
            self.status("")

    async def answer(self, text: str, question_id: str | None = None) -> bool:
        """弹窗答复必须与当前问题相符；旧客户端在 waiting 时发送的文本也作为本题答复。"""
        async with self.reply_lock:
            reply = self.question_reply
            if (self.stopping or reply is None or reply.done() or not self.question_id
                    or question_id is not None and question_id != self.question_id):
                if question_id is not None:
                    raise DomainApiError("BOOK_AGENT_QUESTION_EXPIRED", "这个问题已结束或已经回复，请查看当前工作流程。", status_code=409)
                return False
            if not await store.answer_question(self.job_id, self.question_id, text):
                raise DomainApiError("BOOK_AGENT_QUESTION_EXPIRED", "这个问题已结束或已经回复，请查看当前工作流程。", status_code=409)
            # 保存历史失败不应让已经接受的答复卡住任务或要求作者重复选择。
            with suppress(Exception):
                await input_history.record(self.novel_id, "book_agent", text,
                                           detail={"kind": "answer", "job_id": self.job_id, "question_id": self.question_id})
            if self.stopping or reply.done():
                raise DomainApiError("BOOK_AGENT_QUESTION_EXPIRED", "任务已停止，这个问题已结束。", status_code=409)
            reply.set_result(text)
            return True

    def usage(self) -> dict:
        now = self.meter.snapshot()
        base = self.base_usage
        result = {"input": base.get("input", 0) + now["input"], "output": base.get("output", 0) + now["output"],
                  "total": base.get("total", 0) + now["total"], "calls": base.get("calls", 0) + now["calls"],
                  "cache_read": (base.get("cache_read") or 0) + now["cache_read"],
                  "cache_write": (base.get("cache_write") or 0) + now["cache_write"],
                  "estimated": bool(base.get("estimated")) or bool(now["estimated"]),
                  "priced": bool(base.get("priced")) or bool(now["priced"])}
        base_cost, now_cost = base.get("cost"), now.get("cost")
        currencies = {value for value in (base.get("currency"), now.get("currency")) if value}
        if len(currencies) == 1 and (base_cost is not None or now_cost is not None):
            result.update(cost=round((base_cost or 0) + (now_cost or 0), 6), currency=currencies.pop())
        else:
            result.update(cost=None, currency=None)
        return result

    async def _usage(self, force: bool = False) -> None:
        if force or monotonic() - self.usage_saved >= USAGE_SAVE_SECONDS:
            self.usage_saved = monotonic()
            await store.update_job(self.job_id, {"usage": self.usage()})

    def view(self) -> dict:
        return {"live": {"label": self.live_label, "text": self.live_text} if self.live_label or self.live_text else None,
                "status_text": self.status_text, "usage": self.usage()}


def running_ids() -> set[str]:
    return {job_id for job_id, runner in _runners.items() if runner.task and not runner.task.done()}


def _provider(settings: AgentSettings):
    """只读取并校验供应商配置，不创建需要关闭的模型客户端。"""
    from backend.llm.config import get_llm_config
    config = get_llm_config()
    name = settings.provider or config.default_provider
    provider = config.providers.get(name)
    if provider is None or not provider.enabled or not provider.api_key:
        raise DomainApiError("ASSISTANT_PROVIDER_UNAVAILABLE", "所选模型服务不可用，请检查模型设置", status_code=503)
    return config, name, provider


def _client(settings: AgentSettings):
    """原生工具调用优先；服务没开工具调用时用结构化动作协议，模型和服务不变。"""
    from backend.services.llm.llm_service import LLMService
    from backend.services.novel import writing_agent as agent
    from backend.services.novel import writing_agent_loop as loop
    from backend.services.novel.writing_tool_adapter import StructuredToolClient
    config, name, provider = _provider(settings)
    service = LLMService(provider_name=settings.provider or None)
    if loop.supports_tools(settings.provider):
        return service, loop.create_client(settings.provider, settings.model)
    return service, (StructuredToolClient(service, agent.generation_options(settings)), name, settings.model or provider.default_model)


def _check_capacity(novel_id: str) -> None:
    if any(runner.novel_id == novel_id for job_id, runner in _runners.items() if job_id in running_ids()):
        raise DomainApiError("BOOK_AGENT_BUSY", "这本书已经有一个智能体任务在运行，请先停止它或等它完成", status_code=409)
    if len(running_ids()) >= MAX_RUNNING:
        raise DomainApiError("BOOK_AGENT_LIMIT", f"同时最多运行 {MAX_RUNNING} 个智能体任务，请先停止其他书上的任务", status_code=409)


async def _validate_context(novel_id: str, settings: AgentSettings) -> None:
    from backend.services.novel.book_references import reference_text
    await reference_text(novel_id, settings.reference_books, catalog=True)
    from backend.services.novel.chapter_service import ChapterService
    from backend.services.novel import book_outline_service as outlines
    # 未关联的目录不需要读取；参考书已由 reference_text 完整校验，避免重复查库。
    chapters = {str(row["_id"]) for row in await ChapterService.list_chapters(novel_id)} if settings.chapter_ids else set()
    outline_ids = {row["id"] for row in await outlines.directory(novel_id)} if settings.outline_ids else set()
    if not set(settings.chapter_ids) <= chapters or not set(settings.outline_ids) <= outline_ids:
        raise DomainApiError("WRITING_AGENT_OUT_OF_SCOPE", "关联章节已删除或不属于本书，请重新选择关联范围。", status_code=409)


async def start(novel_id: str, req: StartInput) -> dict:
    from backend.db.repositories.novel_repository import novel_repo
    started_at = monotonic()
    await novel_repo.get_novel_by_id(novel_id)
    _check_capacity(novel_id)
    _provider(req.settings)  # 模型不可用时立即报错；不要为预检再创建一套会泄漏的客户端
    await _validate_context(novel_id, req.settings)
    validated_at = monotonic()
    job = await store.create_job(novel_id, req.instruction.strip(), req.settings.model_dump())
    await input_history.record(novel_id, "book_agent", req.instruction, detail={"kind": "start", "job_id": str(job["_id"])})
    await _launch(job, resumed=False)
    logger.info("智能体启动耗时 novel=%s validation=%.3fs launch=%.3fs total=%.3fs",
                novel_id, validated_at - started_at, monotonic() - validated_at, monotonic() - started_at)
    # 历史日志清理不应挡住启动响应，否则前端一直停在“正在启动”。
    task = asyncio.create_task(_prune(novel_id, keep_also=str(job["_id"])), name="book-agent-prune")
    _background.add(task)
    task.add_done_callback(_background.discard)
    return store.serialize_job(job, running_ids())


async def _prune(novel_id: str, keep_also: str = "") -> None:
    """压缩旧任务过程日志；作品改动及其原稿持续保留。"""
    try:
        await store.prune_finished(novel_id, running_ids() | ({keep_also} if keep_also else set()), keep=1)
    except Exception:  # 清理失败不影响任务本身
        logger.warning("清理旧的智能体任务记录失败：%s", novel_id, exc_info=True)


async def _launch(job: dict, *, resumed: bool) -> None:
    runner = Runner(job, await store.last_seq(str(job["_id"])) if resumed else 0)
    runner.status("正在准备任务上下文…")
    _runners[runner.job_id] = runner
    runner.task = asyncio.create_task(_run(runner, job, resumed), name=f"book-agent-{runner.job_id}")
    _ensure_watchdog()


def _ensure_watchdog() -> None:
    """有任务在跑时才存在；任务全部结束后自行退出，空闲时不占任何资源。"""
    global _watchdog
    if _watchdog is None or _watchdog.done():
        _watchdog = asyncio.create_task(_watch(), name="book-agent-watchdog")


def _stalled_runners(now: float) -> list["Runner"]:
    """正在运行、没有在等作者回复、且太久没有任何动静的任务。"""
    return [runner for job_id, runner in list(_runners.items())
            if job_id in running_ids() and not runner.stopping and not runner.stalled
            and runner.status_text != "等待作者回复…" and now - runner.last_active >= WATCHDOG_IDLE_SECONDS]


async def _watch() -> None:
    while running_ids():
        await asyncio.sleep(WATCHDOG_INTERVAL)
        for runner in _stalled_runners(monotonic()):
            logger.warning("智能体任务长时间没有动静，已由 Watchdog 停下：%s", runner.job_id)
            runner.stalled = True
            if runner.task:
                runner.task.cancel()


async def _run(runner: Runner, job: dict, resumed: bool) -> None:
    from backend.db.repositories.novel_repository import novel_repo
    from backend.services.novel import writing_agent as agent
    from backend.services.novel.writing_runtime import close_clients
    # 每个任务一个用量累计器；任务创建时复制了上下文，这里设置只影响本任务及其子任务。
    usage_meter.set(runner.meter)
    input_history.set_actor("book_agent")  # 本任务里保存的章节、章纲都标成智能体修改
    service = client = None
    try:
        settings = runner.settings
        agent_live.task_gate.set(runner.turn_gate)
        agent_live.research_gate.set(runner.research_gate)
        runner.status("正在初始化模型连接…")
        client_started = monotonic()
        service, client = _client(settings)
        logger.info("智能体模型初始化耗时 job=%s duration=%.3fs", runner.job_id, monotonic() - client_started)
        runner.status("正在准备任务上下文…")
        novel = await novel_repo.get_novel_by_id(runner.novel_id)
        notes = await agent.list_memories(runner.novel_id, enabled_only=True) if settings.use_memory else []
        attempt = 0
        while True:
            try:
                report = await BookAgent(runner, novel, job, settings, service, client, notes, resumed=resumed).run()
                break
            except Exception as exc:
                # 检测到任务没做完就断了：改动都在书里，按计划、笔记和书的现状自动接着做。
                if not settings.auto_resume or attempt >= AUTO_RESUMES or not _retryable(exc):
                    raise
                delay = AUTO_RESUME_DELAYS[min(attempt, len(AUTO_RESUME_DELAYS) - 1)]
                attempt += 1
                reason = exc.message if isinstance(exc, DomainApiError) else (str(exc) or type(exc).__name__)[:200]
                await runner.trace({"kind": "tool", "label": f"任务没做完就中断了（{reason}），{delay} 秒后自动接着做（{attempt}/{AUTO_RESUMES}）；改动都已保存", "error": True})
                runner.status(f"{delay} 秒后自动接着做…")
                runner.live("", "")
                await asyncio.sleep(delay)
                await store.update_job(runner.job_id, {"error": ""}, {"runs": 1})
                job, resumed = await store.get_job(runner.novel_id, runner.job_id), True
        await store.update_job(runner.job_id, {"status": "done", "report": report, "question": "", "question_id": "",
                                              "question_options": [], "question_multi_select": False, "error": "", "finished_at": get_utc_now()})
    except asyncio.CancelledError:
        if runner.stalled:
            await _finish(runner, "failed", f"任务超过 {int(WATCHDOG_IDLE_SECONDS // 60)} 分钟没有任何进展，已自动停下。改动都已保存，可以点继续。")
        else:
            await _finish(runner, "stopped" if runner.stopping else "interrupted",
                          "已按作者要求停止" if runner.stopping else "软件关闭，任务已中断")
        raise
    except DomainApiError as exc:
        await _finish(runner, "refused" if exc.code == "WRITING_AGENT_OFF_TOPIC" else "failed", exc.message)
    except Exception as exc:  # 记下原因供作者查看，改动都已保存，可以继续
        logger.exception("全自动智能体任务失败：%s", runner.job_id)
        await _finish(runner, "failed", (str(exc) or type(exc).__name__)[:300])
    finally:
        with suppress(Exception):
            await runner._usage(force=True)
        if client is not None:
            with suppress(Exception):
                await close_clients(client[0], getattr(service, "_client", None))
        _runners.pop(runner.job_id, None)


async def _finish(runner: Runner, status: str, message: str) -> None:
    with suppress(Exception):
        await store.update_job(runner.job_id, {"status": status, "error": message if status != "stopped" else "", "finished_at": get_utc_now()})
        await runner.trace({"kind": "tool", "label": message, "error": status in {"failed", "refused", "interrupted"}})


async def stop(novel_id: str, job_id: str) -> dict:
    row = await store.get_job(novel_id, job_id)
    runner = _runners.get(job_id)
    if runner and runner.task and not runner.task.done():
        runner.stopping = True
        await store.update_job(job_id, {"status": "stopping"})
        runner.task.cancel()
        await asyncio.wait({runner.task}, timeout=10)
    elif row["status"] in store.ACTIVE:
        await store.update_job(job_id, {"status": "stopped"})
    return store.serialize_job(await store.get_job(novel_id, job_id), running_ids())


async def resume(novel_id: str, job_id: str, message: str = "", settings: dict | None = None) -> dict:
    """继续一个已停止、中断、失败或已完成的任务；可附一句新要求，也可以换模型、思考强度和审查方式。
    改动都在书里，智能体从计划、笔记和书的现状接着做。"""
    row = await store.get_job(novel_id, job_id)
    if job_id in running_ids():
        raise DomainApiError("BOOK_AGENT_RUNNING", "这个任务正在运行", status_code=409)
    if row["status"] == "refused":
        raise DomainApiError("BOOK_AGENT_REFUSED", "这个任务与写小说无关，不能继续", status_code=409)
    _check_capacity(novel_id)
    merged = AgentSettings.model_validate({**(row.get("settings") or {}), **(settings or {})})
    _provider(merged)
    await _validate_context(novel_id, merged)
    if message.strip():
        await store.push_inbox(job_id, message.strip())
        await input_history.record(novel_id, "book_agent", message, detail={"kind": "resume", "job_id": job_id})
    previous = row.get("settings") or {}
    changed_scope = any(previous.get(key) != merged.model_dump()[key] for key in ("chapter_ids", "outline_ids", "use_worldview", "reference_books"))
    # 缩小范围后，旧工作笔记/留言可能包含已经取消关联的原文，不能再交给模型。
    reset = {"notes": "", "plan": [], "messages": [], "question": "", "question_options": [], "question_multi_select": False,
             "coverage": [], "conversation_checkpoint": None} if changed_scope else {}
    await store.update_job(job_id, {"status": "running", "error": "", "finished_at": None, "settings": merged.model_dump(),
                                   "question_id": "", **reset}, {"runs": 1})
    await _launch(await store.get_job(novel_id, job_id), resumed=True)
    return store.serialize_job(await store.get_job(novel_id, job_id), running_ids())


async def set_concurrency(novel_id: str, job_id: str, parallel_agents: int) -> dict:
    await store.get_job(novel_id, job_id)
    await store.update_job(job_id, {"settings.parallel_agents": parallel_agents})
    runner = _runners.get(job_id)
    if runner is not None:
        runner.settings.parallel_agents = parallel_agents
        limit = min(parallel_agents, agent_live.MAX_CONCURRENT_TURNS)
        runner.worker_gate.resize(limit)
        runner.turn_gate.resize(limit)
        runner.research_gate.resize(limit)
        await runner.trace({"kind": "tool", "label": f"作者将并发上限调整为 {parallel_agents}；进行中的请求保留，后续请求按新上限调度"})
    return store.serialize_job(await store.get_job(novel_id, job_id), running_ids())


async def post_message(novel_id: str, job_id: str, text: str, question_id: str | None = None) -> dict:
    """运行中留言或回答智能体的提问；任务没在运行时留言会在继续时交给它。"""
    row = await store.get_job(novel_id, job_id)
    text = text.strip()
    if not text or len(text) > 12000:
        raise DomainApiError("BOOK_AGENT_EMPTY_MESSAGE", "请先选择选项或输入回复，回复最多 12000 字。", status_code=422)
    runner = _runners.get(job_id)
    if question_id is not None:
        if runner is None or not runner.task or runner.task.done():
            raise DomainApiError("BOOK_AGENT_QUESTION_EXPIRED", "这个问题已结束，请继续任务后查看新的提问。", status_code=409)
        await runner.answer(text, question_id)
        return {"ok": True, "delivered": True}
    if runner is not None and row["status"] == "waiting" and await runner.answer(text):
        return {"ok": True, "delivered": True}
    await store.push_inbox(job_id, text)
    await input_history.record(novel_id, "book_agent", text, detail={"kind": "message", "job_id": job_id})
    if runner:
        runner.mail.set()
    return {"ok": True, "delivered": bool(runner)}


async def undo(novel_id: str, job_id: str, change_id: str) -> dict:
    if novel_id in active_novels():
        raise DomainApiError("BOOK_AGENT_UNDO_RUNNING", "请先停止本书正在运行的智能体，再撤销改动，避免它继续覆盖恢复的内容。", status_code=409)
    change = await store.undo_change(novel_id, job_id, change_id)
    runner = _runners.get(job_id)
    if runner:
        # 告诉正在运行的智能体，免得它接着在已撤销的内容上写。
        await store.push_inbox(job_id, f"作者撤销了你的一处改动：{change['title'] or change['kind']}（{change['action']}）。请以书的现状为准，不要重做这处改动。")
        runner.mail.set()
    return change


async def undo_all(novel_id: str, job_id: str) -> dict:
    if novel_id in active_novels():
        raise DomainApiError("BOOK_AGENT_UNDO_RUNNING", "请先停止本书正在运行的智能体，再撤销整次任务。", status_code=409)
    return await store.undo_all(novel_id, job_id)


async def view(novel_id: str, job_id: str, after: int = 0, changes_seen: str = "") -> dict:
    """任务详情。changes_seen 是界面上一次拿到的改动指纹；没变就不再返回整份改动列表（长任务里它是轮询最大的一块）。"""
    row = await store.get_job(novel_id, job_id)
    events, more = await store.read_events(job_id, after, tail=None if after else store.EVENT_PAGE)
    job = store.serialize_job(row, running_ids())
    runner = _runners.get(job_id)
    if runner and job_id in running_ids():
        job.update(runner.view())
    else:
        job["live"] = None
    signature = await store.changes_signature(job_id)
    changes = None if changes_seen and changes_seen == signature else [store.serialize_change(item) for item in await store.list_changes(job_id, brief=True)]
    return {"job": job, "events": events, "more": more, "changes": changes, "changes_signature": signature}


async def list_jobs(novel_id: str) -> list[dict]:
    running = running_ids()
    return [store.serialize_job(row, running) for row in await store.list_jobs(novel_id)]


def active_novels() -> list[str]:
    return sorted({runner.novel_id for job_id, runner in _runners.items() if job_id in running_ids()})


async def shutdown() -> None:
    """软件关闭：停下所有任务，状态记为“已中断”，下次打开可以继续。"""
    for task in list(_background) + ([_watchdog] if _watchdog else []):
        task.cancel()
    tasks =[runner.task for runner in _runners.values() if runner.task and not runner.task.done()]
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.wait(tasks, timeout=10)


async def resume_unfinished() -> list[str]:
    """软件打开后自动接着做上次没做完的任务（作者手动停止、已完成、出错的不算）。

    服务启动时持有用户数据目录的独占锁，同一份数据只有一个后端在跑，所以这时库里仍是“运行中”的任务一定是上次关闭时留下的。
    Returns:
        自动继续的任务 id。
    """
    resumed: list[str] = []
    for row in await store.list_resumable(get_utc_now() - RESUME_WINDOW):
        job_id, novel_id = str(row["_id"]), str(row["novel_id"])
        if job_id in running_ids():
            continue
        if "chapter_ids" not in (row.get("settings") or {}):
            await store.update_job(job_id, {"status": "interrupted", "error": "此旧任务尚未设置关联范围，请勾选前文和大纲后继续。"})
            continue
        try:
            _check_capacity(novel_id)
            _provider(AgentSettings.model_validate(row.get("settings") or {}))
        except DomainApiError as exc:
            logger.info("不自动继续智能体任务 %s：%s", job_id, exc.message)
            continue
        await store.update_job(job_id, {"status": "running", "error": "", "finished_at": None,
                                      "question_id": ""}, {"runs": 1})
        job = await store.get_job(novel_id, job_id)
        await _launch(job, resumed=True)
        runner = _runners.get(job_id)
        if runner:
            await runner.trace({"kind": "tool", "label": "软件重新打开，检测到任务没有做完，自动接着做"})
        resumed.append(job_id)
    return resumed


def schedule_resume() -> None:
    """启动完成后在后台自动继续未完成的任务，不拖慢启动。"""
    async def later():
        await asyncio.sleep(RESUME_STARTUP_DELAY)
        try:
            ids = await resume_unfinished()
            if ids:
                logger.info("已自动继续 %d 个未完成的智能体任务", len(ids))
        except Exception:
            logger.exception("自动继续未完成的智能体任务失败")
    task = asyncio.create_task(later(), name="book-agent-resume")
    _background.add(task)
    task.add_done_callback(_background.discard)
