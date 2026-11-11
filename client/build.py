"""打包桌面客户端。

用法（在项目根目录或 client 目录均可）：
    python client\\build.py                  完整打包，输出到 client\\dist\\<exe_name>\\
    python client\\build.py --skip-frontend  只改了后端/客户端代码时使用，复用上次的前端构建
    python client\\build.py --runtime-only   只准备运行环境（dev.bat 首次运行时会自动调用）

运行环境（Python/Node/MongoDB）下载后缓存在 client\\build\\，再次打包不会重复下载。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tomllib
import zipfile
from pathlib import Path

CLIENT = Path(__file__).resolve().parent
REPO = CLIENT.parent
BUILD = CLIENT / "build"
DOWNLOADS = BUILD / "downloads"
RUNTIME = BUILD / "runtime"
DIST_ROOT = CLIENT / "dist"
FRONTEND = REPO / "frontend"
FRONTEND_DIST_DIR = ".next-client"  # 与网页版的 .next 分开，互不覆盖

sys.path.insert(0, str(CLIENT))
from novel_client.config import load_settings, packaged_data_dir  # noqa: E402
from novel_client.persistence import backup_config_file, preserve_user_config  # noqa: E402


def step(msg: str) -> None:
    print(f"\n==> {msg}", flush=True)


def run(cmd: list[str], **kwargs) -> None:
    print("   $", " ".join(str(c) for c in cmd), flush=True)
    subprocess.run([str(c) for c in cmd], check=True, **kwargs)


def download(url: str) -> Path:
    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    target = DOWNLOADS / url.rsplit("/", 1)[-1]
    if target.exists():
        return target
    print(f"   下载 {url}", flush=True)
    tmp = target.with_suffix(target.suffix + ".part")
    # 用系统自带的 curl：大文件断线后可自动重试并续传
    run(["curl.exe", "-fL", "--retry", "8", "--retry-all-errors", "--retry-delay", "3",
         "-C", "-", "-o", tmp, url])
    tmp.replace(target)
    return target


# ---------------------------------------------------------------- 运行环境

def combined_requirements() -> str:
    """后端依赖 + 客户端依赖。"""
    requirements = [l for l in (REPO / "requirements.txt").read_text(encoding="utf-8").splitlines()
                    if not l.strip().lower().startswith("pyside6")]  # 只有旧启动器用 PySide6
    requirements += (CLIENT / "requirements-client.txt").read_text(encoding="utf-8").splitlines()
    return "\n".join(requirements) + "\n"


def prepare_python(cfg: dict) -> None:
    py_dir = RUNTIME / "python"
    python = py_dir / "python.exe"
    if not python.exists():
        step(f"准备 Python {cfg['version']}")
        with zipfile.ZipFile(download(cfg["url"])) as z:
            z.extractall(py_dir)
        # 内置版 Python 默认禁用 site-packages，开启后才能用 pip 安装依赖
        pth = next(py_dir.glob("python*._pth"))
        lines = [l for l in pth.read_text().splitlines() if l.strip() != "#import site"]
        pth.write_text("\n".join(lines + ["Lib\\site-packages", "import site", ""]))
        run([python, download(cfg["get_pip_url"]), "--no-warn-script-location"])

    req_text = combined_requirements()
    stamp = py_dir / ".deps-stamp"
    digest = hashlib.sha256((cfg["version"] + req_text).encode()).hexdigest()
    if stamp.exists() and stamp.read_text() == digest:
        return
    step("安装 Python 依赖")
    req_file = BUILD / "requirements-all.txt"
    req_file.write_text(req_text, encoding="utf-8")
    pip = [python, "-m", "pip", "install", "--no-warn-script-location", "--disable-pip-version-check"]
    # 内置版 Python 里 pip 的隔离构建环境无法工作；少数只有源码包的依赖（如 proxy_tools）直接用已装的 setuptools 构建
    run(pip + ["setuptools", "wheel"])
    run(pip + ["--no-build-isolation", "-r", req_file])
    stamp.write_text(digest)


def installed_version(folder: Path) -> str:
    marker = folder / ".version"
    return marker.read_text() if marker.exists() else ""


def prepare_node(cfg: dict) -> None:
    node_dir = RUNTIME / "node"
    if installed_version(node_dir) == cfg["version"]:
        return
    step(f"准备 Node.js {cfg['version']}")
    shutil.rmtree(node_dir, ignore_errors=True)
    tmp = BUILD / "node-extract"
    shutil.rmtree(tmp, ignore_errors=True)
    with zipfile.ZipFile(download(cfg["url"])) as z:
        z.extractall(tmp)
    shutil.move(next(tmp.iterdir()), node_dir)  # 去掉压缩包里的顶层目录
    shutil.rmtree(tmp)
    (node_dir / ".version").write_text(cfg["version"])


def prepare_mongodb(cfg: dict) -> None:
    mongo_dir = RUNTIME / "mongodb"
    if installed_version(mongo_dir) == cfg["version"]:
        return
    step(f"准备 MongoDB {cfg['version']}")
    shutil.rmtree(mongo_dir, ignore_errors=True)
    mongo_dir.mkdir(parents=True)
    with zipfile.ZipFile(download(cfg["url"])) as z:
        # 只取服务端程序及其 dll，跳过体积很大的调试符号和其他工具
        for info in z.infolist():
            name = info.filename.rsplit("/", 1)[-1]
            if "/bin/" in info.filename and (name == "mongod.exe" or name.lower().endswith(".dll")):
                (mongo_dir / name).write_bytes(z.read(info))
    (mongo_dir / ".version").write_text(cfg["version"])


def prepare_runtime() -> None:
    versions = tomllib.loads((CLIENT / "versions.toml").read_text(encoding="utf-8"))
    prepare_python(versions["python"])
    prepare_node(versions["node"])
    prepare_mongodb(versions["mongodb"])


# ---------------------------------------------------------------- 前端

def node_env(**extra: str) -> dict[str, str]:
    env = os.environ.copy()
    env["PATH"] = str(RUNTIME / "node") + os.pathsep + env["PATH"]  # 使用内置 Node，结果与本机 Node 版本无关
    env["NEXT_TELEMETRY_DISABLED"] = "1"
    env.update(extra)
    return env


def ensure_node_modules() -> None:
    lock = FRONTEND / "package-lock.json"
    marker = FRONTEND / "node_modules" / ".package-lock.json"
    if not marker.exists() or marker.stat().st_mtime < lock.stat().st_mtime:
        step("安装前端依赖（npm ci）")
        run([RUNTIME / "node" / "npm.cmd", "ci"], cwd=FRONTEND, env=node_env())


def build_frontend(backend_port: int) -> Path:
    ensure_node_modules()
    step("构建前端（几分钟）")
    shutil.rmtree(FRONTEND / FRONTEND_DIST_DIR, ignore_errors=True)
    run([RUNTIME / "node" / "npm.cmd", "run", "build"], cwd=FRONTEND, env=node_env(
        NODE_ENV="production",
        NEXT_OUTPUT="standalone",
        NEXT_DIST_DIR=FRONTEND_DIST_DIR,
        NEXT_PUBLIC_API_BASE=f"http://127.0.0.1:{backend_port}",
    ))
    # 记录写进前端代码的后端端口，--skip-frontend 时以它为准
    (FRONTEND / FRONTEND_DIST_DIR / "client-build.json").write_text(json.dumps({"backend_port": backend_port}))
    return frontend_standalone_dir()


def built_backend_port() -> int:
    info = FRONTEND / FRONTEND_DIST_DIR / "client-build.json"
    if not info.exists():
        sys.exit("没有找到上次的前端构建，请去掉 --skip-frontend 重新打包")
    return json.loads(info.read_text())["backend_port"]


def build_splash_assets() -> None:
    """启动页的画面、配色和编排时长取自网页的启动动画源码，每次打包都重新导出一遍，两边不会对不上。耗时不到一秒。"""
    ensure_node_modules()
    step("导出启动页素材")
    run([RUNTIME / "node" / "node.exe", FRONTEND / "scripts" / "build-splash.mjs", CLIENT / "novel_client" / "splash_assets.json"],
        cwd=FRONTEND, env=node_env())


def frontend_standalone_dir() -> Path:
    standalone = FRONTEND / FRONTEND_DIST_DIR / "standalone"
    # Next 推断的工作区根目录不同时，server.js 可能位于子目录中
    servers = sorted(standalone.rglob("server.js"), key=lambda p: len(p.parts))
    servers = [p for p in servers if "node_modules" not in p.parts]
    if not servers:
        sys.exit(f"找不到前端构建产物 {standalone}，请去掉 --skip-frontend 重新打包")
    return servers[0].parent


# ---------------------------------------------------------------- 组装

def ignore_junk(_dir: str, names: list[str]) -> set[str]:
    return {n for n in names if n in {"__pycache__", ".pytest_cache"} or n.endswith(".pyc")}


def ignore_backend_files(directory: str, names: list[str]) -> set[str]:
    ignored = ignore_junk(directory, names)
    if Path(directory).resolve() == (REPO / "backend" / "config").resolve():
        ignored.add("config.yaml")  # 用户配置及密钥不能随程序分发。
    return ignored


def precompile_package(out: Path) -> None:
    """用随包解释器生成最终路径上的缓存，把首次启动的编译移到打包阶段。"""
    step("预编译后端和客户端 Python 缓存")
    run([out / "runtime" / "python" / "python.exe", "-E", "-m", "compileall",
         "-q", "--invalidation-mode", "timestamp", "-o", "0",
         out / "app", out / "client"])


def assemble(backend_port: int, server_dir: Path, exe_name: str) -> Path:
    out = DIST_ROOT / exe_name
    if out.parent.resolve() != DIST_ROOT.resolve() or out.resolve() == DIST_ROOT.resolve() or out.is_symlink() or out.is_junction():
        sys.exit("打包目标必须是 dist 下的独立普通目录，为避免误删已停止")
    step(f"组装到 {out}")
    saved_client_settings = None
    if out.exists():
        if not (out / "client" / "packaged.json").exists():
            sys.exit(f"{out} 不是之前的打包结果，为避免误删请手动处理")
        previous_settings = out / "client" / "client.toml"
        settings = load_settings(previous_settings)
        data_dir = packaged_data_dir(settings, out)
        if data_dir.is_relative_to(out.resolve()):
            sys.exit(f"用户数据位于待替换的程序目录中，已停止更新以保留数据：{data_dir}")
        from novel_client.services import describe_port_owner, port_in_use
        previous_port = json.loads((out / "client" / "packaged.json").read_text())["backend_port"]
        busy = [port for port in (previous_port, settings.mongodb_port, settings.frontend_port) if port_in_use(port)]
        if busy:
            # 端口被占用不等于客户端开着：测试或排查遗留的服务也会占用同一端口，要说清是谁。
            sys.exit("端口被占用，未替换程序和用户配置：\n" + "\n".join("  " + describe_port_owner(port) for port in busy)
                     + "\n是打开着的客户端就先关闭；是遗留的服务就结束对应进程后再更新。")
        # 必须先迁移并校验备份，再删除旧程序；任何备份失败都保留原目录。
        preserve_user_config(out / "app", data_dir)
        backup_config_file(previous_settings, data_dir)
        saved_client_settings = previous_settings.read_bytes()
        shutil.rmtree(out)

    app = out / "app"
    app.mkdir(parents=True)
    shutil.copytree(REPO / "backend", app / "backend", ignore=ignore_backend_files)
    for name in ("main.py", "LICENSE", "requirements.txt"):
        shutil.copy2(REPO / name, app / name)

    shutil.copytree(server_dir, out / "frontend")
    shutil.copytree(FRONTEND / FRONTEND_DIST_DIR / "static", out / "frontend" / FRONTEND_DIST_DIR / "static")
    if (FRONTEND / "public").exists():
        shutil.copytree(FRONTEND / "public", out / "frontend" / "public")

    # 运行环境自带的 .pyc 要保留：不带的话，每次重新打包后的第一次启动都要把几百个包重新编译一遍。
    shutil.copytree(RUNTIME, out / "runtime", ignore=lambda _d, names: {n for n in names if n == ".pytest_cache"})

    client = out / "client"
    shutil.copytree(CLIENT / "novel_client", client / "novel_client", ignore=ignore_junk)
    shutil.copy2(CLIENT / "launch.py", client / "launch.py")
    if saved_client_settings is not None:
        (client / "client.toml").write_bytes(saved_client_settings)
    else:
        shutil.copy2(CLIENT / "client.toml", client / "client.toml")
    (client / "packaged.json").write_text(json.dumps({"backend_port": backend_port}, indent=2), encoding="utf-8")

    precompile_package(out)
    compile_launcher(out / f"{exe_name}.exe")
    return out


def compile_launcher(exe: Path) -> None:
    step("编译启动器 exe")
    csc = Path(os.environ.get("WINDIR", r"C:\Windows")) / r"Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    cmd = [csc, "/nologo", "/target:winexe", "/optimize", f"/out:{exe}", "/reference:System.Windows.Forms.dll"]
    icon = CLIENT / "launcher" / "app.ico"
    if icon.exists():
        cmd.append(f"/win32icon:{icon}")
    run(cmd + [CLIENT / "launcher" / "Launcher.cs"])


def folder_size_mb(path: Path) -> int:
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file()) >> 20


SHORTCUT_SCRIPT = (
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;"
    "$d = if ($env:SC_DESKTOP) { $env:SC_DESKTOP } else { [Environment]::GetFolderPath('Desktop') };"
    "$p = Join-Path $d ($env:SC_NAME + '.lnk');"
    "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($p);"
    "$s.TargetPath = $env:SC_TARGET; $s.WorkingDirectory = $env:SC_DIR;"
    "$s.IconLocation = $(if ($env:SC_ICON) { $env:SC_ICON + ',0' } else { $env:SC_TARGET + ',0' });"
    "$s.Description = $env:SC_NAME; $s.Save(); Write-Output $p"
)


def create_desktop_shortcut(exe: Path, name: str, desktop: Path | None = None, icon: Path | None = None) -> Path:
    """在桌面创建或更新快捷方式（已存在时覆盖，始终指向最新打包的 exe和主题图标）。

    桌面位置由系统决定，桌面被 OneDrive 重定向时同样正确；desktop 参数仅供测试指定其他目录。
    """
    step("更新桌面快捷方式")
    env = os.environ.copy()
    # 路径通过环境变量传入，避免中文和空格在命令行中被错误转义
    env.update(SC_NAME=name, SC_TARGET=str(exe), SC_DIR=str(exe.parent), SC_DESKTOP=str(desktop or ""),
               SC_ICON=str(icon) if icon else "")
    result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", SHORTCUT_SCRIPT],
                            env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", check=True,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    link = Path(result.stdout.strip().splitlines()[-1])
    print(f"   {link}")
    return link


def main() -> None:
    parser = argparse.ArgumentParser(description="打包 AI 小说生成器桌面客户端")
    parser.add_argument("--skip-frontend", action="store_true", help="复用上次的前端构建")
    parser.add_argument("--runtime-only", action="store_true", help="只准备运行环境")
    parser.add_argument("--no-shortcut", action="store_true", help="不创建或更新桌面快捷方式")
    args = parser.parse_args()

    prepare_runtime()
    if args.runtime_only:
        print("\n运行环境已就绪：", RUNTIME)
        return

    settings = load_settings()
    exe_name = tomllib.loads((CLIENT / "client.toml").read_text(encoding="utf-8"))["app"]["exe_name"]
    build_splash_assets()
    if args.skip_frontend:
        backend_port, server_dir = built_backend_port(), frontend_standalone_dir()
        if backend_port != settings.backend_port:
            print(f"   注意：client.toml 中的后端端口已改为 {settings.backend_port}，但沿用的前端构建使用 {backend_port}。"
                  "要应用新端口，请去掉 --skip-frontend 重新打包。")
    else:
        backend_port = settings.backend_port
        server_dir = build_frontend(backend_port)
    out = assemble(backend_port, server_dir, exe_name)
    if not args.no_shortcut:
        shortcut_icon = None
        try:
            from novel_client import icons, look
            data_dir = packaged_data_dir(settings, out)
            shortcut_icon = icons.write_icon(data_dir, look.load(data_dir))
        except Exception:
            # 图标只是外观；生成失败时仍用 exe 内的默认图标完成更新。
            print("   主题图标生成失败，快捷方式暂用默认图标")
        create_desktop_shortcut(out / f"{exe_name}.exe", exe_name, icon=shortcut_icon)
    print(f"\n完成：{out / (exe_name + '.exe')}（整个文件夹约 {folder_size_mb(out)} MB）")


if __name__ == "__main__":
    main()
