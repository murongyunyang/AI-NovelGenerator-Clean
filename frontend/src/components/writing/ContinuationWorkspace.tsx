"use client";

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Button } from "@heroui/react";
import { useLocale, useTranslations } from "next-intl";
import { RetainedViewActive } from "@/components/layout/RetainedViews";
import { apiGet, apiPost, apiPostSSE, ApiRequestError } from "@/lib/api";
import { readWritingDraft, writeWritingDraft } from "@/lib/writingDrafts";
import { setBookBusy } from "@/lib/openBooks";
import { downloadExport } from "@/lib/userExport";
import type { HierarchyRecord } from "@/types/hierarchy";
import { useResourceRefresh } from "@/hooks/useResourceRefresh";
import { ModelPicker, type ModelChoice } from "@/components/shared/ModelPicker";
import { ConfirmActionModal } from "@/components/shared/RelationEditorPrimitives";
import { FullTextDialog } from "@/components/shared/FullTextDialog";
import { TextFindReplace } from "@/components/shared/TextFindReplace";
import ChapterSummaryDialog from "./ChapterSummaryDialog";
import { MemoryPanel, MemoryProposalPrompt, SelectionAgentButton, type MemoryProposal } from "./SelectionAgent";
import { FeedbackNotesPanel, FeedbackPreferenceDraft, type PendingFeedback } from "./AgentFeedback";
import { candidateFromEvent, doneSummary, settleTrace, traceReducer, type TraceItem } from "./AgentTrace";
import { AgentConsoleBar, AgentRunCard, AgentTimeline, type RunOutcome } from "./AgentWorkbench";
import { agentRequestOptions, DeslopToggle, effortFrom, EffortSelect, isSubmitShortcut, ReviewModeControls, untilPassFrom } from "./AgentSettings";
import { WorkflowPicker, workflowId, type WorkflowId } from "./WorkflowPicker";
import { confirmDialog } from "@/components/shared/ConfirmDialog";
import { BookDocumentChanges, publishBookDocumentChange, type BookDocumentChange } from "./BookDocumentChanges";

interface Basis {
  expected_tail_id: string | null;
  expected_tail_version: number | null;
  sources: { chapter_id: string; version: number }[];
  expected_novel_version?: number;
}
interface SaveBody extends Basis { title: string; content: string }
interface OutlineRow { id: string; title: string; word_count: number }
import { ReferenceBooksPicker, type BookReference } from "./ReferenceBooksPicker";

interface Draft {
  reference_books?: BookReference[];
  workflow: WorkflowId;
  feedback: string;
  conversation: { text: string; feedback: string }[];
  trace: TraceItem[];
  selected: string[];
  planOutlineIds: string[];
  chapterModes: Record<string, "original" | "summary">;
  writeModel: ModelChoice;
  materialsModel: ModelChoice;
  reviewRounds: number;
  reviewUntilPass: boolean;
  deslop: boolean;
  reasoningEffort: string;
  reviewRequirements: string;
  reviewLog: { passed: boolean | null; stopped_reason: string; rounds: { round: number; score: number; summary: string; revised: boolean; issues: { problem: string; suggestion: string }[] }[] } | null;
  contextMode: "original" | "summary";
  summary: string;
  outline: string;
  materials: string;
  title: string;
  words: number | null;
  content: string;
  basis: Basis | null;
  command: { key: string; body: SaveBody } | null;
  /** 上一次智能体运行怎样结束、何时开始；工作台据此显示结果和每一步的时刻。 */
  runOutcome?: RunOutcome;
  runStartedAt?: number | null;
}
const EMPTY: Draft = { workflow: "auto", feedback: "", conversation: [], trace: [], selected: [], planOutlineIds: [], chapterModes: {}, writeModel: { provider: "", model: "" }, materialsModel: { provider: "", model: "" }, reviewRounds: 2, reviewUntilPass: true, deslop: false, reasoningEffort: "", reviewRequirements: "", reviewLog: null, contextMode: "original", summary: "", outline: "", materials: "", title: "", words: null, content: "", basis: null, command: null, runOutcome: null, runStartedAt: null };
const CONTROL = "w-full min-w-0 rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/15 disabled:opacity-60";

