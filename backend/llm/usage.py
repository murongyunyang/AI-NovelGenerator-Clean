"""一次请求内所有模型调用的 Token 用量累计，供界面实时显示。"""

from __future__ import annotations

from contextvars import ContextVar
from time import monotonic

from backend.llm.config import ModelPricing
from backend.llm.models import TokenUsage


def estimate_tokens(text: str) -> int:
    """没有真实用量时的粗略估算：汉字约 1.6 字一个 token，其余字符约 4 个一个。"""
    cjk = sum(1 for char in text if "　" <= char <= "鿿" or "＀" <= char <= "￯")
    return int(cjk / 1.6 + (len(text) - cjk) / 4) + 1 if text else 0


class UsageMeter:
    """累计一次请求里每次模型调用的用量。事件循环是单线程的，更新不需要加锁。"""

    def __init__(self) -> None:
        self.input = 0
        self.output = 0
        self.calls = 0
        self.estimated_calls = 0
        self.cache_read = 0
        self.cache_write = 0
        self.costs: dict[str, float] = {}
        self.priced_calls = 0
        self.version = 0
        # 模型服务的流仍有数据到达（包括没有可见文字的 ping 和思考）的最近时间；静默计时据此判断请求是否真的卡死。
        self.touched = monotonic()

    def touch(self) -> None:
        self.touched = monotonic()

    def add(self, usage: TokenUsage | None, *, fallback_text: str = "", pricing: ModelPricing | None = None) -> None:
        """记录一次调用；供应商没有返回用量时按输出文字估算，并按所选模型价格累计参考费用。"""
        call_input = call_output = 0
        if usage is not None and (usage.input_tokens or usage.output_tokens or usage.total_tokens):
            call_input = usage.input_tokens
            call_output = usage.output_tokens or max(0, usage.total_tokens - usage.input_tokens)
            self.input += call_input
            self.output += call_output
        elif fallback_text:
            call_output = estimate_tokens(fallback_text)
            self.output += call_output
            self.estimated_calls += 1
        else:
            return
        self.calls += 1
        if usage is not None:
            self.cache_read += usage.cache_read_tokens
            self.cache_write += usage.cache_write_tokens
        if pricing is not None:
            # 各客户端的 input_tokens 都已包含缓存读写两项，这里先扣掉再按缓存价计，不会重复计费。
            # 倍率按 Claude 官方（读 0.1 倍、5 分钟写 1.25 倍）；OpenAI / DeepSeek / Gemini 只报告读缓存，
            # 新模型的命中价也约为 0.1 倍，旧模型（如 0.25、0.5 倍）会略为低估，仅作参考。
            cached = (usage.cache_read_tokens * 0.1 + usage.cache_write_tokens * 1.25) if usage is not None else 0
            plain = call_input - ((usage.cache_read_tokens + usage.cache_write_tokens) if usage is not None else 0)
            cost = ((max(0, plain) + cached) * pricing.input_per_million + call_output * pricing.output_per_million) / 1_000_000
            self.costs[pricing.currency] = self.costs.get(pricing.currency, 0) + cost
            self.priced_calls += 1
        self.version += 1

    def snapshot(self) -> dict[str, int | bool | float | str | None]:
        currencies = list(self.costs)
        return {"input": self.input, "output": self.output, "total": self.input + self.output,
                "calls": self.calls, "estimated": self.estimated_calls > 0,
                "cost": round(self.costs[currencies[0]], 6) if len(currencies) == 1 else None,
                "currency": currencies[0] if len(currencies) == 1 else None,
                "priced": self.priced_calls > 0,
                # 即使为零也显示，避免把“没有命中/上游未报告”藏在界面之外。
                "cache_read": self.cache_read, "cache_write": self.cache_write}


# 请求入口设置；任务创建时会复制当前上下文，所以子任务（子智能体、后台读取）共用同一个累计器。
usage_meter: ContextVar[UsageMeter | None] = ContextVar("usage_meter", default=None)
