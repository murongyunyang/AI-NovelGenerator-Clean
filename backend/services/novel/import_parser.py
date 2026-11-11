"""把本机的小说文件（txt / md / docx）解析成「卷 → 章」结构。

只做文本处理，不访问数据库。章节识别针对中文网文常见写法：
「第X章 标题」「第X卷 标题」「序章 / 楔子 / 番外」「Chapter N」，也支持自定义正则和按字数切分。
"""

from __future__ import annotations

import codecs
import io
import re
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from xml.etree import ElementTree

MAX_FILE_BYTES = 30 * 1024 * 1024
MAX_IMPORT_FILES = 1000
MAX_CHAPTERS = 5000
MAX_DOCX_XML_BYTES = 100 * 1024 * 1024
PREFACE_AS_CHAPTER_MIN = 800        # 文件开头没有标题的文字超过这个字数，就当作“序章”保留
MAX_HEADING_LEN = 60
TOC_MIN_RUN = 5
MODES = ("auto", "regex", "size", "single")
SUPPORTED_SUFFIXES = (".txt", ".md", ".markdown", ".docx")

_NUM = r"[零〇一二三四五六七八九十百千万两0-9０-９]+"
_SEP = r"[\s:：、.．·\-—]"
_CHAPTER = re.compile(rf"^第\s*{_NUM}\s*[章节回话](?P<sep>{_SEP}*)(?P<rest>.*)$")
_VOLUME = re.compile(rf"^第\s*{_NUM}\s*[卷部集篇](?P<sep>{_SEP}*)(?P<rest>.*)$")
_SPECIAL = re.compile(rf"^(?:序章|序言|楔子|引子|前言|后记|尾声|终章|大结局|番外[^\s:：]{{0,10}}|序)(?P<rest>(?:{_SEP}.*)?)$")
_ENGLISH_CHAPTER = re.compile(r"^(?:chapter|ch\.?)\s*(?:\d+|[ivxlc]+)\b(?P<rest>.*)$", re.I)
_ENGLISH_VOLUME = re.compile(r"^(?:volume|book|part)\s*(?:\d+|[ivxlc]+)\b(?P<rest>.*)$", re.I)
_MARKDOWN_HEADING = re.compile(r"^#{1,6}\s+\S")
_DENY_FIRST = set("的了里中是在有和与及也都就被把将之")
_NESTED_QUANTIFIER = re.compile(r"\([^)]*[+*][^)]*\)[+*{]")


class ImportParseError(ValueError):
    """文件无法解析，消息可直接展示给用户。"""


@dataclass
class ParsedChapter:
    title: str
    content: str


@dataclass
class ParsedVolume:
    title: str
    chapters: list[ParsedChapter] = field(default_factory=list)


@dataclass
class ParsedNovel:
    title: str
    volumes: list[ParsedVolume]
    introduction: str = ""
    encoding: str = "utf-8"
    mode: str = "auto"
    warnings: list[str] = field(default_factory=list)

    @property
    def chapter_count(self) -> int:
        return sum(len(volume.chapters) for volume in self.volumes)

    @property
    def word_count(self) -> int:
        return sum(count_words(chapter.content) for volume in self.volumes for chapter in volume.chapters)


def count_words(text: str) -> int:
    """与章节服务一致：不含空白的字符数。"""
    return sum(not char.isspace() for char in text)


# ------------------------------------------------------------------ 读取文件

def decode_text(raw: bytes) -> tuple[str, str]:
    """按 BOM → UTF-8 → GB18030 的顺序解码。返回（文本，编码名）。"""
    if raw.startswith(codecs.BOM_UTF8):
        return raw[3:].decode("utf-8", errors="replace"), "utf-8"
    if raw.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        return raw.decode("utf-16", errors="replace"), "utf-16"
    if b"\x00" in raw[:4096]:
        raise ImportParseError("这不是文本文件（含有二进制内容）。请选择 .txt、.md 或 .docx 文件")
    for encoding in ("utf-8", "gb18030"):
        try:
            return raw.decode(encoding), encoding
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace"), "utf-8（部分字符无法识别）"


