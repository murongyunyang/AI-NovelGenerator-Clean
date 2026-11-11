"""LLM 客户端抽象基类，定义统一的生成接口。"""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from typing import Any, AsyncGenerator

from pydantic import BaseModel

from backend.llm.config import LLMProviderConfig
from backend.llm.generation_options import REASONING_FIELDS
from backend.llm.models import LLMFunctionCallProbe, LLMRequest, LLMResponse, LLMToolDefinition, LLMToolResult, LLMToolTurn, LLMWebSearchResult


_THINK_TAGS = ("think", "thinking", "analysis", "reasoning")
_THINK_OPEN_RE = re.compile(r"<(?:think|thinking|analysis|reasoning)\b[^>]*>", re.IGNORECASE)
_THINK_CLOSE_RE = re.compile(r"</(?:think|thinking|analysis|reasoning)\s*>", re.IGNORECASE)
# 只规定思考和过程说明的语言，不改变各请求要求的输出格式（JSON、正文等）。
CHINESE_THINKING_RULE = "语言要求：你的内部思考、推理过程，以及调用工具前后的简短说明，一律使用简体中文，不要用英文思考。这条只规定语言，不改变上文要求的输出格式。"


def apply_request_defaults(request: LLMRequest, config: LLMProviderConfig) -> LLMRequest:
    """补齐模型服务的默认生成参数，不创建客户端。

    Args:
        request: 节点或业务已构建的请求。
        config: 模型服务配置；本函数只使用生成参数。
    Returns:
        补齐默认值后的请求，原请求保持不变。
    """
    overrides = {}
    # 单次请求改变思考方式时，不带入与新方式冲突的 Provider 默认值。
    skip_defaults = set()
    if request.thinking_mode == "disabled":
        skip_defaults.update({"reasoning_effort", "thinking_budget"})
    if request.thinking_mode == "enabled" and config.reasoning_effort == "none":
        skip_defaults.add("reasoning_effort")
    if request.thinking_budget is not None:
        skip_defaults.update({"reasoning_effort", "thinking_mode"})
    if request.reasoning_effort is not None:
        skip_defaults.add("thinking_budget")
        if (config.thinking_mode == "disabled" or request.reasoning_effort == "none"
                or (config.type == "claude" and config.thinking_mode == "enabled")):
            skip_defaults.add("thinking_mode")
    if request.thinking_mode in {"adaptive", "between_tools"}:
        skip_defaults.add("thinking_budget")
    for field in ("temperature", "top_p", "max_tokens", "presence_penalty", "frequency_penalty", *REASONING_FIELDS):
        if field not in skip_defaults and getattr(request, field) is None and getattr(config, field) is not None:
            overrides[field] = getattr(config, field)
    system_prompt = overrides.get("system_prompt", request.system_prompt) or config.system_prompt or ""
    # 所有模型调用都经过这里：总控、子智能体、写手、审稿都按同一规则用中文思考。
    if CHINESE_THINKING_RULE not in system_prompt:
        overrides["system_prompt"] = (system_prompt + "\n\n" if system_prompt else "") + CHINESE_THINKING_RULE
    return request.model_copy(update=overrides) if overrides else request


def build_request_messages(request: LLMRequest) -> list[dict[str, str]]:
    """合并系统提示与对话消息，供正式请求和模拟查看共同使用。

    Args:
        request: 已渲染并补齐默认值的请求。
    Returns:
        完整消息列表。
    """
    messages = [{"role": "system", "content": request.system_prompt}] if request.system_prompt else []
    return [*messages, *request.messages]


