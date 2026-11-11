"""智能体自己写的 Python 工具：静态检查、全书只读快照、在独立子进程里限时运行。

脚本只能读书、算东西、返回结果，不能改书、读写文件、联网或起进程；要改书仍用原有的可撤销修改工具。
限制分两层：这里先按语法树拒绝危险写法，子进程（agent_sandbox_runner）再用受限内置函数和审计钩子兜底。
这不是操作系统级的隔离：它防的是模型写错或被书里的文字诱导，不是专门的恶意攻击者。
"""

from __future__ import annotations

import ast
import asyncio
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import weakref
from contextlib import suppress
from pathlib import Path

from backend.api.error_protocol import DomainApiError

RUNNER = Path(__file__).with_name("agent_sandbox_runner.py")
ALLOWED_MODULES = {"re", "math", "statistics", "collections", "itertools", "functools", "difflib", "json", "string",
                   "unicodedata", "datetime", "random", "heapq", "bisect", "textwrap", "operator", "fractions", "decimal"}
FORBIDDEN_NAMES = {"eval", "exec", "compile", "open", "input", "breakpoint", "globals", "locals", "vars", "dir", "getattr",
                   "setattr", "delattr", "hasattr", "memoryview", "help", "exit", "quit", "type", "super", "classmethod",
                   "staticmethod", "property", "__import__", "__builtins__", "__loader__", "__spec__"}
MAX_SOURCE = 20000
DEFAULT_SECONDS = 60
MAX_SECONDS = 300
MAX_RESULT_CHARS = 40000
# 脚本子进程的内存上限（MB）：够处理上百万字的书，又不会把作者的电脑拖垮。
MEMORY_MB = 1024
TOOL_NAME = re.compile(r"^my_[a-z][a-z0-9_]{1,40}$")
# 能按名字字符串取属性或调用方法的入口：名字是运行时拼出来的，静态检查看不到，等于绕开“不能碰下划线属性”。
# 帧、代码对象、生成器内部状态的属性：能从这里摸到宿主的全局变量。
FORBIDDEN_ATTRS = {"attrgetter", "methodcaller", "Formatter", "get_field", "vformat", "format_map", "mro",
                   "gi_frame", "gi_code", "gi_yieldfrom", "gi_running", "cr_frame", "cr_code", "cr_await", "ag_frame", "ag_code", "ag_await",
                   "f_back", "f_globals", "f_locals", "f_builtins", "f_code", "f_trace", "tb_frame", "tb_next", "tb_lasti",
                   "co_code", "co_consts", "co_names", "co_varnames", "func_globals", "with_traceback"}
_FORMAT_FIELD = re.compile(r"\{[^{}]*?[.\[]\s*_")
# 每本书只缓存最近用到的几份快照：长篇一份就是几 MB。
SNAPSHOT_CACHE = 3
_snapshots: dict[str, tuple[str, bytes]] = {}
SOURCE_HINT = "脚本只能读取 book 并计算；字符串格式化请用 f-string；改书请用原有的修改工具。"


def _source_error(node: ast.AST | None, problem: str) -> DomainApiError:
    line = getattr(node, "lineno", None)
    where = f"脚本第 {line} 行：" if line else "脚本："
    return DomainApiError("AGENT_TOOL_SOURCE", f"{where}{problem}。{SOURCE_HINT}")


