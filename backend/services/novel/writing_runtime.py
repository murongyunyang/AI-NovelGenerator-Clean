"""写作请求的等待上限、心跳与取消；心跳不会延长模型的执行期限。"""

import asyncio
import json
from contextlib import suppress, aclosing
from time import monotonic

from backend.api.error_protocol import DomainApiError, sse_event, sse_error_payload
from backend.llm.usage import UsageMeter, usage_meter

HEARTBEAT_SECONDS = 5.0
# 必须长于 bounded 的单步上限：单步超时由循环记录并改走其他动作，静默上限只兜底真正卡死的请求。
IDLE_SECONDS = 240.0
# 智能体不再限定步数，总时长只作为防失控的兜底；每次有进展都会重置静默计时。
TOTAL_SECONDS = 7200.0


async def watch(steps, *, heartbeat=None, idle=None, total=None, meter: UsageMeter | None = None, usage_events: bool = True):
    """在同一生产任务中消费整个流，保持日志 ContextVar 与模型会话上下文一致。

    meter 不为空时，done 事件附带最终用量。usage_events 为真时，用量变化还会作为 trace/usage 事件实时发出；
    前端只有声明接受 trace 的请求才能收到它们，其余请求（概要、大纲、设定生成）必须关闭。这些事件不算模型进展，不重置静默计时。
    """
    heartbeat = HEARTBEAT_SECONDS if heartbeat is None else heartbeat
    idle = IDLE_SECONDS if idle is None else idle
    total = TOTAL_SECONDS if total is None else total
    started = last = monotonic()
    waiting_since = None
    waiting_id = None
    status = "正在准备写作任务…"
    sent_usage = -1
    queue = asyncio.Queue(maxsize=1)

    async def produce():
        try:
            async with aclosing(steps):
                async for event in steps:
                    terminal = event.get("event") in {"done", "error"}
                    await queue.put(("event", event))
                    if terminal:
                        break
        except Exception as exc:
            await queue.put(("error", exc))
        await queue.put(("end", None))

    producer = asyncio.create_task(produce())
    pending = None
    try:
        while True:
            if pending is None:
                pending = asyncio.create_task(queue.get())
            now = monotonic()
            # 模型服务的流仍有数据到达（哪怕没有可见文字）就不算静默。
            quiet_since = max(last, meter.touched) if meter is not None else last
            # 等待作者不是模型静默，也不消耗任务执行期限；仍发心跳保持连接。
            remaining = heartbeat if waiting_since is not None else min(idle - (now - quiet_since), total - (now - started))
            if remaining <= 0:
                raise DomainApiError("WRITING_TIMEOUT", f"{status}等待超时，已停止本次请求；已收到的稿件保留，可以调整模型后重试。", status_code=504)
            done, _ = await asyncio.wait({pending}, timeout=min(heartbeat, remaining))
            if meter is not None and usage_events and meter.version != sent_usage:
                sent_usage = meter.version
                yield {"event": "trace", "kind": "usage", **meter.snapshot()}
            if not done:
                message = "等待作者选择，回复后继续当前任务…" if waiting_since is not None else f"{status}（已等待 {int(monotonic() - last)} 秒，可随时停止）"
                yield {"event": "progress", "message": message, "heartbeat": True}
                continue
            kind, event = pending.result()
            if kind == "end":
                return
            if kind == "error":
                raise event
            pending = None
            last = monotonic()
            if event.get("event") == "author_question":
                if waiting_since is None:
                    waiting_since = last
                waiting_id = event.get("id")
                status = "等待作者选择，回复后继续当前任务…"
            elif event.get("event") == "author_answered" and event.get("id") == waiting_id:
                if waiting_since is not None:
                    started += last - waiting_since
                waiting_since, waiting_id = None, None
                status = "已收到作者选择，继续工作…"
            elif event.get("event") == "progress" and event.get("message"):
                status = event["message"]
            elif event.get("event") in {"delta", "replacement"}:
                status = "正在生成作品…"
            terminal = event.get("event") in {"done", "error"}
            if meter is not None and event.get("event") == "done":
                event = {**event, "usage": meter.snapshot()}
            yield event
            if terminal:
                return
    finally:
        if pending is not None:
            pending.cancel()
            with suppress(asyncio.CancelledError, Exception):
                await pending
        producer.cancel()
        with suppress(asyncio.CancelledError, Exception):
            await producer


async def bounded(awaitable, seconds=180):
    """一次模型/工具动作的整体上限，包括底层重试。"""
    async with asyncio.timeout(seconds):
        return await awaitable


async def close_clients(*clients):
    for client in clients:
        http = getattr(client, "_http_client", None)
        if http is not None:
            with suppress(Exception):
                await bounded(http.aclose(), 5)


async def sse_stream(source, *, usage_events: bool = True, novel_id: str | None = None,
                     output_source: str = "continuation", output_title: str = ""):
    from backend.services.novel.output_history import OutputJournal
    journal = OutputJournal(novel_id, output_source, output_title) if novel_id else None
    async def decoded():
        try:
            async for frame in source:
                name = next(line[7:] for line in frame.splitlines() if line.startswith("event: "))
                data = json.loads("\n".join(line[6:] for line in frame.splitlines() if line.startswith("data: ")))
                yield {**data, "event": name}
        finally:
            await source.aclose()
    meter = UsageMeter()
    # 必须在 watch 创建生产任务之前设置：任务创建时复制当前上下文，模型调用才记到这个累计器上。
    token = usage_meter.set(meter)
    try:
        async with aclosing(watch(decoded(), meter=meter, usage_events=usage_events)) as monitored:
            async for event in monitored:
                if journal:
                    journal.feed(event)
                name = event.pop("event")
                yield sse_event(name, event)
    except DomainApiError as exc:
        yield sse_event("error", sse_error_payload(exc, fallback_message="写作请求已停止，已收到的稿件保留"))
    finally:
        if journal:
            journal.close()
        # 异步生成器可能在别的上下文里被收尾，重置失败不影响本次请求。
        with suppress(ValueError):
            usage_meter.reset(token)
