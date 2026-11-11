"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { apiGet } from "@/lib/api";

export type WorkflowId = "auto" | "claude" | "codex" | "planner" | "reflexion";
interface Workflow { id: WorkflowId; name: string; name_en: string; description: string; description_en: string; source: string }

export function workflowId(value: unknown): WorkflowId {
  return value === "claude" || value === "codex" || value === "planner" || value === "reflexion" ? value : "auto";
}

/** 选择运行策略，模型供应商与模型 ID 由原有 ModelPicker 单独管理。 */
export function WorkflowPicker({ novelId, value, onChange, disabled = false, testId = "writing-workflow", scope = "writing-agent" }: {
  novelId: string; value: WorkflowId; onChange: (value: WorkflowId) => void; disabled?: boolean; testId?: string; scope?: "writing-agent" | "book-agent";
}) {
  const zh = useLocale() !== "en";
  const [items, setItems] = useState<Workflow[]>([]);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let current = true;
    void apiGet<{ workflows: Workflow[] }>(`/api/novels/${novelId}/${scope}/workflows`).then((result) => {
      if (current) { setItems(result.workflows); setError(""); }
    }).catch((failure) => { if (current) setError(failure.message); });
    return () => { current = false; };
  }, [novelId, reload, scope]);
  const selected = items.find((item) => item.id === value);
  return <div className="space-y-2 rounded-xl border border-border p-3 text-sm" data-workflow-picker>
    <label className="grid gap-2"><span>{scope === "book-agent" ? (zh ? "全自动智能体模式" : "Autonomous agent workflow") : (zh ? "写作智能体流程" : "Writing agent workflow")}</span>
      <select data-testid={testId} className="w-full min-w-0 rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground disabled:opacity-60" value={value} disabled={disabled || !items.length} onChange={(event) => onChange(workflowId(event.target.value))}>
        {!items.length && <option value={value}>{zh ? "正在读取流程…" : "Loading workflows…"}</option>}
        {items.map((item) => <option key={item.id} value={item.id}>{zh ? item.name : item.name_en}</option>)}
      </select>
    </label>
    {selected && <p className="text-xs leading-5 text-muted">{zh ? selected.description : selected.description_en}</p>}
    <p className="text-xs leading-5 text-muted">{zh ? "流程与模型分开选择。这些是本软件参考公开机制实现的写作方式，继续使用上方模型 API。" : "Workflow and model are independent. These approaches are implemented here using your selected model API."}{selected?.source && <> <a className="text-accent underline" href={selected.source} target="_blank" rel="noreferrer">{zh ? "参考来源" : "Source"}</a></>}</p>
    {error && <p role="alert" className="text-xs text-danger">{error} <button type="button" className="underline" onClick={() => setReload((value) => value + 1)}>{zh ? "重试" : "Retry"}</button></p>}
  </div>;
}
