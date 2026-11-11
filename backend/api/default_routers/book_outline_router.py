"""每本书的章纲目录、独立编辑及多文件拖入预览／追加导入。"""

import asyncio
from contextlib import aclosing
from fastapi import APIRouter, File, Form, Header, UploadFile, Query
from fastapi.responses import StreamingResponse
from pydantic import Field, field_validator
from backend.api.contracts import ObjectIdString, StrictRequestModel
from backend.api.default_routers.writing_router import EXPECTED_ERRORS, raise_writing_http_error
from backend.api.error_protocol import DomainApiError, sse_error_payload, sse_event
from backend.db.repositories.novel_repository import novel_repo
from backend.services.novel import book_outline_service as service
from backend.services.novel.import_parser import MAX_FILE_BYTES, MAX_IMPORT_FILES, ParsedChapter
from backend.services.llm.llm_service import LLMService
from backend.services.novel.plot_summary_output import generate_plot_summary

router = APIRouter(prefix="/api/novels/{novel_id}/outline-chapters", tags=["book-outline"])


class OutlineContent(StrictRequestModel):
    title: str = Field(min_length=1)
    content: str = ""

    @field_validator("title")
    @classmethod
    def title_not_empty(cls, value):
        if not value.strip():
            raise ValueError("请填写大纲章节标题")
        return value.strip()


class OutlineUpdate(OutlineContent):
    expected_version: int = Field(ge=1)


class OutlineVersion(StrictRequestModel):
    expected_version: int = Field(ge=1)


class OutlineSummary(OutlineVersion):
    summary: str


class OutlineSummaryGenerate(OutlineVersion):
    content: str | None = None
    provider: str = Field(default="", max_length=100)
    model: str = Field(default="", max_length=300)


@router.get("/{chapter_id}/revisions")
async def history(novel_id: ObjectIdString, chapter_id: ObjectIdString, before: int | None = Query(default=None, ge=1)):
    try:
        return await service.history(novel_id, chapter_id, before)
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.get("/{chapter_id}/revisions/{version}")
async def revision(novel_id: ObjectIdString, chapter_id: ObjectIdString, version: int):
    try:
        return await service.get_revision(novel_id, chapter_id, version)
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.post("/{chapter_id}/revisions/{version}/restore")
async def restore_revision(novel_id: ObjectIdString, chapter_id: ObjectIdString, version: int, req: OutlineVersion):
    try:
        return await service.restore_revision(novel_id, chapter_id, version, req.expected_version)
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.post("/initialize")
async def initialize(novel_id: ObjectIdString):
    try:
        await service.initialize(novel_id)
        return {"chapters": await service.directory(novel_id)}
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.get("")
async def directory(novel_id: ObjectIdString):
    try:
        return {"chapters": await service.directory(novel_id)}
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


async def _parse(novel_id, files, mode):
    await novel_repo.get_novel_by_id(novel_id)
    if len(files) > MAX_IMPORT_FILES:
        raise DomainApiError("OUTLINE_TOO_MANY_FILES", f"一次最多 {MAX_IMPORT_FILES} 个文件，请分批导入", status_code=422)
    documents, size = [], 0
    for file in files:
        raw = await file.read(MAX_FILE_BYTES - size + 1)
        size += len(raw)
        if size > MAX_FILE_BYTES:
            raise DomainApiError("OUTLINE_UPLOAD_TOO_LARGE", f"文件合计超过 {MAX_FILE_BYTES >> 20} MB，请分批导入", status_code=413)
        documents.append((file.filename or "", raw))
    return await asyncio.to_thread(service.parse_outline_files, documents, mode)


