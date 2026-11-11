"""中文创作输出的开头工作说明过滤；不改动作品内的正常英文。"""

import re
from contextlib import aclosing

from backend.llm.base_client import _ThinkStreamFilter


_STARTERS = (
    "i need to", "i have to", "i should", "i must", "i will", "i'll", "let me", "let's",
    "we need to", "we should", "we must", "we will", "need to", "the user", "user wants",
    "the task", "analysis", "thinking", "reasoning", "thought process",
    "okay", "ok", "alright", "sure",
)
_HEADING = re.compile(r"^(?:analysis|thinking|reasoning|thought process)\s*(?::|：|$)", re.I)
_ACTION = re.compile(r"\b(?:writ\w*|rewrit\w*|revis\w*|edit\w*|summari[sz]\w*|produc\w*|provid\w*|generat\w*|compos\w*|craft\w*|ensur\w*|cover\w*|includ\w*|respond\w*|answer\w*|translat\w*)\b", re.I)
_TASK = re.compile(r"\b(?:summary|summaries|synopsis|outline|response|answer|chinese|prose|chapter|characters|chronological|instructions|requirements|user)\b", re.I)
_FINAL = re.compile(r"^(?:final(?: answer| response)?|answer|summary|synopsis|output|正文|剧情概要)\s*[:：]\s*", re.I)
_CHINESE = re.compile(r"[\u3400-\u9fff]")


def _normalized(line: str) -> str:
    return line.lstrip("\ufeff \t\r\n#*`").strip().rstrip("*`").rstrip()


class CreativeOutputFilter:
    """先过滤标签，再在任何文字发给界面前识别无标签的英文任务自述。"""

    def __init__(self):
        self._tags = _ThinkStreamFilter()
        self._buffer = ""
        self._leading = ""
        self._body_started = False
        self._discard_line = False
        self._reasoning_section = False
        self._removed_note = False
        self._after_final = False

    def feed(self, text: str) -> str:
        return self._feed_visible(self._tags.feed(text))

    def _feed_visible(self, text: str) -> str:
        if self._body_started:
            return text
        self._buffer += text
        while self._buffer:
            newline = self._buffer.find("\n")
            if self._discard_line:
                if newline < 0:
                    self._buffer = ""
                    return ""
                self._buffer = self._buffer[newline + 1:]
                self._discard_line = False
                continue
            line = self._buffer if newline < 0 else self._buffer[:newline]
            normalized = _normalized(line)
            if not normalized:
                if newline < 0:
                    return ""
                if self._removed_note:
                    self._buffer = self._buffer[newline + 1:]
                    continue
                self._leading += self._buffer[:newline + 1]
                self._buffer = self._buffer[newline + 1:]
                continue
            if self._removed_note and (final := _FINAL.match(normalized)):
                position = line.index(normalized) + final.end()
                self._buffer = self._buffer[position:]
                self._reasoning_section = False
                self._after_final = True
                continue
            heading = _HEADING.match(normalized) if newline >= 0 or ":" in normalized or "：" in normalized else None
            starter = normalized.lower().startswith(_STARTERS)
            note = bool(heading or (starter and _ACTION.search(normalized) and _TASK.search(normalized)))
            if heading:
                self._reasoning_section = True
            if not note and self._reasoning_section and newline < 0 and not _CHINESE.match(normalized.lstrip('“"（(')):
                # Final answer 等分隔符可能跨片段；整行未收齐前不能丢弃。
                return ""
            if note or (self._reasoning_section and not _CHINESE.match(normalized.lstrip('“"（('))):
                self._removed_note = True
                self._leading = ""
                if newline < 0:
                    self._buffer = ""
                    self._discard_line = True
                    return ""
                self._buffer = self._buffer[newline + 1:]
                continue
            possible = any(prefix.startswith(normalized.lower()) or normalized.lower().startswith(prefix) for prefix in _STARTERS)
            if newline < 0 and possible:
                return ""
            return self._start_body()
        return ""

    def _start_body(self) -> str:
        self._body_started = True
        text, self._buffer = self._leading + self._buffer, ""
        self._leading = ""
        if self._after_final:
            text = text.lstrip(" \t\r\n")
        return text

    def finish(self) -> str:
        visible = self._feed_visible(self._tags.finish())
        if self._discard_line or self._reasoning_section:
            return visible
        return visible + self._start_body()


def clean_creative_output(text: str) -> str:
    cleaner = CreativeOutputFilter()
    return cleaner.feed(text) + cleaner.finish()


PROSE_CONTRACT = (
    "作品交付格式：把可直接使用的作品全文放在 <novel_text> 与 </novel_text> 之间。"
    "标签内只能有作品，不得有分析、计划、审稿、工具说明或修改清单；说明放在标签外。"
)
_PROCESS_LINE = re.compile(
    r"^(?:#{1,6}\s*)?(?:【|\[|\*\*)?(?:思考|分析|推理|思考过程|思考分析|分析过程|写作计划|写作思路|审查意见|修改说明|推理过程|任务分析|自我审查|analysis|reasoning|thinking|thought process)(?:】|\]|\*\*)?\s*[:：]?$"
    r"|^(?:我(?:需要|应该|将会|会先|先要)|接下来(?:我将|我要)|首先(?:我需要|需要先))(?:.*)(?:正文|草稿|续写|用户|作者|大纲|审查|改写|要求)"
    r"|^(?:I need to|I should|Let me|We need to).*(?:write|draft|prose|user|chapter|review)", re.I)
_BODY_LABEL = re.compile(r"^\s*(?:#{1,6}\s*)?(?:【|\[|\*\*)?(?:正文|正文开始|最终正文|修改后正文|最终稿|Final answer)(?:】|\]|\*\*)?\s*[:：]?\s*$", re.I)