def read_docx(raw: bytes) -> str:
    """读取 .docx 正文：逐段取文字，保留制表符和换行。"""
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as exc:
        raise ImportParseError("这不是有效的 .docx 文件") from exc
    with archive:
        try:
            info = archive.getinfo("word/document.xml")
        except KeyError as exc:
            raise ImportParseError("这不是有效的 .docx 文件（缺少正文）") from exc
        if info.file_size > MAX_DOCX_XML_BYTES:
            raise ImportParseError("文档内容过大，请先拆分后再导入")
        xml = archive.read(info)
    if b"<!DOCTYPE" in xml or b"<!ENTITY" in xml:  # 正常的 docx 不会有，拒绝以防实体膨胀
        raise ImportParseError("文档包含不被支持的内容，无法导入")
    ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    try:
        root = ElementTree.fromstring(xml)
    except ElementTree.ParseError as exc:
        raise ImportParseError("文档已损坏，无法读取") from exc
    paragraphs = []
    for paragraph in root.iter(f"{ns}p"):
        parts = []
        for node in paragraph.iter():
            if node.tag == f"{ns}t":
                parts.append(node.text or "")
            elif node.tag == f"{ns}tab":
                parts.append("\t")
            elif node.tag in (f"{ns}br", f"{ns}cr"):
                parts.append("\n")
        paragraphs.append("".join(parts))
    return "\n".join(paragraphs)


def load_document(filename: str, raw: bytes) -> tuple[str, str]:
    """按扩展名读取文件，返回（规范化后的文本，编码说明）。"""
    suffix = Path(filename).suffix.lower()
    if suffix == ".doc":
        raise ImportParseError("不支持旧版 .doc 文件。请在 Word 中另存为 .docx 或 .txt 后再导入")
    if suffix not in SUPPORTED_SUFFIXES:
        raise ImportParseError(f"不支持 {suffix or '无扩展名'} 文件，请选择 .txt、.md 或 .docx")
    if not raw:
        raise ImportParseError("文件是空的")
    if len(raw) > MAX_FILE_BYTES:
        raise ImportParseError(f"文件超过 {MAX_FILE_BYTES >> 20} MB，请先拆分后再导入")
    if suffix == ".docx":
        text, encoding = read_docx(raw), "docx"
    else:
        text, encoding = decode_text(raw)
    text = text.replace("﻿", "").replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    if not text.strip():
        raise ImportParseError("文件里没有文字内容")
    return text, encoding


def guess_title(filename: str) -> str:
    """从文件名推测书名：去掉扩展名、书名号和常见的“作者：xxx”后缀。"""
    name = Path(filename).name
    stem = "" if name.lower() in SUPPORTED_SUFFIXES else Path(name).stem.strip()  # 文件名就是“.txt”时没有书名
    stem = re.sub(r"[（(\[【](?:作者|by)[:：\s].*?[）)\]】]\s*$", "", stem, flags=re.I)
    stem = re.sub(r"\s*[-_—]\s*(?:作者|by)[:：\s]?.*$", "", stem, flags=re.I)
    stem = stem.strip("《》 \t")
    return stem or "导入的小说"


# ------------------------------------------------------------------ 识别标题

def _clean_heading(line: str) -> str:
    text = line.strip().strip("　").strip()
    text = re.sub(r"^#{1,6}\s*", "", text)
    text = re.sub(r"^\*{1,3}(.+?)\*{1,3}$", r"\1", text)
    return text.strip()


def _title_ok(sep: str, rest: str) -> bool:
    """标题部分是否像标题而不是正文句子。"""
    rest = rest.strip()
    if not rest:
        return True
    if rest[-1] in "。，,；;" or len(rest) > 50:
        return False
    if sep:  # “第一章 重生”这类有分隔的写法，宽松接受
        return True
    # “第一章重生”没有分隔，要求更严，避免把“第二回合开始了”这类正文行当标题
    return len(rest) <= 30 and rest[0] not in _DENY_FIRST and "。" not in rest


