"""流式作品的追加式磁盘日志；在交付片段前持久化，进程退出也可恢复。"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone

from bson import ObjectId

SOURCES = {"continuation": "续写正文", "outline": "生成大纲", "summarize": "生成概要",
           "materials": "整理素材", "selection_agent": "AI 修改", "deslop": "去痕"}


def directory(novel_id: str):
    from backend.storage import USER_DATA_DIR
    return USER_DATA_DIR / "output_history" / str(ObjectId(novel_id))


class OutputJournal:
    def __init__(self, novel_id: str, source: str, title: str = ""):
        self.id = str(ObjectId())
        root = directory(novel_id)
        root.mkdir(parents=True, exist_ok=True)
        self.path = root / f"{self.id}.jsonl"
        self.terminal = False
        self.write({"event": "start", "source": source, "title": title,
                    "created_at": datetime.now(timezone.utc).isoformat()})

    def write(self, event: dict):
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False) + "\n")
            handle.flush()
            os.fsync(handle.fileno())

    def feed(self, event: dict):
        name = event.get("event")
        if name in {"delta", "replacement", "done", "error"}:
            # 不保存思考、凭据或工具参数，只保存交付给作者的作品及保存依据。
            self.write({key: event[key] for key in ("event", "text", "basis", "message") if key in event})
            self.terminal = name in {"done", "error"}

    def close(self):
        if not self.terminal:
            self.write({"event": "interrupted"})
            self.terminal = True


def read_entry(novel_id: str, entry_id: str) -> dict:
    path = directory(novel_id) / f"{ObjectId(entry_id)}.jsonl"
    row = {"id": entry_id, "text": "", "status": "interrupted", "versions": []}
    with path.open("rb") as handle:
        for line in handle:
            try:
                event = json.loads(line)
            except (ValueError, UnicodeDecodeError):
                continue  # 强制关闭时最后一条可能没写完，先前已落盘的片段仍可读。
            name = event.get("event")
            if name == "start":
                row.update({key: event.get(key, "") for key in ("source", "title", "created_at")})
            elif name == "delta":
                row["text"] += event.get("text", "")
            elif name in {"replacement", "done"}:
                text = event.get("text")
                if isinstance(text, str) and text != row["text"]:
                    if row["text"]:
                        row["versions"].append(row["text"])
                    row["text"] = text
                if "basis" in event:
                    row["basis"] = event["basis"]
            if name in {"done", "error", "interrupted"}:
                row["status"] = name
    return row


def list_entries(novel_id: str, *, before: str | None = None, query: str = "", limit: int = 30) -> dict:
    rows = []
    for path in sorted(directory(novel_id).glob("*.jsonl"), reverse=True):
        if before and path.stem >= before:
            continue
        row = read_entry(novel_id, path.stem)
        if query.casefold() not in (row.get("title", "") + row["text"]).casefold():
            continue
        if not row["text"]:
            continue
        rows.append({key: value for key, value in row.items() if key not in {"text", "versions", "basis"}} |
                    {"preview": row["text"][:200], "chars": len(row["text"])})
        if len(rows) > limit:
            break
    return {"entries": rows[:limit], "has_more": len(rows) > limit, "sources": SOURCES}
