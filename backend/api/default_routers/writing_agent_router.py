"""写作智能体：选段修改与自我审查、写作偏好记忆。"""

from contextlib import aclosing

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse
from pydantic import Field

from backend.api.contracts import ObjectIdString, StrictRequestModel
from backend.api.default_routers.writing_router import EXPECTED_ERRORS, raise_writing_http_error
from backend.api.error_protocol import sse_error_payload, sse_event
from backend.db.repositories.novel_repository import novel_repo
from backend.services.llm.llm_service import LLMService
from backend.services.novel import claude_memory_import as claude_import
from backend.services.novel import agent_feedback
from backend.services.novel import writing_agent as agent
from backend.services.novel import writing_agent_loop as loop
from backend.services.novel import input_history
from backend.services.novel import writing_workflows as workflows
from backend.services.novel import author_questions
from backend.services.novel.writing_runtime import sse_stream, bounded, close_clients

router = APIRouter(prefix="/api/novels/{novel_id}/writing-agent", tags=["writing-agent"])


class AuthorAnswerInput(StrictRequestModel):
    answer: str = Field(min_length=1, max_length=12000)


@router.post("/questions/{question_id}/answer")
async def answer_question(novel_id: ObjectIdString, question_id: str, req: AuthorAnswerInput):
    try:
        author_questions.submit_answer(novel_id, question_id, req.answer)
        return {"ok": True}
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.get("/workflows")
async def workflow_catalog(novel_id: ObjectIdString):
    return {"workflows": workflows.catalog()}


@router.get("/keyword-search")
async def keyword_search(novel_id: ObjectIdString, q: str = Query(min_length=1, max_length=60)):
    """按关键词筛选章节和章纲：标题、正文、概要里逐字出现的都算。纯文本匹配，不调用模型。

    Returns:
        chapters / outlines：命中的条目 id、命中次数和第一处上下文；没命中的不返回。
    """
    try:
        from backend.db.utils import to_object_id
        from backend.services.novel import book_outline_service as outlines, chapter_text_cache
        from backend.services.novel.chapter_service import ChapterService
        query = q.strip()
        if not query:
            return {"query": "", "chapters": [], "outlines": []}
        await novel_repo.get_novel_by_id(novel_id)

        def match(title: str, *texts: str) -> dict | None:
            body = "\n".join(texts)
            count, index = body.count(query), body.find(query)
            if not count and query not in title:
                return None
            snippet = body[max(0, index - 30):index + len(query) + 30].replace("\n", " ") if index >= 0 else ""
            return {"hits": count, "in_title": query in title, "snippet": snippet}

        rows = await ChapterService.list_chapters(novel_id)
        texts = await chapter_text_cache.contents(rows)
        chapters = [{"chapter_id": str(row["_id"]), **found} for row in rows
                    if (found := match(row.get("title", ""), texts.get(str(row["_id"]), ""), row.get("summary", "") or ""))]
        outline_rows = await outlines.outlines.collection.find(
            {"novel_id": to_object_id(novel_id), "is_deleted": False}, {"title": 1, "content": 1, "summary": 1}).sort("chapter_number", 1).to_list(length=None)
        found_outlines = [{"id": str(row["_id"]), **found} for row in outline_rows
                          if (found := match(row.get("title", ""), row.get("content", "") or "", row.get("summary", "") or ""))]
        return {"query": query, "chapters": chapters, "outlines": found_outlines}
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.get("/outline-style")
async def outline_style(novel_id: ObjectIdString):
    """续写大纲时自动遵守的写法，供“本书大纲”页展示。"""
    from backend.services.novel.author_style import OUTLINE_STYLE
    return {"rules": [line[2:] for line in OUTLINE_STYLE.splitlines() if line.startswith("- ")]}


