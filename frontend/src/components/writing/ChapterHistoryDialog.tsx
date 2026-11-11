"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Modal } from "@heroui/react";
import { useLocale } from "next-intl";
import { RetainedModalBackdrop } from "@/components/layout/RetainedViews";
import { confirmDialog } from "@/components/shared/ConfirmDialog";
import { apiGet, apiPost } from "@/lib/api";
import type { ChapterRevision, HierarchyRecord } from "@/types/hierarchy";

export type ChapterSnapshot = HierarchyRecord & { chapter_id: string; content: string };
type Revision = Pick<ChapterRevision, "revision_id" | "version" | "title" | "source" | "saved_at" | "restored_from_version">;
type RevisionDetail = Revision & { content: string };
type Page = { data: Revision[]; next_before_version: number | null };

const SOURCES: Record<ChapterRevision["source"], [string, string]> = {
  baseline: ["初始原稿", "Baseline"], create: ["新建章节", "Created"], edit: ["手动保存", "Edited"],
  writing: ["生成保存", "Generated"], assistant: ["助手保存", "Assistant"], restore: ["恢复版本", "Restored"],
};

/** 正文历史先预览再恢复；恢复请求沿用同一幂等键，未知结果可安全重试。 */
export default function ChapterHistoryDialog({ chapterId, currentVersion, dirty, onRestored, onClose }: {
  chapterId: string; currentVersion: number; dirty: boolean;
  onRestored: (saved: ChapterSnapshot) => Promise<void>; onClose: () => void;
}) {
  const locale = useLocale();
  const zh = locale !== "en";
  const base = `/api/chapters/${chapterId}/revisions`;
  const [history, setHistory] = useState<Page | null>(null);
  const [preview, setPreview] = useState<RevisionDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const serial = useRef(0);
  const locked = useRef(false);
  const restoreTarget = useRef("");
  const restoreKey = useRef("");

  useEffect(() => {
    let alive = true;
    void apiGet<Page>(`${base}?limit=20`).then((data) => { if (alive) setHistory(data); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; serial.current += 1; };
  }, [base]);

  const revisions = history?.data.filter((row) => row.version < currentVersion) ?? [];
  const view = async (version: number) => {
    const token = ++serial.current;
    setBusy(true); setError(""); setPreview(null);
    try {
      const data = await apiGet<RevisionDetail>(`${base}/${version}`);
      if (serial.current === token) setPreview(data);
    } catch (e) { if (serial.current === token) setError((e as Error).message); }
    finally { if (serial.current === token) setBusy(false); }
  };
  const restore = async () => {
    if (!preview || locked.current) return;
    locked.current = true;
    try {
      if (!(await confirmDialog({
        title: zh ? `恢复正文版本 ${preview.version}？` : `Restore chapter version ${preview.version}?`,
        message: zh
          ? `将恢复该版本的标题、正文、概要和规划。当前已保存内容仍保留在历史中。${dirty ? "未保存的编辑稿会被替换。" : ""}`
          : `The title, text, summary and planning from this version will be restored. The current saved version stays in history.${dirty ? " Unsaved edits will be replaced." : ""}`,
        confirmLabel: zh ? "恢复此版本" : "Restore version",
      }))) return;
      setBusy(true); setError("");
      const target = `${preview.version}:${currentVersion}`;
      if (restoreTarget.current !== target) {
        restoreTarget.current = target;
        restoreKey.current = crypto.randomUUID();
      }
      const saved = await apiPost<ChapterSnapshot>(`${base}/${preview.version}/restore`,
        { expected_version: currentVersion }, { headers: { "Idempotency-Key": restoreKey.current } });
      await onRestored(saved); onClose();
    } catch (e) { setError((e as Error).message); }
    finally { locked.current = false; setBusy(false); }
  };
  const more = async () => {
    if (!history?.next_before_version) return;
    setBusy(true); setError("");
    try {
      const next = await apiGet<Page>(`${base}?limit=20&before_version=${history.next_before_version}`);
      setHistory((current) => current ? {
        data: [...current.data, ...next.data.filter((row) => !current.data.some((item) => item.version === row.version))],
        next_before_version: next.next_before_version,
      } : next);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const date = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(value));

  return <RetainedModalBackdrop isOpen onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <Modal.Container size="full" scroll="inside" className="p-2 sm:p-6">
      <Modal.Dialog data-testid="chapter-history-dialog" aria-label={zh ? "正文历史版本" : "Chapter history"} className="flex h-[90dvh] min-h-0 max-w-6xl flex-col">
        <Modal.Header className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
          <Modal.Heading>{zh ? "正文历史版本" : "Chapter history"}</Modal.Heading>
          <Button isDisabled={busy} onPress={onClose}>{zh ? "关闭" : "Close"}</Button>
        </Modal.Header>
        <Modal.Body className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4">
          {error && <p role="alert" className="text-danger">{error}</p>}
          <p className="text-xs text-muted">{zh ? "每章保留最近 10 个版本。选择历史版本预览，确认后再恢复。" : "The latest 10 versions are kept per chapter. Preview a version before restoring it."}</p>
          <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[18rem_1fr]">
            <div className="workspace-scrollbar space-y-2 overflow-y-auto">
              {!history ? <p>{zh ? "读取中…" : "Loading…"}</p> : !revisions.length && <p>{zh ? "尚无可恢复的历史版本。保存修改后，原稿会出现在这里。" : "No earlier versions yet. Save a change to preserve the previous text here."}</p>}
              {revisions.map((row) => <button type="button" key={row.revision_id} disabled={busy} data-revision={row.version}
                aria-pressed={preview?.version === row.version} className="block w-full rounded-lg border border-border p-3 text-left text-sm aria-pressed:border-accent"
                onClick={() => void view(row.version)}>
                <strong>v{row.version} · {SOURCES[row.source][zh ? 0 : 1]}</strong><span className="block truncate">{row.title}</span>
                <span className="text-xs text-muted">{date(row.saved_at)}{row.restored_from_version ? (zh ? ` · 恢复自 v${row.restored_from_version}` : ` · from v${row.restored_from_version}`) : ""}</span>
              </button>)}
              {history?.next_before_version && <Button isDisabled={busy} onPress={() => void more()}>{zh ? "更早版本" : "Older versions"}</Button>}
            </div>
            <div className="flex min-h-0 flex-col gap-2">
              {preview && <p className="text-xs text-muted">{preview.title} · {Array.from(preview.content.replace(/\s/g, "")).length} {zh ? "字" : "characters"}</p>}
              <textarea data-testid="chapter-history-preview" aria-label={zh ? "历史正文原文" : "Historical chapter text"} readOnly value={preview?.content ?? ""}
                className="min-h-0 flex-1 resize-none rounded-lg border border-border bg-background p-4 leading-7" />
              <Button data-testid="chapter-history-restore" variant="primary" isDisabled={busy || !preview} onPress={() => void restore()}>{zh ? "恢复此版本" : "Restore this version"}</Button>
            </div>
          </div>
        </Modal.Body>
      </Modal.Dialog>
    </Modal.Container>
  </RetainedModalBackdrop>;
}
