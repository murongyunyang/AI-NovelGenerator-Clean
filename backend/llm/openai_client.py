"""OpenAI 兼容客户端实现，支持 OpenAI / DeepSeek / OpenRouter 等兼容平台。"""

from __future__ import annotations

import hashlib
import time
import json
import re
from copy import deepcopy
from typing import Any, AsyncGenerator
from urllib.parse import urlsplit, urlunsplit

import openai
from openai import AsyncOpenAI
from openai.lib._pydantic import to_strict_json_schema, _ensure_strict_json_schema
from pydantic import BaseModel, ValidationError

from backend.llm.base_client import BaseLLMClient, _BeforeSendError, _ThinkStreamFilter, build_request_messages
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
from backend.llm.logger import LLMCall, log_http_request, log_http_response
from backend.llm.json_guard import reject_duplicate_json_keys
from backend.llm.live import ChatStreamLive
from backend.llm.models import LLMFunctionCallProbe, LLMRequest, LLMResponse, TokenUsage, LLMToolCall, LLMToolDefinition, LLMToolResult, LLMToolTurn
from backend.llm.prompt_cache import (modern_openai_model, with_openai_breakpoints, with_chat_anthropic_breakpoints,
                                     cache_parameter_rejected, without_cache_directives, cache_usage, token_count,
                                     cache_rejected, remember_cache_rejection)


_API_VERSION_RE = re.compile(r"^v\d+(?:[a-z0-9._-]+)?$", re.IGNORECASE)


