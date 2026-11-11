"""作者发给智能体的全部指令记录：按书、来源、关键词查看。"""

from fastapi import APIRouter, Query

from backend.api.contracts import ObjectIdString
from backend.api.default_routers.writing_router import EXPECTED_ERRORS, raise_writing_http_error
from backend.db.repositories.novel_repository import novel_repo
from backend.services.novel import input_history

router = APIRouter(prefix="/api/novels/{novel_id}/input-history", tags=["input-history"])


@router.get("")
async def list_history(
    novel_id: ObjectIdString,
    source: str | None = Query(default=None, max_length=40),
    q: str = Query(default="", max_length=200),
    before: ObjectIdString | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    all_books: bool = False,
):
    """时间倒序；before 传上一页最后一条的 id 继续往前翻。"""
    try:
        await novel_repo.get_novel_by_id(novel_id)
        return await input_history.list_entries(novel_id, source=source or None, query=q, before=before, limit=limit, all_books=all_books)
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)
