"""全自动智能体的任务、过程记录与改动记录。

一个任务是作者交给智能体的一件事（例如“按大纲写完第 20–40 章”），在服务端后台运行；过程按序号逐条写入，界面按序号增量读取。
智能体对书做的每一次修改都记成一条改动，作者可以逐条撤销：新建的章节进回收站，修改恢复成改之前的文字，删除的恢复。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from bson import ObjectId

from backend.api.error_protocol import DomainApiError
from backend.db.base import BaseRepository
from backend.db.mongo import get_database
from backend.db.utils import get_utc_now, to_object_id

jobs = BaseRepository("book_agent_jobs")
events = BaseRepository("book_agent_events")
changes = BaseRepository("book_agent_changes")

# 正在运行（或等待作者回复）的状态；后台任务不在运行表里却停在这些状态，说明软件曾被关闭。
ACTIVE = ("running", "waiting", "stopping")
EVENT_PAGE = 400
MAX_INBOX = 20
_indexed: set[str] = set()


async def ensure_indexes() -> None:
    """首次使用时建索引；每个数据库只建一次。"""
    name = get_database().name
    if name in _indexed:
        return
    await events.collection.create_index([("job_id", 1), ("seq", 1)], unique=True)
    await jobs.collection.create_index([("novel_id", 1), ("created_at", -1)])
    await changes.collection.create_index([("job_id", 1), ("_id", 1)])
    _indexed.add(name)


def _iso(value: Any) -> Any:
    # 数据库连接不带时区，取回的是不带时区的 UTC 时间；加上时区再输出，浏览器才不会当成本地时间。
    if isinstance(value, datetime):
        return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).isoformat()
    return value


def serialize_job(row: dict, running: set[str] | None = None) -> dict:
    status = row["status"]
    if running is not None and status in ACTIVE and str(row["_id"]) not in running:
        status = "interrupted"
    return {"id": str(row["_id"]), "novel_id": str(row["novel_id"]), "status": status, "instruction": row["instruction"],
            "settings": row.get("settings", {}), "plan": row.get("plan", []), "notes": row.get("notes", ""),
            "question": row.get("question", ""), "report": row.get("report", ""), "error": row.get("error", ""),
            "question_id": row.get("question_id", ""), "question_options": row.get("question_options", []),
            "question_multi_select": bool(row.get("question_multi_select", False)),
            "stats": row.get("stats", {}), "usage": row.get("usage", {}), "steps": row.get("steps", 0), "runs": row.get("runs", 1),
            "status_text": row.get("status_text", ""), "created_at": _iso(row.get("created_at")), "updated_at": _iso(row.get("updated_at")),
            "finished_at": _iso(row.get("finished_at")), "coverage_count": len(row.get("coverage") or []),
            "custom_tools": [{"name": spec["name"], "description": spec.get("description", ""), "created_by": spec.get("created_by", "")}
                             for spec in row.get("custom_tools") or []]}


def serialize_change(row: dict) -> dict:
    return {"id": str(row["_id"]), "kind": row["kind"], "action": row["action"], "target_id": str(row["target_id"]),
            "title": row.get("title", ""), "number": row.get("number"), "chars": row.get("chars", 0), "note": row.get("note", ""),
            "undone": bool(row.get("undone")), "created_at": _iso(row.get("created_at"))}


async def get_job(novel_id: str, job_id: str) -> dict:
    row = await jobs.find_one({"_id": to_object_id(job_id), "novel_id": to_object_id(novel_id)})
    if row is None:
        raise DomainApiError("BOOK_AGENT_JOB_NOT_FOUND", "这个智能体任务不存在或不属于本书", status_code=404)
    return row


async def list_jobs(novel_id: str, limit: int = 30) -> list[dict]:
    return await jobs.find_many({"novel_id": to_object_id(novel_id)}, sort=[("created_at", -1)], limit=limit)


async def prune_finished(novel_id: str, running: set[str], keep: int = 1) -> int:
    """只清理较早任务的过程事件，保留任务及改动原稿供作者撤销。
    Returns: 删掉的任务数。
    """
    rows = await jobs.collection.find({"novel_id": to_object_id(novel_id)}, {"_id": 1}).sort("created_at", -1).to_list(length=None)
    finished = [row["_id"] for row in rows if str(row["_id"]) not in running]
    doomed = finished[keep:]
    if not doomed:
        return 0
    await events.collection.delete_many({"job_id": {"$in": doomed}})
    await jobs.collection.update_many({"_id": {"$in": doomed}}, {"$set": {"events_pruned": True}})
    return len(doomed)


async def active_novels(running: set[str]) -> list[str]:
    """有后台任务正在运行的书。只认运行表里的任务，软件关闭后残留的状态不算。"""
    if not running:
        return []
    rows = await jobs.collection.find({"_id": {"$in": [ObjectId(job_id) for job_id in running]}, "status": {"$in": list(ACTIVE)}},
                                      {"novel_id": 1}).to_list(length=None)
    return sorted({str(row["novel_id"]) for row in rows})


async def list_resumable(since: datetime) -> list[dict]:
    """软件上次关闭时还没做完、且作者允许自动继续的任务（最近更新的在前）。"""
    query = {"status": {"$in": [*ACTIVE, "interrupted"]}, "settings.auto_resume": True, "updated_at": {"$gte": since}}
    return await jobs.collection.find(query).sort("updated_at", -1).limit(50).to_list(length=50)


async def create_job(novel_id: str, instruction: str, settings: dict) -> dict:
    await ensure_indexes()
    row = {"novel_id": to_object_id(novel_id), "instruction": instruction, "settings": settings, "status": "running",
           "plan": [], "notes": "", "question": "", "question_id": "", "question_options": [], "question_multi_select": False,
           "report": "", "error": "", "inbox": [], "steps": 0, "runs": 1, "seq": 0,
           "stats": {"chapters_written": 0, "chars_written": 0, "chapters_revised": 0, "outlines_written": 0, "edits": 0}, "usage": {}}
    row["_id"] = to_object_id(await jobs.insert_one(row))
    return await jobs.find_one({"_id": row["_id"]})


async def update_job(job_id: str, fields: dict, inc: dict | None = None) -> None:
    update: dict = {"$set": {**fields, "updated_at": get_utc_now()}}
    if inc:
        update["$inc"] = inc
    await jobs.collection.update_one({"_id": to_object_id(job_id)}, update)


async def push_inbox(job_id: str, text: str) -> None:
    await jobs.collection.update_one({"_id": to_object_id(job_id)}, {"$push": {"inbox": {"$each": [{"text": text, "at": get_utc_now()}], "$slice": -MAX_INBOX}},
                                                                     "$set": {"updated_at": get_utc_now()}})


async def take_inbox(job_id: str) -> list[str]:
    """取出并清空作者留言；一条留言只交给智能体一次。交出去的留言另记一份历史，上下文整理和继续运行时用。"""
    row = await jobs.collection.find_one_and_update({"_id": to_object_id(job_id)}, {"$set": {"inbox": []}}, projection={"inbox": 1})
    items = (row or {}).get("inbox", [])
    if items:
        await jobs.collection.update_one({"_id": to_object_id(job_id)}, {"$push": {"messages": {"$each": [item["text"] for item in items], "$slice": -MAX_INBOX}}})
    return [item["text"] for item in items]


async def answer_question(job_id: str, question_id: str, text: str) -> bool:
    """只接受当前问题的一次答复，并持久化到作者留言历史；不让迟到答复进入下一题。"""
    result = await jobs.collection.update_one(
        {"_id": to_object_id(job_id), "status": "waiting", "question_id": question_id},
        {"$set": {"status": "running", "question": "", "question_id": "", "question_options": [],
                  "question_multi_select": False, "updated_at": get_utc_now()},
         "$push": {"messages": {"$each": [text], "$slice": -MAX_INBOX}}})
    return bool(result.matched_count)


async def append_event(job_id: str, seq: int, event: dict) -> None:
    await events.collection.insert_one({"job_id": to_object_id(job_id), "seq": seq, "at": get_utc_now(), "event": event})


async def last_seq(job_id: str) -> int:
    row = await events.collection.find_one({"job_id": to_object_id(job_id)}, sort=[("seq", -1)], projection={"seq": 1})
    return row["seq"] if row else 0


async def read_events(job_id: str, after: int = 0, tail: int | None = None) -> tuple[list[dict], bool]:
    """after 之后的过程记录；首次打开（tail）只取最后若干条，旧记录界面上本来也会折叠。"""
    query = {"job_id": to_object_id(job_id), "seq": {"$gt": after}}
    if tail:
        rows = await events.collection.find(query).sort("seq", -1).limit(tail).to_list(length=tail)
        rows.reverse()
        return [{"seq": row["seq"], "at": _iso(row["at"]), **row["event"]} for row in rows], False
    rows = await events.collection.find(query).sort("seq", 1).limit(EVENT_PAGE + 1).to_list(length=EVENT_PAGE + 1)
    return [{"seq": row["seq"], "at": _iso(row["at"]), **row["event"]} for row in rows[:EVENT_PAGE]], len(rows) > EVENT_PAGE


# ---- 改动与撤销 ----

async def record_change(job_id: str, novel_id: str, *, kind: str, action: str, target_id: str, after_version: int,
                        title: str = "", number: int | None = None, chars: int = 0, before: dict | None = None, note: str = "", session=None) -> dict:
    row = {"job_id": to_object_id(job_id), "novel_id": to_object_id(novel_id), "kind": kind, "action": action,
           "target_id": to_object_id(target_id), "after_version": after_version, "title": title, "number": number,
           "chars": chars, "before": before, "note": note[:300], "undone": False}
    row["_id"] = to_object_id(await changes.insert_one(row, session=session))
    return row


async def bump_version(job_id: str, target_id: str, version: int) -> None:
    """智能体为同一章补写概要等不单独记改动的保存，只更新最近一条改动记下的版本，撤销时不会误报“已被修改”。"""
    row = await changes.collection.find_one({"job_id": to_object_id(job_id), "target_id": to_object_id(target_id), "undone": False}, sort=[("_id", -1)])
    if row is not None:
        await changes.collection.update_one({"_id": row["_id"]}, {"$set": {"after_version": version}})


async def changes_signature(job_id: str) -> str:
    """改动列表的指纹（条数 + 最近一次变化时间）。界面轮询时据此判断要不要重新取整份改动列表。"""
    query = {"job_id": to_object_id(job_id), "is_deleted": False}
    count = await changes.collection.count_documents(query)
    latest = await changes.collection.find_one(query, {"updated_at": 1}, sort=[("updated_at", -1)])
    return f"{count}:{_iso((latest or {}).get('updated_at')) or ''}"


async def list_changes(job_id: str, *, brief: bool = False) -> list[dict]:
    """任务的改动记录。brief 时不取改之前的原文：界面每隔一两秒轮询一次，原文只在撤销时才需要，长任务里它是最大的一块。"""
    if not brief:
        return await changes.find_many({"job_id": to_object_id(job_id)}, sort=[("_id", 1)])
    cursor = changes.collection.find({"job_id": to_object_id(job_id), "is_deleted": False}, {"before": 0}).sort("_id", 1)
    return await cursor.to_list(length=None)


async def undo_change(novel_id: str, job_id: str, change_id: str) -> dict:
    """撤销一条改动。目标在那之后又被改过时不覆盖，提示作者先撤销后面的改动或到章节历史里恢复。"""
    from backend.services.novel import book_outline_service as outlines
    from backend.services.novel.chapter_service import ChapterService
    row = await changes.find_one({"_id": to_object_id(change_id), "job_id": to_object_id(job_id), "novel_id": to_object_id(novel_id)})
    if row is None:
        raise DomainApiError("BOOK_AGENT_CHANGE_NOT_FOUND", "这条改动不存在", status_code=404)
    if row.get("undone"):
        return serialize_change(row)
    target, action, version = str(row["target_id"]), row["action"], row.get("undo_expected_version", row["after_version"])
    async def mark_undone(saved, session=None):
        await changes.collection.update_one({"_id": row["_id"]}, {"$set": {"undone": True, "updated_at": get_utc_now()}}, session=session)
        # 恢复产生新版本，但原 after_version 是历史事实，必须保留供版本历史读取。
        previous = await changes.collection.find_one({"novel_id": row["novel_id"], "target_id": row["target_id"],
            "kind": row["kind"], "undone": False, "_id": {"$lt": row["_id"]}}, sort=[("_id", -1)], session=session)
        if previous and previous.get("undo_expected_version", previous["after_version"]) == row["after_version"] - 1:
            await changes.collection.update_one({"_id": previous["_id"]}, {"$set": {"undo_expected_version": saved["version"], "updated_at": get_utc_now()}}, session=session)
    changed = DomainApiError("BOOK_AGENT_CHANGE_STALE", "这一处在智能体改完之后又被修改过。请先撤销后面的改动，或到章节历史里手动恢复。", status_code=409)
    if row["kind"] == "worldview":
        from backend.services.novel.novel_service import NovelService
        from backend.db.transaction import run_mongo_write_unit
        async def restore(session):
            saved = await NovelService.update_novel(novel_id, {"expected_version": version, **row["before"]}, session=session)
            await mark_undone(saved, session=session)
        await run_mongo_write_unit(restore, "undo_worldview", require_transaction=True)
    elif row["kind"] == "chapter":
        current = await ChapterService.get_chapter(target, include_deleted=True, novel_id=novel_id)
        if current["version"] != version:
            raise changed
        if action == "create":
            saved = await ChapterService.set_deleted(target, expected_version=version, deleted=True)
        elif action == "delete":
            saved = await ChapterService.set_deleted(target, expected_version=version, deleted=False)
        else:
            saved = await ChapterService.update_chapter(target, {"expected_version": version, **row["before"]})
        await mark_undone(saved)
    else:
        current = await outlines.outlines.find_one({"_id": row["target_id"], "novel_id": to_object_id(novel_id)}, include_deleted=True)
        if current is None:
            raise DomainApiError("OUTLINE_NOT_FOUND", "这章大纲已不存在", status_code=404)
        if current["version"] != version:
            raise changed
        if action in {"create", "delete"}:
            await outlines.set_deleted(novel_id, target, version, action == "create", on_saved=mark_undone)
        else:
            await outlines.save_chapter(novel_id, target, version, row["before"]["title"], row["before"]["content"], on_saved=mark_undone)
    return serialize_change({**row, "undone": True})


async def undo_all(novel_id: str, job_id: str) -> dict:
    """先核对所有目标，再按倒序撤销。中途失败保留进度，重试只处理尚未撤销的记录。"""
    from backend.services.novel import book_outline_service as outlines
    from backend.services.novel.chapter_service import ChapterService
    await get_job(novel_id, job_id)
    pending = [row for row in await list_changes(job_id) if not row.get("undone")]
    groups: dict[tuple[str, str], list[dict]] = {}
    for row in pending:
        groups.setdefault((row["kind"], str(row["target_id"])), []).append(row)
    for (kind, target), rows in groups.items():
        latest = rows[-1]
        if kind == "worldview":
            from backend.db.repositories.novel_repository import novel_repo
            current = await novel_repo.get_novel_by_id(novel_id)
        elif kind == "chapter":
            current = await ChapterService.get_chapter(target, include_deleted=True, novel_id=novel_id)
        else:
            current = await outlines.outlines.find_one({"_id": to_object_id(target), "novel_id": to_object_id(novel_id)}, include_deleted=True)
        contiguous = all(left.get("undo_expected_version", left["after_version"]) == right["after_version"] - 1 for left, right in zip(rows, rows[1:]))
        if not current or current["version"] != latest.get("undo_expected_version", latest["after_version"]) or not contiguous:
            raise DomainApiError("BOOK_AGENT_CHANGE_STALE", "本次任务的内容后来又被修改过，未执行整批回退。请到历史版本选择需要恢复的原稿。", status_code=409)
    count = 0
    try:
        for row in reversed(pending):
            await undo_change(novel_id, job_id, str(row["_id"]))
            count += 1
    except Exception as exc:
        raise DomainApiError("BOOK_AGENT_UNDO_PARTIAL", f"已撤销 {count} 处，剩余 {len(pending) - count} 处未完成。已完成的回退已保存，请刷新后重试；若有版本冲突，请在历史版本中恢复。",
                             status_code=409, details={"undone": count, "remaining": len(pending) - count}) from exc
    return {"undone": count, "remaining": 0}
