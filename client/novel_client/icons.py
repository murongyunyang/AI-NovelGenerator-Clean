"""按当前界面风格生成应用图标，并同步窗口与桌面快捷方式。

图标使用用户数据目录中带内容哈希的文件名：切换主题时快捷方式指向一个新文件，
Windows 不会继续显示旧图标的缓存。图标生成或刷新失败只记日志，不影响主题切换。
"""

from __future__ import annotations

import ctypes
import hashlib
import json
import logging
import os
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw

from .config import CLIENT_DIR, ClientConfig
from .look import Look

logger = logging.getLogger(__name__)
_NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
ICON_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
_WINDOW_ICONS: list[int] = []


def _rgb(value: str) -> tuple[int, int, int]:
    return tuple(int(value[index:index + 2], 16) for index in (1, 3, 5))


def _mix(a: tuple[int, int, int], b: tuple[int, int, int], amount: float) -> tuple[int, int, int]:
    return tuple(round(x * (1 - amount) + y * amount) for x, y in zip(a, b))


def _line(draw: ImageDraw.ImageDraw, points, fill, width=10) -> None:
    draw.line(points, fill=fill, width=width, joint="curve")


def _motif(draw: ImageDraw.ImageDraw, look: str, color, secondary) -> None:
    """画在书页上的小图案；十一套风格除配色外也有各自的辨识度。"""
    if look == "tech":
        _line(draw, [(190, 260), (232, 224), (278, 252), (326, 206)], color, 11)
        for x, y in ((190, 260), (232, 224), (278, 252), (326, 206)):
            draw.ellipse((x - 13, y - 13, x + 13, y + 13), fill=secondary, outline=color, width=7)
        _line(draw, [(318, 164), (318, 194)], secondary, 9)
        _line(draw, [(303, 179), (333, 179)], secondary, 9)
    elif look == "mist":
        for y, shift in ((214, 0), (252, 20), (290, -8)):
            _line(draw, [(166 + shift, y), (208 + shift, y - 15), (254 + shift, y + 4), (310 + shift, y - 12), (346 + shift, y - 4)], color, 9)
    elif look == "forest":
        _line(draw, [(250, 306), (256, 202)], color, 11)
        draw.ellipse((184, 190, 257, 245), fill=secondary, outline=color, width=7)
        draw.ellipse((253, 221, 334, 282), fill=secondary, outline=color, width=7)
        _line(draw, [(205, 211), (253, 240)], color, 6)
        _line(draw, [(262, 263), (311, 242)], color, 6)
    elif look == "warm":
        _line(draw, [(198, 308), (314, 180)], color, 12)
        draw.polygon([(206, 284), (190, 202), (278, 164), (318, 181), (284, 254)], fill=secondary, outline=color)
        _line(draw, [(214, 269), (291, 196)], color, 7)
    elif look == "cute":
        draw.polygon([(256, 310), (178, 238), (181, 199), (207, 180), (235, 184), (256, 207),
                      (278, 184), (307, 180), (333, 200), (334, 238)], fill=secondary, outline=color)
        _line(draw, [(197, 236), (256, 292), (316, 236)], color, 7)
    elif look == "casual":
        draw.polygon([(164, 230), (346, 166), (286, 310), (246, 253)], fill=secondary, outline=color)
        _line(draw, [(246, 253), (346, 166), (224, 269)], color, 8)
    elif look == "sunny":
        draw.ellipse((213, 193, 299, 279), fill=secondary, outline=color, width=8)
        for points in (((256, 158), (256, 178)), ((256, 294), (256, 314)), ((176, 236), (196, 236)),
                       ((316, 236), (336, 236)), ((199, 179), (213, 193)), ((299, 279), (313, 293)),
                       ((199, 293), (213, 279)), ((299, 193), (313, 179))):
            _line(draw, points, color, 9)
    elif look == "heal":
        draw.pieslice((178, 188, 266, 310), 185, 355, fill=secondary, outline=color, width=7)
        draw.pieslice((246, 188, 334, 310), 185, 355, fill=secondary, outline=color, width=7)
        _line(draw, [(184, 286), (230, 304), (256, 296), (282, 304), (328, 286)], color, 9)
    elif look == "ink":
        _line(draw, [(170, 294), (222, 226), (254, 264), (298, 194), (344, 286)], color, 13)
        _line(draw, [(188, 314), (328, 314)], secondary, 8)
        draw.ellipse((292, 164, 326, 198), fill=secondary)
    elif look == "retro":
        draw.polygon([(256, 160), (270, 216), (328, 230), (270, 244), (256, 304), (242, 244),
                      (184, 230), (242, 216)], fill=secondary, outline=color)
        draw.rectangle((184, 292, 210, 318), fill=color)
        draw.rectangle((306, 154, 332, 180), fill=color)
    else:  # minimal：只保留三条克制的手稿线
        for y, width in ((208, 132), (248, 148), (288, 104)):
            _line(draw, [(256 - width // 2, y), (256 + width // 2, y)], color, 8)


def render(look: Look) -> Image.Image:
    """生成 512×512 的透明底图标，保存 ICO 时再缩小到各系统尺寸。"""
    size = 512
    accent = _rgb(look.colors["accent"])
    background = _rgb(look.colors["background"])
    foreground = _rgb(look.colors["foreground"])
    surface = _rgb(look.colors["surface"])
    top = _mix(accent, foreground, 0.12 if look.dark else 0.04)
    bottom = _mix(accent, background, 0.58 if look.dark else 0.40)
    image = Image.new("RGBA", (size, size))
    gradient = Image.new("RGBA", (size, size))
    gd = ImageDraw.Draw(gradient)
    for y in range(size):
        gd.line((0, y, size, y), fill=(*_mix(top, bottom, y / (size - 1)), 255))
    mask = Image.new("L", (size, size))
    ImageDraw.Draw(mask).rounded_rectangle((18, 18, 494, 494), radius=112, fill=255)
    image.paste(gradient, (0, 0), mask)
    draw = ImageDraw.Draw(image, "RGBA")
    draw.rounded_rectangle((25, 25, 487, 487), radius=104, outline=(*surface, 105), width=4)

    page = (248, 252, 255) if look.dark else _mix(surface, (255, 255, 255), 0.65)
    edge = _mix(accent, background, 0.52)
    shadow = (*_mix(accent, background, 0.72), 115)
    draw.rounded_rectangle((101, 151, 405, 397), radius=40, fill=shadow)
    left = [(106, 143), (238, 164), (256, 376), (124, 350)]
    right = [(238, 164), (390, 139), (382, 352), (256, 376)]
    draw.polygon(left, fill=(*page, 255), outline=(*edge, 255))
    draw.polygon(right, fill=(*_mix(page, accent, 0.035), 255), outline=(*edge, 255))
    _line(draw, [(239, 172), (256, 369)], (*edge, 190), 7)
    _line(draw, [(127, 350), (256, 382), (381, 352)], (*edge, 220), 8)
    _motif(draw, look.look, (*edge, 255), (*_mix(accent, page, 0.20), 255))
    return image


def write_icon(data_dir: Path, look: Look) -> Path:
    """把当前风格写成带内容哈希的 ICO；相同风格直接复用。"""
    payload = json.dumps({"look": look.look, "dark": look.dark, "colors": look.colors}, sort_keys=True)
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]
    mode = "dark" if look.dark else "light"
    target = data_dir / "icons" / f"{look.look}-{mode}-{digest}.ico"
    if target.exists():
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".tmp")
    render(look).save(temporary, format="ICO", sizes=ICON_SIZES)
    os.replace(temporary, target)
    return target


def set_window_icon(icon: Path) -> None:
    """给当前 Python 进程拥有的可见窗口换图标（标题栏和任务栏）。"""
    if os.name != "nt":
        return
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    hwnd_type = ctypes.c_void_p
    callback_type = ctypes.WINFUNCTYPE(ctypes.c_bool, hwnd_type, ctypes.c_void_p)
    user32.EnumWindows.argtypes = [callback_type, ctypes.c_void_p]
    user32.GetWindowThreadProcessId.argtypes = [hwnd_type, ctypes.POINTER(ctypes.c_ulong)]
    user32.IsWindowVisible.argtypes = [hwnd_type]
    user32.LoadImageW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_uint, ctypes.c_int, ctypes.c_int, ctypes.c_uint]
    user32.LoadImageW.restype = ctypes.c_void_p
    user32.SendMessageW.argtypes = [hwnd_type, ctypes.c_uint, ctypes.c_ulong, ctypes.c_void_p]
    user32.SendMessageW.restype = ctypes.c_void_p
    windows: list[int] = []
    pid = os.getpid()

    def visit(hwnd, _):
        owner = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid and user32.IsWindowVisible(hwnd):
            windows.append(hwnd)
        return True

    user32.EnumWindows(callback_type(visit), None)
    for hwnd in windows:
        for kind, dimension in ((0, 16), (1, 32)):
            handle = user32.LoadImageW(None, str(icon), 1, dimension, dimension, 0x10)
            if handle:
                user32.SendMessageW(hwnd, 0x0080, kind, handle)
                _WINDOW_ICONS.append(handle)  # 句柄随进程存活，避免 Windows 正在使用时被释放
    del _WINDOW_ICONS[:-44]


