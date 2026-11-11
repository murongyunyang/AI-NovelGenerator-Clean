"""客户端主流程：显示启动页 → 依次启动服务 → 加载界面 → 关闭窗口时停止服务。"""

from __future__ import annotations

import html
import json
import logging
import os
import queue
import threading
import time

import webview

from .config import ClientConfig, load_config
from .navigation import install_in_window_navigation
from . import look as look_store
from . import icons
from . import screen
from . import startup_timing
from .startup_trace import trace
from .services import BackendService, FrontendService, MongoService, Service, ServiceError
from .splash import ERROR_HTML, render_splash
from .winjob import KillOnCloseJob

logger = logging.getLogger("novel_client")


class Api:
    """暴露给网页的 JS 接口：页面中可调用 window.pywebview.api.<方法名>()。"""

    def __init__(self, config: ClientConfig) -> None:
        self._config = config
        self._look = look_store.load(config.paths.data_dir)

    def open_logs(self) -> None:
        self._config.paths.logs_dir.mkdir(parents=True, exist_ok=True)
        os.startfile(self._config.paths.logs_dir)

    def open_data_dir(self) -> None:
        os.startfile(self._config.paths.data_dir)

    def save_look(self, look: object) -> bool:
        """保存界面风格，并同步启动页、窗口和桌面快捷方式的图标。内容不合格时不保存。"""
        saved = look_store.save(self._config.paths.data_dir, look)
        if saved:
            current = look_store.load(self._config.paths.data_dir)
            # 页面切换也会重报当前主题；只有主题真的变化才重写桌面快捷方式，避免重复启动 PowerShell。
            icons.apply(self._config, current, shortcut=current != self._look)
            self._look = current
        return saved


