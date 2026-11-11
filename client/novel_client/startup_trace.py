"""本次启动的原始毫秒计时；与启动动画使用的平滑历史值分开保存。"""
from __future__ import annotations

import time

_START_NS = time.perf_counter_ns()

from collections import deque
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path
import threading
import uuid


class StartupTrace:
    def __init__(self, *, clock=time.perf_counter_ns, start_ns=None):
        self.clock = clock
        self.started_ns = clock() if start_ns is None else start_ns
        self.origin_ns = self.started_ns
        self.session = uuid.uuid4().hex[:16]
        self.path: Path | None = None
        self.pending = deque(maxlen=256)
        self.lock = threading.Lock()

    def configure(self, directory: Path, process: str, *, environ=None) -> None:
        """每个进程单独写文件，并保留上一次；日志写失败不影响启动。"""
        with self.lock:
            if environ is not None:
                try:
                    origin = int(environ.get("NOVEL_CLIENT_STARTUP_ORIGIN_NS", ""))
                    if 0 <= origin <= self.started_ns:
                        self.origin_ns = origin
                        self.session = environ.get("NOVEL_CLIENT_STARTUP_SESSION", self.session)
                except (TypeError, ValueError):
                    pass
            target = Path(directory) / f"startup-{process}.jsonl"
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists():
                    os.replace(target, target.with_suffix(".previous.jsonl"))
                target.write_text("", encoding="utf-8")
                self.path = target
                for row in self.pending:
                    self._write(row)
                self.pending.clear()
            except OSError:
                self.path = None
                logging.getLogger("novel_client").warning("启动计时日志不可写，继续正常启动")

    def child_env(self) -> dict[str, str]:
        return {"NOVEL_CLIENT_STARTUP_ORIGIN_NS": str(self.origin_ns),
                "NOVEL_CLIENT_STARTUP_SESSION": self.session}

    def _write(self, row: dict) -> None:
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    def mark(self, phase: str, **fields) -> None:
        with self.lock:
            now = self.clock()
            row = {"timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                   "session": self.session, "pid": os.getpid(), "phase": phase,
                   "elapsed_ms": round((now - self.origin_ns) / 1_000_000, 3),
                   "process_elapsed_ms": round((now - self.started_ns) / 1_000_000, 3), **fields}
            if self.path is None:
                self.pending.append(row)
                return
            try:
                self._write(row)
            except OSError:
                # 写盘故障只停止诊断输出，不能让窗口或服务无法启动。
                self.path = None

    @contextmanager
    def span(self, phase: str):
        started = self.clock()
        self.mark(phase + ".start")
        outcome = "ok"
        try:
            yield
        except BaseException:
            outcome = "error"
            raise
        finally:
            self.mark(phase + ".end", duration_ms=round((self.clock() - started) / 1_000_000, 3),
                      outcome=outcome)


trace = StartupTrace(start_ns=_START_NS)
