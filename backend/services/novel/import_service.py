"""把解析好的本机小说一次性写入数据库。

整本书在同一个事务里创建（小说 → 卷 → 篇章 → 场景 → 章节），任何一步失败都会整体回滚，不会留下半本书。
复用现有的卷、篇章、场景、章节服务，所以各级章节数、字数统计和章节历史版本与手工创建完全一致。
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any

from backend.db.repositories.novel_repository import novel_repo
from backend.db.transaction import run_mongo_write_unit
from backend.db.write_contracts import build_idempotency_fingerprint, resolve_idempotent_replay
from backend.services.novel.arc_service import ArcService
from backend.services.novel.chapter_service import ChapterService
from backend.services.novel.import_parser import ParsedNovel, count_words
from backend.services.novel.novel_service import _prepare_novel_fields
from backend.services.novel.scene_service import SceneService
from backend.services.novel.volume_service import VolumeService

logger = logging.getLogger(__name__)

CHAPTER_BATCH = 200
MAX_VOLUME_TARGET_CHAPTERS = 1000   # 卷规划里“目标章节数”的上限

# 卷必须填好规划才能继续创建下级内容。导入的卷没有这些信息，先写明确的占位说明，作者可随时在卷页面修改。
PLACEHOLDER_GOAL = "（导入的正文，尚未整理本卷目标）"
PLACEHOLDER_TEXT = "（导入的正文，尚未整理）"
STRUCTURE_TITLE = "导入的正文"


def _volume_planning(chapter_count: int, word_count: int) -> dict[str, Any]:
    return {
        "premise": PLACEHOLDER_TEXT, "major_conflict": PLACEHOLDER_TEXT,
        "key_turning_points": [PLACEHOLDER_TEXT],
        "start_state": PLACEHOLDER_TEXT, "end_state": PLACEHOLDER_TEXT,
        "target_chapter_count": min(max(chapter_count, 1), MAX_VOLUME_TARGET_CHAPTERS),
        "target_word_count": max(word_count, 1),
    }


async def import_novel(parsed: ParsedNovel, *, genre: str, idempotency_key: str, source_fingerprint: dict[str, Any]) -> dict[str, Any]:
    """创建一本导入的小说。

    Args:
        parsed: 已解析的卷和章。
        genre: 小说类型。
        idempotency_key: 幂等键；同一份文件、同样的选项重复提交会返回第一次的结果，不会重复创建。
        source_fingerprint: 参与幂等判断的来源信息（文件摘要、切分选项等）。

    Returns:
        含 novel（数据库文档）、volumes、chapters、words、replayed 的字典。
    """
    fields = _prepare_novel_fields({"title": parsed.title, "genre": genre or "unclassified",
                                    **({"introduction": parsed.introduction} if parsed.introduction else {})})
    fingerprint = build_idempotency_fingerprint(idempotency_key, {"operation": "import", **source_fingerprint, **fields})
    # 各级子键由用户键的摘要派生：用户键可长达 128 位，直接拼后缀会超过幂等键的长度上限
    base = hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest()[:40]

    async def create(session: Any) -> dict[str, Any]:
        existing = await novel_repo.find_by_creation_idempotency(fingerprint.key_hash, session=session)
        replay = resolve_idempotent_replay(existing, fingerprint.request_hash, label="小说导入")
        if replay is not None:
            return {"novel": replay, "replayed": True}

        novel_id = await novel_repo.create_novel({
            **fields, **fingerprint.as_creation_fields(), "version": 1, "status": "draft",
            "current_volume_count": 0, "current_chapter_count": 0, "current_word_count": 0,
        }, session=session)

        for volume_index, volume in enumerate(parsed.volumes, 1):
            words = sum(count_words(chapter.content) for chapter in volume.chapters)
            created_volume = await VolumeService.create_volume({
                "novel_id": novel_id, "title": volume.title, "goal": PLACEHOLDER_GOAL,
                "summary": f"从文件导入，共 {len(volume.chapters)} 章。",
                "planning": _volume_planning(len(volume.chapters), words),
            }, idempotency_key=f"{base}:v{volume_index}", session=session)
            volume_id = str(created_volume["_id"])
            arc = await ArcService.create_arc_in_session(
                volume_id, {"title": STRUCTURE_TITLE}, idempotency_key=f"{base}:v{volume_index}:arc", session=session)
            scene = await SceneService.create_scene_in_session(
                str(arc["_id"]), {"title": STRUCTURE_TITLE}, idempotency_key=f"{base}:v{volume_index}:scene", session=session)
            scene_id = str(scene["_id"])
            for start in range(0, len(volume.chapters), CHAPTER_BATCH):
                batch = volume.chapters[start:start + CHAPTER_BATCH]
                await ChapterService.create_chapters_in_session(scene_id, [
                    ({"title": chapter.title, "content": chapter.content}, f"{base}:v{volume_index}:c{start + offset}")
                    for offset, chapter in enumerate(batch)
                ], session=session)
        return {"novel": await novel_repo.get_novel_by_id(novel_id, session=session), "replayed": False}

    result = await run_mongo_write_unit(create, "import_novel", require_transaction=True)
    novel = result["novel"]
    return {"novel": novel, "replayed": result["replayed"], "volumes": int(novel.get("current_volume_count", 0)),
            "chapters": int(novel.get("current_chapter_count", 0)), "words": int(novel.get("current_word_count", 0))}