def clean_prose_output(text: str) -> str:
    """验证作品边界；无法可靠分离的工作说明拒绝交付，不能靠猜测删掉故事句子。"""
    if "<novel_text>" in text:
        text = text.split("<novel_text>", 1)[1]
    # 续写的片段可能没有开标签、只有闭标签；闭标签之后的都是标签外的说明。
    text = text.split("</novel_text>", 1)[0]
    text = clean_creative_output(text)
    lines = text.splitlines(keepends=True)
    labels = [i for i, line in enumerate(lines) if _BODY_LABEL.fullmatch(line.strip())]
    if labels:
        lines = lines[labels[-1] + 1:]
    if any(_PROCESS_LINE.search(_normalized(line)) for line in lines):
        raise ValueError("作品中仍含工作说明，未将其写入正文")
    return "".join(lines).strip("\ufeff \t\r\n")


def _drop_body_labels(text: str) -> str:
    """流式交付时去掉“正文：”“【最终稿】”这类独立标签行，与 clean_prose_output 一致。"""
    return "".join(line for line in text.splitlines(keepends=True) if not _BODY_LABEL.fullmatch(line.strip()))


class ProseOutputFilter:
    """显式作品标签内流式交付。旧模型未遵守标签时先收齐并验证，避免思考先进入初稿。"""

    def __init__(self):
        self._pending = ""
        self._inside = False
        self._closed = False
        self._cleaner = CreativeOutputFilter()

    def feed(self, text: str) -> str:
        if self._closed:
            return ""
        self._pending += text
        if not self._inside:
            if "<novel_text>" not in self._pending:
                return ""
            self._pending = self._pending.split("<novel_text>", 1)[1]
            self._inside = True
        if "</novel_text>" in self._pending:
            body = self._pending.split("</novel_text>", 1)[0]
            clean_prose_output(body)
            self._pending = ""
            self._closed = True
            return self._cleaner.feed(_drop_body_labels(body)) + self._cleaner.finish()
        # 保留可能跨片段的结束标签；只按完整段落/行送出，防止工作标题泄漏。
        end = self._pending.rfind("\n")
        if end < 0:
            return ""
        body, self._pending = self._pending[:end + 1], self._pending[end + 1:]
        clean_prose_output(body)
        return self._cleaner.feed(_drop_body_labels(body))

    def finish(self) -> str:
        if self._closed:
            return ""
        if self._inside:
            # 网络异常不会调用 finish；模型正常结束但省略闭标签可交付已验证的正文。
            clean_prose_output(self._pending)
            return self._cleaner.feed(_drop_body_labels(self._pending)) + self._cleaner.finish()
        return clean_prose_output(self._pending)


MAX_CONTINUATIONS = 8
CONTINUE_TAIL = 3000


def continuation_prompt(prompt: str, written: str, note: str = "") -> str:
    """接着已写正文往下写的提示：只给尾部，避免重发整稿；明确不重复、不收尾。"""
    return (prompt + f"\n\n【已经写好的正文（只列出最后一段，前面的已保存，不要重写）】\n…{written[-CONTINUE_TAIL:]}\n\n"
            + (note or "上一次输出达到了单次长度上限，正文在上面最后一个字处被截断。")
            + "请从最后一个字之后直接接着写：先把没写完的句子补完，再按大纲继续往下写。"
            "不要重复已写的内容，不要重新开头，也不要为了收尾而压缩剧情；写到大纲的结束点自然停下。")


def _glue(written: str, chunk: str) -> str:
    """续写的第一段去掉多余的开头空白；上一段停在句中时直接接上，停在段末时保留换行。"""
    if written and not written.endswith("\n"):
        return chunk.lstrip(" \t")
    return chunk


async def stream_prose(service, prompt: str, system: str, options: dict, *, continuations: int = MAX_CONTINUATIONS):
    """格式错误且未交付任何正文时重试一次；写到单次输出上限时自动从断点接着写；取消/网络异常正常向上传播。"""
    from backend.api.error_protocol import DomainApiError
    from backend.llm.exceptions import LLMResponseError
    written, request, retries, continued = "", prompt, 0, 0
    while True:
        cleaner, delivered, first = ProseOutputFilter(), False, True
        retry = "\n上一请求没有交付合格作品。请直接在作品标签内写正文，省略所有工作说明。" if retries else ""
        try:
            try:
                async with aclosing(service.stream_text(request + retry, system_prompt=system + PROSE_CONTRACT, **options)) as chunks:
                    async for raw in chunks:
                        text = cleaner.feed(raw)
                        if text:
                            if first and continued:
                                text, first = _glue(written, text), False
                            delivered = True
                            written += text
                            yield text
                tail = cleaner.finish()
            except LLMResponseError as exc:
                if not getattr(exc, "truncated", False) or continued >= continuations:
                    raise
                # 写到单次输出上限：交付已经收到的整行之后的残余，再从断点接着写。
                try:
                    tail = cleaner.finish()
                except ValueError:
                    tail = ""
                if tail:
                    written += tail
                    yield tail
                if not written.strip():
                    raise
                continued += 1
                request = continuation_prompt(prompt, written)
                continue
            if tail:
                delivered = True
                written += tail
                yield tail
            if not delivered and not continued:
                raise ValueError("模型只返回了过程说明")
            return
        except ValueError as exc:
            if delivered or retries or continued:
                raise DomainApiError("WRITING_AGENT_INVALID_PROSE", "模型输出仍混有工作说明，已阻止写入正文；请重试或调整模型输出预算", status_code=502) from exc
            retries += 1
