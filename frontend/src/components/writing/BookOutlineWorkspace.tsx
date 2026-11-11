"use client";

import { useContext, useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import { Button } from "@heroui/react";
import { useLocale } from "next-intl";
import { apiDelete, apiGet, apiPost, apiPostSSE, apiPut, apiPostForm } from "@/lib/api";
import { clearWritingDrafts, readWritingDraft, writeWritingDraft } from "@/lib/writingDrafts";
import { ModelPicker, type ModelChoice } from "@/components/shared/ModelPicker";
import { RetainedViewActive } from "@/components/layout/RetainedViews";
import { isFileDrag } from "@/lib/fileDrop";
import { compareImportFiles } from "@/lib/importFileOrder";
import type { NovelDetail } from "@/types/novel";
import OutlineSummaryDialog, { outlineSummaryDraftKey, type OutlineChapter } from "./OutlineSummaryDialog";
import { MemoryPanel, SelectionAgentButton } from "./SelectionAgent";
import { confirmDialog } from "@/components/shared/ConfirmDialog";
import { FullTextDialog } from "@/components/shared/FullTextDialog";
import { TextFindReplace } from "@/components/shared/TextFindReplace";
import { CollapseButton, CollapsedRail, useCollapsed } from "@/components/shared/CollapsiblePanel";
import { BatchProgressView, BatchSelectBar, useBatchRun } from "@/components/shared/BatchSelect";
import { summarizeOutline } from "@/lib/batchSummary";
import { byAgent, stampText } from "@/lib/lastModified";
import { useResourceRefresh } from "@/hooks/useResourceRefresh";
import OutlineHistoryDialog from "./OutlineHistoryDialog";
import { BookDocumentChanges, publishBookDocumentChange, type BookDocumentChange } from "./BookDocumentChanges";
import { candidateFromEvent } from "./AgentTrace";

import { ReferenceBooksPicker, type BookReference } from "./ReferenceBooksPicker";

/** 续写大纲时自动遵守的写法（后端内置）和作者自己记下的大纲写法、本书设定偏好。 */
function OutlineRules({ novelId }: { novelId: string }) {
  const zh = useLocale() !== "en";
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState<string[] | null>(null);
  useEffect(() => {
    if (!open || rules) return;
    let current = true;
    void apiGet<{ rules: string[] }>(`/api/novels/${novelId}/writing-agent/outline-style`).then((data) => { if (current) setRules(data.rules); }).catch(() => { if (current) setRules([]); });
    return () => { current = false; };
  }, [open, rules, novelId]);
  return <details data-testid="outline-rules" className="text-sm" open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
    <summary className="cursor-pointer">{zh ? "大纲写法与偏好（生成时自动遵守）" : "Outline rules and preferences"}</summary>
    {open && <div className="mt-3 space-y-3">
      <ul className="list-disc space-y-1 pl-5 text-xs leading-5 text-muted">{(rules ?? []).map((rule) => <li key={rule}>{rule}</li>)}</ul>
      <MemoryPanel novelId={novelId} categories={["outline", "setting"]} />
    </div>}
  </details>;
}

type OutlineRow = Omit<OutlineChapter, "content" | "summary">;
type Preview = { chapter_count: number; word_count: number; chapters: { title: string; word_count: number }[] };
type Result = { chapters: OutlineRow[]; chapter_count: number; replayed: boolean };

/** 大纲目录只载入标题和字数，逐章读取、留稿和保存。 */
export default function BookOutlineWorkspace({ novelId, onBusyChange, onDirtyChange, beforeLeaveRef, discardRef }: {
  novelId: string; onBusyChange: (busy: boolean) => void; onDirtyChange?: (dirty: boolean) => void;
  beforeLeaveRef?: RefObject<(() => Promise<void>) | null>; discardRef?: RefObject<(() => Promise<void>) | null>;
}) {
  const zh = useLocale() !== "en";
  const active = useContext(RetainedViewActive);
  const base = `/api/novels/${novelId}/outline-chapters`;
  const [novel, setNovel] = useState<NovelDetail | null>(null);
  const [rows, setRows] = useState<OutlineRow[]>([]);
  const [editor, setEditor] = useState<OutlineChapter | null>(null);
  const [summaryChapter, setSummaryChapter] = useState<OutlineChapter | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const savedBase = useRef<OutlineChapter | null>(null);
  const [checkpoint, setCheckpoint] = useState<OutlineChapter | null>(null);
  const [deleted, setDeleted] = useState<OutlineRow | null>(null);
  const [dirty, setDirty] = useState(false);
  const [requirements, setRequirements] = useState("");
  const [candidate, setCandidate] = useState("");
  const [choice, setChoice] = useState<ModelChoice>({ provider: "", model: "" });
  const [references, setReferences] = useState<string[]>([]);
  // 参考章纲里改发大纲概要的章节；其余发送原文。
  const [summaryRefs, setSummaryRefs] = useState<string[]>([]);
  const [useWorldview, setUseWorldview] = useState(true);
  const [referenceBooks, setReferenceBooks] = useState<BookReference[]>([]);
  const pendingSummaryRef = useRef<string | null>(null);
  const [collapsed, setCollapsed] = useCollapsed("book-outline-list");
  const [fullText, setFullText] = useState<"outline" | "candidate" | null>(null);
  const [batchMode, setBatchMode] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [skipSummarized, setSkipSummarized] = useState(true);
  const [batchDeleted, setBatchDeleted] = useState<OutlineRow[]>([]);
  const batch = useBatchRun();
  const live = useRef<{ editor: OutlineChapter | null; dirty: boolean }>({ editor: null, dirty: false });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [agentResponse, setAgentResponse] = useState("");
  const [bookChanges, setBookChanges] = useState<BookDocumentChange[]>([]);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [files, setFiles] = useState<File[]>([]);
  const [mode, setMode] = useState("auto");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const importKey = useRef<string | null>(null);
  const pendingCreate = useRef<{ key: string; path: string; data: { title: string; content: string } } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const outlineRef = useRef<HTMLTextAreaElement>(null);
  const writes = useRef(Promise.resolve());
  const request = useRef(0);
  const toolsKey = `${novelId}:outline-tools`;
  const draftKey = (id: string) => `${novelId}:outline-chapter:${id}`;
  const refresh = async () => { const result = await apiGet<{ chapters: OutlineRow[] }>(base); setRows(result.chapters); return result.chapters; };
  const open = async (id: string) => {
    const token = ++request.current;
    setBusy(true); setError(""); setNotice("");
    try {
      await writes.current;
      const [saved, draft] = await Promise.all([apiGet<OutlineChapter>(`${base}/${id}`), readWritingDraft<OutlineChapter>(draftKey(id))]);
      if (token !== request.current) return;
      savedBase.current = saved;
      setRows((current) => current.map((row) => row.id === saved.id ? saved : row));
      const loaded = draft ? { ...saved, title: draft.value.title, content: draft.value.content, version: draft.base_version } : saved;
      setEditor(loaded); setCheckpoint(loaded); setDirty(Boolean(draft));
      if (draft) setNotice(draft.base_version !== saved.version
        ? (zh ? "已恢复未保存草稿，但数据库已有更新版本。左侧是已保存字数，右侧是草稿字数；可先复制草稿，再点“忽略此次修改”载入已保存内容。" : "Draft restored; a newer version is saved. The list shows saved characters, the editor shows your draft.")
        : (zh ? "已恢复未保存草稿；左侧显示已保存字数，右侧显示草稿字数。" : "Draft restored. The list shows saved characters; the editor shows draft characters."));
    } catch (e) { setError((e as Error).message); }
    finally { if (token === request.current) setBusy(false); }
  };
  const openLatest = useEffectEvent(open);
  const cleanup = useEffectEvent(() => { request.current++; abort.current?.abort(); });
  useEffect(() => {
    let current = true;
    void Promise.all([
      apiGet<NovelDetail>(`/api/novels/${novelId}`), apiPost<{ chapters: OutlineRow[] }>(`${base}/initialize`, {}),
      readWritingDraft<{ requirements: string; candidate: string; summaryRefs?: string[]; useWorldview?: boolean; worldview?: string; referenceBooks?: BookReference[] }>(toolsKey),
      readWritingDraft<{ text: string; requirements: string; candidate: string }>(`${novelId}:book-outline`),
    ]).then(([book, result, tools, legacy]) => {
      if (!current) return;
      setNovel(book); setRows(result.chapters); setReady(true);
      setRequirements(tools?.value.requirements ?? legacy?.value.requirements ?? "");
      setCandidate(tools?.value.candidate ?? legacy?.value.candidate ?? "");
      const live = new Set(result.chapters.map((row) => row.id));
      setSummaryRefs((tools?.value.summaryRefs ?? []).filter((id) => live.has(id)));
      setUseWorldview(tools?.value.useWorldview ?? true);
      setReferenceBooks(tools?.value.referenceBooks ?? []);
      if (result.chapters.length) { setReferences([result.chapters[0].id]); void openLatest(result.chapters[0].id); }
    }).catch((e) => { if (current) setError(e.message); });
    return () => { current = false; cleanup(); };
  }, [novelId, base, toolsKey]);
  useEffect(() => { onBusyChange(busy || batch.running || Boolean(summaryChapter)); return () => onBusyChange(false); }, [busy, batch.running, summaryChapter, onBusyChange]);
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      void writeWritingDraft(toolsKey, 1, { requirements, candidate, summaryRefs, useWorldview, referenceBooks }).catch((e) => setError(e.message));
    }, 250);
    return () => clearTimeout(timer);
  }, [ready, requirements, candidate, summaryRefs, useWorldview, toolsKey, referenceBooks]);
  const edit = (fields: Partial<OutlineChapter>) => {
    if (!editor) return;
    const next = { ...editor, ...fields };
    setEditor(next); setDirty(true); setNotice("");
    writes.current = writes.current.catch(() => {}).then(() => writeWritingDraft(draftKey(next.id), next.version, next));
    void writes.current.catch((e) => setError(e.message));
  };
  live.current = { editor, dirty };
  const sessionDirty = Boolean(editor && checkpoint && editor.id === checkpoint.id &&
    (editor.title !== checkpoint.title || editor.content !== checkpoint.content));
  useEffect(() => { if (active) onDirtyChange?.(sessionDirty); return () => onDirtyChange?.(false); }, [sessionDirty, active, onDirtyChange]);
  // 编辑区的明确丢弃按钮载入数据库版本；离开页面只能撤回本次修改。
  const discard = async () => {
    await writes.current.catch(() => {});
    const current = live.current.editor;
    if (!current) return;
    await clearWritingDrafts(draftKey(current.id));
    setDirty(false); setError("");
    await open(current.id);
    setNotice(zh ? "已忽略本次修改" : "Changes discarded");
  };
  const keepDraft = useEffectEvent(async () => { await writes.current; setCheckpoint(live.current.editor); });
  const discardLatest = useEffectEvent(async () => {
    await writes.current;
    const current = live.current.editor;
    if (!current || !checkpoint || current.id !== checkpoint.id || !sessionDirty) return;
    await writeWritingDraft(`${novelId}:outline-discarded:${current.id}:${Date.now()}`, current.version, current);
    await writeWritingDraft(draftKey(checkpoint.id), checkpoint.version, checkpoint);
    setEditor(checkpoint);
    setDirty(checkpoint.title !== savedBase.current?.title || checkpoint.content !== savedBase.current?.content);
    setError("");
  });
  useEffect(() => {
    if (!active) return;
    if (beforeLeaveRef) beforeLeaveRef.current = keepDraft;
    if (discardRef) discardRef.current = discardLatest;
    return () => {
      if (beforeLeaveRef?.current === keepDraft) beforeLeaveRef.current = null;
      if (discardRef?.current === discardLatest) discardRef.current = null;
    };
  }, [active, beforeLeaveRef, discardRef]);
  useEffect(() => {
    if (!sessionDirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [sessionDirty]);
  // 批量操作后当前章纲的版本可能变了：没有草稿就重新打开；只有概要变了时把草稿接到新版本上。
  const reconcileOpen = async () => {
    const current = live.current.editor;
    if (!current) return;
    const token = request.current;
    const fresh = await apiGet<OutlineChapter>(`${base}/${current.id}`).catch(() => null);
    if (token !== request.current || live.current.editor !== current) return;
    if (!fresh || fresh.version === current.version) return;
    if (!live.current.dirty) { savedBase.current = fresh; setEditor(fresh); setCheckpoint(fresh); return; }
    if (!savedBase.current || current.version !== savedBase.current.version || fresh.content !== savedBase.current.content || fresh.title !== savedBase.current.title) {
      setNotice(zh ? "智能体或其他页面已保存新版本。你的未保存草稿已保留；目录显示已保存字数，编辑区显示草稿字数。请先复制草稿，再载入已保存版本或查看历史。" : "A newer version was saved elsewhere. Your draft is preserved; copy it before loading the saved version or restoring history.");
      return;
    }
    const next = { ...current, summary: fresh.summary, has_summary: fresh.has_summary, version: fresh.version, content_updated_at: fresh.content_updated_at, content_updated_by: fresh.content_updated_by };
    writes.current = writes.current.catch(() => {}).then(() => writeWritingDraft(draftKey(next.id), next.version, next));
    await writes.current; savedBase.current = fresh; setEditor(next);
    setCheckpoint((old) => old?.id === next.id ? { ...next, title: old.title, content: old.content } : old);
  };
  useResourceRefresh(novelId, async () => {
    if (!ready || busy || batch.running || historyOpen || summaryChapter) return;
    try { await refresh(); await reconcileOpen(); } catch (e) { setError((e as Error).message); }
  }, active && ready && !busy && !batch.running && !historyOpen && !summaryChapter);
  const batchSummaries = async () => {
    if (busy || !picked.length) return;
    const targets = rows.filter((row) => picked.includes(row.id) && (!skipSummarized || !row.has_summary));
    if (!targets.length) { setNotice(zh ? "选中的章纲都已有概要。取消“跳过已有概要”可以重新生成。" : "All selected chapters already have summaries."); return; }
    if (!(await confirmDialog({
      title: zh ? `为 ${targets.length} 章大纲生成概要？` : `Summarize ${targets.length} outline chapters?`,
      message: zh ? `按已保存的章纲逐章生成大纲概要并直接保存${skipSummarized ? "，已有概要的会跳过" : "，已有的概要会被替换"}；未保存的章纲草稿不参与。可以中途停止，已完成的会保留。模型使用下方“AI 生成后续大纲”里选的模型。` : "Summaries are generated from saved outlines and saved directly. Uses the model chosen below.",
      confirmLabel: zh ? "开始生成" : "Start",
    }))) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await writes.current;
      const result = await batch.run(targets, (row) => row.title, (row, signal) => summarizeOutline(novelId, row, choice, signal));
      await refresh(); await reconcileOpen();
      if (result) setNotice(zh ? `已为 ${result.done - result.failures.length} 章大纲保存概要${result.stopped ? "（已停止）" : ""}` : `Saved ${result.done - result.failures.length} summaries`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const batchDelete = async () => {
    if (busy || !picked.length) return;
    const targets = rows.filter((row) => picked.includes(row.id));
    if (!(await confirmDialog({
      title: zh ? `删除选中的 ${targets.length} 章大纲？` : `Delete ${targets.length} outline chapters?`,
      message: zh ? "这些章纲及概要会移出目录，它们未保存的草稿会清除。删除后可以立即全部撤销。" : "The outline chapters and summaries leave the list. You can undo right after.",
      confirmLabel: zh ? "删除" : "Delete", tone: "danger",
    }))) return;
    setBusy(true); setError(""); setNotice("");
    const removed: OutlineRow[] = [];
    const openId = editor?.id;
    try {
      await writes.current;
      await batch.run(targets, (row) => row.title, async (row) => {
        const version = row.id === openId && editor ? editor.version : row.version;
        removed.push(await apiDelete<OutlineRow>(`${base}/${row.id}`, { data: { expected_version: version } }));
        await Promise.all([clearWritingDrafts(draftKey(row.id)), clearWritingDrafts(outlineSummaryDraftKey(novelId, row.id))]);
      });
      const gone = new Set(removed.map((row) => row.id));
      setBatchDeleted(removed); setDeleted(null); setPicked([]);
      setReferences((ids) => ids.filter((id) => !gone.has(id))); setSummaryRefs((ids) => ids.filter((id) => !gone.has(id)));
      const index = rows.findIndex((row) => row.id === openId);
      const remaining = await refresh();
      if (openId && gone.has(openId)) {
        setEditor(null); setDirty(false);
        const next = remaining[Math.min(Math.max(index, 0), remaining.length - 1)];
        if (next) await open(next.id);
      }
      setNotice(zh ? `已删除 ${removed.length} 章大纲` : `Deleted ${removed.length} outline chapters`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const undoBatchDelete = async () => {
    if (!batchDeleted.length || busy) return;
    setBusy(true); setError("");
    const failed: OutlineRow[] = [];
    try {
      for (const row of batchDeleted) {
        try { await apiPost<OutlineRow>(`${base}/${row.id}/restore`, { expected_version: row.version }); }
        catch { failed.push(row); }
      }
      setBatchDeleted(failed); await refresh();
      setNotice(failed.length ? (zh ? `${failed.length} 章未能恢复` : `${failed.length} could not be restored`) : (zh ? "已撤销批量删除" : "Batch deletion undone"));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!editor || busy) return;
    setBusy(true); setError("");
    try {
      await writes.current;
      const saved = await apiPut<OutlineChapter>(`${base}/${editor.id}`, { expected_version: editor.version, title: editor.title, content: editor.content });
      await clearWritingDrafts(draftKey(editor.id)); savedBase.current = saved; setEditor(saved); setCheckpoint(saved); setDirty(false);
      await refresh(); setNotice(zh ? "本章大纲已保存" : "Outline chapter saved");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!editor || busy) return;
    const target = editor;
    if (!(await confirmDialog({
      title: zh ? `删除“${target.title}”？` : `Delete “${target.title}”?`,
      message: zh ? "该章纲及概要会移出目录，当前未保存的草稿会清除。删除后可以立即撤销。" : "The outline chapter and its summary leave the list, and unsaved drafts are cleared. You can undo right after.",
      confirmLabel: zh ? "删除" : "Delete", tone: "danger",
    }))) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await writes.current;
      const removed = await apiDelete<OutlineRow>(`${base}/${editor.id}`, { data: { expected_version: editor.version } });
      setDeleted(removed); setEditor(null); setDirty(false);
      const index = rows.findIndex((row) => row.id === removed.id);
      const remaining = rows.filter((row) => row.id !== removed.id);
      setRows(remaining); setReferences((ids) => ids.filter((id) => id !== removed.id)); setSummaryRefs((ids) => ids.filter((id) => id !== removed.id));
      await Promise.all([clearWritingDrafts(draftKey(removed.id)), clearWritingDrafts(outlineSummaryDraftKey(novelId, removed.id))]);
      const next = remaining[Math.min(index, remaining.length - 1)];
      if (next) await open(next.id);
      setNotice(zh ? "本章大纲及概要已删除" : "Outline chapter and summary deleted");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const undoDelete = async () => {
    if (!deleted || busy) return;
    setBusy(true); setError("");
    try {
      const restored = await apiPost<OutlineRow>(`${base}/${deleted.id}/restore`, { expected_version: deleted.version });
      setDeleted(null); await refresh(); await open(restored.id);
      setNotice(zh ? "已恢复章纲及概要" : "Outline chapter and summary restored");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const summarySaved = async (saved: OutlineChapter, baseVersion: number) => {
    // 只为同一版本的本地正文草稿更新版本号；外部修改引起的旧稿仍保留冲突保护。
    if (editor?.id === saved.id && editor.version === baseVersion) {
      savedBase.current = saved;
      const next = { ...editor, summary: saved.summary, has_summary: saved.has_summary, version: saved.version };
      if (dirty) {
        writes.current = writes.current.catch(() => {}).then(() => writeWritingDraft(draftKey(next.id), next.version, next));
        await writes.current;
      }
      setEditor(next);
      setCheckpoint((old) => old?.id === next.id ? { ...next, title: old.title, content: old.content } : old);
    }
    // 概要清空后改回发送原文；从“改用概要”入口补写的概要保存后自动改用概要。
    if (!saved.has_summary) setSummaryRefs((ids) => ids.filter((id) => id !== saved.id));
    else if (pendingSummaryRef.current === saved.id) setSummaryRefs((ids) => ids.includes(saved.id) ? ids : [...ids, saved.id]);
    pendingSummaryRef.current = null;
    await refresh(); setNotice(zh ? "本章大纲概要已保存" : "Outline summary saved");
  };
  const openSummary = async (row: OutlineRow) => {
    if (busy) return;
    if (editor?.id === row.id) { setSummaryChapter(editor); return; }
    setBusy(true); setError("");
    try { setSummaryChapter(await apiGet<OutlineChapter>(`${base}/${row.id}`)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const setReferenceMode = async (row: OutlineRow, summary: boolean) => {
    if (!summary) { setSummaryRefs((ids) => ids.filter((id) => id !== row.id)); return; }
    if (row.has_summary) { setSummaryRefs((ids) => ids.includes(row.id) ? ids : [...ids, row.id]); return; }
    if (!(await confirmDialog({
      title: zh ? `“${row.title}”还没有大纲概要` : `“${row.title}” has no summary yet`,
      message: zh ? "先生成或手写这一章的大纲概要，保存后续写大纲时就发送概要。" : "Write or generate the outline summary first. Once saved, it will be sent instead of the full outline.",
      confirmLabel: zh ? "去写概要" : "Write summary", cancelLabel: zh ? "仍发原文" : "Keep full text",
    }))) return;
    pendingSummaryRef.current = row.id;
    await openSummary(row);
  };
  const create = async (data: { title: string; content: string }, split = false) => {
    if (busy || !ready) return;
    const path = split ? `${base}/from-text` : base;
    if (pendingCreate.current && (pendingCreate.current.path !== path || JSON.stringify(pendingCreate.current.data) !== JSON.stringify(data))) {
      setError(zh ? "上一笔创建结果尚未确认，请先重试上次创建，避免重复追加。" : "Retry the pending creation first."); return;
    }
    pendingCreate.current ??= { key: crypto.randomUUID(), path, data };
    setBusy(true); setError("");
    try {
      const pending = pendingCreate.current;
      const result = await apiPost<Result>(pending.path, pending.data, { headers: { "Idempotency-Key": pending.key } });
      pendingCreate.current = null;
      await refresh();
      if (result.chapters[0]) { await open(result.chapters[0].id); setReferences([result.chapters[0].id]); }
      setNotice(zh ? `已保存 ${result.chapter_count} 章大纲` : `Saved ${result.chapter_count} outline chapters`);
      return true;
    } catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(false); }
  };
  const pick = (picked: File[]) => {
    if (busy || summaryChapter || !ready || !picked.length) return;
    if (picked.some((file) => !/\.(txt|md|markdown|docx)$/i.test(file.name))) { setError(zh ? "支持 TXT、Markdown 和 Word（.docx）文件。" : "Use TXT, Markdown or DOCX files."); return; }
    const added = picked.filter((file, index) => !files.some((f) => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified) && picked.findIndex((f) => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified) === index).sort(compareImportFiles);
    const next = [...files, ...added];
    if (next.length > 1000 || next.reduce((n, file) => n + file.size, 0) > 30 * 1024 * 1024) { setError(zh ? "单次最多 1000 个文件、合计 30 MB，可分批追加。" : "Import batches of up to 1000 files / 30 MB."); return; }
    setFiles(next); setPreview(null); importKey.current = null; setError(""); setNotice("");
  };
  const onDrop = useEffectEvent((event: DragEvent) => {
    if (!isFileDrag(event.dataTransfer)) return;
    event.preventDefault(); event.stopPropagation(); dragDepth.current = 0; setDragging(false);
    pick(Array.from(event.dataTransfer?.files ?? []));
  });
  const onDrag = useEffectEvent((event: DragEvent) => {
    if (!isFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = busy || !ready ? "none" : "copy";
    if (event.type === "dragenter") { dragDepth.current++; if (!busy && ready) setDragging(true); }
  });
  useEffect(() => {
    if (!active) return;
    const drop = (e: DragEvent) => onDrop(e), drag = (e: DragEvent) => onDrag(e);
    const leave = (e: DragEvent) => { if (isFileDrag(e.dataTransfer)) { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); } };
    window.addEventListener("drop", drop); window.addEventListener("dragover", drag); window.addEventListener("dragenter", drag); window.addEventListener("dragleave", leave);
    return () => { window.removeEventListener("drop", drop); window.removeEventListener("dragover", drag); window.removeEventListener("dragenter", drag); window.removeEventListener("dragleave", leave); dragDepth.current = 0; setDragging(false); };
  }, [active]);
  useEffect(() => {
    importKey.current = null; setPreview(null);
    if (!files.length) { setPreviewing(false); return; }
    const controller = new AbortController(); setPreviewing(true);
    const form = new FormData(); files.forEach((file) => form.append("file", file)); form.set("mode", mode);
    void apiPostForm<Preview>(`${base}/import/preview`, form, { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) { setPreview(result); setError(""); }
    }).catch((e) => { if (!controller.signal.aborted) setError(e.message); }).finally(() => { if (!controller.signal.aborted) setPreviewing(false); });
    return () => controller.abort();
  }, [files, mode, base]);
  const commit = async () => {
    if (busy || !preview || previewing) return;
    setBusy(true); setError(""); importKey.current ??= crypto.randomUUID();
    try {
      const form = new FormData(); files.forEach((file) => form.append("file", file)); form.set("mode", mode);
      const result = await apiPostForm<Result>(`${base}/import/commit`, form, { headers: { "Idempotency-Key": importKey.current } });
      setFiles([]); setPreview(null); importKey.current = null;
      await refresh(); if (result.chapters[0]) { await open(result.chapters[0].id); setReferences([result.chapters[0].id]); }
      setNotice(zh ? `已追加导入 ${result.chapter_count} 章大纲，原有大纲保留。` : `Imported ${result.chapter_count} chapters. Existing outlines retained.`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const generate = async () => {
    if (busy || !ready || (candidate && !(await confirmDialog({ message: zh ? "已经有一份候选大纲。重新生成会替换它，需要的话先把它保存为章纲。" : "There is already a candidate outline. Regenerating replaces it.", confirmLabel: zh ? "替换并重新生成" : "Replace and regenerate", cancelLabel: zh ? "先保留" : "Keep it" })))) return;
    setBusy(true); setError(""); setNotice(""); setAgentResponse("");
    const controller = new AbortController(); abort.current = controller; let received = "";
    try {
      const refs = references.filter((id) => id !== editor?.id);
      // 当前打开的章纲若选了“概要”，按已保存的概要发送，不再附上草稿原文。
      const editorBrief = Boolean(editor && references.includes(editor.id) && summaryRefs.includes(editor.id));
      const outlineIds = editorBrief && editor ? [...refs, editor.id] : refs;
      await apiPostSSE(`/api/novels/${novelId}/continuation/stream`, {
        action: "outline", book_edit: true, instruction: requirements, source_id: editor?.id ?? "", outline_chapter_ids: outlineIds,
        reference_books: referenceBooks, outline_summary_ids: summaryRefs.filter((id) => outlineIds.includes(id)), use_worldview: useWorldview,
        outline: `【当前章纲草稿】\n${editor && references.includes(editor.id) && !editorBrief ? `${editor.title}\n${editor.content}` : ""}\n\n【后续要求】\n${requirements}`, ...choice,
      }, (event, data) => {
        if (event === "book_document_change") {
          const change = data as unknown as BookDocumentChange;
          setBookChanges((current) => [...current, change]); publishBookDocumentChange(novelId, change);
        }
        if (event === "progress" && data.message) setNotice(String(data.message));
        if (event === "trace" && data.label) setNotice(String(data.label));
        const text = candidateFromEvent(received, event, data);
        if (text !== null) { received = text; setCandidate(text); }
        if (event === "done") {
          setNotice("");
          if (typeof data.report === "string" && data.report) setAgentResponse(data.report);
          else if (typeof data.answer === "string" && data.answer) setAgentResponse(data.answer);
        }
      }, { signal: controller.signal, idleTimeoutMs: 45000, allowedEvents: ["delta", "replacement", "trace", "memory_proposal", "book_document_change"] });
    } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
    finally { setBusy(false); abort.current = null; }
  };
  // 后台章号保留原始顺序以支持撤销；目录序号按现存章节计算，搜索和分页不重新编号。
  const filtered = rows.map((row, index) => ({ ...row, position: index + 1 }))
    .filter((row) => `${row.position} ${row.title}`.includes(query));
  const pages = Math.max(1, Math.ceil(filtered.length / 100)), currentPage = Math.min(page, pages - 1);
  const pageRows = filtered.slice(currentPage * 100, (currentPage + 1) * 100);
  const control = "w-full min-w-0 rounded-xl border border-border bg-background p-3 text-sm leading-7";
  return <section data-book-outline className="h-full overflow-y-auto p-4 sm:p-7"><div className="mx-auto max-w-6xl space-y-5">
    <h1 className="text-xl font-semibold">{novel?.title} · {zh ? "本书大纲" : "Book outline"}</h1>
    <p className="text-sm text-muted">{zh ? "每章大纲独立保存，篇幅不限。拖入整份大纲可按章标题拆分，也可一次导入多个章节文件。" : "Save outline chapters separately, with no character cap. Drop a full outline or multiple chapter files."}</p>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}{notice && <p role="status" className="text-sm text-accent">{notice}</p>}
    {agentResponse && <section data-testid="outline-agent-response" className="rounded-xl border border-accent/40 p-3 text-sm"><h2 className="mb-2 font-medium">{zh ? "智能体回复" : "Agent response"}</h2><p className="whitespace-pre-wrap leading-7">{agentResponse}</p></section>}
    <BookDocumentChanges novelId={novelId} changes={bookChanges} busy={busy} />
    {deleted && <div className="flex flex-wrap items-center gap-2 text-sm"><span>{zh ? `已删除：${deleted.title}` : `Deleted: ${deleted.title}`}</span><Button size="sm" variant="secondary" isDisabled={busy} onPress={() => void undoDelete()}>{zh ? "撤销删除" : "Undo delete"}</Button></div>}
    {pendingCreate.current && !busy && <Button variant="secondary" onPress={() => { const p = pendingCreate.current; if (p) void create(p.data, p.path.endsWith("/from-text")); }}>{zh ? "重试上次创建" : "Retry creation"}</Button>}
    <label data-testid="outline-drop-zone" className={`grid cursor-pointer gap-2 rounded-xl border-2 border-dashed p-5 text-sm ${dragging ? "border-accent bg-accent/10" : "border-border"}`}>
      <span className="font-medium">{zh ? "拖入大纲文件，或点击选择（支持多选）" : "Drop outline files or click to select multiple files"}</span>
      <span className="text-muted">TXT / Markdown / Word (.docx) · {zh ? "导入前预览，确认后追加到本书大纲目录" : "Preview before appending to this book"}</span>
      <input data-testid="outline-import" aria-label={zh ? "导入大纲" : "Import outline"} type="file" multiple accept=".txt,.md,.markdown,.docx" disabled={busy || !ready} className="sr-only" onChange={(e) => { pick(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
    </label>
    {!!files.length && <div className="space-y-3 rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center gap-3"><span>{zh ? `已选 ${files.length} 个文件` : `${files.length} files`}</span><select aria-label={zh ? "大纲切分方式" : "Outline split mode"} className="rounded-lg border border-border bg-background p-2 text-sm" value={mode} disabled={busy} onChange={(e) => setMode(e.target.value)}><option value="auto">{zh ? "按章标题识别（无标题时整份保留）" : "Detect chapter headings"}</option><option value="files">{zh ? "每个文件作为一章大纲" : "One outline chapter per file"}</option></select><Button size="sm" variant="ghost" isDisabled={busy} onPress={() => setFiles([])}>{zh ? "清空文件" : "Clear files"}</Button></div>
      <ol className="max-h-40 overflow-y-auto text-sm">{files.map((file, index) => <li key={`${file.name}:${index}`} className="flex flex-wrap items-center gap-2"><span className="text-fill">{index + 1}. {file.name}</span>{[-1, 1].map((direction) => <button key={direction} type="button" aria-label={`${direction < 0 ? "上移" : "下移"} ${file.name}`} disabled={busy || index + direction < 0 || index + direction >= files.length} className="min-h-9 px-2 disabled:opacity-30" onClick={() => { const next = [...files]; [next[index], next[index + direction]] = [next[index + direction], next[index]]; setFiles(next); }}>{direction < 0 ? "↑" : "↓"}</button>)}</li>)}</ol>
      {previewing && <p role="status">{zh ? "正在识别大纲章节…" : "Detecting outline chapters…"}</p>}
      {preview && <><p data-testid="outline-preview-count">{zh ? `识别到 ${preview.chapter_count} 章大纲，共 ${preview.word_count} 字` : `${preview.chapter_count} outline chapters, ${preview.word_count} characters`}</p><ol className="max-h-48 overflow-y-auto text-sm">{preview.chapters.slice(0, 100).map((chapter, index) => <li key={index}>{index + 1}. {chapter.title} · {chapter.word_count} {zh ? "字" : "characters"}</li>)}</ol>{preview.chapter_count > 100 && <p className="text-xs text-muted">{zh ? "预览显示前 100 章，确认后会完整导入全部章节。" : "Showing the first 100. All chapters will be imported."}</p>}<Button variant="primary" isDisabled={busy || previewing} onPress={() => void commit()}>{zh ? "确认追加导入大纲" : "Confirm outline import"}</Button></>}
    </div>}
    <div className={`grid items-start gap-5 ${collapsed ? "md:grid-cols-[2.5rem_minmax(0,1fr)]" : "md:grid-cols-[18rem_minmax(0,1fr)]"}`}>
      {collapsed ? <div className="md:sticky md:top-0 md:h-[min(32rem,70vh)]"><CollapsedRail label={zh ? "大纲目录" : "Outline list"} count={rows.length} controls="outline-list-panel" onExpand={() => setCollapsed(false)} /></div> :
      <aside id="outline-list-panel" className="space-y-3 rounded-xl border border-border p-3">
        <div className="flex items-center justify-between gap-2"><h2 className="font-medium">{zh ? `大纲目录（${rows.length}）` : `Outline chapters (${rows.length})`}</h2><span className="flex items-center gap-1"><Button size="sm" isDisabled={busy || !ready} onPress={() => void create({ title: zh ? "新章纲" : "New outline chapter", content: "" })}>{zh ? "新建章纲" : "New chapter"}</Button><CollapseButton controls="outline-list-panel" onPress={() => setCollapsed(true)} label={zh ? "收起大纲目录" : "Collapse outline list"} /></span></div>
        <input aria-label={zh ? "搜索大纲章节" : "Search outline chapters"} className={control} placeholder={zh ? "搜索章节" : "Search chapters"} value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} />
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" data-testid="outline-batch-mode" checked={batchMode} disabled={batch.running} onChange={(e) => { setBatchMode(e.target.checked); if (!e.target.checked) setPicked([]); }} />{zh ? "批量选择（生成概要、删除）" : "Batch select"}</label>
        {batchMode ? <BatchSelectBar ids={pageRows.map((row) => row.id)} selected={picked} onChange={setPicked} anchor={editor?.id} disabled={busy}>
          {filtered.length > pageRows.length && <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => setPicked((ids) => [...ids, ...filtered.map((row) => row.id).filter((id) => !ids.includes(id))])}>{zh ? `全选搜索结果（${filtered.length}）` : `Select all ${filtered.length}`}</Button>}
          <label className="flex items-center gap-1"><input type="checkbox" checked={skipSummarized} disabled={busy} onChange={(e) => setSkipSummarized(e.target.checked)} />{zh ? "跳过已有概要" : "Skip summarized"}</label>
          <Button size="sm" variant="secondary" data-testid="outline-batch-summary" isDisabled={busy || !picked.length} onPress={() => void batchSummaries()}>{zh ? "批量生成概要" : "Summarize"}</Button>
          <Button size="sm" variant="ghost" className="text-danger" data-testid="outline-batch-delete" isDisabled={busy || !picked.length} onPress={() => void batchDelete()}>{zh ? "批量删除" : "Delete"}</Button>
        </BatchSelectBar> : <p className="text-xs text-muted">{zh ? "勾选作为 AI 生成后续大纲的参考，按书中顺序读取。章纲太长时可选“概要”，只发送该章的大纲概要。" : "Select references for AI outline generation. Choose “Summary” to send a long chapter's outline summary instead."}</p>}
        <BatchProgressView progress={batch.progress} running={batch.running} onStop={batch.stop} onClose={batch.clear} />
        {batchDeleted.length > 0 && <Button size="sm" variant="secondary" isDisabled={busy} onPress={() => void undoBatchDelete()}>{zh ? `撤销删除这 ${batchDeleted.length} 章` : `Undo deleting ${batchDeleted.length}`}</Button>}
        <div className="max-h-[32rem] space-y-1 overflow-y-auto">{pageRows.map((row) => <div key={row.id} data-outline-chapter={row.id} className={`flex items-center gap-2 rounded-lg p-2 ${editor?.id === row.id ? "bg-accent/10" : ""}`}>{batchMode
          ? <input type="checkbox" data-outline-pick={row.id} aria-label={`${zh ? "选择" : "Select"} ${row.title}`} checked={picked.includes(row.id)} disabled={busy} onChange={(e) => setPicked((ids) => e.target.checked ? [...ids, row.id] : ids.filter((id) => id !== row.id))} />
          : <input type="checkbox" aria-label={`${zh ? "参考" : "Reference"} ${row.title}`} checked={references.includes(row.id)} disabled={busy} onChange={(e) => setReferences((ids) => e.target.checked ? [...ids, row.id] : ids.filter((id) => id !== row.id))} />}<button type="button" disabled={busy} aria-current={editor?.id === row.id ? "true" : undefined} className="min-w-0 flex-1 text-left text-sm" onClick={() => void open(row.id)}><span className="block break-words">{row.position}. {row.title}</span><span className="text-xs text-muted">{row.word_count} {zh ? "字 · 已保存" : "characters · saved"}{row.has_summary ? (zh ? " · 有概要" : " · summary") : ""}</span>{stampText(row, zh) && <span data-outline-stamp className={`block text-[11px] tabular-nums ${byAgent(row) ? "text-accent" : "text-muted"}`} title={zh ? `最近修改：${stampText(row, zh, false)}` : `Last modified: ${stampText(row, zh, false)}`}>{zh ? "改于 " : ""}{stampText(row, zh)}</span>}</button>{!batchMode && references.includes(row.id) && <select data-testid="outline-reference-mode" aria-label={`${zh ? "发送方式" : "Send as"} ${row.title}`} className="shrink-0 rounded-lg border border-border bg-background px-1 py-1 text-xs" value={summaryRefs.includes(row.id) ? "summary" : "original"} disabled={busy} onChange={(e) => void setReferenceMode(row, e.target.value === "summary")}><option value="original">{zh ? "原文" : "Full"}</option><option value="summary">{zh ? "概要" : "Summary"}</option></select>}</div>)}</div>
        {pages > 1 && <div className="flex items-center justify-between"><Button size="sm" variant="ghost" isDisabled={!currentPage || busy} onPress={() => setPage(currentPage - 1)}>←</Button><span className="text-xs">{currentPage + 1} / {pages}</span><Button size="sm" variant="ghost" isDisabled={currentPage + 1 >= pages || busy} onPress={() => setPage(currentPage + 1)}>→</Button></div>}
      </aside>}
      <div className="min-w-0 space-y-4">{editor ? <>
        <label className="grid gap-2 text-sm">{zh ? "本章大纲标题" : "Outline chapter title"}<input data-testid="outline-title" className={control} value={editor.title} disabled={busy} onChange={(e) => edit({ title: e.target.value })} /></label>
        <TextFindReplace key={editor.id} textareaRef={outlineRef} value={editor.content} onChange={(content) => edit({ content })} disabled={busy} />
        <textarea ref={outlineRef} aria-label={zh ? "本章大纲" : "Outline chapter"} data-testid="book-outline" className={`${control} min-h-80`} value={editor.content} disabled={busy} onChange={(e) => edit({ content: e.target.value })} />
        <div className="flex flex-wrap items-center gap-3"><Button data-testid="outline-history-open" variant="secondary" isDisabled={busy} onPress={() => setHistoryOpen(true)}>{zh ? "历史版本 / 恢复" : "History / Restore"}</Button><Button data-testid="outline-save" variant="primary" isDisabled={busy || !editor.title.trim()} onPress={() => void save()}>{zh ? "保存本章大纲" : "Save outline chapter"}</Button>{dirty && <Button data-testid="outline-discard" variant="ghost" isDisabled={busy} onPress={() => void discard().catch((e) => setError(e.message))}>{zh ? "忽略此次修改" : "Discard changes"}</Button>}<Button data-testid="outline-full-text" variant="ghost" isDisabled={busy} onPress={() => setFullText("outline")}>{zh ? "全屏编辑" : "Full screen"}</Button><SelectionAgentButton novelId={novelId} target="outline" sourceId={editor.id} textareaRef={outlineRef} value={editor.content} onReplace={(content) => edit({ content })} disabled={busy || !editor.content.trim()} /><Button data-testid="outline-summary-open" variant="secondary" isDisabled={busy} onPress={() => setSummaryChapter(editor)}>{zh ? "本章大纲概要" : "Outline summary"}</Button><Button data-testid="outline-delete" variant="ghost" className="text-danger" isDisabled={busy} onPress={() => void remove()}>{zh ? "删除本章大纲" : "Delete outline chapter"}</Button><span className="text-xs text-muted">{Array.from(editor.content).length} {zh ? `字 · ${dirty ? "草稿未保存" : "已保存"}` : `characters · ${dirty ? "Unsaved draft" : "Saved"}`}{editor.has_summary ? (zh ? " · 已有概要" : " · Summary available") : ""}{stampText(editor, zh) && <span data-testid="outline-last-modified" className={byAgent(editor) ? "text-accent" : ""}>{zh ? ` · 最近修改 ${stampText(editor, zh, false)}` : ` · Last modified ${stampText(editor, zh, false)}`}</span>}</span></div>
        {error && <Button variant="ghost" isDisabled={busy} onPress={() => { void confirmDialog({ message: zh ? "用已保存的版本替换本章草稿？草稿里还没保存的修改会丢失。" : "Replace this draft with the saved chapter? Unsaved edits will be lost.", confirmLabel: zh ? "重新载入" : "Reload", tone: "danger" }).then((ok) => { if (ok) { void writes.current.then(() => clearWritingDrafts(draftKey(editor.id))).then(() => open(editor.id)); } }); }}>{zh ? "重新载入本章大纲" : "Reload saved chapter"}</Button>}
      </> : <p className="rounded-xl border border-border p-6 text-sm text-muted">{zh ? "拖入文件导入大纲，或新建章纲。每一章均独立保存。" : "Drop files or create an outline chapter to begin."}</p>}</div>
    </div>
    <div className="space-y-4 rounded-2xl border border-border p-4"><h2 className="font-medium">{zh ? "AI 生成后续大纲" : "Generate the next outline"}</h2><p className="text-xs text-muted">{zh ? `已选 ${references.length} 章大纲作为参考${summaryRefs.filter((id) => references.includes(id)).length ? `（其中 ${summaryRefs.filter((id) => references.includes(id)).length} 章发送概要）` : ""}；未勾选的章节不会发送给模型。候选确认后按章保存。` : `${references.length} reference chapters selected. Only selected outlines are sent to the model.`}</p><ModelPicker value={choice} onChange={setChoice} disabled={busy} />
    <ReferenceBooksPicker novelId={novelId} value={referenceBooks} onChange={setReferenceBooks} disabled={busy} />
    <p className="text-xs text-muted">{zh ? "世界观已移至左侧独立的“世界观”页面，可在那里编辑并交给全自动智能体管理。" : "Edit worldbuilding from its dedicated sidebar page."}</p>
    <label className="flex items-center gap-2 text-sm"><input data-testid="use-worldview" type="checkbox" checked={useWorldview} disabled={busy} onChange={(e) => setUseWorldview(e.target.checked)} />{zh ? "生成后续大纲时参考本书世界观" : "Use the worldview when generating outlines"}{useWorldview && !novel?.worldview?.trim() && <span className="text-xs text-muted">{zh ? "（尚未填写）" : "(none saved)"}</span>}</label>
    <label className="grid gap-2 text-sm"><span>{zh ? "后续剧情与要求" : "Next plot and requirements"}</span><textarea data-testid="outline-requirements" className={control} rows={4} value={requirements} disabled={busy} onChange={(e) => setRequirements(e.target.value)} /></label><OutlineRules novelId={novelId} /><Button variant="primary" isDisabled={busy || !ready || !(references.length || requirements.trim())} onPress={() => void generate()}>{zh ? "生成后续大纲" : "Generate next outline"}</Button>{busy && abort.current && <Button variant="ghost" onPress={() => abort.current?.abort()}>{zh ? "停止" : "Stop"}</Button>}
    {candidate && <><textarea aria-label={zh ? "候选后续大纲" : "Candidate outline"} data-testid="outline-candidate" className={`${control} min-h-56`} value={candidate} disabled={busy} onChange={(e) => setCandidate(e.target.value)} /><div className="flex flex-wrap gap-2"><Button isDisabled={busy} onPress={() => { void create({ title: zh ? "后续大纲" : "Next outline", content: candidate }, true).then((ok) => { if (ok) setCandidate(""); }); }}>{zh ? "确认并保存为后续章纲" : "Save as new outline chapters"}</Button><Button variant="ghost" data-testid="outline-candidate-full-text" onPress={() => setFullText("candidate")}>{zh ? "全屏查看" : "Full screen"}</Button></div></>}
    </div>
  </div>{summaryChapter && <OutlineSummaryDialog novelId={novelId} chapter={summaryChapter} onSaved={summarySaved} onClose={() => { pendingSummaryRef.current = null; setSummaryChapter(null); }} />}
  {historyOpen && editor && <OutlineHistoryDialog novelId={novelId} chapterId={editor.id} onClose={() => setHistoryOpen(false)} onRestored={async (saved) => {
    await writes.current; await clearWritingDrafts(draftKey(saved.id)); savedBase.current = saved; setEditor(saved); setCheckpoint(saved); setDirty(false);
    await refresh(); setNotice(zh ? `已恢复大纲，共 ${saved.word_count} 字。恢复前版本仍在历史中。` : `Outline restored (${saved.word_count} characters). The previous version is kept in history.`);
  }} />}
  {fullText === "outline" && editor && <FullTextDialog title={`${editor.title} · ${zh ? "全屏编辑" : "Full screen"}`} value={editor.content} onChange={busy ? undefined : (content) => edit({ content })} onClose={() => setFullText(null)}
    tools={<Button size="sm" variant="primary" isDisabled={busy || !editor.title.trim()} onPress={() => void save()}>{zh ? "保存本章大纲" : "Save outline chapter"}</Button>} />}
  {fullText === "candidate" && <FullTextDialog title={zh ? "候选后续大纲" : "Candidate outline"} value={candidate} streaming={busy && Boolean(abort.current)} onChange={busy ? undefined : setCandidate} onClose={() => setFullText(null)} />}
</section>;
}
