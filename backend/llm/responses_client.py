"""OpenAI 与 DeepSeek 的 Responses 接口，完整保留工具对话的思考续接信息。"""

from __future__ import annotations

import json
import time
from copy import deepcopy
from typing import Any, AsyncGenerator

import openai
from pydantic import BaseModel, ValidationError

from backend.llm.base_client import _ThinkStreamFilter
from backend.llm.exceptions import LLMConnectionError
from backend.llm.exceptions import LLMError, LLMResponseError, LLMSchemaError
from backend.llm.provider_probe import observe_provider_response
from backend.llm.logger import LLMCall
from backend.llm.json_guard import reject_duplicate_json_keys
from backend.llm.models import LLMFunctionCallProbe, LLMRequest, LLMResponse, LLMToolCall, LLMToolDefinition, LLMToolResult, LLMToolTurn, TokenUsage, LLMWebSearchResult, collect_web_sources
from backend.llm.openai_client import OpenAICompatibleClient, build_openai_parameters
from backend.llm.prompt_cache import cache_usage, token_count


class ResponsesClient(OpenAICompatibleClient):
    """复用 OpenAI SDK 连接配置，通过 Responses 生成文本、JSON 与工具调用。"""

    # Responses API 的流事件结构不同，这里不提供实时片段；工具步骤仍可按普通流式请求收齐。
    live_stream = False

    def _build_params(self, request: LLMRequest, *, function_calling: bool = False,
                      schema: type[BaseModel] | None = None) -> dict[str, Any]:
        return build_openai_parameters(request, self.config, schema=schema,
                                       function_calling=function_calling, api_mode="responses")

    @staticmethod
    def _extract_usage(usage: Any) -> TokenUsage:
        if usage is None:
            return TokenUsage()
        # 命中缓存的部分已包含在 input_tokens 里，单独记下供计费。
        read, write = cache_usage(usage)
        input_t = token_count(usage, "input_tokens", "prompt_tokens")
        output_t = token_count(usage, "output_tokens", "completion_tokens")
        return TokenUsage(input_tokens=input_t, output_tokens=output_t,
                          total_tokens=token_count(usage, "total_tokens") or input_t + output_t,
                          cache_read_tokens=read, cache_write_tokens=write)

    async def _open_response(self, params: dict[str, Any], *, stream: bool) -> Any:
        params = self._send_params(params)
        for attempt in range(3):
            try:
                return await self._client.responses.create(**params, **({"stream": True} if stream else {}))
            except (openai.BadRequestError, openai.UnprocessableEntityError) as exc:
                adjusted = self._cache_fallback(params, exc) if attempt < 2 else None
                if adjusted is None:
                    raise
                params = adjusted

    def _check_response(self, response: Any, model: str, *, partial_text: str | None = None) -> None:
        """拒绝截断、失败和拒答结果，避免把半段生成内容当成成功。

        Args:
            response: Responses 的完整结果。
            model: 当前模型。
            partial_text: 普通正文生成时传入已生成的正文；达到输出上限时随错误带回，与其他接口一致。
        """
        if response.status == "incomplete":
            reason = getattr(response.incomplete_details, "reason", "")
            if partial_text is not None and reason == "max_output_tokens":
                raise LLMResponseError("模型输出达到长度上限，内容未完成", provider=self.provider_name, model=model,
                                       partial_text=partial_text)
            raise LLMSchemaError(f"模型输出未完成（{reason}），请增加输出上限或调整输入", provider=self.provider_name, model=model)
        if response.status != "completed":
            message = getattr(response.error, "message", None) or f"模型请求未完成：{response.status}"
            raise LLMResponseError(message, provider=self.provider_name, model=model)
        for item in response.output:
            if item.type == "message":
                for part in item.content:
                    if part.type == "refusal":
                        raise LLMResponseError(part.refusal, provider=self.provider_name, model=model)

    async def _create_response(self, params: dict[str, Any], *, stream: bool) -> Any:
        """取得 Responses 的完整结果，流式结果以终止事件为准。

        Args:
            params: 现有构建器生成的请求参数。
            stream: 是否使用流式请求。
        Returns:
            包含全部 output 项的 SDK 响应。
        """
        if not stream:
            return await self._open_response(params, stream=False)
        response = None
        events = await self._open_response(params, stream=True)
        async with events:
            async for event in events:
                self._touch_stream()
                observe_provider_response(event, self.config.resolved_api_mode)
                if event.type in {"response.completed", "response.incomplete", "response.failed"}:
                    response = event.response
                elif event.type == "error":
                    raise LLMResponseError(event.message, provider=self.provider_name)
        if response is None:
            raise LLMConnectionError("Responses 响应流提前断开，请重试", provider=self.provider_name)
        return response

    async def _generate(self, request: LLMRequest, schema: type[BaseModel] | None = None) -> LLMResponse:
        request = self._apply_defaults(request)
        model = self._resolve_model(request)
        with LLMCall(self.provider_name, model, "schema" if schema else "text", schema=schema,
                     use_system_proxy=self.config.use_system_proxy) as call:
            start = time.perf_counter()
            try:
                response = await self._create_response(self._build_params(request, schema=schema), stream=request.stream)
                observe_provider_response(response, self.config.resolved_api_mode)
                self._check_response(response, model, partial_text=None if schema is not None else response.output_text)
                content = response.output_text
                if schema is not None or request.json_output_schema is not None:
                    reject_duplicate_json_keys(content)
                if schema is not None:
                    try:
                        content = schema.model_validate_json(content).model_dump_json()
                    except ValidationError as exc:
                        raise LLMSchemaError("模型返回的 JSON 不符合目标结构", provider=self.provider_name, model=model) from exc
                result = self._finalize_response(LLMResponse(
                    content=content, raw_response=response.model_dump(mode="json", warnings=False),
                    usage=self._extract_usage(response.usage), model=response.model or model,
                    provider=self.provider_name, duration_ms=int((time.perf_counter() - start) * 1000),
                    finish_reason=response.status,
                ), preserve_json_strings=schema is not None or request.json_output_schema is not None)
                call.result = result
                return result
            except LLMError:
                raise
            except Exception as exc:
                raise self._map_error(exc, model) from exc

    async def text_generate(self, request: LLMRequest) -> LLMResponse:
        """生成正文。

        Args:
            request: 消息和可选生成参数。
        Returns:
            正文、原始响应及用量。
        """
        return await self._generate(request)

    async def schema_generate(self, request: LLMRequest, schema: type[BaseModel]) -> LLMResponse:
        """用 text.format 约束结果，并执行本地完整校验。

        Args:
            request: 消息和可选生成参数。
            schema: 业务需要的输出结构。
        Returns:
            已校验的 JSON 和用量。
        """
        return await self._generate(request, schema)

    async def stream_text(self, request: LLMRequest) -> AsyncGenerator[str, None]:
        """只转发正文增量，思考信息留在服务端。

        Args:
            request: 消息和可选生成参数。
        Yields:
            正文片段；流中失败或截断时抛出错误。
        """
        request = self._apply_defaults(request)
        model = self._resolve_model(request)
        with LLMCall(self.provider_name, model, "stream", use_system_proxy=self.config.use_system_proxy) as call:
            finished = False
            stream_filter = _ThinkStreamFilter(preserve_json_strings=request.json_output_schema is not None)
            try:
                stream = await self._open_response(self._build_params(request), stream=True)
                async with stream:
                    async for event in stream:
                        self._touch_stream()
                        observe_provider_response(event, self.config.resolved_api_mode)
                        call.chunk_count += 1
                        if event.type == "response.output_text.delta":
                            call.chunks.append(event.delta)
                            text = stream_filter.feed(event.delta)
                            if text:
                                yield text
                        elif event.type in {"response.completed", "response.incomplete", "response.failed"}:
                            call.usage = self._extract_usage(event.response.usage)
                            call.finish_reason = event.response.status
                            self._check_response(event.response, model, partial_text="".join(call.chunks))
                            finished = True
                        elif event.type == "error":
                            raise LLMResponseError(event.message, provider=self.provider_name, model=model)
                if not finished:
                    raise LLMConnectionError("响应流提前断开，请重试", provider=self.provider_name, model=model)
                if request.json_output_schema is not None:
                    reject_duplicate_json_keys("".join(call.chunks))
                tail = stream_filter.finish()
                if tail:
                    yield tail
            except LLMError:
                raise
            except Exception as exc:
                raise self._map_error(exc, model) from exc

    def append_user_message(self, history: list[dict[str, Any]] | None, text: str) -> list[dict[str, Any]]:
        """Responses 的输入文字使用 input_text 块，而不是 Chat Completions 的字符串。"""
        return [*(history or []), {"role": "user", "content": [{"type": "input_text", "text": text}]}]

    async def tool_turn(self, request: LLMRequest, tools: list[LLMToolDefinition], *,
                        history: list[dict[str, Any]] | None = None,
                        results: list[LLMToolResult] | None = None) -> LLMToolTurn:
        """执行一轮工具对话，回传所有原生 output 项以保留推理和调用 ID。

        Args:
            request: 本轮固定提示与生成参数。
            tools: 允许调用的工具。
            history: 上一轮完整 input 和 output。
            results: 上一轮全部工具结果。
        Returns:
            正文、工具调用、用量与可供续接的私有历史。
        """
        request = self._apply_defaults(request)
        model = self._resolve_model(request)
        try:
            params = self._build_params(request, function_calling=True)
            if "text" in params:
                params["text"].pop("format", None)
            messages = deepcopy(history) if history is not None else params["input"]
            messages.extend({"type": "function_call_output", "call_id": result.id,
                             "output": json.dumps(result.content, ensure_ascii=False)} for result in results or [])
            params.update(input=messages, tool_choice="auto", tools=[
                {"type": "function", **tool.model_dump(), **({} if self.config.is_deepseek else {"strict": False})}
                for tool in tools
            ])
            response = await self._create_response(params, stream=request.stream)
            observe_provider_response(response, self.config.resolved_api_mode)
            self._check_response(response, model)
            messages.extend(item.model_dump(mode="json", exclude_none=True, warnings=False) for item in response.output)
            calls = []
            for item in response.output:
                if item.type == "function_call":
                    reject_duplicate_json_keys(item.arguments)
                    calls.append(LLMToolCall(id=item.call_id, name=item.name, arguments=json.loads(item.arguments)))
            return LLMToolTurn(content=self._sanitize_text_content(response.output_text), calls=calls,
                               history=messages, usage=self._extract_usage(response.usage), finish_reason=response.status)
        except LLMError:
            raise
        except Exception as exc:
            raise self._map_error(exc, model) from exc

    async def web_search(self, request: LLMRequest) -> LLMWebSearchResult:
        """用 Responses 的内置 web_search 工具回答一个问题。

        Args:
            request: 搜索问题；不流式。
        Returns:
            回答、url_citation 等来源和用量。
        """
        if self.config.is_deepseek:
            return await super().web_search(request)
        request = self._apply_defaults(request).model_copy(update={"stream": False})
        model = self._resolve_model(request)
        try:
            params = self._build_params(request)
            if "text" in params:
                params["text"].pop("format", None)
            params.update(tools=[{"type": "web_search"}], tool_choice="auto")
            response = await self._create_response(params, stream=False)
            observe_provider_response(response, self.config.resolved_api_mode)
            self._check_response(response, model)
            sources = collect_web_sources([item.model_dump(mode="json", exclude_none=True, warnings=False) for item in response.output])
            return LLMWebSearchResult(content=self._sanitize_text_content(response.output_text or ""), sources=sources,
                                      usage=self._extract_usage(response.usage))
        except LLMError:
            raise
        except Exception as exc:
            raise self._map_error(exc, model) from exc

    async def function_call_probe(self, request: LLMRequest, probe: LLMFunctionCallProbe) -> LLMResponse:
        """沿用正式工具调用路径测试两轮对话，不临时关闭推理。

        Args:
            request: 触发工具的提示。
            probe: 期望参数和模拟工具结果。
        Returns:
            两轮总用量与最终回复。
        """
        model = self._resolve_model(request)
        with LLMCall(self.provider_name, model, "function_call", use_system_proxy=self.config.use_system_proxy) as call:
            start = time.perf_counter()
            tools = [LLMToolDefinition(name=probe.tool_name, description=probe.tool_description, parameters=probe.parameters_schema)]
            first = await self.tool_turn(request, tools)
            if not first.calls or any(item.name != probe.tool_name for item in first.calls):
                raise LLMResponseError("模型未返回指定工具调用", provider=self.provider_name, model=model)
            for item in first.calls:
                self._validate_probe_arguments(item.arguments, probe.expected_arguments)
            # 提示放入工具结果，下一轮必须先收到所有调用的返回值。
            results = [LLMToolResult(id=item.id, name=item.name,
                                    content={**probe.tool_result, "next_instruction": probe.final_response_prompt}) for item in first.calls]
            final = await self.tool_turn(request, tools, history=first.history, results=results)
            self._validate_probe_final_text(final.content, probe.expected_final_text)
            result = LLMResponse(content=final.content, model=model, provider=self.provider_name,
                                 raw_response={"history": final.history}, finish_reason=final.finish_reason,
                                 duration_ms=int((time.perf_counter() - start) * 1000),
                                 usage=first.usage.plus(final.usage))
            call.result = result
            return result
