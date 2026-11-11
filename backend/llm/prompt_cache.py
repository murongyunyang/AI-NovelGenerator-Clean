"""按上游协议放置提示缓存断点；只修改发送副本，不修改对话历史。"""

from __future__ import annotations

import re
import logging
import time
from copy import deepcopy
from typing import Any


def cache_rejected(client: Any, model: Any, *, key: bool = False) -> bool:
    """中转可能轮换上游；拒绝结果只保留五分钟，不能永久停用缓存。"""
    attr = "_cache_key_rejected" if key else "_cache_rejected"
    deadlines = getattr(client, attr, {})
    deadline = deadlines.get(model, 0)
    if deadline > time.monotonic():
        return True
    deadlines.pop(model, None)
    return False


def remember_cache_rejection(client: Any, model: Any, *, key: bool = False) -> None:
    attr = "_cache_key_rejected" if key else "_cache_rejected"
    deadlines = getattr(client, attr, {})
    deadlines[model] = time.monotonic() + 300
    setattr(client, attr, deadlines)
    logging.getLogger("llm").warning(
        "上游拒绝%s，暂时回退，五分钟后重新尝试；缓存优惠可能受影响。provider=%s model=%s",
        "缓存路由键" if key else "缓存断点", getattr(client, "provider_name", ""), model,
    )


def modern_openai_model(model: str) -> bool:
    # 网关常用显示名作真实 ID（例如 GPT-6.1 Sol）；只用于识别，不改发送的模型名。
    name = re.sub(r"[\s_]+", "-", model.rsplit("/", 1)[-1].strip().lower())
    match = re.match(r"gpt-(\d+)(?:\.(\d+))?(?:-|$)", name)
    return bool(match and (int(match[1]) >= 6 or (int(match[1]) == 5 and int(match[2] or 0) >= 6)))


def with_openai_breakpoints(params: dict[str, Any]) -> dict[str, Any]:
    """保留隐式缓存，并在稳定指令、初始上下文和最新消息边界设置最多三个断点。"""
    sent = deepcopy(params)
    responses = "input" in sent
    items = sent.get("input" if responses else "messages")
    if not isinstance(items, list):
        return sent
    # 系统指令要独立缓存：只缓存整个动态请求时，下一次换任务不会命中这段稳定前缀。
    system_count = 0
    for item in items:
        if item.get("role") not in {"system", "developer"}:
            break
        system_count += 1
    stable = [system_count - 1] if system_count else []
    # 工具循环会反复发送首条书籍资料/任务上下文；给它单独留一个断点，避免长历史只命中系统提示。
    initial = [system_count] if len(items) > system_count and items[system_count].get("role") == "user" else []
    recent = [index for index, item in enumerate(items)
              if item.get("role") in {"user", "tool"} or item.get("type") == "function_call_output"][-1:]
    marked = False
    for index in dict.fromkeys([*stable, *initial, *recent]):
        item = items[index]
        key = "output" if item.get("type") == "function_call_output" else "content"
        content = item.get(key)
        kind = "input_text" if responses else "text"
        if isinstance(content, str) and content:
            content = item[key] = [{"type": kind, "text": content}]
        if isinstance(content, list):
            for block in reversed(content):
                if isinstance(block, dict) and block.get("type") == kind and block.get("text"):
                    block["prompt_cache_breakpoint"] = {"mode": "explicit"}
                    marked = True
                    break
    if marked:
        sent["prompt_cache_options"] = {"mode": "implicit"}
    return sent


def with_chat_anthropic_breakpoints(params: dict[str, Any]) -> dict[str, Any]:
    """Claude 经 Chat Completions 网关接入时也发送 cache_control。"""
    from backend.llm.claude_client import with_prompt_cache

    sent = deepcopy(params)
    messages = sent.get("messages") or []
    # Anthropic 的顺序是 tools → system → messages。Chat 接口的 system 保留在消息里。
    stable = [item for item in messages if item.get("role") in {"system", "developer"}]
    dynamic = [item for item in messages if item.get("role") not in {"system", "developer"}]
    # Chat 的 tool 消息会被网关转换为 Claude 的 user/tool_result；它同样要保留滚动断点。
    mapped = with_prompt_cache({"tools": sent.get("tools") or [],
                                "messages": [{**item, "role": "user" if item.get("role") == "tool" else item.get("role")} for item in dynamic],
                                "system": stable[-1].get("content") if stable else ""})
    if sent.get("tools"):
        sent["tools"] = mapped["tools"]
    if stable:
        stable[-1]["content"] = mapped["system"]
    sent["messages"] = [*stable, *[{**item, "role": original["role"]} for original, item in zip(dynamic, mapped["messages"])]]
    return sent


