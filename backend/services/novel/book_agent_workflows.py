"""全书任务策略：共用可撤销工具，规划和反思有独立执行阶段。"""
import json
from typing import Annotated

from pydantic import BaseModel, Field, StringConstraints

from backend.llm.exceptions import LLMError
from backend.services.novel import agent_plan, writing_agent, writing_workflows
from backend.services.novel.writing_runtime import bounded


DESCRIPTIONS = {
    "auto": ("自动选择原生或兼容工具调用，自主读写全书并验证结果。", "Automatically uses native or compatible tool calls to read, write and verify the book."),
    "claude": ("交错查阅、行动与验证；章节写作使用自主探索流程。", "Interleaves research, actions and verification; chapters use adaptive writing."),
    "codex": ("持续执行并核对改动；章节返修优先用精确补丁保留无关段落。", "Executes and verifies changes; chapter revisions prefer exact patches."),
    "planner": ("先独立规划全书任务再执行；每章也先规划、再写作和审稿。会增加规划调用。", "Plans the book task before execution, and plans each chapter before writing and review. Adds planning calls."),
    "reflexion": ("工具失败后先归纳原因再行动；章节返修前反思审稿意见。会增加反思调用。", "Reflects after failed actions and before chapter revisions. Adds reflection calls."),
}
GUIDES = {
    "auto": "",
    "claude": "自主探索模式：按真实资料交错查阅、行动与验证；资料充分时及时执行，不为查阅而重复读书。",
    "codex": "自主执行模式：持续执行直到完成；改旧稿优先用精确局部修改，验证改动并保留无关内容，不把计划当交付。",
    "planner": "规划编辑模式：按已给出的计划执行并通过 update_plan 更新状态；新证据或作者留言改变目标时调整计划，不把计划当成已完成的改动。",
    "reflexion": "反思迭代模式：根据失败反馈修正方法，保留已正确的改动；同一错误不要原样重做。反思不是工具执行结果。",
}


def catalog() -> list[dict]:
    return [{**row, "description": DESCRIPTIONS[row["id"]][0], "description_en": DESCRIPTIONS[row["id"]][1]}
            for row in writing_workflows.catalog()]


class BookPlan(BaseModel):
    steps: list[Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]] = Field(min_length=1, max_length=12)


async def prepare(owner, base: str) -> str:
    mode = owner.settings.workflow
    if owner.depth == 0:
        await owner.rt.trace({"kind": "tool", "tool": "workflow", "label": "全书执行模式：" + writing_workflows.BY_ID[mode].name})
    if mode != "planner":
        return base
    if not owner.plan:
        owner._check_budget()
        await owner.rt.trace({"kind": "tool", "tool": "workflow", "label": "正在独立规划全书任务"})
        try:
            plan = await bounded(writing_agent._generate_json(owner.service,
                base + '\n【全书任务规划】只安排作者要求的步骤，不执行改书、不编造事实。返回 JSON：{"steps":["具体步骤"]}。',
                BookPlan, owner.options))
        except (ValueError, LLMError):
            await owner.rt.trace({"kind": "tool", "tool": "workflow", "label": "独立规划未完成，继续依据原任务自主执行", "error": True})
            return base
        owner.plan = agent_plan.normalize([{"text": step, "status": "pending"} for step in plan.steps], [])
        await owner.rt.save({"plan": owner.plan})
        await owner.rt.trace({"kind": "plan", "items": owner.plan})
    return base + "\n【执行计划（尚未完成，以工具结果为准）】\n" + json.dumps(owner.plan, ensure_ascii=False)


async def reflect(owner, results) -> str:
    failed = [result for result in results if result.is_error]
    if owner.settings.workflow != "reflexion" or not failed or owner.reflections >= 3:
        return ""
    owner.reflections += 1
    owner._check_budget()
    try:
        reflection = await bounded(writing_agent._generate_json(owner.service,
            "【全书动作失败反思】\n原任务：" + owner.job.get("instruction", owner.job.get("prompt", ""))
            + "\n工具反馈：" + json.dumps([item.model_dump() for item in failed], ensure_ascii=False)[:8000]
            + '\n只根据错误归纳原因、下一步改法、应保留的结果，不宣称已执行。返回 JSON：{"diagnosis":"原因","changes":["改法"],"preserve":["保留项"]}。',
            writing_workflows.Reflection, owner.options))
    except (ValueError, LLMError):
        await owner.rt.trace({"kind": "tool", "tool": "workflow", "label": "反思未完成，继续依据原工具反馈处理", "error": True})
        return ""
    text = json.dumps(reflection.model_dump(), ensure_ascii=False)
    await owner.rt.trace({"kind": "tool", "tool": "workflow", "label": "已归纳失败原因与下一步改法", "text": text})
    return text
