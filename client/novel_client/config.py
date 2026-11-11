"""客户端路径与配置。开发模式和打包模式的差异全部集中在这里。"""

from __future__ import annotations

import json
import os
import tomllib
from dataclasses import dataclass, replace
from pathlib import Path

CLIENT_DIR = Path(__file__).resolve().parents[1]
# 打包时由 build.py 写入；存在即表示当前运行在 dist 目录中。
PACKAGED_MARKER = CLIENT_DIR / "packaged.json"


@dataclass(frozen=True)
class Paths:
    """各组件所在目录。"""

    app_dir: Path       # 后端源码所在目录（包含 main.py 和 backend/）
    frontend_dir: Path  # 打包模式为 standalone 产物，开发模式为 frontend 源码
    runtime_dir: Path   # 内置的 python / node / mongodb
    data_dir: Path      # 用户数据：小说数据库、配置、日志

    @property
    def python(self) -> Path:
        return self.runtime_dir / "python" / "python.exe"

    @property
    def node(self) -> Path:
        return self.runtime_dir / "node" / "node.exe"

    @property
    def mongod(self) -> Path:
        return self.runtime_dir / "mongodb" / "mongod.exe"

    @property
    def logs_dir(self) -> Path:
        return self.data_dir / "client_logs"


@dataclass(frozen=True)
class Settings:
    """client.toml 中的设置。"""

    title: str
    width: int
    height: int
    min_width: int
    min_height: int
    debug: bool
    mongodb_port: int
    backend_port: int
    frontend_port: int
    database_name: str
    data_dir_override: str
    exe_name: str = "AI小说生成器"


@dataclass(frozen=True)
class ClientConfig:
    dev: bool
    paths: Paths
    settings: Settings

    @property
    def frontend_url(self) -> str:
        return f"http://127.0.0.1:{self.settings.frontend_port}"

    @property
    def backend_url(self) -> str:
        return f"http://127.0.0.1:{self.settings.backend_port}"

    @property
    def mongodb_url(self) -> str:
        return f"mongodb://127.0.0.1:{self.settings.mongodb_port}/?replicaSet=rs0&directConnection=true"


def load_settings(path: Path | None = None) -> Settings:
    raw = tomllib.loads((path or CLIENT_DIR / "client.toml").read_text(encoding="utf-8"))
    app, window, ports, data = raw.get("app", {}), raw.get("window", {}), raw.get("ports", {}), raw.get("data", {})
    return Settings(
        title=app.get("title", "AI 小说生成器"),
        width=int(window.get("width", 1400)),
        height=int(window.get("height", 900)),
        min_width=int(window.get("min_width", 1000)),
        min_height=int(window.get("min_height", 680)),
        debug=bool(window.get("debug", False)),
        mongodb_port=int(ports.get("mongodb", 27117)),
        backend_port=int(ports.get("backend", 18200)),
        frontend_port=int(ports.get("frontend", 13300)),
        database_name=data.get("database_name", "novel_generator"),
        data_dir_override=data.get("dir", "").strip(),
        exe_name=app.get("exe_name", "AI小说生成器"),
    )


def packaged_data_dir(settings: Settings, root: Path) -> Path:
    """固定正式数据目录；相对自定义路径以程序目录为基准。"""
    if settings.data_dir_override:
        directory = Path(settings.data_dir_override)
        return (directory if directory.is_absolute() else root / directory).resolve()
    return (Path(os.environ.get("LOCALAPPDATA", Path.home())) / "AINovelGenerator-Clean").resolve()


def load_config() -> ClientConfig:
    settings = load_settings()

    if PACKAGED_MARKER.exists():
        # 打包模式：dist\{app,frontend,runtime,client}
        root = CLIENT_DIR.parent
        marker = json.loads(PACKAGED_MARKER.read_text(encoding="utf-8"))
        # 前端构建时写死的后端端口以 packaged.json 为准，防止只改 client.toml 导致前后端对不上。
        settings = replace(settings, backend_port=int(marker["backend_port"]))
        data_dir = packaged_data_dir(settings, root)
        paths = Paths(root / "app", root / "frontend", root / "runtime", data_dir)
        return ClientConfig(False, paths, settings)

    # 开发模式：直接使用仓库源码，运行环境来自 build.py 准备的缓存。
    repo = CLIENT_DIR.parent
    build = CLIENT_DIR / "build"
    paths = Paths(repo, repo / "frontend", build / "runtime", build / "dev-data")
    return ClientConfig(True, paths, settings)