def update_shortcut(config: ClientConfig, icon: Path) -> None:
    """只更新已存在的桌面快捷方式；开发模式和不存在的快捷方式不新建。"""
    exe = CLIENT_DIR.parent / f"{config.settings.exe_name}.exe"
    script = (
        "$d=[Environment]::GetFolderPath('Desktop');$p=Join-Path $d ($env:SC_NAME+'.lnk');"
        "if(Test-Path -LiteralPath $p){$s=(New-Object -ComObject WScript.Shell).CreateShortcut($p);"
        "$s.IconLocation=$env:SC_ICON+',0';$s.Save()}"
    )
    subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                   env={**os.environ, "SC_NAME": config.settings.exe_name, "SC_ICON": str(icon)},
                   capture_output=True, text=True, encoding="utf-8", errors="replace", check=True, timeout=15,
                   creationflags=_NO_WINDOW)
    if exe.exists() and os.name == "nt":
        ctypes.WinDLL("shell32").SHChangeNotify(0x08000000, 0, None, None)


def apply(config: ClientConfig, look: Look, *, shortcut: bool = True) -> Path | None:
    """生成并应用图标。任何系统接口失败都不阻断网页里的主题切换。"""
    try:
        icon = write_icon(config.paths.data_dir, look)
    except Exception:
        logger.exception("生成主题图标失败")
        return None
    try:
        set_window_icon(icon)
    except Exception:
        logger.exception("更新窗口图标失败", exc_info=True)
    if shortcut and not config.dev and (CLIENT_DIR / "packaged.json").exists():
        try:
            update_shortcut(config, icon)
        except Exception:
            logger.exception("更新桌面快捷方式图标失败")
    return icon
