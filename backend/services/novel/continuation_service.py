"""从作者选择的前文和后续大纲直接续写，不要求先建立设定卡或规划。"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import Field, model_validator

from backend.api.contracts import ObjectIdString, StrictRequestModel
from backend.api.error_protocol import DomainApiError
from backend.db.base import BaseRepository
from backend.db.repositories.chapter_repository import chapter_repo
from backend.db.repositories.novel_repository import novel_repo
from backend.db.transaction import run_mongo_write_unit
from backend.db.utils import to_object_id
from backend.db.write_contracts import build_idempotency_fingerprint, resolve_idempotent_replay
from backend.llm.generation_options import ReasoningEffort
from backend.services.novel.arc_service import ArcService
from backend.services.novel.chapter_contract import ChapterCreateV2
from backend.services.novel.chapter_service import ChapterService
from backend.services.novel.scene_service import SceneService
from backend.services.novel.volume_service import VolumeService
from backend.services.novel.author_style import AUTHOR_STYLE, OUTLINE_STYLE
from backend.services.novel.writing_workflow_contract import WorkflowId

from backend.services.novel.book_references import BookReference, reference_text

class ChapterContext(StrictRequestModel):
    chapter_id: ObjectIdString
    mode: Literal["original", "summary"] = "original"


class ContinuationInput(StrictRequestModel):
    workflow: WorkflowId = "auto"
    book_edit: bool = False
    instruction: str = ""
    source_id: str = Field(default="", max_length=64)
    reference_books: list[BookReference] = Field(default_factory=list, max_length=50)
    action: Literal["write", "summarize", "materials", "outline"] = "write"
    provider: str = Field(default="", max_length=100)
    model: str = Field(default="", max_length=300)
    chapter_contexts: list[ChapterContext] | None = Field(default=None, max_length=5000)
    chapter_ids: list[ObjectIdString] = Field(default_factory=list, max_length=100)
    context_mode: Literal["original", "summary"] = "original"
    summary_text: str = Field(default="")
    outline: str = Field(default="")
    outline_chapter_ids: list[ObjectIdString] | None = None
    # 续写大纲时，参考章纲中太长的可改用该章已保存的大纲概要；未列出的按原文发送。
    outline_summary_ids: list[ObjectIdString] = Field(default_factory=list)
    # 世界观只在续写大纲时发送；正文写作不发送。
    use_worldview: bool = True
    # 续写时直接关联“本书大纲”中的章纲作为本章计划，无需复制到大纲输入框。
    plan_outline_ids: list[ObjectIdString] = Field(default_factory=list, max_length=100)
    materials: str = Field(default="")
    title: str = Field(default="")
    target_words: int | None = Field(default=None, gt=0)
    review_rounds: int = Field(default=0, ge=0, le=5)
    review_requirements: str = Field(default="")
    use_memory: bool = True
    reasoning_effort: ReasoningEffort | None = None
    review_until_pass: bool = False
    # 上下文预算（字数），写手的对话历史超过它就整理；0 用默认值。
    context_budget: int = Field(default=0, ge=0, le=2000000)
    # Claude Code 去AI味：正文写完、审完后按 story-deslop 方法再改一轮（deslop.py）。
    deslop: bool = False

    @model_validator(mode="after")
    def validate_inputs(self):
        if self.outline_chapter_ids is not None and len(self.outline_chapter_ids) != len(set(self.outline_chapter_ids)):
            raise ValueError("参考大纲章节不能重复")
        if self.outline_summary_ids and not set(self.outline_summary_ids) <= set(self.outline_chapter_ids or []):
            raise ValueError("改用概要的大纲章节必须是已勾选的参考章节")
        if len(self.plan_outline_ids) != len(set(self.plan_outline_ids)):
            raise ValueError("关联大纲章节不能重复")
        if len(self.chapter_ids) != len(set(self.chapter_ids)):
            raise ValueError("关联章节不能重复")
        if self.chapter_contexts is not None:
            ids = [item.chapter_id for item in self.chapter_contexts]
            if len(ids) != len(set(ids)) or self.chapter_ids:
                raise ValueError("每章只能选择正文或概要之一，不能重复提交关联章节")
        if self.action == "write" and not self.outline.strip() and not self.plan_outline_ids:
            raise ValueError("请关联本书大纲章节或填写后续剧情大纲")
        return self


class SourceVersion(StrictRequestModel):
    chapter_id: ObjectIdString
    version: int = Field(ge=1)


class ContinuationSave(ChapterCreateV2):
    # 必须明确确认当前书尾；首次写作时传 null。
    expected_tail_id: ObjectIdString | None
    expected_tail_version: int | None = Field(ge=1)
    sources: list[SourceVersion] = Field(default_factory=list, max_length=100)
    expected_novel_version: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def validate_tail(self):
        if (self.expected_tail_id is None) != (self.expected_tail_version is None):
            raise ValueError("书尾章节和版本必须同时提供")
        if not self.content.strip():
            raise ValueError("正文不能为空")
        return self


def tail_basis(rows: list[dict]) -> dict:
    return {"expected_tail_id": str(rows[-1]["_id"]) if rows else None,
            "expected_tail_version": rows[-1]["version"] if rows else None}


async def _author_plan(novel: dict, req: ContinuationInput) -> str:
    """本章要写的大纲：作者关联的章纲加上输入框里的补充大纲。"""
    from backend.services.novel.book_outline_service import saved_outline_text
    plan = await saved_outline_text(novel, req.plan_outline_ids) if req.action in {"write", "materials"} and req.plan_outline_ids else ""
    return "\n\n".join(part for part in (
        f"【本章要写的大纲（作者关联的章纲）】\n{plan}" if plan else "",
        f"【作者{'补充的' if plan else ''}后续剧情大纲】\n{req.outline}" if req.outline.strip() or not plan else "",
    ) if part)


async def continuation_plan(novel_id: str, req: ContinuationInput) -> str:
    """单独取出本章大纲，供“是否写到大纲结束点”的检查使用。"""
    if req.action != "write":
        return ""
    # 没有关联章纲时大纲只在输入框里，不必再读一次本书。
    novel = await novel_repo.get_novel_by_id(novel_id) if req.plan_outline_ids else {}
    return await _author_plan(novel, req)


async def prepare_continuation(novel_id: str, req: ContinuationInput) -> tuple[str, dict]:
    """校验小说范围并按阅读顺序组装完整上下文，不截断创作文本。"""
    novel = await novel_repo.get_novel_by_id(novel_id)
    rows = await ChapterService.list_chapters(novel_id)
    modes = {str(to_object_id(item.chapter_id)): item.mode for item in req.chapter_contexts or []}
    selected = set(modes) if req.chapter_contexts is not None else {str(to_object_id(value)) for value in req.chapter_ids}
    chapters = [row for row in rows if str(row["_id"]) in selected]
    if len(chapters) != len(selected):
        raise DomainApiError("CONTINUATION_SOURCE_MISSING", "关联章节已变更、已回收或不属于本书，请刷新后重新选择", status_code=409)
    pieces, sources = [], []
    for row in chapters:
        sources.append({"chapter_id": str(row["_id"]), "version": row["version"]})
        mode = modes[str(row["_id"])] if req.chapter_contexts is not None else req.context_mode
        if req.chapter_contexts is None and mode == "summary" and req.summary_text.strip():
            continue
        if mode == "summary":
            text = row.get("summary", "").strip()
            if not text:
                raise DomainApiError("CONTINUATION_SUMMARY_MISSING", f"第{row['chapter_number']}章尚无概要，请先打开该章概要编辑窗口生成并保存", details={"chapter_id": str(row["_id"])})
        else:
            chapter = await ChapterService.get_chapter(str(row["_id"]), novel_id=novel_id)
            if chapter["version"] != row["version"]:
                raise DomainApiError("CONTINUATION_SOURCE_CHANGED", "前文正在修改，请刷新后重试", status_code=409)
            text = chapter["content"]
        pieces.append(f"第{row['chapter_number']}章 · {row['title']}（{'概要' if mode == 'summary' else '正文'}）\n{text}")
    if req.chapter_contexts is None and req.context_mode == "summary" and req.summary_text.strip():
        pieces = [req.summary_text]
    context = "\n\n".join(pieces)
    if req.action == "summarize" and not context.strip():
        raise DomainApiError("CONTINUATION_CONTEXT_EMPTY", "请先选择需要整理的前文章节")
    if req.action == "materials" and not (context.strip() or req.outline.strip() or req.plan_outline_ids):
        raise DomainApiError("CONTINUATION_CONTEXT_EMPTY", "请先选择前文或填写剧情大纲")
    label = "逐章关联前文（每章仅使用所选的正文或概要）" if req.chapter_contexts is not None else ("前文原文" if req.context_mode == "original" else "前文概要")
    base = f"书名：{novel['title']}\n\n【{label}】\n{context or '暂无前文，从本章开始。'}"
    if req.action != "summarize":
        # 小说页保存的文风与视角必须进入写作上下文，不能只传书名导致每章重置文风。
        # 世界观只用于续写大纲，写正文时由大纲交代需要的设定，不再整段发送。
        fields = {"genre": "题材", "writing_style": "文风", "narrative_pov": "叙事视角",
                  "era_background": "时代背景", "tone": "基调", "target_audience": "目标读者"}
        design = "\n".join(f"{label}：{novel[key]}" for key, label in fields.items() if novel.get(key))
        if design:
            base += f"\n\n【本书设定与写法（设计参考，不能据此推断已发生事件）】\n{design}"
        worldview = (novel.get("worldview") or "").strip()
        if req.action == "outline" and req.use_worldview and worldview:
            base += f"\n\n【本书世界观（规划大纲时遵守，不能据此推断已发生事件）】\n{worldview}"
    if req.action in {"write", "outline", "materials"}:
        external = await reference_text(novel_id, req.reference_books)
        if external:
            base += "\n\n" + external
    from backend.services.novel.book_outline_service import saved_outline_text
    if req.action != "summarize":
        # 只读取明确关联的章纲；省略或空列表都不代表全书。
        if req.outline_chapter_ids:
            saved_outline = await saved_outline_text(novel, req.outline_chapter_ids, exclude=req.plan_outline_ids,
                                                     summary_ids=req.outline_summary_ids if req.action == "outline" else None)
            if saved_outline:
                base += f"\n\n【本书已保存的大纲（仅供参考，不要提前写出其中后续章节的剧情）】\n{saved_outline}"
    author_plan = await _author_plan(novel, req)
    if req.action == "summarize":
        prompt = (f"{base}\n\n请只整理以上前文的剧情概要：按照本章实际发生的剧情顺序，用连贯、自然的中文叙述压缩讲述这一章的故事，"
                  "保留主要人物的行动、冲突、转折、重要对话信息和章末处境，让读者读完能接上后文。"
                  "不要写成大纲、条目、表格或‘起因／经过／结果’的分项分析，不评价写作，不规划后续，不虚构未发生的剧情。"
                  "篇幅由本章剧情复杂程度决定，不设固定字数。只输出剧情概要，不输出思考、推理、分析过程或英文工作笔记。")
    elif req.action == "outline":
        prompt = (f"{base}\n\n【作者现有大纲与后续要求】\n{req.outline}\n\n"
                  "请依据已有大纲、已发生的前文事实和作者要求，规划后续剧情大纲。保留既有设定、因果与未解决伏笔，"
                  "明确后续章节的目标、事件推进、转折和阶段结局；不把计划当作已经发生的事实，不生成正文。"
                  "每章以单独一行‘第X章 标题’开头，下一行写这一章的详细大纲，以便按章独立保存。"
                  "只输出可以编辑的后续大纲，不输出思考、分析过程或英文工作笔记。\n\n"
                  f"【作者的大纲写法（必须遵守；作者明确的偏好与本次要求优先）】\n{OUTLINE_STYLE}")
    elif req.action == "materials":
        prompt = (f"{base}\n\n{author_plan}\n\n"
                  "请为续写整理简洁的人物设定卡及必要的背景备忘。每人列出姓名、动机、关系和已知状态；"
                  "区分前文事实、作者计划和待确认信息，不补造既有人物经历。只输出可编辑的设定文字，不输出思考过程。")
    else:
        prompt = (f"{base}\n\n【可选设定备忘】\n{req.materials or '无，依据前文即可。'}\n\n"
                  f"{author_plan}\n\n【本章标题】\n{req.title or '未指定'}\n\n"
                  "请严格依据作者的大纲续写接下来一章。" + (f"作者期望篇幅约 {req.target_words} 字，这是写作目标而非截断上限。" if req.target_words else "篇幅按剧情需要自然展开，不设固定字数。") + "保持前文的人物、时间线、叙事视角和文风一致。"
                  "从前文结束处自然接续，不复述前文，不擅自跳过大纲中的事件，也不要提前写完后续整本故事。"
                  "只输出本章正文，不输出标题、提纲、解释、写作建议、思考推理过程或英文工作笔记。\n\n"
                  "【写作方法】\n每个场景围绕人物当下要做的事推进：目标、阻力、行动与结果相接，转折有前因。"
                  "关键情节写成场景，描写密度由作者文风决定，不机械添加动作、神态或感官细节。"
                  "人物的想法直接写出来：传音、系统提示、重大决定处写他当下怎么想；主角刚得到金手指或新技能时，写他在脑子里把各种用法模拟一遍。"
                  "大纲提到前文发生过的事，先对照前文，对不上就不写那段往事。"
                  "对白接住上一句，符合人物关系和各自目的；避免所有人同一种口吻。"
                  "按大纲分配篇幅，关键冲突充分展开，过渡简洁；章末停在大纲写到的地方，不为留悬念自加剧情，也不写空泛升华。"
                  "大纲很长时不要为了一次写完而压缩、跳写或用概述带过后面的事件：照常按场景写，写到单次输出的上限停下即可，系统会从断点接着让你写，直到大纲的结束点。"
                  "作者明确的文风偏好优先于这些通用建议。\n\n" + AUTHOR_STYLE)
    current = await novel_repo.get_novel_by_id(novel_id)
    if current["version"] != novel["version"]:
        raise DomainApiError("CONTINUATION_SOURCE_CHANGED", "小说资料正在修改，请刷新后重试", status_code=409)
    return prompt, {**tail_basis(rows), "sources": sources, "expected_novel_version": novel["version"]}


async def _new_writing_scene(novel_id: str, key: str, session: Any) -> str:
    """自动建立普通章节父链，作者无需填写分卷、篇章和场景规划。"""
    volume = await VolumeService.create_volume({
        "novel_id": novel_id, "title": "正文续写", "goal": "按照作者提供的后续剧情大纲续写",
        "planning": {"premise": "承接前文", "major_conflict": "依据作者大纲",
                     "key_turning_points": ["依据每章大纲推进"], "start_state": "前文当前状态",
                     "end_state": "依据作者大纲", "target_chapter_count": 100, "target_word_count": 300000},
    }, idempotency_key=f"{key}:volume", session=session)
    arc = await ArcService.create_arc_in_session(str(volume["_id"]), {"title": "正文续写"}, idempotency_key=f"{key}:arc", session=session)
    scene = await SceneService.create_scene_in_session(str(arc["_id"]), {"title": "正文续写"}, idempotency_key=f"{key}:scene", session=session)
    return str(scene["_id"])


async def save_continuation(novel_id: str, req: ContinuationSave, key: str) -> dict:
    """按书尾和前文版本追加新章；重试返回同一章，事务维护历史与各级统计。"""
    import hashlib
    fields = req.model_dump(include={"title", "summary", "planning", "content"})
    key_hash = build_idempotency_fingerprint(key, {}).key_hash

    async def save(session):
        novel = await novel_repo.get_novel_by_id(novel_id, session=session)
        existing = await chapter_repo.collection.find_one({"novel_id": novel["_id"], "creation_idempotency_key_hash": key_hash}, session=session)
        if existing:
            fingerprint = build_idempotency_fingerprint(key, {"scene_id": str(existing["scene_id"]), **fields})
            return resolve_idempotent_replay(existing, fingerprint.request_hash, label="续写保存")
        if req.expected_novel_version is not None and novel["version"] != req.expected_novel_version:
            raise DomainApiError("CONTINUATION_NOVEL_CHANGED", "本书大纲或资料已修改，请保留草稿，核对后重新生成或刷新保存依据", status_code=409)
        rows = await ChapterService.list_chapters(novel_id, session=session)
        if tail_basis(rows) != {"expected_tail_id": req.expected_tail_id, "expected_tail_version": req.expected_tail_version}:
            raise DomainApiError("CONTINUATION_TAIL_CHANGED", "书尾章节已变更。请保留草稿，刷新目录后确认接续位置再保存", status_code=409)
        versions = {str(row["_id"]): row["version"] for row in rows}
        if any(versions.get(source.chapter_id) != source.version for source in req.sources):
            raise DomainApiError("CONTINUATION_SOURCE_CHANGED", "关联前文已修改，请保留草稿并核对前文后再保存", status_code=409)
        # 仅在整本书最后一个活动场景中追加，避免落到后续已规划内容前面。
        parents = []
        for name in ("volumes", "arcs", "scenes"):
            parents.append(await BaseRepository(name).collection.find({"novel_id": novel["_id"], "is_deleted": False}, session=session).to_list(length=None))
        volumes, arcs, scenes = parents
        volumes.sort(key=lambda row: (row["order_index"], str(row["_id"])))
        last_volume = volumes[-1] if volumes else None
        last_arcs = sorted([row for row in arcs if last_volume and row["volume_id"] == last_volume["_id"]], key=lambda row: (row["order_index"], str(row["_id"])))
        last_scenes = sorted([row for row in scenes if last_arcs and row["arc_id"] == last_arcs[-1]["_id"]], key=lambda row: (row["order_index"], str(row["_id"])))
        from backend.services.novel.writing_context import require_volume_ready
        ready = False
        if last_volume:
            try:
                require_volume_ready(last_volume)
                ready = True
            except DomainApiError:
                pass
        scene_id = str(last_scenes[-1]["_id"]) if ready and last_scenes else await _new_writing_scene(novel_id, hashlib.sha256(key.encode()).hexdigest()[:40], session)
        return await ChapterService.create_chapter_in_session(scene_id, fields, idempotency_key=key, session=session)

    return await run_mongo_write_unit(save, "save_continuation", require_transaction=True)
