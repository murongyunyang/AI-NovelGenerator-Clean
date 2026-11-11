"""Anthropic Claude 客户端实现，基于 anthropic 官方 SDK。"""

from __future__ import annotations

import json
import time
import re
from typing import Any, AsyncGenerator

import anthropic
from anthropic import AsyncAnthropic, transform_schema
from pydantic import BaseModel

from backend.llm.base_client import BaseLLMClient, _BeforeSendError, _ThinkStreamFilter
from backend.llm.config import LLMProviderConfig
from backend.llm.exceptions import LLMConnectionError
from backend.llm.exceptions import (
    LLMAuthError,
    LLMError,
    LLMRateLimitError,
    LLMResponseError,
    LLMSchemaError,
    LLMTimeoutError,
)
from backend.llm.provider_probe import observe_provider_response
from backend.llm.logger import LLMCall, log_http_request, log_http_response, log_parse_error
from backend.llm.json_guard import reject_duplicate_json_keys
from backend.llm.live import ClaudeStreamLive
from backend.llm.models import LLMFunctionCallProbe, LLMRequest, LLMResponse, TokenUsage, LLMToolCall, LLMToolDefinition, LLMToolResult, LLMToolTurn, LLMWebSearchResult, collect_web_sources
from backend.llm.prompt_cache import (cache_usage, token_count, cache_parameter_rejected, without_cache_directives,
                                     cache_rejected, remember_cache_rejection)


def _json_member_slices(raw: str) -> dict[str, str]:
    """提取对象中各字段的原文，避免工具参数在检查前丢掉重复字段。

    Args:
        raw: 服务商响应中的一个 JSON 对象。
    Returns:
        字段名及其值的原始 JSON 文本。
    """
    decoder = json.JSONDecoder()
    members = {}
    position = 1
    while True:
        position += len(raw[position:]) - len(raw[position:].lstrip())
        if raw[position] == "}":
            return members
        key, position = decoder.raw_decode(raw, position)
        position += len(raw[position:]) - len(raw[position:].lstrip()) + 1
        position += len(raw[position:]) - len(raw[position:].lstrip())
        start = position
        _, position = decoder.raw_decode(raw, position)
        members[key] = raw[start:position]
        position += len(raw[position:]) - len(raw[position:].lstrip())
        if raw[position] == ",":
            position += 1


def default_max_tokens(model: str) -> int:
    """作者没设输出上限时按模型取默认值。

    以前一律 4096，一次只能写四五千汉字，长章写到一半就被截断。按回复实际用量计费，上限放宽不会多花钱；
    中转服务的真实上限更小时，客户端会从报错里学到上限并重试（见 ClaudeClient._learn_max_tokens）。
    """
    name = model.lower()
    if re.search(r"claude-3-(?:haiku|opus|sonnet)|claude-3-5", name):
        return 8192
    if re.search(r"claude-(?:3-7|sonnet-4(?![-.]?[5-9])|opus-4(?:[-.][01])?(?:-\d{8})?(?![-.]?\d))", name):
        return 32000
    return 64000


# 各模型从服务端报错学到的输出上限（进程内共享；不同中转同名模型取最小值也安全）。
_LEARNED_MAX_TOKENS: dict[str, int] = {}
_MAX_TOKENS_LIMIT = re.compile(r"max_tokens[^0-9]{0,40}(\d{3,7})\s*>\s*(\d{3,7})|(?:less than or equal to|at most|maximum(?: allowed)?(?: value)?(?: is| of)?)\D{0,12}(\d{3,7})", re.I)