/** 日常续写只需要前文和大纲；生成内容先保留为本地草稿，确认后追加新章。 */
export default function ContinuationWorkspace({ novelId, onBusyChange }: { novelId: string; onBusyChange: (busy: boolean) => void }) {
  const t = useTranslations("writing.continuation");
  const locale = useLocale();
  const zh = locale !== "en";
  const active = useContext(RetainedViewActive);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [chapters, setChapters] = useState<HierarchyRecord[]>([]);
  const [novelTitle, setNovelTitle] = useState("");
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [notice, setNotice] = useState("");
  const [answer, setAnswer] = useState("");
  const [bookReport, setBookReport] = useState("");
  const [bookChanges, setBookChanges] = useState<BookDocumentChange[]>([]);
  // 给智能体提意见后的结果（暂存第几次 / 已总结成经验），与修改完成的提示分开显示。
  // undefined：这一轮没提意见；null：意见没能存成偏好。
  const [pendingFeedback, setPendingFeedback] = useState<PendingFeedback | null>(null);
  const [busy, setBusy] = useState<"write" | "revise" | "summarize" | "materials" | "save" | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [summaryChapter, setSummaryChapter] = useState<HierarchyRecord | null>(null);
  const [selectSummaryOnSave, setSelectSummaryOnSave] = useState(false);
  const [missingSummary, setMissingSummary] = useState<HierarchyRecord | null>(null);
  const [progress, setProgress] = useState("");
  const [trace, setTrace] = useState<TraceItem[]>([]);
  const [memoryProposals, setMemoryProposals] = useState<MemoryProposal[]>([]);
  const [memoryRevision, setMemoryRevision] = useState(0);
  const [outlineRows, setOutlineRows] = useState<OutlineRow[]>([]);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [outlineQuery, setOutlineQuery] = useState("");
  // 全屏阅读正文；修改意见只针对正文框里选中的一段时记下这段文字。
  const [fullText, setFullText] = useState(false);
  const [focus, setFocus] = useState("");
  // setup 为续写设置；agent 为智能体工作台。开始续写或按意见修改时自动切到工作台，保存本章后回到设置。
  const [view, setView] = useState<"setup" | "agent">("setup");
  const controller = useRef<AbortController | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const fullRef = useRef<HTMLTextAreaElement>(null);
  const outlineRef = useRef<HTMLTextAreaElement>(null);
  const generation = useRef(0);
  const lock = useRef(false);
  const liveDraft = useRef(draft);
  const persistQueue = useRef(Promise.resolve());
  const key = `continuation:${novelId}`;
  liveDraft.current = draft;

  const persist = useCallback((value: Draft) => {
    const task = persistQueue.current.catch(() => {}).then(() => writeWritingDraft(key, 1, value));
    persistQueue.current = task;
    return task;
  }, [key]);

  const loadDirectory = useCallback(async () => {
    const result = await apiGet<{ data: HierarchyRecord[] }>(`/api/chapters/novel/${novelId}`);
    setChapters(result.data);
    return result.data;
  }, [novelId]);

  // “本书大纲”目录只读标题和字数；被删除的章纲从已关联的计划中移除。
  const loadOutlines = useCallback(async () => {
    const result = await apiGet<{ chapters: OutlineRow[] }>(`/api/novels/${novelId}/outline-chapters`);
    setOutlineRows(result.chapters);
    const ids = new Set(result.chapters.map((row) => row.id));
    setDraft((current) => current.planOutlineIds.every((id) => ids.has(id)) ? current : { ...current, planOutlineIds: current.planOutlineIds.filter((id) => ids.has(id)) });
    return result.chapters;
  }, [novelId]);

  useEffect(() => {
    let current = true;
    void Promise.all([apiGet<{ data: HierarchyRecord[] }>(`/api/chapters/novel/${novelId}`), apiGet<{ title: string }>(`/api/novels/${novelId}`), readWritingDraft<Draft>(key).catch(() => {
      if (current) setStorageError(t("storageFailed"));
      return null;
    })]).then(([result, novel, saved]) => {
      if (!current) return;
      setChapters(result.data);
      setNovelTitle(novel.title);
      setTrace(settleTrace(saved?.value.trace ?? []));
      setDraft(saved?.value ? { ...EMPTY, ...saved.value, runOutcome: saved.value.runOutcome ?? (saved.value.reviewLog ? "done" : saved.value.trace?.length ? "stopped" : null), workflow: workflowId(saved.value.workflow), reviewUntilPass: untilPassFrom(saved.value.reviewUntilPass, saved.value.reviewRounds ?? EMPTY.reviewRounds), reasoningEffort: effortFrom(saved.value.reasoningEffort), chapterModes: saved.value.chapterModes ?? Object.fromEntries(saved.value.selected.map((id) => [id, saved.value.contextMode ?? "original"])) } : { ...EMPTY });
      if (saved?.value.content || saved?.value.outline) setNotice(t("restored"));
      setReady(true);
      void loadOutlines().catch(() => {});
    }).catch((failure) => { if (current) setError(failure.message); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; controller.current?.abort(); };
  }, [key, novelId, t, loadOutlines]);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => {
      void persist(draft).then(() => setStorageError("")).catch(() => setStorageError(t("storageFailed")));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [draft, persist, ready, t]);

  useEffect(() => {
    if (!ready) return;
    return () => { void persist(liveDraft.current).catch(() => {}); };
  }, [persist, ready]);

  useResourceRefresh(novelId, async () => {
    if (ready && !lock.current) await Promise.all([loadDirectory(), loadOutlines()]).catch((failure) => setError(failure.message));
  }, active);

  useEffect(() => {
    // 生成请求由保留的工作区继续持有；只有保存和模态编辑需要阻止导航。
    if (active) onBusyChange(Boolean(busy === "save" || summaryChapter || missingSummary));
    return () => { if (active) onBusyChange(false); };
  }, [active, busy, summaryChapter, missingSummary, onBusyChange]);

  useEffect(() => {
    if (!active && !busy) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (liveDraft.current.content || liveDraft.current.outline || liveDraft.current.command || storageError) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [active, busy, storageError]);

  useEffect(() => { setDraft((current) => ({ ...current, trace: settleTrace(trace) })); }, [trace]);

  // 生成中正文框停在最新的文字上；作者向上翻看时不再拉回，翻回底部后恢复。
  const followContent = useRef(true);
  const agentWriting = busy === "write" || busy === "revise";
  // 顶栏书签页上这本书显示“运行中”；切到别的书不影响生成。
  useEffect(() => {
    setBookBusy(novelId, "continuation", agentWriting);
    return () => setBookBusy(novelId, "continuation", false);
  }, [novelId, agentWriting]);
  useEffect(() => {
    const element = contentRef.current;
    if (element && agentWriting && followContent.current) element.scrollTop = element.scrollHeight;
  }, [draft.content, agentWriting]);

  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  // 切到工作台时回到页面顶部，窄屏上也能先看到阶段和时间线。
  const openAgent = () => { followContent.current = true; setView("agent"); window.requestAnimationFrame(() => sectionRef.current?.scrollTo({ top: 0 })); };
  const locked = Boolean(busy || draft.command || !ready);
  const selectedCount = draft.selected.length;
  const tail = chapters.at(-1);
  const currentBasis = (): Basis => ({ expected_tail_id: tail?.chapter_id ?? null, expected_tail_version: tail?.version ?? null, sources: [] });
  const linkedContext = { chapters: draft.selected.map((chapter_id) => ({ chapter_id, mode: draft.chapterModes[chapter_id] ?? "original" as const })), outline_ids: draft.planOutlineIds, free_lookup: false };
  const planTitles = outlineRows.filter((row) => draft.planOutlineIds.includes(row.id)).map((row) => row.title).join("、");
  const setChapterMode = (row: HierarchyRecord, mode: "original" | "summary") => {
    if (mode === "summary" && !row.summary.trim()) { setMissingSummary(row); return; }
    update({ chapterModes: { ...draft.chapterModes, [row.chapter_id!]: mode } });
  };

  const generate = async (action: "write" | "summarize" | "materials") => {
    if (lock.current || draft.command) return;
    const field = action === "write" ? "content" : action === "summarize" ? "summary" : "materials";
    if (draft[field].trim() && !(await confirmDialog({
      title: t("replaceTitle"), message: t("replace"), confirmLabel: t("replaceConfirm"), cancelLabel: t("replaceCancel"),
      ...(action === "write" ? { extra: { label: t("export"), onPress: exportDraft } } : {}),
    }))) return;
    if (lock.current) return;
    lock.current = true;
    setBusy(action); setError(""); setNotice(""); setAnswer(""); setBookReport(""); setProgress(""); setFocus(""); setMemoryProposals([]);
    if (action === "write") { update({ reviewLog: null, conversation: [], feedback: "", runOutcome: null, runStartedAt: Date.now() }); setTrace([]); openAgent(); }
    const request = ++generation.current;
    const abort = new AbortController(); controller.current = abort;
    let received = "";
    let basis: Basis | null = null;
    try {
      await apiPostSSE(`/api/novels/${novelId}/continuation/stream`, {
        action, book_edit: action === "write", reference_books: draft.reference_books ?? [], chapter_contexts: draft.selected.map((chapter_id) => ({ chapter_id, mode: draft.chapterModes[chapter_id] ?? "original" })),
        ...(action === "materials" ? draft.materialsModel : draft.writeModel),
        ...(action === "write" ? agentRequestOptions({ rounds: draft.reviewRounds, untilPass: draft.reviewUntilPass, effort: draft.reasoningEffort, deslop: draft.deslop }) : { review_rounds: 0 }), review_requirements: draft.reviewRequirements,
        outline: draft.outline, materials: draft.materials, ...(action === "summarize" ? {} : { plan_outline_ids: draft.planOutlineIds }),
        title: draft.title, target_words: draft.words, workflow: draft.workflow,
      }, (event, data) => {
        if (data.basis) basis = data.basis as unknown as Basis;
        if (event === "book_document_change") {
          const change = data as unknown as BookDocumentChange;
          setBookChanges((current) => [...current, change]); publishBookDocumentChange(novelId, change);
        }
        if (event === "progress" && data.message) setProgress(String(data.message));
        if (event === "memory_proposal") setMemoryProposals((current) => [...current, data as unknown as MemoryProposal]);
        // 正文随起草更新；即使审查中断，也保留已收到的稿件和原生成依据。
        const now = Date.now();
        if (action === "write") setTrace((items) => traceReducer(items, event, data, locale !== "en", now));
        const candidate = candidateFromEvent(received, event, data);
        if (candidate !== null) {
          received = candidate;
          setDraft((current) => ({ ...current, [field]: candidate, ...(action === "write" ? { basis } : {}), ...(action === "summarize" ? { contextMode: "summary" as const } : {}) }));
        }
        if (event === "done" && typeof data.answer === "string" && data.answer) {
          // 作者只是提问：只显示回答，正文不动。
          setAnswer(data.answer);
          setDraft((current) => ({ ...current, ...(action === "write" ? { runOutcome: "done" as const } : {}) }));
          setNotice(zh ? "这次判断为提问：只回答，没有写正文。" : "Treated as a question: answered without writing.");
        } else if (event === "done" && typeof data.report === "string" && data.report) {
          setBookReport(data.report);
          setDraft((current) => ({ ...current, runOutcome: "done" as const }));
          setNotice(zh ? "本书文档处理结束，实际保存的改动列在下方。" : "Book task ended. Saved changes are listed below.");
        } else if (event === "done") {
          setDraft((current) => ({ ...current, ...(action === "write" ? { reviewLog: data.review_log as unknown as Draft["reviewLog"] ?? null, runOutcome: "done" as const } : {}) }));
          const summary = action === "write" ? doneSummary(data, zh) : "";
          setNotice(t(action === "write" ? "generated" : action === "summarize" ? "summarized" : "materialsGenerated") + (summary ? ` · ${summary}` : ""));
        }
      }, { signal: abort.signal, idleTimeoutMs: 45000, allowedEvents: ["delta", "replacement", "trace", "memory_proposal", "outline_request", "outline_change", "book_document_change"], isCurrentRequest: () => generation.current === request });
    } catch (failure) {
      if (action === "write") update({ runOutcome: abort.signal.aborted ? "stopped" : "error" });
      if (abort.signal.aborted) setNotice(t("stopped"));
      else setError(failure instanceof Error ? failure.message : t("failed"));
    } finally {
      if (generation.current === request) { const now = Date.now(); lock.current = false; controller.current = null; setBusy(null); setProgress(""); setTrace((items) => settleTrace(items, "stopped", now)); }
    }
  };

  const revise = async (asFeedback = false) => {
    const current = liveDraft.current;
    if (lock.current || current.command || !current.content.trim() || !current.feedback.trim()) return;
    lock.current = true;
    setBusy("revise"); setError(""); setNotice(""); setAnswer(""); setBookReport(""); setPendingFeedback(null); setProgress(""); setTrace([]); setMemoryProposals([]); openAgent();
    const source = current.content;
    const feedback = current.feedback.trim();
    if (asFeedback) {
      // 给智能体提意见：先给出偏好草案和问题，作者确认或调整方向后才保存；修改照常进行。
      setPendingFeedback({ text: feedback, excerpt: source.slice(0, 400), target: "chapter" });
    }
    // 选中的一段仍在正文里才只改这一段；正文已被改动、找不到时按全文意见修改。
    const only = focus && source.includes(focus) ? focus : "";
    const conversation = [...current.conversation, { text: source, feedback: only ? `【只改选中的一段】${feedback}` : feedback }].slice(-30);
    update({ conversation, reviewLog: null, runOutcome: null, runStartedAt: Date.now() });
    const request = ++generation.current;
    const abort = new AbortController(); controller.current = abort;
    let received = "";
    try {
      await apiPostSSE(`/api/novels/${novelId}/writing-agent/rewrite/stream`, {
        target: "chapter", selection: source, draft: source, focus: only, instruction: feedback, latest_instruction: feedback, book_edit: true,
        linked: { reference_books: current.reference_books ?? [], chapters: current.selected.map((chapter_id) => ({ chapter_id, mode: current.chapterModes[chapter_id] ?? "original" })), outline_ids: current.planOutlineIds, free_lookup: false },
        before: `【本章计划】\n${current.outline}\n${planTitles}\n【作者提供的设定备忘】\n${current.materials}`,
        attempts: conversation.slice(0, -1), ...current.writeModel, ...agentRequestOptions({ rounds: current.reviewRounds, untilPass: current.reviewUntilPass, effort: current.reasoningEffort, deslop: current.deslop }), workflow: current.workflow,
      }, (event, data) => {
        if (event === "book_document_change") {
          const change = data as unknown as BookDocumentChange;
          setBookChanges((current) => [...current, change]); publishBookDocumentChange(novelId, change);
        }
        if (event === "progress" && data.message) setProgress(String(data.message));
        if (event === "memory_proposal") setMemoryProposals((current) => [...current, data as unknown as MemoryProposal]);
        const now = Date.now();
        setTrace((items) => traceReducer(items, event, data, zh, now));
        const candidate = candidateFromEvent(received, event, data);
        if (candidate !== null) {
          received = candidate;
          // 全文修订完成前保留原完整稿；停止或报错也不会用半篇覆盖。
          if (event === "replacement" || event === "done") update({ content: candidate });
        }
        if (event === "done" && typeof data.answer === "string" && data.answer) {
          // 作者只是提问：只显示回答，正文不动；这句提问不算进修改记录。
          setAnswer(data.answer);
          update({ feedback: "", conversation: conversation.slice(0, -1), runOutcome: "done" });
          setNotice(zh ? "这次判断为提问：只回答，没有改稿。" : "Treated as a question: answered without rewriting.");
        } else if (event === "done" && typeof data.report === "string" && data.report) {
          setBookReport(data.report);
          update({ feedback: "", conversation: conversation.slice(0, -1), runOutcome: "done" });
          setNotice(zh ? "本书文档处理结束，实际保存的改动列在下方。" : "Book task ended. Saved changes are listed below.");
        } else if (event === "done") {
          update({ feedback: "", reviewLog: data.review_log as unknown as Draft["reviewLog"] ?? null, runOutcome: "done" });
          setFocus("");
          setMemoryRevision((value) => value + 1);
          const summary = doneSummary(data, zh);
          setNotice((zh ? "已按意见修改，可以继续追问。" : "Revision ready. You can send more feedback.") + (summary ? ` · ${summary}` : ""));
        }
      }, { signal: abort.signal, idleTimeoutMs: 45000, allowedEvents: ["delta", "replacement", "trace", "memory_proposal", "outline_request", "outline_change", "book_document_change"], isCurrentRequest: () => generation.current === request });
    } catch (failure) {
      update({ runOutcome: abort.signal.aborted ? "stopped" : "error" });
      if (abort.signal.aborted) setNotice(t("stopped"));
      else setError(failure instanceof Error ? failure.message : t("failed"));
    } finally {
      if (generation.current === request) { const now = Date.now(); lock.current = false; controller.current = null; setBusy(null); setProgress(""); setTrace((items) => settleTrace(items, "stopped", now)); }
    }
  };

  const save = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy("save"); setError(""); setNotice("");
    const command = draft.command ?? {
      key: crypto.randomUUID(),
      body: { ...(draft.basis ?? currentBasis()), title: draft.title.trim() || t("defaultTitle", { number: chapters.length + 1 }), content: draft.content },
    };
    const pending = { ...draft, command };
    update({ command });
    try {
      // 请求发出前先保留原命令，断线或重启后用相同键核对，避免重复追加章节。
      await persist(pending);
      await apiPost<HierarchyRecord>(`/api/novels/${novelId}/continuation/save`, command.body, { headers: { "Idempotency-Key": command.key } });
      const completed: Draft = { ...pending, content: "", title: "", outline: "", summary: "", feedback: "", conversation: [], trace: [], reviewLog: null, runOutcome: null, runStartedAt: null, contextMode: "original", basis: null, command: null, planOutlineIds: pending.planOutlineIds };
      await persist(completed);
      setDraft(completed);
      setTrace([]);
      setView("setup");
      await loadDirectory();
      setNotice(t("saved"));
    } catch (failure) {
      // 明确的 4xx 表示未执行；其他失败保留冻结命令供原样重试。
      if (failure instanceof ApiRequestError && failure.status >= 400 && failure.status < 500) update({ command: null });
      setError(failure instanceof Error ? failure.message : t("failed"));
    } finally { lock.current = false; setBusy(null); }
  };

  const refresh = async () => {
    if (lock.current || draft.command) return;
    if (draft.content && draft.basis && !(await confirmDialog({ title: t("refresh"), message: t("confirmRefresh"), confirmLabel: t("refreshConfirm") }))) return;
    setError("");
    try {
      const rows = await loadDirectory();
      const byId = new Map(rows.map((row) => [row.chapter_id, row]));
      const basis = {
        expected_tail_id: rows.at(-1)?.chapter_id ?? null, expected_tail_version: rows.at(-1)?.version ?? null,
        sources: draft.selected.filter((id) => byId.has(id)).map((id) => ({ chapter_id: id, version: byId.get(id)!.version })),
      };
      update({ basis, selected: draft.selected.filter((id) => byId.has(id)) });
      setNotice(t("refreshed"));
    } catch (failure) { setError((failure as Error).message); }
  };

  const exportDraft = () => {
    const blob = new Blob([JSON.stringify(draft, null, 2)], { type: "application/json;charset=utf-8" });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "continuation-draft.json";
    downloadExport(link); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };

  const agentRunning = busy === "write" || busy === "revise";
  const agentView = view === "agent";
  // 运行结束（或打开时只有上次的记录）后顶部进度收成一行，下面的过程记录和正文随之加高。
  const agentSettled = agentView && !agentRunning && Boolean(draft.runOutcome || draft.reviewLog || trace.length);
  const chapterLabel = draft.title.trim() || t("defaultTitle", { number: chapters.length + 1 });
  const modelLabel = draft.writeModel.model ? [draft.writeModel.provider, draft.writeModel.model].filter(Boolean).join(" / ") : "";
  const writeLabel = t(draft.content ? "regenerate" : "generate");
  const canWrite = !locked && Boolean(draft.outline.trim() || draft.planOutlineIds.length);
  const adopt = locked ? undefined : (content: string) => update({ content, reviewLog: null });
  // 正文框里的选区：有选中文字时修改意见只用于这一段。
  const trackFocus = (event: { currentTarget: HTMLTextAreaElement }) => {
    const element = event.currentTarget;
    const picked = element.value.slice(element.selectionStart, element.selectionEnd);
    setFocus(picked.trim() ? picked : "");
  };

  return <section ref={sectionRef} data-continuation-workspace data-view={view} className="h-full min-h-0 overflow-y-auto lg:overflow-hidden">
    <div className={`mx-auto flex min-h-0 w-full flex-col gap-4 p-4 pb-12 sm:p-6 lg:h-full lg:p-6 ${agentView ? "max-w-[96rem] lg:gap-3 lg:pt-4" : "max-w-6xl"}`}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className={agentView ? "sr-only" : ""}><p className="mb-1 text-sm text-muted">{novelTitle}</p><h1 className="glow-text text-xl font-semibold">{t("title")}</h1><p className="mt-1 text-sm text-muted">{t("description")}</p></div>
        <div className={`flex flex-wrap items-center gap-2 ${agentView ? "w-full justify-between" : ""}`}>
          <div role="tablist" aria-label={zh ? "续写视图" : "Continuation view"} className="aw-switch">
            <button type="button" role="tab" aria-selected={!agentView} onClick={() => setView("setup")}>{zh ? "续写设置" : "Setup"}</button>
            <button type="button" role="tab" aria-selected={agentView} data-testid="agent-view-tab" onClick={openAgent}>{agentRunning && <span aria-hidden="true" className="aw-switch-dot" />}{zh ? "智能体工作台" : "Agent workbench"}{trace.length > 0 && <span className="aw-switch-count">{trace.filter((item) => item.kind !== "usage" && item.kind !== "plan" && item.kind !== "live").length}</span>}</button>
          </div>
          <Button size="sm" variant="ghost" onPress={exportDraft}>{t("export")}</Button>
        </div>
      </header>
      {error && <p role="alert" className="rounded-xl border border-danger/30 p-3 text-sm text-danger">{error}</p>}
      {storageError && <p role="alert" className="text-sm text-danger">{storageError}</p>}
      {notice && <p role="status" className="text-sm text-accent">{notice}</p>}
      {answer && <section data-testid="continuation-answer" aria-label={zh ? "智能体的回答" : "Answer"} className="space-y-2 rounded-xl border border-accent/40 bg-accent/5 p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-fill font-medium">{zh ? "智能体的回答（没有改动正文）" : "Answer (text unchanged)"}</h3><button type="button" className="text-xs text-accent" onClick={() => setAnswer("")}>{zh ? "收起" : "Dismiss"}</button></div>
        <p className="whitespace-pre-wrap leading-7">{answer}</p>
      </section>}
      {bookReport && <section data-testid="continuation-book-report" className="space-y-2 rounded-xl border border-accent/40 p-3 text-sm"><h3 className="font-medium">{zh ? "本书修改结果" : "Book edit report"}</h3><p className="whitespace-pre-wrap leading-7">{bookReport}</p><button type="button" className="text-xs text-accent" onClick={() => setBookReport("")}>{zh ? "收起" : "Dismiss"}</button></section>}
      <BookDocumentChanges novelId={novelId} changes={bookChanges} busy={Boolean(busy)} />
      {loading ? <p role="status">{t("loading")}</p> : !ready ? <Button onPress={() => window.location.reload()}>{t("retry")}</Button> : <>
      {agentView && <AgentConsoleBar items={trace} running={agentRunning} status={progress} outcome={draft.runOutcome ?? null} reviewLog={draft.reviewLog}
        kicker={novelTitle} title={busy === "revise" ? (zh ? `按意见修改 · ${chapterLabel}` : `Revising · ${chapterLabel}`) : chapterLabel} model={modelLabel}
        onBack={() => setView("setup")} onStop={() => controller.current?.abort()}
        action={<Button size="sm" variant="primary" isDisabled={!canWrite} onPress={() => void generate("write")}>{writeLabel}</Button>} />}
      <div className={`grid min-h-0 min-w-0 flex-1 items-start gap-6 lg:overflow-hidden ${agentView ? "lg:items-stretch lg:gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]" : "lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]"}`}>
        {agentView && <div className={`aw-enter flex min-h-0 min-w-0 flex-col lg:h-full ${agentSettled ? "max-lg:max-h-[85dvh]" : "max-lg:max-h-[70dvh]"}`}>
          <AgentTimeline items={trace} running={agentRunning} outcome={draft.runOutcome ?? null} reviewLog={draft.reviewLog} startedAt={draft.runStartedAt} onAdopt={adopt} />
        </div>}
        <div data-testid="continuation-settings-scroll" hidden={agentView} className="min-h-0 min-w-0 space-y-6 lg:h-full lg:overflow-y-auto lg:overscroll-contain lg:pr-2">
          <section className="space-y-4 rounded-2xl border border-border bg-surface p-4 sm:p-5" aria-label={t("contextTitle")}>
            <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">{t("contextTitle")}</h2><Button size="sm" variant="ghost" isDisabled={locked} onPress={() => void refresh()}>{t("refresh")}</Button></div>
            <p className="text-xs leading-5 text-muted">{t("contextHelp")}</p>
            <button type="button" className="flex min-h-10 w-full items-center justify-between gap-2 text-left text-sm text-accent" aria-expanded={listOpen} onClick={() => setListOpen(!listOpen)}>{t("selected", { count: selectedCount })}<span aria-hidden="true">{listOpen ? "−" : "+"}</span></button>
            {listOpen && <div className="space-y-2">
              <div className="flex flex-wrap gap-2"><Button size="sm" variant="ghost" isDisabled={locked} onPress={() => update({ selected: chapters.filter((row) => row.word_count > 0).slice(-3).map((row) => row.chapter_id!) })}>{t("recent")}</Button><Button size="sm" variant="ghost" isDisabled={locked} onPress={() => update({ selected: [] })}>{t("clearSelection")}</Button></div>
              <div className="max-h-80 space-y-2 overflow-y-auto">{chapters.map((row) => <div key={row.chapter_id} data-context-chapter={row.chapter_id} className="rounded-lg border border-border p-2 text-sm">
                <label className="flex cursor-pointer items-start gap-2"><input type="checkbox" className="mt-1" disabled={locked || (!draft.selected.includes(row.chapter_id!) && selectedCount >= 100)} checked={draft.selected.includes(row.chapter_id!)} onChange={(event) => update({ selected: event.target.checked ? [...draft.selected, row.chapter_id!] : draft.selected.filter((id) => id !== row.chapter_id) })} /><span className="min-w-0 break-words">{row.chapter_number}. {row.title}<span className="ml-2 text-xs text-muted">{row.word_count} {t("characters")}</span></span></label>
                <div className="mt-2 flex flex-wrap items-center gap-4 pl-6">{(["original", "summary"] as const).map((mode) => <label key={mode} className="flex items-center gap-1 text-xs"><input type="radio" name={`chapter-context-${row.chapter_id}`} value={mode} disabled={locked || !draft.selected.includes(row.chapter_id!)} checked={(draft.chapterModes[row.chapter_id!] ?? "original") === mode} onChange={() => setChapterMode(row, mode)} />{t(mode)}</label>)}<button type="button" className="min-h-8 text-xs text-accent" disabled={locked} onClick={() => { setSelectSummaryOnSave(false); setSummaryChapter(row); }}>{t("editChapterSummary")}{row.summary.trim() ? " ✓" : ""}</button></div>
              </div>)}{!chapters.length && <p className="text-sm text-muted">{t("empty")}</p>}</div>
            </div>}
          </section>
          <section className="space-y-4 rounded-2xl border border-border bg-surface p-4 sm:p-5" aria-label={t("outlineTitle")}>
            <h2 className="font-semibold">{t("outlineTitle")}</h2>
            <ModelPicker value={draft.writeModel} onChange={(writeModel) => update({ writeModel })} disabled={locked} />
            <EffortSelect value={draft.reasoningEffort} onChange={(reasoningEffort) => update({ reasoningEffort })} provider={draft.writeModel.provider} disabled={locked} />
            <WorkflowPicker novelId={novelId} value={draft.workflow} onChange={(workflow) => update({ workflow })} disabled={locked} testId="continuation-workflow" />
            <label className="grid gap-2 text-sm"><span>{t("chapterTitle")}</span><input data-testid="continuation-title" className={CONTROL} value={draft.title} disabled={locked} placeholder={t("titlePlaceholder")} onChange={(event) => update({ title: event.target.value })} /></label>
            <div className="space-y-2 rounded-xl border border-border p-3" data-testid="plan-outline">
              <button type="button" className="flex min-h-10 w-full items-center justify-between gap-2 text-left text-sm text-accent" aria-expanded={outlineOpen} onClick={() => setOutlineOpen(!outlineOpen)}>
                <span>{zh ? `关联本书大纲（已选 ${draft.planOutlineIds.length} 章）` : `Link book outline (${draft.planOutlineIds.length} selected)`}{planTitles ? <span className="ml-2 text-xs text-muted">{planTitles}</span> : null}</span><span aria-hidden="true">{outlineOpen ? "−" : "+"}</span>
              </button>
              <p className="text-xs leading-5 text-muted">{zh ? "勾选本章要写的章纲，AI 直接按它续写，不用再复制到下面。只发送勾选的前文与章纲。保存后保留勾选项，不自动关联其他章节。" : "Only selected chapters and outlines are linked. Saving preserves your selections without adding other chapters."}</p>
              {outlineOpen && (outlineRows.length ? <>
                <input aria-label={zh ? "搜索大纲章节" : "Search outline"} className={CONTROL} value={outlineQuery} placeholder={zh ? "搜索章纲标题" : "Search titles"} onChange={(e) => setOutlineQuery(e.target.value)} />
                <div className="flex flex-wrap gap-2"><Button size="sm" variant="ghost" isDisabled={locked || !draft.planOutlineIds.length} onPress={() => update({ planOutlineIds: [] })}>{t("clearSelection")}</Button></div>
                <div className="max-h-64 space-y-1 overflow-y-auto">{outlineRows.map((row, index) => ({ row, position: index + 1 })).filter(({ row, position }) => !outlineQuery.trim() || row.title.includes(outlineQuery.trim()) || String(position) === outlineQuery.trim()).slice(0, 200).map(({ row, position }) => <label key={row.id} data-plan-outline={row.id} className="flex cursor-pointer items-start gap-2 rounded-lg p-1.5 text-sm hover:bg-accent/5">
                  <input type="checkbox" className="mt-1" disabled={locked || (!draft.planOutlineIds.includes(row.id) && draft.planOutlineIds.length >= 100)} checked={draft.planOutlineIds.includes(row.id)} onChange={(e) => update({ planOutlineIds: e.target.checked ? outlineRows.map((item) => item.id).filter((id) => id === row.id || draft.planOutlineIds.includes(id)) : draft.planOutlineIds.filter((id) => id !== row.id) })} />
                  <span className="min-w-0 break-words">{position}. {row.title}<span className="ml-2 text-xs text-muted">{row.word_count} {t("characters")}</span></span>
                </label>)}</div>
              </> : <p className="text-xs text-muted">{zh ? "本书还没有大纲。可在“本书大纲”页导入或新建章纲。" : "No outline yet. Add it on the Book outline page."}</p>)}
            </div>
            <label className="grid gap-2 text-sm"><span>{draft.planOutlineIds.length ? (zh ? "补充要求（可选，会和关联的大纲一起发送）" : "Extra requirements (optional)") : t("outlineLabel")}</span><textarea ref={outlineRef} data-testid="continuation-outline" onKeyDown={(event) => { if (isSubmitShortcut(event) && !locked && (draft.outline.trim() || draft.planOutlineIds.length)) { event.preventDefault(); void generate("write"); } }} rows={7} className={`${CONTROL} resize-y leading-7`} value={draft.outline} disabled={locked} placeholder={t("outlinePlaceholder")} onChange={(event) => update({ outline: event.target.value })} /></label>
            <TextFindReplace textareaRef={outlineRef} value={draft.outline} onChange={(outline) => update({ outline })} disabled={locked} />
            <div className="flex flex-wrap items-center gap-3"><SelectionAgentButton novelId={novelId} target="outline" workflow={draft.workflow} initialLinked={linkedContext} textareaRef={outlineRef} value={draft.outline} onReplace={(outline) => update({ outline })} disabled={locked || !draft.outline.trim()} /></div>
            <details className="space-y-3"><summary className="cursor-pointer text-sm">{t("reviewTitle")}</summary><div className="mt-3"><ReviewModeControls rounds={draft.reviewRounds} untilPass={draft.reviewUntilPass} disabled={locked} label={t("reviewRounds")} ariaLabel={t("reviewRounds")} selectClassName={CONTROL} wrapperClassName="grid gap-2 text-sm"
              onChange={(patch) => update({ ...(patch.rounds !== undefined ? { reviewRounds: patch.rounds } : {}), ...(patch.untilPass !== undefined ? { reviewUntilPass: patch.untilPass } : {}) })} /><div className="mt-2"><DeslopToggle checked={draft.deslop} disabled={locked} onChange={(deslop) => update({ deslop })} /></div></div><p className="text-xs text-muted">{t("reviewHelp")}</p><textarea aria-label={t("reviewRequirements")} className={CONTROL} rows={3} value={draft.reviewRequirements} disabled={locked} placeholder={t("reviewRequirements")} onChange={(e) => update({ reviewRequirements: e.target.value })} /></details>
            <div className="flex flex-wrap items-end justify-between gap-3"><label className="grid gap-2 text-sm"><span>{t("words")}</span><input type="number" min={1} className={CONTROL} value={draft.words ?? ""} disabled={locked} placeholder={locale === "en" ? "As the story needs" : "留空按剧情自然展开"} onChange={(event) => update({ words: event.target.value ? Number(event.target.value) : null })} /></label><Button variant="primary" isDisabled={locked || !(draft.outline.trim() || draft.planOutlineIds.length)} onPress={() => void generate("write")}>{t(draft.content ? "regenerate" : "generate")}</Button></div>
          </section>
          <ReferenceBooksPicker novelId={novelId} value={draft.reference_books ?? []} onChange={(reference_books) => update({ reference_books })} disabled={Boolean(busy)} />
          <details className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
            <summary className="cursor-pointer text-sm font-medium">{zh ? "写作偏好（智能体按任务自动查阅）" : "Writing preferences (selected automatically)"}</summary>
            <p className="mt-2 text-xs leading-5 text-muted">{zh ? "直接在右侧提出修改意见，智能体会提炼可复用的简短偏好。这里可以编辑、停用或删除。当前要求优先于旧规则。" : "Give feedback beside the draft. Reusable preferences are remembered automatically; you can edit or remove them here."}</p>
            <MemoryPanel novelId={novelId} refreshKey={memoryRevision} />
          </details>
          <details className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
            <summary className="cursor-pointer text-sm font-medium">{zh ? "给智能体的意见与经验" : "Agent feedback and lessons"}</summary>
            <div className="mt-2"><FeedbackNotesPanel novelId={novelId} /></div>
          </details>
          <details className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
            <summary className="cursor-pointer text-sm font-medium">{t("materialsTitle")}</summary>
            <div className="mt-4 space-y-3"><p className="text-xs leading-5 text-muted">{t("materialsHelp")}</p><ModelPicker value={draft.materialsModel} onChange={(materialsModel) => update({ materialsModel })} disabled={locked} /><Button size="sm" variant="secondary" isDisabled={locked || (!selectedCount && !draft.outline.trim() && !draft.planOutlineIds.length)} onPress={() => void generate("materials")}>{t("generateMaterials")}</Button><textarea aria-label={t("materialsTitle")} className={`${CONTROL} resize-y leading-6`} rows={8} value={draft.materials} disabled={locked} placeholder={t("materialsPlaceholder")} onChange={(event) => update({ materials: event.target.value })} /></div>
          </details>
        </div>
        <section data-testid="continuation-draft-scroll" className={`${agentView ? "aw-enter aw-frame" : "rounded-2xl border border-border bg-surface"} flex min-h-0 min-w-0 flex-col gap-4 p-4 sm:p-5 lg:h-full lg:overflow-y-auto lg:overscroll-contain`} aria-label={t("bodyTitle")}>
          <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">{agentView ? <><span className="aw-kicker mr-2">LIVE OUTPUT</span>{zh ? "正文输出" : "Draft output"}</> : t("bodyTitle")}</h2><div className="flex flex-wrap items-center gap-3"><Button size="sm" variant="ghost" data-testid="continuation-full-text" isDisabled={!draft.content} onPress={() => setFullText(true)}>{zh ? "全屏阅读" : "Full screen"}</Button><SelectionAgentButton testId="agent-open-content" novelId={novelId} target="chapter" workflow={draft.workflow} initialLinked={linkedContext} textareaRef={contentRef} value={draft.content} onReplace={(content) => update({ content, reviewLog: null })} disabled={locked || !draft.content.trim()} /><span className="font-mono text-xs text-muted tabular-nums">{draft.content.replace(/\s/g, "").length} {t("characters")}</span></div></div>
          <TextFindReplace textareaRef={contentRef} value={draft.content} onChange={(content) => update({ content, reviewLog: null })} disabled={locked} />
          <textarea ref={contentRef} data-testid="continuation-content" aria-label={t("bodyTitle")} className={`${CONTROL} ${agentSettled ? "h-[78dvh] min-h-[32rem] lg:h-auto lg:min-h-[30rem] lg:flex-1 lg:resize-none" : "h-[62dvh] min-h-72 resize-y"} shrink-0 overscroll-contain leading-8 ${agentRunning ? "aw-streaming" : ""}`} value={draft.content} disabled={locked}
            onSelect={trackFocus} onMouseUp={trackFocus} onKeyUp={trackFocus}
            onScroll={(event) => { const element = event.currentTarget; followContent.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60; }} placeholder={agentView && agentRunning ? (zh ? "智能体正在查资料和规划，正文开始起草后会实时出现在这里…" : "The draft appears here as soon as the agent starts writing…") : t("bodyPlaceholder")} onChange={(event) => update({ content: event.target.value, reviewLog: null })} />
          {fullText && <FullTextDialog title={chapterLabel} value={draft.content} streaming={agentRunning} onChange={locked ? undefined : (content) => update({ content, reviewLog: null })} onClose={() => setFullText(false)} areaRef={fullRef}
            tools={!locked && draft.content.trim() ? <SelectionAgentButton testId="full-text-agent" novelId={novelId} target="chapter" workflow={draft.workflow} initialLinked={linkedContext} textareaRef={fullRef} value={draft.content} onReplace={(content) => update({ content, reviewLog: null })} /> : null} />}
          {agentRunning && <p role="status" className="text-xs text-muted">{zh ? "可以切到其他界面，任务会继续运行。完整稿会保留在这里。" : "You can switch pages while this task continues. The draft stays here."}</p>}
          {busy && <div role="status" className="flex flex-wrap items-center gap-3 text-sm text-muted"><span>{t(busy === "save" ? "saving" : "generating")}</span>{busy !== "save" && !agentView && <Button size="sm" variant="danger-soft" onPress={() => controller.current?.abort()}>{t("stop")}</Button>}</div>}
          {progress && !agentRunning && <p role="status" className="text-sm text-muted">{progress}</p>}
          {memoryProposals.length > 0 && <MemoryProposalPrompt novelId={novelId} proposals={memoryProposals} onSaved={() => setMemoryRevision((value) => value + 1)} />}
          {!agentView && <AgentRunCard items={trace} running={agentRunning} outcome={draft.runOutcome ?? null} reviewLog={draft.reviewLog} status={progress} onOpen={openAgent} />}
          <section aria-label={zh ? "继续修改" : "Continue revising"} className="space-y-3 border-t border-border pt-3">
            {draft.conversation.length > 0 && <details><summary className="cursor-pointer text-xs text-muted">{zh ? `修改对话 · ${draft.conversation.length} 轮` : `Revision conversation · ${draft.conversation.length}`}</summary><ol className="mt-2 max-h-36 space-y-2 overflow-y-auto text-sm">{draft.conversation.map((item, index) => <li key={index}>{index + 1}. {item.feedback}</li>)}</ol><Button size="sm" variant="ghost" isDisabled={locked} onPress={() => update({ content: draft.conversation.at(-1)!.text, conversation: draft.conversation.slice(0, -1), reviewLog: null })}>{zh ? "撤回上一轮修改" : "Undo last revision"}</Button></details>}
            <textarea data-testid="continuation-feedback" aria-label={zh ? "修改意见" : "Revision feedback"} className={`${CONTROL} resize-y leading-6`} rows={3} value={draft.feedback} disabled={locked} onKeyDown={(event) => { if (isSubmitShortcut(event) && !locked && draft.content.trim() && draft.feedback.trim()) { event.preventDefault(); void revise(); } }} placeholder={zh ? "写下要怎么改这一稿" : "Describe what to change in this draft…"} onChange={(event) => update({ feedback: event.target.value })} />
            <div className="flex flex-wrap items-center gap-3">
              <Button data-testid="continuation-revise" variant="secondary" isDisabled={locked || !draft.content.trim() || !draft.feedback.trim()} onPress={() => void revise()}>{focus && draft.content.includes(focus) ? (zh ? "只改选中的一段" : "Revise the selection") : (zh ? "按意见继续修改" : "Revise with feedback")}</Button>
              <Button data-testid="continuation-agent-feedback" variant="ghost" isDisabled={locked || !draft.content.trim() || !draft.feedback.trim()} onPress={() => void revise(true)}>{zh ? "给智能体提意见" : "Give the agent feedback"}</Button>
              {focus && draft.content.includes(focus) ? <span data-testid="continuation-focus" className="flex items-center gap-2 text-xs text-muted">{zh ? `已在正文里选中 ${focus.replace(/\s/g, "").length} 字，意见只用于这一段` : `${focus.length} chars selected; feedback applies to them only`}<button type="button" className="text-accent" onClick={() => setFocus("")}>{zh ? "改为全文" : "Whole draft"}</button></span>
                : <span className="text-xs text-muted">{zh ? "“按意见继续修改”只改这一稿；“给智能体提意见”也会照意见改，同时在下方提出一条写作偏好草案，你确认或调整方向后才保存。想只改某一段，先在正文框里选中它。" : "Each revision builds on the last one. “Give the agent feedback” also proposes a writing preference below, saved only after you confirm it. Select text above to revise only that part."}</span>}
            </div>
            {pendingFeedback && <FeedbackPreferenceDraft novelId={novelId} feedback={pendingFeedback} model={draft.writeModel} onChanged={() => setMemoryRevision((value) => value + 1)} />}
          </section>
          <p className="text-xs leading-5 text-muted">{t("saveHelp")}</p>
          {draft.command && !busy && <p role="status" className="text-sm text-muted">{t("pendingSave")}</p>}
          <div className="flex flex-wrap items-center gap-3"><Button variant="primary" isDisabled={Boolean(busy) || !draft.content.trim()} onPress={() => void save()}>{t(draft.command ? "retrySave" : "save")}</Button><span className="text-xs text-muted">{t("localDraft")}</span></div>
        </section>
      </div>
      </>}
      {missingSummary && <ConfirmActionModal title={t("missingSummaryTitle")} message={t("missingSummaryMessage", { title: missingSummary.title })} confirmText={t("openSummaryEditor")} cancelText={t("cancelSummary")} onCancel={() => setMissingSummary(null)} onConfirm={() => { setSelectSummaryOnSave(true); setSummaryChapter(missingSummary); setMissingSummary(null); }} />}
      {summaryChapter && <ChapterSummaryDialog key={summaryChapter.chapter_id} chapter={summaryChapter} autoGenerate={!summaryChapter.summary.trim()} onClose={() => setSummaryChapter(null)} onSaved={(saved) => {
        setChapters((rows) => rows.map((row) => row.chapter_id === saved.chapter_id ? saved : row));
        if (!saved.summary.trim() && liveDraft.current.chapterModes[saved.chapter_id!] === "summary") update({ chapterModes: { ...liveDraft.current.chapterModes, [saved.chapter_id!]: "original" } });
        else if (selectSummaryOnSave && saved.summary.trim()) update({ chapterModes: { ...liveDraft.current.chapterModes, [saved.chapter_id!]: "summary" } });
      }} />}
    </div>
  </section>;
}
