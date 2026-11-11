"""LLM 模块公共接口。

三个模型客户端各自依赖体积很大的官方 SDK（anthropic、openai、google-genai），一起加载要十几秒。
它们只在真正调用对应服务时才需要，所以这里按需加载：``from backend.llm import ClaudeClient``
等写法保持不变，但只有用到时才会加载对应的 SDK，后端启动因此快很多。
"""

from importlib import import_module
from typing import TYPE_CHECKING

from backend.llm.base_client import BaseLLMClient
from backend.llm.config import LLMConfig, LLMProviderConfig, get_llm_config, get_provider_config
from backend.llm.exceptions import (
    LLMAuthError,
    LLMError,
    LLMRateLimitError,
    LLMResponseError,
    LLMSchemaError,
    LLMTimeoutError,
)
from backend.llm.factory import create_llm_client
from backend.llm.models import LLMRequest, LLMResponse, TokenUsage

if TYPE_CHECKING:  # 仅供类型检查和编辑器跳转使用，运行时不加载
    from backend.llm.claude_client import ClaudeClient
    from backend.llm.gemini_client import GeminiClient
    from backend.llm.openai_client import OpenAICompatibleClient

# 公开名称 → 所在模块；首次访问时才加载
_LAZY_EXPORTS = {
    "OpenAICompatibleClient": "backend.llm.openai_client",
    "GeminiClient": "backend.llm.gemini_client",
    "ClaudeClient": "backend.llm.claude_client",
}


def __getattr__(name: str):
    module = _LAZY_EXPORTS.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(import_module(module), name)
    globals()[name] = value  # 下次直接命中，不再经过这里
    return value


def __dir__() -> list[str]:
    return sorted(set(globals()) | set(_LAZY_EXPORTS))


__all__ = [
    "BaseLLMClient",
    "OpenAICompatibleClient",
    "GeminiClient",
    "ClaudeClient",
    "LLMConfig",
    "LLMProviderConfig",
    "LLMRequest",
    "LLMResponse",
    "TokenUsage",
    "LLMError",
    "LLMAuthError",
    "LLMRateLimitError",
    "LLMTimeoutError",
    "LLMResponseError",
    "LLMSchemaError",
    "create_llm_client",
    "get_llm_config",
    "get_provider_config",
]
