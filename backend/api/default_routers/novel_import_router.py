"""从本机文件导入已有小说：先预览识别结果，确认后再导入。"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from typing import Any

from fastapi import APIRouter, File, Form, Header, UploadFile

from backend.api.default_routers.novel_router import _EXPECTED_NOVEL_ERRORS, _novel_http_exception
from backend.api.error_protocol import DomainApiError
from backend.services.novel import import_parser
from backend.services.novel.import_parser import MAX_FILE_BYTES, MAX_IMPORT_FILES, ImportParseError, ParsedNovel
from backend.services.novel.import_service import import_novel

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/novel-import", tags=["novel-import"])

PREVIEW_VOLUME_LIMIT = 50


async def _read_and_parse(files: list[UploadFile], title: str, mode: str, pattern: str,
                          chunk_size: int) -> tuple[ParsedNovel, list[dict[str, str]]]:
    if len(files) > MAX_IMPORT_FILES:
        raise DomainApiError("IMPORT_TOO_MANY_FILES", f"一次最多导入 {MAX_IMPORT_FILES} 个文件", status_code=422)
    documents, sources = [], []
    total_bytes = 0
    for file in files:
        raw = await file.read(MAX_FILE_BYTES - total_bytes + 1)
        total_bytes += len(raw)
        if total_bytes > MAX_FILE_BYTES:
            raise DomainApiError("IMPORT_FILE_TOO_LARGE", f"所选文件合计超过 {MAX_FILE_BYTES >> 20} MB，请减少文件后再导入", status_code=413)
        documents.append((file.filename or "", raw))
        sources.append({"name": file.filename or "", "sha256": hashlib.sha256(raw).hexdigest()})
    try:
        # 解析几十 MB 的文本是纯计算，放到线程里，不阻塞其他请求
        parsed = await asyncio.to_thread(import_parser.parse_files, documents,
                                         title=title, mode=mode, pattern=pattern, chunk_size=chunk_size)
    except ImportParseError as exc:
        raise DomainApiError("IMPORT_PARSE_FAILED", str(exc), status_code=422) from exc
    return parsed, sources


def _summary(parsed: ParsedNovel, file_count: int = 1) -> dict[str, Any]:
    return {
        "title": parsed.title, "encoding": parsed.encoding, "mode": parsed.mode,
        "file_count": file_count,
        "introduction_chars": len(parsed.introduction),
        "volume_count": len(parsed.volumes), "chapter_count": parsed.chapter_count, "word_count": parsed.word_count,
        "warnings": parsed.warnings,
        "volumes": [{
            "title": volume.title, "chapter_count": len(volume.chapters),
            "word_count": sum(import_parser.count_words(c.content) for c in volume.chapters),
            "first_titles": [c.title for c in volume.chapters[:3]],
            "last_title": volume.chapters[-1].title,
        } for volume in parsed.volumes[:PREVIEW_VOLUME_LIMIT]],
        "volumes_truncated": len(parsed.volumes) > PREVIEW_VOLUME_LIMIT,
    }


@router.post("/preview")
async def preview_import(
    files: list[UploadFile] = File(..., alias="file"), title: str = Form(""), mode: str = Form("auto"),
    pattern: str = Form(""), chunk_size: int = Form(3000),
) -> dict[str, Any]:
    """解析文件并返回识别结果，不写入任何数据。"""
    parsed, _ = await _read_and_parse(files, title, mode, pattern, chunk_size)
    return _summary(parsed, len(files))


@router.post("/commit")
async def commit_import(
    files: list[UploadFile] = File(..., alias="file"), title: str = Form(""), genre: str = Form("unclassified"), mode: str = Form("auto"),
    pattern: str = Form(""), chunk_size: int = Form(3000),
    idempotency_key: str = Header(..., alias="Idempotency-Key"),
) -> dict[str, Any]:
    """按与预览相同的选项重新解析并导入，整本书在一个事务里创建。"""
    parsed, sources = await _read_and_parse(files, title, mode, pattern, chunk_size)
    source = {**({"file_sha256": sources[0]["sha256"]} if len(sources) == 1 and mode != "files" else {"files": sources}),
              "mode": mode, "pattern": pattern, "chunk_size": chunk_size}
    try:
        result = await import_novel(parsed, genre=genre.strip() or "unclassified", idempotency_key=idempotency_key,
                                    source_fingerprint=source)
    except _EXPECTED_NOVEL_ERRORS as exc:
        # 与其他小说接口一致：幂等键被不同的文件复用返回 409，参数问题返回 4xx，而不是 500
        raise _novel_http_exception(exc) from exc
    logger.info("[小说导入] novel=%s volumes=%s chapters=%s words=%s replayed=%s", result["novel"]["_id"],
                result["volumes"], result["chapters"], result["words"], result["replayed"])
    return {"id": str(result["novel"]["_id"]), "version": int(result["novel"]["version"]),
            "volume_count": result["volumes"], "chapter_count": result["chapters"], "word_count": result["words"],
            "warnings": parsed.warnings, "replayed": result["replayed"]}
