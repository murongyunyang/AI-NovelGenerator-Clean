"""智能体的一轮工具对话：在子任务里运行模型调用，把它流式输出的思考、说明和草稿预览实时转成 trace/live 事件。

这样界面不用等整步结束才有动静；同时区分“总时长”和“流上完全没有数据”两种超时，长稿正常流式输出不会被误判卡死。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import weakref
from collections.abc import AsyncIterator, Callable
from contextlib import aclosing, suppress
from contextvars import ContextVar
from time import monotonic

from backend.llm.exceptions import LLMAuthError, LLMRateLimitError, LLMTimeoutError, LLMSchemaError, LLMToolProtocolError, network_retry_delay
from backend.llm.live import live_sink, partial_json_string
from backend.llm.logger import LLMCall
from backend.llm.models import LLMRequest, LLMToolDefinition, LLMToolTurn
from backend.llm.usage import usage_meter
from backend.services.novel.agent_concurrency import AdjustableGate

logger = logging.getLogger(__name__)

LIVE_INTERVAL = 0.35        # 同一通道两次实时更新的最短间隔（秒）
LIVE_TAIL = 4000            # 实时预览只保留尾部这么多字
TURN_SECONDS = 180.0        # 不能实时报告进度的服务：单步上限，必须小于请求的静默上限
LIVE_TURN_SECONDS = 900.0   # 能实时报告进度的服务：单步总上限
LIVE_STALL_SECONDS = 200.0  # 能实时报告进度的服务：流上完全没有数据的上限，小于请求的静默上限
# 全进程同时进行的模型调用上限：总控、子智能体、孙智能体、写手和资料员共用。
# 以前默认固定为 4，导致长任务即使把子智能体数调高也只能排队。现在把它作为
# 可由部署环境覆盖的安全上限；任务界面的 parallel_agents 再决定本次任务实际使用多少。
MAX_CONCURRENT_TURNS = max(1, int(os.environ.get("NOVEL_AGENT_MAX_CONCURRENT_TURNS", "16") or 16))

Push = Callable[[dict | None], None]
task_gate: ContextVar[AdjustableGate | None] = ContextVar("novel_agent_task_gate", default=None)
research_gate: ContextVar[AdjustableGate | None] = ContextVar("novel_agent_research_gate", default=None)
_gates: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore]" = weakref.WeakKeyDictionary()


def _gate() -> asyncio.Semaphore:
    """当前事件循环的调用闸门；信号量绑定事件循环，每个循环各建一个。"""
    loop = asyncio.get_running_loop()
    gate = _gates.get(loop)
    if gate is None:
        gate = _gates[loop] = asyncio.Semaphore(MAX_CONCURRENT_TURNS)
    return gate


def should_downgrade(request: LLMRequest, exc: BaseException) -> bool:
    """流式请求出错后是否改用普通请求。

    只有流上一点数据都没收到（服务不能转发流式工具调用）才改。已经收到过数据说明流式可用，
    只是中途断开，改成普通请求反而会让长回复卡在读取超时上，应该保持流式重试。
    """
    if not request.stream or isinstance(exc, (TimeoutError, LLMAuthError, LLMRateLimitError, LLMTimeoutError,
                                              LLMSchemaError, LLMToolProtocolError)):
        return False
    cause = exc.__cause__ or exc
    message = str(cause).lower()
    stream_rejected = (getattr(cause, "status_code", None) in {400, 422} and "stream" in message
                       and any(word in message for word in ("unsupported", "not support", "not allowed", "unknown", "不支持")))
    return not getattr(exc, "stream_activity", 0) and (stream_rejected or retryable_model_error(exc))


def retryable_model_error(exc: BaseException) -> bool:
    """格式、拒绝、模型参数错误不会因等待而恢复；只重试明确的临时故障。"""
    return isinstance(exc, (TimeoutError, LLMRateLimitError)) or network_retry_delay(exc, 0) is not None


def append_user_message(client, history: list[dict] | None, text: str) -> list[dict]:
    """按客户端原生协议追加提醒；测试替身和结构化动作协议使用通用消息格式。"""
    append = getattr(client, "append_user_message", None)
    if append is not None:
        return append(history, text)
    messages = list(history or [])
    return [*messages, {"role": "user", "content": text}]


def retry_delay(failures: int) -> float:
    """第 n 次失败后等多久再试：给中转服务一点恢复时间，又不让作者久等。"""
    return min(2.0 * failures, 8.0)


def make_sink(push: Push, turn_id: str, agent: str = "") -> Callable[[str, str, str], None]:
    """生成给 backend.llm.live 用的接收器：按通道节流，只保留尾部文字；ping 只刷新活动时间。"""
    last: dict[tuple[str, str], float] = {}
    shown: dict[tuple[str, str], str] = {}
    connected = False
    announced_tools: set[str] = set()

    def sink(channel: str, tool: str, text: str) -> None:
        nonlocal connected
        if channel == "ping":
            if not connected:
                connected = True
                push({"event": "progress", "message": "模型连接已建立，正在等待思考或修改内容…"})
            push(None)
            return
        if channel == "args" and tool and tool not in announced_tools:
            announced_tools.add(tool)
            push({"event": "progress", "message": f"模型正在生成工具调用（{tool}），参数收齐后执行…"})
        key, now = (channel, tool), monotonic()
        if key in last and now - last[key] < LIVE_INTERVAL:
            push(None)
            return
        if channel == "args":
            # 正文以外的参数不作为作品展示，但上面仍报告其生成状态。
            text = partial_json_string(text, "text") or "" if tool == "write_draft" else ""
        if not text or shown.get(key) == text:
            push(None)
            return
        last[key], shown[key] = now, text
        event = {"event": "trace", "kind": "live", "id": turn_id, "channel": channel, "text": text[-LIVE_TAIL:]}
        if tool:
            event["tool"] = tool
        if agent:
            event["agent"] = agent
        push(event)

    return sink


async def run_turn(client, request: LLMRequest, tools: list[LLMToolDefinition], *, history, results,
                   provider: str, model: str, turn_id: str, agent: str = "") -> AsyncIterator[dict]:
    """执行一轮工具对话。

    Yields:
        实时 trace 事件；最后一个事件是 {"event": "_turn", "turn": LLMToolTurn}。
    Raises:
        TimeoutError: 整步超时，或流上长时间没有任何数据。其他错误原样抛出。
    """
    live = bool(getattr(client, "live_stream", False)) and request.stream
    limit = LIVE_TURN_SECONDS if live else TURN_SECONDS
    stall = LIVE_STALL_SECONDS if live else TURN_SECONDS
    meter = usage_meter.get()
    queue: asyncio.Queue = asyncio.Queue()
    gate = _gate()
    # 排队等闸门的时间不算这一步的用时，也不算“没有数据”。
    local_gate = task_gate.get()
    if local_gate is not None:
        await local_gate.acquire()
    acquired = False
    try:
        await gate.acquire()
        acquired = True
        # 调用方提前关闭时，内层也要立即关闭，才能及时取消还在进行的模型请求。
        async with aclosing(_run_turn(client, request, tools, history=history, results=results, provider=provider, model=model,
                                      turn_id=turn_id, agent=agent, live=live, limit=limit, stall=stall, meter=meter, queue=queue)) as inner:
            async for event in inner:
                yield event
    finally:
        if acquired:
            gate.release()
        if local_gate is not None:
            local_gate.release()


async def _run_turn(client, request: LLMRequest, tools: list[LLMToolDefinition], *, history, results, provider: str, model: str,
                    turn_id: str, agent: str, live: bool, limit: float, stall: float, meter, queue: asyncio.Queue) -> AsyncIterator[dict]:
    started = activity = monotonic()
    received, first = 0, None

    def push(event: dict | None) -> None:
        nonlocal activity, received, first
        activity = monotonic()
        received += 1
        if first is None:
            first = activity - started
        if meter is not None:
            meter.touch()
        if event is not None:
            queue.put_nowait(event)

    async def call() -> LLMToolTurn:
        # 进入和退出都在这个子任务里完成，日志上下文不会跨任务重置。
        with LLMCall(provider, model, "function_call", use_system_proxy=client.config.use_system_proxy) as call_log:
            turn = await client.tool_turn(request, tools, history=history, results=results)
            call_log.usage = turn.usage
            call_log.finish_reason = turn.finish_reason
            if not (turn.usage.input_tokens or turn.usage.output_tokens or turn.usage.total_tokens) and not getattr(client, "counts_own_usage", False):
                # 有的服务在流式回复里不返回用量：按收到的文字估算，用量统计里会标明是估算值。
                # 结构化动作协议这类自己已经另行统计过用量的客户端不再重复估算。
                call_log.chunks.append(turn.content + "".join(json.dumps(item.arguments, ensure_ascii=False) for item in turn.calls))
            return turn

    # 任务创建时复制当前上下文，所以接收器只需在创建前设置、创建后立即还原，中间没有任何挂起点。
    token = live_sink.set(make_sink(push, turn_id, agent) if live else None)
    try:
        task = asyncio.create_task(call())
    finally:
        live_sink.reset(token)
    getter = None
    try:
        while True:
            if getter is None:
                getter = asyncio.ensure_future(queue.get())
            now = monotonic()
            if now - started >= limit:
                raise TimeoutError(f"模型这一步超过 {int(limit)} 秒仍未完成")
            if now - activity >= stall:
                raise TimeoutError(f"模型 {int(stall)} 秒没有返回任何数据")
            wait = min(limit - (now - started), stall - (now - activity))
            done, _ = await asyncio.wait({task, getter}, timeout=wait, return_when=asyncio.FIRST_COMPLETED)
            if getter in done:
                yield getter.result()
                getter = None
                continue
            if task in done:
                break
        while not queue.empty():
            yield queue.get_nowait()
        yield {"event": "_turn", "turn": task.result()}
    except Exception as exc:
        # 记下流上收到过多少数据：调用方据此判断是服务不支持流式，还是流式中途断开。
        with suppress(Exception):
            exc.stream_activity = received
        raise
    finally:
        for pending in (getter, task):
            if pending is not None and not pending.done():
                pending.cancel()
        for pending in (getter, task):
            if pending is not None:
                with suppress(asyncio.CancelledError, Exception):
                    await pending
        # 首个数据到达的时间和数据次数能区分“中转服务整段缓冲”与“模型确实在慢慢写”。
        logger.info("[智能体单步] turn=%s live=%s 用时=%.1fs 首个数据=%s 数据次数=%d",
                    turn_id, live, monotonic() - started, "无" if first is None else f"{first:.1f}s", received)
