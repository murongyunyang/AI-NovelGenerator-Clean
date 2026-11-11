"""Explicit, read-only references to other books. Never used as write targets."""
from pydantic import Field, model_validator

from backend.api.contracts import ObjectIdString, StrictRequestModel
from backend.api.error_protocol import DomainApiError


class BookReference(StrictRequestModel):
    novel_id: ObjectIdString
    chapter_ids: list[ObjectIdString] = Field(default_factory=list, max_length=5000)
    outline_ids: list[ObjectIdString] = Field(default_factory=list, max_length=5000)
    use_worldview: bool = False

    @model_validator(mode="after")
    def unique_ids(self):
        if len(set(self.chapter_ids)) != len(self.chapter_ids) or len(set(self.outline_ids)) != len(self.outline_ids):
            raise ValueError("关联章节不能重复")
        return self


def reference_scope(references) -> dict:
    return {ref.novel_id: {"chapters": set(ref.chapter_ids), "outlines": set(ref.outline_ids),
                           "worldview": ref.use_worldview} for ref in references}


async def reference_text(novel_id: str, references, *, catalog: bool = False) -> str:
    from backend.db.repositories.novel_repository import novel_repo
    from backend.services.novel.chapter_service import ChapterService
    from backend.services.novel import book_outline_service as outlines
    parts = []
    seen = set()
    for ref in references:
        if ref.novel_id == novel_id or ref.novel_id in seen:
            raise DomainApiError("BOOK_REFERENCE_INVALID", "参考书不能重复或选择当前书")
        seen.add(ref.novel_id)
        book = await novel_repo.get_novel_by_id(ref.novel_id)
        if not book:
            raise DomainApiError("BOOK_REFERENCE_MISSING", "参考书已不存在", status_code=409)
        chapters = [row for row in await ChapterService.list_chapters(ref.novel_id) if str(row["_id"]) in ref.chapter_ids] if ref.chapter_ids else []
        outline_rows = [row for row in await outlines.directory(ref.novel_id) if row["id"] in ref.outline_ids] if ref.outline_ids else []
        if len(chapters) != len(ref.chapter_ids) or len(outline_rows) != len(ref.outline_ids):
            raise DomainApiError("BOOK_REFERENCE_MISSING", "参考书的关联内容已删除或不属于该书，请重新选择", status_code=409)
        lines = [f"【其他书《{book['title']}》·只读参考 · novel_id={ref.novel_id}】",
                 "只借鉴作者要求的文风、内容结构或大纲结构；此书的人物、设定、剧情不是当前书的事实。禁止修改参考书。"]
        for row in chapters:
            lines.append(f"正文 第{row['chapter_number']}章 · {row['title']}")
            if not catalog:
                lines.append((await ChapterService.get_chapter(str(row["_id"]), novel_id=ref.novel_id))["content"])
        for row in outline_rows:
            lines.append(f"大纲 {row['title']} · outline_id={row['id']}")
            if not catalog:
                lines.append((await outlines.get_chapter(ref.novel_id, row["id"]))["content"])
        if ref.use_worldview:
            lines.append("已关联世界观" if catalog else f"世界观：\n{book.get('worldview') or '（空）'}")
        parts.append("\n".join(lines))
    return "\n\n".join(parts)
