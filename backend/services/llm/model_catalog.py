"""仅请求上游模型目录，不试调用模型，也不向浏览器返回凭据。"""

import httpx

from backend.api.error_protocol import DomainApiError
from backend.llm.config import LLMProviderConfig
from backend.config.config import _normalize_provider_base_url


async def list_provider_models(config: LLMProviderConfig) -> list[dict[str, str]]:
    if not config.api_key:
        raise DomainApiError("PROVIDER_SECRET_NOT_CONFIGURED", "请先配置 API Key", status_code=422)
    roots = {"openai":"https://api.openai.com", "deepseek":"https://api.deepseek.com",
             "claude":"https://api.anthropic.com", "gemini":"https://generativelanguage.googleapis.com"}
    root = _normalize_provider_base_url(config.type, config.base_url or roots[config.type]).rstrip("/")
    if config.type == "gemini":
        url = root + ("" if root.endswith(("/v1beta", "/v1")) else "/v1beta") + "/models"
        headers = {"x-goog-api-key":config.api_key}
    else:
        url = root + ("" if root.endswith("/v1") else "/v1") + "/models"
        headers = ({"x-api-key":config.api_key, "anthropic-version":"2023-06-01"} if config.type == "claude"
                   else {"Authorization":f"Bearer {config.api_key}"})
    models: dict[str, str] = {}
    params = {}
    seen_pages = set()
    try:
        async with httpx.AsyncClient(timeout=min(config.timeout_seconds, 60), trust_env=config.use_system_proxy, follow_redirects=False) as client:
            while True:
                response = await client.get(url, headers=headers, params=params)
                if response.status_code >= 300:
                    raise DomainApiError("MODEL_CATALOG_UNAVAILABLE", f"上游模型列表接口返回 HTTP {response.status_code}。可以继续手动填写模型 ID", status_code=502)
                payload = response.json()
                rows = payload.get("models", []) if config.type == "gemini" else payload.get("data", [])
                for row in rows:
                    identifier = str(row.get("name" if config.type == "gemini" else "id", "")).removeprefix("models/")
                    if identifier:
                        models[identifier] = str(row.get("displayName") or row.get("display_name") or identifier)
                if config.type == "gemini" and payload.get("nextPageToken"):
                    params = {"pageToken":payload["nextPageToken"]}
                elif payload.get("has_more") and (payload.get("last_id") or rows):
                    params = {"after_id":payload.get("last_id") or rows[-1]["id"]}
                else:
                    break
                marker = tuple(sorted(params.items()))
                if marker in seen_pages:
                    raise DomainApiError("MODEL_CATALOG_UNAVAILABLE", "上游模型目录重复返回同一页，请重试；原已保存列表仍保留", status_code=502)
                seen_pages.add(marker)
    except DomainApiError:
        raise
    except (httpx.HTTPError, ValueError, AttributeError, TypeError):
        raise DomainApiError("MODEL_CATALOG_UNAVAILABLE", "无法读取上游模型列表，请检查连接；也可以手动填写模型 ID", status_code=502) from None
    return [{"id":key, "name":value} for key, value in sorted(models.items())]
