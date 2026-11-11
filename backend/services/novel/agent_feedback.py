"""作者给智能体提的意见：每条都直接整理成一条写作偏好保存，作者事后可以查看、提意见改写或撤销。

- 写法类意见（对白、心理活动、标点、节奏等）存成可跨书参考的偏好；只针对某处剧情、人物、设定的意见存成“本书设定”，只用于本书。
- 和已有的本书偏好说的是同一件事时，改写那一条，不重复新建；改写前的原文随结果返回，供界面撤销。
- 模型整理失败时，原话照样存成一条只用于本书的偏好，不让意见丢失。
- 以前“同类问题出现 3 次才总结成经验”的暂存意见和经验仍可查看；经验照旧带进写作提示。
"""

from __future__ import annotations

from difflib import SequenceMatcher
from typing import Literal

from pydantic import BaseModel, Field

from backend.api.contracts import StrictRequestModel
from backend.api.error_protocol import DomainApiError
from backend.db.base import BaseRepository
from backend.db.utils import to_object_id

notes = BaseRepository("writing_agent_feedback")
MAX_NOTE = 2000
MAX_RULE = 180
MAX_COMPARE = 80


class FeedbackInput(StrictRequestModel):
    text: str = Field(min_length=1, max_length=MAX_NOTE)
    target: Literal["chapter", "outline"] = "chapter"
    # 意见针对的那一稿的开头，帮助模型理解意见；不存全文。
    excerpt: str = Field(default="", max_length=400)
    provider: str = Field(default="", max_length=100)
    model: str = Field(default="", max_length=300)


class ReviseInput(StrictRequestModel):
    instruction: str = Field(min_length=1, max_length=MAX_NOTE)
    provider: str = Field(default="", max_length=100)
    model: str = Field(default="", max_length=300)


def _rule_model():
    from backend.services.novel.writing_agent import MemoryCategory

    class Rule(BaseModel):
        text: str = Field(min_length=1, max_length=MAX_RULE)
        title: str = Field(default="", max_length=35)
        category: MemoryCategory = "other"
        plot_specific: bool = True
        memory_id: str | None = None
    return Rule


def _key(text: str) -> str:
    from backend.services.novel.writing_agent import _preference_key
    return _preference_key(text)


def _own(row: dict, novel_id: str) -> bool:
    return row.get("scope") == "novel" and (row.get("source_novel_id") or "") == novel_id


def _extract_prompt(req: FeedbackInput, rows: list[dict], novel_id: str) -> str:
    from backend.services.novel.writing_agent import CATEGORY_HINT
    own = "\n".join(f"- id={row['id']}：{row['text'][:200]}" for row in rows if _own(row, novel_id)) or "（无）"
    other = "\n".join(f"- {row['text'][:120]}" for row in rows if not _own(row, novel_id)) or "（无）"
    kind = "大纲" if req.target == "outline" else "正文"
    return (f"【作者对智能体写的这一稿{kind}提的意见】\n{req.text.strip()}\n\n"
            + (f"【这一稿的开头，仅供理解意见】\n{req.excerpt.strip()}\n\n" if req.excerpt.strip() else "")
            + f"【本书已有的偏好（可改写）】\n{own}\n\n【其他已有偏好（只读）】\n{other}\n\n"
            "把作者这条意见整理成一条以后写作时要遵守的写作偏好。\n"
            f"- text：一句祈使句，不超过 {MAX_RULE} 字，只依据作者原话，不添加作者没说的要求；必要时带一个简短的正反例。\n"
            "- title：不超过 20 字的标题。\n"
            "- 意见指出的是写法问题（对白、心理活动、标点、节奏、描写、逻辑等）时，写成通用规则，不写具体人名和情节，plot_specific=false。\n"
            "- 意见针对的是某处剧情、人物的选择或本书设定（例如“这里主角不该原谅他”）时，保留人名和情节写清楚，category=setting，plot_specific=true。\n"
            "- 和【本书已有的偏好】里某一条说的是同一件事，或作者在纠正它时，填那一条的 memory_id，text 写合并后的新规则；否则 memory_id 填 null。\n"
            + CATEGORY_HINT +
            '\n只输出 JSON 对象：{"text": "…", "title": "…", "category": "style", "plot_specific": false, "memory_id": null}')