def build_claude_parameters(request: LLMRequest, config: LLMProviderConfig) -> dict[str, Any]:
    """构建实际调用和任务图预览共用的参数。

    Args:
        request: 已合并默认值的请求。
        config: Provider 配置。
    Returns:
        不含凭据的 Messages 参数。
    """
    # Claude 的 messages 不含 system 角色，system 通过独立参数传入
    messages: list[dict[str, str]] = []
    for msg in request.messages:
        role = msg["role"]
        if role == "system":
            continue  # system 通过 system 参数传入
        # Claude 仅支持 "user" 和 "assistant"
        messages.append({"role": role, "content": msg["content"]})

    model_name = request.model or config.default_model
    params: dict[str, Any] = {
        "model": model_name,
        "messages": messages,
        "max_tokens": request.max_tokens or min(default_max_tokens(model_name), _LEARNED_MAX_TOKENS.get(model_name, 1 << 30)),
    }

    # 合并所有 system 内容
    system_parts: list[str] = []
    if request.system_prompt:
        system_parts.append(request.system_prompt)
    for msg in request.messages:
        if msg["role"] == "system":
            system_parts.append(msg["content"])
    if system_parts:
        params["system"] = "\n".join(system_parts)

    # 当前 SDK 已移除采样参数，避免让用户误以为设置仍生效。
    if request.temperature is not None or request.top_p is not None:
        raise ValueError("Claude 当前接口不再支持 temperature 和 top_p，请关闭这两个采样参数")
    if request.reasoning_mode or request.verbosity:
        raise ValueError("Claude 不支持 OpenAI 的推理模式或输出详细程度参数")
    if request.reasoning_effort not in (None, "low", "medium", "high", "xhigh", "max"):
        raise ValueError("Claude 思考等级支持 low、medium、high、xhigh、max")
    model = params["model"].lower()
    thinking_mode = request.thinking_mode
    if request.thinking_budget is not None:
        if thinking_mode not in (None, "enabled"):
            raise ValueError("手动思考预算不能与自适应或关闭思考同时设置")
        if re.search(r"claude-(?:opus-4-[78]|\w+-5|mythos)", model):
            raise ValueError("当前 Claude 模型使用自适应思考，请取消 token 预算并选择思考等级")
        if not 1024 <= request.thinking_budget < params["max_tokens"]:
            raise ValueError("Claude 思考预算至少为 1024，且必须小于最大输出 token 数")
        params["thinking"] = {"type": "enabled", "budget_tokens": request.thinking_budget}
    elif thinking_mode == "enabled":
        raise ValueError("Claude enabled 模式需要思考预算；新模型请选择 adaptive")
    elif thinking_mode:
        if thinking_mode == "disabled" and re.search(r"opus-5-5|sonnet-5-5|fable|mythos", model):
            raise ValueError("当前 Claude 模型不能关闭思考，请降低思考等级")
        if (thinking_mode == "disabled" and request.reasoning_effort in {"xhigh", "max"}
                and re.search(r"opus-5|haiku-5-5", model)):
            raise ValueError("当前 Claude 模型只在 high 及以下等级允许关闭思考")
        if thinking_mode == "between_tools" and request.reasoning_effort in {"xhigh", "max"}:
            raise ValueError("between_tools 使用 low、medium、high 等级；模型是否支持请查看接口测试结果")
        params["thinking"] = {"type": thinking_mode}
    elif request.reasoning_effort and re.search(r"claude-(?:opus-4-[678]|sonnet-4-6)", model):
        params["thinking"] = {"type": "adaptive"}
    if request.reasoning_effort:
        params["output_config"] = {"effort": request.reasoning_effort}
    if request.json_output_schema is not None and config.supports_json_schema and config.structured_output_mode != "tool_call":
        params.setdefault("output_config", {})["format"] = {"type": "json_schema", "schema": transform_schema(request.json_output_schema)}
    if request.stop is not None:
        params["stop_sequences"] = request.stop

    return params


# 收到这些 stop_reason 才算完整回复；max_tokens 单独处理以保留已生成的正文。
_FINISHED_STOP_REASONS = {"end_turn", "stop_sequence", "tool_use"}


def forced_tool_choice_error(params: dict[str, Any]) -> str | None:
    """检查能否强制调用工具（旧版工具式结构化输出）；不能时返回原因。

    强制 tool_choice 与思考不兼容；Opus 5.5、Sonnet 5.5、Fable 5.1 等新模型直接拒绝强制调用，
    Opus 5 / Sonnet 5 / Fable / Haiku 5.5 不传 thinking 时默认开启思考。

    Args:
        params: 已构建的 Messages 参数。
    Returns:
        不能强制调用时的中文原因，可以时返回 None。
    """
    model = str(params.get("model") or "").lower()
    thinking = (params.get("thinking") or {}).get("type")
    if thinking in {"enabled", "adaptive", "between_tools"}:
        return "工具式结构化输出不能强制调用思考模型，请选择原生 JSON Schema"
    if re.search(r"opus-5-5|sonnet-5-5|fable-5-1|mythos-5-1", model):
        return "当前 Claude 模型不支持强制调用工具，请选择原生 JSON Schema"
    if thinking != "disabled" and re.search(r"claude-(?:(?:opus|sonnet|haiku)-5|fable|mythos)", model):
        return "当前 Claude 模型默认开启思考，不能强制调用工具；请选择原生 JSON Schema，或关闭思考后再用工具输出"
    return None


_CACHE = {"type": "ephemeral"}
# 思考块不能带缓存标记；其余常见块都可以。
_CACHEABLE_BLOCKS = {"text", "image", "document", "tool_use", "tool_result", "search_result"}


