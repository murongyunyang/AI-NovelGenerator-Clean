"use client";

import { useContext, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Button } from "@heroui/react";
import { useLocale } from "next-intl";
import { RetainedViewActive } from "@/components/layout/RetainedViews";
import { ModelPicker, type ModelChoice } from "@/components/shared/ModelPicker";
import { apiDelete, apiGet, apiPatch, apiPost, apiPostSSE, apiPut } from "@/lib/api";
import { AgentTrace, candidateFromEvent, settleTrace, traceReducer, type TraceItem } from "./AgentTrace";
import { agentRequestOptions, DeslopToggle, effortFrom, EffortSelect, isSubmitShortcut, ReviewModeControls, untilPassFrom } from "./AgentSettings";
import { WorkflowPicker, workflowId, type WorkflowId } from "./WorkflowPicker";
import { FeedbackPreferenceDraft, PreferenceReviser, type PendingFeedback } from "./AgentFeedback";

import { ReferenceBooksPicker, type BookReference } from "./ReferenceBooksPicker";
import { readSelectionDraft, selectionDraftKey } from "@/lib/selectionDraft";
import { hitLabel, useKeywordHits } from "./keywordSearch";
import { BookDocumentChanges, publishBookDocumentChange, type BookDocumentChange } from "./BookDocumentChanges";

type Target = "chapter" | "outline";
const MEMORY_CATEGORIES = ["style", "punctuation", "dialogue", "scene", "logic", "outline", "workflow", "setting", "other"] as const;
export type MemoryCategory = typeof MEMORY_CATEGORIES[number];
const CATEGORY_NAMES: Record<MemoryCategory, [string, string]> = {
  style: ["文风措辞", "Style"], punctuation: ["标点与段落", "Punctuation"], dialogue: ["对白", "Dialogue"], scene: ["场景与转场", "Scenes"],
  logic: ["信息与逻辑", "Logic"], outline: ["大纲写法", "Outlines"], workflow: ["审稿与改稿", "Review"], setting: ["本书设定", "Book setting"], other: ["其他", "Other"],
};
const categoryName = (key: MemoryCategory, zh: boolean) => CATEGORY_NAMES[key][zh ? 0 : 1];
interface Memory { source_novel_id?: string | null; source_novel_title?: string; linked?: boolean; plot_specific?: boolean; id: string; scope: "global" | "novel"; title: string; text: string; enabled: boolean; source: "manual" | "learned" | "claude_code" | "feedback"; category?: MemoryCategory }
interface ReviewLog { passed: boolean | null; stopped_reason: string; mode?: "agent"; steps?: string[]; rounds: { round: number; score: number; summary: string; revised: boolean; issues: { problem: string; suggestion: string }[] }[] }
interface Selection { start: number; end: number; text: string; before: string; after: string }
interface Attempt { text: string; feedback: string }
interface Settings { choice: ModelChoice; rounds: number; useMemory: boolean; learn: boolean; workflow: WorkflowId; effort: string; untilPass: boolean; deslop: boolean; outlineSync: boolean }
export interface Accepted { instruction: string; feedback: string[]; original: string; final: string; settings: Settings; skipLearn?: boolean }
interface OutlineRequest { id: string; title: string; position: number }
interface OutlineChange { outline_id: string; title: string; before_version: number; version: number; note: string; restored?: boolean }
type LinkMode = "original" | "summary";
interface Linked { reference_books?: BookReference[]; chapters: { chapter_id: string; mode: LinkMode }[]; outline_ids: string[]; free_lookup: boolean }
interface ChapterRow { chapter_id?: string; chapter_number?: number; title: string; summary: string; word_count?: number }
interface OutlineRow { id: string; title: string; word_count: number }
const NO_LINKS: Linked = { chapters: [], outline_ids: [], free_lookup: false };
const linkKey = (novelId: string) => `writing-agent:linked:${novelId}`;

function readLinked(novelId: string): Linked {
  try {
    const saved = JSON.parse(localStorage.getItem(linkKey(novelId)) ?? "null");
    if (!saved || !Array.isArray(saved.chapters) || !Array.isArray(saved.outline_ids)) return NO_LINKS;
    return { reference_books: saved.reference_books ?? [], chapters: saved.chapters, outline_ids: saved.outline_ids, free_lookup: saved.free_lookup === true };
  } catch { return NO_LINKS; }
}

function saveLinked(novelId: string, value: Linked) {
  try { localStorage.setItem(linkKey(novelId), JSON.stringify(value)); } catch { /* 只是记住上次勾选 */ }
}
export interface MemoryProposal {
  id?: string; text: string; title?: string; scope: "global" | "novel"; category?: MemoryCategory;
  memory_id?: string | null; source_quote?: string; feedback?: string; source: "learned" | "feedback";
}

const SETTINGS_KEY = "writing-agent:settings";
const DEFAULTS: Settings = { choice: { provider: "", model: "" }, rounds: 2, useMemory: true, learn: true, workflow: "auto", effort: "", untilPass: true, deslop: false, outlineSync: false };
const CONTEXT_BEFORE = 3000;
const CONTEXT_AFTER = 1500;
const CONTROL = "w-full min-w-0 rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-accent disabled:opacity-60";

/** 修改稿相对原文的字数变化，例如“比原文多 12 字”。 */
function lengthDelta(delta: number, zh: boolean): string {
  if (!delta) return zh ? "与原文字数相同" : "same length";
  return zh ? `比原文${delta > 0 ? "多" : "少"} ${Math.abs(delta)} 字` : `${delta > 0 ? "+" : "−"}${Math.abs(delta)} vs original`;
}

function readSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    const rounds = typeof saved.rounds === "number" ? saved.rounds : DEFAULTS.rounds;
    return { ...DEFAULTS, ...saved, rounds, workflow: workflowId(saved.workflow), effort: effortFrom(saved.effort), untilPass: untilPassFrom(saved.untilPass, rounds), deslop: saved.deslop === true, outlineSync: saved.outlineSync === true };
  } catch { return DEFAULTS; }
}

function saveSettings(value: Settings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(value)); } catch { /* 只是记住上次的选择，失败不影响修改 */ }
}

/** 采用修改稿后总结通用写作偏好（保存前询问作者）。修改过程中已经按每条要求整理过偏好、作者又没有手改时不再重复提炼，省一次模型调用。 */
export async function learnFromAccepted(novelId: string, target: Target, result: Accepted): Promise<MemoryProposal[]> {
  if (!result.settings.learn || result.skipLearn || !(result.instruction.trim() || result.feedback.length)) return [];
  try {
    return (await apiPost<{ proposals: MemoryProposal[] }>(`/api/novels/${novelId}/writing-agent/memories/learn`, {
      target, original: result.original, final: result.final, instruction: result.instruction, feedback: result.feedback, ...result.settings.choice,
    })).proposals;
  } catch { return []; /* 偏好总结失败不影响已采用的文字 */ }
}

