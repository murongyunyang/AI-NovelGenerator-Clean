"""模型流式回复过程中的实时片段（思考、说明文字、工具参数），让界面不必等一整步结束才有动静。

调用方在创建模型调用任务之前设置接收器；任务创建时会复制当前上下文，客户端里的流式循环据此找到接收器。
没有接收器时所有函数都是空操作，客户端行为不变。
"""

from __future__ import annotations

from collections.abc import Callable
from contextvars import ContextVar

# 接收器参数：通道（thinking / text / args）、工具名（只有 args 通道有）、该通道到目前为止累计的完整文字。
LiveSink = Callable[[str, str, str], None]
live_sink: ContextVar[LiveSink | None] = ContextVar("llm_live_sink", default=None)

_ESCAPES = {'"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t"}


def emit(channel: str, tool: str, text: str) -> None:
    sink = live_sink.get()
    if sink is not None and text:
        sink(channel, tool, text)


def touch() -> None:
    """流上有任何数据到达（包括没有可见文字的 ping）都算服务仍在响应。"""
    sink = live_sink.get()
    if sink is not None:
        sink("ping", "", "")


def partial_json_string(raw: str, key: str) -> str | None:
    """从尚未收完的 JSON 对象文本里取出字符串字段 key 目前已到达的内容；还没出现该字段时返回 None。"""
    marker = f'"{key}"'
    start = raw.find(marker)
    if start < 0:
        return None
    index = start + len(marker)
    while index < len(raw) and raw[index] in " \t\r\n":
        index += 1
    if index >= len(raw) or raw[index] != ":":
        return None
    index += 1
    while index < len(raw) and raw[index] in " \t\r\n":
        index += 1
    if index >= len(raw) or raw[index] != '"':
        return None
    index += 1
    out: list[str] = []
    while index < len(raw):
        char = raw[index]
        if char == '"':
            break
        if char != "\\":
            out.append(char)
            index += 1
            continue
        if index + 1 >= len(raw):
            break
        escape = raw[index + 1]
        if escape == "u":
            try:
                out.append(chr(int(raw[index + 2:index + 6], 16)))
            except ValueError:
                break
            if index + 6 > len(raw):
                out.pop()
                break
            index += 6
            continue
        out.append(_ESCAPES.get(escape, escape))
        index += 2
    text = "".join(out)
    # 😀 这样的代理对要合并成一个字符。
    if any("\ud800" <= char <= "\udfff" for char in text):
        text = text.encode("utf-16", "surrogatepass").decode("utf-16", "replace")
    return text


class ClaudeStreamLive:
    """跟踪 Claude 流式回复里各内容块（思考、说明文字、工具参数）的累计文字。"""

    def __init__(self) -> None:
        self._kinds: dict[int, tuple[str, str]] = {}
        self._texts: dict[int, str] = {}

    def feed(self, event) -> None:
        if live_sink.get() is None:
            return
        touch()
        try:
            if event.type == "content_block_start":
                block = event.content_block
                kind = {"thinking": ("thinking", ""), "text": ("text", ""), "tool_use": ("args", getattr(block, "name", ""))}.get(block.type)
                if kind:
                    self._kinds[event.index] = kind
            elif event.type == "content_block_delta" and event.index in self._kinds:
                delta = event.delta
                piece = getattr(delta, "thinking", None) or getattr(delta, "text", None) or getattr(delta, "partial_json", None)
                if piece:
                    self._texts[event.index] = self._texts.get(event.index, "") + piece
                    channel, tool = self._kinds[event.index]
                    emit(channel, tool, self._texts[event.index])
        except Exception:
            return  # 实时预览只是附加信息，出错不能影响正常的收齐。


class ChatStreamLive:
    """跟踪 Chat Completions 流式回复里的思考、说明文字和工具参数。"""

    def __init__(self) -> None:
        self._thinking = ""
        self._text = ""
        self._calls: dict[int, list[str]] = {}

    def feed(self, chunk) -> None:
        if live_sink.get() is None:
            return
        touch()
        try:
            for choice in chunk.choices or []:
                delta = choice.delta
                if delta is None:
                    continue
                reasoning = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
                if isinstance(reasoning, str) and reasoning:
                    self._thinking += reasoning
                    emit("thinking", "", self._thinking)
                if delta.content:
                    self._text += delta.content
                    emit("text", "", self._text)
                for call in delta.tool_calls or []:
                    entry = self._calls.setdefault(call.index, ["", ""])
                    function = call.function
                    if function is not None:
                        entry[0] = function.name or entry[0]
                        entry[1] += function.arguments or ""
                    emit("args", entry[0], entry[1])
        except Exception:
            return
