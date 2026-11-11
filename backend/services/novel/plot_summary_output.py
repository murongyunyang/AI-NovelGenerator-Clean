"""先取得并校验最终中文剧情概要，再交给界面；模型工作说明不进入草稿。"""

import re
from contextlib import aclosing

from backend.api.error_protocol import DomainApiError
from backend.llm.base_client import BaseLLMClient
from backend.llm.exceptions import LLMResponseError


_SUMMARY_BLOCK = re.compile(r"<plot_summary\s*>(.*?)</plot_summary\s*>", re.I | re.S)
_QUOTES = re.compile(r'“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"')
_HAN = re.compile(r"[\u3400-\u9fff\U00020000-\U0002fa1f]")
_LATIN = re.compile(r"[a-zA-Z]+(?:['’-][a-zA-Z]+)*")
_WORK_START = re.compile(r"^(?:i\b|we\b|let\s+(?:me|us)\b|the\s+user\b|analysis\b|thinking\b|reasoning\b)", re.I)
_SYSTEM = "你是中文小说剧情概要编辑。只交付最终剧情概要，以实际发生的故事事件起笔，用连贯中文讲述。将最终成品放在 <plot_summary> 与 </plot_summary> 之间，标签外不输出任何文字。禁止输出写作计划、任务复述、分析步骤、英文工作说明或试写笔记。"


class InvalidPlotSummary(ValueError):
    """模型没有交付可展示的中文概要。"""


def _chinese_narrative(line: str) -> bool:
    unquoted = _QUOTES.sub("", line)
    if not unquoted.strip(" \t，。！？：；,.!?;:"):
        unquoted = line
    return bool(_HAN.search(unquoted)) and len(_HAN.findall(unquoted)) >= len(_LATIN.findall(unquoted))


def extract_plot_summary(raw: str) -> str:
    """兼容有成品标签和直接返回中文的上游；英文推演段落不能冒充成品。"""
    visible = BaseLLMClient._sanitize_text_content(raw)
    blocks = _SUMMARY_BLOCK.findall(visible)
    if blocks:
        visible = blocks[-1]
    elif re.search(r"</?plot_summary\b", visible, re.I):
        raise InvalidPlotSummary("剧情概要成品标签未闭合")
    lines = visible.replace("\r\n", "\n").replace("\r", "\n").strip().split("\n")
    result = []
    started = False
    for line in lines:
        stripped = line.strip()
        if not stripped:
            if started:
                result.append(line)
            continue
        if stripped in {"```", "```text", "```markdown", "```xml"}:
            continue
        # 英文说明中可能夹带带引号的中文词，不能据此认定已经生成中文概要。
        narrative = _chinese_narrative(stripped) and not _WORK_START.match(stripped)
        if not started:
            if not narrative:
                continue
            started = True
        elif not narrative:
            # 中文成品内可以有完整的英文引语，不能有未标注的英文工作段落。
            if _QUOTES.fullmatch(stripped) and _HAN.search("\n".join(result)):
                result.append(line)
                continue
            raise InvalidPlotSummary("剧情概要中仍混有非成品段落")
        result.append(line)
    if not started:
        raise InvalidPlotSummary("模型只返回工作说明，没有中文剧情概要")
    return "\n".join(result).strip()


async def generate_plot_summary(service, prompt: str, model: str = "", *, planned: bool = False):
    """最多修正一次，沿用作者所选供应商和模型，不回传未验证的模型片段。"""
    options = {"model": model} if model else {}
    system = _SYSTEM if not planned else (
        "你是中文小说大纲概要编辑。只交付最终概要，用连贯中文压缩作者计划的剧情，"
        "保留原文的计划、可能性和未定信息，不把计划改写成已经发生的事实，不补写剧情。"
        "将最终成品放在 <plot_summary> 与 </plot_summary> 之间，标签外不输出任何文字。"
        "禁止输出写作计划、任务复述、分析步骤、英文工作说明或试写笔记。"
    )
    for attempt in range(2):
        yield {"message": "正在整理并校验中文剧情概要…" if not attempt else "模型未返回合格的中文概要，正在重新整理一次…"}
        request = prompt
        if attempt:
            request += ("\n\n上一次没有交付合格的中文概要。请重新直接压缩以上大纲中的计划剧情，保留未定信息；" if planned else
                        "\n\n上一次没有交付合格的中文剧情概要。请重新直接根据以上章节事实用中文叙述实际剧情；")
            request += "省略所有写作计划、分析和工作说明；只交付 <plot_summary>中文剧情概要成品</plot_summary>，不要描述你准备如何写。"
        parts = []
        try:
            async with aclosing(service.stream_text(request, system_prompt=system, **options)) as chunks:
                async for chunk in chunks:
                    parts.append(chunk)
        except LLMResponseError:
            # 长度中断等异常中的 raw_output 也可能全是思考，不能旁路回传。
            raise DomainApiError("CONTINUATION_SUMMARY_INCOMPLETE", "模型未完整返回剧情概要，未写入概要草稿。请重试或检查模型输出设置。", status_code=502) from None
        try:
            text = extract_plot_summary("".join(parts))
        except InvalidPlotSummary:
            if not attempt:
                continue
            raise DomainApiError("CONTINUATION_SUMMARY_INVALID_OUTPUT", "模型连续返回工作说明或非中文概要，未写入概要草稿。请重试或选择其他模型。", status_code=502) from None
        yield {"text": text}
        return