def classify_line(line: str) -> tuple[str, str] | None:
    """识别一行是否是标题。返回（"volume" | "chapter"，规范化标题）或 None。"""
    text = _clean_heading(line)
    if not text or len(text) > MAX_HEADING_LEN:
        return None
    if (m := _VOLUME.match(text)) and _title_ok(m["sep"], m["rest"]):
        return "volume", text
    if (m := _CHAPTER.match(text)) and _title_ok(m["sep"], m["rest"]):
        return "chapter", text
    if (m := _SPECIAL.match(text)) and _title_ok("x", m["rest"]) and len(text) <= 40:
        return "chapter", text
    if (m := _ENGLISH_VOLUME.match(text)) and _title_ok("x", m["rest"]):
        return "volume", text
    if (m := _ENGLISH_CHAPTER.match(text)) and _title_ok("x", m["rest"]):
        return "chapter", text
    return None


def classify_markdown(line: str) -> tuple[str, str] | None:
    """没有“第X章”写法时的备用方案：Markdown 的 # 标题当作章节。"""
    if _MARKDOWN_HEADING.match(line):
        text = _clean_heading(line)
        if text and len(text) <= 100:
            return "chapter", text
    return None


def make_custom_classifier(pattern: str):
    """用户自定义的章节标题正则。卷标题仍按内置写法识别。"""
    if not pattern.strip():
        raise ImportParseError("请填写章节标题的正则表达式")
    if len(pattern) > 200:
        raise ImportParseError("正则表达式过长（最多 200 个字符）")
    if _NESTED_QUANTIFIER.search(pattern):
        raise ImportParseError("正则表达式包含嵌套的重复（如 (a+)+），可能导致卡死，请简化")
    try:
        compiled = re.compile(pattern)
    except re.error as exc:
        raise ImportParseError(f"正则表达式无效：{exc}") from exc

    def classify(line: str) -> tuple[str, str] | None:
        text = _clean_heading(line)
        if not text:
            return None
        volume = classify_line(line)
        if volume and volume[0] == "volume":
            return volume
        return ("chapter", text) if compiled.search(text) else None

    return classify


# ------------------------------------------------------------------ 切分

def _clean_body(lines: list[str]) -> str:
    cleaned = [re.sub(r"[ \t　]+$", "", line) for line in lines]
    text = "\n".join(cleaned).strip("\n")
    return re.sub(r"\n{3,}", "\n\n", text)


def _scan(text: str, classify) -> tuple[list[ParsedVolume], str, int]:
    """按标题切分。返回（卷列表, 第一个标题之前的文字, 识别到的章节标题数）。"""
    volumes: list[ParsedVolume] = []
    preface: list[str] = []
    buffer: list[str] = []
    target = "preface"          # 当前正文归属：preface / volume_intro / chapter
    title = ""
    headings = 0

    def current_volume() -> ParsedVolume:
        if not volumes:
            volumes.append(ParsedVolume(""))  # 没有卷标题时的默认卷，名称稍后补
        return volumes[-1]

    def flush() -> None:
        nonlocal buffer
        body = _clean_body(buffer)
        if target == "chapter":
            current_volume().chapters.append(ParsedChapter(title, body))
        elif target == "volume_intro" and body:
            volume = volumes[-1]
            volume.chapters.append(ParsedChapter(f"{volume.title}（卷首）", body))
        elif target == "preface":
            preface.extend(buffer)
        buffer = []

    for line in text.split("\n"):
        kind = classify(line)
        if kind is None:
            buffer.append(line)
            continue
        flush()
        if kind[0] == "volume":
            volumes.append(ParsedVolume(kind[1]))
            target = "volume_intro"
        else:
            headings += 1
            title, target = kind[1], "chapter"
    flush()
    return volumes, _clean_body(preface), headings


def _chunk_paragraphs(text: str, size: int) -> list[str]:
    """按段落边界把长文切成不超过 size 字的若干块；单个段落超长时按字数硬切。"""
    chunks: list[str] = []
    current: list[str] = []
    length = 0
    for paragraph in text.split("\n"):
        pieces = [paragraph[i:i + size] for i in range(0, len(paragraph), size)] or [""]
        for piece in pieces:
            if current and length + len(piece) + 1 > size:
                chunks.append("\n".join(current).strip("\n"))
                current, length = [], 0
            current.append(piece)
            length += len(piece) + 1
    if current:
        chunks.append("\n".join(current).strip("\n"))
    return [chunk for chunk in chunks if chunk.strip()]



