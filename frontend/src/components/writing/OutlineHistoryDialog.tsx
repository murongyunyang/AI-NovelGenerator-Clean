"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Modal } from "@heroui/react";
import { useLocale } from "next-intl";
import { RetainedModalBackdrop } from "@/components/layout/RetainedViews";
import { apiGet, apiPost } from "@/lib/api";
import { stampText } from "@/lib/lastModified";
import { confirmDialog } from "@/components/shared/ConfirmDialog";
import type { OutlineChapter } from "./OutlineSummaryDialog";

type Revision = Pick<OutlineChapter, "version" | "title" | "word_count" | "content_updated_at" | "content_updated_by"> & { legacy: boolean; content?: string };
type History = { revisions: Revision[]; has_more: boolean; current_version: number };

/** 历史先预览再恢复。恢复基于打开时的数据库版本，防止盖掉并发保存。 */
export default function OutlineHistoryDialog({ novelId, chapterId, onRestored, onClose }: {
  novelId: string; chapterId: string; onRestored: (saved: OutlineChapter) => Promise<void>; onClose: () => void;
}) {
  const zh = useLocale() !== "en";
  const base = `/api/novels/${novelId}/outline-chapters/${chapterId}/revisions`;
  const [history, setHistory] = useState<History | null>(null);
  const [preview, setPreview] = useState<Revision | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const serial = useRef(0);
  const locked = useRef(false);
  useEffect(() => {
    let alive = true;
    void apiGet<History>(base).then((data) => { if (alive) setHistory(data); }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [base]);
  const view = async (version: number) => {
    const token = ++serial.current;
    setBusy(true); setError(""); setPreview(null);
    try { const data = await apiGet<Revision>(`${base}/${version}`); if (serial.current === token) setPreview(data); }
    catch (e) { if (serial.current === token) setError((e as Error).message); }
    finally { if (serial.current === token) setBusy(false); }
  };
  const restore = async () => {
    if (!preview || !history || locked.current) return;
    locked.current = true;
    try {
      if (!(await confirmDialog({ title: zh ? `恢复版本 ${preview.version}？` : `Restore version ${preview.version}?`,
        message: zh ? `将恢复这份 ${preview.word_count} 字大纲。当前已保存内容也会进入历史，可再次恢复。未保存的编辑稿会替换。` : "The current saved outline stays in history. Unsaved edits will be replaced.",
        confirmLabel: zh ? "恢复此版本" : "Restore version" }))) return;
      setBusy(true); setError("");
      const saved = await apiPost<OutlineChapter>(`${base}/${preview.version}/restore`, { expected_version: history.current_version });
      await onRestored(saved); onClose();
    } catch (e) { setError((e as Error).message); }
    finally { locked.current = false; setBusy(false); }
  };
  const more = async () => {
    if (!history?.revisions.length) return;
    setBusy(true);
    try {
      const next = await apiGet<History>(`${base}?before=${history.revisions.at(-1)!.version}`);
      setHistory({ ...history, revisions: [...history.revisions, ...next.revisions], has_more: next.has_more });
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <RetainedModalBackdrop isOpen onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <Modal.Container size="full" scroll="inside" className="p-2 sm:p-6">
      <Modal.Dialog data-testid="outline-history-dialog" aria-label={zh ? "大纲历史版本" : "Outline history"} className="flex h-[90dvh] min-h-0 max-w-6xl flex-col">
        <Modal.Header className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
          <Modal.Heading>{zh ? "大纲历史版本" : "Outline history"}</Modal.Heading>
          <Button isDisabled={busy} onPress={onClose}>{zh ? "关闭" : "Close"}</Button>
        </Modal.Header>
        <Modal.Body className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4">
          {error && <p role="alert" className="text-danger">{error}</p>}
          <p className="text-xs text-muted">{zh ? "选择时间和字数预览原文，再恢复。历史记录不会随智能体任务清理而删除。" : "Preview a saved version before restoring it. History survives task cleanup."}</p>
          <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[16rem_1fr]">
            <div className="space-y-2 overflow-y-auto">
              {!history ? <p>{zh ? "读取中…" : "Loading…"}</p> : !history.revisions.length && <p>{zh ? "尚无可恢复的历史版本。今后的每次保存都会保留原稿。" : "No earlier versions yet. Future saves preserve the previous text."}</p>}
              {history?.revisions.map((row) => <button type="button" key={row.version} disabled={busy} data-revision={row.version} aria-pressed={preview?.version === row.version}
                className="block w-full rounded-lg border border-border p-3 text-left text-sm aria-pressed:border-accent" onClick={() => void view(row.version)}>
                <strong>v{row.version} · {row.word_count} {zh ? "字" : "characters"}</strong><span className="block">{row.title}</span>
                <span className="text-xs text-muted">{stampText(row, zh, false)}{row.legacy ? (zh ? " 修改前原稿" : " before this edit") : ""}</span>
              </button>)}
              {history?.has_more && <Button isDisabled={busy} onPress={() => void more()}>{zh ? "更早版本" : "Older versions"}</Button>}
            </div>
            <div className="flex min-h-0 flex-col gap-2">
              <textarea data-testid="outline-history-preview" aria-label={zh ? "历史大纲原文" : "Historical outline"} readOnly value={preview?.content ?? ""} className="min-h-0 flex-1 resize-none rounded-lg border border-border bg-background p-4 leading-7" />
              <Button data-testid="outline-history-restore" variant="primary" isDisabled={busy || !preview} onPress={() => void restore()}>{zh ? "恢复此版本" : "Restore this version"}</Button>
            </div>
          </div>
        </Modal.Body>
      </Modal.Dialog>
    </Modal.Container>
  </RetainedModalBackdrop>;
}
