"""去AI味的确定性预检：移植自 oh-story-claudecode 的 story-deslop 检测脚本（MIT License，Copyright (c) 2025-2026 oh-story-claudecode）。

只移植两份脚本里的 blocking 规则：
- check-ai-patterns.js：不是A而是B、是A不是B、否定排比、音量反差腔、章尾预告与总结、破折号；
- check-degeneration.js：逐字复读、截断、占位符和拒绝语、写作工程词泄漏。
这些规则在原项目用真人正文校准过（真人语料命中约为 0），命中就要改掉。advisory 的密度类提示
（微动作、套词、比喻密度等）误伤面大，不移植，由去味模型按语境判断。
引号内的台词一律豁免（口语里“不是A，是B”是正常辩解），与原脚本一致。
"""

from __future__ import annotations

import re

_QUOTE_PAIRS = (("「", "」"), ("『", "』"), ("【", "】"), ("“", "”"), ("‘", "’"), ('"', '"'), ("'", "'"))
_QUOTES = [re.compile(re.escape(a) + "[^" + re.escape(b) + r"\n]*" + re.escape(b)) for a, b in _QUOTE_PAIRS]

_STOP = set("。！？!?\n")
_SOFT = set("，,、；;：:")
_HARD = set("。.！!？?")
_EITHER_OR_PREV = set("不就也")
_TAG_PARTICLES = set("吗吧嘛")
_AFFIRM_PARTICLES = set("的啊呀呢")
_AFFIRM_BOUNDARY = set("，,。.！!？?、；;：:\n\r\t ") | {""}
_MAX_SPAN = 80

_VOICE_CONTRAST = re.compile(r"声音(?:并)?不[大高响亮][^。！？!?\n]{0,16}[却但偏]")
_NEGATION_PARADE = (
    re.compile(r"(?:没有[^。！？!?\n，,]{1,12}[，,]){2}"),
    re.compile(r"(?<![沉淹埋出隐湮吞覆漫泯])没(?!有?过?多久)(?:有)?[^。！？!?\n，,]{1,12}[，,]\s*没(?!有?过?多久)(?:有)?"
               r"[^。！？!?\n，,]{1,16}[，,。.][^。！？!?\n，,]{0,6}只(?:是|会|有)"),
)
_REVERSE_NOT_IS = re.compile(r"是([^。！？!?\n，,]{1,12})[，,]\s*(?:而)?不是([^。！？!?\n]{1,20})")
_REVERSE_PREV = _EITHER_OR_PREV | set("还只可但于倒像若要正便总老更最算怕凡或即自竟原本仍许净光单尽")
_TRAILER_ENDING = re.compile(r"没人知道|谁也不知道|谁也没想到|殊不知|(?:这)?才刚刚开(?:始|头)|正(?:朝着|向着)[^。！？!?\n]{0,24}"
                             r"(?:压|涌|袭|逼)(?:了?过去|了?过来|来)|(?<!正式)拉开(?:序幕|帷幕)|即将(?:开始|来临|降临)")
_TRAILER_SUMMARY = re.compile(
    r"这一(?:夜|天|刻|战|年|局|役)[，,]?[^。！？!?，,\n]{0,6}(?<!命中)(?<!是)注定[^。！？!?\n]{0,8}[。！]"
    r"|就这样[，,][^。！？!?，,\n]{0,8}(?:一切|全部)[^。！？!?，,\n]{0,4}(?:结束了|落幕|收场)[。！]"
    r"|这一切[，,]?[^。！？!?，,\n]{0,6}(?:都)?(?:说明|意味着|结束了)(?!的)(?:(?!什么)[^。！？!?\n]){0,6}[。！]"
    r"|(?:新的篇章|新的旅程|崭新的篇章|新的人生)[^。！？!?\n]{0,6}(?:开始|拉开|展开)|命运[^。！？!?\n]{0,6}齿轮")
_TRAILER_WINDOW = 600
_DASH = re.compile(r"——|—|--+")
_VISIBLE = re.compile(r"[一-鿿Ａ-ｚA-Za-z0-9]")
_STRUCTURAL = re.compile(r"^(#{1,6}\s|>\s?|[-*+]\s|\d+[.)]\s|\|)|^第[零一二三四五六七八九十百千万\d]+章(?:\s|_|$)")
_DIVIDER = re.compile(r"^(-{3,}|[*_]{3,})$")

