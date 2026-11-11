"""智能体查资料时批量读章节正文，并按章节版本缓存。

全书搜索、连续读多章以往逐章调用 ChapterService.get_chapter：每章要再查一遍场景、篇章、分卷和小说（约 5 次查询），
30 章的书搜一次约 150 次查询。这里的行来自 list_chapters（已经核对过父级链和本书范围），只需一次 $in 查询取正文。

缓存键是（章节 id, 章节版本）：正文一改版本就变，旧条目自然失效，不会读到旧稿。按总字数限额，最久没用的先丢。
"""

from __future__ import annotations

from collections import OrderedDict

from backend.db.base import BaseRepository

# 缓存的正文总字数上限（约 600 万字，按 UTF-8 中文约 18MB）；够几本长篇同时被智能体查阅。
CACHE_CHARS = 6_000_000
BATCH = 200

_cache: "OrderedDict[tuple[str, int], str]" = OrderedDict()
_chars = 0


def _put(key: tuple[str, int], text: str) -> None:
    global _chars
    if key in _cache:
        _cache.move_to_end(key)
        return
    _cache[key] = text
    _chars += len(text)
    while _chars > CACHE_CHARS and len(_cache) > 1:
        _, dropped = _cache.popitem(last=False)
        _chars -= len(dropped)


def clear() -> None:
    global _chars
    _cache.clear()
    _chars = 0


async def contents(rows: list[dict]) -> dict[str, str]:
    """按 list_chapters 的行取正文：{章节 id: 正文}。缓存里没有的一次批量读出。"""
    found: dict[str, str] = {}
    missing = []
    for row in rows:
        key = (str(row["_id"]), int(row.get("version") or 0))
        if key in _cache:
            _cache.move_to_end(key)
            found[key[0]] = _cache[key]
        else:
            missing.append(row)
    collection = BaseRepository("chapters").collection
    for start in range(0, len(missing), BATCH):
        part = missing[start:start + BATCH]
        versions = {row["_id"]: int(row.get("version") or 0) for row in part}
        async for doc in collection.find({"_id": {"$in": list(versions)}}, {"content": 1, "version": 1}):
            text = doc.get("content") or ""
            found[str(doc["_id"])] = text
            # 读取期间刚被改过的章不进缓存：版本对不上时下次重新读。
            if int(doc.get("version") or 0) == versions.get(doc["_id"]):
                _put((str(doc["_id"]), versions[doc["_id"]]), text)
    return found


async def content(row: dict) -> str:
    return (await contents([row])).get(str(row["_id"]), "")
