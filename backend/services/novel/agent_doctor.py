"""工具诊断智能体：工具库里的工具被标红后，查出原因并直接处理。

分四类，处理方式不同：
- 查阅范围（作者没关联世界观、章节不在范围内）：规则直接识别，不调用模型；标为已处理，告诉作者该开哪个设置。
- 内置工具用法错（参数传错、调用时机不对）：模型写一句用法经验，直接收进工具库，以后的任务会带上。
- 内置工具本身的问题或偶发超时：只写诊断报告。软件自己的代码不能被智能体改，改错了可能整个软件打不开。
- 智能体自造的工具：模型写出修好的版本，必须通过沙箱检查并试运行成功才替换。能力库里的工具生成新版本并直接启用，
  旧版本自动停用，作者可以在工具库里停用新版本；只属于某个任务的工具只替换那个任务里的版本，不进能力库。
每条记录最多自动诊断两次，作者点“已处理，重新统计”或工具成功调用后重新计数。
"""

from __future__ import annotations

import json
import re
from typing import Literal

from pydantic import BaseModel, Field, ValidationError

from backend.api.error_protocol import DomainApiError
from backend.db.utils import get_utc_now, to_object_id
from backend.llm.exceptions import LLMError
from backend.services.novel import agent_library

MAX_AUTO_ATTEMPTS = 2
REPAIR_TRIES = 2
_SETTING_HINTS = (
    (r"世界观", "这本书没有关联世界观。需要智能体查阅或修改世界观时，在全书智能体的任务设置里勾选“关联世界观”。"),
    (r"章节|章纲|前文", "智能体想读的章节或章纲不在你勾选的范围内。需要它读这些内容时，在任务设置里把对应章节或章纲勾选上。"),
    (r"参考书", "智能体想读的参考书没有关联。需要时在任务设置里添加这本参考书。"),
)


class BuiltinVerdict(BaseModel):
    kind: Literal["usage", "bug", "transient"]
    summary: str = Field(min_length=1, max_length=600)
    # kind 为 usage 时写给以后任务的一两句用法经验。
    lesson: str = Field(default="", max_length=agent_library.MAX_LESSON)


class CustomFix(BaseModel):
    summary: str = Field(min_length=1, max_length=600)
    description: str = Field(min_length=4, max_length=1000)
    source: str = Field(min_length=1, max_length=20000)
    parameters: dict = Field(default_factory=dict)
    test_args: dict = Field(default_factory=dict)


# 诊断进行中的标记超过这个时间就当作上次没跑完（软件被关掉了），允许重新诊断。
STALE_SECONDS = 600
SANDBOX_RULES = ("脚本定义 def run(book, args):，返回值就是工具结果。book 是只读的整本书：book['title']；book['chapters'] 每项有 number、title、text、summary；"
                 "book['outline'] 每项有 position、id、title、text。只能导入 re、math、statistics、collections、itertools、functools、difflib、json、string、"
                 "unicodedata、datetime、random、heapq、bisect、textwrap、operator、fractions、decimal；不能用 eval、exec、open、getattr 等，不能碰下划线开头的属性；"
                 "字符串格式化用 f-string。")


def setting_hint(error: str) -> str | None:
    """作者设定的查阅范围造成的拒绝：返回给作者的说明；不是这类问题返回 None。"""
    if not re.search(agent_library._SCOPE_REFUSAL, error or ""):
        return None
    return next((hint for pattern, hint in _SETTING_HINTS if re.search(pattern, error)), "智能体想读的内容不在你设定的查阅范围内，需要时在任务设置里调整关联范围。")


async def claim(issue_id: str, *, force: bool = False) -> dict | None:
    """原子地占下一条待诊断记录，避免并行的子智能体重复诊断同一个工具。自动诊断每条最多两次；作者手动诊断不限次数。"""
    from datetime import timedelta
    now = get_utc_now()
    query = {"_id": to_object_id(issue_id), "kind": "tool_issue", "status": "flagged",
             "$or": [{"doctor_running": {"$ne": True}}, {"doctor_started_at": {"$lt": now - timedelta(seconds=STALE_SECONDS)}}]}
    if not force:
        query["doctor_attempts"] = {"$not": {"$gte": MAX_AUTO_ATTEMPTS}}
    from pymongo import ReturnDocument
    return await agent_library.library.collection.find_one_and_update(
        query, {"$set": {"doctor_running": True, "doctor_started_at": now}, "$inc": {"doctor_attempts": 1}}, return_document=ReturnDocument.AFTER)


