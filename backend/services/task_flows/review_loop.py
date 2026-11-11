"""多轮自审节点：审查正文 → 按问题修改 → 再审查，直到合格或达到轮数上限。

每次审查和修改都是一次普通模型调用，复用节点所在流程的 Provider、流式与格式审校设置。
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from contextlib import aclosing
from copy import deepcopy
from pathlib import Path
from typing import Any

from .contracts import FlowValidationError, Node

PROMPT_DIR = Path(__file__).with_name("review_prompts")
MAX_ROUNDS = 10
DEFAULT_ROUNDS = 2
DEFAULT_PASS_SCORE = 8
MAX_DIMENSIONS = 30
MAX_ISSUES = 20

INPUT_PORTS = {"content", "writing_context", "review_rounds", "extra_review_requirements"}
REQUIRED_INPUTS = {"content", "writing_context"}
OUTPUT_PORTS = {"content", "review_log"}

# 节点未配置审查方面时使用；新建自审方案会复制一份到节点配置中，供作者在流程编辑器里修改和增加。
DEFAULT_DIMENSIONS: list[dict[str, Any]] = [
    {"id": "prose", "name": "去 AI 腔与文笔", "enabled": True, "instructions":
        "找出套话空话、排比堆砌、段尾总结升华、滥用比喻和“仿佛”“不禁”“一丝”“宛如”等高频 AI 用语、"
        "重复的句式和用词；成套的神态小动作（喉结动了一下、嘴唇动了动、脸上没什么表情）、“不是……是……”式对比、"
        "单独成段的停顿句（“没人接话。”）、同一个意思换着说法说两遍，以及通篇冷静旁白、没有视角人物口气的段落。"
        "情绪直接说清或让人物开口都可以，不要因为“只给了结论”就要求补动作神态。"},
    {"id": "punctuation", "name": "标点与断句", "enabled": True, "instructions":
        "逗号是否只放在念出来真要换气的地方：短主语和谓语之间、短时间状语后面加了逗号；并列的词该用顿号却用了逗号；"
        "形容词用逗号一个个排开；一句话主语换了好几回、串了四五个逗号还不断句。引用原句并给出改好的写法。"},
    {"id": "inner", "name": "心理活动与爽点", "enabled": True, "instructions":
        "关键时刻有没有写出人物的想法：听到传音、收到系统提示、做重大决定时，只写了点头低头、脚步一顿，读者却无从知道他怎么想的，算问题。"
        "主角刚得到金手指、新技能或新装备时，有没有写他在脑子里模拟各种用法和威力差别；只贴出技能说明就转场，算 high 问题。"
        "同时检查有没有把读者早已看明白的事再解释一遍，以及心理活动写得像旁白分析、长篇自我剖析，而不是人物当下的念头。"},
    {"id": "continuity", "name": "设定与前文一致性", "enabled": True, "instructions":
        "对照本章资料核对：人物是否只使用当时已知的信息，能力、代价、物品归属、已消耗资源是否与设定一致，"
        "时间、地点、人物状态是否与前文衔接，有没有凭空出现的新能力或无铺垫的解法。"
        "大纲里提到的往事（谁做过什么、做过几次、先后顺序）是否和已写的前文对得上，对不上的照写就是问题。"},
    {"id": "plot_pacing", "name": "情节与节奏", "enabled": True, "instructions":
        "是否完成本章计划的目标，有没有提前写掉后续章节的剧情；关键情节是否写成场景，而不是用概述交代过程；"
        "场景推进是否拖沓或跳跃，冲突和转折是否有铺垫；章末是否停在计划写到的地方，没有为留悬念自加剧情或空泛升华。"},
    {"id": "dialogue", "name": "对白与人物声音", "enabled": True, "instructions":
        "不同人物说话是否有区别，是否符合各自的身份、性格和当下情绪；对白是否自然，"
        "有没有用对白生硬地交代设定，有没有人物说出不符合其认知的话。"
        "逐句检查回话有没有黏着上一句：后一句是否复用了对方的字眼、反问或接茬，是否带着情绪（肯定、无语、无奈、生气、怀疑等），"
        "而不只是交换信息。连续的“一问一个短句”（如“设备没问题？”“核对过了。”“抽走多少？”“不多，可一直在抽。”）、"
        "上级的追问没抓住下属上一句的内容、请示的人没说出顾虑，都算 high 问题；引用原句并给出带情绪、接着上一句的改法。"
        "情绪要从说法里带出来（用词、反问、语气词、话说一半），不要靠在台词前后加“无奈地说”“带着怒气”这类说明。"},
]

DEPTHS = {
    1: ("轻度", "只报告必须修改的硬伤：与设定或前文矛盾、违背本章计划、人物使用了不该知道的信息、明显成段的 AI 腔。"
                "细枝末节不报告。"),
    2: ("中度", "报告硬伤，以及明显影响阅读体验的问题：节奏拖沓或跳跃、对白生硬、人物声音雷同、重复用词、套话和读着别扭的断句。"),
    3: ("深度", "逐段精读，报告所有级别的问题，包括措辞、断句与标点、句式变化，以及哪句念出来不像真人会说的话。"
                "不要为了显得丰富而建议增加描写。"),
}

REVIEW_OUTPUTS = {
    "passed": {"type": "boolean"},
    "score": {"type": "integer", "minimum": 1, "maximum": 10},
    "summary": {"type": "string"},
    "issues": {"type": "array", "maxItems": MAX_ISSUES, "items": {
        "type": "object", "additionalProperties": False,
        "required": ["dimension", "severity", "quote", "problem", "suggestion"],
        "properties": {
            "dimension": {"type": "string"},
            "severity": {"type": "string", "enum": ["high", "medium", "low"]},
            "quote": {"type": "string"},
            "problem": {"type": "string"},
            "suggestion": {"type": "string"},
        },
    }},
}


def depth_for(rounds: int) -> tuple[str, str]:
    """轮数决定审查深度：1 轮轻度，2 轮中度，3 轮及以上深度。"""
    return DEPTHS[min(max(rounds, 1), 3)]


def active_dimensions(config: dict[str, Any], extra: str = "") -> list[dict[str, Any]]:
    """节点配置中启用的审查方面，加上本次运行临时填写的额外要求。"""
    dimensions = config.get("dimensions")
    items = deepcopy(DEFAULT_DIMENSIONS if dimensions is None else dimensions)
    items = [item for item in items if item.get("enabled", True)]
    if extra.strip():
        items.append({"id": "extra", "name": "本次额外要求", "instructions": extra.strip()})
    return items


def format_dimensions(dimensions: list[dict[str, Any]]) -> str:
    return "\n".join(f"{index}. {item['name']}：{item['instructions']}" for index, item in enumerate(dimensions, 1))


def format_issues(issues: list[dict[str, Any]]) -> str:
    if not issues:
        return "（无）"
    lines = []
    for index, issue in enumerate(issues, 1):
        quote = f"\n   原句：{issue['quote']}" if issue.get("quote") else ""
        lines.append(f"{index}. [{issue['severity']}][{issue['dimension']}] {issue['problem']}{quote}\n   建议：{issue['suggestion']}")
    return "\n".join(lines)


def validate_review_node(node: Node) -> None:
    """流程保存和运行前检查自审节点的端口与配置。"""
    label = node.label or node.id
    if not REQUIRED_INPUTS <= node.inputs.keys() or node.inputs.keys() - INPUT_PORTS:
        raise FlowValidationError(f"{label} 的输入端口必须包含 content、writing_context，可选 review_rounds、extra_review_requirements")
    if set(node.outputs) != OUTPUT_PORTS:
        raise FlowValidationError(f"{label} 必须且只能输出 content 和 review_log")
    cfg = node.config
    for key, low, high, default in (("max_rounds", 0, MAX_ROUNDS, DEFAULT_ROUNDS), ("pass_score", 1, 10, DEFAULT_PASS_SCORE)):
        value = cfg.get(key, default)
        if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
            raise FlowValidationError(f"{label} 的 {key} 必须是 {low} 到 {high} 的整数")
    dimensions = cfg.get("dimensions")
    if dimensions is not None:
        if not isinstance(dimensions, list) or len(dimensions) > MAX_DIMENSIONS:
            raise FlowValidationError(f"{label} 的审查方面最多 {MAX_DIMENSIONS} 项")
        for item in dimensions:
            if (not isinstance(item, dict) or not str(item.get("name", "")).strip()
                    or not str(item.get("instructions", "")).strip() or not isinstance(item.get("enabled", True), bool)):
                raise FlowValidationError(f"{label} 的每个审查方面都需要名称和检查内容")
        if not any(item.get("enabled", True) for item in dimensions):
            raise FlowValidationError(f"{label} 至少需要启用一个审查方面")


def _step_node(parent: Node, kind: str, default_provider: str = "") -> Node:
    """生成一次审查或修改调用使用的模型节点，继承自审节点的 Provider 与模型参数。"""
    cfg = parent.config
    common = {"provider": cfg.get("provider") or default_provider, "model": cfg.get("model", ""),
              "parameters": deepcopy(cfg.get("parameters", {})), "review_step": True}
    if cfg.get("timeout_seconds"):
        common["timeout_seconds"] = cfg["timeout_seconds"]
    if kind == "review":
        prompt = (PROMPT_DIR / "review.md").read_text(encoding="utf-8")
        names = ("depth", "depth_instructions", "dimensions", "previous_issues", "writing_context", "content")
        return Node(id=f"{parent.id}__review", type="llm", label=f"{parent.label or parent.id}·审查",
                    inputs={name: {"type": "string"} for name in names}, outputs=deepcopy(REVIEW_OUTPUTS),
                    config={**common, "mode": "json", "prompt": prompt, "append_output_schema": True,
                            "text_prompt": "只返回符合下面 JSON Schema 的 JSON 对象，不要输出 Markdown 代码块或解释。"})
    prompt = (PROMPT_DIR / "revise.md").read_text(encoding="utf-8")
    names = ("dimensions", "issues", "writing_context", "content")
    return Node(id=f"{parent.id}__revise", type="llm", label=f"{parent.label or parent.id}·修改",
                inputs={name: {"type": "string"} for name in names},
                outputs={"content": {"type": "string", "minLength": 1}},
                config={**common, "mode": "text", "prompt": prompt, "output_port": "content"})


def review_passed(review: dict[str, Any], pass_score: int) -> bool:
    """合格条件：审查判定通过、分数达标，且没有必须修改的问题。"""
    return (bool(review.get("passed")) and int(review.get("score", 0)) >= pass_score
            and not any(issue.get("severity") == "high" for issue in review.get("issues", [])))


LLMStep = Callable[[Node, dict[str, Any], str], AsyncIterator[dict[str, Any]]]


async def run_review_loop(node: Node, inputs: dict[str, Any], instance_path: str, llm: LLMStep, *,
                          default_provider: str = "") -> AsyncIterator[dict[str, Any]]:
    """执行自审循环。

    Args:
        node: 自审节点。
        inputs: content、writing_context，以及可选的 review_rounds、extra_review_requirements。
        instance_path: 节点实例位置；每次调用使用其下的子路径。
        llm: 与普通模型节点相同的调用回调。
        default_provider: 节点未指定模型服务时使用的流程默认服务。
    Yields:
        进度事件，最后是含 content、review_log 的完成事件，以及累计用量。
    """
    cfg = node.config
    rounds = inputs.get("review_rounds")
    rounds = cfg.get("max_rounds", DEFAULT_ROUNDS) if rounds is None else rounds
    if isinstance(rounds, bool) or not isinstance(rounds, int) or not 0 <= rounds <= MAX_ROUNDS:
        raise FlowValidationError(f"审查轮数必须是 0 到 {MAX_ROUNDS} 的整数")
    pass_score = cfg.get("pass_score", DEFAULT_PASS_SCORE)
    # depth_rounds 让调用方单独指定审查深度（例如“审查到通过为止”要多轮修改，但不需要逐字精读）。
    depth, depth_instructions = depth_for(cfg.get("depth_rounds", rounds))
    dimensions = active_dimensions(cfg, str(inputs.get("extra_review_requirements") or ""))
    dimension_text = format_dimensions(dimensions)
    content = inputs["content"]
    writing_context = inputs["writing_context"]
    log: dict[str, Any] = {"max_rounds": rounds, "depth": depth if rounds else "不审查", "pass_score": pass_score,
                           "dimensions": [item["name"] for item in dimensions], "rounds": [],
                           "passed": None, "final_score": None, "stopped_reason": ""}
    totals = {"usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}, "model_calls": 0, "usage_complete": True}

    if rounds == 0:
        log["stopped_reason"] = "审查轮数为 0，未进行自审"
        yield {"status": "done", "outputs": {"content": content, "review_log": log}, **totals}
        return

    review_node, revise_node = _step_node(node, "review", default_provider), _step_node(node, "revise", default_provider)

    async def call(step: Node, step_inputs: dict[str, Any], path: str, meta: dict[str, Any]):
        """调用一次模型，转发进度；结果放进返回的列表中（异步生成器不能直接返回值）。"""
        holder: list[dict[str, Any]] = []
        async with aclosing(llm(step, step_inputs, path)) as events:
            async for event in events:
                data = event.get("data", event)
                if data.get("status") == "done" or "outputs" in data:
                    holder.append(data["outputs"])
                    usage = data.get("usage") or {}
                    for key in totals["usage"]:
                        totals["usage"][key] += int(usage.get(key, 0))
                    totals["model_calls"] += int(data.get("model_calls", 1))
                    totals["usage_complete"] = totals["usage_complete"] and bool(data.get("usage_complete", False))
                else:
                    yield {"status": "progress", **{k: v for k, v in data.items() if k not in {"status", "outputs"}}, **meta}
        if not holder:
            raise FlowValidationError(f"{step.label} 没有返回结果")
        yield {"_result": holder[0]}

    previous: list[dict[str, Any]] = []
    # 每轮先审查；不合格且还有轮数就修改，修改后的稿子在下一轮（或最后一次确认审查）再审。
    for number in range(1, rounds + 2):
        final_check = number == rounds + 1
        label = "确认审查" if final_check else f"第 {number}/{rounds} 轮审查"
        yield {"status": "progress", "message": f"{label}（{depth}）", "review_round": number, "review_stage": "review"}
        review = None
        async for event in call(review_node, {
            "depth": depth, "depth_instructions": depth_instructions, "dimensions": dimension_text,
            "previous_issues": format_issues(previous), "writing_context": writing_context, "content": content,
        }, f"{instance_path}/review[{number}]", {"review_round": number, "review_stage": "review"}):
            if "_result" in event:
                review = event["_result"]
            else:
                yield event
        issues = list(review.get("issues") or [])
        passed = review_passed(review, pass_score)
        record = {"round": number, "score": review.get("score"), "passed": passed, "summary": review.get("summary", ""),
                  "issues": issues, "revised": False, "final_check": final_check}
        log["rounds"].append(record)
        log["passed"], log["final_score"] = passed, review.get("score")
        if passed:
            log["stopped_reason"] = f"{label}合格（{review.get('score')} 分，合格线 {pass_score} 分）"
            yield {"status": "progress", "message": log["stopped_reason"], "review_round": number, "review_stage": "passed"}
            break
        if final_check:
            log["stopped_reason"] = f"已修改 {rounds} 轮，确认审查仍为 {review.get('score')} 分，未达到合格线 {pass_score} 分，请人工审阅剩余问题"
            yield {"status": "progress", "message": log["stopped_reason"], "review_round": number, "review_stage": "limit"}
            break
        if not issues:
            log["stopped_reason"] = f"{label}未判定合格（{review.get('score')} 分），但没有给出可修改的问题，停止修改"
            yield {"status": "progress", "message": log["stopped_reason"], "review_round": number, "review_stage": "no_issues"}
            break
        scores = [int(item.get("score") or 0) for item in log["rounds"]]
        if len(scores) >= 3 and max(scores[-2:]) <= max(scores[:-2]):
            # 连续两轮修改都没让分数超过之前的最好成绩：再按意见改多半是越改越像为过审而写，剩下的交给作者取舍。
            log["stopped_reason"] = f"连续两轮修改后分数没有提高（{review.get('score')} 分），停止修改，请人工审阅剩余问题"
            yield {"status": "progress", "message": log["stopped_reason"], "review_round": number, "review_stage": "stagnant"}
            break
        yield {"status": "progress", "message": f"{label}：{review.get('score')} 分，发现 {len(issues)} 处问题，正在修改",
               "review_round": number, "review_stage": "revise"}
        revised = None
        async for event in call(revise_node, {
            "dimensions": dimension_text, "issues": format_issues(issues),
            "writing_context": writing_context, "content": content,
        }, f"{instance_path}/revise[{number}]", {"review_round": number, "review_stage": "revise"}):
            if "_result" in event:
                revised = event["_result"]
            else:
                yield event
        content = revised["content"].strip() or content
        record["revised"] = True
        previous = issues

    yield {"status": "done", "outputs": {"content": content, "review_log": log}, **totals}