# 退化：长句出现 3 次以上算打转；紧邻两行完全相同算即时循环。短句、台词刷屏是体裁手法，豁免。
_REPEAT_MIN_LEN, _REPEAT_MIN_COUNT, _ADJACENT_MIN_LEN = 12, 3, 8
_PLACEHOLDERS = (  # (正则, 说明, 是否连台词里也算)
    (re.compile(r"作为(一个)?(AI|人工智能|大?语言模型|智能助手|聊天助手)(?:语言模型|大?模型|助手|机器人)?(?=[，,。、；;：:！!？?\s）)」』\"】]|我|无法|不能|没法|$)"), "AI 自指", False),
    (re.compile("\ufffd"), "乱码", True),
    (re.compile(r"^(Sure|Certainly|Here'?s|As an AI|I (?:cannot|can't|am unable|apologize))"), "英文 AI 腔", True),
    (re.compile(r"[（(](此处|以下|这里|下文|后续)?\s*(省略|略)(去|过)?[^）)]{0,10}[）)]"), "括号省略占位", True),
    (re.compile(r"(未完待续|TODO|占位符|placeholder)"), "占位符", True),
    (re.compile(r"我(无法|不能)(继续(写|创作|生成|下去)|生成(内容|文本|正文)?|创作|续写|完成(这个|本)?(章|篇|创作|请求))"), "生成拒绝语", False),
)
_META_TIER1 = re.compile(r"细纲|情节点|卷纲|功能标签|目标情绪|字数目标|章首钩子|章尾钩子")
_CHAPTER_TITLE = re.compile(r"^第[一二三四五六七八九十百千万两0-9]+章")
_ENDING = re.compile(r"[。！？!?…”\"』」）)】]$")


def _mask(text: str) -> str:
    """成对引号片段换成等长的“？”：豁免台词，又不改变偏移；“？”会截断各规则的句内匹配。"""
    for pattern in _QUOTES:
        text = pattern.sub(lambda m: "？" * len(m.group()), text)
    return text


def _strip(text: str) -> str:
    for pattern in _QUOTES:
        text = pattern.sub("", text)
    return text


def _visible(text: str) -> int:
    return len(_VISIBLE.findall(text))


