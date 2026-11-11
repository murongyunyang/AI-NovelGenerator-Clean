"""独立于章节保存的作品输出记录。"""
import asyncio
from fastapi import APIRouter, Query, HTTPException
from backend.api.contracts import ObjectIdString
from backend.api.default_routers.writing_router import EXPECTED_ERRORS, raise_writing_http_error
from backend.db.repositories.novel_repository import novel_repo
from backend.services.novel import output_history

router = APIRouter(prefix="/api/novels/{novel_id}/output-history", tags=["output-history"])


@router.get("")
async def list_history(novel_id: ObjectIdString, before: ObjectIdString | None = None,
                       q: str = Query(default="", max_length=200), limit: int = Query(default=30, ge=1, le=100)):
    try:
        await novel_repo.get_novel_by_id(novel_id)
        return await asyncio.to_thread(output_history.list_entries, novel_id, before=before, query=q, limit=limit)
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)


@router.get("/{entry_id}")
async def get_history(novel_id: ObjectIdString, entry_id: ObjectIdString):
    try:
        await novel_repo.get_novel_by_id(novel_id)
        return await asyncio.to_thread(output_history.read_entry, novel_id, entry_id)
    except FileNotFoundError:
        raise HTTPException(404, "输出记录不存在")
    except EXPECTED_ERRORS as exc:
        raise_writing_http_error(exc)
