"""送审前用规则检查作者明确不要、又能稳定识别的写法；命中的问题并入审稿结果，必须改掉才能通过。

审稿模型会漏掉这类机械问题（如“他看了两遍”），规则检查不依赖模型记得偏好。
新规则先拿作者定稿章节试过，不误伤作者原文才加。
"""

from __future__ import annotations

import re

# “看了两遍、检查了三遍、叫了石头两声”：动作后跟具体的多次数。
# 不算：第二遍（顺序）、二十几遍／三十多回（本来就模糊）、两回事／两下子／三下五除二（固定说法）。
_REPEAT_COUNT = re.compile(r"([了过])([^，。！？；：“”\n]{0,4}?)(?<![第十几多二两三四五六七八九])([两三四五六七八九])(遍|次|声|圈|回|下)(?![子事来去五])")
_DASH = re.compile(r"——|—")
# 一句台词劈成两半、中间夹说话人：“抓吧。”他往树干上一靠，“你抓着我踏实。”
_SPLIT_TAG = re.compile(r"“[^“”\n]*[，。！？…~]”[^“”，。！？\n]{1,24}，“")
# 叙述里用逗号一顿一顿排开的短词（饼子，炖肉，灵果）；作者定稿里并列用顿号。
_SHORT_LIST = re.compile(r"(?:(?<=[，。：；！？\s])|^)(?:[一-鿿]{1,3}，){2,}[一-鿿]{1,3}(?=[，。；])")
# 台词里的“我说了两遍了”是人物口语，不当作叙述里凑细节。
_QUOTE = re.compile(r"“[^“”]*”")

MAX_QUOTES = 6


def _narration(text: str) -> str:
    return _QUOTE.sub(lambda match: " " * len(match.group()), text)


def _snippet(text: str, start: int, end: int) -> str:
    left = max(text.rfind(mark, 0, start) for mark in "。！？\n") + 1
    right = min((index for index in (text.find(mark, end) for mark in "。！？\n") if index >= 0), default=len(text))
    return text[left:right + 1].strip()[:80]


def _span(text: str, start: int, end: int) -> str:
    """拆句取到后半句台词结束；引号里的句号不是边界。"""
    close = text.find("”", end)
    return text[start:close + 1 if close >= 0 else end][:80]


def lint(text: str) -> list[dict]:
    """返回审稿问题（与审稿 JSON 的 issue 字段相同）。"""
    issues = []
    narration = _narration(text)
    counts = [_snippet(text, m.start(), m.end()) for m in _REPEAT_COUNT.finditer(narration)]
    if counts:
        issues.append({"dimension": "作者写作偏好", "severity": "high", "quote": counts[0],
                       "problem": f"出现 {len(counts)} 处“看了两遍、试了两次”这类具体的多次数，作者明确禁用：" + "；".join(dict.fromkeys(counts[:MAX_QUOTES])),
                       "suggestion": "改成一次（看了一眼、认真看了一遍）或模糊的“几遍、几声、好几次”。顺序词、成语和事实性的数不用改。"})
    dashes = [_snippet(text, m.start(), m.end()) for m in _DASH.finditer(text)]
    if dashes:
        issues.append({"dimension": "作者写作偏好", "severity": "high", "quote": dashes[0],
                       "problem": f"出现 {len(dashes)} 处破折号，作者要求正文和台词都不用：" + "；".join(dict.fromkeys(dashes[:MAX_QUOTES])),
                       "suggestion": "改成逗号、句号，或把话说完整。台词里的省略号保留，不要一起删掉。"})
    splits = [_span(text, m.start(), m.end()) for m in _SPLIT_TAG.finditer(text)]
    if splits:
        issues.append({"dimension": "作者写作偏好", "severity": "high", "quote": splits[0],
                       "problem": f"出现 {len(splits)} 处把一句台词劈成两半、中间夹说话人和动作的写法，作者明确不要：" + "；".join(dict.fromkeys(splits[:MAX_QUOTES])),
                       "suggestion": "整句台词放在一起，人物和动作放在前面或后面（他往树干上一靠：“抓吧，你抓着我踏实。”），或拆成两句分开写。"})
    # “咚，咚，咚”这类重复是有意的节奏，不算排列。
    lists = [_snippet(text, m.start(), m.end()) for m in _SHORT_LIST.finditer(narration)
             if len(set(parts := m.group().split("，"))) == len(parts)]
    if lists:
        issues.append({"dimension": "作者写作偏好", "severity": "high", "quote": lists[0],
                       "problem": f"出现 {len(lists)} 处用逗号把几个短词一顿一顿排开，读着像报菜名：" + "；".join(dict.fromkeys(lists[:MAX_QUOTES])),
                       "suggestion": "并列的东西用顿号（饼子、炖肉、灵果，满满一桌）；先后做的几个动作并成一句顺口的话。"})
    return issues


def merge(review: dict, text: str) -> dict:
    """把规则问题放在模型问题前面；有规则问题就不能判通过。review 为审稿 JSON（passed、score、summary、issues）。"""
    found = lint(text)
    if not found:
        return review
    return {**review, "passed": False, "issues": (found + list(review.get("issues") or []))[:20]}
