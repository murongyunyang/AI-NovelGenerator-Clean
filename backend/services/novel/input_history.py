"""作者发给各智能体的指令记录，以及章节、章纲“最近一次修改”的修改者标记。

记录只追加不改写；写入失败只打日志，绝不影响生成本身。
"""

from __future__ import annotations

import logging
import os
import re
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterator

from bson import ObjectId

from backend.db.base import BaseRepository
from backend.db.utils import get_utc_now, to_object_id

logger = logging.getLogger(__name__)
history = BaseRepository("input_history")

# 来源 → 界面名称；前端也按这个键筛选。
SOURCES = {
    "assistant": "协作助手",
    "book_agent": "全自动智能体",
    "selection_agent": "AI 修改选段",
    "continuation": "续写正文",
    "outline": "生成后续大纲",
    "summary": "生成概要",
    "materials": "整理素材",
    "feedback": "写作意见与偏好",
    "task_flow": "AI 生成与任务流程",
    "other": "其他 AI 输入",
}

# 当前写入由谁发起；默认是作者本人，后台智能体任务在自己的协程里改写。
_actor: ContextVar[str] = ContextVar("content_actor", default="user")
captured_request: ContextVar[bool] = ContextVar("input_history_captured", default=False)


def journal_dir():
    from backend.storage import USER_DATA_DIR
    return USER_DATA_DIR / "input_history"


def journal(row: dict) -> None:
    """先写独立的逐条备份；停止生成、撤回和数据库故障都不能清掉原话。"""
    from bson import json_util
    directory = journal_dir()
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{row['_id']}.json"
    with path.open("x", encoding="utf-8") as handle:
        handle.write(json_util.dumps(row, ensure_ascii=False))
        handle.flush()
        os.fsync(handle.fileno())


async def capture(novel_id: str | None, source: str, text: str, detail: dict) -> None:
    """请求入口保存完整原文；至少有一个持久副本才允许开始 AI 请求。"""
    row = {"_id": ObjectId(), "novel_id": to_object_id(novel_id) if novel_id else None,
           "source": source, "text": text, "truncated": False, "detail": detail,
           "created_at": get_utc_now(), "updated_at": get_utc_now(), "is_deleted": False}
    file_saved = False
    try:
        journal(row)
        file_saved = True
    except OSError:
        logger.exception("输入记录本地备份失败")
    try:
        await history.insert_one(row)
    except Exception:
        logger.exception("输入记录数据库保存失败，本地副本=%s", file_saved)
        if not file_saved:
            raise RuntimeError("输入记录未能保存，请重试；尚未发送给 AI")
    else:
        if file_saved:
            try:
                (journal_dir() / f"{row['_id']}.json").rename(journal_dir() / f"{row['_id']}.saved")
            except OSError:
                pass  # 下次读取时按固定 ID 幂等补同步。


@contextmanager
def acting_as(actor: str) -> Iterator[None]:
    """在当前协程（及其派生任务）内把修改者标成 actor。"""
    token = _actor.set(actor)
    try:
        yield
    finally:
        _actor.reset(token)


def set_actor(actor: str) -> None:
    """后台任务入口用：任务自己的上下文副本里整段都算 actor 修改。"""
    _actor.set(actor)


def content_stamp(source: str | None = None) -> dict:
    """章节／章纲内容真正变化时写入的修改时间和修改者。

    Args:
        source: 章节保存来源；assistant / writing 表示由对应智能体写入。
    Returns:
        content_updated_at 与 content_updated_by 两个字段。
    """
    actor = _actor.get()
    if actor == "user" and source in {"assistant", "writing"}:
        actor = source
    return {"content_updated_at": get_utc_now(), "content_updated_by": actor}


def stamp_view(document: dict) -> dict:
    """读出最近修改信息；旧文档没有专门字段时退回 updated_at，修改者未知。"""
    at = document.get("content_updated_at") or document.get("updated_at")
    return {"content_updated_at": at.isoformat() if hasattr(at, "isoformat") else at,
            "content_updated_by": document.get("content_updated_by")}


def requirement_part(outline: str) -> str:
    """续写大纲请求里只取作者写的“后续要求”，不重复存章纲草稿。"""
    match = re.search(r"【后续要求】\n?(.*)\Z", outline, re.S)
    return (match.group(1) if match else outline).strip()


async def record(novel_id: str, source: str, text: str, *, detail: dict | None = None) -> None:
    """追加一条作者输入；空文本不记，失败只记日志。"""
    if captured_request.get():
        return
    text = (text or "").strip()
    if not text or source not in SOURCES:
        return
    try:
        await history.insert_one({
            "novel_id": to_object_id(novel_id), "source": source, "text": text,
            "truncated": False, "detail": detail or {},
        })
    except Exception:  # noqa: BLE001 - 记录失败不能拖垮生成
        logger.exception("保存输入记录失败 novel=%s source=%s", novel_id, source)


async def list_entries(novel_id: str, *, source: str | None = None, query: str = "",
                       before: str | None = None, limit: int = 50, all_books: bool = False) -> dict:
    """按时间倒序分页读取，可按来源和关键词筛选。"""
    # 补回数据库临时不可用时已保存的原话，固定 _id 使重复读取不会重复追加。
    from bson import json_util
    for path in journal_dir().glob("*.json"):
        try:
            row = json_util.loads(path.read_text(encoding="utf-8"))
            await history.collection.update_one({"_id": row["_id"]}, {"$setOnInsert": row}, upsert=True)
            path.rename(path.with_suffix(".saved"))
        except (OSError, ValueError):
            logger.exception("读取输入记录备份失败: %s", path.name)
    q: dict = {"is_deleted": False}
    if not all_books:
        q["novel_id"] = to_object_id(novel_id)
    if source:
        q["source"] = source
    if query.strip():
        q["text"] = {"$regex": re.escape(query.strip()), "$options": "i"}
    if before:
        q["_id"] = {"$lt": ObjectId(before)}
    rows = await history.collection.find(q).sort("_id", -1).limit(limit + 1).to_list(length=limit + 1)
    return {
        "entries": [{"id": str(row["_id"]), "source": row["source"], "label": SOURCES.get(row["source"], row["source"]),
                     "text": row["text"], "truncated": row.get("truncated", False), "detail": row.get("detail", {}),
                     "created_at": row["created_at"].isoformat()} for row in rows[:limit]],
        "has_more": len(rows) > limit,
        "sources": SOURCES,
    }
