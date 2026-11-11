"""按章保存大纲；目录不读取正文，导入追加、旧大纲迁移均在事务内完成。"""

from __future__ import annotations

from bson import ObjectId

from backend.api.error_protocol import DomainApiError
from backend.db.base import BaseRepository
from backend.db.repositories.novel_repository import novel_repo
from backend.db.transaction import run_mongo_write_unit
from backend.db.utils import get_utc_now, to_object_id
from backend.db.write_contracts import build_idempotency_fingerprint, canonical_request_hash, update_versioned_document
from backend.services.novel.input_history import content_stamp, stamp_view
from backend.services.novel.import_parser import (
    ParsedChapter, ImportParseError, MAX_IMPORT_FILES, MAX_FILE_BYTES, MAX_CHAPTERS,
    MAX_DOCX_XML_BYTES, load_document, guess_title, classify_line, classify_markdown, _scan,
)

outlines = BaseRepository("book_outline_chapters")
receipts = BaseRepository("book_outline_receipts")
revisions = BaseRepository("book_outline_revisions")


async def _snapshot(row: dict, session) -> None:
    """与正文同一事务留存完整版本；稳定主键使未知提交结果的重试不产生重复历史。"""
    await revisions.collection.update_one(
        {"_id": f"{row['_id']}:{row['version']}"},
        {"$setOnInsert": {"novel_id": row["novel_id"], "chapter_id": row["_id"],
                          "snapshot": row, "version": row["version"]}}, upsert=True, session=session)


async def history(novel_id: str, chapter_id: str, before: int | None = None, limit: int = 50) -> dict:
    current = await get_chapter(novel_id, chapter_id)
    ceiling = min(before or current["version"], current["version"])
    query = {"novel_id": to_object_id(novel_id), "chapter_id": to_object_id(chapter_id), "version": {"$lt": ceiling}}
    rows = await revisions.collection.find(query, {"snapshot.content": 0, "snapshot.summary": 0}).sort("version", -1).limit(limit + 1).to_list(length=None)
    found = {row["version"]: {**serialize({**row["snapshot"], "content": ""}, content=False), "legacy": False} for row in rows}
    # 兼容升级前智能体留下的原稿；旧记录只保存改动时间，不能冒充原稿的修改时间。
    changes = BaseRepository("book_agent_changes")
    older = await changes.collection.find({"novel_id": to_object_id(novel_id), "target_id": to_object_id(chapter_id),
        "kind": "outline", "action": "edit", "after_version": {"$lte": ceiling}, "before.content": {"$exists": True}},
        {"before.title": 1, "before.content": 1, "after_version": 1, "created_at": 1}).sort("after_version", -1).limit(limit + 1).to_list(length=None)
    for row in older:
        version = row["after_version"] - 1
        found.setdefault(version, {"version": version, "title": row["before"]["title"], "word_count": len(row["before"]["content"]),
                                   "legacy": True, "content_updated_at": row.get("created_at"), "content_updated_by": None})
    ordered = sorted(found.values(), key=lambda row: row["version"], reverse=True)
    return {"revisions": ordered[:limit], "has_more": len(ordered) > limit, "current_version": current["version"]}


async def get_revision(novel_id: str, chapter_id: str, version: int) -> dict:
    await get_chapter(novel_id, chapter_id)  # 核对书籍及目标归属。
    row = await revisions.collection.find_one({"_id": f"{chapter_id}:{version}", "novel_id": to_object_id(novel_id)})
    if row:
        return {**serialize(row["snapshot"]), "legacy": False}
    old = await BaseRepository("book_agent_changes").collection.find_one({"novel_id": to_object_id(novel_id),
        "target_id": to_object_id(chapter_id), "kind": "outline", "action": "edit", "after_version": version + 1,
        "before.content": {"$exists": True}})
    if old:
        return {"version": version, **old["before"], "word_count": len(old["before"]["content"]), "legacy": True,
                "content_updated_at": old.get("created_at"), "content_updated_by": None}
    raise DomainApiError("OUTLINE_REVISION_NOT_FOUND", "这份大纲历史版本不存在", status_code=404)


