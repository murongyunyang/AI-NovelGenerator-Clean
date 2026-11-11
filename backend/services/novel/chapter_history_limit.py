"""章节历史版本上限：每章在历史面板里最多保留最新 10 个版本。

超出的旧版本分两种处理：
- 没被任何记录引用的：直接删除。
- 仍被确认过的记录当作证据引用的（设定整理、伏笔、人物和势力关系、助手读取过的原文等）：留在库里，
  标成 hidden_from_history，不算进 10 个，历史面板也不显示；这些记录和全书导出因此不会坏。
删掉中间的版本后，剩下的历史重新首尾相连（parent_version 指向前一份留下的版本），全书导出的校验要求这一点；
“恢复自第 N 版”的那一版被删掉时，这条记录改记为普通编辑。
每次保存后在后台检查一次；软件第一次启动新版本时把所有书清理一遍，删除前先把要删的版本导出备份。
"""

from __future__ import annotations

import asyncio
import gzip
import json
import logging
from contextlib import suppress

from bson import ObjectId

from backend.db.base import BaseRepository
from backend.db.utils import get_utc_now

logger = logging.getLogger(__name__)
MAX_VERSIONS = 10
HIDDEN = "hidden_from_history"
# 不会把旧版本当证据引用的集合：本身就是正文和历史，或只是过程日志。跳过它们，扫描才快。
SKIP = frozenset({"chapter_revisions", "chapters", "book_agent_events", "assistant_events", "input_history", "agent_library", "chapter_history_migrations"})
MIGRATION_ID = "chapter_history_limit_v2_ten"
# 保存后稍等再清理：保存所在的事务提交之后再读，连续保存只清理一次。
DELAY_SECONDS = 3
_pending: dict[str, asyncio.Task] = {}


def plan(rows: list[dict], protected: set[str]) -> tuple[list[ObjectId], list[tuple[ObjectId, dict]]]:
    """rows 是一章的全部历史（按版本升序，至少含 _id、version、parent_version、source、restored_from_version、hidden_from_history）。

    返回 (要删除的 _id, [(要更新的 _id, 新字段)])。最新 10 个版本显示；更早的被引用就隐藏保留，否则删除。
    """
    rows = sorted(rows, key=lambda row: row["version"])
    visible = {row["_id"] for row in rows[-MAX_VERSIONS:]}
    keep = [row for row in rows if row["_id"] in visible or str(row["_id"]) in protected]
    kept_ids = {row["_id"] for row in keep}
    deletes = [row["_id"] for row in rows if row["_id"] not in kept_ids]
    kept_versions = {row["version"] for row in keep}
    updates, previous = [], None
    for row in keep:
        fields = {}
        if row.get("parent_version") != previous:
            fields["parent_version"] = previous
        hidden = row["_id"] not in visible
        if bool(row.get(HIDDEN)) != hidden:
            fields[HIDDEN] = hidden
        if row.get("source") == "restore" and row.get("restored_from_version") not in kept_versions:
            fields["source"], fields["restored_from_version"] = "edit", None
        if fields:
            updates.append((row["_id"], fields))
        previous = row["version"]
    return deletes, updates


def _walk(value, candidates: set[str], found: set[str]) -> None:
    """在任意嵌套的记录里找候选版本的 id：证据字段的位置各处不同，按值找比逐个列字段可靠。"""
    if isinstance(value, ObjectId):
        text = str(value)
        if text in candidates:
            found.add(text)
    elif isinstance(value, str):
        if len(value) == 24 and value in candidates:
            found.add(value)
    elif isinstance(value, dict):
        for item in value.values():
            _walk(item, candidates, found)
    elif isinstance(value, (list, tuple)):
        for item in value:
            _walk(item, candidates, found)


async def referenced(candidates: set[str], novel_id: ObjectId | None = None, session=None) -> set[str]:
    """候选版本里仍被别的记录引用的那些。novel_id 给定时只看这本书的记录（含没有 novel_id 字段的全局记录）。"""
    if not candidates:
        return set()
    from backend.db.mongo import get_database
    db = get_database()
    query = {} if novel_id is None else {"$or": [{"novel_id": novel_id}, {"novel_id": str(novel_id)}, {"novel_id": {"$exists": False}}]}
    found: set[str] = set()
    for name in await db.list_collection_names(session=session):
        if name in SKIP or name.startswith("system."):
            continue
        async for document in db[name].find(query, session=session):
            _walk(document, candidates, found)
            if found == candidates:
                return found
    return found


def _operations(deletes: list[ObjectId], updates: list[tuple[ObjectId, dict]]):
    from pymongo import DeleteMany, UpdateOne
    ops = [DeleteMany({"_id": {"$in": deletes}})] if deletes else []
    for identity, fields in updates:
        unset = {key: "" for key, value in fields.items() if key == "restored_from_version" and value is None}
        values = {key: value for key, value in fields.items() if key not in unset}
        change = {**({"$set": values} if values else {}), **({"$unset": unset} if unset else {})}
        ops.append(UpdateOne({"_id": identity}, change))
    return ops


