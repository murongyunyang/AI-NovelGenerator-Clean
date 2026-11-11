"""无原生 tool calling 时使用结构化动作协议，仍由模型选择工具并接收执行结果。

提示的顺序按“稳定的在前、变化的在后”排：协议说明、智能体的系统提示和工具表放在系统提示里，每一步都一样，
支持前缀缓存的服务能复用；任务和执行历史放在用户消息里，每一步只在末尾追加。
"""

import json
from types import SimpleNamespace

from pydantic import BaseModel, Field, ConfigDict, ValidationError

from backend.llm.models import LLMToolCall, LLMToolTurn
from backend.api.error_protocol import DomainApiError
from backend.llm.exceptions import LLMError, LLMToolProtocolError
from backend.llm.json_guard import reject_duplicate_json_keys
from backend.services.novel.output_filter import clean_creative_output
from backend.services.novel import writing_agent as agent

PROTOCOL = ("【写作智能体动作协议】\n你是工具调度模型。根据任务、执行历史和工具执行结果决定下一步，"
            "只能请求下面【可用工具】里的工具，参数按工具的 parameters 填写；不得宣称工具已执行，工具的结果会在下一条消息里给你。"
            "可以一次请求几个互不依赖的工具。任务完成时调用 finish（或工具表里对应的交付工具）。\n"
            "每次只返回一个 JSON 对象，不要 Markdown 代码块、不要其他文字：\n"
            "{\"message\": \"一句简短进度说明\", \"calls\": [{\"name\": \"工具名\", \"arguments\": {参数}}]}\n")