async def restore_revision(novel_id: str, chapter_id: str, version: int, expected_version: int) -> dict:
    from backend.services.novel.book_agent_jobs import active_novels
    if novel_id in active_novels():
        raise DomainApiError("OUTLINE_RESTORE_RUNNING", "请先停止本书正在运行的智能体，再恢复历史版本。", status_code=409)
    previous = await get_revision(novel_id, chapter_id, version)
    # 恢复正文和标题；概要是独立编辑的资料，不用旧概要覆盖它。
    return await save_chapter(novel_id, chapter_id, expected_version, previous["title"], previous["content"])


def split_outline(text: str, title: str, mode: str = "auto") -> list[ParsedChapter]:
    """只按真实标题拆分，不按字数切断，也不把短小章纲误删成目录。"""
    if mode == "files":
        return [ParsedChapter(title, text)]
    volumes, preface, headings = _scan(text, classify_line)
    if not headings:
        volumes, preface, headings = _scan(text, classify_markdown)
    if not headings:
        return [ParsedChapter(title, text)]
    result = [ParsedChapter(f"{title}（总纲）", preface)] if preface.strip() else []
    result.extend(ParsedChapter(f"{v.title} · {c.title}" if v.title else c.title, c.content)
                  for v in volumes for c in v.chapters)
    return result


def parse_outline_files(documents: list[tuple[str, bytes]], mode: str = "auto") -> list[ParsedChapter]:
    if mode not in {"auto", "files"}:
        raise ImportParseError("请选择按章标题识别或每个文件一章")
    if not documents or len(documents) > MAX_IMPORT_FILES:
        raise ImportParseError(f"请选择 1 至 {MAX_IMPORT_FILES} 个大纲文件")
    if sum(len(raw) for _, raw in documents) > MAX_FILE_BYTES:
        raise ImportParseError(f"文件合计超过 {MAX_FILE_BYTES >> 20} MB，请分批导入")
    result, chars = [], 0
    for name, raw in documents:
        text, _ = load_document(name, raw)
        chars += len(text)
        if chars > MAX_DOCX_XML_BYTES:
            raise ImportParseError("解压后的文档总量过大，请分批导入")
        result.extend(split_outline(text, guess_title(name), mode))
    if len(result) > MAX_CHAPTERS:
        raise ImportParseError(f"单次超过 {MAX_CHAPTERS} 章，请分批导入")
    return result


def serialize(row: dict, *, content: bool = True) -> dict:
    return {"id": str(row["_id"]), "chapter_number": row["chapter_number"],
            "title": row["title"], "version": row["version"], "word_count": row["word_count"],
            "has_summary": row.get("has_summary", bool(row.get("summary", "").strip())), **stamp_view(row),
            **({"content": row["content"], "summary": row.get("summary", "")} if content else {})}


async def _touch(novel: dict, fields: dict, session) -> None:
    updated = await novel_repo.update_versioned_novel(str(novel["_id"]), novel["version"], fields,
                                                     is_deleted=False, session=session)
    if updated is None:
        raise DomainApiError("OUTLINE_BOOK_CHANGED", "本书正在修改，请保留草稿后重试", status_code=409)


def _document(novel_id, number: int, chapter: ParsedChapter) -> dict:
    # 每章独立文档；不存在整本大纲的 BSON 单文档大小瓶颈。
    return {"_id": ObjectId(), "novel_id": novel_id, "chapter_number": number,
            "title": chapter.title, "content": chapter.content, "word_count": len(chapter.content),
            "summary": "", "has_summary": False, "version": 1, **content_stamp()}


async def initialize(novel_id: str) -> None:
    """首次打开时保留旧 plot 原文备份，按标题迁移一次；并发调用不会重复。"""
    async def migrate(session):
        novel = await novel_repo.get_novel_by_id(novel_id, session=session)
        if novel.get("outline_chapters_initialized"):
            return
        old = novel.get("plot") or ""
        chapters = split_outline(old, "原有大纲") if old.strip() else []
        await _touch(novel, {"outline_chapters_initialized": True, "outline_chapter_sequence": len(chapters)}, session)
        await outlines.insert_many([_document(novel["_id"], n, c) for n, c in enumerate(chapters, 1)], session=session)
    await run_mongo_write_unit(migrate, "initialize_book_outline", require_transaction=True)


