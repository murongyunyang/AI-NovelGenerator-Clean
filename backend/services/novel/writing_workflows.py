"""模型无关的写作流程；参考公开机制，自行实现，不调用品牌 CLI 或替换供应商。"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextlib import aclosing
from dataclasses import dataclass

from pydantic import BaseModel, Field

from backend.api.error_protocol import DomainApiError
from backend.services.novel import writing_agent as agent
from backend.services.novel import writing_agent_loop as loop
from backend.services.novel.output_filter import clean_prose_output
from backend.services.novel.writing_workflow_contract import WorkflowId
from backend.services.novel.writing_runtime import bounded
from backend.services.novel.writing_tool_adapter import StructuredToolClient

@dataclass(frozen=True)
class Workflow:
    id: str
    name: str
    name_en: str
    description: str
    description_en: str
    native_tools: bool
    source: str


WORKFLOWS = (
    Workflow("auto", "自动（智能体自主决定）", "Automatic (the agent decides)",
             "模型自己判断要不要查资料、列计划、派子智能体并行查证，写完审查，直到任务完成；不支持工具的服务直接写作并审稿。",
             "The agent decides whether to look things up, plan, delegate to sub-agents and review until the task is done; services without tool support write and review directly.", True, ""),
    Workflow("claude", "自主探索 · 参考 Claude Code", "Adaptive · inspired by Claude Code",
             "模型按工具结果自主查阅、写作、验证与返修；支持停止、上下文整理和重复动作检测。", "An adaptive tool loop with verification, cancellation, context checkpoints and repetition detection.", True,
             "https://code.claude.com/docs/en/how-claude-code-works"),
    Workflow("codex", "自主执行 · 参考 Codex", "Autonomous execution · inspired by Codex",
             "持续执行工具并回送结果，按需要读写、局部修改与验证；完整稿和精确补丁均可使用。", "Feeds tool results back until completion; supports full drafts, exact edits and verification.", True,
             "https://github.com/openai/codex/blob/main/codex-rs/core/src/session/turn.rs"),
    Workflow("planner", "规划编辑 · 参考 LangGraph", "Plan and edit · inspired by LangGraph",
             "独立规划请求先安排场景并选择资料，再写作、审稿、返修；多一次规划调用。", "A separate planning request selects context before writing and editorial review.", False,
             "https://docs.langchain.com/oss/python/langgraph/workflows-agents"),
    Workflow("reflexion", "反思迭代 · 参考 Reflexion", "Reflect and revise · inspired by Reflexion",
             "先写再评估；每次返修前归纳失败原因与保留项，带入后续尝试；会增加调用。", "Each failed review adds a reflection request; lessons guide later revisions.", False,
             "https://github.com/noahshinn/reflexion"),
)
BY_ID = {item.id: item for item in WORKFLOWS}


def catalog() -> list[dict]:
    from dataclasses import asdict
    return [asdict(item) for item in WORKFLOWS]


def is_autonomous(workflow: str) -> bool:
    """这些流程在模型支持工具时由智能体自己决定做什么、做几步；规划编辑和反思迭代是分阶段的固定流程。"""
    return workflow in {"auto", "claude", "codex"}


def needs_tool_client(workflow: str, provider: str) -> bool:
    return BY_ID[workflow].native_tools and loop.supports_tools(provider)


class Plan(BaseModel):
    goal: str = Field(max_length=600)
    scenes: list[str] = Field(default_factory=list, max_length=10)
    constraints: list[str] = Field(default_factory=list, max_length=10)
    unknowns: list[str] = Field(default_factory=list, max_length=10)
    memory_ids: list[str] = Field(default_factory=list, max_length=8)
    chapter_numbers: list[int] = Field(default_factory=list, max_length=3)


class Reflection(BaseModel):
    diagnosis: str = Field(max_length=600)
    changes: list[str] = Field(default_factory=list, max_length=8)
    preserve: list[str] = Field(default_factory=list, max_length=8)


class Patch(BaseModel):
    old: str = Field(min_length=1)
    new: str


class Patches(BaseModel):
    patches: list[Patch] = Field(min_length=1, max_length=20)


def apply_patches(draft: str, patches: Patches) -> str:
    """在副本上依次验证；任一不匹配则整轮不交付，不能覆盖成半稿。"""
    result = draft
    for patch in patches.patches:
        if result.count(patch.old) != 1:
            raise ValueError("精确修订未匹配唯一原文，已保留原稿")
        result = result.replace(patch.old, patch.new, 1)
    result = clean_prose_output(result)
    if not result.strip():
        raise ValueError("精确修订不能清空作品")
    return result


def configure(task: loop.Task, service, workflow: str, model: str) -> None:
    """只修改当前请求 Task；不同书或后台并发任务不共享运行状态。"""
    options = task.options or ({"model": model} if model else {})
    if workflow == "claude":
        loop.make_autonomous(task)
        task.system += "\n自主探索流程：收集上下文、行动、验证可交错进行。根据实际工具结果决定下一步，可在写作或审查后继续查证。不要重复没有进展的动作。"
    elif workflow == "codex":
        loop.make_autonomous(task)
        task.patch_only = False
        task.system += "\n自主执行流程：工具结果回送后继续决定下一步，直到任务完成并验证。优先以精确补丁保留无关内容；作者要求整体重写时也允许 write_draft。不得把计划当交付。"

        async def revise(draft: str, context: str, issues: list[dict]) -> AsyncIterator[str]:
            prompt = (f"【精准修订】\n{task.prompt}\n【实际资料】\n{context}\n【当前作品稿】\n{draft}\n"
                      f"【审稿问题】\n{json.dumps(issues, ensure_ascii=False)}\n"
                      "只对有依据的问题做最小必要修改。old 必须逐字出现且只出现一次；保留未涉及的段落。"
                      '只返回 JSON：{"patches":[{"old":"原文","new":"替换文字"}]}。禁止输出整章或过程说明。')
            patches = await agent._generate_json(service, prompt, Patches,
                {**options, "prompt_cache_prefix": f"【精准修订】\n{task.prompt}\n"})
            yield apply_patches(draft, patches)

        task.revise = revise
    elif workflow == "reflexion":
        async def reflect(draft: str, context: str, issues: list[dict]) -> str:
            prompt = (f"【本轮返修反思】\n{task.prompt}\n【实际资料与之前尝试】\n{context}\n【当前作品稿】\n{draft}\n"
                      f"【独立审稿反馈】\n{json.dumps(issues, ensure_ascii=False)}\n"
                      "只归纳有依据的失败原因、这次应如何修复、哪些已经正确的地方要保留。不要编造新事实，不自行扩展改稿范围。"
                      "这是本次任务的临时经验，不是作者长期偏好，不得宣称已保存记忆。"
                      '只返回 JSON：{"diagnosis":"原因","changes":["改法"],"preserve":["保留项"]}。')
            result = await agent._generate_json(service, prompt, Reflection,
                {**options, "prompt_cache_prefix": f"【本轮返修反思】\n{task.prompt}\n"})
            return json.dumps(result.model_dump(), ensure_ascii=False)[:4000]

        task.reflect = reflect


FALLBACK = "_fallback"


async def structured_auto(service, task: loop.Task, novel_id: str, notes: list[dict], provider: str, model: str) -> AsyncIterator[dict]:
    """“自动”流程遇到没开原生工具调用的服务：用结构化动作协议让同一个模型自己决定查资料、送审、审几次。

    模型第一步就没法按协议回复时，产出 {"event": "_fallback"}，调用方改走原来的固定“写作→审查”流程；之后的失败按自主循环的规则处理。
    """
    from backend.llm.exceptions import LLMResponseError
    client = StructuredToolClient(service, task.options or ({"model": model} if model else {}), probe=True)
    yield {"event": "trace", "kind": "tool", "tool": "workflow", "label": "当前服务未启用原生工具调用，用结构化动作协议让模型自己决定每一步；模型和 API 不变。"}
    try:
        async with aclosing(loop.run_agent(client, provider, model, task, novel_id, notes)) as running:
            async for event in running:
                if event["event"] == "done":
                    event["review_log"].update(execution="structured_tools")
                yield event
    except LLMResponseError as exc:
        if not getattr(exc, "protocol_unsupported", False):
            raise
        if task.book_edit:
            raise DomainApiError("AGENT_TOOL_PROTOCOL_REQUIRED", "当前模型未能执行工具协议，尚未保存任何修改。请重试或选择支持工具调用的模型；不能用普通文字回复冒充已修改章节。", status_code=422) from exc
        yield {"event": "trace", "kind": "tool", "tool": "workflow", "label": "模型没能按结构化动作协议回复，改用固定的写作与审查流程", "error": True}
        yield {"event": FALLBACK}


async def run(service, task: loop.Task, workflow: str, novel_id: str, notes: list[dict],
              provider: str, model: str, client=None) -> AsyncIterator[dict]:
    profile = BY_ID[workflow]
    configure(task, service, workflow, model)
    if task.book_edit:
        # 规划/反思仍使用自己的提示和审稿策略，真实读写不能被旧的阶段数截成半项任务。
        loop.make_autonomous(task)
    options = task.options or ({"model": model} if model else {})
    structured = client is None and (workflow in {"claude", "codex"} or task.book_edit)
    if structured:
        client = (StructuredToolClient(service, options), provider, model)
    native = client is not None and (profile.native_tools or task.book_edit)
    execution = "structured_tools" if structured else "tools" if native else "staged"
    if workflow != "auto":
        yield {"event": "trace", "kind": "tool", "tool": "workflow", "label": "写作流程：" + profile.name}
    if structured:
        yield {"event": "trace", "kind": "tool", "tool": "workflow", "label": "当前服务未启用原生工具调用，使用结构化动作协议执行同一工具循环；模型和 API 不变。"}
    if not native:
        task.max_turns = 0
        # 无工具的执行也带入偏好全文，不能只给无法读取的目录。
        task.prepared_context = "【作者偏好（当前要求优先）】\n" + agent.memory_text(notes)
    if workflow == "planner" and task.book_edit:
        task.system += "\n规划编辑流程：先判断本轮意图；明确是写作或多文档修改后，用 plan_writing 整理具体步骤再执行。提问不做创作规划。"
    if workflow == "planner" and not task.book_edit:
        yield {"event": "progress", "message": "规划编辑：正在整理场景与需要核对的资料…"}
        try:
            plan = await bounded(agent._generate_json(service, f"【独立写作规划】\n{task.prompt}\n"
                f"【可读的偏好目录】\n{agent.memory_catalog(notes)}\n"
                "遵守作者原始范围，只规划写法，不虚构剧情事实。修改选段时 scenes 表示修改步骤，不重排情节；"
                "需要的已有章号放 chapter_numbers，相关偏好 id 放 memory_ids；未知信息列入 unknowns，不能当事实使用。"
                '返回 JSON：{"goal":"任务目标","scenes":["场景或改稿步骤"],"constraints":["约束"],'
                '"unknowns":["未知"],"memory_ids":[],"chapter_numbers":[]}。', Plan, options))
            task.prepared_context += "\n【规划（不是已发生事实）】\n" + json.dumps(plan.model_dump(), ensure_ascii=False)[:6000]
            yield {"event": "trace", "kind": "tool", "tool": "plan_writing", "label": "独立规划已完成", "text": json.dumps(plan.model_dump(), ensure_ascii=False)}
            # 给每项实际读取的资料预留空间，避免先读的长章把后续资料静默挤掉。
            material_count = len(set(plan.memory_ids)) + len(set(plan.chapter_numbers))
            material_budget = max(500, (loop.MAX_RESEARCH_CHARS - len(task.prepared_context)) // max(1, material_count))
            def append_material(material):
                text = json.dumps(material, ensure_ascii=False)
                task.prepared_context += "\n" + text[:material_budget]
                if len(text) > material_budget:
                    task.prepared_context += "\n【此项资料仅提供部分内容，不可据此断言未展示部分】"
            for memory_id in dict.fromkeys(plan.memory_ids):
                try:
                    material = await bounded(loop.execute("read_memory", {"memory_id": memory_id}, novel_id, notes), 30)
                    append_material(material)
                    yield {"event": "trace", "kind": "tool", "tool": "read_memory", "label": "规划器读取相关作者偏好"}
                except (DomainApiError, TimeoutError):
                    yield {"event": "trace", "kind": "tool", "tool": "read_memory", "label": "规划中的偏好不可用，已保留未知", "error": True}
            for number in dict.fromkeys(plan.chapter_numbers):
                try:
                    material = await bounded(loop.execute("read_chapter", {"chapter_number": number}, novel_id, notes, task.scope), 30)
                    append_material(material)
                    yield {"event": "trace", "kind": "tool", "tool": "read_chapter", "label": f"规划器核对第 {number} 章"}
                except (DomainApiError, TimeoutError):
                    yield {"event": "trace", "kind": "tool", "tool": "read_chapter", "label": f"第 {number} 章不可用，未编造资料", "error": True}
        except Exception:
            yield {"event": "trace", "kind": "tool", "tool": "plan_writing", "label": "独立规划未完成，按作者原始要求起草并审稿", "error": True}
    async with aclosing(loop.run_agent(client[0] if native else None, client[1] if native else provider,
                                      client[2] if native else model, task, novel_id, notes)) as running:
        async for event in running:
            if event["event"] == "done":
                event["review_log"].update(workflow=workflow, workflow_name=profile.name,
                                             workflow_name_en=profile.name_en, execution=execution)
            yield event