def with_prompt_cache(params: dict[str, Any]) -> dict[str, Any]:
    """返回加了提示缓存断点的参数副本，不改动调用方的消息历史。

    工具和 system 各保留一个稳定断点，消息优先保留最初资料与最新用户消息的边界。
    上游的顺序是 tools → system → messages；工具断点并不包含 system。初始资料保留独立断点，
    剩余位置用于近期消息，所有断点合计不超过四个。前缀不足模型最低长度时服务端自动不缓存。

    Args:
        params: 已构建好的 Messages 参数。
    Returns:
        可直接发送的新参数。
    """
    params = dict(params)
    stable_breakpoints = 0
    if params.get("tools"):
        tools = [dict(tool) for tool in params["tools"]]
        for tool in tools:
            tool.pop("cache_control", None)
        tools[-1]["cache_control"] = _CACHE
        params["tools"] = tools
        stable_breakpoints += 1
    system = params.get("system")
    if isinstance(system, str) and system:
        system = [{"type": "text", "text": system}]
    if isinstance(system, list):
        system = [dict(block) for block in system]
        for block in system:
            block.pop("cache_control", None)
        for block in reversed(system):
            if block.get("type") == "text" and block.get("text"):
                block["cache_control"] = _CACHE
                stable_breakpoints += 1
                break
        params["system"] = system

    messages = []
    candidates = []
    remaining = 4 - stable_breakpoints
    # 只给用户消息设历史断点：上一轮响应里的 assistant 块当时尚未进入请求，给它设断点不能复用旧缓存。
    for message in reversed(params.get("messages") or []):
        current = dict(message)
        content = current.get("content")
        if isinstance(content, str):
            blocks = [{"type": "text", "text": content}] if content else []
        elif isinstance(content, list) and all(isinstance(block, dict) for block in content):
            blocks = [dict(block) for block in content]
        else:
            messages.append(current)
            continue
        for block in blocks:
            block.pop("cache_control", None)
        if current.get("role") == "user":
            for block in reversed(blocks):
                if block.get("type") not in _CACHEABLE_BLOCKS:
                    continue
                # 空文本块不能带缓存标记，继续找同一消息里前面的有效块。
                if block.get("type") == "text" and not block.get("text"):
                    continue
                candidates.append(block)
                break
        if blocks or not isinstance(content, str):
            current["content"] = blocks
        messages.append(current)
    params["messages"] = list(reversed(messages))
    # candidates 按由新到旧排列。初始资料不能随对话增长滑出服务端的前缀查找窗口。
    # 最新边界用于扩展缓存，有余量再保留上一轮边界（长工具结果可能超过查找窗口）。
    if candidates:
        order = [len(candidates) - 1, *range(len(candidates))]
        for index in list(dict.fromkeys(order))[:remaining]:
            candidates[index]["cache_control"] = dict(_CACHE)
    return params


class _ClaudeBeforeSendError(_BeforeSendError, anthropic.AnthropicError):
    """让 Claude SDK 直接抛回校验失败，不包装成可重试的连接错误。"""