class ClientApp:
    def __init__(self, config: ClientConfig) -> None:
        self.config = config
        self.job = KillOnCloseJob()
        self.closing = threading.Event()
        self.mongo, self.backend, self.frontend = self.build_services()
        self.window: webview.Window | None = None
        self._title = config.settings.title
        self._js_lock = threading.Lock()
        self._started = time.monotonic()
        self._timeline: dict[str, list[int]] = {}
        self._entering = False
        self._page_loaded = False
        self._reported_exits: set[tuple[str, int]] = set()

    def build_services(self) -> tuple[MongoService, BackendService, FrontendService]:
        return MongoService(self.config, self.job), BackendService(self.config, self.job), FrontendService(self.config, self.job)

    @property
    def services(self) -> list[Service]:
        return [self.mongo, self.backend, self.frontend]

    # ---- 启动 ----
    def _js(self, script: str):
        """后台线程里执行启动页脚本；几个服务的等待线程可能同时报进度，按顺序发。窗口正在关闭时出错不影响启动流程。"""
        if not self.window:
            return None
        with self._js_lock:
            try:
                return self.window.evaluate_js(script)
            except Exception:
                logger.debug("启动页脚本执行失败", exc_info=True)
                return None

    def _status(self, text: str) -> None:
        """更新启动页底部的一行提示文字。"""
        logger.info(text)
        self._js(f"document.getElementById('msg')&&(document.getElementById('msg').textContent={text!r})")

    def _step(self, key: str, step: int) -> None:
        """某个服务到达第 step 步（key 为 db、api、ui，对应启动页的三条进度），同时记下耗时供下次启动参考。"""
        elapsed = round((time.monotonic() - self._started) * 1000)
        marks = self._timeline.setdefault(key, [])
        while len(marks) < step:
            marks.append(elapsed)
        trace.mark(f"service.{key}.step_{step}", services_elapsed_ms=elapsed)
        self._js(f"typeof setStep==='function'&&setStep({key!r},{int(step)})")

    def _start_services(self) -> None:
        # 三个服务同时启动、同时等待：后端要花几秒加载代码，数据库的启动时间正好被它盖住；三条进度条一起往前走。
        # 后端自己会等数据库可写之后才开始服务（见 run_backend.py），所以不会抢跑。
        self._status("正在启动数据库、后端服务和写作界面…" + ("（开发模式首次编译前端较慢）" if self.config.dev else ""))
        self._started, self._timeline = time.monotonic(), {}
        trace.mark("services_start")
        for key, service in zip(("db", "api", "ui"), self.services):
            with trace.span(f"service.{key}.spawn"):
                service.start()
        self._js("typeof beginSplash==='function'&&beginSplash()")
        names = {"db": "数据库", "api": "后端服务", "ui": "写作界面"}
        finished: queue.Queue = queue.Queue()

        def wait(key: str, service: Service) -> None:
            try:
                with trace.span(f"service.{key}.wait_ready"):
                    service.wait_ready(lambda step: self._step(key, step))
                finished.put((key, None))
            except BaseException as exc:  # 由主流程统一报错
                finished.put((key, exc))

        keys = ("db", "api", "ui")
        for key, service in zip(keys, (self.mongo, self.backend, self.frontend)):
            threading.Thread(target=wait, args=(key, service), name=f"wait-{key}", daemon=True).start()
        pending = set(keys)
        while pending:
            key, error = finished.get()
            if self.closing.is_set():
                return
            if error is not None:
                raise error
            pending.discard(key)
            rest = "、".join(names[k] for k in keys if k in pending)
            self._status(f"{names[key]}已就绪" + (f"，还在等{rest}…" if rest else "，正在进入写作界面…"))
        trace.mark("all_services_ready")

    def _enter(self) -> None:
        """三条进度都满了：等启动页放完退场动画再切到写作界面，记下这次各步的耗时。"""
        with trace.span("splash_exit"):
            wait = self._js("typeof finishSplash==='function'?finishSplash():0")
            if isinstance(wait, (int, float)) and wait > 0:
                time.sleep(min(float(wait), 4000) / 1000)
        if self.closing.is_set():
            return
        logger.info("界面地址 %s", self.config.frontend_url)
        self._entering = True
        with trace.span("frontend_navigation"):
            self.window.load_url(self.config.frontend_url)
        startup_timing.save(self.config.paths.data_dir, self._timeline)
        trace.mark("frontend_navigation_requested")

    def _on_page_loaded(self) -> None:
        # 启动页本身也触发 loaded；只有目标页面真正加载后才记完成。
        if self._entering and not self._page_loaded:
            current = self.window.get_current_url() if self.window else None
            base = self.config.frontend_url.rstrip("/")
            if current and (current == base or current.startswith(base + "/")):
                self._page_loaded = True
                trace.mark("frontend_document_loaded")

    def _keep_on_screen(self) -> None:
        """窗口显示后核对一次：超出所在显示器的可用区域就缩小并移回来。出任何问题都不能影响启动。"""
        try:
            shown = getattr(getattr(self.window, "events", None), "shown", None)
            if shown is not None:
                shown.wait(10)
            if screen.keep_on_screen(self._title):
                logger.info("窗口超出屏幕可用区域，已缩小并移回屏幕内")
        except Exception:
            logger.exception("检查窗口位置失败")

    def _check_service_exits(self) -> None:
        """启动后也检查托管进程；异常退出只提示并记录，不重放请求或刷新草稿。"""
        if self.closing.is_set():
            return
        messages = []
        for service in self.services:
            proc = getattr(service, "proc", None)
            if proc is None:
                continue
            code = proc.poll()
            if code is None:
                continue
            identity = (service.name, proc.pid)
            if identity not in self._reported_exits:
                self._reported_exits.add(identity)
                logger.error("运行期间服务退出 name=%s pid=%s exit_code=%s", service.name, proc.pid, code)
                trace.mark("service_exited", service=service.name, service_pid=proc.pid, exit_code=code)
            messages.append(f"{service.label}已停止（退出码 {code}）")
        if messages:
            text = "；".join(messages) + "。请先复制保留未保存的正文，再退出并重新打开软件。"
            self._js("""(() => {
              if (!document.body) return;
              let notice = document.getElementById('novel-service-exit');
              if (!notice) {
                notice = document.createElement('div');
                notice.id = 'novel-service-exit'; notice.setAttribute('role', 'alert');
                notice.style.cssText = 'position:fixed;bottom:12px;left:12px;right:12px;z-index:2147483647;background:#7f1d1d;color:white;padding:12px;border-radius:8px;font:14px/1.5 sans-serif';
                document.body.appendChild(notice);
              }
              notice.textContent = """ + json.dumps(text, ensure_ascii=False) + "; })()")

    def _monitor_services(self) -> None:
        while not self.closing.wait(3):
            try:
                self._check_service_exits()
            except Exception:
                logger.exception("检查运行期间服务状态失败")

    def boot(self) -> None:
        """在 pywebview 的后台线程中执行。"""
        trace.mark("webview_boot_callback")
        with trace.span("window_screen_check"):
            self._keep_on_screen()
        with trace.span("window_icons"):
            icons.apply(self.config, look_store.load(self.config.paths.data_dir), shortcut=False)
        try:
            self._start_services()
            if not self.closing.is_set():
                self._enter()
                threading.Thread(target=self._monitor_services, name="service-monitor", daemon=True).start()
        except Exception as exc:
            trace.mark("startup_failed", error_type=type(exc).__name__)
            logger.exception("启动失败")
            tail = exc.service.log_tail() if isinstance(exc, ServiceError) else ""
            self.window.load_html(
                ERROR_HTML.replace("__MESSAGE__", html.escape(str(exc)))
                .replace("__LOGDIR__", html.escape(str(self.config.paths.logs_dir)))
                .replace("__TAIL__", html.escape(tail or "（无日志）"))
            )

    # ---- 关闭 ----
    def shutdown(self) -> None:
        self.closing.set()
        for service in reversed(self.services):
            try:
                service.stop()
            except Exception:
                logger.exception("停止 %s 失败", service.label)
        self.job.close()  # 兜底：结束所有残留子进程
        logger.info("已退出")

    def run(self) -> None:
        trace.mark("window_setup_start")
        s = self.config.settings
        title = s.title + ("（开发模式）" if self.config.dev else "")
        self._title = title
        # pywebview 会把窗口按系统缩放比例放大，高缩放的屏幕上会超出可用区域，所以先按屏幕限制尺寸。
        width, height, min_size = screen.fit_window(s.width, s.height, s.min_width, s.min_height, screen.query_work_area())
        webview.settings["ALLOW_DOWNLOADS"] = True  # 导出小说需要
        debug_port = os.environ.get("NOVEL_CLIENT_DEBUG_PORT", "").strip()
        if debug_port.isdigit():
            # 诊断用：打开窗口的远程调试端口，可用 tools/cdp.py 连上真实窗口检查页面
            webview.settings["REMOTE_DEBUGGING_PORT"] = int(debug_port)
        install_in_window_navigation(self.config.frontend_url)
        look = look_store.load(self.config.paths.data_dir)
        self.window = webview.create_window(
            title,
            html=render_splash(s.title, look, startup_timing.load(self.config.paths.data_dir)),
            width=width, height=height, min_size=min_size,
            background_color=look.colors["background"],  # 启动页载入前窗口的底色，避免先闪一下白
            text_select=True,  # pywebview 默认为 False，会禁止选择报错、正文等页面文字。
            js_api=Api(self.config),
        )
        trace.mark("window_created")
        events = getattr(self.window, "events", None)
        if events is not None:
            events.loaded += self._on_page_loaded
        try:
            trace.mark("webview_start")
            webview.start(
                self.boot,
                debug=s.debug,
                private_mode=False,  # 保留界面的本地设置（主题、语言等）
                storage_path=str(self.config.paths.data_dir / "webview"),
            )
        finally:
            self.shutdown()


def main() -> None:
    with trace.span("client_config"):
        config = load_config()
    config.paths.logs_dir.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        filename=config.paths.logs_dir / "client.log", filemode="w", encoding="utf-8",
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
    )
    trace.configure(config.paths.logs_dir, "client")
    logger.info("模式=%s 数据目录=%s", "开发" if config.dev else "打包", config.paths.data_dir)
    ClientApp(config).run()
