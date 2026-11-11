"""把作者在 Claude Code 里积累的记忆（~/.claude/projects/*/memory/*.md）导入为写作偏好。

只读取这一种目录下的 Markdown 文件；客户端只传文件键，不传路径。重复导入同一文件会更新原偏好而不是新增。
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Literal

import yaml
from pydantic import Field

from backend.api.contracts import StrictRequestModel
from backend.api.error_protocol import DomainApiError
from backend.db.utils import to_object_id
from backend.services.novel import writing_agent as agent

_KEY = re.compile(r"^[\w.\-]+/[\w.\-]+\.md$")
_LINK = re.compile(r"\[\[([^\]]+)\]\]")
# 这些记忆讲的是工具、文件位置或进度，不是写作要求，默认不勾选。
_NOT_WRITING = ("cli", "codebuddy", "docx", "layout", "pipeline", "progress", "reply-in", "read-cwd", "xml", "布局", "进度", "配置")


def memory_root() -> Path:
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude") / "projects"


def _parse(path: Path) -> dict | None:
    raw = path.read_text(encoding="utf-8", errors="replace")
    meta, body = {}, raw
    if raw.startswith("---"):
        parts = raw.split("---", 2)
        if len(parts) == 3:
            try:
                meta = yaml.safe_load(parts[1]) or {}
            except yaml.YAMLError:
                meta = {}
            body = parts[2]
    # frontmatter 可能是字符串或列表；只认字典，免得一个文件让整个列表读取失败。
    if not isinstance(meta, dict):
        meta = {}
    body = _LINK.sub(r"\1", body).strip()
    if not body:
        return None
    nested = meta.get("metadata")
    kind = (nested.get("type") if isinstance(nested, dict) else None) or meta.get("type") or ""
    return {"name": str(meta.get("name") or path.stem), "title": str(meta.get("description") or meta.get("name") or path.stem)[:200],
            "text": body[:agent.MAX_MEMORY_CHARS], "type": str(kind)}


def scan(merged: set[str] = frozenset()) -> list[dict]:
    """列出可导入的记忆，并给出建议：写作要求默认勾选；“project”类设定默认只用于本书。

    已整理进现有偏好（merged_from）的文件标为 merged、默认不选，避免把整理前的长文重新导入一遍。
    """
    root = memory_root()
    items = []
    if not root.is_dir():
        return items
    for directory in sorted(root.iterdir()):
        folder = directory / "memory"
        if not folder.is_dir():
            continue
        for path in sorted(folder.glob("*.md")):
            if path.name.upper() == "MEMORY.MD":
                continue
            parsed = _parse(path)
            if parsed is None:
                continue
            key = f"{directory.name}/{path.name}"
            lowered = (parsed["name"] + " " + parsed["title"]).lower()
            writing = not any(word in lowered for word in _NOT_WRITING)
            setting = parsed["type"] == "project" or "设定" in parsed["title"][:12] or "setting" in parsed["name"]
            items.append({"key": key, "project": directory.name, **parsed, "merged": key in merged,
                          "suggested": writing and key not in merged, "suggested_scope": "novel" if setting else "global"})
    return items


async def merged_keys(novel_id: str) -> set[str]:
    return {key for item in await agent.list_memories(novel_id) for key in item.get("merged_from", [])}


class ImportItem(StrictRequestModel):
    key: str = Field(min_length=1, max_length=400)
    scope: Literal["global", "novel"] = "global"


class ImportRequest(StrictRequestModel):
    items: list[ImportItem] = Field(min_length=1, max_length=agent.MAX_MEMORIES)


async def import_memories(novel_id: str, req: ImportRequest) -> dict:
    root = memory_root().resolve()
    created = updated = 0
    for item in req.items:
        if not _KEY.match(item.key):
            raise DomainApiError("WRITING_MEMORY_IMPORT_INVALID", "导入项无效，请重新读取 Claude Code 记忆列表")
        project, name = item.key.split("/")
        path = (root / project / "memory" / name).resolve()
        if path.parent.parent.parent != root or not path.is_file():
            raise DomainApiError("WRITING_MEMORY_IMPORT_MISSING", f"找不到记忆文件：{item.key}", status_code=404)
        parsed = _parse(path)
        if parsed is None:
            continue
        setting = parsed["type"] == "project" or "设定" in parsed["title"][:12] or "setting" in parsed["name"]
        scope = "novel" if setting else item.scope
        owner = to_object_id(novel_id) if scope == "novel" else None
        existing = await agent.memories.find_one({"import_key": item.key, "novel_id": owner})
        if existing:
            await agent.memories.update_one({"_id": existing["_id"]}, {"title": parsed["title"], "text": parsed["text"]})
            updated += 1
            continue
        if await agent._memory_count(novel_id) >= agent.MAX_MEMORIES:
            raise DomainApiError("WRITING_MEMORY_FULL", f"偏好最多保存 {agent.MAX_MEMORIES} 条，已导入 {created} 条", status_code=409)
        await agent._insert_memory(novel_id, parsed["text"], scope, "claude_code", title=parsed["title"], import_key=item.key,
                                   category="setting" if setting else "other", plot_specific=setting)
        created += 1
    return {"created": created, "updated": updated}