class ClaudeClient(BaseLLMClient):
    """Anthropic Claude 客户端，通过 anthropic SDK 调用 Messages API。

    结构化输出使用 output_config.format，旧模型可显式选择 tool_use 兼容模式。
    """

    live_stream = True

    def __init__(self, config: LLMProviderConfig, provider_name: str = "claude") -> None:
        super().__init__(config, provider_name)
        self._http_client = anthropic.DefaultAsyncHttpxClient(
            trust_env=config.use_system_proxy,
            timeout=float(config.timeout_seconds),
            event_hooks={"request": [self._before_http_request, log_http_request], "response": [log_http_response]},
        )
        client_kwargs: dict[str, Any] = {
            "api_key": config.api_key,
            "timeout": float(config.timeout_seconds),
            "max_retries": config.max_retries,
            "http_client": self._http_client,
        }
        if config.base_url:
            client_kwargs["base_url"] = config.base_url
        self._client = AsyncAnthropic(**client_kwargs)

    async def _before_http_request(self, request: Any) -> None:
        """沿用实例回调，只让 SDK 识别校验失败不是连接失败。"""
        try:
            await super()._before_http_request(request)
        except _BeforeSendError as exc:
            raise _ClaudeBeforeSendError(exc.original) from None

    def _build_params(self, request: LLMRequest) -> dict[str, Any]:
        return build_claude_parameters(request, self.config)

    def _send_params(self, params: dict[str, Any]) -> dict[str, Any]:
        """发送前统一加缓存断点；只作用于这次请求，历史消息保持原样。"""
        enabled = self.config.prompt_cache and self.config.prompt_cache_mode != "implicit"
        return with_prompt_cache(params) if enabled and not cache_rejected(self, params.get("model")) else params

    def _map_error(self, exc: Exception, model: str = "") -> LLMError:
        """将 Anthropic SDK 异常映射为自定义异常。"""
        if isinstance(exc, _BeforeSendError):
            exc.__cause__ = exc.__context__ = None
            raise exc.original from exc.original.__cause__
        kwargs = {"provider": self.provider_name, "model": model}
        if isinstance(exc, LLMError):
            return exc
        if isinstance(exc, anthropic.AuthenticationError):
            return LLMAuthError(str(exc), **kwargs)
        if isinstance(exc, anthropic.RateLimitError):
            return LLMRateLimitError(str(exc), **kwargs)
        if isinstance(exc, anthropic.APITimeoutError):
            return LLMTimeoutError(str(exc), **kwargs)
        if isinstance(exc, anthropic.APIStatusError) and "upstream response stream was interrupted" in str(exc).lower():
            # 中转服务已经建立流、但上游中途断开：这是可重试的连接问题，不是模型回复内容不合格。
            return LLMConnectionError("模型上游流式连接中断", **kwargs)
        if isinstance(exc, anthropic.APIConnectionError):
            # 超时已在上面单独归类；其余是连不上或连接被断开，可以重试。
            return LLMConnectionError(str(exc), **kwargs)
        if isinstance(exc, anthropic.APIError):
            return LLMResponseError(str(exc), **kwargs)
        return self._transport_error(exc, **kwargs) or LLMError(str(exc), **kwargs)

    @staticmethod
    def _extract_usage(usage: Any) -> TokenUsage:
        """从 Claude 响应中提取 Token 用量。"""
        if usage is None:
            return TokenUsage()
        # Claude 的 input_tokens 只是未命中缓存的部分；合计输入要加上读、写缓存两项。
        read, write = cache_usage(usage)
        input_t = token_count(usage, "input_tokens") + read + write
        output_t = token_count(usage, "output_tokens")
        return TokenUsage(
            input_tokens=input_t,
            output_tokens=output_t,
            total_tokens=input_t + output_t,
            cache_read_tokens=read,
            cache_write_tokens=write,
        )

    def _learn_max_tokens(self, exc: Exception, params: dict[str, Any]) -> bool:
        """服务端说输出上限给大了：记下它允许的上限，返回 True 表示调用方可以用新上限重试一次。

        只在作者没有自己设上限时生效（作者设的值原样发送，报错照常给作者看）。
        """
        if self.config.max_tokens or not isinstance(exc, anthropic.BadRequestError) or "max_tokens" not in str(exc):
            return False
        sent = int(params.get("max_tokens") or 0)
        match = _MAX_TOKENS_LIMIT.search(str(exc))
        limit = int(match.group(2) or match.group(3)) if match else sent // 2
        if not 1024 <= limit < sent:
            return False
        budget = (params.get("thinking") or {}).get("budget_tokens")
        if budget and budget >= limit:
            return False
        _LEARNED_MAX_TOKENS[params["model"]] = min(limit, _LEARNED_MAX_TOKENS.get(params["model"], limit))
        params["max_tokens"] = limit
        return True

    async def _open_message(self, params: dict[str, Any], *, stream: bool = False, raw: bool = False) -> Any:
        for attempt in range(3):
            try:
                endpoint = self._client.messages.with_raw_response if raw else self._client.messages
                return await endpoint.create(**self._send_params(params), **({"stream": True} if stream else {}))
            except Exception as exc:
                if attempt == 2:
                    raise
                if cache_parameter_rejected(exc) and not cache_rejected(self, params.get("model")):
                    remember_cache_rejection(self, params.get("model"))
                    params = without_cache_directives(params)
                elif not self._learn_max_tokens(exc, params):
                    raise

    async def _create_message(self, params: dict[str, Any], *, stream: bool) -> Any:
        for attempt in range(3):
            try:
                return await self._create_message_once(params, stream=stream)
            except Exception as exc:
                if attempt == 2:
                    raise
                if cache_parameter_rejected(exc) and not cache_rejected(self, params.get("model")):
                    remember_cache_rejection(self, params.get("model"))
                    params = without_cache_directives(params)
                elif not self._learn_max_tokens(exc, params):
                    raise

    async def _create_message_once(self, params: dict[str, Any], *, stream: bool) -> Any:
        """按已选方式请求，流式时收齐文本、工具参数和思考签名。

        Args:
            params: 已构建的 Messages 参数。
            stream: 是否使用流式请求。
        Returns:
            SDK 完整消息，供原有解析和两轮上下文复用。
        """
        params = self._send_params(params)
        if not stream:
            return await self._client.messages.create(**params)
        finished = False
        tool_json: dict[int, str] = {}
        live = ClaudeStreamLive()
        async with self._client.messages.stream(**params) as events:
            async for event in events:
                self._touch_stream()
                observe_provider_response(event, self.config.resolved_api_mode)
                live.feed(event)
                if event.type == "content_block_start" and event.content_block.type == "tool_use":
                    tool_json[event.index] = ""
                elif event.type == "content_block_delta" and event.delta.type == "input_json_delta":
                    tool_json[event.index] = tool_json.get(event.index, "") + event.delta.partial_json
                elif event.type == "content_block_stop" and tool_json.get(event.index):
                    # SDK 允许部分 JSON，必须另查原文是否完整且没有重复字段。
                    reject_duplicate_json_keys(tool_json[event.index])
                    json.loads(tool_json[event.index])
                elif event.type == "message_stop":
                    finished = True
            if not finished:
                raise LLMConnectionError("Claude 响应流提前断开，请重试", provider=self.provider_name)
            response = await events.get_final_message()
        # stop_reason 由调用方检查：普通生成遇到 max_tokens 要带回已生成的正文，结构化输出要报结构错误。
        return response

    def _check_stop_reason(self, stop_reason: str | None, model: str, text: str) -> None:
        """普通生成只接受完整结束的回复；达到上限时保留已生成的正文供界面展示。

        Args:
            stop_reason: Claude 返回的结束原因。
            model: 当前模型。
            text: 已生成的可见正文。
        Returns:
            无；未完成时抛出 LLMResponseError。
        """
        if stop_reason == "max_tokens":
            raise LLMResponseError("模型输出达到长度上限，内容未完成", provider=self.provider_name, model=model,
                                   partial_text=text)
        if stop_reason == "refusal":
            raise LLMResponseError("Claude 拒绝了本次请求，请调整输入后重试", provider=self.provider_name, model=model)
        # 部分中转服务的普通请求不填 stop_reason；流式请求已用 message_stop 确认收齐。
        if stop_reason is not None and stop_reason not in _FINISHED_STOP_REASONS:
            raise LLMResponseError(f"Claude 回复未完成：{stop_reason}", provider=self.provider_name, model=model)

    async def text_generate(self, request: LLMRequest) -> LLMResponse:
        """调用 Claude Messages API 进行普通文本生成。"""
        request = self._apply_defaults(request)
        model = self._resolve_model(request)
        with LLMCall(self.provider_name, model, "text", use_system_proxy=self.config.use_system_proxy) as call:
            start = time.perf_counter()

            try:
                # 与其他服务一致：request.stream 时用流式请求收齐整条回复，长回复不会因读取超时整段重发。
                resp = await self._create_message(self._build_params(request), stream=request.stream)
                observe_provider_response(resp, self.config.resolved_api_mode)
            except LLMError:
                raise
            except Exception as exc:
                mapped = self._map_error(exc, model)
                raise mapped from exc

            elapsed_ms = int((time.perf_counter() - start) * 1000)

            # 提取文本内容（Claude 返回 content blocks 列表）
            text_parts: list[str] = []
            for block in resp.content:
                if block.type == "text":
                    text_parts.append(block.text)
            content = "".join(text_parts)

            if resp.stop_reason not in _FINISHED_STOP_REASONS:
                call.finish_reason = resp.stop_reason or ""
                call.usage = self._extract_usage(resp.usage)
                self._check_stop_reason(resp.stop_reason, model, content)
            result = LLMResponse(
                content=content,
                raw_response=resp.model_dump() if hasattr(resp, "model_dump") else None,
                usage=self._extract_usage(resp.usage),
                model=resp.model or model,
                provider=self.provider_name,
                duration_ms=elapsed_ms,
                finish_reason=resp.stop_reason or "",
                success=True,
            )
            if request.json_output_schema is not None:
                reject_duplicate_json_keys(result.content)
            result = self._finalize_response(result, preserve_json_strings=request.json_output_schema is not None)
            call.result = result
            return result

    async def schema_generate(self, request: LLMRequest, schema: type[BaseModel]) -> LLMResponse:
        """使用原生 JSON Schema 输出，或用户明确选择的旧工具输出方式。

        Args:
            request: 消息与生成参数。
            schema: 业务需要的 Pydantic 结构。
        Returns:
            通过本地完整校验的 JSON 响应。
        """
        request = self._apply_defaults(request)
        model = self._resolve_model(request)
        with LLMCall(self.provider_name, model, "schema", schema=schema, use_system_proxy=self.config.use_system_proxy) as call:
            start = time.perf_counter()

            tool_def = {
                "name": "structured_output",
                "description": f"按照 {schema.__name__} 结构输出结果",
                "input_schema": schema.model_json_schema(),
            }

            try:
                params = self._build_params(request)
                if self.config.structured_output_mode == "tool_call":
                    forced_error = forced_tool_choice_error(params)
                    if forced_error:
                        raise ValueError(forced_error)
                    params["tools"] = [tool_def]
                    params["tool_choice"] = {"type": "tool", "name": "structured_output"}
                    if request.stream:
                        resp = await self._create_message(params, stream=True)
                    else:
                        raw_response = await self._open_message(params, raw=True)
                        raw_body = (await raw_response.text()).strip()
                        # SDK 会把 input 转成 dict；仅检查约定工具的参数原文，不检查协议历史。
                        try:
                            content = _json_member_slices(raw_body).get("content", "[]")
                            decoder = json.JSONDecoder()
                            position = 1
                            while position < len(content):
                                position += len(content[position:]) - len(content[position:].lstrip())
                                if content[position] == "]":
                                    break
                                block, end = decoder.raw_decode(content, position)
                                if block.get("type") == "tool_use" and block.get("name") == "structured_output":
                                    fields = _json_member_slices(content[position:end])
                                    if "input" in fields:
                                        reject_duplicate_json_keys(fields["input"])
                                    break
                                position = end
                                position += len(content[position:]) - len(content[position:].lstrip())
                                if content[position] == ",":
                                    position += 1
                        except json.JSONDecodeError:
                            # 非 JSON 响应仍交给 SDK 和原有错误处理。
                            pass
                        resp = await raw_response.parse()
                    observe_provider_response(resp, self.config.resolved_api_mode)
                else:
                    params.setdefault("output_config", {})["format"] = {"type": "json_schema", "schema": transform_schema(schema)}
                    resp = await self._create_message(params, stream=request.stream)
                    observe_provider_response(resp, self.config.resolved_api_mode)
            except LLMError:
                raise
            except Exception as exc:
                mapped = self._map_error(exc, model)
                raise mapped from exc

            elapsed_ms = int((time.perf_counter() - start) * 1000)

            if resp.stop_reason is not None and resp.stop_reason not in _FINISHED_STOP_REASONS:
                raise LLMSchemaError(f"Claude 未完成结构化输出：{resp.stop_reason}", provider=self.provider_name, model=model)
            # 原生输出从文本读取，旧接口只读取约定的工具参数。
            tool_input: dict[str, Any] | str | None = None
            if self.config.structured_output_mode == "tool_call":
                for block in resp.content:
                    if block.type == "tool_use" and block.name == "structured_output":
                        tool_input = block.input
                        break
            else:
                tool_input = "".join(block.text for block in resp.content if block.type == "text")

            if tool_input is None:
                error = LLMSchemaError(
                    "Claude 未返回有效的 tool_use 结构化输出",
                    provider=self.provider_name,
                    model=model,
                )
                raise error

            # 验证返回的数据符合 Schema
            if isinstance(tool_input, str):
                if self.config.structured_output_mode != "tool_call" and re.match(r"^\s*```", tool_input):
                    raise LLMSchemaError(
                        "Claude 把 JSON 放在了 Markdown 代码块中，没有按原生 JSON Schema 要求直接返回 JSON。"
                        "请检查服务商是否支持原生结构化输出；如果工具调用测试通过，可以改选工具输出模式后重新测试。",
                        provider=self.provider_name,
                        model=model,
                    )
                reject_duplicate_json_keys(tool_input)
            try:
                parsed = schema.model_validate_json(tool_input) if isinstance(tool_input, str) else schema.model_validate(tool_input)
            except Exception as parse_exc:
                log_parse_error(parse_exc, content=tool_input, schema=schema, message="Claude 结构化输出校验失败")
                error = LLMSchemaError(
                    f"Claude 返回内容无法解析为目标 Schema: {parse_exc}",
                    provider=self.provider_name,
                    model=model,
                )
                raise error from parse_exc

            result = LLMResponse(
                content=parsed.model_dump_json(),
                raw_response=resp.model_dump() if hasattr(resp, "model_dump") else None,
                usage=self._extract_usage(resp.usage),
                model=resp.model or model,
                provider=self.provider_name,
                duration_ms=elapsed_ms,
                finish_reason=resp.stop_reason or "",
                success=True,
            )
            result = self._finalize_response(result, preserve_json_strings=True)
            call.result = result
            return result

    async def stream_text(self, request: LLMRequest) -> AsyncGenerator[str, None]:
        """流式调用 Claude Messages API，逐块 yield 生成文本。"""
        # 流式入口统一标记请求语义，保证调试日志与实际 SDK 调用保持一致。
        request = self._apply_defaults(request).model_copy(update={"stream": True})
        model = self._resolve_model(request)
        with LLMCall(self.provider_name, model, "stream", use_system_proxy=self.config.use_system_proxy) as call:

            try:
                stream = await self._open_message(self._build_params(request), stream=True)
                stream_filter = _ThinkStreamFilter(preserve_json_strings=request.json_output_schema is not None)
                async with stream:
                    async for event in stream:
                        self._touch_stream()
                        observe_provider_response(event, self.config.resolved_api_mode)
                        call.chunk_count += 1
                        if event.type == "message_start":
                            call.usage = self._extract_usage(event.message.usage)
                        elif event.type == "message_delta":
                            call.finish_reason = event.delta.stop_reason or ""
                            # message_delta 的输入用量可能为空，此时保留 message_start 里的数（含缓存）。
                            final = self._extract_usage(event.usage)
                            if final.input_tokens:
                                call.usage = final
                            else:
                                call.usage = call.usage.model_copy(update={"output_tokens": final.output_tokens, "total_tokens": call.usage.input_tokens + final.output_tokens})
                        if event.type == "content_block_delta" and event.delta.type == "text_delta":
                            text = event.delta.text
                            call.chunks.append(text)
                            clean_text = stream_filter.feed(text)
                            if clean_text:
                                yield clean_text
                if not call.finish_reason:
                    raise LLMConnectionError("Claude 响应流提前断开，请重试", provider=self.provider_name, model=model)
                # 达到上限保留已生成正文；拒答等其他未完成原因同样不能当作成功。
                self._check_stop_reason(call.finish_reason, model, "".join(call.chunks))
                if request.json_output_schema is not None:
                    reject_duplicate_json_keys("".join(call.chunks))
                tail = stream_filter.finish()
                if tail:
                    yield tail
            except LLMError:
                raise
            except Exception as exc:
                mapped = self._map_error(exc, model)
                raise mapped from exc

    async def tool_turn(
        self, request: LLMRequest, tools: list[LLMToolDefinition], *,
        history: list[dict[str, Any]] | None = None,
        results: list[LLMToolResult] | None = None,
    ) -> LLMToolTurn:
        """执行 Claude 工具对话，保留思考块并紧接着回传全部调用结果。

        Args:
            request: 固定的提示和参数。
            tools: 服务端工具白名单。
            history: 本客户端上一轮返回的原生消息。
            results: 上轮全部调用的结果。
        Returns:
            本轮调用、正文、用量及完整原生消息。
        """
        request = self._apply_defaults(request)
        model = self._resolve_model(request)
        params = self._build_params(request)
        if "output_config" in params:
            params["output_config"].pop("format", None)
        messages = list(history) if history is not None else params["messages"]
        if results:
            messages.append({"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": result.id,
                 "content": json.dumps(result.content, ensure_ascii=False), "is_error": result.is_error}
                for result in results
            ]})
        params.update(messages=messages, tool_choice={"type": "auto"}, tools=[
            {"name": tool.name, "description": tool.description, "input_schema": tool.parameters} for tool in tools
        ])
        try:
            response = await self._create_message(params, stream=request.stream)
            observe_provider_response(response, self.config.resolved_api_mode)
            if response.stop_reason not in _FINISHED_STOP_REASONS:
                raise LLMResponseError(f"Claude 工具回复未完成：{response.stop_reason}，请检查输出上限或输入", provider=self.provider_name, model=model,
                                       truncated=response.stop_reason == "max_tokens")
            messages.append({"role": "assistant", "content": [block.model_dump(mode="json", exclude_none=True) for block in response.content]})
            calls = [LLMToolCall(id=block.id, name=block.name, arguments=block.input)
                     for block in response.content if block.type == "tool_use"]
            text = "".join(block.text for block in response.content if block.type == "text")
            return LLMToolTurn(content=self._sanitize_text_content(text), calls=calls, history=messages,
                               usage=self._extract_usage(response.usage), finish_reason=response.stop_reason or "")
        except LLMError:
            raise
        except Exception as exc:
            raise self._map_error(exc, model) from exc

    async def web_search(self, request: LLMRequest) -> LLMWebSearchResult:
        """用 Claude 服务端的 web_search 工具回答一个问题。

        服务端搜索时间较长时会以 pause_turn 暂停，把已有内容原样送回即可继续；最多续 3 次。

        Args:
            request: 搜索问题；不流式。
        Returns:
            回答、搜索结果与引文中的来源和累计用量。
        """
        request = self._apply_defaults(request).model_copy(update={"stream": False})
        model = self._resolve_model(request)
        params = self._build_params(request)
        if "output_config" in params:
            params["output_config"].pop("format", None)
        messages = list(params["messages"])
        params["tools"] = [{"type": "web_search_20250305", "name": "web_search", "max_uses": 5}]
        usage, blocks = TokenUsage(), []
        try:
            for _ in range(4):
                params["messages"] = messages
                response = await self._create_message(params, stream=False)
                observe_provider_response(response, self.config.resolved_api_mode)
                usage = usage.plus(self._extract_usage(response.usage))
                content = [block.model_dump(mode="json", exclude_none=True) for block in response.content]
                blocks += content
                if response.stop_reason != "pause_turn":
                    break
                messages = [*messages, {"role": "assistant", "content": content}]
            else:
                raise LLMResponseError("Claude 联网搜索多次暂停仍未完成，请缩小问题后重试", provider=self.provider_name, model=model)
            text = "".join(block.text for block in response.content if block.type == "text")
            self._check_stop_reason(response.stop_reason, model, text)
            return LLMWebSearchResult(content=self._sanitize_text_content(text), sources=collect_web_sources(blocks), usage=usage)
        except LLMError:
            raise
        except Exception as exc:
            raise self._map_error(exc, model) from exc

    async def function_call_probe(
        self,
        request: LLMRequest,
        probe: LLMFunctionCallProbe,
    ) -> LLMResponse:
        """执行 Claude tool_use Function Calling 两轮探测。

        Args:
            request: 第一轮触发工具调用的 LLM 请求。
            probe: 工具定义、期望参数和二轮校验文本。

        Returns:
            包含第二轮最终回复的 LLM 响应。
        """
        request = self._apply_defaults(request)
        model = self._resolve_model(request)
        with LLMCall(self.provider_name, model, "function_call", use_system_proxy=self.config.use_system_proxy) as call:
            start = time.perf_counter()
            tool_def = {
                "name": probe.tool_name,
                "description": probe.tool_description,
                "input_schema": probe.parameters_schema,
            }

            try:
                params = self._build_params(request)
                params["tools"] = [tool_def]
                params["tool_choice"] = {"type": "auto"}
                first_resp = await self._create_message(params, stream=request.stream)
                observe_provider_response(first_resp, self.config.resolved_api_mode)
                tool_block = next(
                    (
                        block
                        for block in first_resp.content
                        if block.type == "tool_use" and block.name == probe.tool_name
                    ),
                    None,
                )
                if tool_block is None:
                    raise ValueError("模型未返回指定工具调用")

                actual_args = dict(tool_block.input or {})
                self._validate_probe_arguments(actual_args, probe.expected_arguments)

                # Claude 需要带回 assistant 的 tool_use 块与 user 的 tool_result 块完成二轮。
                messages = list(params["messages"])
                messages.append(
                    {
                        # 与正式工具对话一致：去掉 SDK 补的空字段（如 citations: null），只回传服务端给出的内容。
                        "role": "assistant",
                        "content": [block.model_dump(mode="json", exclude_none=True) for block in first_resp.content],
                    }
                )
                messages.append(
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": tool_block.id,
                                "content": json.dumps(probe.tool_result, ensure_ascii=False),
                            },
                            {
                                "type": "text",
                                "text": probe.final_response_prompt,
                            },
                        ],
                    }
                )
                final_params = self._build_params(request)
                final_params["messages"] = messages
                final_params["tools"] = [tool_def]
                final_resp = await self._create_message(final_params, stream=request.stream)
                observe_provider_response(final_resp, self.config.resolved_api_mode)
            except LLMError:
                raise
            except Exception as exc:
                mapped = self._map_error(exc, model)
                raise mapped from exc

            elapsed_ms = int((time.perf_counter() - start) * 1000)
            text_parts: list[str] = []
            for block in final_resp.content:
                if block.type == "text":
                    text_parts.append(block.text)
            content = "".join(text_parts)
            try:
                self._validate_probe_final_text(content, probe.expected_final_text)
            except ValueError as exc:
                mapped = LLMResponseError(str(exc), provider=self.provider_name, model=model)
                raise mapped from exc

            first_usage = self._extract_usage(first_resp.usage)
            final_usage = self._extract_usage(final_resp.usage)
            result = LLMResponse(
                content=content,
                raw_response={
                    "tool_call": first_resp.model_dump() if hasattr(first_resp, "model_dump") else None,
                    "final": final_resp.model_dump() if hasattr(final_resp, "model_dump") else None,
                },
                usage=first_usage.plus(final_usage),
                model=final_resp.model or model,
                provider=self.provider_name,
                duration_ms=elapsed_ms,
                finish_reason=final_resp.stop_reason or "",
                success=True,
            )
            result = self._finalize_response(result)
            call.result = result
            return result