async def _finish(row: dict, kind: str, summary: str, fixed: bool, **extra) -> dict:
    now = get_utc_now()
    diagnosis = {"kind": kind, "summary": summary[:600], "fixed": fixed, "at": now, **extra}
    update = {"doctor_running": False, "diagnosis": diagnosis, "updated_at": now}
    if fixed:
        update.update(status="resolved", failure_count=0, doctor_attempts=0, reason="诊断智能体已处理：" + summary[:300])
    await agent_library.library.collection.update_one({"_id": row["_id"]}, {"$set": update})
    return {**diagnosis, "at": now.isoformat()}


def _builtin_prompt(row: dict, definition) -> str:
    schema = json.dumps(definition.parameters if definition else {}, ensure_ascii=False)
    return ("【工具诊断】写作智能体反复调用一个软件内置工具失败。判断原因：\n"
            "- usage：参数传错、漏传、调用时机不对，或想用这个工具做它不支持的事。写一两句给以后任务的用法经验（lesson），说清该怎么调用、什么时候不该调用。\n"
            "- bug：参数和用法都对，工具自己出错。\n- transient：超时、模型服务中断等偶发问题，工具和用法都没错。\n"
            "只依据下面的事实判断，不确定时选 bug。\n"
            f"【工具】{row['name']}\n【说明】{definition.description if definition else '（内置工具表里找不到这个名字，可能是模型编造的工具名）'}\n"
            f"【参数表】{schema}\n【最近一次失败时的参数】{json.dumps(row.get('last_args') or {}, ensure_ascii=False)[:3000]}\n"
            f"【最近错误】{row.get('last_error', '')[:2000]}\n【累计失败】{row.get('failure_count', 0)} 次\n"
            '只返回 JSON：{"kind":"usage|bug|transient","summary":"给作者看的一两句原因","lesson":"usage 时的用法经验"}。')


def _custom_prompt(row: dict, spec: dict, previous: str) -> str:
    return ("【修复自造工具】写作智能体自己写的一个工具反复调用失败。找出原因，写出修好的完整版本。\n"
            f"{SANDBOX_RULES}\n名字不变，用途不变；只改造成失败的地方。参数传法不合理时可以改参数表和说明，让调用方不容易传错。"
            "test_args 要能覆盖这次失败的情形。\n"
            f"【工具名】{spec['name']}\n【说明】{spec.get('description', '')}\n【参数表】{json.dumps(spec.get('parameters') or {}, ensure_ascii=False)}\n"
            f"【源码】\n{spec.get('source', '')}\n【失败时的参数】{json.dumps(row.get('last_args') or {}, ensure_ascii=False)[:3000]}\n"
            f"【最近错误】{row.get('last_error', '')[:2000]}\n"
            + (f"【上一次修复没通过】{previous}\n" if previous else "")
            + '只返回 JSON：{"summary":"给作者看的一两句原因和改法","description":"说明","source":"完整源码","parameters":{参数表},"test_args":{试运行参数}}。')


async def _repair(service, options: dict, novel_id: str, scope: dict | None, row: dict, spec: dict) -> tuple[dict | None, str]:
    """让模型写出修好的自造工具，通过沙箱检查并试运行成功才算修好；返回 (新工具, 说明)，没修好时新工具为 None。"""
    from backend.services.novel import agent_sandbox
    from backend.services.novel import writing_agent_loop as loop
    from backend.services.novel.writing_agent import _generate_json
    previous = ""
    for _ in range(REPAIR_TRIES):
        fix = await _generate_json(service, _custom_prompt(row, spec, previous), CustomFix, options)
        try:
            parameters = agent_sandbox.check_tool_spec(spec["name"], fix.description, fix.parameters)
            agent_sandbox.check_source(fix.source)
            # 失败时的参数在新参数表下仍然合法，就用它重跑一遍：修好的版本必须能处理当初失败的那次调用。
            runs = [fix.test_args]
            try:
                loop._check_object(parameters, row.get("last_args") or {})
                runs.append(row.get("last_args") or {})
            except DomainApiError:
                pass
            for args in runs:
                loop._check_object(parameters, args)
                outcome = await agent_sandbox.run_source(novel_id, fix.source, args, scope=scope)
                if not outcome.get("ok"):
                    raise DomainApiError("AGENT_DOCTOR_TEST", f"试运行出错：{outcome.get('error')} {outcome.get('hint', '')}".strip())
        except DomainApiError as exc:
            previous = exc.message[:1500]
            continue
        return {**spec, "description": fix.description, "source": fix.source, "parameters": parameters, "runs_ok": 1}, fix.summary
    return None, "修复版本没有通过沙箱检查或试运行：" + previous


