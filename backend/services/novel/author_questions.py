"""写作流里的作者选择：等待时不占用模型请求，回复后继续原工具调用。"""

from __future__ import annotations

import asyncio
import re
import secrets
from contextlib import asynccontextmanager
from dataclasses import dataclass

from backend.api.error_protocol import DomainApiError


TOOL_PROPERTIES = {
    "question": {"type": "string", "minLength": 1, "maxLength": 3000},
    "options": {"type": "array", "minItems": 2, "maxItems": 8,
                "items": {"type": "string", "minLength": 1, "maxLength": 800}},
    "multi_select": {"type": "boolean"},
}
TOOL_DESCRIPTION = ("仅当缺少关键决定、需要作者选择方向时提问，暂停到作者回复后继续当前任务。"
                    "有可比较方案时把 2–8 个具体选项分别放进 options，不要只把选项写在 question 里；"
                    "允许多选时设 multi_select=true。能从资料查到或能按现有要求合理决定的不要问。")
RULE = ("\n需要作者决定剧情方向、范围或关键取舍时，调用 ask_author 并在 options 列出具体方案；"
        "界面会弹出选项并暂停，收到真实回复后按选择继续同一任务。不要把疑问写进正文，也不要假定作者已同意。\n")

_NUMBERED = re.compile(r"^\s*(?:[-*]\s+)?[（(\[]?([1-8A-Ha-h])[）)\].、．:：]\s*(.+?)\s*$")


def normalize_question(question: str, options=None, multi_select: bool = False) -> dict:
    """统一结构化选项，兼容旧智能体写在问题里的逐行编号选项。"""
    question = str(question).strip()
    if not question:
        raise DomainApiError("AUTHOR_QUESTION_EMPTY", "提问内容不能为空")
    values = list(options or [])
    if not values:
        numbered = [match.groups() for line in question.splitlines() if (match := _NUMBERED.match(line))]
        labels = [label.upper() for label, _ in numbered]
        if len(numbered) >= 2 and labels in ([str(i) for i in range(1, len(labels) + 1)],
                                              [chr(ord("A") + i) for i in range(len(labels))]):
            values = [text for _, text in numbered]
    cleaned = list(dict.fromkeys(str(value).strip() for value in values if str(value).strip()))[:8]
    return {"question": question, "options": cleaned, "multi_select": bool(multi_select and len(cleaned) > 1)}


@dataclass
class PendingQuestion:
    payload: dict
    future: asyncio.Future

    async def answer(self) -> str:
        return await self.future


_pending: dict[str, PendingQuestion] = {}


@asynccontextmanager
async def pending(novel_id: str, question: str, options=None, multi_select: bool = False):
    payload = {"id": secrets.token_urlsafe(24), "novel_id": str(novel_id),
               **normalize_question(question, options, multi_select)}
    item = PendingQuestion(payload, asyncio.get_running_loop().create_future())
    _pending[payload["id"]] = item
    try:
        yield item
    finally:
        _pending.pop(payload["id"], None)
        if not item.future.done():
            item.future.cancel()


def submit_answer(novel_id: str, question_id: str, answer: str) -> None:
    """只有当前书的活跃问题接受一次回复；取消、过期和重复回复均不交给其他任务。"""
    item = _pending.get(question_id)
    if item is None or item.future.done():
        raise DomainApiError("AUTHOR_QUESTION_EXPIRED", "这个问题已结束或已经回复，请查看当前工作流程。", status_code=409)
    if item.payload["novel_id"] != str(novel_id):
        raise DomainApiError("AUTHOR_QUESTION_NOT_FOUND", "当前书没有这个待回复问题。", status_code=404)
    text = answer.strip()
    if not text or len(text) > 12000:
        raise DomainApiError("AUTHOR_ANSWER_INVALID", "请先选择一个选项或填写回复，回复最多 12000 字。", status_code=422)
    item.future.set_result(text)
