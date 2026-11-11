"""“本章正文（多轮自审）”方案：在内置正文流程的生成节点之后加入自审节点。

方案由内置流程派生，原项目更新正文流程后自动跟随；首次启动时安装一次，之后作者可在流程编辑器里自由修改。
"""

from __future__ import annotations

import logging
from copy import deepcopy

from .contracts import Edge, Flow, Node
from .defaults import builtin_flow
from .review_loop import DEFAULT_DIMENSIONS, DEFAULT_PASS_SCORE, DEFAULT_ROUNDS, MAX_ROUNDS

logger = logging.getLogger(__name__)

TASK = "write_chapter_by_ai"
FLOW_ID = "self_review_write_chapter_by_ai"
FLOW_NAME = "本章正文（多轮自审）"

START_FIELDS = {
    "review_rounds": {
        "type": "integer", "minimum": 0, "maximum": MAX_ROUNDS, "default": DEFAULT_ROUNDS,
        "title": "自审轮数（1 轻度 / 2 中度 / 3 及以上深度，0 不审）", "required": False,
    },
    "extra_review_requirements": {
        "type": "string", "maxLength": 2000, "default": "",
        "title": "本次额外审查要求（可选，只对这次生成有效）", "required": False,
    },
}


def build_self_review_flow() -> Flow:
    """在内置正文流程的“生成本章正文”与“审核候选”之间插入自审节点。"""
    flow = builtin_flow(TASK).model_copy(deep=True)
    start = next(node for node in flow.nodes if node.type == "input")
    generate = next(node for node in flow.nodes if node.type == "llm")
    output = next(node for node in flow.nodes if node.type == "output")
    prepared = next(node for node in flow.nodes if node.type == "context" and "prepared_context" in node.inputs)
    content_edge = next(edge for edge in flow.edges if edge.source == generate.id and edge.target == output.id)

    start.outputs.update(deepcopy(START_FIELDS))
    review = Node(
        id="self_review", type="review_loop", label="多轮自审",
        inputs={
            "content": deepcopy(generate.outputs[content_edge.source_port]),
            "writing_context": {"type": "string"},
            **deepcopy(START_FIELDS),
        },
        outputs={
            "content": deepcopy(generate.outputs[content_edge.source_port]),
            "review_log": {"type": "object", "additionalProperties": True},
        },
        config={"provider": "", "model": "", "parameters": {}, "max_rounds": DEFAULT_ROUNDS,
                "pass_score": DEFAULT_PASS_SCORE, "dimensions": deepcopy(DEFAULT_DIMENSIONS)},
    )
    flow.nodes.insert(flow.nodes.index(output), review)
    flow.edges.remove(content_edge)
    flow.edges += [
        Edge(id="generate-content-self_review-content", source=generate.id, source_port=content_edge.source_port,
             target=review.id, target_port="content"),
        Edge(id="prepared-writing_context-self_review-writing_context", source=prepared.id, source_port="writing_context",
             target=review.id, target_port="writing_context"),
        *(Edge(id=f"start-{name}-self_review-{name}", source=start.id, source_port=name, target=review.id, target_port=name)
          for name in START_FIELDS),
        Edge(id="self_review-content-result-content", source=review.id, source_port="content",
             target=output.id, target_port=content_edge.target_port),
    ]
    positions = flow.editor.setdefault("positions", {})
    positions[review.id] = {"x": positions.get(generate.id, {}).get("x", 0) + 360, "y": positions.get(generate.id, {}).get("y", 340)}
    if output.id in positions:
        positions[output.id] = {"x": positions[review.id]["x"] + 360, "y": positions[review.id]["y"]}
    return flow.model_copy(update={"id": FLOW_ID, "name": FLOW_NAME, "revision": 1})


def install_self_review_flow(store) -> bool:
    """首次启动时保存自审方案；默认方案仍是未改动的内置方案时，切换为自审方案。

    已经存在（包括作者改过）的自审方案不会被覆盖，作者改选的默认方案也不会被改回。

    Returns:
        本次是否新安装了方案。
    """
    from .registry import validate_task_definition
    if FLOW_ID in {item["id"] for item in store.list_flows(TASK)["flows"]}:
        return False
    try:
        flow = validate_task_definition(build_self_review_flow())
    except Exception:
        # 原项目的正文流程结构变化时不阻止启动，只是不提供自审方案。
        logger.exception("多轮自审方案与当前正文流程不兼容，已跳过安装")
        return False
    default = store.list_flows(TASK)["defaults"].get(TASK)
    saved = store.save(flow, expected_revision=0)
    if default is None or default["id"] == f"default_{TASK}":
        store.set_default(TASK, saved.id, saved.revision)
    logger.info("已安装多轮自审正文方案 %s", saved.id)
    return True