def _drop_table_of_contents(volumes: list[ParsedVolume], warnings: list[str]) -> None:
    """目录页会被识别成一串几乎没有正文的“章节”。只有这些标题后面又真的出现过，才当作目录删掉。"""
    flat = [(vi, ci) for vi, volume in enumerate(volumes) for ci in range(len(volume.chapters))]
    if len(flat) < TOC_MIN_RUN * 2:
        return
    chapters = [volumes[vi].chapters[ci] for vi, ci in flat]
    start = 0
    while start < min(3, len(chapters)):
        end = start
        while end < len(chapters) and count_words(chapters[end].content) < 40:
            end += 1
        if end - start >= TOC_MIN_RUN:
            later = {chapter.title for chapter in chapters[end:]}
            seen = sum(chapters[i].title in later for i in range(start, end))
            if seen >= 0.6 * (end - start):
                doomed = {flat[i] for i in range(start, end)}
                for vi, volume in enumerate(volumes):
                    volume.chapters = [c for ci, c in enumerate(volume.chapters) if (vi, ci) not in doomed]
                warnings.append(f"识别到目录页（{end - start} 条），已忽略")
                return
        start += 1


def parse_text(text: str, *, title: str, mode: str = "auto", pattern: str = "", chunk_size: int = 3000,
               encoding: str = "utf-8") -> ParsedNovel:
    """把规范化后的文本切成卷和章。

    Args:
        mode: auto 自动识别标题；regex 用 pattern 识别章节标题；size 每 chunk_size 字一章；single 整篇一章。
    """
    if mode not in MODES:
        raise ImportParseError(f"未知的切分方式：{mode}")
    if chunk_size < 1:
        raise ImportParseError("每章字数需要为正整数")
    warnings: list[str] = []
    introduction = ""

    if mode in {"size", "single"}:
        body = _clean_body(text.split("\n"))
        parts = _chunk_paragraphs(body, chunk_size) if mode == "size" else [body]
        chapters = ([ParsedChapter(f"第{i}章", part) for i, part in enumerate(parts, 1)] if mode == "size"
                    else [ParsedChapter(title, part) for part in parts if part.strip()])
        volumes = [ParsedVolume("", chapters)]
    else:
        classify = make_custom_classifier(pattern) if mode == "regex" else classify_line
        volumes, preface, headings = _scan(text, classify)
        if mode == "auto" and headings < 2:
            md_volumes, md_preface, md_headings = _scan(text, classify_markdown)
            if md_headings >= 2:
                volumes, preface, headings = md_volumes, md_preface, md_headings
                warnings.append("没有识别到“第X章”写法的标题，已按 Markdown 的 # 标题切分")
        if headings == 0:
            if mode == "regex":
                raise ImportParseError("自定义正则没有匹配到任何章节标题，请检查表达式（它会逐行匹配标题行）")
            body = _clean_body(text.split("\n"))
            volumes = [ParsedVolume("", [ParsedChapter(f"第{i}章", part)
                                         for i, part in enumerate(_chunk_paragraphs(body, chunk_size), 1)])]
            preface = ""
            warnings.append(f"没有识别到章节标题，已按每 {chunk_size} 字切成 {len(volumes[0].chapters)} 章。"
                            "如果文件里有标题，可以改用“自定义正则”重新切分")
        elif headings == 1:
            warnings.append("只识别到 1 个章节标题。如果这不是只有一章的短篇，请改用“自定义正则”或“按字数切分”")
        if preface:
            if count_words(preface) >= PREFACE_AS_CHAPTER_MIN:
                first = volumes[0] if volumes else None
                if first is None:
                    first = ParsedVolume("")
                    volumes.append(first)
                first.chapters.insert(0, ParsedChapter("序章", preface))
                warnings.append(f"文件开头 {count_words(preface)} 字没有章节标题，已作为“序章”保留")
            else:
                introduction = preface
        _drop_table_of_contents(volumes, warnings)

    volumes = [volume for volume in volumes if volume.chapters]
    if not volumes:
        raise ImportParseError("没有找到可导入的正文")
    for index, volume in enumerate(volumes, 1):
        if not volume.title:
            volume.title = title if len(volumes) == 1 else f"第{index}卷"
    total = sum(len(volume.chapters) for volume in volumes)
    if total > MAX_CHAPTERS:
        raise ImportParseError(f"共 {total} 章，超过单次导入上限 {MAX_CHAPTERS} 章。请拆分文件，或改用“每章字数”切分")
    empty = sum(not chapter.content.strip() for volume in volumes for chapter in volume.chapters)
    if empty:
        warnings.append(f"有 {empty} 个章节没有正文，请确认标题识别是否正确")
    return ParsedNovel(title=title, volumes=volumes, introduction=introduction, encoding=encoding, mode=mode,
                       warnings=warnings)


