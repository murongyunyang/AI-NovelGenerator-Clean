"""简洁自动设定：选章整理人设，读取人物、物品和规则的统一视图。"""

from typing import Literal

from fastapi import APIRouter
from pydantic import Field, model_validator

from backend.api.contracts import ObjectIdString, StrictRequestModel
from backend.api.default_routers.writing_router import EXPECTED_ERRORS, raise_writing_http_error
from backend.api.error_protocol import DomainApiError
from backend.db.repositories.novel_repository import novel_repo
from backend.services.llm.llm_service import LLMService
from backend.services.novel import story_auto
from backend.services.novel.chapter_service import ChapterService
from backend.services.novel.writing_runtime import close_clients

router = APIRouter(prefix="/api/novels/{novel_id}/story-auto", tags=["story-auto"])


class ExtractInput(StrictRequestModel):
    chapter_ids: list[ObjectIdString] = Field(min_length=1, max_length=100)
    kinds: list[Literal["character", "item", "world_rule"]] = Field(default_factory=lambda: ["character"], min_length=1, max_length=3)
    provider: str = Field(default="", max_length=100)
    model: str = Field(default="", max_length=300)

    @model_validator(mode="after")
    def unique_values(self):
        if len(set(self.chapter_ids)) != len(self.chapter_ids) or len(set(self.kinds)) != len(self.kinds):
            raise ValueError("章节和整理类型不能重复")
        return self


@router.get("/chapters")
async def chapters(novel_id: ObjectIdString):
    await novel_repo.get_novel_by_id(novel_id)
    rows = await ChapterService.list_chapters(novel_id)
    return {"chapters": [{"id": str(row["_id"]), "title": row["title"], "chapter_number": row["chapter_number"],
                          "word_count": row.get("word_count", 0)} for row in rows]}


@router.get("/{kind}")
async def entries(novel_id: ObjectIdString, kind: Literal["character", "item", "world_rule"]):
    try:
        await novel_repo.get_novel_by_id(novel_id)
        return {"entries": await story_auto.list_entries(novel_id, kind)}
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.post("/extract")
async def extract(novel_id: ObjectIdString, req: ExtractInput):
    service = None
    try:
        await novel_repo.get_novel_by_id(novel_id)
        rows = await ChapterService.list_chapters(novel_id)
        selected = set(req.chapter_ids)
        chosen = [row for row in rows if str(row["_id"]) in selected]
        if len(chosen) != len(selected):
            raise DomainApiError("STORY_AUTO_SOURCE_MISSING", "所选章节已变化，请刷新后重选", status_code=409)
        sources = []
        for row in chosen:
            chapter = await ChapterService.get_chapter(str(row["_id"]), novel_id=novel_id)
            sources.append({"title": f"第{row['chapter_number']}章 · {row['title']}", "content": chapter["content"]})
        service = LLMService(provider_name=req.provider or None)
        result = await story_auto.extract_and_apply(service, novel_id, sources, kinds=req.kinds, model=req.model)
        return result
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)
    finally:
        await close_clients(None, getattr(service, "_client", None))
