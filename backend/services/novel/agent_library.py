"""智能体的工具库：异常工具提醒，以及跨任务保留的自造工具和经验。

同一本书里同一个工具连续失败三次后自动标红，成功调用后自动恢复；作者也可以标记已处理并重新统计。
智能体在任务里造的工具当场就能用；它判断工具通用且好用时会提交到这里，以绿色推荐显示，作者批准后才在之后的任务里自动加载。
经验是一两句做事方法（例如“全书审查先用脚本统计人名再分段精读”），批准后放进以后任务的提示里。
同名工具重新提交时生成新版本，批准后取代旧版本；作者可以随时停用。
"""

from __future__ import annotations

from typing import Literal

from pymongo import ReturnDocument

from backend.api.error_protocol import DomainApiError
from backend.db.base import BaseRepository
from backend.db.utils import get_utc_now, to_object_id

library = BaseRepository("agent_library")
STATUSES = ("pending", "approved", "rejected", "disabled", "monitoring", "flagged", "resolved")
FAILURE_THRESHOLD = 3
MAX_LESSON = 300
MAX_LESSONS = 30
# 这些错误是本次调度的反馈（重复动作提醒、作者设定的查阅范围），工具本身没坏，不计入工具故障。
NOT_TOOL_FAULTS = frozenset({"WRITING_AGENT_REPEATED_ACTION", "BOOK_WORLDVIEW_SCOPE", "WRITING_AGENT_OUT_OF_SCOPE", "BOOK_REFERENCE_FORBIDDEN",
                             "BOOK_AGENT_NO_CHANGE", "WRITING_AGENT_EDIT_MISMATCH", "OUTLINE_EDIT_CONFLICT",
                             "WRITING_AGENT_PLAN_OPEN", "WRITING_AGENT_REVIEW_REQUIRED", "WRITING_AGENT_OUTLINE_UNFINISHED",
                             "BOOK_AGENT_PLAN_OPEN", "BOOK_AGENT_COVERAGE", "ASSISTANT_FINAL_TOOL_ALONE"})
# 旧版按上面这些拒绝累计出来的失败记录，按错误原文识别后清掉。
_SCOPE_REFUSAL = r"^(?:请先关联(?:本书)?世界观|作者限定了本次可查阅的|该资料未被作者关联|请求的前文章节未被作者关联|仅可读取明确关联的参考书)"


def serialize(row: dict) -> dict:
    return {"id": str(row["_id"]), "kind": row["kind"], "name": row.get("name", ""), "description": row.get("description", ""),
            "text": row.get("text", ""), "source": row.get("source", ""), "parameters": row.get("parameters", {}),
            "scope": row["scope"], "status": row["status"], "reason": row.get("reason", ""), "uses": row.get("uses", 0),
            "hits": row.get("hits", 0), "version": row.get("version", 1), "job_id": str(row["job_id"]) if row.get("job_id") else "",
            "failure_count": row.get("failure_count", 0), "last_error": row.get("last_error", ""),
            "diagnosis": _diagnosis(row.get("diagnosis")), "doctor_running": bool(row.get("doctor_running")),
            "created_at": row.get("created_at").isoformat() if row.get("created_at") else None,
            "updated_at": row.get("updated_at").isoformat() if row.get("updated_at") else None}


def _diagnosis(value: dict | None) -> dict | None:
    if not value:
        return None
    at = value.get("at")
    return {**value, "at": at.isoformat() if hasattr(at, "isoformat") else at}


def _scope_query(novel_id: str) -> dict:
    return {"$or": [{"scope": "global"}, {"scope": "novel", "novel_id": to_object_id(novel_id)}]}


