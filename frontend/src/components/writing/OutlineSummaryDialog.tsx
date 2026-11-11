"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Modal } from "@heroui/react";
import { useLocale } from "next-intl";
import { RetainedModalBackdrop } from "@/components/layout/RetainedViews";
import { ModelPicker, type ModelChoice } from "@/components/shared/ModelPicker";
import { apiGet, apiPostSSE, apiPut } from "@/lib/api";
import { clearWritingDrafts, readWritingDraft, writeWritingDraft } from "@/lib/writingDrafts";
import { confirmDialog } from "@/components/shared/ConfirmDialog";

export type OutlineChapter = {
  id: string; chapter_number: number; title: string; version: number; word_count: number;
  has_summary: boolean; content: string; summary: string;
  content_updated_at?: string | null; content_updated_by?: string | null;
};
export const outlineSummaryDraftKey = (novelId: string, id: string) => `${novelId}:outline-chapter:${id}:summary`;

/** 章纲概要有自己的草稿和保存接口，使用当前编辑中的完整章纲生成。 */
export default function OutlineSummaryDialog({ novelId, chapter, onSaved, onClose }: {
  novelId: string; chapter: OutlineChapter;
  onSaved: (saved: OutlineChapter, baseVersion: number) => Promise<void>; onClose: () => void;
}) {
  const zh = useLocale() !== "en";
  const path = `/api/novels/${novelId}/outline-chapters/${chapter.id}`;
  const key = outlineSummaryDraftKey(novelId, chapter.id);
  const [summary, setSummary] = useState("");
  const [version, setVersion] = useState(chapter.version);
  const [choice, setChoice] = useState<ModelChoice>({ provider: "", model: "" });
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const writes = useRef(Promise.resolve());
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([apiGet<OutlineChapter>(path), readWritingDraft<string>(key)]).then(([fresh, draft]) => {
      if (!active) return;
      setSummary(draft?.value ?? fresh.summary); setVersion(draft?.base_version ?? fresh.version);
      setChanged(Boolean(draft)); setReady(true);
    }).catch((e) => { if (active) setError(e.message); });
    return () => { active = false; abort.current?.abort(); };
  }, [path, key]);
  const persist = (text: string, base: number) => {
    writes.current = writes.current.catch(() => {}).then(() => writeWritingDraft(key, base, text));
    return writes.current;
  };
  const edit = (text: string) => {
    setSummary(text); setChanged(true); setError("");
    void persist(text, version).catch((e) => setError(e.message));
  };
  const generate = async () => {
    if (!ready || busy || (summary.trim() && !(await confirmDialog({ message: zh ? "重新生成会替换当前的概要草稿。" : "Regenerating replaces the current summary draft.", confirmLabel: zh ? "替换并重新生成" : "Replace and regenerate", cancelLabel: zh ? "先保留" : "Keep it" })))) return;
    const controller = new AbortController(); abort.current = controller;
    setBusy(true); setError(""); setProgress(zh ? "正在整理大纲概要…" : "Preparing the outline summary…");
    let result: { text: string; version: number } | null = null;
    try {
      await apiPostSSE(`${path}/summary/stream`, {
        expected_version: chapter.version, content: chapter.content, ...choice,
      }, (event, data) => {
        if (event === "progress" && data.message) setProgress(zh ? String(data.message) : "Validating the outline summary…");
        if (event === "done") result = { text: String(data.text ?? ""), version: Number(data.version) };
      }, { signal: controller.signal });
      // 只在完整生成且校验通过后替换，失败和停止都保留原稿。
      if (result) {
        const completed = result as { text: string; version: number };
        await persist(completed.text, completed.version);
        setSummary(completed.text); setVersion(completed.version); setChanged(true);
      }
    } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
    finally { setBusy(false); setProgress(""); abort.current = null; }
  };
  const close = async () => {
    if (busy) return;
    try { if (changed) await persist(summary, version); await writes.current; onClose(); }
    catch (e) { setError((e as Error).message); }
  };
  const save = async () => {
    if (!ready || busy) return;
    setBusy(true); setError("");
    try {
      await writes.current;
      const saved = await apiPut<OutlineChapter>(`${path}/summary`, { expected_version: version, summary });
      await clearWritingDrafts(key); setChanged(false);
      await onSaved(saved, version); onClose();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <RetainedModalBackdrop isOpen variant="blur" isDismissable={!busy} onOpenChange={(open) => { if (!open) void close(); }}>
    <Modal.Container size="lg" scroll="inside"><Modal.Dialog aria-label={zh ? "大纲概要编辑" : "Outline summary editor"}>
      <Modal.Header><Modal.Heading>{chapter.title} · {zh ? "大纲概要" : "Outline summary"}</Modal.Heading></Modal.Header>
      <Modal.Body className="space-y-4">
        <ModelPicker value={choice} onChange={setChoice} disabled={busy} />
        <p className="text-sm text-muted">{zh ? "根据当前章纲整理计划剧情，保留未定信息。概要独立保存，不改动大纲内容，篇幅不限。" : "Summarize the current planned plot and preserve uncertainty. Saved separately with no character cap."}</p>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {progress && <p role="status" className="text-sm text-muted">{progress}</p>}
        <textarea data-testid="outline-summary-editor" aria-label={zh ? "本章大纲概要" : "Outline chapter summary"} rows={10} disabled={busy || !ready} value={summary} onChange={(e) => edit(e.target.value)} className="w-full resize-y rounded-xl border border-border bg-background p-3 text-sm leading-7" />
        <p className="text-xs text-muted">{summary.length} {zh ? `字 · ${changed ? "草稿未保存" : "已保存"}` : `characters · ${changed ? "Unsaved draft" : "Saved"}`}</p>
        {error && <Button variant="ghost" isDisabled={busy || !ready} onPress={() => void confirmDialog({ message: zh ? "用已保存的概要替换本地概要草稿？草稿里还没保存的修改会丢失。" : "Replace the draft with the saved summary? Unsaved edits will be lost.", confirmLabel: zh ? "替换" : "Replace", tone: "danger" }).then((ok) => {
          if (ok) {
            setBusy(true);
            void writes.current.then(() => apiGet<OutlineChapter>(path)).then(async (fresh) => {
              await clearWritingDrafts(key); setSummary(fresh.summary); setVersion(fresh.version); setChanged(false); setError("");
            }).catch((e) => setError(e.message)).finally(() => setBusy(false));
          }
        })}>{zh ? "重新载入已保存概要" : "Reload saved summary"}</Button>}
      </Modal.Body>
      <Modal.Footer className="flex flex-wrap gap-2">
        {busy && abort.current && <Button variant="ghost" onPress={() => abort.current?.abort()}>{zh ? "停止生成" : "Stop"}</Button>}
        <Button variant="secondary" isDisabled={busy || !ready || !chapter.content.trim()} onPress={() => void generate()}>{zh ? "AI 生成大纲概要" : "Generate outline summary"}</Button>
        <Button variant="ghost" isDisabled={busy || !ready || !summary} onPress={() => edit("")}>{zh ? "清空概要" : "Clear summary"}</Button>
        <Button variant="ghost" isDisabled={busy} onPress={() => void close()}>{zh ? "返回" : "Back"}</Button>
        <Button variant="primary" isDisabled={busy || !ready} onPress={() => void save()}>{zh ? "保存概要并返回" : "Save summary and return"}</Button>
      </Modal.Footer>
    </Modal.Dialog></Modal.Container>
  </RetainedModalBackdrop>;
}