def build_openai_parameters(request: LLMRequest, config: LLMProviderConfig,
                            *, schema: type[BaseModel] | None = None,
                            function_calling: bool = False, api_mode: str | None = None) -> dict[str, Any]:
    """把统一参数转换为实际 OpenAI / DeepSeek 接口参数，供调用与模拟共用。

    Args:
        request: 已合并默认值的请求。
        config: Provider 配置。
        schema: 原生结构化输出模型。
        function_calling: 是否进行工具对话。
        api_mode: 客户端已固定的接口；未指定时读取配置。
    Returns:
        不含凭据的 SDK 调用参数。
    """
    mode = api_mode or config.resolved_api_mode
    responses = mode == "responses"
    model = request.model or config.default_model
    model_name = model.rsplit("/", 1)[-1].lower()
    effort = request.reasoning_effort
    if config.is_deepseek:
        if request.thinking_mode not in (None, "enabled", "disabled"):
            raise ValueError("DeepSeek 思考模式只支持 enabled 或 disabled")
        if request.thinking_mode == "disabled":
            if effort not in (None, "none"):
                raise ValueError("关闭思考时不能同时设置思考等级")
            effort = "none"
        elif request.thinking_mode == "enabled" and effort == "none":
            raise ValueError("开启思考时不能选择 none 等级")
        if request.reasoning_mode or request.verbosity:
            raise ValueError("DeepSeek 不支持 Pro 推理或输出详细程度参数")
    elif request.thinking_mode is not None:
        raise ValueError("OpenAI 使用思考等级控制推理，不支持 thinking_mode")
    if request.thinking_budget is not None:
        raise ValueError("此接口使用思考等级，不支持思考 token 预算")
    if model_name.startswith(("gpt-6-astra", "gpt-6.1-sol")) and effort in {"none", "minimal"}:
        raise ValueError("GPT-6 Astra / GPT-6.1 Sol 的最低思考等级为 low")
    if not responses and request.reasoning_mode is not None:
        raise ValueError("Pro 推理模式需要选择 Responses 接口")
    if function_calling and not responses and not config.is_deepseek and (
        model_name.startswith("gpt-6") or re.match(r"^gpt-5\.[4-9](?:-|$)", model_name)
    ) and (effort != "none" or model_name.startswith("gpt-6-astra")):
        raise ValueError("当前模型的推理工具调用需要 Responses 接口，请在 Provider 设置中切换接口模式")

    params: dict[str, Any] = {"model": model}
    json_output = config.resolved_structured_output_mode == "json_object" and (schema is not None or config.json_output_enabled)
    content = build_openai_request_content(request, schema, json_output=json_output)
    params["input" if responses else "messages"] = content["messages"]
    if responses:
        # 本地保留完整历史，OpenAI 续接携带加密思考；DeepSeek 本身不存储会话。
        if not config.is_deepseek:
            params.update(store=False, include=["reasoning.encrypted_content"])
        if json_output and "response_format" in content:
            params["text"] = {"format": {"type": "json_object"}}
        elif schema is not None:
            fmt = content["response_format"]["json_schema"]
            if config.is_deepseek:
                fmt = {"name": schema.__name__, "schema": schema.model_json_schema()}
            params["text"] = {"format": {"type": "json_schema", **fmt}}
        elif request.json_output_schema is not None and config.supports_json_schema and config.uses_native_schema:
            # 流式同样携带结构约束，业务层仍校验完整结果。
            fmt = {"type": "json_schema", "name": "generated_output",
                   "schema": request.json_output_schema if config.is_deepseek else build_openai_schema(request.json_output_schema)}
            if not config.is_deepseek:
                fmt["strict"] = True
            params["text"] = {"format": fmt}
        if request.verbosity:
            params.setdefault("text", {})["verbosity"] = request.verbosity
        if effort is not None:
            params["reasoning"] = {"effort": effort}
        if request.reasoning_mode:
            params.setdefault("reasoning", {})["mode"] = request.reasoning_mode
        if config.is_deepseek and request.thinking_mode == "enabled" and effort is None:
            params["reasoning"] = {"effort": "high"}
    else:
        params.update({key: value for key, value in content.items() if key != "messages"})
        if schema is None and request.json_output_schema is not None and config.supports_json_schema and config.uses_native_schema:
            params["response_format"] = {"type": "json_schema", "json_schema": {
                "name": "generated_output", "strict": True, "schema": build_openai_schema(request.json_output_schema),
            }}
        if effort is not None:
            params["reasoning_effort"] = effort
        if config.is_deepseek and request.thinking_mode:
            params["extra_body"] = {"thinking": {"type": request.thinking_mode}}
        if request.verbosity:
            params["verbosity"] = request.verbosity

    reasoning_model = not config.is_deepseek and bool(re.match(r"^(?:gpt-[56](?:[.-]|$)|o[134](?:-|$))", model_name))
    default_none = bool(re.match(r"^gpt-5\.(?:1|2|4)(?:-|$)", model_name))
    sampling = not reasoning_model or effort == "none" or (effort is None and default_none)
    if config.is_deepseek:
        thinking = effort != "none" and (request.thinking_mode != "disabled")
        if model_name == "deepseek-chat" and effort is None and request.thinking_mode is None:
            thinking = False
        if request.temperature is not None and not thinking:
            params["temperature"] = request.temperature
        if request.top_p is not None and thinking:
            params["top_p"] = request.top_p
    elif sampling:
        for field in ("temperature", "top_p"):
            if getattr(request, field) is not None:
                params[field] = getattr(request, field)
    if request.max_tokens is not None:
        token_key = "max_output_tokens" if responses else "max_completion_tokens" if reasoning_model else "max_tokens"
        params[token_key] = request.max_tokens
    if not responses:
        for field in ("presence_penalty", "frequency_penalty", "stop"):
            if getattr(request, field) is not None and not reasoning_model:
                params[field] = getattr(request, field)
    return params


def build_openai_schema(schema: type[BaseModel] | dict[str, Any]) -> dict[str, Any]:
    """统一普通与流式请求的严格 Schema，保留原结构用于本地校验。

    Args:
        schema: Pydantic 模型或任务节点的 JSON Schema。
    Returns:
        OpenAI 支持的严格结构副本。
    """
    if isinstance(schema, dict):
        api_schema = deepcopy(schema)
        api_schema = _ensure_strict_json_schema(api_schema, path=(), root=api_schema)
    else:
        api_schema = deepcopy(to_strict_json_schema(schema))
    pending = [api_schema]
    while pending:
        current = pending.pop()
        if "discriminator" in current and "oneOf" in current:
            current["anyOf"] = current.pop("oneOf")
            current.pop("discriminator")
        for keyword in ("properties", "$defs", "definitions", "patternProperties"):
            pending.extend(current.get(keyword, {}).values())
        for keyword in ("items", "additionalProperties"):
            if isinstance(current.get(keyword), dict):
                pending.append(current[keyword])
        for keyword in ("anyOf", "oneOf", "allOf"):
            pending.extend(current.get(keyword, []))
    return api_schema