def _compact(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= 80 else text[:77] + "..."


def _prose(text: str) -> list[str]:
    return [line for line in text.splitlines() if line.strip() and not _DIVIDER.match(line.strip()) and not _STRUCTURAL.match(line.strip())]


def _finding(kind: str, excerpt: str, message: str, fixable: bool = True) -> dict:
    return {"type": kind, "excerpt": _compact(excerpt), "message": message, "fixable": fixable}


def _affirmation(text: str, index: int) -> bool:
    """“是的，……”“是啊，……”是承接确认，不是对比里的肯定项。"""
    if index >= len(text) or text[index] != "是" or index + 1 >= len(text) or text[index + 1] not in _AFFIRM_PARTICLES:
        return False
    return (text[index + 2] if index + 2 < len(text) else "") in _AFFIRM_BOUNDARY


def _skip_gap(text: str, index: int) -> int:
    while index < len(text) and text[index] in " \t\r\n":
        index += 1
    return index


def _flip_end(text: str, start: int) -> int:
    """从“不是”往后找肯定翻转的“是/而是”；找不到返回 -1。分隔符之后的“只是/可是/还是”是连词，不算。"""
    index, scanned, crossed = start + 2, 0, False
    while index < len(text) and scanned <= _MAX_SPAN:
        char = text[index]
        if text.startswith("而是", index):
            return index + 2
        if char in _SOFT:
            nxt = _skip_gap(text, index + 1)
            if text.startswith("而是", nxt):
                return nxt + 2
            if nxt < len(text) and text[nxt] == "是" and (text[nxt + 1:nxt + 2] not in _TAG_PARTICLES) and not _affirmation(text, nxt):
                return nxt + 1
            crossed = True
        if char in _HARD:
            nxt = _skip_gap(text, index + 1)
            if nxt < len(text) and text[nxt] == "是" and (text[nxt + 1:nxt + 2] not in _TAG_PARTICLES) and not _affirmation(text, nxt):
                return nxt + 1
            if char != ".":
                break
            crossed = True
        if char in _STOP:
            break
        if char == "是" and text[index - 1] not in _EITHER_OR_PREV and not crossed:
            return index + 1
        index += 1
        scanned += 1
    return -1


def _not_is(text: str) -> list[dict]:
    """“不是A，而是B”“不是A是B”：可以跨行（含空行分段的揭示句），引号内豁免。"""
    ranges = [m.span() for pattern in _QUOTES for m in pattern.finditer(text)]
    found, offset = [], 0
    while (start := text.find("不是", offset)) != -1:
        if any(a <= start < b for a, b in ranges) or (start > 0 and text[start - 1] == "是"):
            offset = start + 2
            continue
        end = _flip_end(text, start)
        if end == -1:
            offset = start + 2
            continue
        stop = end
        while stop < min(len(text), end + _MAX_SPAN) and text[stop] not in _STOP:
            stop += 1
        raw = re.sub(r"[\s|）)】\]]+$", "", text[start:stop])
        if len(raw) >= 4:
            found.append(_finding("not-is-comparison", raw, "“不是A，而是B”对比腔：删掉否定铺垫，直接写B；只有在纠错、辩解、排除猜测时才保留对比。"))
        offset = start + max(len(raw), 2)
    return found


def _line_rules(lines: list[str]) -> list[dict]:
    found = []
    for line in lines:
        masked = _mask(line)
        for m in _DASH.finditer(line):
            found.append(_finding("em-dash", line[max(0, m.start() - 8):m.end() + 8],
                                  "破折号按功能改写：打断改成动作或短句，拖长音删去或改动作，插入说明改逗号、冒号；不要一律换句号。"))
        for m in _VOICE_CONTRAST.finditer(masked):
            found.append(_finding("voice-contrast", line[m.start():m.end()],
                                  "音量反差腔“声音不大，却……”：删掉音量铺垫，直接写这句话落下后谁有什么反应。"))
        spans, last = sorted(m.span() for pattern in _NEGATION_PARADE for m in pattern.finditer(masked)), -1
        for a, b in spans:
            if a >= last:
                found.append(_finding("negation-parade", line[a:b], "否定排比“没有X，没有Y……”：删掉否定清单，直接写现场实际有什么，最多留一个最有信息量的否定。"))
            last = max(last, b)
        for m in _REVERSE_NOT_IS.finditer(masked):
            a = m.start()
            if (a > 0 and masked[a - 1] in _REVERSE_PREV) or masked[a + 1:a + 2] == "不" or _affirmation(masked, a) or m.group(2)[:1] in "吗么吧":
                continue
            found.append(_finding("reverse-not-is", line[a:m.end()], "反序对比腔“是A，不是B”：删掉后面的否定，直接写A的具体表现。"))
    return found


def _trailer(lines: list[str]) -> list[dict]:
    """章尾预告和状态总结：只看文末约 600 字的叙述，正文中段的“没人知道”是普通叙述。"""
    window, total = [], 0
    for line in reversed(lines):
        if total >= _TRAILER_WINDOW:
            break
        window.insert(0, line)
        total += _visible(_strip(line.strip()))
    found = []
    for line in window:
        masked = _mask(line)
        for m in _TRAILER_ENDING.finditer(masked):
            found.append(_finding("trailer-ending", line[m.start():m.end()], "章尾预告腔：结尾停在具体动作、画面或一句台词上，让事件自己挂住悬念，不替读者预告下一章。"))
        for m in _TRAILER_SUMMARY.finditer(masked):
            found.append(_finding("trailer-summary", line[m.start():m.end()], "章尾总结腔（这一夜注定……、这一切都结束了、命运的齿轮）：把结尾落成最后一个具体动作、画面或台词。"))
    return found


def _degeneration(text: str) -> list[dict]:
    body = [line.strip() for line in text.splitlines() if line.strip() and not line.strip().startswith("#") and not _DIVIDER.match(line.strip())]
    found = []
    for prev, line in zip(body, body[1:]):
        if line == prev and _visible(_strip(line)) >= _ADJACENT_MIN_LEN:
            found.append(_finding("verbatim-repeat", line, "紧邻两行完全相同，疑似模型打转：删掉重复的一行。"))
    counts: dict[str, int] = {}
    for line in body:
        for sentence in re.split(r"[。！？!?]", _strip(line)):
            if _visible(s := sentence.strip()) >= _REPEAT_MIN_LEN:
                counts[s] = counts.get(s, 0) + 1
    for sentence, count in counts.items():
        if count >= _REPEAT_MIN_COUNT:
            found.append(_finding("verbatim-repeat", sentence, f"同一句叙述出现了 {count} 次，疑似模型打转：只留一处，其余删掉或改写。"))
    if body and not _ENDING.search(body[-1]):
        # 截断要补写结尾，补丁改不了，也不能让去味模型凭空续写；只报告给作者。
        found.append(_finding("truncated", body[-1][-24:], "正文末尾没有句末标点，可能被中途截断。", fixable=False))
    for index, line in enumerate(body):
        outside = _mask(line).replace("？", " ")
        for pattern, label, anywhere in _PLACEHOLDERS:
            if m := pattern.search(line if anywhere else outside):
                found.append(_finding("placeholder-leak", line[max(0, m.start() - 4):m.start() + 20],
                                      f"正文混入了{label}：删掉或改成故事里的话。", fixable=label != "乱码"))
                break
        if index == 0 and _CHAPTER_TITLE.match(line):
            continue
        if m := _META_TIER1.search(outside):
            found.append(_finding("meta-leak", line[max(0, m.start() - 6):m.end() + 12],
                                  f"写作工程词“{m.group()}”漏进了正文：改成人物和场景里的说法。"))
    return found


def scan(text: str) -> list[dict]:
    """返回必须改掉的问题（blocking）。fixable=False 的问题（截断、乱码）去味补丁修不了，只报告。"""
    lines = _prose(text)
    return _not_is(text) + _line_rules(lines) + _trailer(lines) + _degeneration(text)
