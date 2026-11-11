"""在业务准备、模型校验和流式生成之前，统一保存作者提交的输入。"""
from __future__ import annotations

import json
import re

from backend.services.novel import input_history

# 只取作者输入字段，不归档凭据、模型输出缓存或模型生成的历史稿件。
FIELDS = {"instruction", "instructions", "message", "prompt", "user_prompt", "requirements",
          "review_requirements", "feedback", "reply", "text", "outline", "materials"}


def extract(path: str, body: dict) -> tuple[str, list[tuple[str, str]]]:
    source = "other"
    if "/writing-agent/" in path:
        source = "selection_agent" if "/rewrite/" in path else "feedback"
    elif "/book-agent/" in path:
        source = "book_agent"
    elif "/assistant/" in path:
        source = "assistant"
    elif "/continuation/" in path:
        source = {"write": "continuation", "outline": "outline", "summary": "summary", "materials": "materials"}.get(body.get("action"), "continuation")
    elif "/llm/" in path or "flow_inputs" in body:
        source = "task_flow"
    # 保存、导入和采用模型结果不是新一次对 AI 的发言。
    if path.endswith(("/save", "/confirm", "/learn", "/import")) or "/input-history" in path:
        return source, []
    parts = []
    for key, value in body.items():
        if key in FIELDS and isinstance(value, str) and value.strip():
            parts.append((key, value))
    # 每轮只记本轮追问；之前的稿件不冒充作者发言。
    if source == "selection_agent" and isinstance(body.get("attempts"), list) and body["attempts"]:
        last = body["attempts"][-1]
        if isinstance(last, dict) and isinstance(last.get("feedback"), str) and last["feedback"].strip():
            parts = [("feedback", last["feedback"])]
    if source == "feedback" and isinstance(body.get("turns"), list) and body["turns"]:
        last = body["turns"][-1]
        if isinstance(last, dict) and isinstance(last.get("reply"), str) and last["reply"].strip():
            parts = [("reply", last["reply"])]
    # 自定义任务图的输入字段由用户自定义，必须完整保留，不靠字段名猜测。
    for key in ("flow_inputs",):
        if isinstance(body.get(key), dict) and body[key]:
            parts.append((key, json.dumps(body[key], ensure_ascii=False, indent=2)))
    return source, parts


async def capture_request(request):
    path = request.url.path
    if request.method not in {"POST", "PUT", "PATCH"} or not path.startswith("/api/"):
        return False
    if path.startswith(("/api/config", "/api/input-history")) or "application/json" not in request.headers.get("content-type", ""):
        return False
    try:
        body = await request.json()
    except (ValueError, UnicodeDecodeError):
        return False
    if not isinstance(body, dict):
        return False
    source, parts = extract(path, body)
    # 通用 text 只在智能体入口捕获，普通编辑正文不是给 AI 发言。
    if source == "other":
        parts = [(key, value) for key, value in parts if key not in {"text", "outline", "materials"}]
    if not parts:
        return False
    match = re.search(r"/(?:novels|novel)/([a-fA-F0-9]{24})(?:/|$)", path)
    scope = body.get("scope") if isinstance(body.get("scope"), dict) else {}
    novel_id = match.group(1) if match else body.get("novel_id") or scope.get("novel_id")
    if not isinstance(novel_id, str) or not re.fullmatch(r"[a-fA-F0-9]{24}", novel_id):
        novel_id = None
    for field, text in parts:
        await input_history.capture(novel_id, source, text, {
            "path": path, "field": field, "kind": "follow_up" if field in {"feedback", "reply"} else "turn",
            "model": body.get("model", ""), "provider": body.get("provider", ""),
        })
    return True