def _check_node(node: ast.AST) -> str:
    """一个语法节点的问题；没有问题返回空字符串。"""
    if isinstance(node, (ast.Import, ast.ImportFrom)):
        if isinstance(node, ast.ImportFrom) and node.level:
            return "不能相对导入"
        names = [alias.name for alias in node.names] if isinstance(node, ast.Import) else [node.module or ""]
        bad = [name for name in names if name.split(".")[0] not in ALLOWED_MODULES]
        if bad:
            return f"不能导入 {'、'.join(bad)}；可用的模块：{'、'.join(sorted(ALLOWED_MODULES))}"
        if isinstance(node, ast.ImportFrom):
            bad = [alias.name for alias in node.names if alias.name == "*" or alias.name.startswith("_") or alias.name in FORBIDDEN_ATTRS]
            if bad:
                return f"不能从模块导入 {'、'.join(bad)}"
    elif isinstance(node, ast.Name):
        if node.id in FORBIDDEN_NAMES:
            return f"不能使用 {node.id}"
        if node.id.startswith("__") and node.id != "__name__":
            return f"不能使用双下划线开头的名字 {node.id}"
    elif isinstance(node, ast.Attribute):
        if node.attr.startswith("_"):
            return f"不能访问下划线开头的属性 .{node.attr}"
        if node.attr in FORBIDDEN_ATTRS:
            return f"不能使用 .{node.attr}（它能按字符串取任意属性或摸到解释器内部）"
        if node.attr == "format" and not (isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)):
            return "只能对字面字符串调用 .format（例如 \"第{}章\".format(n)），或者改用 f-string"
    elif isinstance(node, ast.Constant) and isinstance(node.value, (str, bytes)):
        text = node.value if isinstance(node.value, str) else node.value.decode("latin-1")
        if "__" in text:
            return "字符串里不能出现双下划线"
        if _FORMAT_FIELD.search(text):
            return "格式字符串里不能用 .或[] 取下划线开头的属性"
    elif isinstance(node, ast.MatchClass):
        bad = [name for name in node.kwd_attrs if name.startswith("_") or name in FORBIDDEN_ATTRS]
        if bad:
            return f"match 语句不能匹配属性 {'、'.join(bad)}"
    elif isinstance(node, (ast.FunctionDef, ast.ClassDef)):
        if any(isinstance(item, ast.keyword) and item.arg == "metaclass" for item in getattr(node, "keywords", [])):
            return "不能指定 metaclass"
    elif isinstance(node, (ast.Global, ast.Nonlocal, ast.AsyncFunctionDef, ast.Await, ast.Yield, ast.YieldFrom, ast.AsyncFor, ast.AsyncWith)):
        return f"不能使用 {type(node).__name__}"
    return ""


def check_source(source: str) -> None:
    """拒绝危险写法：只能导入白名单模块，不能用执行代码、文件和反射类内置函数，不能碰下划线开头的属性，
    也不能用按字符串取属性的入口（operator.attrgetter、string.Formatter、非字面量的 str.format、match 的属性模式）。

    报错写明行号和改法，智能体能照着改好再试。
    """
    if not source.strip():
        raise _source_error(None, "脚本是空的")
    if len(source) > MAX_SOURCE:
        raise DomainApiError("AGENT_TOOL_SOURCE", f"脚本超过 {MAX_SOURCE} 字，请拆小")
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        detail = f"：{exc.text.strip()[:120]}" if exc.text else ""
        raise DomainApiError("AGENT_TOOL_SOURCE", f"脚本有语法错误：第 {exc.lineno} 行第 {exc.offset or '?'} 列 {exc.msg}{detail}") from exc
    run = next((node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "run"), None)
    if run is None:
        raise _source_error(None, "必须在最外层定义 def run(book, args):，返回值就是工具结果")
    positional = len(run.args.posonlyargs) + len(run.args.args)
    if positional < 2 and run.args.vararg is None:
        raise _source_error(run, "run 要接收两个参数：def run(book, args):（args 是调用时传入的参数字典）")
    for node in ast.walk(tree):
        problem = _check_node(node)
        if problem:
            raise _source_error(node, problem)


async def book_snapshot(novel_id: str, scope: dict | None = None) -> bytes:
    """全书只读快照（JSON 字节）：书名、各章章号/标题/正文/概要、大纲各章。按章节和大纲版本缓存，书没变就不重新读库。"""
    from backend.db.base import BaseRepository
    from backend.db.repositories.novel_repository import novel_repo
    from backend.db.utils import to_object_id
    from backend.services.novel import book_outline_service as outlines
    from backend.services.novel.chapter_service import ChapterService
    rows = await ChapterService.list_chapters(novel_id)
    outline_rows = await outlines.outlines.collection.find({"novel_id": to_object_id(novel_id), "is_deleted": False}).sort("chapter_number", 1).to_list(length=None)
    novel = await novel_repo.get_novel_by_id(novel_id)
    if scope is not None:
        rows = [row for row in rows if str(row["_id"]) in scope["chapters"]]
        outline_rows = [row for row in outline_rows if str(row["_id"]) in scope["outlines"]]
    # 章节版本不一定随概要、标题变化：一并算进缓存键。大纲正文已经读出来了，直接按内容算。
    key = hashlib.sha256(json.dumps([novel.get("title", "")]
                                    + [[str(row["_id"]), row.get("version"), row.get("title", ""), row.get("summary") or ""] for row in rows]
                                    + [[str(row["_id"]), row.get("title", ""), row.get("content") or ""] for row in outline_rows],
                                    ensure_ascii=False, default=str).encode("utf-8")).hexdigest()
    cached = _snapshots.get(novel_id)
    if cached and cached[0] == key:
        _snapshots[novel_id] = _snapshots.pop(novel_id)  # 移到最近使用
        return cached[1]
    contents = {}
    ids = [row["_id"] for row in rows]
    for start in range(0, len(ids), 200):
        async for doc in BaseRepository("chapters").collection.find({"_id": {"$in": ids[start:start + 200]}}, {"content": 1}):
            contents[doc["_id"]] = doc.get("content") or ""
    book = {"title": novel.get("title", ""),
            "chapters": [{"number": row["chapter_number"], "title": row["title"], "text": contents.get(row["_id"], ""),
                          "summary": row.get("summary") or ""} for row in rows],
            # 带上 id：上下文整理后智能体可能只剩脚本能查目录，没有 id 就没法用 edit_outline 改它找到的问题。
            "outline": [{"position": index, "id": str(row["_id"]), "title": row.get("title", ""), "text": row.get("content") or ""}
                        for index, row in enumerate(outline_rows, 1)]}
    data = json.dumps(book, ensure_ascii=False).encode("utf-8")
    _snapshots.pop(novel_id, None)
    _snapshots[novel_id] = (key, data)
    while len(_snapshots) > SNAPSHOT_CACHE:
        _snapshots.pop(next(iter(_snapshots)))
    return data