class _ThinkStreamFilter:
    """跨片段过滤显式思考标签；JSON 字符串内的作品内容保持原样。"""

    def __init__(self, *, preserve_json_strings: bool = False) -> None:
        self._buffer = ""
        self._inside_think = False
        self._think_depth = 0
        self._preserve_json_strings = preserve_json_strings
        self._inside_json_string = False
        self._json_escaped = False

    def feed(self, chunk: str) -> str:
        if not chunk:
            return ""

        self._buffer += chunk
        output_parts: list[str] = []

        while self._buffer:
            if self._inside_think:
                open_match = _THINK_OPEN_RE.search(self._buffer)
                close_match = _THINK_CLOSE_RE.search(self._buffer)
                if open_match and (close_match is None or open_match.start() < close_match.start()):
                    self._buffer = self._buffer[open_match.end():]
                    self._think_depth += 1
                    continue
                if close_match:
                    self._buffer = self._buffer[close_match.end():]
                    self._think_depth -= 1
                    self._inside_think = self._think_depth > 0
                    continue
                # 保留跨片段的标签（包括属性），正文中的思考内容立即丢弃。
                candidates = [m.start() for m in re.finditer("<", self._buffer)
                              if self._is_potential_think_prefix(self._buffer[m.start():])]
                self._buffer = self._buffer[min(candidates):] if candidates else ""
                break

            if self._inside_json_string:
                # JSON 字符串里的标签是字段内容；转义状态需要跨片段保留。
                position = 0
                for character in self._buffer:
                    position += 1
                    if self._json_escaped:
                        self._json_escaped = False
                    elif character == "\\":
                        self._json_escaped = True
                    elif character == '"':
                        self._inside_json_string = False
                        break
                output_parts.append(self._buffer[:position])
                self._buffer = self._buffer[position:]
                continue

            open_match = _THINK_OPEN_RE.search(self._buffer)
            close_match = _THINK_CLOSE_RE.search(self._buffer)
            tag_match = open_match
            if close_match is not None and (open_match is None or close_match.start() < open_match.start()):
                tag_match = close_match
            quote = self._buffer.find('"') if self._preserve_json_strings else -1
            # 未收完的标签可能含属性引号，必须等标签结束后再判断 JSON 字符串。
            if 0 <= quote < self._safe_emit_length(self._buffer) and (tag_match is None or quote < tag_match.start()):
                output_parts.append(self._buffer[:quote + 1])
                self._buffer = self._buffer[quote + 1:]
                self._inside_json_string = True
                continue
            if tag_match:
                if tag_match.start() > 0:
                    output_parts.append(self._buffer[:tag_match.start()])
                self._buffer = self._buffer[tag_match.end():]
                self._inside_think = tag_match is open_match
                self._think_depth = 1 if self._inside_think else 0
                continue

            safe_length = self._safe_emit_length(self._buffer)
            if safe_length <= 0:
                break
            output_parts.append(self._buffer[:safe_length])
            self._buffer = self._buffer[safe_length:]

        return "".join(output_parts)

    def finish(self) -> str:
        if self._inside_think:
            return ""
        if self._is_potential_think_prefix(self._buffer):
            return ""
        return self._buffer

    def _safe_emit_length(self, text: str) -> int:
        if not self._preserve_json_strings:
            last_lt = text.rfind("<")
            return last_lt if last_lt >= 0 and self._is_potential_think_prefix(text[last_lt:]) else len(text)
        for marker in re.finditer("<", text):
            if self._is_potential_think_prefix(text[marker.start():]):
                return marker.start()
        return len(text)

    @staticmethod
    def _is_potential_think_prefix(text: str) -> bool:
        lowered = text.lower()

        for tag in _THINK_TAGS:
            for prefix in (f"<{tag}", f"</{tag}"):
                if prefix.startswith(lowered):
                    return True
                if lowered.startswith(prefix):
                    suffix = lowered[len(prefix):]
                    if not suffix or not (suffix[0].isalnum() or suffix[0] == "_"):
                        return True
        return False


class _BeforeSendError(Exception):
    """只穿过 SDK 的校验失败，适配器必须还原原异常。"""

    def __init__(self, original: Exception) -> None:
        self.original = original
        super().__init__(str(original))


