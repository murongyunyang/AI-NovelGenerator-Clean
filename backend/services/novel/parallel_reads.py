"""同一步里连续的几个只读查询同时执行。

模型常在一步里一起要几章正文、几处搜索。以前逐个等结果，几次数据库读取和文本处理排成一串；
现在把连续的只读查询提前一起启动，按原来的顺序取结果，交给模型的结果顺序和以前完全一样。
只合并“连续的”只读调用：中间夹着修改的，修改之后的查询要看到修改后的书，仍在修改完成后才读。
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Sequence
from contextlib import suppress
from typing import Any


class Prefetch:
    """按调用下标保存提前启动的查询；没用上的在结束时取消，异常不会遗留成“未取回的任务异常”。"""

    def __init__(self) -> None:
        self.tasks: dict[int, asyncio.Task] = {}

    def start(self, calls: Sequence[Any], index: int, is_read: Callable[[Any], bool],
              run: Callable[[Any], Awaitable[Any]]) -> None:
        """从 index 起连续的只读调用不止一个时，一起启动（已经启动过的不重复启动）。"""
        if index in self.tasks:
            return
        end = index
        while end < len(calls) and is_read(calls[end]):
            end += 1
        if end - index < 2:
            return
        for position in range(index, end):
            self.tasks[position] = asyncio.ensure_future(run(calls[position]))

    def take(self, index: int) -> asyncio.Task | None:
        return self.tasks.pop(index, None)

    async def close(self) -> None:
        pending = list(self.tasks.values())
        self.tasks.clear()
        for task in pending:
            task.cancel()
        for task in pending:
            with suppress(asyncio.CancelledError, Exception):
                await task
