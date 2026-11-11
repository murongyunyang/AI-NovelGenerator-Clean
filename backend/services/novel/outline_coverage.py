"""检查一章正文是否写到了本章大纲的结束点，没写到就从断点接着写。

模型一次写很长的大纲时容易越写越压缩，或者写到单次输出上限后就交稿，正文停在大纲中段。
这里用一次独立的模型调用逐条对照大纲事件，列出还没写到的部分；续写只发正文尾部和缺的事件。
"""

from __future__ import annotations

import hashlib
from collections.abc import AsyncIterator, Awaitable, Callable

from pydantic import BaseModel, Field

# 自动接着写的轮数上限：每轮还能写一次单次输出上限那么长，6 轮足够写完很长的章纲，又不会失控。
MAX_EXTENSIONS = 6
# 交给检查的正文：开头和结尾都要看到，中间太长时截掉一部分（检查只需判断事件有没有写到）。
CHECK_HEAD = 30000
CHECK_TAIL = 30000


class Coverage(BaseModel):
    reached_end: bool
    last_event: str = Field(default="", max_length=400)
    missing: list[str] = Field(default_factory=list, max_length=20)
    rushed: list[str] = Field(default_factory=list, max_length=10)


CoverageFn = Callable[[str], Awaitable[Coverage]]


def _draft_view(draft: str) -> str:
    if len(draft) <= CHECK_HEAD + CHECK_TAIL:
        return draft
    return draft[:CHECK_HEAD] + f"\n\n……（中间 {len(draft) - CHECK_HEAD - CHECK_TAIL} 字略）……\n\n" + draft[-CHECK_TAIL:]


def coverage_prompt(plan: str, draft: str, target_words: int | None = None) -> str:
    length = f"作者期望篇幅约 {target_words} 字，当前正文 {len(draft)} 字。" if target_words else f"当前正文 {len(draft)} 字。"
    return (f"{plan}\n\n【已写的正文】\n{_draft_view(draft)}\n\n"
            "请只做一件事：对照上面本章大纲里依次要发生的事件，判断正文写到了哪里。" + length +
            "逐条核对大纲事件：正文里写成了场景或至少明确交代了的算写到；一句话概述带过本该展开的关键冲突，列进 rushed。"
            "正文结尾停在大纲中段、后面的事件没写，reached_end 为 false，把没写到的事件按大纲顺序列进 missing（每条一句，照大纲原意）。"
            "大纲最后的事件已经写到，reached_end 为 true，missing 为空。不评价文笔，不提修改意见。"
            '只输出 JSON 对象：{"reached_end": 布尔值, "last_event": "正文最后写到的大纲事件", "missing": ["没写到的事件"], "rushed": ["被一句话带过的关键事件"]}')


def make_checker(service, plan: str, options: dict, target_words: int | None = None) -> CoverageFn | None:
    """没有本章大纲（例如选段修改）时不检查。"""
    if not plan.strip():
        return None
    from backend.services.novel import writing_agent as agent
    cache: dict[str, Coverage] = {}

    async def check(draft: str) -> Coverage:
        key = hashlib.sha256(draft.encode()).hexdigest()
        if key not in cache:
            cache[key] = await agent._generate_json(service, coverage_prompt(plan, draft, target_words), Coverage, options)
        return cache[key]

    return check


UNFINISHED = "\n正文停在大纲中段，后面的事件还没写。"


def missing_note(result: Coverage) -> str:
    lines = [f"- {item}" for item in result.missing]
    if result.last_event:
        lines.insert(0, f"正文目前写到：{result.last_event}")
    return "【大纲里还没写到的事件（按顺序）】\n" + "\n".join(lines)


def paragraph_sep(draft: str) -> str:
    """段落分隔沿用正文原来的写法（空一行或只换行）。"""
    return "\n\n" if "\n\n" in draft else "\n"


async def joined(draft: str, chunks: AsyncIterator[str]) -> AsyncIterator[str]:
    """接着写的片段接到 draft（已去掉末尾换行）后面：第一段去掉开头空行，补上段落分隔。"""
    from contextlib import aclosing
    first = True
    async with aclosing(chunks) as stream:
        async for chunk in stream:
            if first:
                chunk = chunk.lstrip("\r\n")
                if not chunk:
                    continue
                chunk, first = (paragraph_sep(draft) if draft else "") + chunk, False
            yield chunk


def extend(service, prompt: str, draft: str, note: str, system: str, options: dict) -> AsyncIterator[str]:
    """从正文末尾接着写。draft 应已去掉末尾换行；note 说明这一段要写什么。"""
    from backend.services.novel.output_filter import continuation_prompt, stream_prose
    return joined(draft, stream_prose(service, continuation_prompt(prompt, draft, note), system, options))


async def extend_until_covered(service, prompt: str, draft: str, check: CoverageFn | None, system: str, options: dict,
                               *, limit: int = MAX_EXTENSIONS) -> AsyncIterator[dict]:
    """固定流程用：检查 → 接着写 → 再检查，直到写到大纲结束点。

    Yields:
        progress、delta 事件；最后一个是 {"event": "_covered", "text": 完整正文, "coverage": 最后一次检查结果或 None}。
    """
    result = None
    for number in range(limit + 1):
        if check is None:
            break
        yield {"event": "progress", "message": "正在核对正文是否写到了大纲的结束点…"}
        try:
            result = await check(draft)
        except Exception:
            # 检查本身失败不能让作者拿不到正文。
            result = None
            break
        if result.reached_end or not result.missing or number == limit:
            break
        yield {"event": "progress", "message": f"正文停在大纲中段（还有 {len(result.missing)} 个事件没写），正在接着写…"}
        yield {"event": "trace", "kind": "tool", "tool": "outline_coverage",
               "label": f"大纲还没写完，第 {number + 1} 次接着写", "text": missing_note(result)}
        piece = ""
        draft = draft.rstrip("\r\n")
        async for chunk in extend(service, prompt, draft, missing_note(result) + UNFINISHED, system, options):
            piece += chunk
            yield {"event": "delta", "text": chunk}
        if not piece.strip():
            break
        draft += piece
    yield {"event": "_covered", "text": draft, "coverage": result.model_dump() if result else None}