async def prune_chapter(chapter_id: ObjectId) -> int:
    """清理一章的历史；返回删掉的版本数。先在事务外查引用（慢），再在事务里按最新历史落改。"""
    revisions = BaseRepository("chapter_revisions").collection
    rows = await revisions.find({"chapter_id": chapter_id}, {"_id": 1, "version": 1, "novel_id": 1, HIDDEN: 1}).sort("version", 1).to_list(length=None)
    if len(rows) <= MAX_VERSIONS and not any(row.get(HIDDEN) for row in rows):
        return 0
    checked = {str(row["_id"]) for row in rows[:-MAX_VERSIONS]}
    return await _apply(chapter_id, checked, await referenced(checked, rows[0]["novel_id"]))


async def _apply(chapter_id: ObjectId, checked: set[str], protected: set[str], backup=None) -> int:
    """在事务里按最新历史落改。checked 是查过引用的旧版本；没查过的一律当作被引用保留，下次再查。
    backup 给定时，删除前把要删的完整版本交给它写进备份。"""
    from backend.db.transaction import run_mongo_write_unit
    revisions = BaseRepository("chapter_revisions").collection

    async def apply(session) -> int:
        current = await revisions.find({"chapter_id": chapter_id}, {"content": 0, "summary": 0, "planning": 0},
                                       session=session).sort("version", 1).to_list(length=None)
        unchecked = {str(row["_id"]) for row in current if str(row["_id"]) not in checked}
        deletes, updates = plan(current, protected | unchecked)
        if deletes and backup is not None:
            backup(await revisions.find({"_id": {"$in": deletes}}, session=session).to_list(length=None))
        ops = _operations(deletes, updates)
        if ops:
            await revisions.bulk_write(ops, ordered=True, session=session)
        return len(deletes)
    return await run_mongo_write_unit(apply, "prune_chapter_history", require_transaction=True)


def schedule(chapter_id: ObjectId) -> None:
    """保存章节后调用：稍后在后台清理这一章的历史；连续保存只清理一次。清理失败只记日志，不影响保存。"""
    key = str(chapter_id)
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    task = _pending.get(key)
    if task is not None and not task.done():
        return

    async def run() -> None:
        try:
            await asyncio.sleep(DELAY_SECONDS)
            await prune_chapter(chapter_id)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("清理章节历史失败：%s", key)
        finally:
            _pending.pop(key, None)
    _pending[key] = loop.create_task(run())


async def migrate(backup_dir) -> dict:
    """新版本第一次启动时把所有书清理一遍；做完记一笔，之后不再重复。删除前把要删的版本写进备份文件。

    中途被关掉也没关系：做完的章已经落库，下次启动接着清理剩下的。
    """
    from bson import json_util
    db_migrations = BaseRepository("chapter_history_migrations").collection
    if await db_migrations.find_one({"_id": MIGRATION_ID, "done": True}):
        return {"skipped": True}
    revisions = BaseRepository("chapter_revisions").collection
    cursor = await revisions.aggregate([{"$group": {"_id": "$chapter_id", "count": {"$sum": 1},
                                                   "hidden": {"$sum": {"$cond": ["$hidden_from_history", 1, 0]}}}},
                                        {"$match": {"$or": [{"count": {"$gt": MAX_VERSIONS}}, {"hidden": {"$gt": 0}}]}}])
    over = await cursor.to_list(length=None)
    checked: dict[ObjectId, set[str]] = {}
    for row in over:
        ids = await revisions.find({"chapter_id": row["_id"]}, {"_id": 1}).sort("version", 1).to_list(length=None)
        checked[row["_id"]] = {str(item["_id"]) for item in ids[:-MAX_VERSIONS]}
    candidates = set().union(*checked.values()) if checked else set()
    protected = await referenced(candidates)
    path, deleted, handle = None, 0, None
    try:
        if candidates - protected:
            backup_dir.mkdir(parents=True, exist_ok=True)
            path = backup_dir / f"chapter_history_{get_utc_now().strftime('%Y%m%d_%H%M%S')}.jsonl.gz"
            handle = gzip.open(path, "at", encoding="utf-8")

        def backup(rows: list[dict]) -> None:
            for row in rows:
                handle.write(json_util.dumps(row, ensure_ascii=False) + "\n")
            handle.flush()
        for chapter_id, ids in checked.items():
            deleted += await _apply(chapter_id, ids, protected, backup if handle else None)
    finally:
        if handle is not None:
            handle.close()
    result = {"chapters": len(checked), "deleted": deleted, "kept_as_evidence": len(protected), "backup": str(path) if path else ""}
    await db_migrations.update_one({"_id": MIGRATION_ID}, {"$set": {"done": True, "finished_at": get_utc_now(), **result}}, upsert=True)
    logger.info("章节历史清理完成：%s", result)
    return result
