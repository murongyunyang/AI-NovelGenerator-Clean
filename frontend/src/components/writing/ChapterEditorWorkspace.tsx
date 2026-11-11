"use client";

import { useContext, useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import { Button } from "@heroui/react";
import { useLocale } from "next-intl";
import { RetainedViewActive } from "@/components/layout/RetainedViews";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, ApiRequestError } from "@/lib/api";
import { clearWritingDrafts, readWritingDraft, writeWritingDraft } from "@/lib/writingDrafts";
import { useResourceRefresh } from "@/hooks/useResourceRefresh";
import type { HierarchyLocation, HierarchyRecord } from "@/types/hierarchy";
import { SelectionAgentButton } from "./SelectionAgent";
import { hitLabel, useKeywordHits } from "./keywordSearch";
import { confirmDialog } from "@/components/shared/ConfirmDialog";
import { FullTextDialog } from "@/components/shared/FullTextDialog";
import { TextFindReplace } from "@/components/shared/TextFindReplace";
import { CollapseButton, CollapsedRail, useCollapsed } from "@/components/shared/CollapsiblePanel";
import { BatchProgressView, BatchSelectBar, useBatchRun } from "@/components/shared/BatchSelect";
import { ModelPicker, type ModelChoice } from "@/components/shared/ModelPicker";
import { summarizeChapter } from "@/lib/batchSummary";
import { byAgent, stampText } from "@/lib/lastModified";
import ChapterHistoryDialog, { type ChapterSnapshot } from "./ChapterHistoryDialog";

type Chapter = ChapterSnapshot;
type Draft = { title: string; content: string };
type CreateCommand = { key: string; title: string };
const INPUT = "min-w-0 rounded-xl border border-border bg-background px-3 py-2 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-accent/30";

