"""智能体自己维护的计划清单（类似待办列表）：模型每次提交完整清单，界面实时显示进度。"""

from __future__ import annotations

from backend.api.error_protocol import DomainApiError

MAX_ITEMS = 12
STATUSES = ("pending", "in_progress", "done", "cancelled")


def normalize(items: list[dict], previous: list[dict]) -> list[dict]:
    """校验并规整模型提交的清单；文字相同的条目沿用原 id，界面上的条目保持稳定。"""
    if not 1 <= len(items) <= MAX_ITEMS:
        raise DomainApiError("WRITING_AGENT_PLAN", f"计划需要 1 到 {MAX_ITEMS} 项")
    known = {item["text"]: item["id"] for item in previous}
    taken: set[str] = set()
    result = []
    for index, item in enumerate(items, 1):
        text, status = str(item.get("text", "")).strip(), item.get("status", "pending")
        if not text or len(text) > 120 or status not in STATUSES:
            raise DomainApiError("WRITING_AGENT_PLAN", "每项计划需要 120 字以内的内容，状态为 pending、in_progress、done 或 cancelled")
        identity = known.get(text)
        if identity is None or identity in taken:
            identity = f"p{index}"
            while identity in taken:
                identity += "x"
        taken.add(identity)
        result.append({"id": identity, "text": text, "status": status})
    if sum(item["status"] == "in_progress" for item in result) > 1:
        raise DomainApiError("WRITING_AGENT_PLAN", "同一时间只能有一项处于 in_progress")
    return result


def open_items(plan: list[dict]) -> list[dict]:
    return [item for item in plan if item["status"] in {"pending", "in_progress"}]
