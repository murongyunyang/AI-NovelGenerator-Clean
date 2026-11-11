"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { apiGet, apiPost } from "@/lib/api";
import type { AppConfig } from "@/types/config";

export interface ModelChoice { provider: string; model: string }
const CONTROL = "min-h-10 w-full min-w-0 rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground disabled:opacity-60";

/** 每次生成单独选供应商和上游模型；名称可手填，不修改供应商默认值。 */
export function ModelPicker({ value, onChange, disabled = false }: { value: ModelChoice; onChange: (value: ModelChoice) => void; disabled?: boolean }) {
  const zh = useLocale() !== "en";
  const id = useId();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [models, setModels] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  useEffect(() => {
    let current = true;
    void apiGet<{ data: AppConfig }>("/api/config").then(({ data }) => { if (current) setConfig(data); }).catch((e) => { if (current) setError(e.message); });
    const changed = (event: Event) => setConfig((event as CustomEvent<AppConfig>).detail);
    window.addEventListener("app-config-saved", changed);
    return () => { current = false; window.removeEventListener("app-config-saved", changed); };
  }, []);
  const provider = value.provider || config?.llm.default_provider || "";
  const selected = config?.llm.providers[provider];
  useEffect(() => { request.current += 1; setModels({}); setError(""); setLoading(false); return () => { request.current += 1; }; }, [provider]);
  const choices = { ...Object.fromEntries((selected?.available_models ?? []).map((item) => [item.name === item.id ? item.id : `${item.name} (${item.id})`, item.id])), ...models, ...(selected?.models ?? {}) };
  if (selected?.default_model) choices[selected.default_model] = selected.default_model;
  const fetchModels = async () => {
    if (!selected) return;
    const token = ++request.current;
    setLoading(true); setError("");
    try {
      const result = await apiPost<{ models: { id: string; name: string }[] }>("/api/config/llm-providers/models", {
        alias: provider, provider: { type: selected.type, base_url: selected.base_url, api_key: "", use_system_proxy: selected.use_system_proxy }, use_stored_api_key: true,
      });
      if (token !== request.current) return;
      setModels(Object.fromEntries(result.models.map((item) => [item.name === item.id ? item.id : `${item.name} (${item.id})`, item.id])));
      if (!result.models.length) setError(zh ? "上游未返回模型，可手动填写。" : "No models returned. Enter a model ID manually.");
    } catch (e) { if (token === request.current) setError((e as Error).message); }
    finally { if (token === request.current) setLoading(false); }
  };
  return <div className="grid min-w-0 gap-2" data-model-picker>
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      <label className="grid min-w-0 gap-1 text-xs text-muted"><span>{zh ? "模型供应商" : "Provider"}</span><select aria-label={zh ? "模型供应商" : "Provider"} className={CONTROL} disabled={disabled} value={value.provider} onChange={(e) => onChange({ provider: e.target.value, model: "" })}>
        <option value="">{zh ? "使用默认供应商" : "Default provider"}</option>
        {Object.entries(config?.llm.providers ?? {}).filter(([, row]) => row.enabled).map(([alias]) => <option key={alias} value={alias}>{alias}</option>)}
        {value.provider && !config?.llm.providers[value.provider]?.enabled && <option value={value.provider} disabled>{value.provider} ({zh ? "不可用" : "unavailable"})</option>}
      </select></label>
      <label className="grid min-w-0 gap-1 text-xs text-muted"><span>{zh ? "模型 ID（可自定义输入）" : "Model ID (editable)"}</span><input aria-label={zh ? "模型 ID" : "Model ID"} className={CONTROL} list={`${id}-models`} value={value.model} maxLength={300} placeholder={selected?.default_model || (zh ? "使用供应商默认模型" : "Provider default model")} disabled={disabled} onChange={(e) => onChange({ ...value, model: e.target.value })} />
      <datalist id={`${id}-models`}>{Object.entries(choices).map(([label, model]) => <option key={`${label}:${model}`} value={model}>{label}</option>)}</datalist></label>
    </div>
    {Object.keys(choices).length > 0 && <label className="grid gap-1 text-xs text-muted"><span>{zh ? "已保存／上游模型" : "Saved / upstream models"}</span><select aria-label={zh ? "选择模型" : "Choose model"} className={CONTROL} value={value.model} disabled={disabled} onChange={(e) => onChange({ ...value, model: e.target.value })}><option value="">{zh ? "供应商默认模型" : "Provider default model"}</option>{Object.entries(choices).map(([label, model]) => <option key={`${label}:${model}`} value={model}>{label}</option>)}{value.model && !Object.values(choices).includes(value.model) && <option value={value.model}>{value.model}</option>}</select></label>}
    <button type="button" disabled={disabled || loading || !selected} className="min-h-9 justify-self-start text-xs text-accent disabled:opacity-50" onClick={() => void fetchModels()}>{loading ? (zh ? "读取中…" : "Loading…") : (zh ? "获取上游模型" : "Fetch upstream models")}</button>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </div>;
}
