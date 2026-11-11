"""格式审校服务：原始响应校验失败时，调用支持结构化输出的模型修正格式。"""

from __future__ import annotations

import logging
from typing import TypeVar

from pydantic import BaseModel

from backend.llm.config import LLMConfig, get_llm_config
from backend.api.error_protocol import DomainApiError

logger = logging.getLogger(__name__)
T = TypeVar("T", bound=BaseModel)
FORMAT_REVIEW_PROMPT_TEMPLATE = (
    "以下是另一个 AI 的原始输出，但格式不符合要求。\n"
    "请只修正不符合目标 Schema 的格式或字段，严格输出合法 JSON，不要输出任何额外内容。\n"
    "保留原文含义、事实和完整句子，不得编造内容，也不得删除与格式或字段限制无关的事实。\n"
    "字段超过长度限制时，在含义不变的前提下精炼措辞，并用完整句子收束；"
    "不得直接截取前 N 字或把句子截成半句。\n"
    "保留不需修正的字段和原文中的可疑字符，不要擅自删除、替换或猜测缺失的原字。\n\n"
    "原始输出:\n{raw_text}"
)


def resolve_format_review_provider(config: LLMConfig | None = None) -> str:
    """解析当前可用的结构化格式审校 Provider。

    Args:
        config: 本次请求固定的模型配置；未提供时读取当前设置。

    Returns:
        已启用且支持 JSON Schema 或 DeepSeek JSON Output 的 Provider 别名。
    """
    llm_cfg = config if config is not None else get_llm_config()

    # 1. 配置显式指定
    configured = llm_cfg.format_review_provider
    if configured:
        if configured in llm_cfg.providers:
            prov = llm_cfg.providers[configured]
            if prov.enabled and ((prov.supports_json_schema and prov.resolved_structured_output_mode != "json_object") or (prov.resolved_structured_output_mode == "json_object" and prov.json_output_enabled)):
                return configured
        logger.warning(
            "配置的 format_review_provider '%s' 不可用（不存在 / 未启用 / 不支持结构化输出），尝试自动查找",
            configured,
        )

    # 2. 自动查找
    for name, cfg in llm_cfg.providers.items():
        if cfg.enabled and ((cfg.supports_json_schema and cfg.resolved_structured_output_mode != "json_object") or (cfg.resolved_structured_output_mode == "json_object" and cfg.json_output_enabled)):
            return name

    raise DomainApiError(
        "FORMAT_REVIEW_PROVIDER_UNAVAILABLE",
        "无可用的结构化格式审校 Provider，请检查设置",
        status_code=503,
    )