class Action(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    arguments: dict = Field(default_factory=dict)


class Decision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message: str = ""
    calls: list[Action] = Field(max_length=8)


def parse_decision(raw: str) -> Decision:
    """接受完整 JSON、代码围栏和常见工具封装；不从截断回复或解释文字中猜测写操作。"""
    text = clean_creative_output(raw).strip()
    if text.startswith("```") and text.endswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    reject_duplicate_json_keys(text)
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError("动作回复必须是一个完整 JSON 对象")
    if "tool_calls" in value and "calls" not in value:
        value = {**value, "calls": value["tool_calls"]}
        value.pop("tool_calls")
    elif "name" in value and "calls" not in value:
        value = {"calls": [value]}
    calls = value.get("calls")
    if isinstance(calls, list):
        normalized = []
        for call in calls:
            if isinstance(call, dict) and call.get("type") == "function" and isinstance(call.get("function"), dict):
                call = call["function"]
            if isinstance(call, dict) and isinstance(call.get("arguments"), str):
                reject_duplicate_json_keys(call["arguments"])
                call = {**call, "arguments": json.loads(call["arguments"])}
            normalized.append(call)
        value = {**value, "calls": normalized}
    return Decision.model_validate(value)


class StructuredToolClient:
    # 每一步都是 service.generate_text 的调用，用量已经在那里统计过，外层不能再估算一次。
    counts_own_usage = True

    def __init__(self, service, options: dict | None = None, *, probe: bool = False):
        self.service = service
        # 本次请求的模型选项（model、reasoning_effort），与原生工具调用的请求保持一致。
        self.options = options or {}
        config = getattr(getattr(service, "_client", None), "config", None)
        self.config = SimpleNamespace(use_system_proxy=getattr(config, "use_system_proxy", False),
                                      supports_streaming=getattr(config, "supports_streaming", True))
        # probe：第一次就没能按协议回复时，标记为“这个模型做不到”，调用方可以直接改走固定流程，不必反复重试。
        self.probe = probe
        self.succeeded = False

    async def tool_turn(self, request, tools, *, history=None, results=None):
        messages = list(history or request.messages)
        if results:
            messages.append({"role": "user", "content": "工具实际执行结果：" + json.dumps(
                [result.model_dump() for result in results], ensure_ascii=False)})
        system = (PROTOCOL + "\n" + (request.system_prompt or "") + "\n\n【可用工具】\n"
                  + json.dumps([tool.model_dump() for tool in tools], ensure_ascii=False))
        names = [tool.name for tool in tools]
        options = {**self.options, **({"model": request.model} if request.model else {})}
        config = getattr(getattr(self.service, "_client", None), "config", None)
        example = '{"message":"简短说明","calls":[{"name":"工具名","arguments":{}}]}'
        # 服务声明支持结构约束时，实际发送约束，不只靠文字要求 JSON。
        if getattr(config, "supports_json_schema", False) or getattr(config, "json_output_enabled", False):
            # 工具含开放字典（脚本 args、自造工具 parameters 等）及可选参数，不能直接
            # 塞进 strict Schema：封闭字典会丢参数，强制 required 会改变省略参数的语义。
            # 约束动作外壳，参数用 JSON 字符串无损传输；解析后仍按原工具定义校验再执行。
            schema = Decision.model_json_schema()
            schema["required"] = ["message", "calls"]
            schema["$defs"]["Action"] = {
                "type": "object", "properties": {"name": {"type": "string", "enum": names},
                 "arguments": {"type": "string", "description": "按可用工具参数表填写的 JSON 对象，序列化为字符串；无参数时填写 {}。"}},
                "required": ["name", "arguments"], "additionalProperties": False}
            options["json_output_schema"] = schema
            example = '{"message":"简短说明","calls":[{"name":"工具名","arguments":"{}"}]}'
            system += ("\n【本次结构化输出格式】上方动作协议的 arguments 改用 JSON 对象序列化后的字符串，"
                       "参数名称和类型仍按可用工具表填写，未使用的可选参数直接省略。示例：" + example)
        decision, problem = None, ""
        for attempt in range(2):
            try:
                raw = await self._generate(system, options, messages, request.stream)
            except Exception as exc:
                if not self.probe or self.succeeded or isinstance(exc, (LLMError, DomainApiError)):
                    raise
                # 试探阶段遇到意料之外的服务错误：同样交给调用方改走固定流程，固定流程会自己报出真正的错误。
                error = LLMToolProtocolError(f"结构化动作协议不可用：{type(exc).__name__}")
                error.protocol_unsupported = True
                raise error from exc
            try:
                decision = parse_decision(raw)
                unknown = [call.name for call in decision.calls if call.name not in names]
                if unknown:
                    raise ValueError(f"没有工具 {'、'.join(unknown)}，可用的有：{'、'.join(names)}")
                break
            except (ValueError, ValidationError, LLMError) as exc:
                # 模型没按协议、而是直接用拒绝标记回复：照常按“非写作任务”拒绝，不当作协议失败。
                agent._check_scope(raw or "")
                decision = None
                problem = str(exc).splitlines()[0][:300] if str(exc) else "没有找到 JSON 对象"
                if not attempt:
                    messages.append({"role": "assistant", "content": raw[:12000]})
                    messages.append({"role": "user", "content": f"上一条回复没有执行任何工具，格式错误：{problem}。"
                                     f"请纠正为 {example}。"
                                     "只返回一个完整 JSON 对象。保持原任务，只修正格式；工具未执行，不要假定已改书。"})
        if decision is None:
            error = LLMToolProtocolError("模型动作格式仍不正确，已停止本步以避免重复消耗。已完成的修改保留；可换支持工具调用的模型后继续。"
                                         f" 格式原因：{problem}")
            if self.probe and not self.succeeded:
                error.protocol_unsupported = True
            raise error
        self.succeeded = True
        messages.append({"role": "assistant", "content": decision.model_dump_json()})
        return LLMToolTurn(content=decision.message, history=messages, finish_reason="tool_calls" if decision.calls else "stop",
                           calls=[LLMToolCall(id=f"action-{len(messages)}-{i}", **a.model_dump()) for i, a in enumerate(decision.calls)])

    async def _generate(self, system: str, options: dict, messages: list[dict], stream: bool) -> str:
        generate_messages = getattr(self.service, "generate_messages", None)
        if callable(generate_messages):
            return await generate_messages(list(messages), system_prompt=system, stream=stream, **options)
        # 保留只实现单轮 generate_text 的外部服务适配。
        prompt = "【任务和执行历史】\n" + json.dumps(messages, ensure_ascii=False)
        return await self.service.generate_text(prompt, system_prompt=system, stream=stream, **options)
