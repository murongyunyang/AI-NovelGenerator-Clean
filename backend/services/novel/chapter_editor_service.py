"""全书正文编辑：独立于规划层级创建空章与调整阅读顺序。"""

from backend.db.errors import VersionConflictError
from backend.db.repositories.chapter_repository import chapter_repo
from backend.db.repositories.novel_repository import novel_repo
from backend.db.transaction import run_mongo_write_unit
from backend.db.write_contracts import build_idempotency_fingerprint, resolve_idempotent_replay, update_versioned_document
from backend.services.novel.arc_service import validate_sibling_order
from backend.services.novel.chapter_contract import ChapterCreateV2, ChapterReorderV2
from backend.services.novel.chapter_service import ChapterService, load_chapter_parent_chain


async def create_chapter(novel_id: str, req: ChapterCreateV2, key: str) -> dict:
    """全书末尾追加空章，同一创建键在响应丢失后也只创建一次。"""
    fields = req.model_dump()
    key_hash = build_idempotency_fingerprint(key, {}).key_hash

    async def create(session):
        from backend.services.novel.continuation_service import _new_writing_scene
        from backend.services.novel.writing_context import require_volume_ready

        novel = await novel_repo.get_novel_by_id(novel_id, session=session)
        existing = await chapter_repo.collection.find_one({"novel_id": novel["_id"], "creation_idempotency_key_hash": key_hash}, session=session)
        if existing:
            fingerprint = build_idempotency_fingerprint(key, {"scene_id": str(existing["scene_id"]), **fields})
            return resolve_idempotent_replay(existing, fingerprint.request_hash, label="新建章节")
        rows = await ChapterService.list_chapters(novel_id, session=session)
        scene_id = None
        if rows:
            parents = await load_chapter_parent_chain(str(rows[-1]["scene_id"]), session=session)
            from backend.api.error_protocol import DomainApiError
            try:
                require_volume_ready(parents[1])
                scene_id = str(rows[-1]["scene_id"])
            except DomainApiError:
                pass
        if scene_id is None:
            scene_id = await _new_writing_scene(novel_id, key_hash[:40], session)
        return await ChapterService.create_chapter_in_session(scene_id, fields, idempotency_key=key, session=session)

    return await run_mongo_write_unit(create, "create_editor_chapter", require_transaction=True)


async def reorder_chapters(novel_id: str, req: ChapterReorderV2) -> list[dict]:
    """按完整目录及逐章版本原子更新全书阅读顺序，不改变章节的规划归属。"""
    async def reorder(session):
        novel = await novel_repo.get_novel_by_id(novel_id, session=session)
        rows = await ChapterService.list_chapters(novel_id, session=session)
        ordered = validate_sibling_order(rows, req.model_dump()["items"], id_field="chapter_id")
        if [str(row["_id"]) for row, _ in ordered] == [str(row["_id"]) for row in rows]:
            return rows
        changed = await update_versioned_document(novel_repo.collection, {"_id": novel["_id"]}, novel["version"],
            {"chapter_order_revision": novel.get("chapter_order_revision", 0) + 1}, is_deleted=False, session=session)
        if changed is None:
            raise VersionConflictError("章节目录在排序期间已变化，请刷新后重试")
        for chapter, number in ordered:
            changed = await update_versioned_document(chapter_repo.collection, {"_id": chapter["_id"], "novel_id": novel["_id"]},
                chapter["version"], {"reading_order": number}, is_deleted=False, session=session)
            if changed is None:
                raise VersionConflictError("章节在排序期间已修改，顺序未保存，请刷新后重试")
        return await ChapterService.list_chapters(novel_id, session=session)

    return await run_mongo_write_unit(reorder, "reorder_editor_chapters", require_transaction=True)
