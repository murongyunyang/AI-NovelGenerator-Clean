"""简洁续写、前文概要和可选人物设定生成。"""

from contextlib import aclosing

from fastapi import APIRouter, Header, File, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import Field

from backend.api.contracts import ObjectIdString, StrictRequestModel
from backend.llm.generation_options import ReasoningEffort
from backend.api.error_protocol import DomainApiError, sse_error_payload, sse_event
from backend.api.default_routers.writing_router import EXPECTED_ERRORS, raise_writing_http_error
from backend.services.llm.llm_service import LLMService
from backend.services.novel.chapter_contract import ChapterReadV2, serialize_chapter
from backend.services.novel.continuation_service import ContinuationInput, ContinuationSave, prepare_continuation, save_continuation, continuation_plan
from backend.services.novel import outline_coverage
from backend.services.novel.continuation_review import review_continuation
from backend.services.novel.output_filter import stream_prose, clean_prose_output
from backend.services.novel.plot_summary_output import generate_plot_summary
from backend.services.novel import writing_agent_loop as loop
from backend.services.novel import input_history
from backend.services.novel import writing_workflows as workflows
from backend.services.novel.writing_agent import list_memories, memory_text, generation_options, ANSWER_MARKER_RULE, answer_text, undecided
from backend.services.novel.writing_runtime import sse_stream, close_clients

router = APIRouter(prefix="/api/novels/{novel_id}/continuation", tags=["continuation"])


class DeslopInput(StrictRequestModel):
    text: str = Field(min_length=1)
    requirements: str = ""
    provider: str = Field(default="", max_length=100)
    model: str = Field(default="", max_length=300)
    reasoning_effort: ReasoningEffort | None = None
    max_rounds: int = Field(default=1, ge=1, le=3)


