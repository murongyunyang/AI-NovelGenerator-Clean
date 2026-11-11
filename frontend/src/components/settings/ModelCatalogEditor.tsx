"use client";

import { useState } from "react";
import { Button } from "@heroui/react";
import { useLocale } from "next-intl";
import { apiPost } from "@/lib/api";
import type { ProviderConfig } from "@/types/config";
import { confirmDialog } from "@/components/shared/ConfirmDialog";

/** 一个供应商保存多个可命名模型，密钥保留在服务端。 */
export default function ModelCatalogEditor({ alias, provider, onChange }: { alias: string; provider: ProviderConfig; onChange: (patch: Partial<ProviderConfig>) => void }) {
  const zh = useLocale() !== "en";
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const upstream = provider.available_models ?? [];
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [priceModel, setPriceModel] = useState(provider.default_model);
  const control = "min-h-10 w-full min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-sm";
  const fetchModels = async () => {
    setLoading(true); setError("");
    try {
      const key = provider.api_key_update;
      const result = await apiPost<{ models: { id: string; name: string }[] }>("/api/config/llm-providers/models", {
        alias, provider: { type: provider.type, base_url: provider.base_url, api_key: key.action === "replace" ? key.value : "", use_system_proxy: provider.use_system_proxy },
        use_stored_api_key: key.action === "preserve" && provider.api_key_configured,
      });
      onChange({ available_models: result.models });
      if (!result.models.length) setError(zh ? "上游未返回模型，可以手动添加。" : "No models returned. Add one manually.");
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };
  const catalog = Array.from(new Set([provider.default_model, ...Object.values(provider.models ?? {}), ...upstream.map((item) => item.id)].filter(Boolean)));
  const selectedPriceModel = priceModel || provider.default_model || catalog[0] || "";
  const pricing = provider.model_prices?.[selectedPriceModel] ?? { input_per_million: 0, output_per_million: 0, currency: "CNY" };
  const updatePricing = (patch: Partial<typeof pricing>) => {
    if (!selectedPriceModel) return;
    onChange({ model_prices: { ...provider.model_prices, [selectedPriceModel]: { ...pricing, ...patch } } });
  };
  const add = async () => {
    if (!name.trim() || !model.trim()) return;
    if (provider.models?.[name.trim()] && provider.models[name.trim()] !== model.trim() && !(await confirmDialog({
      message: zh ? `“${name.trim()}”已经对应另一个模型，替换成 ${model.trim()}？` : `“${name.trim()}” already points to another model. Replace it with ${model.trim()}?`,
      confirmLabel: zh ? "替换" : "Replace",
    }))) return;
    onChange({ models: { ...provider.models, [name.trim()]: model.trim() } }); setName(""); setModel("");
  };
  return <div className="space-y-3 rounded-xl border border-border p-3 md:col-span-2" data-model-catalog>
    <div className="flex flex-wrap items-center gap-3"><h3 className="text-sm font-medium">{zh ? "此 API 下的模型" : "Models under this API"}</h3><Button size="sm" variant="secondary" isDisabled={loading} onPress={() => void fetchModels()}>{loading ? (zh ? "读取中…" : "Loading…") : (zh ? "获取上游模型" : "Fetch upstream models")}</Button></div>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    {upstream.length > 0 && <div className="space-y-2"><p role="status" className="text-xs text-muted">{zh ? `全部 ${upstream.length} 个上游模型均已加入可选列表，保存设置后在任意 AI 入口切换。` : `All ${upstream.length} upstream models are available. Save settings to use them in every AI tool.`}</p><input aria-label={zh ? "搜索上游模型" : "Search upstream models"} className={control} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={zh ? "搜索名称或模型 ID" : "Search names or model IDs"} /><ul aria-label={zh ? "上游模型列表" : "Upstream models"} className="max-h-64 overflow-y-auto divide-y divide-border">{upstream.filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(query.toLowerCase())).map((item) => <li key={item.id} className="flex items-center gap-2 py-2 text-xs"><span className="min-w-0 flex-1 break-words">{item.name}<span className="block text-muted">{item.id}</span></span><Button size="sm" variant="ghost" onPress={() => { setModel(item.id); setName(item.name); }}>{zh ? "自定义名称" : "Customize name"}</Button></li>)}</ul></div>}
    <div className="grid gap-2 sm:grid-cols-2"><label className="grid gap-1 text-xs text-muted"><span>{zh ? "自定义显示名称" : "Custom display name"}</span><input aria-label={zh ? "自定义模型名称" : "Custom model name"} maxLength={100} className={control} value={name} onChange={(e) => setName(e.target.value)} /></label><label className="grid gap-1 text-xs text-muted"><span>{zh ? "实际模型 ID" : "Upstream model ID"}</span><input aria-label={zh ? "实际模型 ID" : "Upstream model ID"} maxLength={300} className={control} value={model} onChange={(e) => setModel(e.target.value)} /></label></div>
    <Button size="sm" variant="outline" isDisabled={!name.trim() || !model.trim()} onPress={() => void add()}>{zh ? "添加到此供应商" : "Add to this provider"}</Button>
    {Object.entries(provider.models ?? {}).map(([label, id]) => <div key={label} className="flex flex-wrap items-center gap-2 border-t border-border pt-2 text-sm"><span className="text-fill">{label} · <span className="text-xs text-muted">{id}</span></span><Button size="sm" variant="ghost" onPress={() => onChange({ default_model: id })}>{zh ? "设为默认" : "Set default"}</Button><Button size="sm" variant="ghost" onPress={() => { const remaining = { ...provider.models }; delete remaining[label]; onChange({ models: remaining }); }}>{zh ? "移除" : "Remove"}</Button></div>)}
    <section className="grid gap-3 rounded-lg border border-border bg-surface/40 p-3" aria-label={zh ? "模型价格参考" : "Model price reference"}>
      <div><h3 className="text-sm font-medium">{zh ? "模型价格参考" : "Model price reference"}</h3><p className="mt-1 text-xs text-muted">{zh ? "按每 100 万 token 填写；生成后会按实际输入、输出用量估算费用，不会修改模型请求。" : "Prices per 1M tokens. Generation shows an estimated cost from actual usage; requests are unchanged."}</p></div>
      <label className="grid gap-1 text-xs text-muted"><span>{zh ? "计费模型" : "Priced model"}</span><select className={control} value={selectedPriceModel} disabled={!catalog.length} onChange={(event) => setPriceModel(event.target.value)}>{catalog.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="grid gap-1 text-xs text-muted"><span>{zh ? "输入价格 / 百万 token" : "Input / 1M tokens"}</span><input aria-label={zh ? "输入价格" : "Input price"} type="number" min="0" step="any" className={control} value={pricing.input_per_million} onChange={(event) => updatePricing({ input_per_million: Math.max(0, Number(event.target.value) || 0) })} /></label>
        <label className="grid gap-1 text-xs text-muted"><span>{zh ? "输出价格 / 百万 token" : "Output / 1M tokens"}</span><input aria-label={zh ? "输出价格" : "Output price"} type="number" min="0" step="any" className={control} value={pricing.output_per_million} onChange={(event) => updatePricing({ output_per_million: Math.max(0, Number(event.target.value) || 0) })} /></label>
        <label className="grid gap-1 text-xs text-muted"><span>{zh ? "币种" : "Currency"}</span><select aria-label={zh ? "价格币种" : "Price currency"} className={control} value={pricing.currency} onChange={(event) => updatePricing({ currency: event.target.value })}>{["CNY", "USD", "EUR", "JPY", "GBP"].map((code) => <option key={code} value={code}>{code}</option>)}</select></label>
      </div>
      <p className="text-xs text-muted">{zh ? "费用仅为本地参考，以供应商账单为准；未填价格的模型仍只显示 token。" : "Costs are local estimates; provider billing is authoritative. Models without prices still show tokens only."}</p>
    </section>
    <p className="text-xs text-muted">{zh ? "名称仅用于显示，请保留上游要求的真实模型 ID。添加后点击设置页保存。" : "Display names are local; requests use the upstream ID. Save settings after editing."}</p>
  </div>;
}