def build_openai_request_content(request: LLMRequest, schema: type[BaseModel] | None = None,
                                 *, json_output: bool = False) -> dict[str, Any]:
    """构建完整消息与输出格式，模拟和真实 OpenAI 兼容请求使用同一份约束。

    Args:
        request: 已渲染并补齐默认值的请求。
        schema: 本次使用原生结构化输出时的模型。
        json_output: 是否发送 JSON Output，由当前输出配置决定。
    Returns:
        messages 及适用时的 response_format，不含接入地址或凭据。
    """
    messages = build_request_messages(request)
    content: dict[str, Any] = {"messages": messages}
    output_schema = schema.model_json_schema() if schema is not None else request.json_output_schema
    if json_output and output_schema is not None:
        content["response_format"] = {"type": "json_object"}
        instructions = (
            "请只输出一个符合以下 JSON Schema 的 JSON 对象，"
            "不要输出 Markdown 代码块或额外说明。\nJSON Schema:\n"
            + json.dumps(output_schema, ensure_ascii=False)
        )
        if messages and messages[0]["role"] == "system":
            messages[0] = {**messages[0], "content": messages[0]["content"] + "\n\n" + instructions}
        else:
            messages.insert(0, {"role": "system", "content": instructions})
    elif schema is not None:
        api_schema = build_openai_schema(schema)
        content["response_format"] = {"type": "json_schema", "json_schema": {
            "name": schema.__name__, "strict": True, "schema": api_schema,
        }}
    return content


_OPENAI_ENDPOINT_SUFFIXES: tuple[tuple[str, ...], ...] = (
    ("chat", "completions"),
    ("responses",),
    ("response",),
    ("completions",),
    ("embeddings",),
    ("images",),
    ("audio", "speech"),
    ("audio", "transcriptions"),
    ("audio", "translations"),
    ("moderations",),
    ("models",),
    ("files",),
    ("batches",),
    ("uploads",),
    ("assistants",),
    ("threads",),
    ("vector_stores",),
    ("fine_tuning", "jobs"),
)


def _trim_openai_endpoint_suffixes(segments: list[str]) -> list[str]:
    """移除用户误填到 base_url 末尾的 OpenAI 接口端点路径。

    Args:
        segments: URL path 拆分后的路径片段。

    Returns:
        已去掉已知接口端点尾巴的路径片段。
    """
    remaining = list(segments)
    while remaining:
        lowered = [segment.lower() for segment in remaining]
        matched = False
        for suffix in _OPENAI_ENDPOINT_SUFFIXES:
            if len(remaining) >= len(suffix) and tuple(lowered[-len(suffix) :]) == suffix:
                del remaining[-len(suffix) :]
                matched = True
                break
        if not matched:
            break
    return remaining


def _build_openai_sdk_base_url(base_url: str) -> str | None:
    """将配置中的 OpenAI 根地址转换为 SDK 需要的版本根地址。

    Args:
        base_url: 用户配置的服务根地址，兼容旧配置中已包含版本路径的地址。

    Returns:
        SDK 可直接使用的 base_url；空配置返回 None 以保留 SDK 默认行为。
    """
    trimmed = base_url.strip()
    if not trimmed:
        return None

    parsed = urlsplit(trimmed)
    if parsed.scheme and parsed.netloc:
        segments = _trim_openai_endpoint_suffixes([segment for segment in parsed.path.split("/") if segment])
        if not segments or not _API_VERSION_RE.fullmatch(segments[-1]):
            # 配置文件只保存服务根地址，OpenAI 兼容 SDK 调用前统一补到版本根路径。
            segments.append("v1")
        path = "/" + "/".join(segments)
        return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))

    segments = _trim_openai_endpoint_suffixes([segment for segment in trimmed.rstrip("/").split("/") if segment])
    if segments and _API_VERSION_RE.fullmatch(segments[-1]):
        return "/".join(segments)
    return f"{'/'.join(segments)}/v1"