def _decode(done_stdout: bytes, stderr: bytes, returncode: int | None) -> dict:
    try:
        return json.loads(done_stdout.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        detail = stderr.decode("utf-8", errors="replace")[-1500:]
        if returncode not in (0, None) and not detail:
            detail = "可能是内存超过上限被系统结束。不要把整本书拼成一个大字符串，逐章处理并只保留统计结果"
        raise DomainApiError("AGENT_TOOL_CRASHED", f"脚本进程异常退出（代码 {returncode}）：{detail or '没有输出'}") from exc


MAX_PROCESSES = max(1, int(os.environ.get("NOVEL_AGENT_MAX_SANDBOX_PROCESSES", "2") or 2))
_process_gates: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore]" = weakref.WeakKeyDictionary()


def _process_gate() -> asyncio.Semaphore:
    """同时运行的脚本进程上限：每个进程内存上限 1GB，几段子智能体并行时不能一起开六七个。"""
    loop = asyncio.get_running_loop()
    gate = _process_gates.get(loop)
    if gate is None:
        gate = _process_gates[loop] = asyncio.Semaphore(MAX_PROCESSES)
    return gate


async def _execute_async(payload: bytes, seconds: int) -> dict:
    """在子进程里运行。超时或调用方被取消（作者停止任务）时立即结束子进程，不让它在后台继续跑满时限。"""
    async with _process_gate():
        return await _execute_once(payload, seconds)


