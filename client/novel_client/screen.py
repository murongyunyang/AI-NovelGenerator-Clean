"""窗口尺寸与屏幕适配。

pywebview 在 Windows 上会把窗口按系统缩放比例放大：client.toml 里 1400×900 的窗口，在 125% 缩放、可用高度 1020 像素的屏幕上
实际是 1746×1102，下沿被任务栏遮住。这里根据显示器的可用区域和缩放比例，在创建窗口前先把尺寸限制到屏幕内；
窗口显示后再核对一次，超出就缩小并移回屏幕内。
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass

# 窗口最多占可用区域的比例，给边框、阴影和任务栏边缘留一点余量。
SAFE_FRACTION = 0.98
# 窗口看不见的边框宽度（物理像素），超出屏幕不超过这个值时不算超出。
HIDDEN_BORDER = 8


@dataclass(frozen=True)
class WorkArea:
    width: int    # 物理像素，不含任务栏
    height: int
    scale: float  # 系统缩放比例，125% 为 1.25


def _system_dpi(ctypes, user32) -> int:
    try:
        return int(user32.GetDpiForSystem())
    except Exception:  # Windows 10 1607 之前没有这个接口
        hdc = user32.GetDC(0)
        try:
            return int(ctypes.WinDLL("gdi32").GetDeviceCaps(hdc, 88))  # LOGPIXELSX
        finally:
            user32.ReleaseDC(0, hdc)


def query_work_area() -> WorkArea | None:
    """主显示器的可用区域和系统缩放比例；不是 Windows 或查询失败时返回 None，窗口保持配置的尺寸。"""
    if sys.platform != "win32":
        return None
    try:
        import ctypes
        from ctypes import wintypes
        user32 = ctypes.WinDLL("user32")  # 独立实例，不改动 pywebview 共用的 windll.user32
        user32.SetProcessDPIAware()  # 与 pywebview 之后的做法相同，保证拿到的是物理像素
        rect = wintypes.RECT()
        if not user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(rect), 0):  # SPI_GETWORKAREA
            return None
        return WorkArea(rect.right - rect.left, rect.bottom - rect.top, max(_system_dpi(ctypes, user32), 96) / 96)
    except Exception:
        return None


def fit_window(width: int, height: int, min_width: int, min_height: int, area: WorkArea | None) -> tuple[int, int, tuple[int, int]]:
    """把配置的窗口大小（pywebview 会再乘以缩放比例）限制在可用区域内。最小尺寸也不能超过可用区域，否则窗口永远放不下。"""
    if area is None or area.width <= 0 or area.height <= 0:
        return width, height, (min_width, min_height)
    scale = area.scale if area.scale > 0 else 1.0
    limit_w, limit_h = max(1, int(area.width * SAFE_FRACTION / scale)), max(1, int(area.height * SAFE_FRACTION / scale))
    min_w, min_h = min(min_width, limit_w), min(min_height, limit_h)
    return max(min_w, min(width, limit_w)), max(min_h, min(height, limit_h)), (min_w, min_h)


def keep_on_screen(title: str) -> bool:
    """按标题找到本进程的窗口；超出所在显示器的可用区域就缩小并移回屏幕内。返回是否做了调整。

    Windows 10 以上的窗口左、右、下各有约 7 像素看不见的边框，小幅超出不算，避免无谓地移动窗口。
    """
    if sys.platform != "win32" or not title:
        return False
    import ctypes
    from ctypes import wintypes

    class MonitorInfo(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT), ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD)]

    user32 = ctypes.WinDLL("user32")  # 独立实例：下面设置的参数类型不会影响 pywebview 共用的 windll.user32
    user32.FindWindowW.argtypes, user32.FindWindowW.restype = [wintypes.LPCWSTR, wintypes.LPCWSTR], wintypes.HWND
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.IsZoomed.argtypes = [wintypes.HWND]
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.MonitorFromWindow.argtypes, user32.MonitorFromWindow.restype = [wintypes.HWND, wintypes.DWORD], wintypes.HANDLE
    user32.GetMonitorInfoW.argtypes = [wintypes.HANDLE, ctypes.POINTER(MonitorInfo)]
    user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]

    hwnd = user32.FindWindowW(None, title)
    if not hwnd:
        return False
    owner = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
    if owner.value != os.getpid() or user32.IsZoomed(hwnd):  # 只处理自己进程的窗口；最大化的窗口本来就铺满
        return False
    rect, info = wintypes.RECT(), MonitorInfo()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    info.cbSize = ctypes.sizeof(MonitorInfo)
    monitor = user32.MonitorFromWindow(hwnd, 2)  # MONITOR_DEFAULTTONEAREST
    if not monitor or not user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
        return False
    work = info.rcWork
    overflow = max(work.left - rect.left, rect.right - work.right, work.top - rect.top, rect.bottom - work.bottom)
    if overflow <= HIDDEN_BORDER:
        return False
    width, height = min(rect.right - rect.left, work.right - work.left), min(rect.bottom - rect.top, work.bottom - work.top)
    left, top = min(max(rect.left, work.left), work.right - width), min(max(rect.top, work.top), work.bottom - height)
    return bool(user32.SetWindowPos(hwnd, None, left, top, width, height, 0x0004 | 0x0010))  # SWP_NOZORDER | SWP_NOACTIVATE
