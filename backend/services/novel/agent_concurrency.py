"""可在任务运行中调整的并发闸门；降低上限不取消正在执行的工作。"""

import asyncio


class AdjustableGate:
    def __init__(self, limit: int):
        self.limit = max(1, limit)
        self.active = 0
        self._changed = asyncio.Condition()

    def resize(self, limit: int) -> None:
        self.limit = max(1, limit)
        asyncio.create_task(self._notify())

    async def _notify(self) -> None:
        async with self._changed:
            self._changed.notify_all()

    async def acquire(self) -> None:
        async with self._changed:
            while self.active >= self.limit:
                await self._changed.wait()
            self.active += 1

    def release(self) -> None:
        self.active -= 1
        asyncio.create_task(self._notify())

    async def __aenter__(self):
        await self.acquire()
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        self.release()