def cache_parameter_rejected(exc: Any) -> bool:
    """只对上游明确拒绝可选缓存参数的 400/422 做兼容重试。"""
    if getattr(exc, "status_code", None) not in {400, 422}:
        return False
    message = str(getattr(exc, "message", "") or exc).lower()
    param = str(getattr(exc, "param", "") or "").lower()
    fields = ("cache_control", "prompt_cache_breakpoint", "prompt_cache_options", "prompt_cache_key")
    named = any(field in param or field in message for field in fields)
    rejected = bool(re.search(r"unknown|unrecognized|unsupported|not support|not allowed|not permitted|extra inputs|extra fields|unexpected|invalid parameter|不支持|未知参数", message))
    return named and rejected


def without_cache_directives(params: dict[str, Any]) -> dict[str, Any]:
    """移除本次可选缓存标记；不删消息、工具结果或其他请求参数。"""
    sent = deepcopy(params)
    for key in ("prompt_cache_key", "prompt_cache_options", "cache_control"):
        sent.pop(key, None)
    def clean_blocks(blocks: Any) -> None:
        if isinstance(blocks, list):
            for block in blocks:
                if isinstance(block, dict):
                    block.pop("cache_control", None)
                    block.pop("prompt_cache_breakpoint", None)
                    if block.get("type") == "tool_result":
                        clean_blocks(block.get("content"))
    # 不遍历 Schema、工具参数或用户 JSON：同名的业务字段并不是缓存参数。
    for tool in sent.get("tools") or []:
        tool.pop("cache_control", None)
    clean_blocks(sent.get("system"))
    for key in ("messages", "input"):
        items = sent.get(key)
        if isinstance(items, list):
            for item in items:
                clean_blocks(item.get("content"))
                if item.get("type") == "function_call_output":
                    clean_blocks(item.get("output"))
                for content_key in ("content", "output"):
                    blocks = item.get(content_key)
                    if isinstance(blocks, list) and blocks and all(
                        isinstance(block, dict) and block.get("type") in {"text", "input_text"}
                        and set(block) <= {"type", "text"} and isinstance(block.get("text"), str) for block in blocks
                    ):
                        item[content_key] = "".join(block["text"] for block in blocks)
    return sent


def usage_value(value: Any, key: str, default: Any = None) -> Any:
    return value.get(key, default) if isinstance(value, dict) else getattr(value, key, default)


def token_count(value: Any, *keys: str) -> int:
    """兼容 SDK 对象、网关额外字段和原始 JSON；零值仍然是有效报告。"""
    for key in keys:
        current = value
        for part in key.split("."):
            current = usage_value(current, part)
        if current is not None:
            try:
                return max(0, int(current))
            except (ValueError, TypeError):
                continue
    return 0


def cache_usage(usage: Any) -> tuple[int, int]:
    # 中转会同时填一个默认 0 的标准字段和真正的厂商字段。它们是同一用量的别名，取最大值，不能相加或被默认 0 遮蔽。
    def aliases(*keys: str) -> int:
        return max((token_count(usage, key) for key in keys), default=0)

    read = aliases("prompt_tokens_details.cached_tokens", "input_tokens_details.cached_tokens",
                       "cache_read_input_tokens", "prompt_cache_hit_tokens", "model_extra.prompt_cache_hit_tokens",
                       "cache_read_tokens", "cached_tokens", "cached_content_token_count", "cachedContentTokenCount", "total_cached_tokens")
    write = aliases("prompt_tokens_details.cache_write_tokens", "input_tokens_details.cache_write_tokens",
                    "prompt_tokens_details.cache_creation_tokens", "input_tokens_details.cache_creation_tokens",
                    "cache_creation_input_tokens", "cache_write_input_tokens", "cache_write_tokens")
    write = max(write, token_count(usage, "cache_creation.ephemeral_5m_input_tokens")
                + token_count(usage, "cache_creation.ephemeral_1h_input_tokens"))
    return read, write