async def record(service, novel_id: str, req: FeedbackInput) -> dict:
    """把一条意见存成写作偏好。

    Returns:
        {"action": "created" | "updated" | "exists", "memory": 偏好, "previous_text": 改写前的原文（只有 updated 有）}
    """
    from backend.services.novel import writing_agent as agent
    from backend.services.novel.writing_runtime import bounded
    text = req.text.strip()
    if not text:
        raise DomainApiError("AGENT_FEEDBACK_EMPTY", "意见不能为空")
    rows = (await agent.list_memories(novel_id))[:MAX_COMPARE]
    Rule = _rule_model()
    try:
        rule = await bounded(agent._generate_json(service, _extract_prompt(req, rows, novel_id), Rule,
                                                  {"model": req.model} if req.model else {}), 60)
    except Exception:
        # 整理失败：原话存成只用于本书的偏好，作者之后可以提意见改写。
        rule = Rule(text=text[:MAX_RULE], title=text[:20], category="other", plot_specific=True)
    return await _save(novel_id, rows, rule)


async def _save(novel_id: str, rows: list[dict], rule) -> dict:
    from backend.services.novel import writing_agent as agent
    rule_text = rule.text.strip()
    if rule.category == "setting":
        rule.plot_specific = True
    target = next((row for row in rows if row["id"] == rule.memory_id and _own(row, novel_id)), None)
    if target is not None:
        if _key(target["text"]) == _key(rule_text):
            return {"action": "exists", "memory": target, "previous_text": None}
        updated = await agent.update_memory(novel_id, target["id"], agent.MemoryUpdate(
            text=rule_text, **({"title": rule.title.strip()} if rule.title.strip() else {})))
        return {"action": "updated", "memory": updated, "previous_text": target["text"]}
    key = _key(rule_text)
    same = next((row for row in rows if _key(row["text"]) == key or SequenceMatcher(None, key, _key(row["text"])).ratio() >= .86), None)
    if same is not None:
        return {"action": "exists", "memory": same, "previous_text": None}
    if await agent._memory_count(novel_id) >= agent.MAX_MEMORIES:
        raise DomainApiError("WRITING_MEMORY_FULL", "偏好已满，请清理不再需要的规则")
    created = await agent._insert_memory(novel_id, rule_text, "novel", "feedback", title=rule.title.strip() or rule_text[:20],
                                         category=rule.category, plot_specific=rule.plot_specific)
    return {"action": "created", "memory": created, "previous_text": None}


# ---- 先商量再保存：模型说出它理解的偏好方向并提问，作者逐轮调整，确认后才存 ----

class DraftTurn(BaseModel):
    """商量过程中的一轮：模型当时的提案和作者对它的回应。"""
    proposal: str = Field(default="", max_length=MAX_RULE * 2)
    reply: str = Field(default="", max_length=MAX_NOTE)


class DraftInput(FeedbackInput):
    turns: list[DraftTurn] = Field(default_factory=list, max_length=12)


class ConfirmInput(StrictRequestModel):
    text: str = Field(min_length=1, max_length=MAX_RULE)
    title: str = Field(default="", max_length=35)
    category: str = Field(default="other", max_length=30)
    plot_specific: bool = True
    memory_id: str | None = Field(default=None, max_length=40)


def _draft_model():
    Rule = _rule_model()

    class Draft(Rule):
        # 作者的意见可能有几种理解：每种写成一条候选规则，供作者挑或继续改。
        understanding: str = Field(default="", max_length=300)
        alternatives: list[str] = Field(default_factory=list, max_length=3)
        question: str = Field(default="", max_length=300)
    return Draft


def _draft_prompt(req: DraftInput, rows: list[dict], novel_id: str) -> str:
    history = "\n".join(f"第 {index} 轮：你提的偏好：{turn.proposal}\n作者的回应：{turn.reply}"
                        for index, turn in enumerate(req.turns, 1) if turn.proposal or turn.reply)
    return (_extract_prompt(req, rows, novel_id).rsplit("\n只输出 JSON", 1)[0]
            + ("\n\n【之前几轮商量（作者的回应优先于他最初的原话）】\n" + history if history else "")
            + "\n\n现在还不保存，先和作者确认方向：\n"
            "- understanding：一句话说你理解作者想要的效果是什么（作者看了能判断你有没有理解偏）。\n"
            "- text、title、category、plot_specific、memory_id：按上面的规则，写出你现在认为最贴近作者意思的一条偏好。\n"
            "- alternatives：作者的意见还可能有别的理解时，各写成一条候选规则（0–3 条，和 text 明显不同，不凑数）。\n"
            "- question：只问一个最影响写法的问题（例如适用范围、程度、正反例），作者的意思已经清楚时留空。\n"
            '只输出 JSON 对象：{"understanding": "…", "text": "…", "title": "…", "category": "style", "plot_specific": false, '
            '"memory_id": null, "alternatives": [], "question": ""}')