def parse_file(filename: str, raw: bytes, *, title: str = "", mode: str = "auto", pattern: str = "",
               chunk_size: int = 3000) -> ParsedNovel:
    """读取并解析一个小说文件。"""
    text, encoding = load_document(filename, raw)
    return parse_text(text, title=(title or guess_title(filename)).strip(), mode=mode, pattern=pattern,
                      chunk_size=chunk_size, encoding=encoding)


def parse_files(files: list[tuple[str, bytes]], *, title: str = "", mode: str = "auto", pattern: str = "",
                chunk_size: int = 3000) -> ParsedNovel:
    """按提交顺序把多个文件导入同一本小说；files 模式保留每个文件的章节边界。"""
    if not files:
        raise ImportParseError("请至少选择一个小说或章节文件")
    if len(files) > MAX_IMPORT_FILES:
        raise ImportParseError(f"一次最多导入 {MAX_IMPORT_FILES} 个文件，请分批整理")
    if sum(len(raw) for _, raw in files) > MAX_FILE_BYTES:
        raise ImportParseError(f"所选文件合计超过 {MAX_FILE_BYTES >> 20} MB，请减少文件后再导入")
    if len(files) == 1 and mode != "files":
        return parse_file(*files[0], title=title, mode=mode, pattern=pattern, chunk_size=chunk_size)
    if mode not in (*MODES, "files"):
        raise ImportParseError(f"未知的切分方式：{mode}")
    book_title = title.strip() or (guess_title(files[0][0]) if len(files) == 1 else "导入的小说")
    documents, encodings = [], []
    total_chars = 0
    for filename, raw in files:
        try:
            text, encoding = load_document(filename, raw)
        except ImportParseError as exc:
            raise ImportParseError(f"《{filename}》：{exc}") from exc
        total_chars += len(text)
        if total_chars > MAX_DOCX_XML_BYTES:
            raise ImportParseError("所选文档的正文总量过大，请减少文件后再导入")
        documents.append((filename, text))
        if encoding not in encodings:
            encodings.append(encoding)
    encoding = " / ".join(encodings)
    if mode != "files":
        return parse_text("\n\n".join(text for _, text in documents), title=book_title, mode=mode,
                          pattern=pattern, chunk_size=chunk_size, encoding=encoding)

    chapters = []
    for filename, text in documents:
        chapter_title = guess_title(filename)
        lines = text.split("\n")
        first = next(index for index, line in enumerate(lines) if line.strip())
        heading = classify_line(lines[first]) or classify_markdown(lines[first])
        if heading and heading[0] == "chapter":
            chapter_title = heading[1]
            lines = lines[first + 1:]
        elif _clean_heading(lines[first]) == chapter_title:
            lines = lines[first + 1:]
        chapters.append(ParsedChapter(chapter_title, _clean_body(lines)))
    volumes = [ParsedVolume(book_title, chapters)]
    warnings: list[str] = []
    total = len(volumes[0].chapters)
    if total > MAX_CHAPTERS:
        raise ImportParseError(f"共 {total} 章，超过单次导入上限 {MAX_CHAPTERS} 章，请减少文件后再导入")
    empty = sum(not chapter.content.strip() for chapter in volumes[0].chapters)
    if empty:
        warnings.append(f"有 {empty} 个章节没有正文，请检查源文件")
    return ParsedNovel(title=book_title, volumes=volumes, encoding=encoding, mode=mode, warnings=warnings)
