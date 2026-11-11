"""窗口内的导航策略：本应用的页面留在窗口里，外部链接交给系统浏览器。

pywebview 默认把所有“新窗口”请求（window.open、target=_blank）都交给系统浏览器，
结果设置页里的“配置流程”会跳出去。这里只对本应用自己的地址改为在窗口内打开。
"""

from __future__ import annotations

import logging
from urllib.parse import urlsplit

logger = logging.getLogger("novel_client")
_PATCHED_MARK = "_novel_client_patched"


def is_app_url(uri: str, app_base_url: str) -> bool:
    """uri 是否属于本应用的前端（协议、主机、端口都相同）。"""
    try:
        target, base = urlsplit(uri), urlsplit(app_base_url)
        return (target.scheme, target.hostname, target.port) == (base.scheme, base.hostname, base.port) and bool(base.hostname)
    except ValueError:
        return False


def make_new_window_handler(original, app_base_url: str):
    """本应用留在窗口内；只有用户主动打开的外部网页才能启动系统浏览器。"""
    def handler(self, sender, args):
        uri = str(args.get_Uri())
        if is_app_url(uri, app_base_url):
            args.set_Handled(True)
            self.load_url(uri)
            return
        try:
            target = urlsplit(uri)
            external_page = target.scheme in {"http", "https"} and bool(target.hostname)
        except ValueError:
            external_page = False
        if external_page and args.IsUserInitiated:
            original(self, sender, args)
        else:
            # 拖入的本地文件、空白页和自动弹窗不能交给系统浏览器。
            args.set_Handled(True)

    setattr(handler, _PATCHED_MARK, True)
    handler.__wrapped__ = original
    return handler


def make_navigation_handler(original):
    """阻止未被页面接管的本地文件拖放替换应用页面。"""
    def handler(self, sender, args):
        if str(args.get_Uri()).lower().startswith("file:"):
            args.set_Cancel(True)
            return
        original(self, sender, args)

    setattr(handler, _PATCHED_MARK, True)
    handler.__wrapped__ = original
    return handler


def install_in_window_navigation(app_base_url: str) -> bool:
    """给 pywebview 的 Edge 后端安装上述策略。必须在窗口创建之前调用。

    Returns:
        是否安装成功；pywebview 内部结构变化时返回 False，此时退回默认行为（链接在系统浏览器打开）。
    """
    try:
        from webview.platforms import edgechromium
        edge = edgechromium.EdgeChrome
        current = edge.on_new_window_request
        if getattr(current, _PATCHED_MARK, False):
            current = current.__wrapped__  # 重复调用（如更换地址）时基于原函数重新包装
        edge.on_new_window_request = make_new_window_handler(current, app_base_url)
        current_navigation = edge.on_navigation_start
        if getattr(current_navigation, _PATCHED_MARK, False):
            current_navigation = current_navigation.__wrapped__
        edge.on_navigation_start = make_navigation_handler(current_navigation)
        return True
    except Exception:
        logger.exception("无法安装窗口内导航，配置页将在系统浏览器中打开")
        return False