async def _execute_once(payload: bytes, seconds: int) -> dict:
    env = {key: os.environ[key] for key in ("SYSTEMROOT", "WINDIR", "TEMP", "TMP") if key in os.environ}
    env.update({"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "PYTHONDONTWRITEBYTECODE": "1"})
    with tempfile.TemporaryDirectory(prefix="agent-tool-") as work:
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        process = subprocess.Popen([sys.executable, "-I", "-S", str(RUNNER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, cwd=work, env=env, creationflags=flags)
        try:
            stdout, stderr = await asyncio.to_thread(process.communicate, payload, seconds)
        except subprocess.TimeoutExpired as exc:
            process.kill()
            await asyncio.to_thread(process.communicate)
            raise DomainApiError("AGENT_TOOL_TIMEOUT", f"脚本运行超过 {seconds} 秒，已停止。请减少计算量（例如先用 args 限定章号范围），"
                                 f"或用 timeout_seconds 放宽（最多 {MAX_SECONDS} 秒）") from exc
        except BaseException:
            # 被取消时读线程还在 communicate 里：只结束进程并等它退出，读线程随之返回；不能再并发调用 communicate。
            process.kill()
            with suppress(BaseException):
                await asyncio.shield(asyncio.to_thread(process.wait, 10))
            raise
    return _decode(stdout, stderr, process.returncode)


def _execute(payload: bytes, seconds: int) -> dict:
    """同步版本，供测试和脚本直接调用。"""
    return asyncio.run(_execute_async(payload, seconds))


async def run_source(novel_id: str, source: str, args: dict | None = None, *, timeout_seconds: int | None = None, scope: dict | None = None) -> dict:
    """检查并运行一段脚本，返回 {ok, result, logs, error, error_lines, truncated}。结果太长时截断并标明，智能体可以让脚本只返回要点。"""
    check_source(source)
    seconds = max(1, min(int(timeout_seconds or DEFAULT_SECONDS), MAX_SECONDS))
    book = await book_snapshot(novel_id, scope)
    head = json.dumps({"source": source, "args": args or {}, "memory_mb": MEMORY_MB}, ensure_ascii=False).encode("utf-8")
    # 把快照直接拼进请求，避免为了加一个字段把整本书解码再编码一次。
    payload = head[:-1] + b',"book":' + book + b"}"
    outcome = await _execute_async(payload, seconds)
    text = json.dumps(outcome.get("result"), ensure_ascii=False, default=str)
    truncated = len(text) > MAX_RESULT_CHARS or bool(outcome.pop("oversized", False))
    if truncated:
        outcome["result"] = text[:MAX_RESULT_CHARS]
    outcome["truncated"] = truncated
    if truncated:
        outcome["notice"] = f"结果超过 {MAX_RESULT_CHARS} 字，只返回前段。让脚本只返回要点或分批返回（例如用 args 指定章号范围）。"
    if not outcome.get("ok") and outcome.get("error_lines"):
        where = "；".join(f"第 {item['line']} 行 `{item['code']}`" for item in outcome["error_lines"])
        outcome["hint"] = f"出错位置：{where}。改好后可以先用 run_script 试运行，再注册或保存。"
    return outcome


def check_tool_spec(name: str, description: str, parameters: dict | None) -> dict:
    """自造工具的名字、说明和参数表。参数表只支持简单类型，和内置工具用同一套校验。"""
    if not TOOL_NAME.match(name):
        raise DomainApiError("AGENT_TOOL_NAME", "自造工具的名字须以 my_ 开头，只用小写字母、数字和下划线，例如 my_count_names")
    if not description.strip():
        raise DomainApiError("AGENT_TOOL_NAME", "请写清这个工具做什么、返回什么")
    parameters = parameters or {}
    if not isinstance(parameters, dict):
        raise DomainApiError("AGENT_TOOL_PARAMS", "parameters 要写成对象，例如 {\"word\": {\"type\": \"string\", \"description\": \"要统计的字\"}}")
    required: list[str] = []
    # 模型常按 JSON Schema 整体写 {"type": "object", "properties": {...}, "required": [...]}：两种写法都接受。
    if isinstance(parameters.get("properties"), dict) and parameters.get("type", "object") == "object":
        required = [str(name) for name in parameters.get("required") or [] if isinstance(name, str)]
        parameters = parameters["properties"]
    if len(parameters) > 20:
        raise DomainApiError("AGENT_TOOL_PARAMS", "参数最多 20 个，请合并成数组或拆成两个工具")
    properties = {}
    for key, rule in parameters.items():
        if not re.match(r"^[a-z][a-z0-9_]{0,30}$", str(key)) or not isinstance(rule, dict):
            raise DomainApiError("AGENT_TOOL_PARAMS", f"参数 {key} 不对：参数名用小写字母和下划线，值写成 {{\"type\": \"string\", \"description\": \"…\"}}")
        kind = rule.get("type", "string")
        if kind not in {"string", "integer", "number", "boolean", "array"}:
            raise DomainApiError("AGENT_TOOL_PARAMS", f"参数 {key} 的类型只能是 string、integer、number、boolean 或 array（写的是 {kind}）")
        clean = {"type": kind, "description": str(rule.get("description", ""))[:300]}
        if kind == "array":
            item = (rule.get("items") or {}).get("type", "string")
            clean["items"] = {"type": item if item in {"string", "integer", "number"} else "string"}
        if kind in {"string", "integer", "number"} and isinstance(rule.get("enum"), list) and rule["enum"]:
            clean["enum"] = rule["enum"][:50]
        if kind in {"integer", "number"}:
            for bound in ("minimum", "maximum"):
                if type(rule.get(bound)) in (int, float):
                    clean[bound] = rule[bound]
        if rule.get("required") is True:
            required.append(key)
        properties[key] = clean
    unknown = [name for name in required if name not in properties]
    if unknown:
        raise DomainApiError("AGENT_TOOL_PARAMS", f"required 里的 {'、'.join(unknown)} 没有在参数表里定义")
    return {"type": "object", "additionalProperties": False, "properties": properties, "required": list(dict.fromkeys(required))}
