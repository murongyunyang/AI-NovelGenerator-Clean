"""Read CC Switch provider stores without changing them or exposing credentials.

The SQLite schema and legacy JSON structures follow farion1231/cc-switch.
Only API credentials are imported; CLI login sessions and proxy placeholders
cannot be used as independent providers by this application.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import tomllib
from collections import Counter
from contextlib import closing
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from backend.llm.config import LLMProviderConfig

MAX_PROVIDERS = 1000
MAX_JSON_BYTES = 16 * 1024 * 1024
SUPPORTED_APPS = {"claude", "claude-desktop", "codex", "gemini", "grokbuild", "opencode", "openclaw"}


class CCSwitchImportError(ValueError):
    """A user-readable error that never embeds source configuration values."""


@dataclass
class ImportPlan:
    providers: dict[str, dict[str, Any]] = field(default_factory=dict, repr=False)
    duplicates: int = 0
    skipped: int = 0
    warnings: list[str] = field(default_factory=list)


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _object(value: Any) -> dict[str, Any]:
    if isinstance(value, str):
        if len(value) > MAX_JSON_BYTES:
            raise ValueError("oversized")
        value = json.loads(value)
    if not isinstance(value, dict):
        raise ValueError("not an object")
    return value


def _app_paths_file(home: Path) -> Path:
    """Tauri Store uses AppData/com.ccswitch.desktop, not settings.json."""
    if sys.platform == "win32":
        data = Path(os.environ.get("APPDATA") or home / "AppData" / "Roaming")
    elif sys.platform == "darwin":
        data = home / "Library" / "Application Support"
    else:
        data = Path(os.environ.get("XDG_DATA_HOME") or home / ".local" / "share")
    return data / "com.ccswitch.desktop" / "app_paths.json"


def _custom_config_dir(home: Path) -> Path | None:
    store = _app_paths_file(home)
    if not store.is_file():
        return None
    try:
        if store.stat().st_size > MAX_JSON_BYTES:
            raise ValueError("oversized")
        settings = _object(json.loads(store.read_text(encoding="utf-8-sig")))
        value = settings.get("app_config_dir_override")
        if value is not None and not isinstance(value, str):
            raise ValueError("invalid path")
        if not _text(value):
            return None
        path = Path(_text(value)).expanduser()
        if not path.is_absolute() or not path.is_dir():
            raise ValueError("unavailable path")
        return path
    except (OSError, ValueError):
        # Do not silently import an obsolete default database when the configured
        # current location cannot be resolved.
        raise CCSwitchImportError("无法读取 CC Switch 自定义配置目录，请在“指定配置位置”中填写当前配置路径。") from None


def _source_path(source_path: str | None) -> Path:
    if source_path and source_path.strip():
        source = Path(os.path.expandvars(source_path.strip().strip('"'))).expanduser()
    else:
        home = Path.home()
        custom = _custom_config_dir(home)
        source = custom or home / ".cc-switch"
        # CC Switch v3.10.3 could use HOME instead of USERPROFILE on Windows.
        legacy_home = _text(os.environ.get("HOME"))
        if (custom is None and os.name == "nt" and legacy_home and not (source / "cc-switch.db").is_file()
                and (Path(legacy_home) / ".cc-switch" / "cc-switch.db").is_file()):
            source = Path(legacy_home) / ".cc-switch"
    if source.is_dir():
        source = source / ("cc-switch.db" if (source / "cc-switch.db").is_file() else "config.json")
    if not source.is_file():
        raise CCSwitchImportError("没有找到 CC Switch 配置，请展开“指定配置位置”，填写 .cc-switch 目录、cc-switch.db 或旧版 config.json 的路径。")
    if source.suffix.lower() not in {".db", ".json"}:
        raise CCSwitchImportError("请选择 CC Switch 的 cc-switch.db 数据库或旧版 config.json 文件。")
    return source.resolve()


def _read_rows(source: Path) -> list[dict[str, Any]]:
    if source.suffix.lower() == ".db":
        with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True, timeout=3)) as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA query_only = ON")
            columns = {row[1] for row in conn.execute("PRAGMA table_info(providers)")}
            if not {"id", "app_type", "name", "settings_config"}.issubset(columns):
                raise CCSwitchImportError("数据库中没有可识别的 CC Switch 供应商表。")
            optional = ", meta" if "meta" in columns else ", '{}' AS meta"
            optional += ", is_current" if "is_current" in columns else ", 0 AS is_current"
            rows = conn.execute("SELECT id, app_type, name, settings_config" + optional
                                + " FROM providers ORDER BY is_current DESC, app_type, name LIMIT ?",
                                (MAX_PROVIDERS + 1,)).fetchall()
            if len(rows) > MAX_PROVIDERS:
                raise CCSwitchImportError("CC Switch 供应商超过 1000 个，请先缩小导入范围。")
            return [dict(row) for row in rows]
    if source.stat().st_size > MAX_JSON_BYTES:
        raise CCSwitchImportError("CC Switch JSON 配置超过 16 MB，无法导入。")
    config = _object(json.loads(source.read_text(encoding="utf-8-sig")))
    sections = {app: config[app] for app in SUPPORTED_APPS if isinstance(config.get(app), dict)}
    if not sections and isinstance(config.get("providers"), dict):
        sections = {"claude": config}  # v1 had a single Claude provider manager.
    if not sections:
        raise CCSwitchImportError("JSON 中没有可识别的 CC Switch 供应商配置。")
    rows = []
    for app, manager in sections.items():
        providers = manager.get("providers", {})
        if not isinstance(providers, dict):
            continue
        for provider_id, provider in providers.items():
            if not isinstance(provider, dict):
                rows.append({"app_type": app, "settings_config": None})
                continue
            rows.append({"id": provider_id, "app_type": app, "name": provider.get("name", provider_id),
                         "settings_config": provider.get("settingsConfig", provider.get("settings_config", {})),
                         "meta": provider.get("meta", {}), "is_current": provider_id == manager.get("current")})
    if len(rows) > MAX_PROVIDERS:
        raise CCSwitchImportError("CC Switch 供应商超过 1000 个，请先缩小导入范围。")
    return sorted(rows, key=lambda row: not row.get("is_current", False))


def _usable_key(value: Any) -> str:
    key = _text(value)
    if (not key or key.upper() in {"PROXY_MANAGED", "CC_SWITCH_PROXY", "YOUR_API_KEY", "YOUR_API_KEY_HERE"}
            or key.startswith(("${", "{env:", "{file:")) or "\n" in key or "\r" in key):
        return ""
    return key


def _convert(row: dict[str, Any]) -> dict[str, Any]:
    app = row["app_type"]
    settings = _object(row.get("settings_config"))
    meta = _object(row.get("meta") or {})
    if meta.get("providerType") in {"codex_oauth", "xai_oauth", "github_copilot"}:
        raise CCSwitchImportError("托管登录账号需要原客户端会话，不能作为独立 API Key 导入")
    kind, mode, base, key, model = "openai", "auto", "", "", ""
    models: dict[str, str] = {}
    if app in {"claude", "claude-desktop"}:
        env = _object(settings.get("env", {}))
        kind = "claude"
        base = _text(env.get("ANTHROPIC_BASE_URL")) or "https://api.anthropic.com"
        key_fields = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]
        if meta.get("apiKeyField") == "ANTHROPIC_API_KEY":
            key_fields.reverse()
        key = next((value for field_name in key_fields if (value := _usable_key(env.get(field_name)))), "")
        model = _text(env.get("ANTHROPIC_MODEL")) or _text(settings.get("model"))
        for field_name, value in env.items():
            match = re.fullmatch(r"ANTHROPIC_DEFAULT_(\w+)_MODEL", field_name)
            if match and _text(value):
                label = _text(env.get(field_name + "_NAME")) or match.group(1).title()
                models[label] = _text(value)
        if not model:
            model = _text(env.get("ANTHROPIC_DEFAULT_SONNET_MODEL")) or next(iter(models.values()), "")
        if meta.get("apiFormat") in {"openai_chat", "openai_responses"}:
            kind = "openai"
            mode = "responses" if meta["apiFormat"] == "openai_responses" else "chat_completions"
    elif app == "codex":
        raw = settings.get("config", "")
        config = tomllib.loads(raw) if isinstance(raw, str) else _object(raw)
        provider_name = _text(config.get("model_provider"))
        provider = _object(_object(config.get("model_providers", {})).get(provider_name, {}))
        if provider_name and provider_name != "openai" and not provider:
            raise ValueError("missing active provider")
        base = _text(provider.get("base_url")) or "https://api.openai.com/v1"
        auth = _object(settings.get("auth", {}))
        key = _usable_key(auth.get("OPENAI_API_KEY")) or _usable_key(provider.get("experimental_bearer_token"))
        if not key and _text(provider.get("env_key")):
            key = _usable_key(os.environ.get(provider["env_key"]))
        model = _text(config.get("model"))
        wire = provider.get("wire_api", "responses")
        if wire not in {"responses", "chat"}:
            raise ValueError("unsupported wire API")
        mode = "responses" if wire == "responses" else "chat_completions"
    elif app == "gemini":
        env = _object(settings.get("env", {}))
        kind, mode = "gemini", "generate_content"
        base = _text(env.get("GOOGLE_GEMINI_BASE_URL")) or "https://generativelanguage.googleapis.com"
        key = _usable_key(env.get("GEMINI_API_KEY")) or _usable_key(env.get("GOOGLE_API_KEY"))
        model = _text(env.get("GEMINI_MODEL"))
        if not model and isinstance(settings.get("config"), dict):
            configured_model = settings["config"].get("model")
            model = _text(configured_model.get("name")) if isinstance(configured_model, dict) else _text(configured_model)
    elif app == "grokbuild":
        raw = settings.get("config", "")
        config = tomllib.loads(raw) if isinstance(raw, str) else _object(raw)
        selected = _text(_object(config.get("models", {})).get("default"))
        provider = _object(_object(config.get("model", {})).get(selected, {}))
        base, model = _text(provider.get("base_url")) or "https://api.x.ai/v1", _text(provider.get("model"))
        key = _usable_key(provider.get("api_key"))
        if not key and _text(provider.get("env_key")):
            key = _usable_key(os.environ.get(provider["env_key"]))
        wire = provider.get("api_backend", "responses")
        if wire not in {"responses", "chat", "chat_completions"}:
            raise ValueError("unsupported wire API")
        mode = "responses" if wire == "responses" else "chat_completions"
    elif app == "opencode":
        options = _object(settings.get("options", settings.get("settings", {})))
        package = _text(settings.get("npm")) or _text(settings.get("package"))
        mapping = {"@ai-sdk/anthropic": ("claude", "auto"), "@ai-sdk/google": ("gemini", "generate_content"),
                   "@ai-sdk/openai": ("openai", "responses"), "@ai-sdk/openai-compatible": ("openai", "chat_completions")}
        if package not in mapping:
            raise ValueError("unsupported SDK")
        kind, mode = mapping[package]
        base, key = _text(options.get("baseURL")), _usable_key(options.get("apiKey"))
        for identifier, value in _object(settings.get("models", {})).items():
            label = _text(value.get("name")) if isinstance(value, dict) else ""
            models[label or identifier] = identifier
        model = next(iter(models.values()), "")
    elif app == "openclaw":
        mapping = {"anthropic-messages": ("claude", "auto"), "google-generative-ai": ("gemini", "generate_content"),
                   "openai-responses": ("openai", "responses"), "openai-completions": ("openai", "chat_completions")}
        if settings.get("api") not in mapping:
            raise ValueError("unsupported API")
        kind, mode = mapping[settings["api"]]
        base, key = _text(settings.get("baseUrl")), _usable_key(settings.get("apiKey"))
        for entry in settings.get("models", []):
            if isinstance(entry, dict) and _text(entry.get("id")):
                models[_text(entry.get("name")) or entry["id"]] = entry["id"]
        model = next(iter(models.values()), "")
    if not key:
        raise CCSwitchImportError("缺少可直接使用的 API Key（登录会话、代理占位符或未解析变量）")
    base = base or {"claude": "https://api.anthropic.com", "gemini": "https://generativelanguage.googleapis.com",
                    "openai": "https://api.openai.com/v1"}[kind]
    parsed = urlsplit(base)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("invalid base URL")
    # The client appends endpoint paths itself; tolerate exported full endpoints.
    base = re.sub(r"/(?:chat/completions|responses|messages)/?$", "", base).rstrip("/")
    if model:
        models.setdefault(model, model)
    return LLMProviderConfig(type=kind, api_mode=mode, base_url=base, api_key=key, default_model=model,
                             models=models, enabled=True, supports_function_calling=False).model_dump(exclude={"model"})


def _identity(provider: dict[str, Any]) -> tuple[str, ...]:
    try:
        mode = LLMProviderConfig.model_validate(provider).resolved_api_mode
    except (ValueError, TypeError):
        mode = _text(provider.get("api_mode"))
    return (_text(provider.get("type")), mode, _text(provider.get("base_url")).rstrip("/"),
            _text(provider.get("api_key")), _text(provider.get("default_model")))


def build_import_plan(existing: dict[str, Any], source_path: str | None = None,
                      reserved_aliases: list[str] | None = None) -> ImportPlan:
    """Build additive config patches. Secrets stay in this server-side result."""
    try:
        rows = _read_rows(_source_path(source_path))
    except CCSwitchImportError:
        raise
    except (OSError, ValueError, sqlite3.Error):
        raise CCSwitchImportError("无法读取 CC Switch 配置，文件可能损坏、被占用或格式不受支持；请检查所选配置文件。") from None
    plan, reasons = ImportPlan(), Counter()
    identities = {_identity(value) for value in existing.values() if isinstance(value, dict)}
    occupied = set(existing) | set(reserved_aliases or [])
    for row in rows:
        if row.get("app_type") not in SUPPORTED_APPS:
            reasons["暂不支持的应用类型"] += 1
            continue
        try:
            provider = _convert(row)
        except CCSwitchImportError as exc:
            reasons[str(exc)] += 1
            continue
        except (ValueError, TypeError, KeyError, AttributeError):
            reasons["配置格式或接口协议无法识别"] += 1
            continue
        identity = _identity(provider)
        if identity in identities:
            plan.duplicates += 1
            continue
        name = re.sub(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]", "", _text(row.get("name")))
        stem = f"CC Switch · {name or row['app_type']}"[:90].strip()
        alias, suffix = stem, 2
        while alias in occupied:
            alias, suffix = f"{stem} ({suffix})", suffix + 1
        occupied.add(alias)
        identities.add(identity)
        provider["api_key_update"] = {"action": "replace", "value": provider.pop("api_key")}
        plan.providers[alias] = provider
    plan.skipped = sum(reasons.values())
    plan.warnings = [f"{count} 项：{reason}" for reason, count in reasons.items()]
    if any(not provider["default_model"] for provider in plan.providers.values()):
        plan.warnings.append("部分 API 未配置默认模型，请在导入后使用“获取模型列表”选择模型。")
    return plan