@router.post("/deslop/stream")
async def deslop_only(novel_id: ObjectIdString, req: DeslopInput):
    """独立去痕：只发送原稿、去痕方法和本次要求，不读写偏好或进入写作审查。"""
    from backend.db.repositories.novel_repository import novel_repo
    from backend.services.novel import deslop
    try:
        await novel_repo.get_novel_by_id(novel_id)
        if not req.text.strip():
            raise DomainApiError("DESLOP_EMPTY_TEXT", "请先输入需要去痕的正文")
        service = LLMService(provider_name=req.provider or None)
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)

    async def events():
        try:
            async with aclosing(deslop.polish(service, req.text, req.requirements, generation_options(req), max_rounds=req.max_rounds)) as steps:
                async for item in steps:
                    name = item["event"]
                    payload = {key: value for key, value in item.items() if key != "event"}
                    yield sse_event("done" if name == "_deslop" else name, payload)
        except Exception as exc:
            yield sse_event("error", sse_error_payload(exc, fallback_message="去痕失败，原稿已保留"))
        finally:
            await close_clients(getattr(service, "_client", None))

    return StreamingResponse(sse_stream(events(), usage_events=False, novel_id=novel_id, output_source="deslop"), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


async def _record_input(novel_id: str, req: ContinuationInput) -> None:
    """记下作者为这次生成写的内容；只选章节的概要生成没有作者文字，不记。"""
    if req.action == "outline":
        await input_history.record(novel_id, "outline", input_history.requirement_part(req.outline),
                                   detail={"reference_count": len(req.outline_chapter_ids or [])})
        return
    parts = [("本章大纲", req.outline)]
    if req.action == "write":
        parts += [("标题", req.title), ("审查要求", req.review_requirements)]
    elif req.action == "materials":
        parts += [("素材要求", req.materials)]
    else:
        return
    text = "\n\n".join(f"【{label}】\n{value.strip()}" for label, value in parts if value and value.strip())
    await input_history.record(novel_id, "continuation" if req.action == "write" else "materials", text,
                               detail={"target_words": req.target_words} if req.target_words else None)


@router.post("/outline/import")
async def import_outline(novel_id: ObjectIdString, file: UploadFile = File(...)):
    import asyncio
    from backend.db.repositories.novel_repository import novel_repo
    from backend.services.novel.import_parser import load_document, ImportParseError, MAX_FILE_BYTES
    try:
        await novel_repo.get_novel_by_id(novel_id)
        raw = await file.read(MAX_FILE_BYTES + 1)
        if len(raw) > MAX_FILE_BYTES:
            raise DomainApiError("OUTLINE_FILE_TOO_LARGE", "大纲文件过大，请分批导入", status_code=413)
        text, _ = await asyncio.to_thread(load_document, file.filename or "", raw)
        return {"text": text}
    except ImportParseError as exc:
        raise DomainApiError("OUTLINE_IMPORT_FAILED", str(exc), status_code=422) from exc
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.post("/stream")
async def generate(novel_id: ObjectIdString, req: ContinuationInput):
    try:
        prompt, basis = await prepare_continuation(novel_id, req)
        plan = await continuation_plan(novel_id, req)
        preferences, notes = "", []
        if req.use_memory and req.action in {"write", "outline"}:
            notes = await list_memories(novel_id, enabled_only=True)
            if notes:
                # 整理后的偏好全文不长，写作和审稿都给全文；只看标题会误读规则。超出预算的部分仍只列标题，可用 read_memory 读取。
                preferences = memory_text(notes)
                prompt += f"\n\n【作者的自定义写作偏好（按任务选用，当前要求优先）】\n{preferences}"
        if req.action == "write":
            from backend.services.novel.agent_feedback import lesson_text
            lessons = await lesson_text(novel_id)
            if lessons:
                prompt += f"\n\n【以往的经验（作者的意见里反复出现过的问题，写作时注意避免）】\n{lessons}"
        service = LLMService(provider_name=req.provider or None)
        # 写正文时，支持工具调用的服务走自主循环：自己查资料、写草稿、送审、局部修改后交稿。
        tool_action = req.action == "write" or (req.action == "outline" and req.book_edit)
        client = loop.create_client(req.provider, req.model) if tool_action and (workflows.needs_tool_client(req.workflow, req.provider) or (req.book_edit and loop.supports_tools(req.provider))) else None
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)
    await _record_input(novel_id, req)

    async def events():
        async def deliver(payload: dict):
            # 先交付并归档作品，后续附加整理即使被取消也不能丢稿。
            if req.action == "write":
                yield sse_event("replacement", {"text": payload["text"]})
            if req.action == "write" and req.deslop and payload["text"].strip():
                from backend.services.novel import deslop
                async with aclosing(deslop.polish(service, payload["text"], preferences, generation_options(req))) as polishing:
                    async for item in polishing:
                        name = item.pop("event")
                        if name == "_deslop":
                            payload = {**payload, "text": item["text"], "review_log": {**(payload.get("review_log") or {}), "deslop": item["log"]}}
                        else:
                            yield sse_event(name, item)
            if req.action == "write":
                yield sse_event("progress", {"message": "正文已完成，正在自动整理人物、技能、物品和规则…"})
                try:
                    from backend.services.novel import story_auto
                    result = await story_auto.extract_and_apply(service, novel_id, [{"title": req.title or "本次生成正文", "content": payload["text"]}], model=req.model)
                    changed = result["created"] + result["updated"]
                    label = (f"自动设定整理完成：人物 {result['characters']} 项、物品 {result['items']} 项、规则 {result['world_rules']} 项"
                             if changed else "自动检查完成：本次正文没有需要新增或更新的设定")
                    yield sse_event("trace", {"kind": "tool", "tool": "story_auto", "label": label})
                except Exception:
                    # 自动整理是附加服务，失败不影响正文交付；可在人设页选章重试。
                    yield sse_event("trace", {"kind": "tool", "tool": "story_auto", "label": "自动设定整理未完成，正文已保留，可在人设页选章重试", "error": True})
            yield sse_event("done", payload)

        yield sse_event("progress", {"basis": basis})
        text = ""
        try:
            if req.action == "write" or (req.action == "outline" and req.book_edit):
                task = (loop.outline_task(service, prompt, req, notes) if req.action == "outline" else
                        loop.chapter_task(service, prompt, req, preferences, autonomous=workflows.is_autonomous(req.workflow), plan=plan))
                if req.workflow != "auto":
                    steps = workflows.run(service, task, req.workflow, novel_id, notes, req.provider, req.model, client)
                elif client:
                    steps = loop.run_agent(client[0], client[1], client[2], task, novel_id, notes)
                else:
                    # 没开原生工具调用：先让同一模型按结构化动作协议自己决定；第一步就做不到时落到下面原来的固定流程。
                    steps = workflows.structured_auto(service, task, novel_id, notes, req.provider, req.model)
                fell_back = False
                async with aclosing(steps) as running:
                    async for step in running:
                        name = step.pop("event")
                        if name == workflows.FALLBACK:
                            fell_back = True
                            break
                        if name == "done" and (step.get("answer") or step.get("report")):
                            # 作者只是提问：只交付回答，不产生正文，也不做去 AI 味和设定整理。
                            yield sse_event("done", {**step, "text": "", "basis": basis})
                            return
                        if name == "done":
                            async for event in deliver({"text": step["text"], "basis": basis, "review_log": step["review_log"], "steps": step.get("steps", 0)}):
                                yield event
                            return
                        yield sse_event(name, step)
                if not fell_back:
                    return
            if req.action == "summarize":
                async with aclosing(generate_plot_summary(service, prompt, req.model)) as summaries:
                    async for event in summaries:
                        if "text" in event:
                            text = event["text"]
                        else:
                            yield sse_event("progress", event)
                yield sse_event("delta", {"text": text})
                yield sse_event("done", {"text": text, "basis": basis, "review_log": None})
                return
            options = generation_options(req)
            system = "你是小说创作助手。依据作者提供的前文事实和后续大纲完成指定任务。只输出作品，不输出任务复述、写作计划、思考过程或英文工作说明。"
            # 续写正文时作者可能只是在要求里提问：开头是回答标记就只回答，不交付正文。
            answering = None if req.action == "write" else False
            async with aclosing(stream_prose(service, prompt, system + (ANSWER_MARKER_RULE if req.action == "write" else ""), options)) as chunks:
                async for chunk in chunks:
                    if not chunk:
                        continue
                    text += chunk
                    if answering is None:
                        if undecided(text):
                            continue
                        answering, chunk = answer_text(text) is not None, text
                    if not answering:
                        yield sse_event("delta", {"text": chunk})
            if answering:
                yield sse_event("done", {"text": "", "answer": answer_text(text), "basis": basis,
                                         "review_log": {"passed": None, "rounds": [], "stopped_reason": "已回答作者的问题，没有写正文"}})
                return
            if answering is None and text:
                yield sse_event("delta", {"text": text})
            if not text.strip():
                raise DomainApiError("CONTINUATION_EMPTY_OUTPUT", "模型没有返回正文，请重试或检查模型配置", status_code=502)
            coverage = None
            if req.action == "write" and plan.strip():
                # 没写到大纲的结束点就接着写，再进入审查。
                checker = outline_coverage.make_checker(service, plan, options, req.target_words)
                async with aclosing(outline_coverage.extend_until_covered(service, prompt, text, checker, system, options)) as extending:
                    async for event in extending:
                        name = event.pop("event")
                        if name == "_covered":
                            text, coverage = event["text"], event["coverage"]
                        else:
                            yield sse_event(name, event)
            review_log = None
            if req.action == "write" and req.review_rounds:
                async with aclosing(review_continuation(service, text, prompt, req, preferences)) as reviews:
                    async for event in reviews:
                        if event["status"] == "done":
                            text = clean_prose_output(event["outputs"]["content"])
                            review_log = event["outputs"]["review_log"]
                        elif "replacement" in event:
                            yield sse_event("replacement", {"text": clean_prose_output(event["replacement"])})
                        else:
                            yield sse_event("progress", {key: event[key] for key in ("message", "review_round", "review_stage") if key in event})
            if coverage is not None:
                review_log = {**(review_log or {"passed": None, "stopped_reason": "", "rounds": []}), "coverage": coverage}
            async for event in deliver({"text": text, "basis": basis, "review_log": review_log}):
                yield event
        except Exception as exc:
            yield sse_event("error", sse_error_payload(exc, fallback_message="生成失败，已收到的文字保留在草稿中"))
        finally:
            await close_clients(client[0] if client else None, getattr(service, "_client", None))

    # 只有续写正文的前端声明了接受 trace 事件；概要、大纲、设定生成收到未声明的事件会报协议错误，不能发用量事件。
    return StreamingResponse(sse_stream(events(), usage_events=req.action == "write", novel_id=novel_id,
                             output_source="continuation" if req.action == "write" else req.action, output_title=req.title),
                             media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/save", response_model=ChapterReadV2)
async def save(novel_id: ObjectIdString, req: ContinuationSave, idempotency_key: str = Header(..., alias="Idempotency-Key")):
    try:
        return serialize_chapter(await save_continuation(novel_id, req, idempotency_key))
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)
