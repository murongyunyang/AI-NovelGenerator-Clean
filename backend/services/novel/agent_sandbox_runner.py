"""智能体自造工具的子进程执行器。由 agent_sandbox 用 `python -I -S 本文件` 启动，不导入项目里的任何模块。

stdin 收一个 JSON：{"source": 代码, "args": 参数, "book": 全书只读快照, "memory_mb": 内存上限}；
stdout 回一个 JSON：{"ok", "result", "logs", "error", "error_lines", "limits"}。
代码在宿主进程已经做过静态检查；这里再做运行时限制：
1. 操作系统层：Windows 上把本进程放进作业对象（不能再起子进程、内存有上限，进程退出时作业一并关闭）；其他系统限制地址空间。
2. 内置函数只留安全的一组，`__import__` 只认预先载入的白名单模块。
3. 审计钩子：打开文件、起进程、联网、加载动态库、再次编译执行代码、取帧对象都会被拦下。钩子装上后无法移除；
   拦截名单写成钩子函数里的常量，脚本即使拿到本模块也改不了它（以前放在模块全局变量里，能被改掉后整个钩子失效）。
"""

import json
import sys

ALLOWED_MODULES = ("re", "math", "statistics", "collections", "itertools", "functools", "difflib", "json", "string",
                   "unicodedata", "datetime", "random", "heapq", "bisect", "textwrap", "operator", "fractions", "decimal")
SAFE_BUILTINS = ("abs", "all", "any", "ascii", "bin", "bool", "bytes", "callable", "chr", "complex", "dict", "divmod", "enumerate",
                 "filter", "float", "format", "frozenset", "hash", "hex", "int", "isinstance", "issubclass", "iter", "len", "list",
                 "map", "max", "min", "next", "object", "oct", "ord", "pow", "range", "repr", "reversed", "round", "set", "slice",
                 "sorted", "str", "sum", "tuple", "zip", "Exception", "ValueError", "KeyError", "IndexError", "TypeError",
                 "ZeroDivisionError", "StopIteration", "RuntimeError", "ArithmeticError", "LookupError", "AssertionError",
                 "NotImplementedError", "True", "False", "None")
MAX_LOG_LINES = 200
MAX_LOG_CHARS = 20000
# 回给宿主的整份结果上限；宿主还会再截到给模型看的长度。防止脚本把整本书原样返回撑爆宿主内存。
MAX_OUTPUT_CHARS = 1_000_000
DEFAULT_MEMORY_MB = 1024


