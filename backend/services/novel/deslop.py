"""Claude Code 去AI味：章节写完、审完之后，按 oh-story-claudecode 的 story-deslop 方法再改一轮。

方法来源：oh-story-claudecode 的 skills/story-deslop（MIT License，Copyright (c) 2025-2026 oh-story-claudecode），
把它的表达、用笔、故事三层方法压缩成一份提示词，规则检测见 deslop_scan。
与原 skill 一致的边界：
- 表达和用笔直接改；故事层缺口（缺动机、缺因果、缺成立条件）只报告给作者，不替作者补剧情；
- 用精确补丁改，未涉及的段落逐字保留，不整章重写；
- 改完复扫，只为剩下的必改问题再改，全文最多三轮；
- 去味是附加步骤，模型出错或改坏了就保留去味前的稿子，不影响交付。
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextlib import aclosing

from pydantic import BaseModel, Field, ValidationError

from backend.llm.exceptions import LLMError
from backend.api.error_protocol import DomainApiError
from backend.llm.usage import usage_meter
from backend.services.novel import deslop_scan
from backend.services.novel.output_filter import clean_prose_output
from backend.services.novel.writing_runtime import watch

MAX_ROUNDS = 3
# 先于外层 240 秒静默保护收尾；有真实流量时继续等，心跳不算进展。
ROUND_IDLE_SECONDS = 180.0
ROUND_TOTAL_SECONDS = 1800.0
# 一轮补丁最多删掉三成正文；超过多半是模型把整段剧情删了，整轮作废。
MIN_KEEP = 0.7
SOURCE = "oh-story-claudecode / story-deslop"


class Patch(BaseModel):
    old: str = Field(min_length=1)
    new: str


class Result(BaseModel):
    patches: list[Patch] = Field(default_factory=list, max_length=40)
    # 故事层缺口：需要作者决定的剧情问题，只报告不改。
    gaps: list[str] = Field(default_factory=list, max_length=10)


METHOD = """【去AI味方法（Claude Code story-deslop，三层都查，每层可以没有问题）】
一、表达：同一事实怎样说。
- 先治电报体：每个分句都重新报一项状态、读着像清单的段落，找出这段在写哪次行动，围绕主干重组，背景、条件、缘由嵌进需要它的动作里；短对白、新线索、判断变化和有意留白可以分步写。
- 否定铺垫后翻转（不是A，而是B；没有X，没有Y，只有Z）：先否定了一个没人在意的靶子，就直接写B；在纠错、辩解、排除猜测时保留。
- 工整并列只重复同一个结论就合并；“带着一丝……”“声音不大，却不容置疑”这类给谁都能用的套式声线，只留能分辨的语气；普通的“说”不必换成微动作。
- 普通名词加引号强调（“机会”“答案”）去掉引号；只抬高语气的模板比喻和抽象大词（潮水般涌来、命运的齿轮）压回准确描述，有新认识的比喻保留。
- 情绪可以直写。身体反应逐处做删除测试：删掉后不损失感受、人物特点、关系或后果的（指节泛白、喉结滚动、目光移开），删掉，不换个部位再写一遍。
- 把刚发生的事再翻译成结论、用“这意味着”“真正重要的是”把意义说满的，删重复部分；补足因果、用途、情绪来由的解释保留。
- 台词按说话人此刻的身份、对象和意图读；不靠加粗话、口头禅、口误制造真人感，不改变原来的交际目的。
- 破折号按功能改：打断改成动作或短句，拖长音删去，插入说明改逗号、冒号。章尾不替读者预告或盖章（没人知道、才刚刚开始、这一夜注定），停在具体动作、画面或台词上。
二、用笔：篇幅落在值得经历的地方。
- 先用一句话想清这场戏要让读者经历什么，再看实际篇幅。开门、倒水、赶路、逐件清点这类不改变处境的过程压成必要承接。
- 关键过程被“商量妥了”“她终于想通了”一句带过时，用原文已有的条件、试探和反馈展开；原文没有依据的，按故事层报告，不编理由。
- 同一情绪原地打转（反复写害怕、沉默）合并；群像轮流吃惊、后退只留有立场的人。逐件同精度陈列的环境和无功能装饰压缩。
三、故事：行为和因果是否成立（只诊断）。
- 看人物依据当时所知为什么这样选，后件由前件哪个条件触发，对方有没有自己的理由，办法和结果有没有前文支撑，谁在何时知道什么。
- 可以直接修：能核实的指代、主体、时序笔误；恢复原文已有的因果和信息来源承接。
- 需要作者决定的（缺动机、缺成立条件、临时冒出的证据或能力）写进 gaps：写明原文哪处、缺什么、最小改法，不改正文。
边界：不改事件、人物决定、胜负、关系走向和揭露顺序；不新增事实、人物、证据、微动作或冲突；保留作者的直白写法、心理活动、吐槽和有功能的停顿。作者偏好与这份方法冲突时以作者偏好为准。"""


def _prompt(draft: str, targets: list[dict], notes_text: str, round_no: int) -> str:
    listed = "\n".join(f"- [{item['type']}] {item['excerpt']}：{item['message']}" for item in targets) or "（规则检测没有命中；仍按三层方法通读检查）"
    scope = ("本轮任务：按上面的方法通读全章，三层都查，改掉表达和用笔问题，并把下列规则命中全部改掉。" if round_no == 1 else
             "本轮任务：上一轮改完后复扫，下列规则命中仍在。只改这些问题和改动带出的直接衔接，不另起一次全文修改。")
    return (f"{METHOD}\n\n【本次去痕要求】\n{notes_text or '（暂无，保留原文风格）'}\n\n"
            f"【必须改掉的规则命中（保留这句的叙事功能，换一种写法）】\n{listed}\n\n{scope}\n\n"
            f"【当前正文】\n{draft}\n\n"
            "用精确补丁修改：old 必须逐字出现在当前正文里且只出现一次，取完整的一句或几句，保证唯一；new 是替换后的文字，删除就给空字符串。"
            "没提到的段落保持原样，不要用一个补丁覆盖大段无关正文。没有需要改的就返回空 patches。"
            '只返回 JSON：{"patches":[{"old":"原文","new":"改后"}],"gaps":["故事层需要作者决定的问题"]}。')


def _apply(draft: str, patches: list[Patch]) -> tuple[str, int, int]:
    """逐个应用补丁；对不上原文或原文不唯一的跳过，不让一处失配废掉整轮。"""
    applied = skipped = 0
    for patch in patches:
        if patch.old == patch.new or draft.count(patch.old) != 1:
            skipped += patch.old != patch.new
            continue
        draft, applied = draft.replace(patch.old, patch.new, 1), applied + 1
    return draft, applied, skipped


def must_fix(text: str) -> list[dict]:
    """只检查去痕方法自身的规则，不混入软件的通用文风偏好。"""
    return deslop_scan.scan(text)


def _trace(label: str, error: bool = False) -> dict:
    return {"event": "trace", "kind": "tool", "tool": "deslop", "label": label, **({"error": True} if error else {})}


async def polish(service, draft: str, notes_text: str, options: dict, *, max_rounds: int = MAX_ROUNDS) -> AsyncIterator[dict]:
    """去味一章。产出 progress、trace、replacement 事件，最后一个事件是 {"event": "_deslop", "text", "log"}。"""
    from backend.services.novel.writing_agent import _generate_json
    if not 1 <= max_rounds <= MAX_ROUNDS:
        raise ValueError("去痕轮数必须在 1 到 3 之间")
    found = must_fix(draft)
    log = {"source": SOURCE, "before": len(found), "rounds": [], "gaps": [], "remaining": [], "stopped_reason": ""}
    text = draft
    for round_no in range(1, max_rounds + 1):
        targets = [item for item in found if item["fixable"]]
        if round_no > 1 and not targets:
            break
        yield {"event": "progress", "message": f"Claude Code 去AI味：第 {round_no} 轮" + ("，按表达、用笔、故事三层通读…" if round_no == 1 else f"，还有 {len(targets)} 处必改问题…")}
        try:
            async def generate():
                result = await _generate_json(service, _prompt(text, targets, notes_text, round_no), Result, options)
                yield {"event": "done", "result": result}

            # JSON 收齐前不向正文发送半截补丁；底层真实流量通过 meter.touched 保活。
            async with aclosing(watch(generate(), idle=ROUND_IDLE_SECONDS, total=ROUND_TOTAL_SECONDS,
                                     meter=usage_meter.get(), usage_events=False)) as monitored:
                async for event in monitored:
                    if event["event"] == "done":
                        result = event["result"]
        except (ValueError, ValidationError, LLMError, TimeoutError, DomainApiError) as exc:
            if isinstance(exc, DomainApiError) and exc.code != "WRITING_TIMEOUT":
                raise
            log["stopped_reason"] = "去味模型没有返回可用结果，保留当前稿"
            yield _trace(f"去AI味第 {round_no} 轮没有完成（{type(exc).__name__}），保留当前稿", error=True)
            break
        log["gaps"] = list(dict.fromkeys([*log["gaps"], *(gap.strip() for gap in result.gaps if gap.strip())]))[:10]
        revised, applied, skipped = _apply(text, result.patches)
        record = {"round": round_no, "targets": len(targets), "patches": len(result.patches), "applied": applied, "skipped": skipped, "accepted": False}
        log["rounds"].append(record)
        if not applied:
            log["stopped_reason"] = "去味模型认为不需要再改" if not result.patches else "补丁都对不上原文，保留当前稿"
            yield _trace(f"去AI味第 {round_no} 轮：{log['stopped_reason']}", error=bool(result.patches))
            break
        try:
            revised = clean_prose_output(revised).strip(" \t\r\n")
        except ValueError:
            revised = ""
        after = must_fix(revised) if revised else found
        if not revised or len(revised) < len(text) * MIN_KEEP:
            log["stopped_reason"] = "这一轮删得太多，可能删掉了剧情，已作废并保留上一稿"
        elif sum(item["fixable"] for item in after) > sum(item["fixable"] for item in found):
            log["stopped_reason"] = "这一轮改出了更多必改问题，已作废并保留上一稿"
        else:
            record["accepted"], text, found = True, revised, after
            yield {"event": "replacement", "text": text}
            yield _trace(f"去AI味第 {round_no} 轮：改了 {applied} 处" + (f"，{skipped} 处对不上原文已跳过" if skipped else "") + f"，复扫剩 {len(found)} 处必改问题")
            continue
        yield _trace(f"去AI味第 {round_no} 轮：{log['stopped_reason']}", error=True)
        break
    log["after"] = len(found)
    log["remaining"] = [{"type": item["type"], "excerpt": item["excerpt"], "message": item["message"]} for item in found][:20]
    if not log["stopped_reason"]:
        log["stopped_reason"] = "复扫没有必改问题" if not found else f"已改 {max_rounds} 轮，还剩 {len(found)} 处，请作者查看"
    if log["gaps"]:
        yield _trace("去AI味发现需要作者决定的剧情问题（没有改正文）：" + "；".join(log["gaps"])[:600])
    yield {"event": "_deslop", "text": text, "log": log}


async def wrap(steps: AsyncIterator[dict], service, notes_text: str, options: dict) -> AsyncIterator[dict]:
    """包住任一写作流程的事件流：拦下 done，先去味一轮，再把去味后的稿子和记录放进 done 交出去。"""
    async with aclosing(steps) as running:
        async for event in running:
            if event.get("event") != "done" or not str(event.get("text", "")).strip():
                yield event
                continue
            text = event["text"]
            async with aclosing(polish(service, text, notes_text, options)) as polishing:
                async for item in polishing:
                    if item["event"] == "_deslop":
                        text = item["text"]
                        event = {**event, "text": text, "review_log": {**(event.get("review_log") or {}), "deslop": item["log"]}}
                    else:
                        yield item
            yield event
