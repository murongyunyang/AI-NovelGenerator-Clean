"""让简洁续写复用高级流程中的审查、修改和最终确认循环。"""

import json
from contextlib import aclosing

from backend.api.error_protocol import DomainApiError
from backend.llm.json_guard import reject_duplicate_json_keys
from backend.services.task_flows.contracts import Node
from backend.services.task_flows.engine import render_template
from backend.services.task_flows.graph import compile_output_model
from backend.services.task_flows.review_loop import DEFAULT_DIMENSIONS, run_review_loop
from backend.services.novel.output_filter import clean_prose_output, PROSE_CONTRACT
from backend.services.novel import style_lint
from backend.services.novel.writing_agent import generation_options

# 不调用工具的固定流程没有分数停滞判断，“审查到通过为止”在这里最多修改这么多轮（与原界面的上限相同），避免无休止地花费调用。
UNTIL_PASS_STAGED_ROUNDS = 5


def review_dimensions(preferences: str) -> list[dict]:
    """作者偏好（含从 Claude Code 导入的规则）作为一个必查方面，排在默认方面之前。"""
    return ([{"id": "author_preferences", "name": "作者写作偏好", "enabled": True,
              "instructions": "只核对适用于本次任务且有明确内容的作者偏好。本次要求、最新作者正文优先于旧记忆；目录标题不是完整规则，不凭标题推断禁忌。违反明确且适用的要求才列为 high：\n" + preferences}] if preferences.strip() else []) + DEFAULT_DIMENSIONS


async def _full_revision(service, rendered: str, options: dict) -> str:
    """整章修订稿。长章一次写不下时（达到单次输出上限），从断点接着写完，不把半章当成修订稿。"""
    from backend.llm.exceptions import LLMResponseError
    from backend.services.novel.output_filter import continuation_prompt, stream_prose
    try:
        return await service.generate_text(rendered, system_prompt=PROSE_CONTRACT, stream=True, **options)
    except LLMResponseError as exc:
        if not getattr(exc, "truncated", False) or not (exc.partial_text or "").strip():
            raise
        written = clean_prose_output(exc.partial_text)
    rest = ""
    async with aclosing(stream_prose(service, continuation_prompt(rendered, written), "", options)) as chunks:
        async for chunk in chunks:
            rest += chunk
    return written + rest


async def review_continuation(service, content, prompt, req, preferences: str = ""):
    rounds = max(req.review_rounds, UNTIL_PASS_STAGED_ROUNDS) if req.review_until_pass else req.review_rounds
    node = Node(id="continuation_review", type="review_loop", label="正文自主审查",
                inputs={}, outputs={}, config={"max_rounds": rounds, "provider": req.provider, "model": req.model, "dimensions": review_dimensions(preferences),
                                                # 审到通过要改很多轮；每轮都逐字精读会越改越像为过审而写，所以按中度审查。
                                                **({"depth_rounds": min(req.review_rounds or 2, 2)} if req.review_until_pass else {})})
    options = generation_options(req)

    async def call(step, inputs, path):
        template = step.config["prompt"]
        rendered = render_template(template, inputs)
        boundary = "## 上一轮指出的问题" if step.id.endswith("__review") else "## 需要修改的问题"
        prefix = render_template(template.split(boundary, 1)[0], inputs) if boundary in template else ""
        call_options = {**options, **({"prompt_cache_prefix": prefix} if prefix else {})}
        if step.id.endswith("__review"):
            schema = compile_output_model(step)
            rendered += "\n\n只输出符合以下结构的 JSON 对象：\n" + json.dumps(schema.model_json_schema(), ensure_ascii=False)
            raw = await service.generate_text(rendered, stream=True, **call_options)
            reject_duplicate_json_keys(raw)
            result = style_lint.merge(schema.model_validate(json.loads(raw)).model_dump(), inputs.get("content", ""))
        else:
            revised = clean_prose_output(await _full_revision(service, rendered, call_options))
            if not revised.strip():
                raise DomainApiError("CONTINUATION_INVALID_REVISION", "修改后的正文为空，已保留上一版正文", status_code=502)
            result = {"content": revised}
            yield {"status": "progress", "replacement": revised}
        yield {"status": "done", "outputs": result}

    async with aclosing(run_review_loop(node, {"content": content, "writing_context": prompt,
                                               "extra_review_requirements": req.review_requirements}, "continuation", call,
                                        default_provider=req.provider)) as events:
        async for event in events:
            yield event