/** 选段旁的“AI 修改选段”入口：读取文本框当前选区，打开写作智能体小窗，采用后替换原选区并在后台总结写作偏好。 */
export function SelectionAgentButton({ novelId, target, textareaRef, value, onReplace, onReplaceAndSave, disabled = false, testId, workflow, label, onOpenChange, initialLinked, sourceId }: {
  novelId: string; target: Target; textareaRef: RefObject<HTMLTextAreaElement | null>; value: string;
  onReplace: (next: string) => void; onReplaceAndSave?: (next: string) => void | Promise<void>; disabled?: boolean; testId?: string; workflow?: WorkflowId; label?: string; onOpenChange?: (open: boolean) => void; initialLinked?: Linked; sourceId?: string;
}) {
  const zh = useLocale() !== "en";
  const [selection, setSelection] = useState<Selection | null>(null);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [proposals, setProposals] = useState<MemoryProposal[]>([]);

  const openAgent = () => {
    const area = textareaRef.current;
    const start = area?.selectionStart ?? 0;
    const end = area?.selectionEnd ?? 0;
    const text = value.slice(start, end);
    setSelection(text.trim() ? { start, end, text, before: value.slice(Math.max(0, start - CONTEXT_BEFORE), start), after: value.slice(end, end + CONTEXT_AFTER) } : null);
    setNotice(""); setProposals([]); setOpen(true); onOpenChange?.(true);
  };

  const accept = (result: Accepted, andSave = false) => {
    if (!selection) return;
    // 小窗打开期间原文不能编辑；仍核对一次位置，原文被外部改动时按唯一匹配定位，找不到就不替换。
    let start = selection.start;
    if (value.slice(start, selection.end) !== selection.text) {
      const first = value.indexOf(selection.text);
      if (first < 0 || value.indexOf(selection.text, first + 1) >= 0) { setNotice(zh ? "原文已变化，无法定位选段，未替换。" : "The text changed; the selection could not be located."); setOpen(false); onOpenChange?.(false); return; }
      start = first;
    }
    const next = value.slice(0, start) + result.final + value.slice(start + selection.text.length);
    const saving = andSave && onReplaceAndSave;
    if (saving) void onReplaceAndSave(next); else onReplace(next);
    setOpen(false); onOpenChange?.(false);
    setNotice(saving ? (zh ? "已替换选段。" : "Selection replaced.") : (zh ? "已替换选段，记得保存。" : "Selection replaced. Remember to save."));
    requestAnimationFrame(() => { const area = textareaRef.current; area?.focus(); area?.setSelectionRange(start, start + result.final.length); });
    void learnFromAccepted(novelId, target, result).then((found) => { if (found.length) setProposals((current) => [...current, ...found]); });
  };

  return <>
    <Button size="sm" variant="secondary" data-testid={testId} isDisabled={disabled} onPress={openAgent}>{label ?? (zh ? "AI 修改选段" : "AI edit selection")}</Button>
    {notice && <span role="status" className="text-xs text-accent">{notice}</span>}
    {proposals.length > 0 && <MemoryProposalPrompt novelId={novelId} proposals={proposals} />}
    {open && <SelectionAgentDialog novelId={novelId} target={target} sourceId={sourceId} selection={selection} initialWorkflow={workflow} initialLinked={initialLinked} onAccept={accept} onAcceptAndSave={onReplaceAndSave ? (result) => accept(result, true) : undefined} onClose={() => { setOpen(false); onOpenChange?.(false); }} />}
  </>;
}