@router.post("/rewrite/stream")
async def rewrite(novel_id: ObjectIdString, req: agent.RewriteInput):
    try:
        novel = await novel_repo.get_novel_by_id(novel_id)
        notes = await agent.list_memories(novel_id, enabled_only=True) if req.use_memory else []
        await agent.load_linked(novel_id, req)
        if req.target == "chapter":
            from backend.services.novel.agent_feedback import lesson_text
            req._lessons = await lesson_text(novel_id)
        service = LLMService(provider_name=req.provider or None)
        # 支持工具调用的服务走自主循环（自己查资料、送审、交稿）；其余服务走固定的修改→审查流程。
        client = loop.create_client(req.provider, req.model) if workflows.needs_tool_client(req.workflow, req.provider) or (req.book_edit and loop.supports_tools(req.provider)) else None
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)
    await input_history.record(novel_id, "selection_agent", req.instruction,
                               detail={"target": req.target, "selection_preview": req.selection[:120]})

    async def events():
        try:
            autonomous = workflows.is_autonomous(req.workflow)
            if req.workflow != "auto":
                steps = workflows.run(service, loop.selection_task(service, novel["title"], req, notes, autonomous=autonomous), req.workflow,
                                      novel_id, notes, req.provider, req.model, client)
            elif client:
                steps = loop.run_agent(client[0], client[1], client[2], loop.selection_task(service, novel["title"], req, notes, autonomous=autonomous), novel_id, notes)
            else:
                # 没开原生工具调用：先让同一模型按结构化动作协议自己决定；做不到时再走固定的修改→审查流程。
                steps = workflows.structured_auto(service, loop.selection_task(service, novel["title"], req, notes, autonomous=True),
                                                  novel_id, notes, req.provider, req.model)

            async def fallback_aware(source):
                async with aclosing(source) as running:
                    async for step in running:
                        if step["event"] == workflows.FALLBACK:
                            async with aclosing(agent.run_rewrite(service, novel["title"], req, notes)) as fixed:
                                async for item in fixed:
                                    yield item
                            return
                        yield step

            source = fallback_aware(steps)
            if req.deslop and req.target == "chapter":
                if req.focus.strip():
                    yield sse_event("trace", {"kind": "tool", "tool": "deslop", "label": "这次只改选中的片段，去AI味会动到片段以外，本次跳过"})
                else:
                    from backend.services.novel import deslop
                    source = deslop.wrap(source, service, agent.memory_text(notes) if notes else "", agent.generation_options(req))

            async with aclosing(source) as running:
                async for step in running:
                    name = step.pop("event")
                    if name == "done" and (step.get("answer") or step.get("report")):
                        # 作者只是提问：只交付回答。没有修改稿，所以不替换候选稿，也不做设定整理和偏好提炼（省掉这几次模型调用）。
                        yield sse_event(name, step)
                        continue
                    if name == "done" and isinstance(step.get("text"), str):
                        yield sse_event("replacement", {"text": step["text"]})
                    if name == "done" and req.target == "chapter":
                        yield sse_event("progress", {"message": "正在自动检查本次正文中的人物、技能、物品和规则变化…"})
                        try:
                            from backend.services.novel import story_auto
                            result = await story_auto.extract_and_apply(service, novel_id, [{"title": "本次修改正文", "content": step["text"]}], model=req.model)
                            changed = result["created"] + result["updated"]
                            label = (f"自动设定整理完成：人物 {result['characters']} 项、物品 {result['items']} 项、规则 {result['world_rules']} 项"
                                     if changed else "自动检查完成：本次修改没有需要更新的设定")
                            yield sse_event("trace", {"kind": "tool", "tool": "story_auto", "label": label})
                        except Exception:
                            yield sse_event("trace", {"kind": "tool", "tool": "story_auto", "label": "自动设定整理未完成，修改稿已保留", "error": True})
                    if name == "done" and req.use_memory and req.instruction.strip() and "偏好已提议" not in step.get("review_log", {}).get("steps", []):
                        yield sse_event("progress", {"message": "正在整理可复用的作者偏好…"})
                        try:
                            proposals = await bounded(agent.remember_feedback(service, novel_id, req.instruction, notes, req.model), 10)
                        except TimeoutError:
                            proposals = []
                            yield sse_event("trace", {"kind": "tool", "label": "偏好整理超时，已跳过并交付正文", "error": True})
                        for item in proposals:
                            yield sse_event("memory_proposal", item)
                            yield sse_event("trace", {"kind": "tool", "label": "发现可复用写作偏好，等待作者确认：" + item["text"]})
                    yield sse_event(name, step)
        except Exception as exc:
            yield sse_event("error", sse_error_payload(exc, fallback_message="修改失败，原文没有改动"))
        finally:
            await close_clients(client[0] if client else None, getattr(service, "_client", None))

    return StreamingResponse(sse_stream(events(), novel_id=novel_id, output_source="selection_agent", output_title=req.target), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/memories/claude-code")
async def claude_code_memories(novel_id: ObjectIdString):
    try:
        await novel_repo.get_novel_by_id(novel_id)
        return {"items": claude_import.scan(await claude_import.merged_keys(novel_id))}
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.post("/memories/claude-code/import")
async def import_claude_code_memories(novel_id: ObjectIdString, req: claude_import.ImportRequest):
    try:
        await novel_repo.get_novel_by_id(novel_id)
        return await claude_import.import_memories(novel_id, req)
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


class MemoryLinksInput(StrictRequestModel):
    source_novel_ids: list[ObjectIdString] = Field(default_factory=list, max_length=50)


@router.get("/memories/links")
async def memory_links(novel_id: ObjectIdString):
    try:
        await novel_repo.get_novel_by_id(novel_id)
        return {"books": await agent.memory_link_overview(novel_id)}
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.put("/memories/links")
async def set_memory_links(novel_id: ObjectIdString, req: MemoryLinksInput):
    try:
        await novel_repo.get_novel_by_id(novel_id)
        return {"books": await agent.set_memory_links(novel_id, list(dict.fromkeys(req.source_novel_ids)))}
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.get("/memories")
async def memories(novel_id: ObjectIdString):
    try:
        await novel_repo.get_novel_by_id(novel_id)
        return {"memories": await agent.list_memories(novel_id)}
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.post("/memories")
async def create_memory(novel_id: ObjectIdString, req: agent.MemoryCreate):
    try:
        await novel_repo.get_novel_by_id(novel_id)
        return await agent.create_memory(novel_id, req)
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.post("/memories/confirm")
async def confirm_memory(novel_id: ObjectIdString, req: agent.MemoryConfirmation):
    try:
        await novel_repo.get_novel_by_id(novel_id)
        return await agent.confirm_memory(novel_id, req)
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.patch("/memories/{memory_id}")
async def update_memory(novel_id: ObjectIdString, memory_id: ObjectIdString, req: agent.MemoryUpdate):
    try:
        return await agent.update_memory(novel_id, memory_id, req)
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.delete("/memories/{memory_id}")
async def delete_memory(novel_id: ObjectIdString, memory_id: ObjectIdString):
    try:
        await agent.delete_memory(novel_id, memory_id)
        return {"deleted": True}
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.post("/memories/learn")
async def learn(novel_id: ObjectIdString, req: agent.LearnInput):
    try:
        await novel_repo.get_novel_by_id(novel_id)
        service = LLMService(provider_name=req.provider or None)
        return {"proposals": await agent.learn_preferences(service, novel_id, req)}
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


# ---- 给智能体提的意见：直接整理成写作偏好；以前暂存的意见只读 ----

@router.post("/feedback")
async def record_feedback(novel_id: ObjectIdString, req: agent_feedback.FeedbackInput):
    try:
        await novel_repo.get_novel_by_id(novel_id)
        service = LLMService(provider_name=req.provider or None)
        try:
            return await agent_feedback.record(service, novel_id, req)
        finally:
            await close_clients(None, getattr(service, "_client", None))
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.post("/feedback/draft")
async def draft_feedback(novel_id: ObjectIdString, req: agent_feedback.DraftInput):
    """先不保存：按意见和之前几轮商量提出一条偏好草案，供作者确认或继续调整。"""
    try:
        await novel_repo.get_novel_by_id(novel_id)
        service = LLMService(provider_name=req.provider or None)
        try:
            return await agent_feedback.draft(service, novel_id, req)
        finally:
            await close_clients(None, getattr(service, "_client", None))
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.post("/feedback/confirm")
async def confirm_feedback(novel_id: ObjectIdString, req: agent_feedback.ConfirmInput):
    try:
        await novel_repo.get_novel_by_id(novel_id)
        return await agent_feedback.confirm(novel_id, req)
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.post("/memories/{memory_id}/revise")
async def revise_memory(novel_id: ObjectIdString, memory_id: ObjectIdString, req: agent_feedback.ReviseInput):
    try:
        await novel_repo.get_novel_by_id(novel_id)
        service = LLMService(provider_name=req.provider or None)
        try:
            return await agent_feedback.revise(service, novel_id, memory_id, req)
        finally:
            await close_clients(None, getattr(service, "_client", None))
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.get("/feedback")
async def list_feedback(novel_id: ObjectIdString):
    try:
        await novel_repo.get_novel_by_id(novel_id)
        return {"notes": await agent_feedback.list_open(novel_id)}
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.delete("/feedback/{note_id}")
async def delete_feedback(novel_id: ObjectIdString, note_id: ObjectIdString):
    try:
        await agent_feedback.delete(novel_id, note_id)
        return {"deleted": True}
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)
