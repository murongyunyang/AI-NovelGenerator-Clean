"""从已经生成的正文中自动整理人物、技能、物品与规则，不要求作者另走候选确认流程。"""

from __future__ import annotations

import unicodedata
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, Field

from backend.db.repositories.character_repository import character_repo
from backend.db.repositories.id_sequence_repository import id_sequence_repo
from backend.db.repositories.item_repository import item_repo
from backend.db.utils import get_utc_now
from backend.services.novel.character_name import normalize_character_name
from backend.services.novel.world_rule_service import WorldRuleService
from backend.services.novel.writing_agent import _generate_json

AUTO_KINDS = ("character", "item", "world_rule")


class CharacterChange(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    aliases: list[str] = Field(default_factory=list, max_length=10)
    identity: str = ""
    appearance: str = ""
    personality: str = ""
    abilities: list[str] = Field(default_factory=list, max_length=12)
    evidence: str = ""


class ItemChange(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    item_type: str = "物品"
    description: str = ""
    abilities: list[str] = Field(default_factory=list, max_length=12)
    status: Literal["available", "held", "consumed", "destroyed"] = "available"
    owner_name: str = ""
    evidence: str = ""


class RuleChange(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    category: str = "世界规则"
    statement: str = Field(min_length=1)
    evidence: str = ""


class StoryChanges(BaseModel):
    characters: list[CharacterChange] = Field(default_factory=list, max_length=30)
    items: list[ItemChange] = Field(default_factory=list, max_length=30)
    world_rules: list[RuleChange] = Field(default_factory=list, max_length=20)


def _normalized(value: str) -> str:
    return unicodedata.normalize("NFKC", value).strip().casefold()


def _clean(values: list[str], limit: int = 12) -> list[str]:
    return list(dict.fromkeys(value.strip() for value in values if value.strip()))[:limit]


async def _catalog(novel_id: str) -> dict:
    characters = await character_repo.get_characters_by_novel(novel_id)
    items = await item_repo.list_items(novel_id)
    from backend.db.repositories.world_rule_repository import world_rule_repo
    rules = await world_rule_repo.list_world_rules(novel_id)
    return {"characters": characters, "items": items, "world_rules": rules}


def _catalog_text(catalog: dict) -> str:
    characters = "\n".join(f"- {row['name']}｜技能：{'、'.join(row.get('abilities') or []) or '无'}" for row in catalog["characters"])
    items = "\n".join(f"- {row['name']}｜状态：{row['lifecycle_status']}" for row in catalog["items"])
    rules = "\n".join(f"- {row.get('name') or row['statement'][:40]}｜{row['statement']}" for row in catalog["world_rules"])
    return f"【已有人物】\n{characters or '无'}\n\n【已有物品】\n{items or '无'}\n\n【已有规则】\n{rules or '无'}"


async def extract_and_apply(service, novel_id: str, sources: list[dict], *, kinds= AUTO_KINDS, model: str = "") -> dict:
    """一次模型调用提取全部变化，只写正文明示事实；失败向调用方抛出，正文交付不受影响。"""
    selected = set(kinds)
    text = "\n\n".join(f"【{row.get('title') or '正文'}】\n{row.get('content', '')}" for row in sources if row.get("content", "").strip())
    if not text.strip() or not selected:
        return {"created": 0, "updated": 0, "characters": 0, "items": 0, "world_rules": 0}
    catalog = await _catalog(novel_id)
    prompt = (f"{_catalog_text(catalog)}\n\n{text}\n\n"
              "请只根据上述正文已经明确写出的事实，整理人物、物品和世界规则变化。不要根据常见网文套路补全未知资料。\n"
              "人物：新出现的有名角色，以及既有角色新获得或首次明确展示的技能、能力；技能写进 abilities。未知外貌性格留空。\n"
              "物品：新获得的重要物品，以及被消耗、用掉或毁掉的物品。普通餐具、ambient 背景物和一次性无意义物件不建卡。\n"
              "世界规则：只记反复适用、明确成立的规则，不把一次行动、单次战斗结果或人物目标概括成规则。\n"
              "与已有目录相同的不要重复创建；已有角色的新技能仍要返回以便合并。没有变化就返回空数组。\n"
              "只输出 JSON：{\"characters\":[{\"name\":\"…\",\"aliases\":[],\"identity\":\"…\",\"appearance\":\"\",\"personality\":\"\",\"abilities\":[\"新技能\"],\"evidence\":\"正文依据\"}],"
              "\"items\":[{\"name\":\"…\",\"item_type\":\"…\",\"description\":\"…\",\"abilities\":[],\"status\":\"available|held|consumed|destroyed\",\"owner_name\":\"…\",\"evidence\":\"…\"}],"
              "\"world_rules\":[{\"name\":\"…\",\"category\":\"…\",\"statement\":\"完整规则\",\"evidence\":\"…\"}]}")
    changes = await _generate_json(service, prompt, StoryChanges, {"model": model} if model else {})
    result = {"created": 0, "updated": 0, "characters": 0, "items": 0, "world_rules": 0}
    source_titles = [str(row.get("title") or "正文") for row in sources]
    if "character" in selected:
        counts = await _apply_characters(novel_id, changes.characters, catalog["characters"], source_titles)
        result["characters"] = counts["created"] + counts["updated"]
        result["created"] += counts["created"]
        result["updated"] += counts["updated"]
    if "item" in selected:
        counts = await _apply_items(novel_id, changes.items, catalog["items"], catalog["characters"])
        result["items"] = counts["created"] + counts["updated"]
        result["created"] += counts["created"]
        result["updated"] += counts["updated"]
    if "world_rule" in selected:
        counts = await _apply_rules(novel_id, changes.world_rules, catalog["world_rules"])
        result["world_rules"] = counts["created"]
        result["created"] += counts["created"]
    return result


async def _apply_characters(novel_id: str, changes: list[CharacterChange], existing: list[dict], source_titles: list[str]) -> dict:
    by_name = {row["normalized_name"]: row for row in existing}
    sort_order = max((int(row.get("sort_order") or 0) for row in existing), default=0)
    counts = {"created": 0, "updated": 0}
    for change in changes:
        name, key = normalize_character_name(change.name)
        if not key:
            continue
        current = by_name.get(key)
        abilities = _clean(change.abilities)
        aliases = _clean(change.aliases, 10)
        if current:
            merged_abilities = _clean([*(current.get("abilities") or []), *abilities])
            merged_aliases = _clean([*(current.get("aliases") or []), *aliases], 10)
            extra = dict(current.get("extra") or {})
            history = list(extra.get("auto_history") or [])
            evidence = change.evidence.strip()
            if evidence:
                history.append({"sources": source_titles, "note": evidence[:500]})
                extra["auto_history"] = history[-20:]
            fields = {}
            if merged_abilities != (current.get("abilities") or []):
                fields["abilities"] = merged_abilities
            if merged_aliases != (current.get("aliases") or []):
                fields["aliases"] = merged_aliases
            if extra != (current.get("extra") or {}):
                fields["extra"] = extra
            if fields:
                updated = await character_repo.update_character(novel_id, current["character_id"], fields, expected_version=current["version"])
                if updated:
                    counts["updated"] += 1
                    by_name[key] = updated
            continue
        sort_order += 1
        character_id = (await id_sequence_repo.allocate_many(novel_id, "character", "char", 1))[0]
        now = get_utc_now()
        unknown = "正文未明确"
        document = {
            "novel_id": novel_id, "character_id": character_id, "name": name, "normalized_name": key,
            "aliases": aliases, "role_type": "supporting", "importance_level": "minor", "status": "active",
            "gender": unknown, "age_group": unknown, "race": unknown,
            "identity": change.identity.strip() or "正文新出现角色", "appearance": change.appearance.strip() or unknown,
            "personality": change.personality.strip() or unknown, "core_desire": unknown, "core_fear": unknown,
            "strengths": [], "weaknesses": [], "abilities": abilities,
            "conflict_with_mainline": unknown, "relationship_with_protagonist": unknown,
            "initial_state": unknown, "growth_direction": unknown, "story_function": unknown, "arc_seed": unknown,
            "tags": ["正文自动整理"], "sort_order": sort_order,
            "extra": {"auto_created": True, "auto_sources": source_titles, **({"auto_history": [{"sources": source_titles, "note": change.evidence[:500]}]} if change.evidence.strip() else {})},
            "is_core_character": False, "is_deleted": False, "deleted_at": None,
            "created_at": now, "updated_at": now,
        }
        inserted_id = await character_repo.create_character(document)
        counts["created"] += 1
        by_name[key] = {**document, "_id": inserted_id, "version": 1, "dependency_guard_revision": 0}
    return counts


async def _apply_items(novel_id: str, changes: list[ItemChange], existing: list[dict], characters: list[dict]) -> dict:
    by_name = {row["normalized_name"]: row for row in existing}
    owners = {row["normalized_name"]: row["character_id"] for row in characters}
    order = max((int(row.get("order_index") or 0) for row in existing), default=0)
    counts = {"created": 0, "updated": 0}
    for change in changes:
        name = unicodedata.normalize("NFKC", change.name).strip()
        key = _normalized(name)
        if not key:
            continue
        status = change.status
        owner_id = owners.get(_normalized(change.owner_name)) if status == "held" else None
        if status == "held" and not owner_id:
            status = "available"
        current = by_name.get(key)
        if current:
            if current["lifecycle_status"] == status:
                continue
            # 已消耗或毁坏的记录不因后文识别误差自动复活。
            if current["lifecycle_status"] in {"consumed", "destroyed"}:
                continue
            fields = {"lifecycle_status": status}
            if status in {"consumed", "destroyed"}:
                fields.update(owner_character_id=None, controlling_faction_id=None, current_location_id=None)
            elif owner_id:
                fields["owner_character_id"] = owner_id
            updated = await item_repo.update_from_snapshot(current, fields, increment_version=True, write_time=get_utc_now())
            if updated:
                counts["updated"] += 1
                by_name[key] = updated
            continue
        order += 1
        item_id = (await id_sequence_repo.allocate_many(novel_id, "item", "item", 1))[0]
        document = {
            "novel_id": novel_id, "item_id": item_id, "name": name, "normalized_name": key,
            "aliases": [], "item_type": change.item_type.strip() or "物品", "description": change.description.strip() or change.evidence.strip() or "正文中出现的重要物品",
            "appearance": "", "origin": "", "abilities": _clean(change.abilities), "limitations": [], "costs": [],
            "owner_character_id": owner_id, "controlling_faction_id": None, "current_location_id": None,
            "lifecycle_status": status, "story_function": change.evidence.strip(), "tags": ["正文自动整理"],
            "order_index": order, "item_write_pending_token": None,
        }
        created = await item_repo.create_item(document)
        counts["created"] += 1
        by_name[key] = created
    return counts


async def _apply_rules(novel_id: str, changes: list[RuleChange], existing: list[dict]) -> dict:
    names = {_normalized(row.get("name") or row["statement"][:40]) for row in existing}
    statements = {_normalized(row["statement"]) for row in existing}
    counts = {"created": 0}
    for change in changes:
        name = unicodedata.normalize("NFKC", change.name).strip()
        if _normalized(name) in names or _normalized(change.statement) in statements:
            continue
        await WorldRuleService.create_world_rule(novel_id, {
            "name": name, "category": change.category.strip() or "世界规则", "statement": change.statement.strip(),
            "scope_type": "global", "scope_entity_ids": [], "enforcement": "", "exceptions": [],
            "costs_and_consequences": [], "priority": 0, "status": "active", "tags": ["正文自动整理"],
        }, idempotency_key=f"story-auto:{uuid4().hex}")
        names.add(_normalized(name))
        statements.add(_normalized(change.statement))
        counts["created"] += 1
    return counts


async def list_entries(novel_id: str, kind: str) -> list[dict]:
    """简单设定页的统一只读投影，保留已有卡片，不强迫进入旧规划流程。"""
    if kind == "character":
        rows = await character_repo.get_characters_by_novel(novel_id)
        return [{"id": row["character_id"], "name": row["name"], "aliases": row.get("aliases") or [],
                 "identity": row.get("identity") or "", "appearance": row.get("appearance") or "",
                 "personality": row.get("personality") or "", "abilities": row.get("abilities") or [],
                 "auto": bool((row.get("extra") or {}).get("auto_created")), "sources": (row.get("extra") or {}).get("auto_sources") or []} for row in rows]
    if kind == "item":
        rows = await item_repo.list_items(novel_id)
        return [{"id": row["item_id"], "name": row["name"], "item_type": row["item_type"], "description": row["description"],
                 "abilities": row.get("abilities") or [], "status": row["lifecycle_status"], "auto": "正文自动整理" in (row.get("tags") or [])} for row in rows]
    if kind == "world_rule":
        from backend.db.repositories.world_rule_repository import world_rule_repo
        rows = await world_rule_repo.list_world_rules(novel_id)
        return [{"id": row["rule_id"], "name": row.get("name") or row["statement"][:40], "category": row["category"],
                 "statement": row["statement"], "status": row["status"], "auto": "正文自动整理" in (row.get("tags") or [])} for row in rows]
    raise ValueError("未知设定类型")