async def _approve_lesson(row: dict, text: str) -> dict:
    entry = await agent_library.propose(str(row["novel_id"]), str(row.get("job_id") or row["novel_id"]), kind="lesson", scope="novel",
                                        reason=f"诊断智能体根据 {row['name']} 的反复失败总结", text=text)
    return await agent_library.decide(entry["id"], "approve")


async def _replace_job_tool(novel_id: str, job_id: str, spec: dict) -> None:
    """只属于某个任务的工具：替换那个任务保存的版本，任务继续时用修好的版本。"""
    from backend.services.novel import book_agent_store as store
    try:
        row = await store.get_job(novel_id, job_id)
    except DomainApiError:
        return  # 任务已经删掉了：没有要换的版本，诊断结果照常记在工具库里。
    tools = [spec if item.get("name") == spec["name"] else item for item in row.get("custom_tools") or []]
    await store.update_job(job_id, {"custom_tools": tools})


async def treat(row: dict, *, service, options: dict, scope: dict | None, spec: dict | None, write_job: bool) -> dict:
    """诊断一条已占下的记录并处理。spec 是自造工具当前的定义；内置工具为 None。返回诊断结果，修好的自造工具放在 "spec"。

    write_job 为真时（任务没在运行）把任务自己的工具直接换掉；任务正在运行时由调用方换掉内存里的版本。
    """
    novel_id = str(row["novel_id"])
    try:
        hint = setting_hint(row.get("last_error", ""))
        if hint:
            return await _finish(row, "setting", hint, True)
        if spec:
            fixed, summary = await _repair(service, options, novel_id, scope, row, spec)
            if fixed is None:
                return await _finish(row, "custom", summary, False)
            extra = {}
            if spec.get("library_id"):
                old = await agent_library.library.find_one({"_id": to_object_id(spec["library_id"])})
                entry = await agent_library.propose(novel_id, str(row.get("job_id") or novel_id), kind="tool", scope=(old or {}).get("scope", "novel"),
                                                    reason="诊断智能体修复：" + summary[:300], name=fixed["name"], description=fixed["description"],
                                                    source=fixed["source"], parameters=fixed["parameters"])
                entry = await agent_library.decide(entry["id"], "approve")
                fixed["library_id"], extra["version"] = entry["id"], entry["version"]
            elif write_job and row.get("job_id"):
                await _replace_job_tool(novel_id, str(row["job_id"]), fixed)
            result = await _finish(row, "custom", summary, True, **extra)
            return {**result, "spec": fixed}
        from backend.services.novel import book_agent
        from backend.services.novel.writing_agent import _generate_json
        definition = next((tool for tool in book_agent.TOOLS if tool.name == row["name"]), None)
        verdict = await _generate_json(service, _builtin_prompt(row, definition), BuiltinVerdict, options)
        if verdict.kind == "usage" and verdict.lesson.strip():
            await _approve_lesson(row, verdict.lesson.strip())
            return await _finish(row, "usage", verdict.summary, True, lesson=verdict.lesson.strip())
        if verdict.kind == "transient":
            return await _finish(row, "transient", verdict.summary + "（偶发问题，工具本身没坏，已重新计数）", True)
        return await _finish(row, "bug", verdict.summary + "（这是软件内置工具的问题，智能体不能改软件代码；可以把这段诊断发给开发者修复）", False)
    except (LLMError, ValidationError, ValueError, TimeoutError) as exc:
        return await _finish(row, "error", f"诊断没有完成：{type(exc).__name__}，可以稍后在工具库里点“诊断并修复”重试", False)
    except BaseException:
        await agent_library.library.collection.update_one({"_id": row["_id"]}, {"$set": {"doctor_running": False}})
        raise