/** 写作智能体小窗：按要求修改 → 自我审查 → 不满意可提意见再改，满意一键替换。 */
export function SelectionAgentDialog({ novelId, target, selection, onAccept, onAcceptAndSave, onClose, initialWorkflow, initialLinked, inline = false, acceptLabel, onBusyChange, sourceId }: {
  novelId: string; target: Target; selection: Selection | null; onAccept: (result: Accepted) => void; onAcceptAndSave?: (result: Accepted) => void; onClose: () => void; initialWorkflow?: WorkflowId; initialLinked?: Linked; inline?: boolean; acceptLabel?: string; onBusyChange?: (busy: boolean) => void; sourceId?: string;
}) {
  const zh = useLocale() !== "en";
  const active = useContext(RetainedViewActive);
  const [settings, setSettings] = useState<Settings>(() => ({ ...readSettings(), ...(initialWorkflow ? { workflow: initialWorkflow } : {}) }));
  const [linked, setLinked] = useState<Linked>(() => initialLinked ?? readLinked(novelId));
  const updateLinked = (next: Linked) => { setLinked(next); saveLinked(novelId, next); };
  const draftKey = selectionDraftKey(novelId, target, selection?.text ?? "");
  const [instruction, setInstruction] = useState(() => readSelectionDraft(draftKey, selection?.text ?? "").instruction);
  const [candidate, setCandidate] = useState(() => readSelectionDraft(draftKey, selection?.text ?? "").candidate);
  // 是否已生成过修改稿；不能用 candidate 是否为空判断，否则清空修改稿会让追问区连同意见一起消失。
  const [drafted, setDrafted] = useState(false);
  const hasDraft = drafted || Boolean(candidate);
  const [attempts, setAttempts] = useState<Attempt[]>(() => readSelectionDraft(draftKey, selection?.text ?? "").attempts);
  const [feedback, setFeedback] = useState(() => readSelectionDraft(draftKey, selection?.text ?? "").feedback);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [trace, setTrace] = useState<TraceItem[]>([]);
  const [reviewLog, setReviewLog] = useState<ReviewLog | null>(null);
  const [proposals, setProposals] = useState<MemoryProposal[]>([]);
  const [error, setError] = useState("");
  // 作者只是提问时智能体只回答、不改稿：回答单独显示，不进入修改稿和追问记录。
  const [answer, setAnswer] = useState<{ question: string; text: string } | null>(null);
  const [bookChanges, setBookChanges] = useState<BookDocumentChange[]>([]);
  const [bookReport, setBookReport] = useState("");
  // 同步章纲：grants 是作者另外批准的未关联章纲；requests 是智能体提出、等作者答复的申请；changes 是本次已改动的章纲。
  const [grants, setGrants] = useState<string[]>([]);
  const [requests, setRequests] = useState<{ outlines: OutlineRequest[]; reason: string } | null>(null);
  const [changes, setChanges] = useState<OutlineChange[]>([]);
  const [restoring, setRestoring] = useState("");
  // 修改过程中是否已按要求整理过偏好、作者是否手改过修改稿：决定采用后要不要再提炼一次偏好。
  const distilled = useRef(false);
  const handEdited = useRef(false);
  useEffect(() => {
    try { localStorage.setItem(draftKey, JSON.stringify({ selection: selection?.text ?? "", instruction, feedback, candidate, attempts })); }
    catch { setError(zh ? "本地草稿保存失败，请先复制提示词。" : "Draft could not be saved locally. Please copy your prompt."); }
  }, [draftKey, selection?.text, instruction, feedback, candidate, attempts, zh]);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  const [memoryOpen, setMemoryOpen] = useState(false);
  // 追问时只改修改稿里选中的一段；wide 把原文和修改稿放大，方便读长段落。
  const [focus, setFocus] = useState("");
  const [wide, setWide] = useState(false);
  // undefined：这一轮没提意见；null：意见没能存成偏好。
  const [pendingFeedback, setPendingFeedback] = useState<PendingFeedback | null>(null);
  const [memoryRevision, setMemoryRevision] = useState(0);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const update = (patch: Partial<Settings>) => setSettings((current) => { const next = { ...current, ...patch }; saveSettings(next); return next; });

  // 作品流实时更新候选；停止或失败保留最新稿，不让审查过程覆盖作品。
  // 追问时在当前修改稿（含作者手改）上接着改：新稿完整到达前，框里一直是当前稿。
  const run = async (history: Attempt[], focusText = "", grantIds = grants) => {
    if (!selection || busy) return;
    const previous = candidate;
    const followUp = history.length > 0;
    setBusy(true); setError(""); setReviewLog(null); setTrace([]); setAnswer(null); setBookReport(""); setRequests(null); setStatus(zh ? "正在提交修改请求、准备关联资料…" : "Submitting revision and preparing context…");
    // 回答或只改其他文档时，原有候选稿保留；收到真实新稿后再替换。
    const controller = new AbortController(); abort.current = controller;
    let received = "";
    let delivered = false;
    let answered = false;
    try {
      await apiPostSSE(`/api/novels/${novelId}/writing-agent/rewrite/stream`, {
        target, selection: selection.text, before: selection.before, after: selection.after, instruction, attempts: history,
        latest_instruction: followUp ? history.at(-1)!.feedback : instruction,
        book_edit: true, source_id: sourceId ?? "",
        draft: followUp ? history.at(-1)!.text : "", focus: focusText, linked,
        ...settings.choice, ...agentRequestOptions(settings), use_memory: settings.useMemory, workflow: settings.workflow,
        ...(target === "chapter" ? { outline_write: settings.outlineSync, outline_grants: grantIds.slice(0, 100) } : {}),
      }, (event, data) => {
        if (event === "book_document_change") {
          const change = data as unknown as BookDocumentChange;
          setBookChanges((current) => [...current, change]);
          publishBookDocumentChange(novelId, change);
        }
        if (event === "outline_request") {
          const asked = data as unknown as { outlines: OutlineRequest[]; reason: string };
          setRequests((current) => ({ outlines: [...(current?.outlines ?? []), ...asked.outlines.filter((item) => !current?.outlines.some((old) => old.id === item.id))], reason: asked.reason }));
        }
        if (event === "outline_change") {
          const change = data as unknown as OutlineChange;
          // 同一章纲改了几次时合并成一条：恢复时回到第一次改动之前。
          setChanges((current) => {
            const old = current.find((item) => item.outline_id === change.outline_id && !item.restored);
            const rest = current.filter((item) => item.outline_id !== change.outline_id);
            return [...rest, old ? { ...change, before_version: old.before_version, note: `${old.note}；${change.note}` } : change];
          });
        }
        if (event === "done" && typeof data.answer === "string" && data.answer) {
          answered = true;
          setAnswer({ question: followUp ? history.at(-1)!.feedback : instruction.trim(), text: data.answer });
        }
        if (event === "done" && typeof data.report === "string" && data.report) { answered = true; setBookReport(data.report); }
        if (event === "progress" && data.message) setStatus(String(data.message));
        if (event === "memory_proposal") setProposals((current) => [...current, data as unknown as MemoryProposal]);
        setTrace((items) => traceReducer(items, event, data, zh));
        const text = candidateFromEvent(received, event, data);
        if (text !== null) {
          received = text;
          // 首次修改边写边显示；追问只在整段新稿到达时替换，半截文字不覆盖当前稿。
          if (!followUp || event !== "delta") { delivered = true; setCandidate(text); setDrafted(true); }
        }
        if (event === "done") setReviewLog(data.review_log as unknown as ReviewLog);
      }, { signal: controller.signal, idleTimeoutMs: 45000, allowedEvents: ["delta", "replacement", "trace", "memory_proposal", "outline_request", "outline_change", "book_document_change"] });
      // 只是回答问题：修改稿和追问记录都不动，问题从输入框里清掉（回答旁边留着原问题）。
      if (answered) { if (followUp) setFeedback(""); }
      else { setAttempts(history); setFeedback(""); setFocus(""); if (settings.useMemory && instruction.trim()) distilled.current = true; }
    } catch (e) {
      if (controller.signal.aborted) setStatus(zh ? "已停止" : "Stopped");
      else setError((e as Error).message);
      if (followUp ? !delivered : !received.trim()) { if (previous) setCandidate(previous); }
      else { setAttempts(history); }
    } finally { setTrace((items) => settleTrace(items)); setBusy(false); abort.current = null; }
  };
  const followUp = (asFeedback = false) => {
    if (!candidate || !feedback.trim() || busy) return;
    const only = focus && candidate.includes(focus) ? focus : "";
    if (asFeedback) {
      // 给智能体提意见：先给出偏好草案和问题，作者确认或调整方向后才保存；修改照常进行。
      setPendingFeedback({ text: feedback.trim(), excerpt: candidate.slice(0, 400), target });
    }
    void run([...attempts, { text: candidate, feedback: (only ? "【只改选中的一段】" : "") + feedback.trim() }], only);
  };
  // 作者同意智能体申请的章纲：记下授权，并在当前稿上接着跑一轮，让它把改动同步过去。
  const grantRequests = () => {
    if (!requests || busy) return;
    const next = [...new Set([...grants, ...requests.outlines.map((item) => item.id)])];
    const names = requests.outlines.map((item) => `「${item.title}」`).join("、");
    setGrants(next); setRequests(null);
    if (candidate.trim()) void run([...attempts, { text: candidate, feedback: `我已授权修改章纲${names}。请把刚才的改动同步到这些章纲；当前稿不需要再改，除非它和章纲仍有矛盾。` }], "", next);
    else setStatus(zh ? "已授权，下次修改时会同步这些章纲。" : "Granted. They will be synced on the next run.");
  };
  const restoreOutline = async (item: OutlineChange) => {
    if (restoring) return;
    setRestoring(item.outline_id); setError("");
    try {
      await apiPost(`/api/novels/${novelId}/outline-chapters/${item.outline_id}/revisions/${item.before_version}/restore`, { expected_version: item.version });
      setChanges((current) => current.map((row) => row.outline_id === item.outline_id ? { ...row, restored: true } : row));
    } catch (e) { setError((zh ? `章纲「${item.title}」没有恢复：` : `Outline “${item.title}” was not restored: `) + (e as Error).message); }
    finally { setRestoring(""); }
  };
  // 撤回上一轮：回到追问前的那一稿。
  const undo = () => {
    const last = attempts.at(-1);
    if (!last || busy) return;
    setCandidate(last.text); setAttempts(attempts.slice(0, -1)); setFeedback((current) => current || last.feedback); setReviewLog(null); setTrace([]); setFocus("");
  };
  const trackFocus = (event: { currentTarget: HTMLTextAreaElement }) => {
    const element = event.currentTarget;
    const picked = element.value.slice(element.selectionStart, element.selectionEnd);
    setFocus(picked.trim() ? picked : "");
  };

  const close = () => { if (busy) abort.current?.abort(); onClose(); };
  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !busy) { event.preventDefault(); onClose(); }
    };
    if (!active || inline) return;
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [active, busy, onClose, inline]);
  const accept = (andSave = false) => {
    if (!selection || !candidate.trim()) return;
    (andSave && onAcceptAndSave ? onAcceptAndSave : onAccept)({ instruction, feedback: attempts.map((item) => item.feedback), original: selection.text, final: candidate, settings,
      skipLearn: distilled.current && !handEdited.current });
  };

  // Ctrl/⌘ + Enter：还没有修改稿时开始修改，已有修改稿且填了意见时按意见再改。
  const shortcut = (event: KeyboardEvent) => {
    if (!isSubmitShortcut(event) || busy || !selection) return;
    event.preventDefault();
    if (!hasDraft) void run([]);
    else followUp();
  };
  const focused = Boolean(focus && candidate.includes(focus));
  const pane = wide || inline ? "h-[56dvh]" : "max-h-72 min-h-40";

  if (!active) return null;
  const content = <div className={inline ? "min-w-0 w-full" : "pointer-events-none fixed inset-x-0 bottom-0 top-14 z-[70] flex items-start justify-center overflow-y-auto p-3 sm:p-5"} data-testid={inline ? "revision-panel" : "selection-agent-layer"}>
    {/* 内嵌到页面时不再自限高度和裁切，整页只有一个滚动条，鼠标停在中间任何位置滚轮都能翻页。 */}
    <section role={inline ? "region" : "dialog"} aria-modal={inline ? undefined : "false"} className={`pointer-events-auto flex w-full flex-col rounded-2xl border border-border bg-background shadow-2xl ${inline ? "min-w-0" : "max-h-full max-w-5xl overflow-hidden"}`} aria-label={zh ? "写作智能体" : "Writing agent"}>
      {!inline && <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5"><h2 className="font-semibold">{zh ? `写作智能体 · 修改${target === "chapter" ? "正文" : "大纲"}选段` : "Writing agent"}</h2><button type="button" className="min-h-8 min-w-8 text-xl text-muted hover:text-foreground" aria-label={zh ? "关闭修改窗口" : "Close writing agent"} onClick={close}>×</button></header>}
      <div className={inline ? "space-y-4 p-4 sm:p-5" : "workspace-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-5"} onKeyDown={shortcut}>
        <section className="rounded-xl border border-border bg-surface p-3" aria-label={zh ? "本次修改的写作偏好" : "Writing preferences for this revision"}>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="agent-use-memory" checked={settings.useMemory} disabled={busy} onChange={(e) => update({ useMemory: e.target.checked })} />{zh ? "本次修改参考已记住的写作偏好" : "Use remembered writing preferences for this revision"}</label>
          <details className="mt-2 text-sm" open={memoryOpen} onToggle={(e) => setMemoryOpen((e.target as HTMLDetailsElement).open)}><summary className="cursor-pointer text-accent">{zh ? "选择、编辑或停用写作偏好" : "Select, edit, or disable writing preferences"}</summary>{memoryOpen && <MemoryPanel novelId={novelId} refreshKey={memoryRevision} />}</details>
        </section>
        {!selection ? <p className="rounded-xl border border-border p-4 text-sm text-muted">{zh ? "请先在编辑框里用鼠标选中需要修改的文字，再点“AI 修改选段”。下方可以管理写作偏好。" : "Select text in the editor first, then click “AI edit selection”."}</p> : <>
          <LinkPicker novelId={novelId} value={linked} onChange={updateLinked} disabled={busy} />
          <ReferenceBooksPicker novelId={novelId} value={linked.reference_books ?? []} onChange={(reference_books) => updateLinked({ ...linked, reference_books })} disabled={busy} />
          {target === "chapter" && <label className="flex items-start gap-2 rounded-xl border border-border bg-surface p-3 text-sm">
            <input type="checkbox" className="mt-1 shrink-0" data-testid="agent-outline-sync" checked={settings.outlineSync} disabled={busy} onChange={(e) => update({ outlineSync: e.target.checked })} />
            <span className="min-w-0">{zh ? "允许顺手同步章纲：这次修改改变了剧情或设定时，直接改上面已关联的章纲；没关联的章纲先问我。" : "Let the agent sync outline chapters: linked ones directly, others after asking me."}
              <span className="mt-1 block text-xs leading-5 text-muted">{zh ? "这是附带同步的授权；如果你明确要求修改某章正文或章纲，智能体可直接处理指定目标，各流程均支持。每次保存留有历史。" : "This controls incidental sync. Explicit requests to edit a named chapter or outline work in every workflow and keep version history."}</span></span>
          </label>}
          <div className="flex justify-end"><button type="button" className="text-xs text-accent" data-testid="agent-wide" onClick={() => setWide(!wide)}>{wide ? (zh ? "收起文字框" : "Smaller") : (zh ? "放大文字框" : "Larger")}</button></div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="grid min-w-0 gap-2 text-sm"><span>{zh ? `选中的原文（${selection.text.length} 字）` : `Selected text (${selection.text.length})`}</span><pre className={`workspace-scrollbar ${pane} overflow-y-auto whitespace-pre-wrap rounded-xl border border-border bg-surface p-3 font-sans leading-7`}>{selection.text}</pre></div>
            <label className="grid min-w-0 gap-2 text-sm"><span>{zh ? "修改稿" : "Candidate"}{hasDraft && <span data-testid="agent-candidate-count">{zh ? `（${candidate.length} 字，${lengthDelta(candidate.length - selection.text.length, zh)}）` : ` (${candidate.length}, ${lengthDelta(candidate.length - selection.text.length, zh)})`}</span>}<span className="text-muted">{zh ? " 可直接编辑，选中一段可只改那一段" : " · editable; select part to revise only that"}</span></span><textarea data-testid="agent-candidate" className={`${CONTROL} ${pane} resize-y leading-7`} value={candidate} disabled={busy} onSelect={trackFocus} onMouseUp={trackFocus} onKeyUp={trackFocus} placeholder={busy ? (zh ? "正在准备资料，修改稿会实时显示在这里；停止后保留已写出的文字。" : "Preparing context. The draft appears as it is written and is kept if you stop.") : (zh ? "修改结果会显示在这里" : "The rewrite appears here")} onChange={(e) => { handEdited.current = true; setCandidate(e.target.value); }} /></label>
          </div>
          {!attempts.length && !hasDraft && <label className="grid gap-2 text-sm"><span>{zh ? "修改要求" : "Instruction"}</span><textarea data-testid="agent-instruction" className={CONTROL} rows={3} value={instruction} disabled={busy} placeholder={zh ? "可提问、修改选段，或明确要求修改本书其他章节/大纲。留空则润色选段。" : "Ask a question, revise the selection, or request changes to other chapters/outlines."} onChange={(e) => setInstruction(e.target.value)} /></label>}
          {(attempts.length > 0 || hasDraft) && <section aria-label={zh ? "追问修改" : "Follow-up"} className="space-y-2 rounded-xl border border-border p-3">
            <p className="text-xs text-muted">{zh ? "修改要求：" : "Instruction: "}{instruction.trim() || (zh ? "自然润色" : "Polish")}</p>
            {attempts.length > 0 && <ol data-testid="agent-thread" className="max-h-28 space-y-1 overflow-y-auto text-xs">{attempts.map((item, index) => <li key={index} className="text-muted">{zh ? `第 ${index + 1} 次追问：` : `Follow-up ${index + 1}: `}<span className="text-foreground">{item.feedback}</span></li>)}</ol>}
            {hasDraft && <>
              <textarea data-testid="agent-feedback" aria-label={zh ? "追问意见" : "Follow-up"} className={CONTROL} rows={2} value={feedback} disabled={busy} placeholder={zh ? "不满意就直接追问，会在上面这一稿上接着改。" : "Say what to change; the next version builds on this one."} onChange={(e) => setFeedback(e.target.value)} />
              <div className="flex flex-wrap items-center gap-3 text-xs">
                {focused ? <span data-testid="agent-focus" className="text-muted">{zh ? `只改修改稿里选中的 ${focus.replace(/\s/g, "").length} 字，其余不动` : `Only the ${focus.length} selected chars will change`} <button type="button" className="text-accent" onClick={() => setFocus("")}>{zh ? "改为整段" : "Whole text"}</button></span>
                  : <span className="text-muted">{zh ? "每次追问都在当前修改稿（包括你手改的地方）上接着改。" : "Each follow-up builds on the current candidate, including your edits."}</span>}
                {attempts.length > 0 && !busy && <button type="button" className="text-accent" data-testid="agent-undo" onClick={undo}>{zh ? "撤回上一轮" : "Undo last round"}</button>}
              </div>
              {pendingFeedback && <FeedbackPreferenceDraft novelId={novelId} feedback={pendingFeedback} model={settings.choice} onChanged={() => setMemoryRevision((value) => value + 1)} />}
            </>}
          </section>}
          {answer && <section data-testid="agent-answer" aria-label={zh ? "智能体的回答" : "Answer"} className="space-y-2 rounded-xl border border-accent/40 bg-accent/5 p-3 text-sm">
            <h3 className="font-medium">{zh ? "这次判断为提问：只回答，没有改稿" : "Treated as a question: answered without rewriting"}</h3>
            {answer.question && <p className="text-xs text-muted">{zh ? "你问：" : "You asked: "}{answer.question}</p>}
            <p className="whitespace-pre-wrap leading-7">{answer.text}</p>
            <p className="text-xs text-muted">{zh ? "想让它动手改，就在要求里写明要改什么（例如“把这段改成…”）。" : "To have it edit, state the change you want."}</p>
          </section>}
          {requests && <section data-testid="agent-outline-request" aria-label={zh ? "章纲修改授权" : "Outline access request"} className="space-y-2 rounded-xl border border-accent/40 bg-accent/5 p-3 text-sm">
            <h3 className="font-medium">{zh ? "智能体申请修改这些未授权的章纲，是否同意？" : "The agent asks to edit these outline chapters"}</h3>
            <ul className="space-y-1">{requests.outlines.map((item) => <li key={item.id}>{item.position}. {item.title}</li>)}</ul>
            <p className="text-xs leading-5 text-muted">{zh ? "理由：" : "Reason: "}{requests.reason}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="primary" data-testid="agent-outline-grant" isDisabled={busy} onPress={grantRequests}>{zh ? "同意，并让它现在同步" : "Allow and sync now"}</Button>
              <Button size="sm" variant="ghost" data-testid="agent-outline-deny" isDisabled={busy} onPress={() => setRequests(null)}>{zh ? "不同意" : "Decline"}</Button>
            </div>
            {busy && <p className="text-xs text-muted">{zh ? "当前这一稿写完后就可以答复。" : "You can answer once this run finishes."}</p>}
          </section>}
          {changes.length > 0 && <section data-testid="agent-outline-changes" aria-label={zh ? "已同步修改的章纲" : "Outline chapters changed"} className="space-y-2 rounded-xl border border-border p-3 text-sm">
            <h3 className="font-medium">{zh ? "已同步修改的章纲（已直接保存到书里）" : "Outline chapters changed (already saved)"}</h3>
            <ul className="space-y-2">{changes.map((item) => <li key={item.outline_id} data-outline-change={item.outline_id} className="flex flex-wrap items-start gap-x-3 gap-y-1">
              <span className="text-fill min-w-40 flex-1"><span className="font-medium">{item.title}</span><span className="block text-xs leading-5 text-muted">{item.note}</span></span>
              {item.restored ? <span className="text-xs text-muted">{zh ? "已恢复到改动前" : "Restored"}</span>
                : <Button size="sm" variant="ghost" isDisabled={busy || Boolean(restoring)} onPress={() => void restoreOutline(item)}>{restoring === item.outline_id ? (zh ? "恢复中…" : "Restoring…") : (zh ? "恢复到改动前" : "Restore previous")}</Button>}
            </li>)}</ul>
          </section>}
          {bookReport && <section data-testid="agent-book-report" className="space-y-2 rounded-xl border border-accent/40 p-3 text-sm"><h3 className="font-medium">{zh ? "本书修改结果" : "Book edit report"}</h3><p className="whitespace-pre-wrap leading-7">{bookReport}</p></section>}
          <BookDocumentChanges novelId={novelId} changes={bookChanges} busy={busy} />
          <AgentTrace items={trace} running={busy} status={status} reviewLog={reviewLog} onAdopt={(text) => setCandidate(text)} onStop={() => abort.current?.abort()} />
          {proposals.length > 0 && <MemoryProposalPrompt novelId={novelId} proposals={proposals} />}
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <WorkflowPicker novelId={novelId} value={settings.workflow} onChange={(workflow) => update({ workflow })} disabled={busy} testId="agent-workflow" />
          <EffortSelect value={settings.effort} onChange={(effort) => update({ effort })} provider={settings.choice.provider} disabled={busy} />
          <details className="text-sm"><summary className="cursor-pointer">{zh ? "模型与自我审查" : "Model and self-review"}</summary><div className="mt-3 space-y-3">
            <ModelPicker value={settings.choice} onChange={(choice) => update({ choice })} disabled={busy} />
            <ReviewModeControls rounds={settings.rounds} untilPass={settings.untilPass} disabled={busy} onChange={(patch) => update({ ...(patch.rounds !== undefined ? { rounds: patch.rounds } : {}), ...(patch.untilPass !== undefined ? { untilPass: patch.untilPass } : {}) })}
              label={zh ? "自我审查轮数（0 为不审查；每轮不达标就继续修改再审）" : "Self-review rounds (0 = off)"} ariaLabel={zh ? "自我审查轮数" : "Self-review rounds"} selectClassName={CONTROL} />
            {target === "chapter" && <DeslopToggle checked={settings.deslop} disabled={busy} onChange={(deslop) => update({ deslop })} />}
            {<label className="flex items-center gap-2 text-xs"><input type="checkbox" data-testid="agent-learn" checked={settings.learn} disabled={busy} onChange={(e) => update({ learn: e.target.checked })} />{zh ? "采用修改稿后总结通用写作偏好（保存前询问我）" : "Suggest general preferences after accepting"}</label>}
          </div></details>
        </>}
      </div>
      <footer className="flex shrink-0 flex-wrap gap-2 border-t border-border p-4 sm:px-5">
        {busy && <p role="status" data-testid="agent-running-status" className="w-full text-sm text-accent">{status}</p>}
        {error && <p role="alert" data-testid="agent-footer-error" className="w-full text-sm text-danger">{error}</p>}
        {busy && <Button size="sm" variant="danger-soft" onPress={() => abort.current?.abort()}>{zh ? "停止" : "Stop"}</Button>}
        {!inline && <Button data-testid="agent-cancel" variant="ghost" onPress={close}>{zh ? "取消" : "Cancel"}</Button>}
        {selection && !hasDraft && <Button data-testid="agent-generate" variant="primary" isDisabled={busy} onPress={() => void run([])}>{zh ? "开始修改" : "Rewrite"}</Button>}
        {selection && hasDraft && <>
          <Button variant="ghost" isDisabled={busy} onPress={() => { setCandidate(""); setDrafted(false); setAttempts([]); setReviewLog(null); setTrace([]); setStatus(""); setFocus(""); setAnswer(null); handEdited.current = false; distilled.current = false; }}>{zh ? "改要求重来" : "Start over"}</Button>
          <Button data-testid="agent-revise" variant="secondary" isDisabled={busy || !feedback.trim() || !candidate.trim()} onPress={() => followUp()}>{focused ? (zh ? "只改选中的一段" : "Revise selection") : (zh ? "按意见再改" : "Revise")}</Button>
          <Button data-testid="agent-give-feedback" variant="ghost" isDisabled={busy || !feedback.trim() || !candidate.trim()} onPress={() => followUp(true)}>{zh ? "给智能体提意见" : "Give the agent feedback"}</Button>
          <Button data-testid="agent-accept" variant="primary" isDisabled={busy || !candidate.trim()} onPress={() => accept()}>{acceptLabel ?? (zh ? "替换选段" : "Replace selection")}</Button>
          {onAcceptAndSave && <Button data-testid="agent-accept-save" variant="secondary" isDisabled={busy || !candidate.trim()} onPress={() => accept(true)}>{zh ? "替换并保存本章" : "Replace and save"}</Button>}
        </>}
      </footer>
    </section>
  </div>;
  return inline ? content : createPortal(content, document.body);
}


