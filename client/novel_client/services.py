"""客户端托管的后台服务。新增服务：继承 Service，实现 command()/is_ready()，再加入 app.build_services()。"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from .config import ClientConfig
from .persistence import preserve_user_config
from .winjob import KillOnCloseJob
from .startup_trace import trace

_NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
# 访问本机服务时绕过系统代理（开着代理软件时 localhost 请求可能被转发）。
_LOCAL_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class ServiceError(RuntimeError):
    def __init__(self, service: "Service", message: str) -> None:
        super().__init__(f"{service.label}：{message}")
        self.service = service


def port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


# 查端口的监听进程及其父进程链；只在端口已被占用时调用，用来说明到底是谁占着，而不是一概说“客户端正在运行”。
_OWNER_SCRIPT = (
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8;"
    "$c=Get-NetTCPConnection -State Listen -LocalPort {port} -ErrorAction SilentlyContinue|Select-Object -First 1;"
    "$rows=@();$id=$c.OwningProcess;"
    "for($i=0;$id -and $i -lt 6;$i++){{$p=Get-CimInstance Win32_Process -Filter \"ProcessId=$id\";if(!$p){{break}};"
    "$rows+=[pscustomobject]@{{pid=$p.ProcessId;name=$p.Name;cmd=[string]$p.CommandLine}};$id=$p.ParentProcessId}};"
    "ConvertTo-Json -InputObject @($rows) -Compress"
)


def port_owner(port: int) -> list[dict]:
    """占用端口的进程及其父进程链（由近到远，每项含 pid、name、cmd）。查不到或非 Windows 时返回空列表。"""
    if sys.platform != "win32":
        return []
    try:
        result = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", _OWNER_SCRIPT.format(port=int(port))],
                                capture_output=True, timeout=20, creationflags=_NO_WINDOW)
        import json
        rows = json.loads(result.stdout.decode("utf-8", errors="replace").strip() or "[]")
        return [rows] if isinstance(rows, dict) else rows
    except Exception:
        return []


def describe_port_owner(port: int) -> str:
    """用一句话说明端口被谁占用：打开着的桌面客户端、测试或排查留下的服务，还是别的程序。"""
    chain = port_owner(port)
    if not chain:
        return f"端口 {port} 已被占用，无法确定是哪个程序"
    cmds = " ".join(row.get("cmd", "") for row in chain).replace("/", "\\").lower()
    first = f"{chain[0].get('name', '?')}（PID {chain[0].get('pid', '?')}）"
    if "\\client\\launch.py" in cmds:
        return f"端口 {port} 已被占用，占用的是打开着的桌面客户端：{first}"
    if "run_tests.py" in cmds or "novel-stack-" in cmds or "unittest" in cmds:
        return f"端口 {port} 已被占用，占用的是测试启动的服务，不是桌面客户端：{first}"
    if "run_backend.py" in cmds or "mongod" in cmds or "server.js" in cmds:
        return f"端口 {port} 已被占用，占用的是遗留的本软件服务，不属于任何打开的客户端窗口（多半是测试或排查后没有退出）：{first}"
    return f"端口 {port} 已被占用，占用的是其他程序：{first}"


def http_ok(url: str, timeout: float = 2.0) -> bool:
    """服务已在响应即视为就绪；4xx 也算（说明进程在处理请求），5xx 和连接失败不算。"""
    try:
        with _LOCAL_OPENER.open(url, timeout=timeout) as resp:
            return resp.status < 500
    except urllib.error.HTTPError as exc:
        return exc.code < 500
    except Exception:
        return False


class Service:
    """一个子进程服务。日志写入 data_dir/client_logs/<name>.log。"""

    name = "service"
    label = "服务"
    port = 0
    start_timeout = 60.0

    def __init__(self, config: ClientConfig, job: KillOnCloseJob) -> None:
        self.config = config
        self.job = job
        self.proc: subprocess.Popen | None = None
        self.log_path = config.paths.logs_dir / f"{self.name}.log"

    # ---- 子类实现 ----
    def command(self) -> list[str]:
        raise NotImplementedError

    def cwd(self) -> Path:
        return self.config.paths.app_dir

    def env(self) -> dict[str, str]:
        env = os.environ.copy()
        env["NO_PROXY"] = env["no_proxy"] = "127.0.0.1,localhost"
        return env

    def is_ready(self) -> bool:
        return port_in_use(self.port)

    def milestones(self) -> list:
        """就绪之前依次会达到的中间状态（各是一个返回真假的检查），启动页按它们推进这条进度；最后一步总是“就绪”。"""
        return []

    @property
    def steps(self) -> int:
        return len(self.milestones()) + 1

    def before_start(self) -> None:
        """启动前的准备工作（建目录、检查文件等）。"""

    def after_ready(self) -> None:
        """就绪后的初始化工作。"""

    # ---- 通用流程 ----
    def start(self) -> None:
        if self.port and port_in_use(self.port):
            raise ServiceError(self, describe_port_owner(self.port) + "。如果是遗留的服务，结束该进程后重新打开；也可以在 client.toml 中更换端口。")
        self.before_start()
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        log = self.log_path.open("w", encoding="utf-8", errors="replace")
        try:
            self.proc = subprocess.Popen(
                self.command(), cwd=self.cwd(), env=self.env(),
                stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                creationflags=_NO_WINDOW,
            )
        except OSError as exc:
            raise ServiceError(self, f"无法启动：{exc}") from exc
        finally:
            log.close()  # 子进程已持有自己的句柄
        self.job.add(self.proc)

    def wait_ready(self, on_step=None) -> None:
        """等到就绪。on_step(n) 在达到第 n 个中间状态时调用（n 从 1 起，最后一次是 steps，表示就绪）；
        中间状态只往前走，就绪时没报过的也一并报上。回调出错不影响等待。"""
        checks = self.milestones()
        reached = 0

        def report(step: int) -> None:
            nonlocal reached
            if step > reached and on_step is not None:
                try:
                    on_step(step)
                except Exception:
                    pass
            reached = max(reached, step)

        deadline = time.monotonic() + self.start_timeout
        while time.monotonic() < deadline:
            if self.proc and self.proc.poll() is not None:
                raise ServiceError(self, f"进程意外退出（退出码 {self.proc.returncode}）")
            while reached < len(checks) and checks[reached]():
                report(reached + 1)
            if self.is_ready():
                self.after_ready()
                report(len(checks) + 1)
                return
            time.sleep(0.3)
        raise ServiceError(self, f"{int(self.start_timeout)} 秒内未就绪")

    def stop(self) -> None:
        if not self.proc or self.proc.poll() is not None:
            return
        # taskkill /T 连同子进程（如 npm 启动的 node）一起结束
        subprocess.run(["taskkill", "/PID", str(self.proc.pid), "/T", "/F"],
                       capture_output=True, creationflags=_NO_WINDOW)
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()

    def log_tail(self, lines: int = 40) -> str:
        try:
            return "\n".join(self.log_path.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:])
        except OSError:
            return ""


class MongoService(Service):
    name = "mongodb"
    label = "数据库 MongoDB"
    start_timeout = 60.0

    def __init__(self, config: ClientConfig, job: KillOnCloseJob) -> None:
        super().__init__(config, job)
        self.port = config.settings.mongodb_port
        self.db_path = config.paths.data_dir / "mongodb"

    def before_start(self) -> None:
        if not self.config.paths.mongod.exists():
            raise ServiceError(self, f"找不到 {self.config.paths.mongod}，请先运行 build.bat")
        self.db_path.mkdir(parents=True, exist_ok=True)

    def command(self) -> list[str]:
        return [
            str(self.config.paths.mongod),
            "--dbpath", str(self.db_path),
            "--port", str(self.port),
            "--bind_ip", "127.0.0.1",
            "--replSet", "rs0",
            # 限制常驻缓存，但给整书导入事务留出空间：256MB 无法容纳 1500 章的正文和历史索引。
            "--wiredTigerCacheSizeGB", "0.5",
            # 关掉诊断数据采集，空闲时不再定时写盘
            "--setParameter", "diagnosticDataCollectionEnabled=false",
        ]

    def cwd(self) -> Path:
        return self.db_path

    def milestones(self) -> list:
        # 端口打开 → 能应答且成为可写主节点（就绪）
        return [lambda: port_in_use(self.port)]

    def _client(self, **kwargs):
        from pymongo import MongoClient
        return MongoClient("127.0.0.1", self.port, directConnection=True, serverSelectionTimeoutMS=2000, **kwargs)

    def is_ready(self) -> bool:
        if not port_in_use(self.port):
            return False
        try:
            with self._client() as client:
                client.admin.command("ping")
            return True
        except Exception:
            return False

    def after_ready(self) -> None:
        """后端保存数据需要事务，所以 MongoDB 必须是副本集；首次运行自动初始化。

        mongod 刚启动时还在后台加载副本集配置，期间的命令可能短暂失败，所以整个过程循环重试。
        """
        from pymongo.errors import PyMongoError
        host = f"127.0.0.1:{self.port}"
        last_error: Exception | None = None
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                with self._client() as client:
                    if client.admin.command("hello").get("isWritablePrimary"):
                        return
                    # 直接读本地保存的副本集配置：端口改过时节点在配置里找不到自己，
                    # replSetGetConfig 会误报“未初始化”，不能据此重新初始化。
                    conf = client.local["system.replset"].find_one()
                    if conf is None:
                        client.admin.command("replSetInitiate", {"_id": "rs0", "members": [{"_id": 0, "host": host}]})
                    elif conf["members"][0]["host"] != host:
                        # 端口改过：把成员地址改成新端口
                        conf["members"][0]["host"] = host
                        conf["version"] += 1
                        client.admin.command("replSetReconfig", conf, force=True)
            except PyMongoError as exc:
                last_error = exc  # 重新配置会断开连接、配置尚未加载完等，都属于暂时状态
            time.sleep(0.5)
        raise ServiceError(self, f"副本集未能成为可写主节点：{last_error}")

    def stop(self) -> None:
        """正常关闭，保证数据完整写盘；失败时再强制结束。"""
        if not self.proc or self.proc.poll() is not None:
            return
        try:
            with self._client() as client:
                client.admin.command("shutdown")
        except Exception:
            pass  # 关闭命令成功时连接会被断开，这里的异常是预期的
        try:
            self.proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            super().stop()


class BackendService(Service):
    name = "backend"
    label = "后端服务"
    start_timeout = 90.0

    def __init__(self, config: ClientConfig, job: KillOnCloseJob) -> None:
        super().__init__(config, job)
        self.port = config.settings.backend_port

    def command(self) -> list[str]:
        runner = Path(__file__).with_name("run_backend.py")
        return [str(self.config.paths.python), "-u", str(runner), str(self.config.paths.app_dir)]

    def before_start(self) -> None:
        if not self.config.dev:
            preserve_user_config(self.config.paths.app_dir, self.config.paths.data_dir)

    def env(self) -> dict[str, str]:
        s = self.config.settings
        env = super().env()
        env.update(trace.child_env())
        env["NOVEL_CLIENT_STARTUP_LOG_DIR"] = str(self.config.paths.logs_dir)
        env.update({
            "PYTHONUTF8": "1",
            "NOVEL_GENERATOR_USER_DATA_DIR": str(self.config.paths.data_dir / "user_data"),
            "NOVEL_GENERATOR_MONGODB_URL": self.config.mongodb_url,
            "NOVEL_GENERATOR_MONGO_DATABASE_NAME": s.database_name,
            "NOVEL_GENERATOR_BACKEND_PORT": str(s.backend_port),
            "NOVEL_GENERATOR_FRONTEND_PORT": str(s.frontend_port),
        })
        return env

    def is_ready(self) -> bool:
        return http_ok(f"{self.config.backend_url}/api/startup")

    def milestones(self) -> list:
        # 代码加载完 → 数据库可写 → 端口开始监听 → 启动检查通过（就绪）。前两步看 run_backend.py 写进日志的标记。
        from .run_backend import BOOT_CODE_MARK, BOOT_DATABASE_MARK
        return [lambda: self._logged(BOOT_CODE_MARK), lambda: self._logged(BOOT_DATABASE_MARK), lambda: port_in_use(self.port)]

    def _logged(self, mark: str) -> bool:
        try:
            return mark in self.log_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return False


class FrontendService(Service):
    name = "frontend"
    label = "前端界面"
    start_timeout = 120.0  # 开发模式首次编译较慢

    def __init__(self, config: ClientConfig, job: KillOnCloseJob) -> None:
        super().__init__(config, job)
        self.port = config.settings.frontend_port

    def cwd(self) -> Path:
        return self.config.paths.frontend_dir

    def command(self) -> list[str]:
        if self.config.dev:
            # 开发模式：next dev 热更新，改前端代码后窗口内刷新即可看到效果
            npm = "npm.cmd" if sys.platform == "win32" else "npm"
            return [npm, "run", "dev", "--", "-p", str(self.port), "-H", "127.0.0.1"]
        return [str(self.config.paths.node), "--max-old-space-size=384", "server.js"]

    def env(self) -> dict[str, str]:
        env = super().env()
        env.update({
            "PORT": str(self.port),
            "HOSTNAME": "127.0.0.1",
            "NEXT_PUBLIC_API_BASE": self.config.backend_url,
            "NEXT_TELEMETRY_DISABLED": "1",
        })
        if not self.config.dev:
            env["NODE_ENV"] = "production"
        return env

    def is_ready(self) -> bool:
        return http_ok(self.config.frontend_url, timeout=10)

    def milestones(self) -> list:
        # 端口开始监听 → 首页能打开（就绪；这一次请求也让界面先渲染好一遍，进入时更快）
        return [lambda: port_in_use(self.port)]