async def run_inline(owner, issue: dict) -> str:
    """全书智能体运行中某个工具刚被标红时调用：当场诊断，修好的自造工具立刻换上。返回要附在这次工具结果里给模型看的说明。"""
    from backend.services.novel.writing_runtime import bounded
    row = await claim(issue["id"])
    if row is None:
        return ""
    await owner.rt.trace({"kind": "tool", "tool": "agent_doctor", "label": f"{row['name']} 连续失败 {row.get('failure_count', 0)} 次，诊断智能体正在查原因"})
    spec = owner.root.custom_tools.get(row["name"])
    try:
        result = await bounded(treat(row, service=owner.service, options=owner.options, scope=owner.scope, spec=spec, write_job=False), 300)
    except TimeoutError:
        await agent_library.library.collection.update_one({"_id": row["_id"]}, {"$set": {"doctor_running": False}})
        await owner.rt.trace({"kind": "tool", "tool": "agent_doctor", "label": "诊断超时，没有改动", "error": True})
        return ""
    if result.get("spec"):
        owner.root.custom_tools[row["name"]] = result["spec"]
        owner.revision += 1
        if not result["spec"].get("library_id"):
            await owner._save_tools()
    done = "已修好" if result["fixed"] else "没能自动修好"
    await owner.rt.trace({"kind": "tool", "tool": "agent_doctor", "label": f"诊断 {row['name']}：{done}。{result['summary']}"[:600], "error": not result["fixed"]})
    if result.get("spec"):
        return f"诊断智能体已修好工具 {row['name']}：{result['summary']}。用原来的参数再调用一次即可。"
    if result.get("lesson"):
        return f"诊断智能体的用法提醒：{result['lesson']}"
    if result["kind"] == "setting":
        return "这项内容不在作者设定的查阅范围内，不要再调用这个工具查它；需要时在报告里提醒作者调整任务设置。"
    return f"诊断：{result['summary']}。换一种办法完成任务，不要重复这个调用。"


async def diagnose_manual(novel_id: str, issue_id: str) -> dict:
    """作者在工具库里点“诊断并修复”：用出问题那个任务的模型和查阅范围诊断，不受自动诊断次数限制。"""
    from backend.services.llm.llm_service import LLMService
    from backend.services.novel import book_agent_store as store
    from backend.services.novel.book_agent import AgentSettings
    from backend.services.novel.book_agent_jobs import running_ids
    from backend.services.novel.book_references import reference_scope
    from backend.services.novel.writing_agent import generation_options
    from backend.services.novel.writing_runtime import bounded, close_clients
    issue = await agent_library.library.find_one({"_id": to_object_id(issue_id), "novel_id": to_object_id(novel_id), "kind": "tool_issue"})
    if issue is None:
        raise DomainApiError("AGENT_LIBRARY_NOT_FOUND", "这条工具库记录不存在或不属于本书", status_code=404)
    job_id = str(issue.get("job_id") or "")
    if job_id and job_id in running_ids():
        raise DomainApiError("AGENT_DOCTOR_RUNNING", "出问题的任务还在运行，它下次调用失败时会自动诊断；任务停下后再手动诊断", status_code=409)
    job = None
    if job_id:
        try:
            job = await store.get_job(novel_id, job_id)
        except DomainApiError:
            job = None
    settings = AgentSettings.model_validate((job or {}).get("settings") or {})
    scope = {"chapters": set(settings.chapter_ids), "outlines": set(settings.outline_ids), "worldview": settings.use_worldview,
             "reference_books": reference_scope(settings.reference_books)}
    spec = next((item for item in (job or {}).get("custom_tools") or [] if item.get("name") == issue["name"]), None)
    if spec is None and issue.get("source"):
        spec = {"name": issue["name"], "description": issue.get("description", ""), "source": issue["source"],
                "parameters": issue.get("parameters") or {"type": "object", "properties": {}, "required": []}}
        if issue.get("library_id"):
            spec["library_id"] = issue["library_id"]
    if issue.get("status") != "flagged":
        raise DomainApiError("AGENT_DOCTOR_NOT_FLAGGED", "这个工具现在没有标红，不需要诊断", status_code=409)
    row = await claim(issue_id, force=True)
    if row is None:
        raise DomainApiError("AGENT_DOCTOR_BUSY", "这个工具正在诊断，请稍后刷新工具库查看结果", status_code=409)
    service = LLMService(provider_name=settings.provider or None)
    try:
        result = await bounded(treat(row, service=service, options=generation_options(settings), scope=scope, spec=spec, write_job=bool(job)), 300)
    except TimeoutError:
        await agent_library.library.collection.update_one({"_id": row["_id"]}, {"$set": {"doctor_running": False}})
        raise DomainApiError("AGENT_DOCTOR_TIMEOUT", "诊断超时，请稍后重试", status_code=504)
    finally:
        await close_clients(getattr(service, "_client", None))
    result.pop("spec", None)
    return result