async def directory(novel_id: str) -> list[dict]:
    novel = await novel_repo.get_novel_by_id(novel_id)
    rows = await outlines.collection.find({"novel_id": novel["_id"], "is_deleted": False},
                                         {"content": 0, "summary": 0}).sort("chapter_number", 1).to_list(length=None)
    return [serialize(row, content=False) for row in rows]


async def get_chapter(novel_id: str, chapter_id: str) -> dict:
    novel = await novel_repo.get_novel_by_id(novel_id)
    row = await outlines.find_one({"novel_id": novel["_id"], "_id": to_object_id(chapter_id)})
    if row is None:
        raise DomainApiError("OUTLINE_NOT_FOUND", "大纲章节不存在或不属于本书", status_code=404)
    return serialize(row)


async def append_chapters(novel_id: str, chapters: list[ParsedChapter], key: str) -> dict:
    await initialize(novel_id)
    fingerprint = build_idempotency_fingerprint(key, {"novel_id": novel_id, "chapters": [vars(c) for c in chapters]})
    async def append(session):
        novel = await novel_repo.get_novel_by_id(novel_id, session=session)
        existing = await receipts.find_one({"novel_id": novel["_id"], "key_hash": fingerprint.key_hash}, session=session)
        if existing:
            if existing["request_hash"] != fingerprint.request_hash:
                raise DomainApiError("OUTLINE_IMPORT_CONFLICT", "重试标记已用于不同的大纲，请重新选择文件", status_code=409)
            return {**existing["result"], "replayed": True}
        start = novel.get("outline_chapter_sequence", 0)
        docs = [_document(novel["_id"], start + n, c) for n, c in enumerate(chapters, 1)]
        await _touch(novel, {"outline_chapter_sequence": start + len(docs)}, session)
        await outlines.insert_many(docs, session=session)
        result = {"chapters": [serialize(d, content=False) for d in docs], "chapter_count": len(docs)}
        await receipts.insert_one({"novel_id": novel["_id"], "key_hash": fingerprint.key_hash,
                                   "request_hash": fingerprint.request_hash, "result": result}, session=session)
        return {**result, "replayed": False}
    return await run_mongo_write_unit(append, "append_book_outline", require_transaction=True)


async def save_chapter(novel_id: str, chapter_id: str, expected_version: int, title: str, content: str, *, on_saved=None) -> dict:
    if not title.strip():
        raise DomainApiError("OUTLINE_TITLE_EMPTY", "请填写大纲章节标题", status_code=422)
    return await _save_fields(novel_id, chapter_id, expected_version,
                              {"title": title.strip(), "content": content, "word_count": len(content)}, on_saved=on_saved)


async def save_summary(novel_id: str, chapter_id: str, expected_version: int, summary: str) -> dict:
    """只修改本章概要，正文及其他章纲不受影响。"""
    return await _save_fields(novel_id, chapter_id, expected_version,
                              {"summary": summary, "has_summary": bool(summary.strip())})


async def _save_fields(novel_id: str, chapter_id: str, expected_version: int, fields: dict, *, on_saved=None) -> dict:
    write_hash = canonical_request_hash({"expected_version": expected_version, "fields": fields})
    async def save(session):
        novel = await novel_repo.get_novel_by_id(novel_id, session=session)
        query = {"novel_id": novel["_id"], "_id": to_object_id(chapter_id)}
        old = await outlines.find_one(query, session=session)
        if old is None:
            raise DomainApiError("OUTLINE_NOT_FOUND", "大纲章节不存在或不属于本书", status_code=404)
        # 未知提交结果的原请求可安全重试，但不能覆盖其他版本。
        if old["version"] == expected_version + 1 and old.get("last_write_hash") == write_hash:
            return serialize(old)
        saved = await update_versioned_document(outlines.collection, query, expected_version, {**fields, "last_write_hash": write_hash, **content_stamp()},
                                                is_deleted=False, session=session)
        if saved is None:
            raise DomainApiError("OUTLINE_VERSION_CHANGED", "本章大纲已在其他位置修改，当前草稿已保留，请重新载入后合并", status_code=409)
        await _snapshot(old, session)
        await _snapshot(saved, session)
        if on_saved is not None:
            await on_saved(serialize(saved), session)
        await _touch(novel, {"outline_chapters_initialized": True}, session)
        return serialize(saved)
    return await run_mongo_write_unit(save, "save_book_outline_chapter", require_transaction=True)