/** 作者自己选这次修改参考哪些正文章节（正文或概要）和章纲；默认不关联，智能体也不能自己翻全书，除非作者打开“允许自行查阅”。 */
function LinkPicker({ novelId, value, onChange, disabled }: { novelId: string; value: Linked; onChange: (next: Linked) => void; disabled: boolean }) {
  const zh = useLocale() !== "en";
  const [open, setOpen] = useState(false);
  const [chapters, setChapters] = useState<ChapterRow[] | null>(null);
  const [outlines, setOutlines] = useState<OutlineRow[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    let current = true;
    void Promise.all([
      apiGet<{ data: ChapterRow[] }>(`/api/chapters/novel/${novelId}`),
      apiGet<{ chapters: OutlineRow[] }>(`/api/novels/${novelId}/outline-chapters`).catch(() => ({ chapters: [] as OutlineRow[] })),
    ]).then(([chapterResult, outlineResult]) => {
      if (!current) return;
      setChapters(chapterResult.data); setOutlines(outlineResult.chapters);
      // 上次勾选的章节可能已删除；只保留还在的。
      const ids = new Set(chapterResult.data.map((row) => row.chapter_id));
      const outlineIds = new Set(outlineResult.chapters.map((row) => row.id));
      const saved = latest.current;
      const kept = { ...saved, chapters: saved.chapters.filter((item) => ids.has(item.chapter_id)), outline_ids: saved.outline_ids.filter((id) => outlineIds.has(id)) };
      if (kept.chapters.length !== saved.chapters.length || kept.outline_ids.length !== saved.outline_ids.length) onChange(kept);
    }).catch((e) => { if (current) setError((e as Error).message); });
    return () => { current = false; };
    // onChange 每次渲染都是新函数，只在换书时重新读取目录。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [novelId]);
  const picked = new Map(value.chapters.map((item) => [item.chapter_id, item.mode]));
  const setChapter = (id: string, mode: LinkMode | null) => {
    const order = (chapters ?? []).map((row) => row.chapter_id!);
    const next = new Map(picked);
    if (mode) next.set(id, mode); else next.delete(id);
    onChange({ ...value, chapters: order.filter((key) => next.has(key)).map((chapter_id) => ({ chapter_id, mode: next.get(chapter_id)! })) });
  };
  const toggleOutline = (id: string, on: boolean) => {
    const order = (outlines ?? []).map((row) => row.id);
    onChange({ ...value, outline_ids: order.filter((key) => key === id ? on : value.outline_ids.includes(key)) });
  };
  const written = (chapters ?? []).filter((row) => (row.word_count ?? 0) > 0);
  const text = query.trim();
  // 标题和章号在本地即时筛选；正文、概要、章纲内容里的关键词由后端逐字查找。
  const { hits, searching } = useKeywordHits(novelId, query);
  const shownChapters = (chapters ?? []).filter((row) => !text || row.title.includes(text) || String(row.chapter_number) === text || hits?.chapters.has(row.chapter_id!));
  const shownOutlines = (outlines ?? []).map((row, index) => ({ row, position: index + 1 })).filter(({ row, position }) => !text || row.title.includes(text) || String(position) === text || hits?.outlines.has(row.id));
  const hitNote = (hit: ReturnType<NonNullable<typeof hits>["chapters"]["get"]>) => hit?.hits ? <span className="block text-xs leading-5 text-muted" data-keyword-hit>{hitLabel(hit, zh)}：…{hit.snippet}…</span> : null;
  const count = value.chapters.length + value.outline_ids.length;
  const summaryLabel = zh
    ? (count ? `已关联 ${value.chapters.length} 章正文${value.outline_ids.length ? `、${value.outline_ids.length} 章章纲` : ""}` : "未关联其他章节（只看选段前后文）") + (value.free_lookup ? " · 允许自行查阅全书" : "")
    : (count ? `${value.chapters.length} chapters, ${value.outline_ids.length} outline chapters linked` : "No chapters linked") + (value.free_lookup ? " · may look up the book" : "");

  return <section className="rounded-xl border border-border bg-surface p-3 text-sm" data-testid="agent-links" aria-label={zh ? "关联章节" : "Linked chapters"}>
    <button type="button" className="flex min-h-8 w-full items-center justify-between gap-2 text-left text-accent" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span>{zh ? "关联章节：" : "Linked: "}<span className="text-foreground">{summaryLabel}</span></span><span aria-hidden="true">{open ? "−" : "+"}</span>
    </button>
    {open && <div className="mt-3 space-y-3">
      <p className="text-xs leading-5 text-muted">{zh ? "勾选的章节会整章（或概要）交给智能体参考；没勾选的它读不到。上次的勾选会记住。" : "Ticked chapters are given to the agent; others are not readable. Your choice is remembered."}</p>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <input aria-label={zh ? "搜索章节" : "Search chapters"} className={`${CONTROL} min-w-40 flex-1`} value={query} placeholder={zh ? "按关键词筛选：标题、章号或内容里的词" : "Filter by title, number or a word in the text"} maxLength={60} data-testid="agent-link-filter" onChange={(e) => setQuery(e.target.value)} />
        <Button size="sm" variant="ghost" isDisabled={disabled || !written.length} onPress={() => onChange({ ...value, chapters: written.slice(-3).map((row) => ({ chapter_id: row.chapter_id!, mode: picked.get(row.chapter_id!) ?? "original" })) })}>{zh ? "最近 3 章" : "Last 3"}</Button>
        <Button size="sm" variant="ghost" isDisabled={disabled || !count} onPress={() => onChange({ ...value, chapters: [], outline_ids: [] })}>{zh ? "全部取消" : "Clear"}</Button>
      </div>
      {text && <p className="text-xs text-muted" role="status">{searching ? (zh ? "正在查找内容里的关键词…" : "Searching text…") : (zh ? `筛出 ${shownChapters.length} 章正文、${shownOutlines.length} 章章纲` : `${shownChapters.length} chapters, ${shownOutlines.length} outline chapters`)}</p>}
      {chapters === null ? <p className="text-xs text-muted">{zh ? "读取中…" : "Loading…"}</p> : <>
        <h4 className="text-xs font-semibold text-muted">{zh ? "正文章节" : "Chapters"}</h4>
        {!chapters.length ? <p className="text-xs text-muted">{zh ? "本书还没有正文章节。" : "No chapters yet."}</p> :
          <ul className="max-h-56 space-y-1 overflow-y-auto">{shownChapters.map((row) => {
            const id = row.chapter_id!; const mode = picked.get(id);
            return <li key={id} data-link-chapter={id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg p-1.5 hover:bg-accent/5">
              <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2"><input type="checkbox" className="mt-1" disabled={disabled || (!mode && value.chapters.length >= 100)} checked={Boolean(mode)} onChange={(e) => setChapter(id, e.target.checked ? "original" : null)} /><span className="min-w-0 break-words">{row.chapter_number}. {row.title}<span className="ml-2 text-xs text-muted">{row.word_count ?? 0} {zh ? "字" : "chars"}</span>{text && hitNote(hits?.chapters.get(id))}</span></label>
              {mode && <span className="flex items-center gap-3 text-xs">{(["original", "summary"] as const).map((item) => <label key={item} className="flex items-center gap-1"><input type="radio" name={`link-mode-${id}`} disabled={disabled || (item === "summary" && !row.summary.trim())} checked={mode === item} onChange={() => setChapter(id, item)} />{item === "original" ? (zh ? "正文" : "Text") : (zh ? "概要" : "Summary")}</label>)}</span>}
            </li>;
          })}</ul>}
        {outlines && outlines.length > 0 && <>
          <h4 className="text-xs font-semibold text-muted">{zh ? "本书大纲（章纲）" : "Outline chapters"}</h4>
          <ul className="max-h-40 space-y-1 overflow-y-auto">{shownOutlines.map(({ row, position }) => <li key={row.id} data-link-outline={row.id}>
            <label className="flex cursor-pointer items-start gap-2 rounded-lg p-1.5 hover:bg-accent/5"><input type="checkbox" className="mt-1" disabled={disabled || (!value.outline_ids.includes(row.id) && value.outline_ids.length >= 100)} checked={value.outline_ids.includes(row.id)} onChange={(e) => toggleOutline(row.id, e.target.checked)} /><span className="min-w-0 break-words">{position}. {row.title}<span className="ml-2 text-xs text-muted">{row.word_count} {zh ? "字" : "chars"}</span>{text && hitNote(hits?.outlines.get(row.id))}</span></label>
          </li>)}</ul>
        </>}
      </>}
      <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" data-testid="agent-free-lookup" disabled={disabled} checked={value.free_lookup} onChange={(e) => onChange({ ...value, free_lookup: e.target.checked })} /><span>{zh ? "允许智能体自己查阅其他章节和大纲（关掉时只能看上面勾选的）" : "Let the agent look up other chapters on its own"}</span></label>
    </div>}
  </section>;
}


/** AI 只提出建议；作者逐条选择“记住”或“忽略”，未作选择不会写入数据库。 */
export function MemoryProposalPrompt({ novelId, proposals, onSaved }: { novelId: string; proposals: MemoryProposal[]; onSaved?: () => void }) {
  const zh = useLocale() !== "en";
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const visible = proposals.map((item, index) => ({ item, key: item.id ?? `${index}-${item.text}` })).filter(({ key }) => !closed.has(key));
  if (!visible.length) return null;
  const decide = async (key: string, item: MemoryProposal, save: boolean) => {
    if (!save) { setClosed((current) => new Set(current).add(key)); return; }
    setBusy(key); setError("");
    try {
      await apiPost(`/api/novels/${novelId}/writing-agent/memories/confirm`, item);
      onSaved?.();
      setClosed((current) => new Set(current).add(key));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(""); }
  };
  return <section data-testid="memory-proposals" className="min-w-72 flex-1 space-y-2 rounded-xl border border-accent/40 bg-accent/5 p-3" aria-label={zh ? "是否记住通用写作规则" : "Save general writing rules"}>
    <h3 className="text-sm font-medium">{zh ? "发现可复用的写法规则，要记录吗？" : "Save these reusable writing rules?"}</h3>
    <p className="text-xs text-muted">{zh ? "只总结文风、写法或格式等通用问题；剧情和一次性修改不会记录。忽略后不会保存。" : "Only general style, technique, or formatting rules are suggested. Plot-specific changes are not saved."}</p>
    {visible.map(({ item, key }) => <article key={key} className="rounded-lg border border-border bg-surface p-3" data-memory-proposal={key}>
      <p className="text-sm leading-6">{item.text}</p>
      <p className="mt-1 text-xs text-muted">{item.scope === "global" ? (zh ? "应用到所有小说" : "All novels") : (zh ? "仅应用到本书" : "This novel only")}</p>
      <div className="mt-2 flex gap-2"><Button size="sm" variant="primary" isDisabled={Boolean(busy)} onPress={() => void decide(key, item, true)}>{busy === key ? (zh ? "保存中…" : "Saving…") : (zh ? "记住这条规则" : "Save rule")}</Button><Button size="sm" variant="ghost" isDisabled={Boolean(busy)} onPress={() => void decide(key, item, false)}>{zh ? "忽略" : "Dismiss"}</Button></div>
    </article>)}
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </section>;
}


/** 写作偏好按功能分组；可停用、编辑、删除，或从其他写作工具（目前支持 Claude Code 记忆）导入。categories 只显示这几类（例如写大纲时只看“大纲写法”和“本书设定”）。 */
export function MemoryPanel({ novelId, refreshKey = 0, categories }: { novelId: string; refreshKey?: number; categories?: MemoryCategory[] }) {
  const zh = useLocale() !== "en";
  const base = `/api/novels/${novelId}/writing-agent/memories`;
  const [rows, setRows] = useState<Memory[] | null>(null);
  const [text, setText] = useState("");
  const [scope, setScope] = useState<Memory["scope"]>("global");
  const [plotSpecific, setPlotSpecific] = useState(false);
  const [category, setCategory] = useState<MemoryCategory>(categories?.[0] ?? "style");
  const [editing, setEditing] = useState<{ id: string; title: string; text: string; category: MemoryCategory; scope: Memory["scope"]; plot_specific: boolean } | null>(null);
  const [importing, setImporting] = useState(false);
  const [linking, setLinking] = useState(false);
  const [revisingId, setRevisingId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const reload = async () => setRows((await apiGet<{ memories: Memory[] }>(base)).memories);
  useEffect(() => {
    let current = true;
    void apiGet<{ memories: Memory[] }>(base).then((result) => { if (current) setRows(result.memories); }).catch((e) => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [base, refreshKey]);
  const act = async (task: () => Promise<unknown>) => {
    setError("");
    try { await task(); await reload(); return true; } catch (e) { setError((e as Error).message); return false; }
  };
  // 本书设定默认只对本书生效、其他类默认对所有书生效；只有和默认不同时才标出范围。
  const scopeLabel = (row: Memory) => row.linked ? (zh ? "关联书偏好 · 只读" : "Linked book · read only") : row.plot_specific ? (zh ? "强剧情相关 · 仅来源书" : "Plot specific · source book only") : (row.source_novel_id ? (zh ? "可跨书参考 · 来源书偏好" : "Reusable · source book preference") : (zh ? "通用偏好" : "General preference"));
  const groups = rows ? [...new Set(rows.map((row) => row.source_novel_id ?? "global"))].flatMap((origin) =>
    MEMORY_CATEGORIES.filter((key) => !categories || categories.includes(key)).map((key) => {
      const members = rows.filter((row) => (row.category ?? "other") === key && (row.source_novel_id ?? "global") === origin);
      const source = members[0]?.source_novel_title || (zh ? "来源书" : "Source book");
      return { key, id: `${origin}:${key}`, label: origin === "global" ? (zh ? "通用写作偏好" : "General preferences") : (zh ? `来自《${source}》的写作偏好` : `Preferences from ${source}`), rows: members };
    }).filter((group) => group.rows.length)) : [];
  // 一键全选/全取消只作用于当前显示的偏好；只提交状态需要改变的条目。
  const shown = groups.flatMap((group) => group.rows);
  const enabledCount = shown.filter((row) => row.enabled).length;
  const setAll = (enabled: boolean) => void act(() => Promise.all(shown.filter((row) => row.enabled !== enabled).map((row) => apiPatch(`${base}/${row.id}`, { enabled }))));
  const categorySelect = (value: MemoryCategory, onChange: (value: MemoryCategory) => void) =>
    <select aria-label={zh ? "分类" : "Category"} className={`${CONTROL} w-auto`} value={value} onChange={(e) => onChange(e.target.value as MemoryCategory)}>
      {MEMORY_CATEGORIES.filter((key) => !categories || categories.includes(key) || key === value).map((key) => <option key={key} value={key}>{categoryName(key, zh)}</option>)}
    </select>;
  const scopeSelect = (value: Memory["scope"], onChange: (value: Memory["scope"]) => void) =>
    <select aria-label={zh ? "来源" : "Origin"} className={`${CONTROL} w-auto`} value={value} onChange={(e) => onChange(e.target.value as Memory["scope"])}><option value="global">{zh ? "通用写作偏好" : "General preferences"}</option><option value="novel">{zh ? "来自本书的偏好（可跨书参考）" : "From this book (reusable)"}</option></select>;
  return <div className="mt-3 space-y-3" data-testid="memory-panel">
    <p className="text-xs text-muted">{zh ? "智能体按任务自动查阅相关偏好，当前要求优先于旧规则。点“给智能体提意见”时，意见会直接整理成一条偏好存到这里；文风与结构偏好跨书可用，来源书仅作标记；强剧情相关内容只用于来源书。不合预期的可以“提意见修改”，也可编辑、停用、删除或导入。" : "The agent selects relevant preferences. Current instructions take priority. “Give the agent feedback” saves each note here as a preference; use “Revise with feedback” if one is off."}</p>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    {rows === null ? <p className="text-xs text-muted">{zh ? "读取中…" : "Loading…"}</p> : !groups.length ? <p className="text-xs text-muted">{categories ? (zh ? "这几类还没有偏好，可以在下面手动添加。" : "No preferences in these categories yet.") : (zh ? "还没有记住任何偏好。" : "No preferences yet.")}</p> :
      <>
      <div className="flex flex-wrap items-center gap-3 text-xs" data-testid="memory-bulk">
        <button type="button" className="text-accent disabled:text-muted" disabled={enabledCount === shown.length} onClick={() => setAll(true)}>{zh ? "全部启用" : "Enable all"}</button>
        <button type="button" className="text-accent disabled:text-muted" disabled={enabledCount === 0} onClick={() => setAll(false)}>{zh ? "全部停用" : "Disable all"}</button>
        <span className="text-muted">{zh ? `已启用 ${enabledCount} / ${shown.length}` : `${enabledCount} / ${shown.length} enabled`}</span>
      </div>
      <div className="max-h-96 space-y-3 overflow-y-auto">{groups.map((group) => <section key={group.id} data-memory-category={group.key}>
        <h4 className="mb-1 text-xs font-semibold text-muted">{group.label} · {categoryName(group.key, zh)}（{group.rows.length}）</h4>
        <ul className="space-y-2">{group.rows.map((row) => <li key={row.id} className="space-y-1 rounded-lg border border-border p-2 text-xs">
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5 shrink-0" aria-label={zh ? "启用" : "Enabled"} checked={row.enabled} onChange={(e) => void act(() => apiPatch(`${base}/${row.id}`, { enabled: e.target.checked }))} />
            <span className={`text-fill font-medium ${row.enabled ? "" : "text-muted line-through"}`}>{row.title || row.text.slice(0, 60)}</span>
          </label>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-5">
            {scopeLabel(row) && <span className="whitespace-nowrap rounded bg-surface px-1 text-muted">{scopeLabel(row)}</span>}
            {(row.source === "learned" || row.source === "feedback") && <span className="whitespace-nowrap rounded bg-surface px-1 text-muted">{zh ? "AI 总结" : "AI suggested"}</span>}
            {row.linked && <span className="rounded bg-surface px-1 text-muted">{zh ? `关联自《${row.source_novel_title}》` : `From ${row.source_novel_title}`}</span>}
            {editing?.id !== row.id && !row.linked && <span className="ml-auto flex flex-wrap gap-2 whitespace-nowrap">
              <button type="button" className="text-accent" onClick={() => setEditing({ id: row.id, title: row.title, text: row.text, category: row.category ?? "other", scope: row.scope, plot_specific: row.plot_specific ?? false })}>{zh ? "编辑" : "Edit"}</button>
              <button type="button" className="text-accent" data-testid="memory-revise" onClick={() => setRevisingId(revisingId === row.id ? null : row.id)}>{zh ? "提意见修改" : "Revise with feedback"}</button>
              <button type="button" className="text-danger" onClick={() => void act(() => apiDelete(`${base}/${row.id}`))}>{zh ? "删除" : "Delete"}</button>
            </span>}
          </div>
          {editing?.id === row.id ? <div className="grid gap-2">
            <input aria-label={zh ? "标题" : "Title"} className={CONTROL} value={editing.title} maxLength={200} placeholder={zh ? "标题（可选）" : "Title (optional)"} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
            <textarea aria-label={zh ? "偏好内容" : "Preference"} className={`${CONTROL} min-h-24 resize-y`} value={editing.text} maxLength={8000} onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
            <div className="flex flex-wrap items-center gap-2">
              {categorySelect(editing.category, (value) => setEditing({ ...editing, category: value }))}
              {scopeSelect(editing.scope, (value) => setEditing({ ...editing, scope: value }))}
              <label className="flex items-center gap-1"><input type="checkbox" checked={editing.plot_specific || editing.category === "setting"} disabled={editing.category === "setting"} onChange={(e) => setEditing({ ...editing, plot_specific: e.target.checked })} />{zh ? "强剧情相关（仅来源书）" : "Plot specific (source book only)"}</label>
              <button type="button" className="text-accent" disabled={!editing.text.trim()} onClick={() => void act(() => apiPatch(`${base}/${row.id}`, { title: editing.title, text: editing.text, category: editing.category, scope: editing.scope, plot_specific: editing.plot_specific })).then((ok) => { if (ok) setEditing(null); })}>{zh ? "保存" : "Save"}</button>
              <button type="button" className="text-muted" onClick={() => setEditing(null)}>{zh ? "取消" : "Cancel"}</button>
            </div>
          </div> : (row.title || row.text.length > 60) && <details><summary className="cursor-pointer text-muted">{zh ? `查看全文（${row.text.length} 字）` : `Full text (${row.text.length})`}</summary><p className="mt-1 whitespace-pre-wrap leading-5">{row.text}</p></details>}
          {revisingId === row.id && editing?.id !== row.id && <PreferenceReviser novelId={novelId} memory={row} onChanged={() => void reload().catch((e) => setError(e.message))} onClose={() => setRevisingId(null)} />}
        </li>)}</ul>
      </section>)}</div>
      </>}
    <div className="flex flex-wrap items-center gap-2">
      <input aria-label={zh ? "新的写作偏好" : "New preference"} className={`${CONTROL} min-w-48 flex-1`} value={text} maxLength={8000} placeholder={zh ? "例如：对白少用感叹号" : "e.g. fewer exclamation marks"} onChange={(e) => setText(e.target.value)} />
      {categorySelect(category, (value) => { setCategory(value); setScope(value === "setting" ? "novel" : "global"); })}
      {scopeSelect(scope, setScope)}
      <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={plotSpecific || category === "setting"} disabled={category === "setting"} onChange={(e) => setPlotSpecific(e.target.checked)} />{zh ? "强剧情相关（仅来源书）" : "Plot specific (source book only)"}</label>
      <Button size="sm" isDisabled={!text.trim()} onPress={() => void act(() => apiPost(base, { text, scope, category, plot_specific: plotSpecific || category === "setting" })).then((ok) => { if (ok) setText(""); })}>{zh ? "添加" : "Add"}</Button>
      <Button size="sm" variant="secondary" data-testid="claude-import-open" onPress={() => { setLinking(false); setImporting(true); }}>{zh ? "从写作工具导入" : "Import from writing tools"}</Button>
      <Button size="sm" variant="secondary" data-testid="book-links-open" onPress={() => { setImporting(false); setLinking(!linking); }}>{zh ? "关联其他书的偏好" : "Link another book"}</Button>
    </div>
    {importing && <ClaudeImport base={base} onDone={(message) => { setImporting(false); if (!message) return; setNotice(message); void reload().catch((e) => setError(e.message)); }} />}
    {linking && <BookLinks base={base} onChanged={() => void reload().catch((e) => setError(e.message))} onClose={() => setLinking(false)} />}
    {notice && <p role="status" className="text-xs text-accent">{notice}</p>}
  </div>;
}

interface LinkBook { id: string; title: string; count: number; linked: boolean }

/** 关联其他书的写作偏好：勾选即生效。被关联书的偏好直接显示在本书列表里，原书改了这里跟着变；本书只能启用/停用，不能改原条目。 */
function BookLinks({ base, onChanged, onClose }: { base: string; onChanged: () => void; onClose: () => void }) {
  const zh = useLocale() !== "en";
  const [books, setBooks] = useState<LinkBook[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    void apiGet<{ books: LinkBook[] }>(`${base}/links`).then(({ books }) => { if (current) setBooks(books); }).catch((e) => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [base]);
  const save = async (ids: string[]) => {
    setBusy(true); setError("");
    try { setBooks((await apiPut<{ books: LinkBook[] }>(`${base}/links`, { source_novel_ids: ids })).books); onChanged(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const linkedIds = books?.filter((book) => book.linked).map((book) => book.id) ?? [];
  const toggle = (id: string, on: boolean) => void save(on ? [...linkedIds, id] : linkedIds.filter((item) => item !== id));
  return <div className="space-y-2 rounded-xl border border-accent/40 p-3 text-xs" data-testid="book-links">
    <p className="text-muted">{zh ? "勾选一本书，它的本书设定、强剧情相关等偏好就会出现在本书列表里，写作时一起遵守。原书改动会实时同步过来；在本书里只能启用或停用这些偏好，要改内容请到原书里改。文风、对白这类可复用偏好本来就对所有书生效，不需要关联。" : "Linked books' book-specific preferences appear here and stay in sync. You can only enable or disable them in this book."}</p>
    {error && <p role="alert" className="text-danger">{error}</p>}
    {books === null ? <p className="text-muted">{zh ? "读取中…" : "Loading…"}</p> : !books.length ? <p className="text-muted">{zh ? "其他书还没有本书专属的写作偏好。" : "No other book has book-specific preferences."}</p> :
      <ul className="space-y-1">{books.map((book) => <li key={book.id} data-link-book={book.id}>
        <label className="flex items-center gap-2"><input type="checkbox" disabled={busy} checked={book.linked} onChange={(e) => toggle(book.id, e.target.checked)} /><span>{`《${book.title}》`}</span><span className="text-muted">{zh ? `${book.count} 条专属偏好` : `${book.count}`}</span></label>
      </li>)}</ul>}
    <div className="flex gap-2"><Button size="sm" variant="ghost" onPress={onClose}>{zh ? "收起" : "Close"}</Button></div>
  </div>;
}

interface ClaudeItem { key: string; project: string; title: string; text: string; type: string; suggested: boolean; suggested_scope: Memory["scope"]; merged?: boolean }

/** 列出本机写作工具的记忆（目前读取 Claude Code 各项目 memory 目录），作者勾选并为每条选择“所有书／仅本书”后导入；重复导入会更新原条目。 */
function ClaudeImport({ base, onDone }: { base: string; onDone: (message: string) => void }) {
  const zh = useLocale() !== "en";
  const [items, setItems] = useState<ClaudeItem[] | null>(null);
  const [picked, setPicked] = useState<Record<string, Memory["scope"] | null>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    void apiGet<{ items: ClaudeItem[] }>(`${base}/claude-code`).then(({ items }) => {
      if (!current) return;
      setItems(items);
      setPicked(Object.fromEntries(items.map((item) => [item.key, item.suggested ? item.suggested_scope : null])));
    }).catch((e) => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [base]);
  const chosen = Object.entries(picked).filter((entry): entry is [string, Memory["scope"]] => entry[1] !== null);
  const submit = async () => {
    setBusy(true); setError("");
    try {
      const result = await apiPost<{ created: number; updated: number }>(`${base}/claude-code/import`, { items: chosen.map(([key, scope]) => ({ key, scope })) });
      onDone(zh ? `已导入 ${result.created} 条偏好${result.updated ? `，更新 ${result.updated} 条` : ""}。` : `Imported ${result.created}, updated ${result.updated}.`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <div className="space-y-2 rounded-xl border border-accent/40 p-3 text-xs" data-testid="claude-import">
    <p className="text-muted">{zh ? "读取本机写作工具的记忆文件（目前支持 Claude Code，只读，不会修改它们）。已按内容建议勾选：文风、对话等写作要求默认“通用写作偏好”，人物和世界观设定仅用于来源书；工具配置、文件位置、进度类，以及已经整理进现有偏好的，默认不选。" : "Reads memory files from local writing tools (Claude Code for now, read-only)."}</p>
    {error && <p role="alert" className="text-danger">{error}</p>}
    {items === null ? <p className="text-muted">{zh ? "读取中…" : "Loading…"}</p> : !items.length ? <p className="text-muted">{zh ? "没有找到可导入的记忆。" : "No memories found."}</p> : <>
      <div className="flex flex-wrap gap-3"><button type="button" className="text-accent" onClick={() => setPicked(Object.fromEntries(items.map((item) => [item.key, item.suggested_scope])))}>{zh ? "全选" : "All"}</button><button type="button" className="text-accent" onClick={() => setPicked(Object.fromEntries(items.map((item) => [item.key, null])))}>{zh ? "全不选" : "None"}</button><span className="text-muted">{zh ? `已选 ${chosen.length} / ${items.length}` : `${chosen.length} / ${items.length}`}</span></div>
      <ul className="max-h-80 space-y-1 overflow-y-auto">{items.map((item) => <li key={item.key} data-claude-memory={item.key} className="rounded-lg border border-border p-2">
        <div className="flex flex-wrap items-center gap-2">
          <input type="checkbox" aria-label={item.title} checked={picked[item.key] != null} onChange={(e) => setPicked({ ...picked, [item.key]: e.target.checked ? item.suggested_scope : null })} />
          <span className="text-fill">{item.title}<span className="ml-2 text-muted">{item.project}</span>{item.merged && <span className="ml-2 rounded bg-surface px-1 text-muted">{zh ? "已整理进现有偏好" : "Already merged"}</span>}</span>
          <select aria-label={zh ? "生效范围" : "Scope"} className="rounded border border-border bg-background px-1 py-0.5" disabled={picked[item.key] == null} value={picked[item.key] ?? item.suggested_scope} onChange={(e) => setPicked({ ...picked, [item.key]: e.target.value as Memory["scope"] })}><option value="global">{zh ? "通用写作偏好" : "General preferences"}</option><option value="novel">{zh ? "来自本书的偏好" : "Preferences from this book"}</option></select>
        </div>
        <details><summary className="cursor-pointer text-muted">{zh ? `查看（${item.text.length} 字）` : "View"}</summary><p className="mt-1 whitespace-pre-wrap leading-5">{item.text}</p></details>
      </li>)}</ul>
    </>}
    <div className="flex gap-2"><Button size="sm" variant="primary" data-testid="claude-import-submit" isDisabled={busy || !chosen.length} onPress={() => void submit()}>{zh ? `导入所选（${chosen.length}）` : "Import"}</Button><Button size="sm" variant="ghost" isDisabled={busy} onPress={() => onDone("")}>{zh ? "取消" : "Cancel"}</Button></div>
  </div>;
}