async def record_failure(novel_id: str, job_id: str, name: str, error: str, custom: dict | None = None, args: dict | None = None) -> dict:
    """累计同一本书里尚未恢复的工具失败；达到阈值后标红，记录本身不进入工具表。args 是这次失败时的参数，给诊断智能体看。"""
    now = get_utc_now()
    name = name.strip()[:100] or "unknown"
    custom = custom or {}
    query = {"kind": "tool_issue", "novel_id": to_object_id(novel_id), "name": name}
    row = await library.collection.find_one_and_update(
        query,
        {"$inc": {"failure_count": 1},
         "$set": {"job_id": to_object_id(job_id), "last_error": str(error).strip()[:2000], "last_failed_at": now, "updated_at": now,
                  "description": str(custom.get("description") or "智能体多次调用失败，请检查工具实现、参数说明或模型输出。")[:1000],
                  "source": str(custom.get("source") or ""), "parameters": custom.get("parameters") or {},
                  "library_id": str(custom.get("library_id") or ""), "last_args": _clip_args(args)},
         "$setOnInsert": {"scope": "novel", "status": "monitoring", "text": "", "reason": "", "uses": 0, "hits": 0, "version": 1,
                          "is_deleted": False, "deleted_at": None, "first_failed_at": now, "created_at": now}},
        upsert=True, return_document=ReturnDocument.AFTER)
    if row["failure_count"] >= FAILURE_THRESHOLD and row.get("status") != "flagged":
        await library.collection.update_one({"_id": row["_id"]}, {"$set": {"status": "flagged", "flagged_at": now, "updated_at": now}})
        row.update(status="flagged", flagged_at=now, updated_at=now)
    elif row["failure_count"] < FAILURE_THRESHOLD and row.get("status") != "monitoring":
        await library.collection.update_one({"_id": row["_id"]}, {"$set": {"status": "monitoring", "updated_at": now}})
        row.update(status="monitoring", updated_at=now)
    return serialize(row)


async def record_success(novel_id: str, name: str) -> None:
    """成功调用中断连续失败计数，不再把空 error 字段当成失败。"""
    await library.collection.update_one(
        {"kind": "tool_issue", "novel_id": to_object_id(novel_id), "name": name,
         "status": {"$in": ["monitoring", "flagged"]}, "failure_count": {"$gt": 0}},
        {"$set": {"status": "resolved", "failure_count": 0, "doctor_attempts": 0, "last_error": "", "updated_at": get_utc_now()}})


def _clip_args(args: dict | None) -> dict:
    """失败参数只留够诊断用的长度：自造工具的参数可能带整段正文。"""
    import json
    text = json.dumps(args or {}, ensure_ascii=False, default=str)
    return (args or {}) if len(text) <= 4000 else {"_truncated": text[:4000]}


async def repair_legacy_false_alarms(novel_id: str) -> None:
    """纠正旧版成功脚本、重复动作保护及查阅范围拒绝的误报，保留真实执行错误。"""
    await library.collection.update_many(
        {"kind": "tool_issue", "novel_id": to_object_id(novel_id), "failure_count": {"$gt": 0},
         "status": {"$in": ["monitoring", "flagged"]},
         "$or": [{"last_error": "", "name": {"$regex": r"^(?:run_script$|my_)"}},
                 {"last_error": "同一状态下重复这个动作没有进展，请根据已有结果换一个动作。"},
                 {"last_error": {"$regex": _SCOPE_REFUSAL}}]},
        {"$set": {"status": "resolved", "failure_count": 0, "updated_at": get_utc_now(),
                  "reason": "已纠正旧版将成功脚本、重复动作提醒或作者设定的查阅范围误计为工具故障的问题"}})


