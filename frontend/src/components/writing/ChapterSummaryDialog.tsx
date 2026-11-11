"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Modal } from "@heroui/react";
import { useLocale } from "next-intl";
import { RetainedModalBackdrop } from "@/components/layout/RetainedViews";
import { ModelPicker, type ModelChoice } from "@/components/shared/ModelPicker";
import { apiGet, apiPostSSE, apiPut } from "@/lib/api";
import { clearWritingDrafts, readWritingDraft, writeWritingDraft } from "@/lib/writingDrafts";
import type { HierarchyRecord } from "@/types/hierarchy";
import { confirmDialog } from "@/components/shared/ConfirmDialog";

/** 独立章节概要小窗；保存只更新本章概要，不触碰正文，关闭后回到原工作区。 */
export default function ChapterSummaryDialog({ chapter, autoGenerate = false, onSaved, onClose }: {
  chapter: HierarchyRecord; autoGenerate?: boolean; onSaved: (chapter: HierarchyRecord) => void; onClose: () => void;
}) {
  const zh = useLocale() !== "en";
  const [summary, setSummary] = useState(chapter.summary);
  const [version, setVersion] = useState(chapter.version);
  const [choice, setChoice] = useState<ModelChoice>({ provider: "", model: "" });
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [changed, setChanged] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const writes = useRef(Promise.resolve());
  const key = `${chapter.novel_id}:chapter:${chapter.chapter_id}:summary`;
  const persist = useCallback((text: string, base: number) => {
    writes.current = writes.current.catch(() => {}).then(() => writeWritingDraft(key, base, text));
    return writes.current;
  }, [key]);
  useEffect(() => {
    let active = true;
    void Promise.all([apiGet<HierarchyRecord>(`/api/chapters/${chapter.chapter_id}`), readWritingDraft<string>(key)]).then(([fresh, draft]) => {
      if (!active) return;
      setVersion(draft?.base_version ?? fresh.version);
      setSummary(draft?.value ?? fresh.summary);
      setChanged(Boolean(draft));
      setReady(true);
    }).catch((e) => { if (active) setError(e.message); });
    return () => { active = false; abort.current?.abort(); };
  }, [chapter.chapter_id, key]);
  useEffect(() => {
    if (!ready || !changed || busy) return;
    const timer = setTimeout(() => { void persist(summary, version).catch((e) => setError(e.message)); }, 250);
    return () => clearTimeout(timer);
  }, [summary, ready, changed, busy, persist, version]);
  const generate = async () => {
    if (busy || !ready) return;
    if (summary.trim() && !(await confirmDialog({ message: zh ? "重新生成会替换小窗里现在的概要。" : "Regenerating replaces the summary in this window.", confirmLabel: zh ? "替换并重新生成" : "Replace and regenerate", cancelLabel: zh ? "先保留" : "Keep it" }))) return;
    if (busy) return;
    setBusy(true); setError(""); setProgress(zh ? "正在整理并校验中文剧情概要…" : "Preparing and validating the Chinese plot summary…");
    const controller = new AbortController(); abort.current = controller;
    let text = "";
    try {
      const fresh = await apiGet<HierarchyRecord>(`/api/chapters/${chapter.chapter_id}`);
      let generatedVersion = fresh.version;
      setVersion(fresh.version);
      await apiPostSSE(`/api/novels/${chapter.novel_id}/continuation/stream`, {
        action: "summarize", chapter_contexts: [{ chapter_id: chapter.chapter_id, mode: "original" }], ...choice,
      }, (event, data) => {
        if (event === "progress" && data.message) setProgress(zh ? String(data.message) : "Preparing and validating the Chinese plot summary…");
        if (data.basis) {
          const basis = data.basis as unknown as { sources: { chapter_id: string; version: number }[] };
          const source = basis.sources.find((row) => row.chapter_id === chapter.chapter_id);
          if (source) { generatedVersion = source.version; setVersion(source.version); }
        }
        if (event === "delta") { text += String(data.text ?? ""); setSummary(text); setChanged(true); }
        if (event === "done") { text = String(data.text ?? text); setSummary(text); }
      }, { signal: controller.signal, allowedEvents: ["delta"] });
      await persist(text, generatedVersion);
    } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
    finally { setBusy(false); setProgress(""); abort.current = null; }
  };
  const close = async () => {
    if (busy) return;
    try { if (changed) await persist(summary, version); onClose(); }
    catch (e) { setError((e as Error).message); }
  };
  const save = async () => {
    if (!ready || busy) return;
    setBusy(true); setError("");
    try {
      const saved = await apiPut<HierarchyRecord>(`/api/chapters/${chapter.chapter_id}`, { expected_version: version, summary });
      await writes.current.catch(() => {});
      await clearWritingDrafts(key);
      setChanged(false); onSaved(saved); onClose();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <RetainedModalBackdrop isOpen variant="blur" isDismissable={!busy} onOpenChange={(open) => { if (!open) void close(); }}>
    <Modal.Container size="lg" scroll="inside"><Modal.Dialog aria-label={zh ? "章节概要编辑" : "Chapter summary editor"}>
      <Modal.Header><Modal.Heading>{chapter.chapter_number}. {chapter.title} · {zh ? "概要" : "Summary"}</Modal.Heading></Modal.Header>
      <Modal.Body className="space-y-4">
        <ModelPicker value={choice} onChange={setChoice} disabled={busy} />
        {autoGenerate && !chapter.summary && <p className="text-sm text-muted">{zh ? "本章尚无概要。选择模型后点击生成，可编辑后保存并返回。" : "This chapter has no summary. Choose a model, generate, edit and save to return."}</p>}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {progress && <p role="status" className="text-sm text-muted">{progress}</p>}
        <textarea aria-label={zh ? "本章概要" : "Chapter summary"} data-testid="chapter-summary-editor" rows={10} disabled={busy || !ready} value={summary} onChange={(e) => { setSummary(e.target.value); setChanged(true); }} className="w-full resize-y rounded-xl border border-border bg-background p-3 text-sm leading-7" />
        <p className="text-xs text-muted">{summary.length} {zh ? "字 · 剧情概要独立保存，篇幅不限。" : "characters · Story summary saved separately, with no character cap."}</p>
      </Modal.Body>
      <Modal.Footer className="flex flex-wrap gap-2">
        {busy && abort.current && <Button size="sm" variant="ghost" onPress={() => abort.current?.abort()}>{zh ? "停止生成" : "Stop"}</Button>}
        <Button variant="secondary" isDisabled={busy || !ready} onPress={() => void generate()}>{zh ? "AI 生成本章概要" : "Generate chapter summary"}</Button>
        <Button variant="ghost" isDisabled={busy || !ready || !summary} onPress={() => { setSummary(""); setChanged(true); setError(""); void persist("", version).catch((e) => setError(e.message)); }}>{zh ? "清空概要" : "Clear summary"}</Button>
        <Button variant="ghost" isDisabled={busy} onPress={() => void close()}>{zh ? "返回" : "Back"}</Button>
        <Button variant="primary" isDisabled={busy || !ready} onPress={() => void save()}>{zh ? "保存并返回" : "Save and return"}</Button>
      </Modal.Footer>
    </Modal.Dialog></Modal.Container>
  </RetainedModalBackdrop>;
}
