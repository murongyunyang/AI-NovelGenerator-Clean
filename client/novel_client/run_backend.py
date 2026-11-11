"""以子进程方式运行原项目后端：等同于在项目根目录执行 python main.py。

内置 Python 使用 ._pth 文件，不会自动把工作目录加入 sys.path，所以在这里手动加入。

启动提速：数据库和后端是同时启动的。后端先把自己的代码加载好（占大部分时间），再等数据库可写，
然后才真正开始服务，所以数据库启动的时间被后端加载的时间盖住了。
"""

import os
import runpy
import sys
import time
import faulthandler

# 内置 Python 的 ._pth 不自动加入脚本父目录；直接执行和测试导入均可用。
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from novel_client.startup_trace import trace

MONGO_URL_ENV = "NOVEL_GENERATOR_MONGODB_URL"
MONGO_WAIT_ENV = "NOVEL_CLIENT_MONGO_WAIT_SECONDS"
PRELOAD_ENV = "NOVEL_CLIENT_PRELOAD_MODULE"
DEFAULT_PRELOAD = "backend.app"
DEFAULT_MONGO_WAIT = 90.0
# 写进后端日志的两个进度标记：代码加载完、数据库已可写（或等待结束）。客户端启动页据此推进“后端服务”这条进度（services.BackendService）。
BOOT_CODE_MARK = "[novel-client] backend code loaded"
BOOT_DATABASE_MARK = "[novel-client] database ready"


def wait_for_mongo(url: str, timeout: float, *, sleep=time.sleep, clock=time.monotonic) -> bool:
    """等到 MongoDB 成为可写主节点；超时返回 False（后端会沿用原有的“需要配置数据库”界面）。"""
    from pymongo import MongoClient
    from pymongo.errors import PyMongoError

    deadline = clock() + timeout
    while True:
        try:
            with MongoClient(url, serverSelectionTimeoutMS=1000) as client:
                if client.admin.command("hello").get("isWritablePrimary"):
                    return True
        except PyMongoError:
            pass
        if clock() >= deadline:
            return False
        sleep(0.3)


def main(argv: list[str], environ=os.environ) -> None:
    # 原生扩展崩溃也把 Python 栈留在后端日志里，便于诊断无异常信息的进程退出。
    faulthandler.enable()
    log_dir = environ.get("NOVEL_CLIENT_STARTUP_LOG_DIR")
    if log_dir:
        trace.configure(log_dir, "backend", environ=environ)
    trace.mark("backend_python_entry")
    app_dir = os.path.abspath(argv[1])
    os.chdir(app_dir)
    sys.path.insert(0, app_dir)

    preload = environ.get(PRELOAD_ENV, DEFAULT_PRELOAD)
    with trace.span("backend_imports"):
        if preload:
            __import__(preload)  # 先加载代码；后面的 main.py 会直接复用，不会重复加载
    print(BOOT_CODE_MARK, flush=True)

    url = environ.get(MONGO_URL_ENV)
    if url:
        with trace.span("backend_wait_database"):
            writable = wait_for_mongo(url, float(environ.get(MONGO_WAIT_ENV, DEFAULT_MONGO_WAIT)))
        trace.mark("backend_database_check", writable=writable)
    print(BOOT_DATABASE_MARK, flush=True)

    sys.argv = [os.path.join(app_dir, "main.py")]
    trace.mark("backend_server_entry")
    runpy.run_path(sys.argv[0], run_name="__main__")


if __name__ == "__main__":
    main(sys.argv)