async def propose(novel_id: str, job_id: str, *, kind: Literal["tool", "lesson"], scope: Literal["novel", "global"], reason: str,
                  name: str = "", description: str = "", source: str = "", parameters: dict | None = None, text: str = "") -> dict:
    """提交一条待作者确认的工具或经验。同一任务重复提交同一个工具只更新那条待确认记录。"""
    now = get_utc_now()
    if kind == "lesson":
        text = text.strip()
        if not text or len(text) > MAX_LESSON:
            raise DomainApiError("AGENT_LIBRARY_LESSON", f"经验写成一两句可复用的做事方法，不超过 {MAX_LESSON} 字")
    row = {"kind": kind, "scope": scope, "novel_id": to_object_id(novel_id), "job_id": to_object_id(job_id), "reason": reason[:500],
           "name": name, "description": description[:1000], "source": source, "parameters": parameters or {}, "text": text,
           "status": "pending", "uses": 0, "updated_at": now}
    if kind == "tool":
        same = await library.collection.find_one({"kind": "tool", "name": name, "job_id": row["job_id"], "status": "pending"})
        if same:
            await library.collection.update_one({"_id": same["_id"]}, {"$set": row})
            return serialize({**same, **row})
        latest = await library.collection.find_one({"kind": "tool", "name": name, **_scope_query(novel_id)}, sort=[("version", -1)])
        row["version"] = (latest or {}).get("version", 0) + 1
    row["created_at"] = now
    row["_id"] = to_object_id(await library.insert_one(row))
    return serialize(row)


async def decide(entry_id: str, decision: Literal["approve", "reject", "disable", "resolve"]) -> dict:
    """作者处理一条记录。异常提醒处理后清零重计；批准工具新版本时停用同名旧版本。"""
    row = await library.find_one({"_id": to_object_id(entry_id)})
    if row is None:
        raise DomainApiError("AGENT_LIBRARY_NOT_FOUND", "这条工具库记录不存在", status_code=404)
    now = get_utc_now()
    if row["kind"] == "tool_issue":
        if decision != "resolve":
            raise DomainApiError("AGENT_LIBRARY_ISSUE_DECISION", "异常工具只能标记为已处理")
        await library.collection.update_one({"_id": row["_id"]}, {"$set": {"status": "resolved", "failure_count": 0, "doctor_attempts": 0, "updated_at": now}})
        return serialize({**row, "status": "resolved", "failure_count": 0, "updated_at": now})
    if decision == "resolve":
        raise DomainApiError("AGENT_LIBRARY_ISSUE_DECISION", "只有异常工具才能标记为已处理")
    status = {"approve": "approved", "reject": "rejected", "disable": "disabled"}[decision]
    if status == "approved" and row["kind"] == "tool":
        await library.collection.update_many({"kind": "tool", "name": row["name"], "status": "approved", "_id": {"$ne": row["_id"]},
                                              **_scope_query(str(row["novel_id"]))}, {"$set": {"status": "disabled", "updated_at": now}})
    await library.collection.update_one({"_id": row["_id"]}, {"$set": {"status": status, "updated_at": now}})
    return serialize({**row, "status": status, "updated_at": now})


async def list_entries(novel_id: str, status: str | None = None) -> list[dict]:
    await repair_legacy_false_alarms(novel_id)
    query = _scope_query(novel_id)
    if status:
        query["status"] = status
    rows = await library.collection.find(query).sort("updated_at", -1).to_list(length=300)
    return [serialize(row) for row in rows]


async def approved(novel_id: str) -> tuple[list[dict], list[dict]]:
    """本书可用的已批准工具和经验。

    经验按作者意见里“又出现”的次数排序，其次是用过的次数和新旧：反复出现的问题最该先注意。
    以前只按新旧取最近 30 条，攒多了以后最常犯的问题反而可能被挤出去。
    """
    rows = await library.collection.find({"status": "approved", **_scope_query(novel_id)}).sort("created_at", -1).to_list(length=300)
    tools = [row for row in rows if row["kind"] == "tool"][:200]
    lessons = sorted((row for row in rows if row["kind"] == "lesson"),
                     key=lambda row: (int(row.get("hits") or 0), int(row.get("uses") or 0), str(row.get("created_at") or "")), reverse=True)[:MAX_LESSONS]
    return tools, lessons


async def count_use(entry_id: str) -> None:
    await library.collection.update_one({"_id": to_object_id(entry_id)}, {"$inc": {"uses": 1}})