def _limit_process(memory_mb: int) -> str:
    """操作系统层的限制。做不到时如实返回原因，脚本照常在其余几层限制下运行。"""
    limit = max(64, int(memory_mb)) * 1024 * 1024
    try:
        if sys.platform == "win32":
            import ctypes
            from ctypes import wintypes

            class Basic(ctypes.Structure):
                _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                            ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                            ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                            ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

            class Counters(ctypes.Structure):
                _fields_ = [(name, ctypes.c_ulonglong) for name in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                                                                     "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

            class Extended(ctypes.Structure):
                _fields_ = [("BasicLimitInformation", Basic), ("IoInfo", Counters), ("ProcessMemoryLimit", ctypes.c_size_t),
                            ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.CreateJobObjectW.restype = wintypes.HANDLE
            kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
            kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
            kernel32.GetCurrentProcess.restype = wintypes.HANDLE
            kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
            job = kernel32.CreateJobObjectW(None, None)
            if not job:
                return "无法创建作业对象"
            info = Extended()
            # 进程内存上限 | 活动进程数上限（只有自己，起不了子进程） | 作业句柄关闭时结束进程
            info.BasicLimitInformation.LimitFlags = 0x100 | 0x8 | 0x2000
            info.BasicLimitInformation.ActiveProcessLimit = 1
            info.ProcessMemoryLimit = limit
            if not kernel32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
                return "无法设置作业对象限制"
            if not kernel32.AssignProcessToJobObject(job, kernel32.GetCurrentProcess()):
                return "无法加入作业对象"
            # 作业句柄故意不关：进程结束时系统回收。
            return f"内存上限 {memory_mb} MB，禁止子进程"
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
        return f"内存上限 {memory_mb} MB"
    except Exception as exc:  # 限制失败不影响运行，宿主在结果里看得到
        return f"操作系统层限制不可用：{type(exc).__name__}"
    finally:
        # 不给脚本留下现成的 ctypes；之后再导入会被审计钩子拦下。
        for name in [name for name in sys.modules if name == "ctypes" or name.startswith(("ctypes.", "_ctypes"))]:
            sys.modules.pop(name, None)


def _jsonable(value):
    """结果里的集合、元组等转成列表，其余转成字符串，保证结果能交回给智能体。"""
    if isinstance(value, (set, frozenset)):
        try:
            return sorted(value)
        except TypeError:
            return list(value)
    if isinstance(value, tuple):
        return list(value)
    return str(value)


def main() -> None:
    raw = sys.stdin.buffer.read()
    request = json.loads(raw.decode("utf-8"))
    source = request["source"]
    limits = _limit_process(request.get("memory_mb") or DEFAULT_MEMORY_MB)
    # 白名单模块在装审计钩子之前全部导入：它们内部的延迟导入此时完成，之后代码里的 import 只是取已经加载好的模块。
    modules = {}
    for name in ALLOWED_MODULES:
        modules[name] = __import__(name)
    # datetime.strptime 在 C 代码里经由 __import__ 取 _strptime：提前载入并放进可取列表（静态检查仍不允许脚本自己导入它）。
    modules["_strptime"] = __import__("_strptime")
    real_builtins = __builtins__ if isinstance(__builtins__, dict) else __builtins__.__dict__
    logs: list[str] = []
    size = [0]

    def safe_import(name, globals=None, locals=None, fromlist=(), level=0):
        root = name.split(".")[0]
        if level or root not in modules:
            raise ImportError(f"脚本只能导入这些模块：{'、'.join(ALLOWED_MODULES)}")
        module = modules[root]
        if "." in name and not fromlist:
            return module
        for part in name.split(".")[1:]:
            module = getattr(module, part)
        return module

    def safe_print(*values, sep=" ", end="\n", **_):
        text = sep.join(str(value) for value in values) + end
        if len(logs) < MAX_LOG_LINES and size[0] < MAX_LOG_CHARS:
            logs.append(text[:MAX_LOG_CHARS - size[0]])
            size[0] += len(text)

    builtins = {name: real_builtins[name] for name in SAFE_BUILTINS if name in real_builtins}
    builtins.update({"__import__": safe_import, "print": safe_print, "__build_class__": real_builtins["__build_class__"], "__name__": "agent_tool"})
    scope = {"__builtins__": builtins, "__name__": "agent_tool"}
    # 编译放在装钩子之前，钩子随后拦下任何再次编译或执行代码的企图。
    code = compile(source, "<agent-tool>", "exec")

    # state[0]：脚本本身的那一次 exec 是否已放行；state[1]：宿主自己整理报错行号时临时允许读帧（期间不运行脚本的代码）。
    state = [False, False]

    def audit(event, _args, state=state, deny=PermissionError):
        if event == "exec" and not state[0]:
            state[0] = True  # 只放行下面这一次执行脚本本身
            return
        if state[1] and event == "object.__getattr__":
            return
        # 名单是函数里的常量：脚本拿到本模块、改掉模块变量也影响不了这里。
        if event.startswith(("open", "os.", "subprocess", "socket", "shutil", "ctypes", "winreg", "_winapi", "msvcrt", "sys._getframe",
                             "sys.setprofile", "sys.settrace", "sys._current_frames", "sys.addaudithook", "gc.", "object.__getattr__",
                             "object.__setattr__", "object.__delattr__", "code.__new__", "function.__new__", "cpython.run_", "compile", "exec",
                             "import", "urllib", "http", "ftplib", "smtplib", "webbrowser", "pathlib", "glob", "tempfile", "mmap", "signal",
                             "_thread", "threading", "sqlite3", "marshal", "pickle", "builtins.input", "time.sleep", "resource",
                             "_posixsubprocess", "pty", "fcntl", "syslog", "ensurepip", "venv", "shelve", "dbm", "zipimport", "imaplib",
                             "poplib", "nntplib", "telnetlib")):
            raise deny(f"脚本不允许执行这个操作（{event}）：只能读取传进来的书的数据并计算")

    sys.addaudithook(audit)
    outcome = {"ok": False, "result": None, "logs": logs, "error": "", "limits": limits}
    try:
        exec(code, scope)  # noqa: S102 - 代码已通过静态检查，运行在受限内置函数与审计钩子下
        run = scope.get("run")
        if not callable(run):
            raise TypeError("脚本必须定义 run(book, args) 函数")
        outcome["result"] = run(request["book"], request.get("args") or {})
        outcome["ok"] = True
    except BaseException as exc:  # 脚本的任何错误都原样告诉智能体，让它自己改
        lines = []
        # 先取出错位置（只读 C 层的回溯对象，不调用脚本自己的代码），再取错误文字（可能调用脚本定义的 __str__）。
        state[1] = True
        try:
            trace = sys.exc_info()[2]
            while trace is not None:
                if trace.tb_frame.f_code.co_filename == "<agent-tool>":
                    lines.append(trace.tb_lineno)
                trace = trace.tb_next
        except Exception:
            lines = []
        finally:
            state[1] = False
        source_lines = source.splitlines()
        outcome["error_lines"] = [{"line": number, "code": source_lines[number - 1].strip()[:200] if 0 < number <= len(source_lines) else ""}
                                  for number in lines[-3:]]
        try:
            text = f"{type(exc).__name__}: {exc}"
        except BaseException:
            text = type(exc).__name__
        if isinstance(exc, MemoryError):
            text = "MemoryError: 脚本用的内存超过上限。不要把整本书拼成一个大字符串或复制多份，逐章处理并只保留统计结果"
        outcome["error"] = text[:2000]
    try:
        data = json.dumps(outcome, ensure_ascii=False, default=_jsonable)
    except BaseException as exc:
        outcome.update(ok=False, result=None, error=f"结果无法转成 JSON：{type(exc).__name__}。请只返回字符串、数字、列表和字典")
        data = json.dumps(outcome, ensure_ascii=False, default=str)
    if len(data) > MAX_OUTPUT_CHARS:
        head = json.dumps(outcome["result"], ensure_ascii=False, default=_jsonable)[:MAX_OUTPUT_CHARS // 2]
        outcome.update(result=head, oversized=True)
        data = json.dumps(outcome, ensure_ascii=False, default=str)
    sys.stdout.buffer.write(data.encode("utf-8"))
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