/** 全书目录与正文两个区域，规划、概要、生成及章后记录不进入此工作区。 */
export default function ChapterEditorWorkspace({ novelId, chapterId, onNavigate, onDirtyChange, onBusyChange, beforeLeaveRef, discardRef }: {
  novelId: string; chapterId?: string | null; onNavigate: (location: HierarchyLocation, replace?: boolean) => void;
  onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void;
  beforeLeaveRef: RefObject<(() => Promise<void>) | null>;
  discardRef?: RefObject<(() => Promise<void>) | null>;
}) {
  const zh = useLocale() !== "en";
  const active = useContext(RetainedViewActive);
  const base = `/api/chapters/novel/${novelId}`;
  const [rows, setRows] = useState<HierarchyRecord[]>([]);
  const [editor, setEditor] = useState<Chapter | null>(null);
  const [saved, setSaved] = useState<Chapter | null>(null);
  // 离开确认只比较本次编辑的起点；已确认保留的本机草稿也是起点，不能当作新修改。
  const [checkpoint, setCheckpoint] = useState<Chapter | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  // 章节列表的关键词筛选：标题即时匹配，正文和概要里的词由后端逐字查找。只隐藏不匹配的行，序号和排序仍按全书。
  const [keyword, setKeyword] = useState("");
  const keywordText = keyword.trim();
  const { hits: keywordHits, searching: keywordSearching } = useKeywordHits(novelId, keyword);
  const matches = (row: HierarchyRecord) => !keywordText || row.title.includes(keywordText) || Boolean(keywordHits?.chapters.has(row.chapter_id!));
  const [deleted, setDeleted] = useState<Chapter | null>(null);
  const [pendingCreate, setPendingCreate] = useState<CreateCommand | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [collapsed, setCollapsed] = useCollapsed("chapter-editor-list");
  const [fullText, setFullText] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [batchMode, setBatchMode] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [batchChoice, setBatchChoice] = useState<ModelChoice>({ provider: "", model: "" });
  const [skipSummarized, setSkipSummarized] = useState(true);
  const [batchDeleted, setBatchDeleted] = useState<Chapter[]>([]);
  const batch = useBatchRun();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const live = useRef({ editor, saved, checkpoint }); live.current = { editor, saved, checkpoint };
  const lock = useRef(false);
  const request = useRef(0);
  const dragged = useRef<{ id: string; handle: HTMLSpanElement; pointer: number; x: number; y: number; moved: boolean; target: { id: string; after: boolean } | null } | null>(null);
  const writes = useRef<Promise<void>>(Promise.resolve());
  const storageFailure = useRef<Error | null>(null);
  const selected = useRef(chapterId); selected.current = chapterId;
  const draftKey = (id: string) => `${novelId}:chapter:${id}:editor`;
  const oldBodyKey = (id: string) => `${novelId}:chapter:${id}:body`;
  const createKey = `${novelId}:chapter-editor:create`;
  const dirty = Boolean(editor && saved && (editor.title !== saved.title || editor.content !== saved.content));
  const sessionDirty = Boolean(editor && checkpoint && editor.chapter_id === checkpoint.chapter_id
    && (editor.title !== checkpoint.title || editor.content !== checkpoint.content));
  const locked = busy || agentOpen || historyOpen || Boolean(pendingCreate) || batch.running;

  const updateSelection = () => {
    const area = bodyRef.current;
    setHasSelection(Boolean(area && area.value.slice(area.selectionStart, area.selectionEnd).trim()));
  };
  useEffect(() => {
    // 同时覆盖鼠标、键盘和浏览器原生选区变化，工具栏获得焦点时仍保留选段。
    const changed = () => {
      const area = bodyRef.current;
      if (area) setHasSelection(Boolean(area.value.slice(area.selectionStart, area.selectionEnd).trim()));
    };
    document.addEventListener("selectionchange", changed);
    return () => document.removeEventListener("selectionchange", changed);
  }, []);

  const persist = async () => {
    await writes.current;
    if (storageFailure.current) throw storageFailure.current;
  };
  const keepDraft = async () => {
    const current = live.current.editor;
    await persist();
    if (current && live.current.editor?.chapter_id === current.chapter_id) {
      setCheckpoint(current);
      onDirtyChange(false);
    }
  };
  const persistLatest = useEffectEvent(keepDraft);
  useEffect(() => { if (!active) return; beforeLeaveRef.current = persistLatest; return () => { if (beforeLeaveRef.current === persistLatest) beforeLeaveRef.current = null; }; }, [beforeLeaveRef, active]);
  // 只撤销本次修改，回到进入时/上次明确保留的草稿，绝不清除之前保留的草稿。
  const discard = async () => {
    await writes.current.catch(() => {});
    const current = live.current;
    if (!current.editor || !current.checkpoint || current.editor.chapter_id !== current.checkpoint.chapter_id) return;
    if (current.editor.title === current.checkpoint.title && current.editor.content === current.checkpoint.content) return;
    // 留下被撤销稿的独立副本，恢复基线的写入失败时不改变编辑框。
    await writeWritingDraft(`${draftKey(current.editor.chapter_id)}:discarded:${Date.now()}`, current.editor.version,
      { title: current.editor.title, content: current.editor.content });
    await writeWritingDraft(draftKey(current.checkpoint.chapter_id), current.checkpoint.version,
      { title: current.checkpoint.title, content: current.checkpoint.content });
    storageFailure.current = null;
    setEditor(current.checkpoint);
    setConflict(Boolean(current.saved && current.checkpoint.version !== current.saved.version));
    onDirtyChange(false);
    setError(""); setNotice(zh ? "已撤销本次修改，之前保留的草稿仍在" : "Reverted this session; previously kept draft preserved");
  };
  const discardLatest = useEffectEvent(discard);
  useEffect(() => {
    if (!active || !discardRef) return;
    discardRef.current = discardLatest;
    return () => { if (discardRef.current === discardLatest) discardRef.current = null; };
  }, [discardRef, active]);
  useEffect(() => { if (active) onDirtyChange(sessionDirty); return () => onDirtyChange(false); }, [sessionDirty, active, onDirtyChange]);
  useEffect(() => { if (active) onBusyChange(busy || agentOpen || historyOpen || batch.running); return () => onBusyChange(false); }, [busy, agentOpen, historyOpen, batch.running, active, onBusyChange]);
  useEffect(() => {
    if (!sessionDirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [sessionDirty]);

  const open = async (id: string, navigate = true, replace = false) => {
    if (lock.current || agentOpen || historyOpen) return;
    const token = ++request.current;
    lock.current = true; setBusy(true); setError(""); setNotice("");
    try {
      await persist();
      const [record, draft, old] = await Promise.all([
        apiGet<Chapter>(`/api/chapters/${id}`), readWritingDraft<Draft>(draftKey(id)), readWritingDraft<string>(oldBodyKey(id)),
      ]);
      if (token !== request.current) return;
      if (record.novel_id !== novelId) throw new Error(zh ? "章节不属于当前小说" : "Chapter belongs to another novel");
      const cached = draft ?? (old ? { ...old, value: { title: record.title, content: old.value } } : null);
      setSaved(record);
      const loaded = cached ? { ...record, ...cached.value, version: cached.base_version } : record;
      setEditor(loaded); setCheckpoint(loaded);
      setConflict(Boolean(cached && cached.base_version !== record.version)); setHasSelection(false);
      if (cached) setNotice(zh ? "已恢复本章未保存的草稿" : "Unsaved chapter draft restored");
      if (navigate) onNavigate({ chapter_id: id }, replace);
    } catch (e) { setError((e as Error).message); }
    finally { if (token === request.current) { lock.current = false; setBusy(false); } }
  };
  const openLatest = useEffectEvent(open);
  const refresh = async () => {
    const result = await apiGet<{ data: HierarchyRecord[] }>(base);
    setRows(result.data); setReady(true); return result.data;
  };
  const initialize = async () => {
    try {
      const result = await refresh();
      const pending = await readWritingDraft<CreateCommand>(createKey);
      setPendingCreate(pending?.value ?? null);
      const id = selected.current ?? result[0]?.chapter_id;
      if (id) await open(id, !selected.current, true);
    } catch (e) { setError((e as Error).message); }
  };
  const initializeEffect = useEffectEvent(initialize);
  const cleanup = useEffectEvent(() => { request.current++; });
  useEffect(() => { void initializeEffect(); return () => { cleanup(); }; }, [novelId]);
  useEffect(() => {
    if (active && ready && chapterId && chapterId !== live.current.editor?.chapter_id) void openLatest(chapterId, false);
  }, [chapterId, active, ready]);
  useResourceRefresh(novelId, async () => {
    if (lock.current || agentOpen || historyOpen || !ready) return;
    try {
      const result = await refresh();
      const current = live.current;
      const row = result.find((row) => row.chapter_id === current.editor?.chapter_id);
      if (row && current.saved && row.version !== current.saved.version) {
        if (current.editor?.title !== current.saved.title || current.editor?.content !== current.saved.content) {
          setSaved(await apiGet<Chapter>(`/api/chapters/${row.chapter_id}`)); setConflict(true);
        }
        else await open(row.chapter_id!, false);
      }
    } catch (e) { setError((e as Error).message); }
  }, active);

  const edit = (fields: Partial<Draft>) => {
    if (!editor) return;
    const next = { ...editor, ...fields }; setEditor(next); setNotice("");
    // 立即排入写入队列，切章或离开页面前等待它完成。
    writes.current = writes.current.catch(() => {}).then(() => writeWritingDraft(draftKey(next.chapter_id), next.version, { title: next.title, content: next.content }))
      .then(() => { storageFailure.current = null; }).catch((e) => { storageFailure.current = e; setError(e.message); });
  };
  // content 由“替换并保存本章”传入：先写进草稿（保存失败或有冲突时修改稿仍在编辑框和本机草稿里），再保存。
  const save = async (content?: string) => {
    if (!editor) return;
    if (content !== undefined) edit({ content });
    if (lock.current || conflict) return;
    const draft = content === undefined ? editor : { ...editor, content };
    lock.current = true; setBusy(true); setError("");
    try {
      await persist();
      const record = await apiPut<Chapter>(`/api/chapters/${draft.chapter_id}`, { expected_version: draft.version, title: draft.title, content: draft.content });
      setEditor(record); setSaved(record); setCheckpoint(record); setConflict(false); onDirtyChange(false);
      await Promise.all([clearWritingDrafts(draftKey(record.chapter_id)), clearWritingDrafts(oldBodyKey(record.chapter_id))]);
      await refresh(); setNotice(zh ? "本章正文已保存" : "Chapter saved");
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiRequestError && e.status === 409) {
        setConflict(true);
        try { setSaved(await apiGet<Chapter>(`/api/chapters/${editor.chapter_id}`)); } catch { /* 原草稿仍保留 */ }
      }
    }
    finally { lock.current = false; setBusy(false); }
  };
  const historyRestored = async (record: Chapter) => {
    await persist();
    await Promise.all([clearWritingDrafts(draftKey(record.chapter_id)), clearWritingDrafts(oldBodyKey(record.chapter_id))]);
    await refresh();
    setEditor(record); setSaved(record); setCheckpoint(record); setConflict(false); setError(""); onDirtyChange(false);
    setNotice(zh ? `已恢复正文版本，当前为 v${record.version}。恢复前版本仍在历史中。` : `Chapter restored as v${record.version}. The previous version remains in history.`);
  };
  const create = async () => {
    if (lock.current || agentOpen) return;
    const command = pendingCreate ?? { key: crypto.randomUUID(), title: zh ? "未命名章节" : "Untitled chapter" };
    lock.current = true; setBusy(true); setError("");
    let created: Chapter | null = null;
    try {
      await persist();
      await writeWritingDraft(createKey, 0, command); setPendingCreate(command);
      created = await apiPost<Chapter>(base, { title: command.title, content: "" }, { headers: { "Idempotency-Key": command.key } });
      await clearWritingDrafts(createKey); setPendingCreate(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiRequestError && e.status >= 400 && e.status < 500) { await clearWritingDrafts(createKey); setPendingCreate(null); }
    } finally { lock.current = false; setBusy(false); }
    if (created) await open(created.chapter_id);
  };
  const remove = async () => {
    if (!editor || lock.current || !(await confirmDialog({
      title: zh ? `删除“${editor.title}”？` : `Delete “${editor.title}”?`,
      message: zh ? "该章将移出章节列表，未保存的修改会清除。删除后可以立即撤销。" : "The chapter leaves the list and unsaved edits are cleared. You can undo right after.",
      confirmLabel: zh ? "删除" : "Delete", tone: "danger",
    })) || lock.current) return;
    lock.current = true; setBusy(true); setError("");
    let next: string | undefined;
    try {
      await persist();
      const removed = await apiDelete<Chapter>(`/api/chapters/${editor.chapter_id}?expected_version=${editor.version}`);
      setDeleted(removed); setEditor(null); setSaved(null); setConflict(false);
      await Promise.all([clearWritingDrafts(draftKey(editor.chapter_id)), clearWritingDrafts(oldBodyKey(editor.chapter_id))]);
      const index = rows.findIndex((row) => row.chapter_id === editor.chapter_id);
      const remaining = await refresh(); next = remaining[Math.min(index, remaining.length - 1)]?.chapter_id;
      if (!next) onNavigate({}, true);
      setNotice(zh ? "当前章节已删除" : "Chapter deleted");
    } catch (e) { setError((e as Error).message); }
    finally { lock.current = false; setBusy(false); }
    if (next) await open(next);
  };
  const undoDelete = async () => {
    if (!deleted || lock.current) return;
    lock.current = true; setBusy(true); setError("");
    let restored: Chapter | null = null;
    try { restored = await apiPost<Chapter>(`/api/chapters/${deleted.chapter_id}/restore`, { expected_version: deleted.version }); setDeleted(null); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { lock.current = false; setBusy(false); }
    if (restored) await open(restored.chapter_id);
  };
  // 批量操作期间锁住其他操作；结束后若当前章被改了版本，按情况重新打开或接上新版本。
  const reconcileCurrent = async () => {
    const current = live.current;
    if (!current.editor || !current.saved) return;
    const fresh = await apiGet<Chapter>(`/api/chapters/${current.editor.chapter_id}`).catch(() => null);
    if (!fresh || fresh.version === current.saved.version) return;
    const edited = current.editor.title !== current.saved.title || current.editor.content !== current.saved.content;
    if (!edited) { setEditor(fresh); setSaved(fresh); setCheckpoint(fresh); return; }
    // 批量概要只改概要；正文草稿接到新版本上，避免误报冲突。
    if (current.editor.version === current.saved.version && fresh.title === current.saved.title && fresh.content === current.saved.content) {
      const rebased = { ...current.editor, summary: fresh.summary, version: fresh.version };
      setEditor(rebased); setSaved(fresh);
      setCheckpoint((previous) => previous?.chapter_id === fresh.chapter_id ? { ...previous, version: fresh.version } : previous);
      await writeWritingDraft(draftKey(rebased.chapter_id), fresh.version, { title: rebased.title, content: rebased.content });
    } else { setSaved(fresh); setConflict(true); }
  };
  const batchSummaries = async () => {
    if (lock.current || agentOpen || !picked.length) return;
    const targets = rows.filter((row) => picked.includes(row.chapter_id!) && (!skipSummarized || !row.summary?.trim()));
    if (!targets.length) { setNotice(zh ? "选中的章节都已有概要。取消“跳过已有概要”可以重新生成。" : "All selected chapters already have summaries."); return; }
    if (!(await confirmDialog({
      title: zh ? `为 ${targets.length} 章生成概要？` : `Summarize ${targets.length} chapters?`,
      message: zh ? `逐章根据正文生成概要并直接保存${skipSummarized ? "，已有概要的章节会跳过" : "，已有的概要会被替换"}。可以中途停止，已完成的章节会保留。` : "Each summary is generated from the chapter text and saved. You can stop midway.",
      confirmLabel: zh ? "开始生成" : "Start",
    }))) return;
    lock.current = true; setError(""); setNotice("");
    try {
      await persist();
      const result = await batch.run(targets, (row) => row.title, (row, signal) => summarizeChapter(novelId, { chapter_id: row.chapter_id!, version: row.version }, batchChoice, signal));
      await refresh(); await reconcileCurrent();
      if (result) setNotice(zh ? `已为 ${result.done - result.failures.length} 章保存概要${result.stopped ? "（已停止）" : ""}` : `Saved ${result.done - result.failures.length} summaries`);
    } catch (e) { setError((e as Error).message); }
    finally { lock.current = false; }
  };
  const batchDelete = async () => {
    if (lock.current || agentOpen || !picked.length) return;
    const targets = rows.filter((row) => picked.includes(row.chapter_id!));
    if (!(await confirmDialog({
      title: zh ? `删除选中的 ${targets.length} 章？` : `Delete ${targets.length} chapters?`,
      message: zh ? "这些章节会移出章节列表，它们未保存的本机草稿会清除。删除后可以立即全部撤销。" : "The chapters leave the list and their unsaved drafts are cleared. You can undo right after.",
      confirmLabel: zh ? "删除" : "Delete", tone: "danger",
    }))) return;
    lock.current = true; setError(""); setNotice("");
    const removed: Chapter[] = [];
    const openId = live.current.editor?.chapter_id;
    const index = rows.findIndex((row) => row.chapter_id === openId);
    let next: string | undefined;
    try {
      await persist();
      await batch.run(targets, (row) => row.title, async (row) => {
        // 删除一章会让后面章节的版本号变化，每章删除前重新读取当前版本。
        const { version } = await apiGet<Chapter>(`/api/chapters/${row.chapter_id}`);
        removed.push(await apiDelete<Chapter>(`/api/chapters/${row.chapter_id}?expected_version=${version}`));
        await Promise.all([clearWritingDrafts(draftKey(row.chapter_id!)), clearWritingDrafts(oldBodyKey(row.chapter_id!))]);
      });
      setBatchDeleted(removed); setDeleted(null); setPicked([]);
      const remaining = await refresh();
      if (openId && removed.some((row) => row.chapter_id === openId)) {
        setEditor(null); setSaved(null); setConflict(false);
        next = remaining[Math.min(Math.max(index, 0), remaining.length - 1)]?.chapter_id;
        if (!next) onNavigate({}, true);
      } else await reconcileCurrent();
      setNotice(zh ? `已删除 ${removed.length} 章` : `Deleted ${removed.length} chapters`);
    } catch (e) { setError((e as Error).message); }
    finally { lock.current = false; }
    if (next) await open(next);
  };
  const undoBatchDelete = async () => {
    if (!batchDeleted.length || lock.current) return;
    lock.current = true; setBusy(true); setError("");
    const failed: Chapter[] = [];
    try {
      for (const row of batchDeleted) {
        try {
          const { version } = await apiGet<Chapter>(`/api/chapters/${row.chapter_id}?include_deleted=true`);
          await apiPost<Chapter>(`/api/chapters/${row.chapter_id}/restore`, { expected_version: version });
        } catch { failed.push(row); }
      }
      setBatchDeleted(failed); await refresh(); await reconcileCurrent();
      setNotice(failed.length ? (zh ? `${failed.length} 章未能恢复，可在回收站处理` : `${failed.length} could not be restored`) : (zh ? "已撤销批量删除" : "Batch deletion undone"));
    } catch (e) { setError((e as Error).message); }
    finally { lock.current = false; setBusy(false); }
  };
  const reorder = async (source: string, target: string, after: boolean) => {
    if (lock.current || agentOpen || pendingCreate || source === target) return;
    const moving = rows.find((row) => row.chapter_id === source);
    if (!moving) return;
    const next = rows.filter((row) => row.chapter_id !== source);
    const index = next.findIndex((row) => row.chapter_id === target);
    if (index < 0) return;
    next.splice(index + Number(after), 0, moving);
    if (next.every((row, i) => row.chapter_id === rows[i].chapter_id)) return;
    lock.current = true; setBusy(true); setError(""); setDrop(null);
    try {
      await persist();
      const result = await apiPatch<{ data: HierarchyRecord[] }>(`${base}/reorder`, { items: next.map((row, i) => ({ chapter_id: row.chapter_id, expected_version: row.version, order_index: i + 1 })) });
      setRows(result.data);
      await Promise.all(result.data.map(async (row) => {
        const previous = rows.find((before) => before.chapter_id === row.chapter_id);
        for (const key of [draftKey(row.chapter_id!), oldBodyKey(row.chapter_id!)]) {
          const cached = await readWritingDraft<unknown>(key);
          if (cached && cached.base_version === previous?.version && cached.base_version !== row.version) {
            await writeWritingDraft(key, row.version, cached.value);
            await writeWritingDraft(key, cached.base_version, null);
          }
        }
      }));
      // 仅本次已知排序改变版本；外部正文变化仍由逐章版本核对阻止，不能自动认可。
      const current = live.current;
      const row = result.data.find((row) => row.chapter_id === current.editor?.chapter_id);
      if (row && current.editor && current.saved && current.editor.version === current.saved.version && !conflict) {
        const rebased = { ...current.editor, version: row.version };
        setEditor(rebased); setSaved({ ...current.saved, version: row.version });
        setCheckpoint((previous) => previous && previous.chapter_id === row.chapter_id ? { ...previous, version: row.version } : previous);
        if (rebased.title !== current.saved.title || rebased.content !== current.saved.content) {
          await writeWritingDraft(draftKey(rebased.chapter_id), rebased.version, { title: rebased.title, content: rebased.content });
        }
      }
      setNotice(zh ? "章节顺序已保存" : "Chapter order saved");
    } catch (e) { setError((e as Error).message); }
    finally { lock.current = false; setBusy(false); }
  };

  const moveDrag = useEffectEvent((event: PointerEvent) => {
    const drag = dragged.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
    drag.moved = true;
    event.preventDefault();
    const list = listRef.current;
    const bounds = list?.getBoundingClientRect();
    if (list && bounds && event.clientX >= bounds.left && event.clientX <= bounds.right) {
      if (event.clientY < bounds.top + 32) list.scrollTop -= 18;
      else if (event.clientY > bounds.bottom - 32) list.scrollTop += 18;
    }
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-chapter-row]");
    const rect = row?.getBoundingClientRect();
    drag.target = row && rect && list?.contains(row) ? { id: row.dataset.chapterRow!, after: event.clientY > rect.top + rect.height / 2 } : null;
    setDrop(drag.target);
  });
  const endDrag = useEffectEvent((event: PointerEvent, cancel = false) => {
    const drag = dragged.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    dragged.current = null; setDrop(null);
    if (drag.handle.hasPointerCapture(event.pointerId)) drag.handle.releasePointerCapture(event.pointerId);
    if (!cancel && drag.moved && drag.target) void reorder(drag.id, drag.target.id, drag.target.after);
  });
  useEffect(() => {
    // 浏览器或外层组件可能释放指针捕获；移动和松开仍须完成同一次拖动。
    const move = (event: PointerEvent) => moveDrag(event);
    const up = (event: PointerEvent) => endDrag(event);
    const cancel = (event: PointerEvent) => endDrag(event, true);
    const blur = () => { dragged.current = null; setDrop(null); };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", blur);
      dragged.current = null;
    };
  }, []);

  return <section data-testid="chapter-editor-workspace" className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4 sm:p-6">
    <header className="flex shrink-0 items-center justify-between gap-3"><h1 className="text-lg font-semibold">{zh ? "章节编辑" : "Chapter editor"}</h1><span className="text-xs text-muted">{zh ? `共 ${rows.length} 章` : `${rows.length} chapters`}</span></header>
    {error && <p role="alert" className="shrink-0 text-sm text-danger">{error} <button className="underline" onClick={() => void initialize()} disabled={busy}>{zh ? "重新读取" : "Reload"}</button></p>}
    {(notice || deleted || batchDeleted.length > 0) && <div role="status" className="flex shrink-0 items-center gap-3 text-xs text-muted">{notice}{deleted && <button className="text-accent underline" disabled={locked} onClick={() => void undoDelete()}>{zh ? "撤销删除" : "Undo deletion"}</button>}{batchDeleted.length > 0 && <button className="text-accent underline" disabled={locked} onClick={() => void undoBatchDelete()}>{zh ? `撤销删除这 ${batchDeleted.length} 章` : `Undo deleting ${batchDeleted.length}`}</button>}</div>}
    <div className={`grid min-h-0 flex-1 gap-4 ${collapsed ? "grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[2.5rem_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)]" : "grid-rows-[minmax(8rem,25vh)_minmax(0,1fr)] md:grid-cols-[15rem_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)] xl:grid-cols-[18rem_minmax(0,1fr)]"}`}>
      {collapsed ? <CollapsedRail label={zh ? "章节列表" : "Chapters"} count={rows.length} controls="chapter-list-panel" onExpand={() => setCollapsed(false)} /> :
      <aside id="chapter-list-panel" className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface" aria-label={zh ? "章节列表" : "Chapter list"}>
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border p-3"><span className="text-sm font-medium">{zh ? "全部章节" : "All chapters"}</span><span className="flex items-center gap-1"><Button data-testid="chapter-create" size="sm" variant="secondary" isDisabled={busy || agentOpen || !ready || batch.running} onPress={() => void create()}><span aria-hidden="true">＋</span>{pendingCreate ? (zh ? "重试新建" : "Retry creation") : (zh ? "新建章节" : "New chapter")}</Button><CollapseButton controls="chapter-list-panel" onPress={() => setCollapsed(true)} label={zh ? "收起章节列表" : "Collapse chapter list"} /></span></div>
        <div className="shrink-0 space-y-2 border-b border-border px-3 py-2">
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" data-testid="chapter-batch-mode" checked={batchMode} disabled={batch.running} onChange={(e) => { setBatchMode(e.target.checked); if (!e.target.checked) setPicked([]); }} />{zh ? "批量选择（生成概要、删除）" : "Batch select"}</label>
          <input data-testid="chapter-filter" aria-label={zh ? "按关键词筛选章节" : "Filter chapters by keyword"} className={`${INPUT} w-full text-xs`} value={keyword} maxLength={60} placeholder={zh ? "筛选：标题或正文里的关键词" : "Filter by title or text"} onChange={(e) => setKeyword(e.target.value)} />
          {keywordText && <p role="status" data-testid="chapter-filter-status" className="flex flex-wrap items-center gap-x-2 text-xs text-muted"><span className="text-fill">{keywordSearching ? (zh ? "正在查找正文…" : "Searching text…") : (zh ? `筛出 ${rows.filter(matches).length} / ${rows.length} 章` : `${rows.filter(matches).length} / ${rows.length} chapters`)}</span><button type="button" className="text-accent" onClick={() => setKeyword("")}>{zh ? "清除筛选" : "Clear"}</button></p>}
          {batchMode && <BatchSelectBar ids={rows.filter(matches).map((row) => row.chapter_id!)} selected={picked} onChange={setPicked} anchor={editor?.chapter_id} disabled={locked} pageLabel={keywordText ? (zh ? "全选筛出的章节" : "Select filtered") : (zh ? "全选全部章节" : "Select all")}>
            <details className="w-full"><summary className="cursor-pointer text-muted">{zh ? "生成概要用的模型" : "Model for summaries"}</summary><div className="mt-2"><ModelPicker value={batchChoice} onChange={setBatchChoice} disabled={locked} /></div></details>
            <label className="flex items-center gap-1"><input type="checkbox" checked={skipSummarized} disabled={locked} onChange={(e) => setSkipSummarized(e.target.checked)} />{zh ? "跳过已有概要" : "Skip summarized"}</label>
            <Button size="sm" variant="secondary" data-testid="chapter-batch-summary" isDisabled={locked || !picked.length} onPress={() => void batchSummaries()}>{zh ? "批量生成概要" : "Summarize"}</Button>
            <Button size="sm" variant="ghost" className="text-danger" data-testid="chapter-batch-delete" isDisabled={locked || !picked.length} onPress={() => void batchDelete()}>{zh ? "批量删除" : "Delete"}</Button>
          </BatchSelectBar>}
          <BatchProgressView progress={batch.progress} running={batch.running} onStop={batch.stop} onClose={batch.clear} />
        </div>
        <nav ref={listRef} data-testid="chapter-list" className="workspace-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          {!ready && <p className="p-3 text-sm text-muted">{zh ? "正在读取章节…" : "Loading chapters…"}</p>}
          {ready && !rows.length && <p className="p-3 text-sm text-muted">{zh ? "还没有章节，点击上方新建。" : "Create your first chapter above."}</p>}
          {ready && rows.length > 0 && keywordText && !keywordSearching && !rows.some(matches) && <p className="p-3 text-sm text-muted">{zh ? "没有章节包含这个关键词。" : "No chapter contains this keyword."}</p>}
          {rows.map((row, i) => !matches(row) ? null : <div key={row.chapter_id} data-chapter-row={row.chapter_id} className={`relative flex min-w-0 items-center gap-1 rounded-xl ${editor?.chapter_id === row.chapter_id ? "bg-accent/10 text-accent" : "hover:bg-background"}`}>
            {drop?.id === row.chapter_id && <span className={`pointer-events-none absolute inset-x-1 z-10 border-t-2 border-accent ${drop?.after ? "bottom-0" : "top-0"}`} />}
            {batchMode && <input type="checkbox" data-chapter-pick={row.chapter_id} aria-label={zh ? `选择第 ${i + 1} 章` : `Select chapter ${i + 1}`} className="ml-2 shrink-0" checked={picked.includes(row.chapter_id!)} disabled={locked} onChange={(e) => setPicked((ids) => e.target.checked ? [...ids, row.chapter_id!] : ids.filter((id) => id !== row.chapter_id))} />}
            <span role="button" tabIndex={locked ? -1 : 0} aria-disabled={locked} data-chapter-drag={row.chapter_id} aria-label={zh ? `拖动第 ${i + 1} 章排序` : `Reorder chapter ${i + 1}`} title={zh ? "拖动排序，也可用上下方向键移动" : "Drag, or use arrow keys to move"} className={`inline-flex touch-none select-none rounded-lg p-2 text-muted outline-none focus-visible:ring-2 focus-visible:ring-accent/30 ${locked ? "opacity-40" : "cursor-grab active:cursor-grabbing"}`} onPointerDown={(event) => {
              if (locked || !event.isPrimary || event.button !== 0) return;
              event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
              dragged.current = { id: row.chapter_id!, handle: event.currentTarget, pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false, target: null };
            }} onKeyDown={(event) => {
              if (locked) return;
              const target = event.key === "ArrowUp" ? rows[i - 1] : event.key === "ArrowDown" ? rows[i + 1] : null;
              if (target) { event.preventDefault(); void reorder(row.chapter_id!, target.chapter_id!, event.key === "ArrowDown"); }
            }}><span aria-hidden="true" className="pointer-events-none text-lg leading-none">⠿</span></span>
            <button data-chapter-open={row.chapter_id} disabled={locked} aria-current={editor?.chapter_id === row.chapter_id ? "page" : undefined} className="min-w-0 flex-1 py-3 pr-2 text-left disabled:opacity-50" onClick={() => { if (row.chapter_id !== editor?.chapter_id) void open(row.chapter_id!); }}><span className="block text-xs tabular-nums text-muted">{zh ? `第 ${i + 1} 章` : `Chapter ${i + 1}`}</span><span className="block truncate text-sm">{row.title}</span>{keywordText && keywordHits?.chapters.get(row.chapter_id!)?.hits ? <span data-keyword-hit className="block text-[11px] leading-4 text-muted">{hitLabel(keywordHits.chapters.get(row.chapter_id!), zh)}：…{keywordHits.chapters.get(row.chapter_id!)!.snippet}…</span> : null}{stampText(row, zh) && <span data-chapter-stamp className={`block truncate text-[11px] tabular-nums ${byAgent(row) ? "text-accent" : "text-muted"}`} title={zh ? `最近修改：${stampText(row, zh, false)}` : `Last modified: ${stampText(row, zh, false)}`}>{zh ? "改于 " : ""}{stampText(row, zh)}</span>}</button>
          </div>)}
        </nav>
        {rows.length > 1 && <p className="shrink-0 border-t border-border px-3 py-2 text-xs text-muted">{zh ? "拖动章节左侧手柄调整顺序" : "Drag a handle to reorder chapters"}</p>}
      </aside>}
      <section className="flex min-h-0 min-w-0 flex-col gap-3 rounded-2xl border border-border bg-surface p-4" aria-label={zh ? "章节正文" : "Chapter text"}>
        {editor ? <>
          <div className="flex shrink-0 flex-wrap items-center gap-2"><input data-testid="chapter-title" aria-label={zh ? "章节标题" : "Chapter title"} className={`${INPUT} w-48 flex-1 text-base font-medium`} value={editor.title} disabled={locked} onChange={(event) => edit({ title: event.target.value })} /><Button data-testid="chapter-save" size="sm" variant="primary" isDisabled={locked || !dirty || conflict || !editor.title.trim()} onPress={() => void save()}>{zh ? "保存正文" : "Save chapter"}</Button><Button data-testid="chapter-history-open" size="sm" variant="secondary" isDisabled={busy || agentOpen} onPress={() => setHistoryOpen(true)}>{zh ? "历史版本 / 恢复" : "History / Restore"}</Button>{sessionDirty && !conflict && <Button data-testid="chapter-discard" size="sm" variant="ghost" isDisabled={locked} onPress={() => void discard().catch((e) => setError(e.message))}>{zh ? "忽略此次修改" : "Discard changes"}</Button>}<Button data-testid="chapter-full-text" size="sm" variant="ghost" isDisabled={busy || agentOpen} onPress={() => setFullText(true)}>{zh ? "全屏编辑" : "Full screen"}</Button><Button data-testid="chapter-delete" size="sm" variant="ghost" isDisabled={locked || conflict} onPress={() => void remove()}>{zh ? "删除当前章节" : "Delete chapter"}</Button></div>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 text-xs text-muted"><span>{dirty ? (zh ? "有未保存的修改 · 已在本机保留草稿" : "Unsaved edits · draft kept locally") : (zh ? "已保存" : "Saved")}{stampText(saved ?? editor, zh) && <span data-testid="chapter-last-modified" className={byAgent(saved ?? editor) ? "text-accent" : ""}>{zh ? ` · 最近修改 ${stampText(saved ?? editor, zh, false)}` : ` · Last modified ${stampText(saved ?? editor, zh, false)}`}</span>}</span><SelectionAgentButton novelId={novelId} target="chapter" sourceId={editor.chapter_id} textareaRef={bodyRef} value={editor.content} onReplace={(content) => { edit({ content }); setHasSelection(false); }} onReplaceAndSave={conflict || !editor.title.trim() ? undefined : (content) => { setHasSelection(false); return save(content); }} disabled={locked || !hasSelection} label={zh ? "AI 修改选中内容" : "AI edit selected text"} onOpenChange={setAgentOpen} testId="chapter-ai-edit" /></div>
          {conflict && saved && <div role="alert" className="shrink-0 space-y-2 text-sm">
            <p className="text-danger">{zh ? "已保存章节有新版本，当前草稿已保留。请先核对最新正文，再选择继续编辑的内容。" : "The saved chapter changed. Your draft is preserved. Compare the latest text before continuing."}</p>
            <details><summary className="cursor-pointer text-accent">{zh ? "查看最新保存的正文" : "View latest saved text"}</summary><p className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border p-3">{saved.title}{"\n\n"}{saved.content}</p></details>
            <div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" isDisabled={locked} onPress={() => {
              setEditor({ ...editor, version: saved.version }); setCheckpoint((previous) => previous ? { ...previous, version: saved.version } : previous); setConflict(false); setError("");
              writes.current = writes.current.catch(() => {}).then(() => writeWritingDraft(draftKey(editor.chapter_id), saved.version, { title: editor.title, content: editor.content }))
                .catch((e) => { storageFailure.current = e; setError(e.message); });
            }}>{zh ? "保留当前草稿，继续编辑" : "Continue with my draft"}</Button><Button size="sm" variant="ghost" isDisabled={locked} onPress={() => { void (async () => {
              await persist(); await Promise.all([clearWritingDrafts(draftKey(editor.chapter_id)), clearWritingDrafts(oldBodyKey(editor.chapter_id))]);
              setEditor(saved); setCheckpoint(saved); setConflict(false); setError(""); onDirtyChange(false);
            })().catch((e) => setError(e.message)); }}>{zh ? "采用最新保存的正文" : "Use latest saved text"}</Button></div>
          </div>}
          <TextFindReplace key={editor.chapter_id} textareaRef={bodyRef} value={editor.content} onChange={(content) => { edit({ content }); setHasSelection(false); }} disabled={locked} />
          <textarea id="chapter-body" data-testid="chapter-body" ref={bodyRef} aria-label={zh ? "章节正文" : "Chapter text"} className={`${INPUT} workspace-scrollbar min-h-40 flex-1 resize-none overflow-y-auto overscroll-contain p-4 text-[15px] leading-8`} value={editor.content} disabled={locked} onChange={(event) => { edit({ content: event.target.value }); setHasSelection(false); }} onSelect={updateSelection} onPointerUp={updateSelection} onKeyUp={updateSelection} placeholder={zh ? "在这里编辑本章正文。选中一段文字后，可以让 AI 按要求修改。" : "Write your chapter here. Select a passage to edit it with AI."} />
          <span className="shrink-0 text-right text-xs tabular-nums text-muted">{Array.from(editor.content.replace(/\s/g, "")).length} {zh ? "字" : "characters"}</span>
        </> : <p className="m-auto text-sm text-muted">{busy ? (zh ? "正在读取正文…" : "Loading chapter…") : (zh ? "选择左侧章节，或新建章节开始写作。" : "Select or create a chapter to start writing.")}</p>}
      </section>
    </div>
    {fullText && editor && <FullTextDialog title={`${editor.title} · ${zh ? "全屏编辑" : "Full screen"}`} value={editor.content} onChange={locked ? undefined : (content) => edit({ content })} onClose={() => setFullText(false)}
      tools={<Button size="sm" variant="primary" isDisabled={locked || !dirty || conflict || !editor.title.trim()} onPress={() => void save()}>{zh ? "保存正文" : "Save chapter"}</Button>} />}
    {historyOpen && editor && <ChapterHistoryDialog chapterId={editor.chapter_id} currentVersion={saved?.version ?? editor.version} dirty={dirty}
      onRestored={historyRestored} onClose={() => setHistoryOpen(false)} />}
  </section>;
}