class OpenAICompatibleClient(BaseLLMClient):
    """基于 Chat Completions API 的 OpenAI 兼容客户端。

    兼容所有支持 /v1/chat/completions 端点的服务商，
    结构化输出默认使用 JSON Schema，DeepSeek 使用 JSON Output 并在本地校验。
    """

    live_stream = True

    def __init__(self, config: LLMProviderConfig, provider_name: str = "openai") -> None:
        super().__init__(config, provider_name)
        base_url = config.base_url.strip()
        if config.is_deepseek and not base_url:
            base_url = "https://api.deepseek.com"
        self._http_client = openai.DefaultAsyncHttpxClient(
            trust_env=config.use_system_proxy,
            timeout=float(config.timeout_seconds),
            event_hooks={"request": [self._before_http_request, log_http_request], "response": [log_http_response]},
        )
        if config.is_deepseek and config.resolved_api_mode == "responses":
            parsed = urlsplit(base_url)
            segments = _trim_openai_endpoint_suffixes([part for part in parsed.path.split("/") if part])
            if parsed.hostname == "api.deepseek.com" and segments == ["v1"]:
                segments = []
            base_url = urlunsplit((parsed.scheme, parsed.netloc, "/".join(segments), "", ""))
        self._client = AsyncOpenAI(
            base_url=(base_url.rstrip("/") if config.is_deepseek and config.resolved_api_mode == "responses"
                      else _build_openai_sdk_base_url(base_url)),
            api_key=config.api_key,
            timeout=float(config.timeout_seconds),
            max_retries=config.max_retries,
            http_client=self._http_client,
        )

    def _build_params(self, request: LLMRequest, *, function_calling: bool = False) -> dict[str, Any]:
        """根据请求构建 Chat Completions API 调用参数。

        Args:
            request: 已补齐默认值的生成请求。
            function_calling: 是否正在调用工具或回传工具结果。
        Returns:
            适合当前模型和调用方式的 SDK 参数。
        """
        return build_openai_parameters(request, self.config, function_calling=function_calling,
                                       api_mode="chat_completions")

    def _uses_prompt_cache_key(self) -> bool:
        """只对 OpenAI 官方接口发送 prompt_cache_key；中转和 DeepSeek 可能不认这个字段。"""
        if not self.config.prompt_cache or self.config.is_deepseek:
            return False
        return urlsplit(self.config.base_url.strip()).hostname in (None, "api.openai.com")

    def _send_params(self, params: dict[str, Any]) -> dict[str, Any]:
        """发送前补上同一任务稳定的缓存键，只作用于这次请求。

        OpenAI 按前缀哈希路由缓存；同一任务（相同模型、系统提示和工具）的每轮请求带相同的键，
        才会落到同一台机器上读到前缀缓存。键只由这些稳定内容算出，不含时间或随机数。

        Args:
            params: 已构建的 Chat Completions 或 Responses 参数。
        Returns:
            可直接发送的新参数。
        """
        if not self.config.prompt_cache:
            return params
        mode = self.config.prompt_cache_mode
        model = str(params.get("model") or "")
        if mode == "implicit":
            return params
        rejected = cache_rejected(self, model)
        if mode == "anthropic" or (mode == "auto" and "claude" in model.lower()):
            return with_chat_anthropic_breakpoints(params) if "messages" in params and not rejected else params
        modern = mode == "openai" or (mode == "auto" and modern_openai_model(model) and not self.config.is_deepseek)
        if modern and not rejected:
            params = with_openai_breakpoints(params)
        if ((not self._uses_prompt_cache_key() and not modern) or "prompt_cache_key" in params
                or cache_rejected(self, model, key=True)):
            return params
        canonical = without_cache_directives(params)
        items = canonical.get("messages") or canonical.get("input") or []
        system = []
        for item in items:
            if not isinstance(item, dict) or item.get("role") not in {"system", "developer"}:
                break
            system.append(item.get("content"))
        # 工具说明和参数结构也是前缀的一部分；不以动态任务或随机 ID 作为缓存键。
        raw = json.dumps([params.get("model"), system, canonical.get("tools") or []], ensure_ascii=False, sort_keys=True, default=str)
        return {**params, "prompt_cache_key": "novel-" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:40]}

    def _cache_fallback(self, params: dict[str, Any], exc: Exception) -> dict[str, Any] | None:
        if not cache_parameter_rejected(exc):
            return None
        # 缓存键不是显式断点的前提；只拒绝键的网关仍然可以使用断点。
        if "prompt_cache_key" in params and "prompt_cache_key" in (str(getattr(exc, "param", "") or "") + str(exc)):
            remember_cache_rejection(self, params.get("model"), key=True)
            return {key: value for key, value in params.items() if key != "prompt_cache_key"}
        if cache_rejected(self, params.get("model")):
            return None
        remember_cache_rejection(self, params.get("model"))
        cleaned = without_cache_directives(params)
        # 断点不支持不代表缓存路由键不支持，继续让自动缓存使用稳定路由。
        if "prompt_cache_key" in params:
            cleaned["prompt_cache_key"] = params["prompt_cache_key"]
        return cleaned

    @staticmethod
    def _without_rejected_parameter(params: dict[str, Any], exc: Any) -> dict[str, Any] | None:
        """兼容服务明确拒绝某个可选参数时，换成它接受的写法重发一次；其他错误返回 None。"""
        message = str(getattr(exc, "message", "") or exc)
        param = getattr(exc, "param", None) or ""
        if ("max_tokens" in params and param == "max_tokens" and getattr(exc, "code", None) == "unsupported_parameter"
                and "max_completion_tokens" in message):
            params = dict(params)
            params["max_completion_tokens"] = params.pop("max_tokens")
            return params
        if "stream_options" in params and ("stream_options" in param or "stream_options" in message):
            return {key: value for key, value in params.items() if key != "stream_options"}
        return None

    async def _create_completion(self, params: dict[str, Any], *, collect_stream: bool = False) -> Any:
        """发送请求，按需收齐流式结果，并保留长度参数重试。

        Args:
            params: 已构建的 Chat Completions 参数。
            collect_stream: 是否发送流式请求并返回完整消息。
        Returns:
            SDK 完整响应；普通 stream_text 调用仍返回原始流。
        """
        params = self._send_params(params)
        if collect_stream or params.get("stream"):
            # 不加这一项，流式回复的最后不会带 usage，用量只能按字数估算，缓存命中也看不到。
            params = {"stream_options": {"include_usage": True}, **params}
        for attempt in range(4):
            try:
                if not collect_stream:
                    return await self._client.chat.completions.create(**params)
                live = ChatStreamLive()
                async with self._client.chat.completions.stream(**params) as events:
                    # 部分兼容网关忽略 stream，直接返回完整 JSON。复用已付费的结果，不能将它当空流后重发。
                    http_response = getattr(events, "_response", None)
                    media_type = (http_response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                                  if http_response is not None else "")
                    if media_type == "application/json" or media_type.endswith("+json"):
                        from openai.types.chat import ChatCompletion
                        try:
                            response = ChatCompletion.model_validate_json(await http_response.aread())
                        except ValueError as exc:
                            raise LLMResponseError("服务返回的工具响应不是合法的 Chat Completions JSON", provider=self.provider_name) from exc
                        observe_provider_response(response, self.config.resolved_api_mode)
                    else:
                        received = False
                        async for event in events:
                            if event.type == "chunk":
                                self._touch_stream()
                                received = True
                                observe_provider_response(event.chunk, self.config.resolved_api_mode)
                                live.feed(event.chunk)
                        if not received:
                            raise LLMConnectionError("Chat Completions 响应流没有返回数据", provider=self.provider_name)
                        response = await events.get_final_completion()
                if not response.choices or any(choice.finish_reason is None for choice in response.choices):
                    raise LLMConnectionError("Chat Completions 响应流提前断开，请重试", provider=self.provider_name)
                return response
            except (openai.BadRequestError, openai.UnprocessableEntityError) as exc:
                # 中转服务可能使用自定义模型名，以明确的错误说明为准；每种调整最多一次（参数被移除后不会再匹配）。
                adjusted = (self._cache_fallback(params, exc) or self._without_rejected_parameter(params, exc)) if attempt < 3 else None
                if adjusted is None:
                    raise
                params = adjusted

    def _map_error(self, exc: Exception, model: str = "") -> LLMError:
        """将 OpenAI SDK 异常映射为自定义异常。"""
        if isinstance(exc, _BeforeSendError):
            exc.__cause__ = exc.__context__ = None
            raise exc.original from exc.original.__cause__
        kwargs = {"provider": self.provider_name, "model": model}
        if isinstance(exc, LLMError):
            return exc
        if isinstance(exc, openai.AuthenticationError):
            return LLMAuthError(str(exc), **kwargs)
        if isinstance(exc, openai.RateLimitError):
            return LLMRateLimitError(str(exc), **kwargs)
        if isinstance(exc, openai.APITimeoutError):
            return LLMTimeoutError(str(exc), **kwargs)
        if isinstance(exc, openai.APIConnectionError):
            # 超时已在上面单独归类；其余是连不上或连接被断开，可以重试。
            return LLMConnectionError(str(exc), **kwargs)
        if isinstance(exc, openai.APIError):
            return LLMResponseError(str(exc), **kwargs)
        return self._transport_error(exc, **kwargs) or LLMError(str(exc), **kwargs)

    @staticmethod
    def _extract_usage(usage: Any) -> TokenUsage:
        """从响应中提取 Token 用量；命中缓存的部分已包含在 prompt_tokens 里，单独记下供计费。"""
        if usage is None:
            return TokenUsage()
        read, write = cache_usage(usage)
        input_t = token_count(usage, "prompt_tokens", "input_tokens")
        output_t = token_count(usage, "completion_tokens", "output_tokens")
        return TokenUsage(
            input_tokens=input_t,
            output_tokens=output_t,
            total_tokens=token_count(usage, "total_tokens") or input_t + output_t,
            cache_read_tokens=read,
            cache_write_tokens=write,
        )

    async def text_generate(self, request: LLMRequest) -> LLMResponse:
        """调用 Chat Completions API 进行普通文本生成。"""
        request = self._apply_defaults(request)
        model = self._resolve_model(request)
        with LLMCall(self.provider_name, model, "text", use_system_proxy=self.config.use_system_proxy) as call:
            start = time.perf_counter()

            try:
                resp = await self._create_completion(self._build_params(request), collect_stream=request.stream)
                observe_provider_response(resp, self.config.resolved_api_mode)
            except LLMError:
                raise
            except Exception as exc:
                mapped = self._map_error(exc, model)
                raise mapped from exc

            elapsed_ms = int((time.perf_counter() - start) * 1000)
            choice = resp.choices[0] if resp.choices else None
            if choice and choice.finish_reason == "length":
                call.finish_reason = choice.finish_reason
                call.usage = self._extract_usage(resp.usage)
                raise LLMResponseError(
                    "模型输出达到长度上限，内容未完成", provider=self.provider_name, model=model,
                    partial_text=choice.message.content or "",
                )
            if choice and choice.finish_reason == "content_filter":
                raise LLMResponseError("模型输出被内容过滤，请调整输入后重试", provider=self.provider_name, model=model)
            result = LLMResponse(
                content=(choice.message.content or "") if choice else "",
                raw_response=resp.model_dump(warnings=False) if hasattr(resp, "model_dump") else None,
                usage=self._extract_usage(resp.usage),
                model=resp.model or model,
                provider=self.provider_name,
                duration_ms=elapsed_ms,
                finish_reason=(choice.finish_reason or "") if choice else "",
                success=True,
            )
            if request.json_output_schema is not None:
                reject_duplicate_json_keys(result.content)
            result = self._finalize_response(result, preserve_json_strings=request.json_output_schema is not None)
            call.result = result
            return result

    async def schema_generate(self, request: LLMRequest, schema: type[BaseModel]) -> LLMResponse:
        """生成结构化 JSON，并按原始模型校验返回值。

        Args:
            request: 对话消息和生成参数。
            schema: 输出必须符合的 Pydantic 模型。

        Returns:
            已通过模型校验的 JSON 字符串及原始响应、用量等信息。
        """
        request = self._apply_defaults(request)
        if self.config.resolved_structured_output_mode == "json_object":
            request = request.model_copy(update={"json_output_schema": schema.model_json_schema()})
        model = self._resolve_model(request)
        with LLMCall(self.provider_name, model, "schema", schema=schema, use_system_proxy=self.config.use_system_proxy) as call:
            start = time.perf_counter()

            try:
                # 显式结构化调用也走与普通生成、预览相同的格式构建。
                params = build_openai_parameters(request, self.config, schema=schema, api_mode="chat_completions")
                resp = await self._create_completion(params, collect_stream=request.stream)
                observe_provider_response(resp, self.config.resolved_api_mode)
                choice = resp.choices[0] if resp.choices else None
            except LLMError:
                raise
            except Exception as exc:
                mapped = self._map_error(exc, model)
                raise mapped from exc

            elapsed_ms = int((time.perf_counter() - start) * 1000)

            if choice and choice.finish_reason == "length":
                raise LLMSchemaError(
                    "模型输出被截断，请增加 max_tokens 后重试", provider=self.provider_name, model=model
                )
            if choice and choice.finish_reason == "content_filter":
                raise LLMSchemaError("模型输出被内容过滤，请调整输入后重试", provider=self.provider_name, model=model)
            parsed_obj = None
            if choice and choice.message.content and not choice.message.refusal:
                reject_duplicate_json_keys(choice.message.content)
                try:
                    parsed_obj = schema.model_validate_json(choice.message.content)
                except ValidationError as exc:
                    raise LLMSchemaError(
                        "模型返回的 JSON 不符合目标结构", provider=self.provider_name, model=model
                    ) from exc
            if parsed_obj is None:
                refusal = getattr(choice.message, "refusal", None) if choice else None
                err_msg = refusal or "模型未返回有效的结构化输出"
                error = LLMSchemaError(err_msg, provider=self.provider_name, model=model)
                raise error

            result = LLMResponse(
                content=parsed_obj.model_dump_json(),
                raw_response=resp.model_dump(warnings=False) if hasattr(resp, "model_dump") else None,
                usage=self._extract_usage(resp.usage),
                model=resp.model or model,
                provider=self.provider_name,
                duration_ms=elapsed_ms,
                finish_reason=(choice.finish_reason or "") if choice else "",
                success=True,
            )
            result = self._finalize_response(result, preserve_json_strings=True)
            call.result = result
            return result

    async def stream_text(self, request: LLMRequest) -> AsyncGenerator[str, None]:
        """流式调用 Chat Completions API，逐块 yield 生成文本。"""
        # 流式入口统一标记请求语义，保证调试日志与实际 SDK 调用保持一致。
        request = self._apply_defaults(request).model_copy(update={"stream": True})
        model = self._resolve_model(request)
        with LLMCall(self.provider_name, model, "stream", use_system_proxy=self.config.use_system_proxy) as call:

            try:
                params = self._build_params(request)
                params["stream"] = True
                stream = await self._create_completion(params)
                stream_filter = _ThinkStreamFilter(preserve_json_strings=request.json_output_schema is not None)
                async with stream:
                    async for chunk in stream:
                        self._touch_stream()
                        observe_provider_response(chunk, self.config.resolved_api_mode)
                        call.chunk_count += 1
                        if chunk.usage is not None:
                            call.usage = self._extract_usage(chunk.usage)
                        text = ""
                        if chunk.choices:
                            text = chunk.choices[0].delta.content or ""
                            if chunk.choices[0].finish_reason:
                                call.finish_reason = chunk.choices[0].finish_reason
                        if text:
                            call.chunks.append(text)
                            clean_text = stream_filter.feed(text)
                            if clean_text:
                                yield clean_text
                if not call.finish_reason:
                    raise LLMConnectionError("Chat Completions 响应流提前断开，请重试", provider=self.provider_name, model=model)
                if call.finish_reason == "length":
                    raise LLMResponseError(
                        "模型输出达到长度上限，内容未完成", provider=self.provider_name, model=model,
                        partial_text="".join(call.chunks),
                    )
                if call.finish_reason == "content_filter":
                    raise LLMResponseError("模型输出被内容过滤，请调整输入后重试", provider=self.provider_name, model=model)
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
        """执行原生工具对话，完整回传 DeepSeek 等兼容服务的附加字段。

        Args:
            request: 固定的提示和参数。
            tools: 服务端工具白名单。
            history: 本客户端上一轮返回的消息。
            results: 上轮全部调用的结果。
        Returns:
            本轮工具调用、正文、用量及完整消息历史。
        """
        request = self._apply_defaults(request)
        model = self._resolve_model(request)
        messages = deepcopy(history) if history is not None else self._build_messages(request)
        messages.extend({"role": "tool", "tool_call_id": result.id,
                         "content": json.dumps(result.content, ensure_ascii=False)} for result in results or [])
        params = self._build_params(request, function_calling=True)
        params.pop("response_format", None)
        params.update(messages=messages, tool_choice="auto", tools=[
            {"type": "function", "function": tool.model_dump()} for tool in tools
        ])
        try:
            response = await self._create_completion(params, collect_stream=request.stream)
            observe_provider_response(response, self.config.resolved_api_mode)
            if not response.choices:
                raise ValueError("工具对话没有返回候选")
            choice = response.choices[0]
            if choice.finish_reason not in {"stop", "tool_calls"}:
                raise LLMResponseError(f"工具回复未完成：{choice.finish_reason}，请检查输出上限或输入", provider=self.provider_name, model=model,
                                       truncated=choice.finish_reason == "length")
            if choice.message.refusal:
                raise LLMResponseError("模型拒绝了本次工具对话，请调整输入后重试", provider=self.provider_name, model=model)
            # 不能只重建正文和工具字段，reasoning_content 等续接字段也必须留下。
            # SDK 的解析结果和分片序号不属于上游消息字段。
            messages.append(choice.message.model_dump(
                mode="json", exclude_none=True, warnings=False,
                exclude={"parsed": True, "tool_calls": {"__all__": {"index": True, "function": {"parsed_arguments": True}}}},
            ))
            calls = []
            for tool_call in choice.message.tool_calls or []:
                reject_duplicate_json_keys(tool_call.function.arguments)
                calls.append(LLMToolCall(id=tool_call.id, name=tool_call.function.name,
                                         arguments=json.loads(tool_call.function.arguments)))
            return LLMToolTurn(content=self._sanitize_text_content(choice.message.content or ""),
                               calls=calls, history=messages, usage=self._extract_usage(response.usage),
                               finish_reason=choice.finish_reason or "")
        except LLMError:
            raise
        except Exception as exc:
            raise self._map_error(exc, model) from exc

    async def function_call_probe(
        self,
        request: LLMRequest,
        probe: LLMFunctionCallProbe,
    ) -> LLMResponse:
        """执行 OpenAI 兼容 Function Calling 两轮探测。

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
                "type": "function",
                "function": {
                    "name": probe.tool_name,
                    "description": probe.tool_description,
                    "parameters": probe.parameters_schema,
                    "strict": True,
                },
            }

            try:
                params = self._build_params(request, function_calling=True)
                params["tools"] = [tool_def]
                if self.config.is_deepseek:
                    # 思考模式不支持强制指定工具，探测必须沿用用户的实际思考设置。
                    tool_def["function"].pop("strict")
                params["tool_choice"] = "auto" if self.config.is_deepseek else {
                    "type": "function",
                    "function": {"name": probe.tool_name},
                }
                first_resp = await self._create_completion(params, collect_stream=request.stream)
                observe_provider_response(first_resp, self.config.resolved_api_mode)
                first_choice = first_resp.choices[0] if first_resp.choices else None
                tool_calls = list(getattr(first_choice.message, "tool_calls", None) or []) if first_choice else []
                tool_call = next(
                    (
                        call
                        for call in tool_calls
                        if getattr(getattr(call, "function", None), "name", "") == probe.tool_name
                    ),
                    None,
                )
                if tool_call is None:
                    raise ValueError("模型未返回指定工具调用")

                reject_duplicate_json_keys(tool_call.function.arguments or "{}")
                actual_args = json.loads(tool_call.function.arguments or "{}")
                self._validate_probe_arguments(actual_args, probe.expected_arguments)

                # 第二轮把本地模拟工具结果回传给模型，确认接口能完成真实 tool-call 循环。
                messages = self._build_messages(request)
                messages.append(first_choice.message.model_dump(
                    mode="json", exclude_none=True, warnings=False,
                    exclude={"parsed": True, "tool_calls": {"__all__": {"index": True, "function": {"parsed_arguments": True}}}},
                ))
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": json.dumps(probe.tool_result, ensure_ascii=False),
                    }
                )
                messages.append({"role": "user", "content": probe.final_response_prompt})
                final_request = request.model_copy(update={"messages": messages, "system_prompt": ""})
                final_resp = await self._create_completion(self._build_params(final_request, function_calling=True), collect_stream=final_request.stream)
                observe_provider_response(final_resp, self.config.resolved_api_mode)
            except LLMError:
                raise
            except Exception as exc:
                mapped = self._map_error(exc, model)
                raise mapped from exc

            elapsed_ms = int((time.perf_counter() - start) * 1000)
            final_choice = final_resp.choices[0] if final_resp.choices else None
            content = (final_choice.message.content or "") if final_choice else ""
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
                    "tool_call": first_resp.model_dump(warnings=False) if hasattr(first_resp, "model_dump") else None,
                    "final": final_resp.model_dump(warnings=False) if hasattr(final_resp, "model_dump") else None,
                },
                usage=first_usage.plus(final_usage),
                model=final_resp.model or model,
                provider=self.provider_name,
                duration_ms=elapsed_ms,
                finish_reason=(final_choice.finish_reason or "") if final_choice else "",
                success=True,
            )
            result = self._finalize_response(result)
            call.result = result
            return result
