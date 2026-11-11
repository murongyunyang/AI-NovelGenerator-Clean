"""旧桌面版配置迁移及更新前备份。配置和密钥只留在用户数据目录。"""

from __future__ import annotations

import hashlib
import logging
import os
from pathlib import Path
import secrets

logger = logging.getLogger(__name__)


def _write_atomic(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    try:
        with temporary.open("xb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def backup_config_file(source: Path, data_dir: Path) -> Path:
    """按内容去重备份，并核对完整字节；失败时禁止继续更新。"""
    content = source.read_bytes()
    digest = hashlib.sha256(content).hexdigest()
    backup = data_dir / "user_data" / "backups" / "settings" / f"{source.stem}-{digest}{source.suffix}"
    if not backup.exists():
        _write_atomic(backup, content)
    if backup.read_bytes() != content:
        raise RuntimeError(f"配置备份校验失败，未继续更新：{source}")
    return backup


def preserve_user_config(app_dir: Path, data_dir: Path) -> None:
    """迁移旧程序目录中的配置，已有正式配置始终优先，所有不同副本均备份。"""
    target = data_dir / "user_data" / "config" / "config.yaml"
    legacy = [path for path in (
        app_dir / "backend" / "config" / "config.yaml",
        app_dir / "user_data" / "config" / "config.yaml",
    ) if path.is_file() and path.resolve() != target.resolve()]
    for source in ([target] if target.is_file() else []) + legacy:
        backup_config_file(source, data_dir)
    if target.exists():
        if any(source.read_bytes() != target.read_bytes() for source in legacy):
            logger.warning("旧版配置与用户配置不同，已分别备份并保留当前用户配置。备份目录：%s",
                           data_dir / "user_data" / "backups" / "settings")
        return
    if legacy:
        content = legacy[0].read_bytes()
        if any(source.read_bytes() != content for source in legacy[1:]):
            raise RuntimeError("发现不同的旧版配置，已分别备份；请核对后再更新，未覆盖任何配置。")
        _write_atomic(target, content)
        if target.read_bytes() != content:
            raise RuntimeError("旧版配置迁移校验失败，未继续更新。")