@router.post("/import/preview")
async def preview(novel_id: ObjectIdString, files: list[UploadFile] = File(..., alias="file"), mode: str = Form("auto")):
    try:
        chapters = await _parse(novel_id, files, mode)
        return {"chapter_count": len(chapters), "word_count": sum(len(c.content) for c in chapters),
                "chapters": [{"title": c.title, "word_count": len(c.content)} for c in chapters]}
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.post("/import/commit")
async def commit(novel_id: ObjectIdString, files: list[UploadFile] = File(..., alias="file"), mode: str = Form("auto"),
                 idempotency_key: str = Header(..., alias="Idempotency-Key")):
    try:
        return await service.append_chapters(novel_id, await _parse(novel_id, files, mode), idempotency_key)
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.post("")
async def create(novel_id: ObjectIdString, req: OutlineContent, idempotency_key: str = Header(..., alias="Idempotency-Key")):
    try:
        return await service.append_chapters(novel_id, [ParsedChapter(req.title.strip(), req.content)], idempotency_key)
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.post("/from-text")
async def from_text(novel_id: ObjectIdString, req: OutlineContent, idempotency_key: str = Header(..., alias="Idempotency-Key")):
    try:
        if not req.content.strip():
            raise DomainApiError("OUTLINE_EMPTY", "请先填写大纲内容", status_code=422)
        # 几十万字的大纲拆分放到线程里，免得阻塞其他请求和生成流。
        chapters = await asyncio.to_thread(service.split_outline, req.content, req.title)
        return await service.append_chapters(novel_id, chapters, idempotency_key)
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.get("/{chapter_id}")
async def detail(novel_id: ObjectIdString, chapter_id: ObjectIdString):
    try:
        return await service.get_chapter(novel_id, chapter_id)
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.put("/{chapter_id}")
async def update(novel_id: ObjectIdString, chapter_id: ObjectIdString, req: OutlineUpdate):
    try:
        return await service.save_chapter(novel_id, chapter_id, req.expected_version, req.title, req.content)
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.delete("/{chapter_id}")
async def delete(novel_id: ObjectIdString, chapter_id: ObjectIdString, req: OutlineVersion):
    try:
        return await service.set_deleted(novel_id, chapter_id, req.expected_version, True)
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.post("/{chapter_id}/restore")
async def restore(novel_id: ObjectIdString, chapter_id: ObjectIdString, req: OutlineVersion):
    try:
        return await service.set_deleted(novel_id, chapter_id, req.expected_version, False)
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.put("/{chapter_id}/summary")
async def save_summary(novel_id: ObjectIdString, chapter_id: ObjectIdString, req: OutlineSummary):
    try:
        return await service.save_summary(novel_id, chapter_id, req.expected_version, req.summary)
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.post("/{chapter_id}/summary/stream")
async def generate_summary(novel_id: ObjectIdString, chapter_id: ObjectIdString, req: OutlineSummaryGenerate):
    try:
        chapter = await service.get_chapter(novel_id, chapter_id)
        if chapter["version"] != req.expected_version:
            raise DomainApiError("OUTLINE_VERSION_CHANGED", "本章大纲已变更，请保留草稿并重新载入后生成概要", status_code=409)
        content = chapter["content"] if req.content is None else req.content
        if not content.strip():
            raise DomainApiError("OUTLINE_EMPTY", "本章大纲内容为空，请先填写内容再生成概要", status_code=422)
        llm = LLMService(provider_name=req.provider or None)
        prompt = (f"【本章大纲：{chapter['title']}】\n{content}\n\n"
                  "请整理以上本章大纲的剧情概要，用连贯自然的中文压缩计划中的故事，保留主要人物、事件、转折和章末安排。"
                  "忠实保留原文的计划、可能性和未定信息，不把计划当作已发生的前文事实，不新增后续剧情。"
                  "不要写成条目、表格或‘起因／经过／结果’的分项分析。篇幅按内容需要，不设固定字数。"
                  "只输出中文概要，不输出思考、分析过程或英文工作笔记。")
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)

    async def events():
        try:
            async with aclosing(generate_plot_summary(llm, prompt, req.model, planned=True)) as summaries:
                async for event in summaries:
                    if "text" in event:
                        yield sse_event("done", {"text": event["text"], "version": chapter["version"]})
                    else:
                        yield sse_event("progress", event)
        except Exception as exc:
            yield sse_event("error", sse_error_payload(exc, fallback_message="概要生成失败，原有概要草稿已保留"))
        finally:
            # 与续写相同，结束或断开后关闭本次请求创建的模型 HTTP 客户端，避免连接泄漏。
            from backend.services.novel.writing_runtime import close_clients
            await close_clients(getattr(llm, "_client", None))
    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
