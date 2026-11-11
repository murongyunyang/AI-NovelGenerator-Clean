"""界面风格的本地记录：网页切换风格或亮暗时通过 JS 接口报给客户端，下次启动时启动页按它配色、画对应风格的小场景。

启动页在网页载入之前显示，读不到网页的 localStorage，所以要单独存一份。只接受固定字段、十一种风格名之一和 #rrggbb 颜色，
其余一律丢弃，文件损坏或不存在时用默认的科技暗色。"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger("novel_client")

FILE_NAME = "client_look.json"
COLOR_KEYS = ("background", "foreground", "muted", "accent", "border", "surface")
# 和前端 frontend/src/lib/themes.ts 的 THEME_PRESETS 一一对应；网页报来的风格名不在其中就整条不收。
LOOK_IDS = ("tech", "mist", "forest", "warm", "cute", "casual", "sunny", "heal", "ink", "retro", "minimal")
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


@dataclass(frozen=True)
class Look:
    look: str = "tech"
    dark: bool = True
    colors: dict[str, str] = field(default_factory=lambda: {
        "background": "#060a13", "foreground": "#dbe7ff", "muted": "#8ea4c8",
        "accent": "#22d3ee", "border": "#1d2e4a", "surface": "#0c1322",
    })


DEFAULT = Look()


def parse(data: object) -> Look | None:
    """校验网页报来的内容；任何字段不合格都返回 None，不做部分保存。"""
    if not isinstance(data, dict):
        return None
    look, dark, colors = data.get("look"), data.get("dark"), data.get("colors")
    if not isinstance(look, str) or look not in LOOK_IDS or not isinstance(dark, bool) or not isinstance(colors, dict):
        return None
    picked = {key: colors.get(key) for key in COLOR_KEYS}
    if not all(isinstance(value, str) and _HEX.match(value) for value in picked.values()):
        return None
    return Look(look, dark, {key: value.lower() for key, value in picked.items()})


def load(data_dir: Path) -> Look:
    try:
        return parse(json.loads((data_dir / FILE_NAME).read_text(encoding="utf-8"))) or DEFAULT
    except (OSError, ValueError):
        return DEFAULT


def save(data_dir: Path, data: object) -> bool:
    """先写临时文件再替换，写到一半断电也不会留下坏文件。"""
    look = parse(data)
    if look is None:
        return False
    target = data_dir / FILE_NAME
    tmp = target.with_suffix(".tmp")
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps({"look": look.look, "dark": look.dark, "colors": look.colors}), encoding="utf-8")
        os.replace(tmp, target)
    except OSError:
        logger.exception("保存界面风格失败")
        return False
    return True