class BaseLLMClient(ABC):
    """所有 LLM 服务商客户端的抽象基类。

    子类需实现 text_generate / schema_generate / stream_text 三个核心方法。
    """

    # 工具对话的流式请求是否会通过 backend.llm.live 报告思考、说明文字和工具参数的实时片段。
    live_stream = False

    def __init__(self, config: LLMProviderConfig, provider_name: str = "") -> None:
        self.config = config
        self.provider_name = provider_name
        self.before_send: Callable[[], Awaitable[Any]] | None = None

    @staticmethod
    def _touch_stream() -> None:
        """收到真实流事件时更新静默计时，含思考和无可见正文的事件。"""
        from backend.llm.usage import usage_meter
        meter = usage_meter.get()
        if meter is not None:
            meter.touch()

    async def _before_http_request(self, request: Any) -> None:
        """每次真正发送前复验本次调用者的读取，包括 SDK 内部重试。

        Args:
            request: HTTP 客户端即将发送的请求，不修改请求内容。
        Returns:
            无；校验失败由适配器原样交还业务层。
        """
        if self.before_send is not None:
            try:
                await self.before_send()
            except Exception as exc:
                # 校验可能因数据库暂不可用失败，也不能让 SDK 当网络错误重发。
                raise _BeforeSendError(exc) from None

    async def aclose(self) -> None:
        """关闭本客户端自建的 HTTP 连接池；临时客户端（接口测试、单次任务）用完必须调用。"""
        http_client = getattr(self, "_http_client", None)
        if http_client is not None:
            await http_client.aclose()

    @staticmethod
    def _transport_error(exc: BaseException, **kwargs: Any) -> Exception | None:
        """把流读取途中直接抛出的底层断线异常归为可重试的连接错误；不是断线时返回 None。

        SDK 只包装发请求阶段的网络错误，流式读取中途断开时会直接抛出 httpx 的异常。
        读取超时不在这里处理，保持各客户端原有分类（智能体据此决定是否改用普通请求）。
        """
        import httpx2

        from backend.llm.exceptions import LLMConnectionError

        current: BaseException | None = exc
        seen: set[int] = set()
        while current is not None and id(current) not in seen:
            seen.add(id(current))
            if isinstance(current, httpx2.TimeoutException):
                return None
            if isinstance(current, httpx2.TransportError):
                return LLMConnectionError(str(exc) or type(current).__name__, **kwargs)
            current = current.__cause__ or current.__context__
        return None

    def _resolve_model(self, request: LLMRequest) -> str:
        """确定实际使用的模型名称，请求未指定时回退到服务商默认模型。"""
        return request.model or self.config.default_model

    def _apply_defaults(self, request: LLMRequest) -> LLMRequest:
        """将服务商配置中的生成参数默认值合并到请求中（请求级别优先）。"""
        return apply_request_defaults(request, self.config)

    def _build_messages(self, request: LLMRequest) -> list[dict[str, str]]:
        """将 system_prompt 与 messages 合并为完整消息列表。"""
        return build_request_messages(request)

    @staticmethod
    def _sanitize_text_content(text: str, *, preserve_json_strings: bool = False) -> str:
        """移除思考块，JSON 请求保留字段字符串里的标签。

        Args:
            text: 尚未过滤的模型正文。
            preserve_json_strings: 是否把 JSON 字符串中的标签当作字段内容。
        Returns:
            已过滤思考块的正文。
        """
        if not text:
            return text
        stream_filter = _ThinkStreamFilter(preserve_json_strings=preserve_json_strings)
        sanitized = stream_filter.feed(text) + stream_filter.finish()
        if sanitized != text:
            return sanitized.strip()
        return sanitized

    def _finalize_response(self, response: LLMResponse, *, preserve_json_strings: bool = False) -> LLMResponse:
        """只过滤业务正文，raw_response 保留服务商原始内容。

        Args:
            response: 尚未处理的统一响应。
            preserve_json_strings: JSON 请求保留字段字符串里的标签。

        Returns:
            业务正文已过滤、原始响应完整保留的对象。
        """
        clean_content = self._sanitize_text_content(response.content, preserve_json_strings=preserve_json_strings)
        if clean_content == response.content:
            return response
        return response.model_copy(update={"content": clean_content})

    def _validate_probe_arguments(
        self,
        actual_arguments: dict[str, Any],
        expected_arguments: dict[str, Any],
    ) -> None:
        """校验 Function Calling 探测返回的工具参数。

        Args:
            actual_arguments: 模型实际生成的工具参数。
            expected_arguments: 探测流程要求的工具参数。

        Returns:
            无。

        Raises:
            ValueError: 参数缺失或值不一致时抛出。
        """
        for key, expected_value in expected_arguments.items():
            if actual_arguments.get(key) != expected_value:
                raise ValueError(f"工具参数不匹配: {key}")

    def _validate_probe_final_text(self, content: str, expected_final_text: str) -> None:
        """校验 Function Calling 二轮结果是否包含约定文本。

        Args:
            content: 模型第二轮最终回复文本。
            expected_final_text: 必须出现在回复中的约定文本。

        Returns:
            无。

        Raises:
            ValueError: 回复为空或未包含约定文本时抛出。
        """
        if expected_final_text not in content:
            raise ValueError("工具结果二轮回复未包含约定文本")

    @abstractmethod
    async def text_generate(self, request: LLMRequest) -> LLMResponse:
        """普通文本生成。"""

    @abstractmethod
    async def schema_generate(
        self, request: LLMRequest, schema: type[BaseModel]
    ) -> LLMResponse:
        """结构化 JSON 输出，按 Pydantic Schema 约束生成。"""

    @abstractmethod
    async def stream_text(self, request: LLMRequest) -> AsyncGenerator[str, None]:
        """流式文本输出，逐块 yield 生成内容。"""

    @abstractmethod
    async def function_call_probe(
        self,
        request: LLMRequest,
        probe: LLMFunctionCallProbe,
    ) -> LLMResponse:
        """Function Calling 探测，要求模型调用工具并完成工具结果二轮回复。"""

    def append_user_message(self, history: list[dict[str, Any]] | None, text: str) -> list[dict[str, Any]]:
        """向当前供应商的原生工具历史追加作者提醒，默认用于 OpenAI/Claude 消息格式。"""
        messages = list(history or [])
        return [*messages, {"role": "user", "content": text}]

    async def tool_turn(
        self, request: LLMRequest, tools: list[LLMToolDefinition], *,
        history: list[dict[str, Any]] | None = None,
        results: list[LLMToolResult] | None = None,
    ) -> LLMToolTurn:
        """执行一轮原生工具对话，具体客户端必须保留完整续接信息。

        Args:
            request: 固定的初始提示与生成参数。
            tools: 允许模型调用的工具定义。
            history: 上轮客户端返回的原生历史。
            results: 对上轮全部工具调用的执行结果。
        Returns:
            本轮调用和仅供服务端续接的历史。
        """
        raise NotImplementedError("当前模型客户端不支持正式工具调用")

    async def web_search(self, request: LLMRequest) -> LLMWebSearchResult:
        """用模型自带的联网搜索回答一个问题，单独一次请求，不夹带业务工具。

        Args:
            request: 搜索问题与生成参数，不流式。
        Returns:
            回答正文、来源链接和用量。
        """
        raise NotImplementedError("当前模型接口没有自带的联网搜索")