async def draft(service, novel_id: str, req: DraftInput) -> dict:
    """根据意见（和之前几轮商量）提出一条偏好草案，不保存。"""
    from backend.services.novel import writing_agent as agent
    from backend.services.novel.writing_runtime import bounded
    if not req.text.strip():
        raise DomainApiError("AGENT_FEEDBACK_EMPTY", "意见不能为空")
    rows = (await agent.list_memories(novel_id))[:MAX_COMPARE]
    Draft = _draft_model()
    try:
        result = await bounded(agent._generate_json(service, _draft_prompt(req, rows, novel_id), Draft,
                                                    {"model": req.model} if req.model else {}), 60)
    except Exception as exc:
        raise DomainApiError("AGENT_FEEDBACK_DRAFT_FAILED", "模型没能整理出偏好草案，请稍后重试", status_code=502) from exc
    if result.category == "setting":
        result.plot_specific = True
    target = next((row for row in rows if row["id"] == result.memory_id and _own(row, novel_id)), None)
    return {**result.model_dump(), "memory_id": target["id"] if target else None,
            "replaces": {"id": target["id"], "text": target["text"]} if target else None}


async def confirm(novel_id: str, req: ConfirmInput) -> dict:
    """作者确认后保存草案；和已有偏好重复或要改写已有一条时按 record 的规则处理。"""
    from backend.services.novel import writing_agent as agent
    rows = (await agent.list_memories(novel_id))[:MAX_COMPARE]
    Rule = _rule_model()
    category = req.category if req.category in getattr(agent.MemoryCategory, "__args__", ()) else "other"
    rule = Rule(text=req.text.strip()[:MAX_RULE], title=req.title, category=category,
                plot_specific=req.plot_specific, memory_id=req.memory_id)
    return await _save(novel_id, rows, rule)


async def revise(service, novel_id: str, memory_id: str, req: ReviseInput) -> dict:
    """按作者对一条偏好的意见改写它。返回改写前后的内容，界面可以撤销。"""
    from backend.services.novel import writing_agent as agent
    from backend.services.novel.writing_runtime import bounded
    current = agent.serialize_memory(await agent._owned(novel_id, memory_id))

    class Revised(BaseModel):
        text: str = Field(min_length=1, max_length=agent.MAX_MEMORY_CHARS)
        title: str = Field(default="", max_length=35)

    prompt = (f"【一条写作偏好】\n标题：{current['title']}\n内容：{current['text']}\n\n【作者对这条偏好的意见】\n{req.instruction.strip()}\n\n"
              "按作者的意见改写这条偏好：只改作者要求改的地方，其余意思保留；不添加作者没说的要求。"
              f"内容尽量保持一句话（不超过 {MAX_RULE} 字，作者要求写详细时可以更长），title 不超过 20 字。"
              '只输出 JSON 对象：{"text": "…", "title": "…"}')
    try:
        result = await bounded(agent._generate_json(service, prompt, Revised, {"model": req.model} if req.model else {}), 60)
    except DomainApiError:
        raise
    except Exception as exc:
        raise DomainApiError("WRITING_MEMORY_REVISE_FAILED", "模型没能改写这条偏好，请稍后重试或直接编辑", status_code=502) from exc
    updated = await agent.update_memory(novel_id, memory_id, agent.MemoryUpdate(
        text=result.text.strip(), **({"title": result.title.strip()} if result.title.strip() else {})))
    return {"before": {"text": current["text"], "title": current["title"]}, "memory": updated}


# ---- 以前暂存的意见：只读和删除，不再新增 ----

def serialize(row: dict) -> dict:
    return {"id": str(row["_id"]), "text": row["text"], "issue": row.get("issue", ""), "target": row.get("target", "chapter"),
            "status": row.get("status", "open"), "excerpt": row.get("excerpt", ""),
            "created_at": row["created_at"].isoformat() if row.get("created_at") else None}


async def list_open(novel_id: str) -> list[dict]:
    rows = await notes.collection.find({"novel_id": to_object_id(novel_id), "status": "open"}).sort("created_at", -1).to_list(length=200)
    return [serialize(row) for row in rows]


async def delete(novel_id: str, note_id: str) -> None:
    result = await notes.collection.delete_one({"_id": to_object_id(note_id), "novel_id": to_object_id(novel_id), "status": "open"})
    if not result.deleted_count:
        raise DomainApiError("AGENT_FEEDBACK_NOT_FOUND", "这条意见已删除", status_code=404)


async def lesson_text(novel_id: str) -> str:
    """写进任务提示的经验（以前由反复出现的意见总结而来）。读不出来时返回空，不影响写作。"""
    from backend.services.novel import agent_library
    try:
        _, rows = await agent_library.approved(novel_id)
    except Exception:
        return ""
    return "\n".join(f"- {row['text']}" for row in rows if row.get("text"))
