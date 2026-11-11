"""只在完整工具批次之间恢复对话；书籍版本或设置变化时回退到工作笔记。"""
import hashlib
import json
from backend.llm.models import LLMRequest, LLMToolResult

MAX_BYTES = 6_000_000


async def book_signature(novel_id: str) -> str:
    from backend.db.repositories.novel_repository import novel_repo
    from backend.services.novel.chapter_service import ChapterService
    novel = await novel_repo.get_novel_by_id(novel_id)
    rows = await ChapterService.list_chapters(novel_id)
    value = [novel["version"], [[str(row["_id"]), row["version"], row["chapter_number"]] for row in rows]]
    return hashlib.sha256(json.dumps(value).encode()).hexdigest()


def notes_digest(notes):
    return hashlib.sha256(json.dumps(notes, sort_keys=True, default=str, ensure_ascii=False).encode()).hexdigest()


def pack(request, history, results, settings: dict, signature: str, notes: list) -> dict | None:
    value = {"request": request.model_dump(mode="json"), "history": history,
             "results": [item.model_dump(mode="json") for item in results],
             "settings": settings, "signature": signature, "notes": notes_digest(notes)}
    return value if len(json.dumps(value, ensure_ascii=False).encode()) <= MAX_BYTES else None


def restore(value, settings: dict, signature: str, notes: list, model: str, system: str):
    if not isinstance(value, dict) or value.get("signature") != signature:
        return None
    # 上下文预算只决定何时整理，不影响历史是否还能接着用，调整它不应让检查点作废。
    ignore = {"context_budget"}
    saved = value.get("settings")
    if not isinstance(saved, dict) or {k: v for k, v in saved.items() if k not in ignore} != {k: v for k, v in settings.items() if k not in ignore}:
        return None
    # 参考书可能被单独编辑，目前不复用含参考书的旧对话。
    if settings.get("reference_books") or value.get("notes") != notes_digest(notes):
        return None
    try:
        request = LLMRequest.model_validate(value["request"])
        results = [LLMToolResult.model_validate(item) for item in value["results"]]
        if request.model != model or request.system_prompt != system or not isinstance(value["history"], list):
            return None
        return request, value["history"], results
    except (KeyError, ValueError, TypeError):
        return None