async def set_deleted(novel_id: str, chapter_id: str, expected_version: int, deleted: bool, *, on_saved=None) -> dict:
    """带版本保护的删除／撤销，不复用编号；同一次请求可安全重试。"""
    async def change(session):
        novel = await novel_repo.get_novel_by_id(novel_id, session=session)
        query = {"novel_id": novel["_id"], "_id": to_object_id(chapter_id)}
        old = await outlines.find_one(query, include_deleted=True, session=session)
        if old is None:
            raise DomainApiError("OUTLINE_NOT_FOUND", "大纲章节不存在或不属于本书", status_code=404)
        if old["is_deleted"] == deleted and old["version"] == expected_version + 1:
            return serialize(old, content=False)
        saved = await update_versioned_document(
            outlines.collection, query, expected_version,
            {"is_deleted": deleted, "deleted_at": get_utc_now() if deleted else None},
            is_deleted=not deleted, session=session,
        )
        if saved is None:
            raise DomainApiError("OUTLINE_VERSION_CHANGED", "本章大纲已变更，请重新载入后再删除或恢复", status_code=409)
        await _snapshot(old, session)
        await _snapshot(saved, session)
        if on_saved is not None:
            await on_saved(serialize(saved), session)
        await _touch(novel, {"outline_chapters_initialized": True}, session)
        return serialize(saved, content=False)
    return await run_mongo_write_unit(change, "delete_or_restore_book_outline_chapter", require_transaction=True)


async def saved_outline_text(novel: dict, selected: list[str] | None = None, exclude: list[str] | None = None,
                             summary_ids: list[str] | None = None) -> str:
    """模型按作者选中的大纲章节读取；未指定时兼容原本的全书参考行为。exclude 中的章节不再重复发送。
    summary_ids 中的章节改发该章已保存的大纲概要，用于篇幅很长的章纲。"""
    if not novel.get("outline_chapters_initialized"):
        if selected:
            raise DomainApiError("OUTLINE_NOT_FOUND", "请刷新大纲目录后重新选择", status_code=409)
        if selected is not None:
            return ""
        return novel.get("plot") or ""
    query = {"novel_id": novel["_id"], "is_deleted": False}
    if selected is not None:
        query["_id"] = {"$in": [to_object_id(value) for value in selected]}
    elif exclude:
        query["_id"] = {"$nin": [to_object_id(value) for value in exclude]}
    rows = await outlines.collection.find(query).sort("chapter_number", 1).to_list(length=None)
    if selected is not None and len(rows) != len(selected):
        raise DomainApiError("OUTLINE_NOT_FOUND", "所选大纲已变更或不属于本书，请刷新后重选", status_code=409)
    brief = {str(to_object_id(value)) for value in summary_ids or []}
    pieces = []
    for row in rows:
        if str(row["_id"]) not in brief:
            pieces.append(f"{row['title']}\n{row['content']}")
            continue
        summary = (row.get("summary") or "").strip()
        if not summary:
            raise DomainApiError("OUTLINE_SUMMARY_MISSING", f"“{row['title']}”还没有大纲概要，请先生成并保存，或改回发送原文",
                                 details={"chapter_id": str(row["_id"])}, status_code=409)
        pieces.append(f"{row['title']}（大纲概要）\n{summary}")
    return "\n\n".join(pieces)
