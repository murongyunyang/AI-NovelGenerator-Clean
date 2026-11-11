"""启动页进度条的节奏：记下每个服务到达各个启动步骤用了多少毫秒，下次启动时进度条照这个节奏往前走。

进度条只在服务真正到达某一步时才越过那一步；节奏只决定两步之间怎么平滑地走，所以记录不准也不会显示假的“已完成”。
没有记录时用一台普通电脑热启动的大致耗时。每次启动成功后和旧记录取平均，偶尔一次特别慢不会把节奏带偏。
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

logger = logging.getLogger("novel_client")

FILE_NAME = "startup_timing.json"
# 各服务的步骤数与 services.py 的 milestones() + 1 一致：数据库 2 步，后端 4 步，写作界面 2 步。
DEFAULTS: dict[str, list[int]] = {
    "db": [1200, 3000],
    "api": [3200, 3600, 4400, 5300],
    "ui": [1500, 5800],
}
MAX_MS = 600_000


def _valid(rows: object) -> dict[str, list[int]] | None:
    if not isinstance(rows, dict):
        return None
    result = {}
    for key, default in DEFAULTS.items():
        values = rows.get(key)
        if not isinstance(values, list) or len(values) != len(default):
            return None
        if not all(isinstance(value, (int, float)) and 0 <= value <= MAX_MS for value in values):
            return None
        if any(later < earlier for earlier, later in zip(values, values[1:])):
            return None
        result[key] = [int(value) for value in values]
    return result


def load(data_dir: Path) -> dict[str, list[int]]:
    try:
        return _valid(json.loads((data_dir / FILE_NAME).read_text(encoding="utf-8"))) or {key: list(value) for key, value in DEFAULTS.items()}
    except (OSError, ValueError):
        return {key: list(value) for key, value in DEFAULTS.items()}


def merge(previous: dict[str, list[int]], measured: dict[str, list[int]]) -> dict[str, list[int]]:
    """和旧记录各取一半；本次某个服务没测全就沿用旧记录。"""
    result = {}
    for key, old in previous.items():
        new = measured.get(key)
        result[key] = [round((a + b) / 2) for a, b in zip(old, new)] if new and len(new) == len(old) else list(old)
        for index in range(1, len(result[key])):
            result[key][index] = max(result[key][index], result[key][index - 1])
    return result


def save(data_dir: Path, measured: dict[str, list[int]]) -> None:
    """先写临时文件再替换；保存失败只记日志，不影响使用。"""
    rows = _valid(merge(load(data_dir), measured))
    if rows is None:
        return
    target = data_dir / FILE_NAME
    tmp = target.with_suffix(".tmp")
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(rows), encoding="utf-8")
        os.replace(tmp, target)
    except OSError:
        logger.exception("保存启动耗时失败")
