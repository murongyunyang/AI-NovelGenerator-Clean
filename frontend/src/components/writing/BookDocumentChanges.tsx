"use client";

import { useState } from "react";
import { useLocale } from "next-intl";
import { Button } from "@heroui/react";
import { apiPost } from "@/lib/api";
import { notifyResourceChange } from "@/lib/resourceChanges";

export interface BookDocumentChange {
  kind: "chapter" | "outline"; document_id: string; title: string;
  before_version: number; version: number; note: string;
}

export function publishBookDocumentChange(novelId: string, change: BookDocumentChange) {
  notifyResourceChange({ novelId, source: "assistant", path: change.kind === "chapter"
    ? `/api/chapters/${change.document_id}` : `/api/novels/${novelId}/outline-chapters/${change.document_id}` });
}

/** Saved changes stay visible even when generation stops before its final report. */
export function BookDocumentChanges({ novelId, changes, busy = false }: { novelId: string; changes: BookDocumentChange[]; busy?: boolean }) {
  const zh = useLocale() !== "en";
  const [restoring, setRestoring] = useState("");
  const [restored, setRestored] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  if (!changes.length) return null;
  const key = (item: BookDocumentChange) => `${item.kind}:${item.document_id}:${item.version}`;
  const restore = async (item: BookDocumentChange) => {
    setRestoring(key(item)); setError("");
    const path = item.kind === "chapter" ? `/api/chapters/${item.document_id}` : `/api/novels/${novelId}/outline-chapters/${item.document_id}`;
    try {
      await apiPost(`${path}/revisions/${item.before_version}/restore`, { expected_version: item.version },
        { headers: { "Idempotency-Key": crypto.randomUUID() } });
      setRestored((current) => new Set([...current, key(item)]));
      publishBookDocumentChange(novelId, item);
    } catch (e) { setError((e as Error).message); }
    finally { setRestoring(""); }
  };
  return <section data-testid="agent-book-changes" aria-label={zh ? "已保存的本书修改" : "Saved book changes"} className="space-y-2 rounded-xl border border-border p-3 text-sm">
    <h3 className="font-medium">{zh ? "已直接保存到本书" : "Saved directly to this book"}</h3>
    <ul className="space-y-2">{changes.map((item, index) => {
      const latest = !changes.slice(index + 1).some((next) => next.kind === item.kind && next.document_id === item.document_id);
      return <li key={key(item)} className="flex flex-wrap items-start gap-2">
        <span className="min-w-0 flex-1"><span className="font-medium">{item.kind === "chapter" ? (zh ? "正文" : "Chapter") : (zh ? "章纲" : "Outline")} · {item.title}</span><span className="block text-xs text-muted">{item.note} · v{item.before_version} → v{item.version}</span></span>
        {restored.has(key(item)) ? <span className="text-xs text-muted">{zh ? "已恢复" : "Restored"}</span>
          : latest && <Button size="sm" variant="ghost" isDisabled={busy || Boolean(restoring)} onPress={() => void restore(item)}>{restoring === key(item) ? (zh ? "恢复中…" : "Restoring…") : (zh ? "撤销这次保存" : "Undo this save")}</Button>}
      </li>;
    })}</ul>
    <p className="text-xs text-muted">{zh ? "已有本机草稿会保留；保存草稿时若版本有变化，请先比较。更早版本可在正文或大纲的历史中恢复。" : "Local drafts are retained. Compare changed versions before saving; earlier versions are available in history."}</p>
    {error && <p role="alert" className="text-danger">{error}</p>}
  </section>;
}
