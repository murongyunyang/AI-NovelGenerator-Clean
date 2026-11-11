"""Google Gemini 客户端实现，基于 google-genai 官方 SDK。"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
import re
from contextlib import aclosing
from typing import Any, AsyncGenerator

import httpx2 as httpx
from google import genai
from google.genai import errors as genai_errors
from google.genai import types
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
from backend.llm.models import LLMFunctionCallProbe, LLMRequest, LLMResponse, TokenUsage, LLMToolCall, LLMToolDefinition, LLMToolResult, LLMToolTurn, LLMWebSearchResult, collect_web_sources
from backend.llm.prompt_cache import cache_usage, token_count, cache_rejected, remember_cache_rejection

logger = logging.getLogger("llm")

# 显式缓存有最低长度和按小时的存储费；前缀太短时只靠隐式缓存。中文约 1 字 1 token。
_EXPLICIT_CACHE_MIN_CHARS = 8000
_EXPLICIT_CACHE_TTL_SECONDS = 900
# 本地记录的缓存还剩不到这么久就重建，避免请求途中过期。
_EXPLICIT_CACHE_RENEW_MARGIN = 90


def build_gemini_generation_config(request: LLMRequest, model: str, *, interactions: bool = False) -> dict[str, Any]:
    """转换 Gemini 生成参数，新接口使用等级，旧 2.5 接口使用预算。

    Args:
        request: 已合并 Provider 默认值的请求。
        model: 实际模型名称。
        interactions: 是否使用 Interactions 接口。
    Returns:
        当前接口支持的生成参数，不含消息或凭据。
    """
    if request.thinking_mode or request.reasoning_mode or request.verbosity:
        raise ValueError("Gemini 使用思考等级或思考预算，不支持当前选择的其他思考参数")
    if request.reasoning_effort is not None and request.thinking_budget is not None:
        raise ValueError("Gemini 思考等级和思考预算不能同时设置")
    if request.reasoning_effort not in (None, "minimal", "low", "medium", "high"):
        raise ValueError("Gemini 思考等级支持 minimal、low、medium、high；旧版关闭思考请使用预算 0")
    if request.reasoning_effort == "minimal" and re.search(r"gemini-(?:3\.[78]-flash|3(?:\.1)?-pro)", model):
        raise ValueError("当前 Gemini 模型不支持 minimal，请选择 low 或更高等级")
    if request.reasoning_effort == "medium" and "gemini-3-pro" in model:
        raise ValueError("Gemini 3 Pro 支持 low 或 high 思考等级")
    kwargs: dict[str, Any] = {}
    if not interactions and not re.search(r"gemini-3\.[5-9]", model):
        for field in ("temperature", "top_p", "presence_penalty", "frequency_penalty"):
            if getattr(request, field) is not None:
                kwargs[field] = getattr(request, field)
    if request.max_tokens is not None:
        kwargs["max_output_tokens"] = request.max_tokens
    if request.stop is not None:
        kwargs["stop_sequences"] = request.stop
    if interactions:
        if request.thinking_budget is not None:
            raise ValueError("Interactions 使用思考等级；如需旧模型的 token 预算，请选择 Generate Content 接口")
        if request.reasoning_effort is not None:
            kwargs["thinking_level"] = request.reasoning_effort
    else:
        thinking: dict[str, Any] = {}
        if request.reasoning_effort is not None:
            if "gemini-2.5" in model:
                raise ValueError("Gemini 2.5 的 Generate Content 接口使用思考预算，请取消等级设置")
            thinking["thinking_level"] = request.reasoning_effort
        if request.thinking_budget is not None:
            if "gemini-2.5-pro" in model and request.thinking_budget != -1 and not 128 <= request.thinking_budget <= 32768:
                raise ValueError("Gemini 2.5 Pro 思考预算应为 -1 或 128–32768，不能关闭思考")
            thinking["thinking_budget"] = request.thinking_budget
        if thinking:
            kwargs["thinking_config"] = thinking
    return kwargs


class GeminiClient(BaseLLMClient):
    """Google Gemini 客户端，通过 google-genai SDK 调用 Gemini API。"""

    def __init__(self, config: LLMProviderConfig, provider_name: str = "gemini") -> None:
        super().__init__(config, provider_name)
        client_kwargs: dict[str, Any] = {"api_key": config.api_key}
        self._http_client = httpx.AsyncClient(
            trust_env=config.use_system_proxy, timeout=float(config.timeout_seconds), follow_redirects=True,
            event_hooks={"request": [self._before_http_request, log_http_request], "response": [log_http_response]},
        )
        http_options_kwargs: dict[str, Any] = {
            "timeout": int(config.timeout_seconds * 1000),
            "client_args": {"trust_env": config.use_system_proxy},
            "httpx_async_client": self._http_client,
            "retry_options": types.HttpRetryOptions(attempts=config.max_retries + 1),
        }
        if config.base_url:
            http_options_kwargs["base_url"] = config.base_url
        self._http_options = types.HttpOptions(**http_options_kwargs)
        client_kwargs["http_options"] = self._http_options
        self._client = genai.Client(**client_kwargs)
        # 前缀哈希 -> (cachedContents 名称, 本地过期时刻)
        self._explicit_caches: dict[str, tuple[str, float]] = {}
        self._explicit_cache_locks: dict[str, asyncio.Lock] = {}

    async def _with_explicit_cache(self, model: str, contents: list[types.Content],
                                   config: types.GenerateContentConfig) -> tuple[list[types.Content], types.GenerateContentConfig, str | None]:
        """把稳定前缀（系统指令、工具声明、多轮时的首条资料）建成 cachedContent 供后续请求引用。

        隐式缓存只是尽力而为，中转轮换上游时几乎命中不了；显式缓存命中是确定的。
        Args:
            model: 当前模型。
            contents: 完整输入。
            config: 已构建的生成参数。
        Returns:
            实际发送的 contents、config，以及使用的缓存名（未使用时为 None）。
        """
        if not self.config.prompt_cache or self.config.prompt_cache_mode == "implicit" or not contents:
            return contents, config, None
        if cache_rejected(self, model) or getattr(config, "cached_content", None):
            return contents, config, None
        tools = config.tools or []
        # 联网搜索等内置工具不放进缓存，保持原样发送。
        if any(not isinstance(tool, types.Tool) or tool.function_declarations is None for tool in tools):
            return contents, config, None
        # 多轮（工具循环）时首条用户资料每轮相同，一起缓存；单轮时它就是本次问题，只缓存系统指令。
        cached_contents = contents[:1] if len(contents) >= 2 and contents[0].role == "user" else []
        system = config.system_instruction
        prefix = {
            "model": model,
            "system": system if isinstance(system, str) else (system.model_dump(mode="json", exclude_none=True) if system else None),
            "tools": [tool.model_dump(mode="json", exclude_none=True) for tool in tools],
            "tool_config": config.tool_config.model_dump(mode="json", exclude_none=True) if config.tool_config else None,
            "contents": [item.model_dump(mode="json", exclude_none=True) for item in cached_contents],
        }
        raw = json.dumps(prefix, ensure_ascii=False, sort_keys=True, default=str)
        if len(raw) < _EXPLICIT_CACHE_MIN_CHARS:
            return contents, config, None
        key = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        entry = self._explicit_caches.get(key)
        if entry is None or entry[1] <= time.monotonic() + _EXPLICIT_CACHE_RENEW_MARGIN:
            async with self._explicit_cache_locks.setdefault(key, asyncio.Lock()):
                entry = self._explicit_caches.get(key)
                if entry is None or entry[1] <= time.monotonic() + _EXPLICIT_CACHE_RENEW_MARGIN:
                    try:
                        created = await self._client.aio.caches.create(model=model, config=types.CreateCachedContentConfig(
                            display_name="novel-" + key[:16], ttl=f"{_EXPLICIT_CACHE_TTL_SECONDS}s",
                            system_instruction=system or None, tools=tools or None, tool_config=config.tool_config,
                            contents=cached_contents or None,
                        ))
                    except _BeforeSendError:
                        raise
                    except Exception as exc:
                        # 中转不支持 cachedContents、前缀低于模型最低长度等情况：五分钟内回退为隐式缓存。
                        logger.warning("Gemini 显式缓存创建失败，回退为隐式缓存：%s", exc)
                        remember_cache_rejection(self, model)
                        return contents, config, None
                    entry = (created.name, time.monotonic() + _EXPLICIT_CACHE_TTL_SECONDS)
                    self._explicit_caches[key] = entry
                    logger.info("[Gemini 显式缓存] 已创建 name=%s model=%s prefix_chars=%d ttl=%ds",
                                created.name, model, len(raw), _EXPLICIT_CACHE_TTL_SECONDS)
        # 引用 cachedContent 时，系统指令、工具和工具配置必须只放在缓存里。
        sent = config.model_copy(update={"cached_content": entry[0], "system_instruction": None,
                                         "tools": None, "tool_config": None})
        return contents[len(cached_contents):], sent, entry[0]

    def _drop_explicit_cache(self, model: str, name: str, exc: Exception) -> bool:
        """引用缓存的请求被 4xx 拒绝（过期、中转换了上游账号等）时作废该缓存并允许无缓存重发一次。"""
        if not isinstance(exc, genai_errors.ClientError) or exc.code == 429:
            return False
        self._explicit_caches = {key: value for key, value in self._explicit_caches.items() if value[0] != name}
        remember_cache_rejection(self, model)
        logger.warning("Gemini 显式缓存 %s 不可用，本次改为不带缓存重发：%s", name, exc)
        return True

    def _build_contents(self, request: LLMRequest) -> list[types.Content]:
        """将 messages 转换为 Gemini SDK 的 Content 列表。"""
        contents: list[types.Content] = []
        for msg in request.messages:
            role = msg["role"]
            # Gemini 仅识别 "user" 和 "model" 角色
            if role == "assistant":
                role = "model"
            elif role == "system":
                # system 消息通过 system_instruction 处理，此处跳过
                continue
            contents.append(types.Content(role=role, parts=[types.Part(text=msg["content"])]))
        return contents

    def _build_config(self, request: LLMRequest) -> types.GenerateContentConfig:
        """构建 Gemini 生成配置参数。"""
        kwargs = build_gemini_generation_config(request, self._resolve_model(request))
        system_parts = [request.system_prompt] if request.system_prompt else []
        system_parts.extend(msg["content"] for msg in request.messages if msg["role"] == "system")
        if system_parts:
            kwargs["system_instruction"] = "\n".join(system_parts)
        if request.json_output_schema is not None and self.config.supports_json_schema:
            kwargs.update(response_mime_type="application/json", response_json_schema=request.json_output_schema)
        return types.GenerateContentConfig(**kwargs)

    @staticmethod
    def _exception_search_text(exc: Exception) -> str:
        """汇总异常链的类型与消息，兼容 httpx.ReadTimeout 这类空消息异常。"""
        parts: list[str] = []
        current: BaseException | None = exc
        seen: set[int] = set()
        while current is not None and id(current) not in seen:
            seen.add(id(current))
            parts.append(type(current).__name__)
            parts.append(str(current))
            current = current.__cause__ or current.__context__
        return " ".join(parts).lower()

    def _map_error(self, exc: Exception, model: str = "") -> LLMError:
        """将 Gemini SDK 异常映射为自定义异常。"""
        if isinstance(exc, _BeforeSendError):
            # Interactions 重抛 inner 时可能留下 SDK 包装链的环，只清理临时封套。
            exc.__cause__ = exc.__context__ = None
            raise exc.original from exc.original.__cause__
        kwargs = {"provider": self.provider_name, "model": model}
        if isinstance(exc, LLMError):
            return exc
        if isinstance(exc, genai_errors.APIError) and isinstance(exc.code, int):
            # 有 HTTP 状态时按状态分类；只看文字会把 “generateContent” 里的 rate 当成限流。
            # 密钥无效时 Gemini 返回 400 INVALID_ARGUMENT（原因 API_KEY_INVALID）。
            if exc.code in {401, 403} or (exc.code == 400 and re.search(r"api[_ ]key", self._exception_search_text(exc))):
                return LLMAuthError(str(exc), **kwargs)
            if exc.code == 429:
                return LLMRateLimitError(str(exc), **kwargs)
            if exc.code in {408, 504}:
                return LLMTimeoutError(str(exc), **kwargs)
            return LLMResponseError(str(exc), **kwargs)
        exc_str = self._exception_search_text(exc)
        if re.search(r"api_key|api key|authentication|unauthenticated|permission[_ ]denied", exc_str):
            return LLMAuthError(str(exc), **kwargs)
        if re.search(r"rate[_ ]?limit|quota|resource_exhausted|too many requests", exc_str):
            return LLMRateLimitError(str(exc), **kwargs)
        if "timeout" in exc_str or "deadline" in exc_str:
            return LLMTimeoutError(str(exc), **kwargs)
        transport = self._transport_error(exc, **kwargs)
        if transport is not None:
            return transport
        return LLMResponseError(str(exc), **kwargs)

    @staticmethod
    def _visible_text(response: Any) -> str:
        """仅取最终文本 part，Gemini 的 thought part 不能进入作品。"""
        candidates = getattr(response, "candidates", None)
        if candidates:
            parts = getattr(getattr(candidates[0], "content", None), "parts", None)
            if parts is not None:
                return "".join(part.text for part in parts if getattr(part, "text", None) and not getattr(part, "thought", False))
        return getattr(response, "text", None) or ""

    @staticmethod
    def _extract_usage(usage_metadata: Any) -> TokenUsage:
        """从 Gemini 响应中提取 Token 用量。"""
        if usage_metadata is None:
            return TokenUsage()
        # cached_content_token_count（隐式缓存命中）已包含在 prompt_token_count 里，单独记下供计费。
        read, write = cache_usage(usage_metadata)
        input_t = token_count(usage_metadata, "prompt_token_count", "promptTokenCount")
        output_t = token_count(usage_metadata, "candidates_token_count", "candidatesTokenCount") + token_count(usage_metadata, "thoughts_token_count", "thoughtsTokenCount")
        return TokenUsage(input_tokens=input_t, output_tokens=output_t,
                          total_tokens=token_count(usage_metadata, "total_token_count", "totalTokenCount") or input_t + output_t,
                          cache_read_tokens=read, cache_write_tokens=write)

    def _check_finish(self, response: Any, model: str) -> None:
        """普通生成和结构化输出只接受正常结束；达到上限时带回已生成的正文。

        Args:
            response: 完整的 Generate Content 响应。
            model: 当前模型。
        Returns:
            无；被拦截、截断或其他异常结束时抛出 LLMResponseError。
        """
        if not response.candidates:
            feedback = getattr(response, "prompt_feedback", None)
            reason = getattr(feedback, "block_reason", None)
            if reason is not None:
                raise LLMResponseError(f"Gemini 拒绝了本次输入：{reason}", provider=self.provider_name, model=model)
            return
        finish = response.candidates[0].finish_reason
        if finish == types.FinishReason.MAX_TOKENS:
            raise LLMResponseError(
                "模型输出达到长度上限，内容未完成", provider=self.provider_name, model=model,
                partial_text=self._visible_text(response),
            )
        if finish is not None and finish != types.FinishReason.STOP:
            raise LLMResponseError(f"Gemini 回复未完成：{finish}", provider=self.provider_name, model=model)

    async def _generate_content(self, *, model: str, contents: list[types.Content],
                                config: types.GenerateContentConfig, stream: bool) -> Any:
        """收齐 Generate Content 的原生内容块，保留工具调用和签名。

        Args:
            model: 当前模型。
            contents: 完整输入及工具上下文。
            config: 已构建的生成参数。
            stream: 是否使用流式接口。
        Returns:
            完整的 SDK 响应，普通请求保持原样。
        """
        sent_contents, sent_config, cache_name = await self._with_explicit_cache(model, contents, config)
        if cache_name is None:
            return await self._send_content(model=model, contents=contents, config=config, stream=stream)
        try:
            return await self._send_content(model=model, contents=sent_contents, config=sent_config, stream=stream)
        except Exception as exc:
            if not self._drop_explicit_cache(model, cache_name, exc):
                raise
        return await self._send_content(model=model, contents=contents, config=config, stream=stream)

    async def _send_content(self, *, model: str, contents: list[types.Content],
                            config: types.GenerateContentConfig, stream: bool) -> Any:
        """发送一次 Generate Content 请求并收齐流式内容块。"""
        if not stream:
            return await self._client.aio.models.generate_content(model=model, contents=contents, config=config)
        response = None
        candidate = None
        parts: list[types.Part] = []
        events = await self._client.aio.models.generate_content_stream(model=model, contents=contents, config=config)
        async with aclosing(events):
            async for chunk in events:
                self._touch_stream()
                observe_provider_response(chunk, self.config.resolved_api_mode)
                if response is None:
                    response = chunk.model_copy(deep=True)
                if chunk.usage_metadata is not None:
                    response.usage_metadata = chunk.usage_metadata
                if chunk.candidates:
                    current = chunk.candidates[0]
                    if candidate is None:
                        candidate = current.model_copy(deep=True)
                    if current.content is not None:
                        parts.extend(current.content.parts or [])
                    if current.finish_reason is not None:
                        candidate.finish_reason = current.finish_reason
        if candidate is None and response is not None:
            # 输入被拦截时流里只有 prompt_feedback、没有候选，不是断线，重试也没用。
            self._check_finish(response, model)
        if candidate is None or candidate.finish_reason is None:
            raise LLMConnectionError("Gemini 响应流提前断开，请重试", provider=self.provider_name, model=model)
        # finish_reason 由调用方检查：普通生成遇到 MAX_TOKENS 要带回已生成的正文。
        candidate.content = types.Content(role="model", parts=parts)
        response.candidates = [candidate]
        return response

    async def text_generate(self, request: LLMRequest) -> LLMResponse:
        """调用 Gemini API 进行普通文本生成。"""
        request = self._apply_defaults(request)
        model = self._resolve_model(request)
        with LLMCall(self.provider_name, model, "text", use_system_proxy=self.config.use_system_proxy) as call:
            start = time.perf_counter()

            try:
                resp = await self._generate_content(stream=request.stream,
                    model=model,
                    contents=self._build_contents(request),
                    config=self._build_config(request),
                )
                observe_provider_response(resp, self.config.resolved_api_mode)
            except LLMError:
                raise
            except Exception as exc:
                mapped = self._map_error(exc, model)
                raise mapped from exc

            elapsed_ms = int((time.perf_counter() - start) * 1000)
            if resp.candidates and resp.candidates[0].finish_reason is not None:
                call.finish_reason = resp.candidates[0].finish_reason.name
            call.usage = self._extract_usage(resp.usage_metadata)
            self._check_finish(resp, model)
            result = LLMResponse(
                content=self._visible_text(resp),
                raw_response=resp.model_dump() if hasattr(resp, "model_dump") else {"text": resp.text or ""},
                usage=self._extract_usage(resp.usage_metadata),
                model=model,
                provider=self.provider_name,
                duration_ms=elapsed_ms,
                finish_reason=resp.candidates[0].finish_reason.name if resp.candidates else "",
                success=True,
            )
            if request.json_output_schema is not None:
                reject_duplicate_json_keys(result.content)
            result = self._finalize_response(result, preserve_json_strings=request.json_output_schema is not None)
            call.result = result
            return result

    async def schema_generate(self, request: LLMRequest, schema: type[BaseModel]) -> LLMResponse:
        """通过 Gemini 的 response_schema 进行结构化 JSON 输出。

        将 Pydantic Schema 通过 generation_config 中的 response_mime_type
        和 response_schema 传入，获取符合 Schema 约束的 JSON 响应。
        """
        request = self._apply_defaults(request)
        model = self._resolve_model(request)
        with LLMCall(self.provider_name, model, "schema", schema=schema, use_system_proxy=self.config.use_system_proxy) as call:
            start = time.perf_counter()

            try:
                config = self._build_config(request)
                config.response_mime_type = "application/json"
                config.response_json_schema = schema.model_json_schema()

                resp = await self._generate_content(stream=request.stream,
                    model=model,
                    contents=self._build_contents(request),
                    config=config,
                )
                observe_provider_response(resp, self.config.resolved_api_mode)
            except LLMError:
                raise
            except Exception as exc:
                mapped = self._map_error(exc, model)
                raise mapped from exc

            elapsed_ms = int((time.perf_counter() - start) * 1000)
            if resp.candidates and resp.candidates[0].finish_reason is not None:
                call.finish_reason = resp.candidates[0].finish_reason.name
            call.usage = self._extract_usage(resp.usage_metadata)
            self._check_finish(resp, model)
            reject_duplicate_json_keys(self._visible_text(resp))
            text = self._sanitize_text_content(self._visible_text(resp), preserve_json_strings=True)

            # 验证返回的 JSON 能被 Schema 解析
            reject_duplicate_json_keys(text)
            try:
                parsed = schema.model_validate_json(text)
            except Exception as parse_exc:
                log_parse_error(parse_exc, content=text, schema=schema, message="Gemini 结构化输出校验失败")
                error = LLMSchemaError(
                    f"Gemini 返回内容无法解析为目标 Schema: {parse_exc}",
                    provider=self.provider_name,
                    model=model,
                )
                raise error from parse_exc

            result = LLMResponse(
                content=parsed.model_dump_json(),
                raw_response=resp.model_dump() if hasattr(resp, "model_dump") else {"text": text},
                usage=self._extract_usage(resp.usage_metadata),
                model=model,
                provider=self.provider_name,
                duration_ms=elapsed_ms,
                finish_reason=resp.candidates[0].finish_reason.name if resp.candidates else "",
                success=True,
            )
            result = self._finalize_response(result, preserve_json_strings=True)
            call.result = result
            return result

    async def stream_text(self, request: LLMRequest) -> AsyncGenerator[str, None]:
        """流式调用 Gemini API，逐块 yield 生成文本。"""
        # 流式入口统一标记请求语义，保证调试日志与实际 SDK 调用保持一致。
        request = self._apply_defaults(request).model_copy(update={"stream": True})
        model = self._resolve_model(request)
        with LLMCall(self.provider_name, model, "stream", use_system_proxy=self.config.use_system_proxy) as call:

            try:
                contents, config = self._build_contents(request), self._build_config(request)
                sent_contents, sent_config, cache_name = await self._with_explicit_cache(model, contents, config)
                try:
                    stream = await self._client.aio.models.generate_content_stream(
                        model=model, contents=sent_contents, config=sent_config)
                except Exception as exc:
                    # 流还没开始输出，缓存失效时可以安全地不带缓存重发。
                    if cache_name is None or not self._drop_explicit_cache(model, cache_name, exc):
                        raise
                    stream = await self._client.aio.models.generate_content_stream(
                        model=model, contents=contents, config=config)
                stream_filter = _ThinkStreamFilter(preserve_json_strings=request.json_output_schema is not None)
                async with aclosing(stream):
                    async for chunk in stream:
                        self._touch_stream()
                        observe_provider_response(chunk, self.config.resolved_api_mode)
                        call.chunk_count += 1
                        if chunk.usage_metadata is not None:
                            call.usage = self._extract_usage(chunk.usage_metadata)
                        if chunk.candidates and chunk.candidates[0].finish_reason is not None:
                            call.finish_reason = chunk.candidates[0].finish_reason.name
                        text = self._visible_text(chunk)
                        if text:
                            call.chunks.append(text)
                            clean_text = stream_filter.feed(text)
                            if clean_text:
                                yield clean_text
                if not call.finish_reason:
                    raise LLMConnectionError("Gemini 响应流提前断开，请重试", provider=self.provider_name, model=model)
                if call.finish_reason == "MAX_TOKENS":
                    raise LLMResponseError(
                        "模型输出达到长度上限，内容未完成", provider=self.provider_name, model=model,
                        partial_text="".join(call.chunks),
                    )
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

    def append_user_message(self, history: list[dict[str, Any]] | None, text: str) -> list[dict[str, Any]]:
        """Gemini 历史只接受 Content(parts=...)，不能混用 OpenAI 的 content 字符串。"""
        content = types.Content(role="user", parts=[types.Part(text=text)])
        return [*(history or []), content.model_dump(mode="json", exclude_none=True)]

    async def tool_turn(
        self, request: LLMRequest, tools: list[LLMToolDefinition], *,
        history: list[dict[str, Any]] | None = None,
        results: list[LLMToolResult] | None = None,
    ) -> LLMToolTurn:
        """执行 Gemini 原生工具对话，原样保存所有内容块及思考签名。

        Args:
            request: 固定的提示和参数。
            tools: 服务端工具白名单。
            history: 本客户端上一轮返回的 JSON 历史。
            results: 上轮全部调用的结果。
        Returns:
            本轮调用及可无损还原签名的原生历史。
        """
        request = self._apply_defaults(request)
        model = self._resolve_model(request)
        contents = [types.Content.model_validate(value) for value in history] if history is not None else self._build_contents(request)
        if results:
            # 安装的 SDK 工厂方法尚不接受 id，直接构建 FunctionResponse 保留调用配对。
            contents.append(types.Content(role="user", parts=[types.Part(function_response=types.FunctionResponse(
                id=result.id, name=result.name, response=result.content,
            )) for result in results]))
        config = self._build_config(request)
        config.response_mime_type = None
        config.response_json_schema = None
        config.tools = [types.Tool(function_declarations=[types.FunctionDeclaration(
            name=tool.name, description=tool.description, parameters_json_schema=tool.parameters,
        ) for tool in tools])]
        config.automatic_function_calling = types.AutomaticFunctionCallingConfig(disable=True)
        config.tool_config = types.ToolConfig(function_calling_config=types.FunctionCallingConfig(mode="AUTO"))
        try:
            response = await self._generate_content(stream=request.stream, model=model, contents=contents, config=config)
            observe_provider_response(response, self.config.resolved_api_mode)
            if not response.candidates or response.candidates[0].content is None:
                raise ValueError("工具对话没有返回候选")
            candidate = response.candidates[0]
            if candidate.finish_reason != types.FinishReason.STOP:
                raise LLMResponseError(f"Gemini 工具回复未完成：{candidate.finish_reason}，请检查输出上限或输入", provider=self.provider_name, model=model,
                                       truncated=candidate.finish_reason == types.FinishReason.MAX_TOKENS)
            contents.append(candidate.content)
            calls = [LLMToolCall(id=part.function_call.id, name=part.function_call.name,
                                 arguments=dict(part.function_call.args or {}))
                     for part in candidate.content.parts or [] if part.function_call is not None]
            text = "".join(part.text for part in candidate.content.parts or [] if part.text and not part.thought)
            return LLMToolTurn(content=self._sanitize_text_content(text), calls=calls,
                               history=[value.model_dump(mode="json", exclude_none=True) for value in contents],
                               usage=self._extract_usage(response.usage_metadata),
                               finish_reason=str(candidate.finish_reason or ""))
        except LLMError:
            raise
        except Exception as exc:
            raise self._map_error(exc, model) from exc

    async def web_search(self, request: LLMRequest) -> LLMWebSearchResult:
        """用 Google 搜索接地回答一个问题，来源取自 grounding_metadata。

        Args:
            request: 搜索问题；不流式。
        Returns:
            回答、来源和用量。
        """
        request = self._apply_defaults(request).model_copy(update={"stream": False})
        model = self._resolve_model(request)
        config = self._build_config(request)
        config.response_mime_type = None
        config.response_json_schema = None
        config.tools = [types.Tool(google_search=types.GoogleSearch())]
        try:
            response = await self._generate_content(stream=False, model=model, contents=self._build_contents(request), config=config)
            observe_provider_response(response, self.config.resolved_api_mode)
            self._check_finish(response, model)
            metadata = response.candidates[0].grounding_metadata if response.candidates else None
            sources = collect_web_sources(metadata.model_dump(mode="json", exclude_none=True)) if metadata else []
            return LLMWebSearchResult(content=self._sanitize_text_content(self._visible_text(response)), sources=sources,
                                      usage=self._extract_usage(response.usage_metadata))
        except LLMError:
            raise
        except Exception as exc:
            raise self._map_error(exc, model) from exc

    async def function_call_probe(
        self,
        request: LLMRequest,
        probe: LLMFunctionCallProbe,
    ) -> LLMResponse:
        """执行 Gemini Function Calling 两轮探测。

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
            tool = types.Tool(
                function_declarations=[
                    types.FunctionDeclaration(
                        name=probe.tool_name,
                        description=probe.tool_description,
                        parameters_json_schema=probe.parameters_schema,
                    )
                ]
            )

            try:
                config = self._build_config(request)
                config.tools = [tool]
                config.tool_config = types.ToolConfig(
                    function_calling_config=types.FunctionCallingConfig(
                        mode=types.FunctionCallingConfigMode.ANY,
                        allowed_function_names=[probe.tool_name],
                    )
                )
                contents = self._build_contents(request)
                first_resp = await self._generate_content(stream=request.stream,
                    model=model,
                    contents=contents,
                    config=config,
                )
                observe_provider_response(first_resp, self.config.resolved_api_mode)
                first_content = first_resp.candidates[0].content if first_resp.candidates else None
                function_call = None
                for part in getattr(first_content, "parts", []) or []:
                    if getattr(part, "function_call", None) and part.function_call.name == probe.tool_name:
                        function_call = part.function_call
                        break
                if function_call is None:
                    raise ValueError("模型未返回指定工具调用")

                actual_args = dict(function_call.args or {})
                self._validate_probe_arguments(actual_args, probe.expected_arguments)

                # Gemini 需要把模型上一轮 content 与本地 function response 一起带回上下文。
                final_contents = list(contents)
                final_contents.append(first_content)
                final_contents.append(
                    types.Content(
                        role="user",
                        parts=[
                            types.Part(function_response=types.FunctionResponse(
                                id=function_call.id, name=probe.tool_name,
                                response=probe.tool_result,
                            )),
                            types.Part(text=probe.final_response_prompt),
                        ],
                    )
                )
                final_config = self._build_config(request)
                final_config.tools = [tool]
                final_resp = await self._generate_content(stream=request.stream,
                    model=model,
                    contents=final_contents,
                    config=final_config,
                )
                observe_provider_response(final_resp, self.config.resolved_api_mode)
            except LLMError:
                raise
            except Exception as exc:
                mapped = self._map_error(exc, model)
                raise mapped from exc

            elapsed_ms = int((time.perf_counter() - start) * 1000)
            content = self._sanitize_text_content(self._visible_text(final_resp))
            try:
                self._validate_probe_final_text(content, probe.expected_final_text)
            except ValueError as exc:
                mapped = LLMResponseError(str(exc), provider=self.provider_name, model=model)
                raise mapped from exc

            first_usage = self._extract_usage(first_resp.usage_metadata)
            final_usage = self._extract_usage(final_resp.usage_metadata)
            result = LLMResponse(
                content=content,
                raw_response={
                    "tool_call": first_resp.model_dump() if hasattr(first_resp, "model_dump") else None,
                    "final": final_resp.model_dump() if hasattr(final_resp, "model_dump") else None,
                },
                usage=first_usage.plus(final_usage),
                model=model,
                provider=self.provider_name,
                duration_ms=elapsed_ms,
                finish_reason=final_resp.candidates[0].finish_reason.name if final_resp.candidates else "",
                success=True,
            )
            result = self._finalize_response(result)
            call.result = result
            return result
