"use client";

import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@heroui/react";
import { useLocale } from "next-intl";
import { RetainedViewActive } from "@/components/layout/RetainedViews";
import { ModelPicker, type ModelChoice } from "@/components/shared/ModelPicker";
import { apiGet, apiPost } from "@/lib/api";
import { setBookBusy } from "@/lib/openBooks";
import { notifyResourceChange } from "@/lib/resourceChanges";
import { compactNumber, traceReducer, type Kind, type PlanEntry, type TraceItem } from "./AgentTrace";
import { MemoryProposalPrompt, type MemoryProposal } from "./SelectionAgent";
import { LibraryManager, LibraryProposalPrompt } from "./AgentLibrary";
import { activeBatch, AgentTimeline, ParallelBoard, type RunOutcome } from "./AgentWorkbench";
import { DeslopToggle, effortFrom, EffortSelect, isSubmitShortcut, ReviewModeControls } from "./AgentSettings";
import "./agent-workbench.css";
import { confirmDialog } from "@/components/shared/ConfirmDialog";
import { WorkflowPicker, workflowId, type WorkflowId } from "./WorkflowPicker";

import { BookContextPicker, EMPTY_CONTEXT, type BookContext } from "./BookContextPicker";
import { clearAgentQuestionOwner, registerAgentQuestion, reopenAgentQuestion } from "@/lib/agentQuestions";

type Status = "running" | "waiting" | "stopping" | "done" | "stopped" | "interrupted" | "failed" | "refused";
interface Stats { chapters_written?: number; chars_written?: number; chapters_revised?: number; outlines_written?: number; edits?: number }
interface Usage { input?: number; output?: number; total?: number; calls?: number; estimated?: boolean; cost?: number | null; currency?: string | null; cache_read?: number; cache_write?: number }
interface Job {
  id: string; status: Status; instruction: string; plan: PlanEntry[]; notes: string; question: string; report: string; error: string;
  question_id?: string; question_options?: string[]; question_multi_select?: boolean;
  stats: Stats; usage: Usage; steps: number; runs: number; status_text?: string; live?: { label: string; text: string } | null;
  settings: Partial<BookContext> & { workflow?: WorkflowId; provider?: string; model?: string; token_budget?: number; context_budget?: number; reasoning_effort?: string | null; review_rounds?: number; review_until_pass?: boolean; deslop?: boolean; parallel_agents?: number }; created_at?: string; updated_at?: string; finished_at?: string | null;
  coverage_count?: number; custom_tools?: { name: string; description: string; created_by: string }[];
}
interface Change { id: string; kind: "chapter" | "outline" | "worldview"; action: "create" | "edit" | "delete"; title: string; number: number | null; chars: number; note: string; undone: boolean; created_at?: string }
interface ServerEvent extends Record<string, unknown> { seq: number; at?: string }
interface Settings { workflow: WorkflowId; choice: ModelChoice; effort: string; rounds: number; untilPass: boolean; deslop: boolean; maxChapters: number; words: number | null; autoSummary: boolean; useMemory: boolean; autoResume: boolean; budget: number; contextBudget: number; parallel: number }

const SETTINGS_KEY = "book-agent:settings";
const DEFAULTS: Settings = { workflow: "auto", choice: { provider: "", model: "" }, effort: "", rounds: 2, untilPass: false, deslop: false, maxChapters: 0, words: null, autoSummary: true, useMemory: true, autoResume: true, budget: 0, contextBudget: 0, parallel: 3 };
const ACTIVE: Status[] = ["running", "waiting", "stopping"];
const POLL_MS = 1500;
const HIDDEN_POLL_MS = 6000;
const RESUME_POLL_MS = 15000;
const CONTROL = "w-full min-w-0 rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/15 disabled:opacity-60";
const STATUS: Record<Status, [string, string, string]> = {
  running: ["运行中", "Running", "run"], waiting: ["等你回复", "Waiting for you", "warn"], stopping: ["正在停止", "Stopping", "warn"],
  done: ["已完成", "Done", "ok"], stopped: ["已停止", "Stopped", "warn"], interrupted: ["已中断", "Interrupted", "warn"],
  failed: ["出错", "Failed", "bad"], refused: ["已拒绝", "Refused", "bad"],
};
const EXAMPLES: [string, string][] = [
  ["按“本书大纲”从下一章开始往后写，大纲写到哪就写到哪。", "Write on from the next chapter, following the book outline to its end."],
  ["先续写 10 章大纲，再按新大纲写出这 10 章正文。", "Extend the outline by 10 chapters, then write those chapters."],
  ["通读第 1–5 章，把前后矛盾的称呼和设定改一致，改动列给我看。", "Read chapters 1–5 and fix inconsistent names and settings."],
];

function readSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    return { ...DEFAULTS, ...saved,
      workflow: workflowId(saved.workflow),
      rounds: typeof saved.rounds === "number" ? saved.rounds : DEFAULTS.rounds,
      parallel: typeof saved.parallel === "number" && Number.isFinite(saved.parallel) ? Math.min(16, Math.max(1, Math.floor(saved.parallel))) : DEFAULTS.parallel,
      contextBudget: typeof saved.contextBudget === "number" && Number.isFinite(saved.contextBudget) ? Math.min(2000000, Math.max(0, Math.floor(saved.contextBudget))) : DEFAULTS.contextBudget,
      effort: effortFrom(saved.effort), untilPass: saved.untilPass === true, deslop: saved.deslop === true, autoResume: saved.autoResume !== false };
  } catch { return DEFAULTS; }
}
const isActive = (status?: Status) => Boolean(status && ACTIVE.includes(status));
const timeOf = (value?: string) => { const parsed = value ? Date.parse(value) : NaN; return Number.isNaN(parsed) ? undefined : parsed; };

/** 全自动智能体：选一本书作为工作区，交代任务后智能体自己读、写、改，直到判断任务完成。任务在后台运行，切换页面不中断。 */
export default function BookAgentWorkspace({ novelId }: { novelId: string }) {
  const zh = useLocale() !== "en";
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState("");
  const base = `/api/novels/${novelId}/book-agent`;
  const loadJobs = useCallback(async () => (await apiGet<{ jobs: Job[] }>(`${base}/jobs`)).jobs, [base]);
  useEffect(() => {
    let current = true;
    void loadJobs().then((rows) => {
      if (!current) return;
      setJobs(rows);
      const pick = rows.find((row) => isActive(row.status)) ?? rows[0];
      if (pick) setJobId(pick.id); else setComposing(true);
    }).catch((failure) => { if (current) setError((failure as Error).message); });
    return () => { current = false; };
  }, [loadJobs]);
  const refreshJobs = useCallback(() => { void loadJobs().then(setJobs).catch(() => undefined); }, [loadJobs]);
  const busy = Boolean(jobs?.some((row) => isActive(row.status)));
  // 新任务和历史任务都保留入口，旧任务的改动仍可撤销。
  const started = (job: Job) => { setJobs((rows) => [job, ...(rows ?? [])]); setJobId(job.id); setComposing(false); refreshJobs(); };
  const ended = () => { refreshJobs(); setComposing(true); };
  const focusWorkflow = !composing && isActive(jobs?.find((row) => row.id === jobId)?.status);
  const historyControl = Boolean(jobs?.length) && <label className="flex flex-wrap items-center gap-2 text-sm">{zh ? "任务与回退记录" : "Tasks and undo history"}
    <select data-testid="book-agent-history" className={`${CONTROL} min-w-0 max-w-xl`} value={composing ? "" : jobId ?? ""}
      onChange={(event) => { if (event.target.value) { setJobId(event.target.value); setComposing(false); } }}>
      <option value="" disabled>{zh ? "选择历史任务查看改动与撤销" : "Choose a task to review or undo"}</option>
      {jobs?.map((row) => <option key={row.id} value={row.id}>{row.created_at ? new Date(row.created_at).toLocaleString() : ""} · {row.instruction.slice(0, 45)}</option>)}
    </select>
  </label>;

  return <section data-book-agent-workspace data-workflow-focused={focusWorkflow ? "true" : "false"} className="h-full min-h-0 overflow-y-auto lg:overflow-hidden">
    <div className={`mx-auto flex min-h-0 w-full max-w-[96rem] flex-col lg:h-full ${focusWorkflow ? "gap-3 p-3" : "gap-4 p-4 pb-12 sm:p-6"}`}>
      {!focusWorkflow && <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{zh ? "全自动智能体" : "Autonomous agent"}</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">{zh ? "把这本书交给智能体：它自己读正文、概要和大纲，写新章、改旧章、续写大纲，直到判断任务完成。每一处改动都会列出来，可以逐条撤销。普通续写仍在“小说续写”里，不受影响。" : "Hand the whole book to the agent. It reads, writes and edits until it judges the task done; every change is listed and can be undone."}</p>
        </div>
      </header>}
      {!focusWorkflow && historyControl}
      {error && <p role="alert" className="rounded-xl border border-danger/30 p-3 text-sm text-danger">{error}</p>}
      {jobs === null && !error ? <p role="status" className="text-sm text-muted">{zh ? "读取中…" : "Loading…"}</p>
        : composing ? <StartForm novelId={novelId} busy={busy} onStarted={started} onCancel={jobs?.length ? () => setComposing(false) : undefined} />
        : jobId ? <JobPanel key={jobId} novelId={novelId} jobId={jobId} onChanged={refreshJobs} onEnd={ended} historyControl={focusWorkflow ? historyControl : null} /> : null}
    </div>
  </section>;
}

/** 新任务：任务要求、模型、每章审查、篇幅与上限。设置和没发出的要求记在本机。 */
function StartForm({ novelId, busy, onStarted, onCancel }: { novelId: string; busy: boolean; onStarted: (job: Job) => void; onCancel?: () => void }) {
  const zh = useLocale() !== "en";
  const draftKey = `book-agent:draft:${novelId}`;
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [context, setContext] = useState<BookContext>(EMPTY_CONTEXT);
  const [instruction, setInstruction] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setSettings(readSettings());
    try { setInstruction(localStorage.getItem(draftKey) ?? ""); } catch { /* 草稿只是方便，读不到就从空白开始 */ }
  }, [draftKey]);
  const update = (patch: Partial<Settings>) => setSettings((current) => {
    const next = { ...current, ...patch };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* 同上 */ }
    return next;
  });
  const edit = (value: string) => { setInstruction(value); try { localStorage.setItem(draftKey, value); } catch { /* 同上 */ } };
  const start = async () => {
    if (!instruction.trim() || sending || busy) return;
    setSending(true); setError("");
    try {
      const job = await apiPost<Job>(`/api/novels/${novelId}/book-agent/jobs`, {
        instruction: instruction.trim(),
        settings: {
          ...context, workflow: settings.workflow,
          provider: settings.choice.provider, model: settings.choice.model, ...(settings.effort ? { reasoning_effort: settings.effort } : {}),
          review_rounds: settings.rounds, review_until_pass: settings.untilPass, deslop: settings.deslop, max_new_chapters: Math.max(0, Math.floor(settings.maxChapters || 0)),
          target_words: settings.words && settings.words > 0 ? Math.floor(settings.words) : null, auto_summary: settings.autoSummary, use_memory: settings.useMemory,
          auto_resume: settings.autoResume, token_budget: Math.max(0, Math.floor(settings.budget || 0)),
          parallel_agents: Math.min(16, Math.max(1, Math.floor(settings.parallel || 1))),
          context_budget: Math.min(2000000, Math.max(0, Math.floor(settings.contextBudget || 0))),
        },
      });
      try { localStorage.removeItem(draftKey); } catch { /* 同上 */ }
      setBookBusy(novelId, "agent", true);
      onStarted(job);
    } catch (failure) { setError((failure as Error).message); } finally { setSending(false); }
  };
  return <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] lg:overflow-y-auto lg:pr-2" data-testid="book-agent-start">
    <section className="space-y-3 rounded-2xl border border-border bg-surface p-4 sm:p-5">
      <h2 className="font-semibold">{zh ? "交代任务" : "Task"}</h2>
      <textarea data-testid="book-agent-instruction" aria-label={zh ? "任务要求" : "Task"} rows={9} className={`${CONTROL} resize-y leading-7`} value={instruction} disabled={sending}
        placeholder={zh ? "写清楚要做什么、做到哪里为止。" : "Say what to do and where to stop."}
        onChange={(event) => edit(event.target.value)} onKeyDown={(event) => { if (isSubmitShortcut(event)) { event.preventDefault(); void start(); } }} />
      <div className="flex flex-wrap gap-2">{EXAMPLES.map(([text, en]) => <button key={text} type="button" className="rounded-full border border-border px-3 py-1 text-left text-xs text-muted hover:border-accent hover:text-foreground"
        onClick={() => edit(instruction.trim() ? `${instruction.trim()}\n${zh ? text : en}` : zh ? text : en)}>{zh ? text : en}</button>)}</div>
      <p className="text-xs leading-5 text-muted">{zh ? "智能体会直接写入这本书：新章追加在书尾，修改保存为新版本，删除进回收站。每一处改动都会列在任务旁边，可以逐条撤销。运行中可以随时留言调整方向，也可以停止，之后从中断处继续。" : "The agent writes straight into the book. Every change is listed and can be undone. You can leave messages, stop, and resume later."}</p>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {busy && <p role="status" className="text-sm text-muted">{zh ? "这本书已有一个任务在运行，先停止它才能开始新任务。" : "Another task is running on this book."}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" data-testid="book-agent-start-button" isDisabled={!instruction.trim() || sending || busy} onPress={() => void start()}>{sending ? (zh ? "正在启动…" : "Starting…") : (zh ? "开始执行" : "Start")}</Button>
        {onCancel && <Button variant="ghost" onPress={onCancel}>{zh ? "返回上一个任务" : "Back to last task"}</Button>}
      </div>
    </section>
    <section className="space-y-4 rounded-2xl border border-border bg-surface p-4 sm:p-5">
      <h2 className="font-semibold">{zh ? "模型与写法" : "Model"}</h2>
      <BookContextPicker novelId={novelId} value={context} onChange={setContext} disabled={sending || busy} />
      <ModelPicker value={settings.choice} onChange={(choice) => update({ choice })} disabled={sending} />
      <WorkflowPicker novelId={novelId} scope="book-agent" value={settings.workflow} onChange={(workflow) => update({ workflow })} disabled={sending} testId="book-agent-workflow" />
      <EffortSelect value={settings.effort} onChange={(effort) => update({ effort })} provider={settings.choice.provider} disabled={sending} testId="book-agent-effort" />
      <ReviewModeControls rounds={settings.rounds} untilPass={settings.untilPass} disabled={sending} label={zh ? "每章写完后的自我审查轮数（0 为不审查）" : "Self-review rounds per chapter"} ariaLabel={zh ? "每章审查轮数" : "Review rounds"}
        selectClassName={CONTROL} onChange={(patch) => update({ ...(patch.rounds !== undefined ? { rounds: patch.rounds } : {}), ...(patch.untilPass !== undefined ? { untilPass: patch.untilPass } : {}) })} />
      <DeslopToggle checked={settings.deslop} disabled={sending} onChange={(deslop) => update({ deslop })} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-xs text-muted"><span>{zh ? "最多新写几章（0 为不限）" : "Max new chapters (0 = no limit)"}</span>
          <input type="number" min={0} data-testid="book-agent-max" className={CONTROL} value={settings.maxChapters} disabled={sending} onChange={(event) => update({ maxChapters: Number(event.target.value) || 0 })} /></label>
        <label className="grid gap-1 text-xs text-muted"><span>{zh ? "每章篇幅（留空按剧情）" : "Words per chapter"}</span>
          <input type="number" min={1} className={CONTROL} value={settings.words ?? ""} disabled={sending} placeholder={zh ? "按剧情自然展开" : "As needed"} onChange={(event) => update({ words: event.target.value ? Number(event.target.value) : null })} /></label>
      </div>
      <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={settings.autoSummary} disabled={sending} onChange={(event) => update({ autoSummary: event.target.checked })} />
        <span>{zh ? "每章写完自动生成概要" : "Summarise each new chapter"}<span className="block text-muted">{zh ? "概要会保存到新章；已有前文仍严格按关联范围读取。" : "Later chapters read summaries instead of full text."}</span></span></label>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={settings.useMemory} disabled={sending} onChange={(event) => update({ useMemory: event.target.checked })} />{zh ? "参考已记住的写作偏好（含大纲写法）" : "Use remembered writing preferences"}</label>
      <label className="grid gap-1 text-xs text-muted"><span>{zh ? "同时工作的子智能体数（1 为逐段进行）" : "Sub-agents working at once (1 = one part at a time)"}</span>
        <select data-testid="book-agent-parallel" className={CONTROL} value={settings.parallel} disabled={sending} onChange={(event) => update({ parallel: Number(event.target.value) })}>
          {Array.from({ length: 16 }, (_, index) => index + 1).map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <span>{zh ? "互不依赖的审改可并行。使用电脑时建议选 1–3，空闲时可提高到 8–16；运行中也能调整。接着书尾写新章、续写大纲仍逐段进行，删除章节在整批完成后统一执行。实际并发还受模型服务及全局上限影响。" : "Independent revisions can run in parallel. Choose 1–3 while using the computer, or 8–16 when it is idle; you can also adjust this during a run. New chapters and outlines stay sequential, and deletions wait until the batch ends. Actual concurrency also depends on the model service and global limit."}</span></label>
      <label className="grid gap-1 text-xs text-muted"><span>{zh ? "每次运行的用量上限（token，0 为不限）" : "Token budget per run (0 = no limit)"}</span>
        <input type="number" min={0} step={100000} data-testid="book-agent-budget" className={CONTROL} value={settings.budget} disabled={sending} onChange={(event) => update({ budget: Number(event.target.value) || 0 })} />
        <span>{zh ? "含子智能体和写手。用到上限就停下，改动都已保存，调高后可以继续。读取资料还受你选择的关联范围限制。" : "Includes sub-agents and writers. The run stops at the limit with all changes saved."}</span></label>
      <label className="grid gap-1 text-xs text-muted"><span>{zh ? "上下文预算（字数，0 为默认 15 万字）" : "Context budget in characters (0 = default 150k)"}</span>
        <input type="number" min={0} max={2000000} step={10000} data-testid="book-agent-context" className={CONTROL} value={settings.contextBudget} disabled={sending} onChange={(event) => update({ contextBudget: Math.min(2000000, Math.max(0, Number(event.target.value) || 0)) })} />
        <span>{zh ? "对话历史超过这个长度就整理一次，只保留任务、计划、笔记和书的现状，丢掉早期的查阅记录。模型上下文窗口较小时可以调低，避免超限；整理会让提示缓存重新计算一次。" : "The conversation is compacted once it passes this length, keeping the task, plan, notes and the book's current state. Lower it for models with a small context window. Each compaction rebuilds the prompt cache once."}</span></label>
      <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" data-testid="book-agent-auto-resume" checked={settings.autoResume} disabled={sending} onChange={(event) => update({ autoResume: event.target.checked })} />
        <span>{zh ? "没做完时自动接着做" : "Resume automatically when unfinished"}<span className="block text-muted">{zh ? "连接中断、模型停住或软件关闭导致任务没做完时，自动从中断处继续。手动停止的任务不会自动继续。" : "Picks up after dropped connections, stalls or a restart. Tasks you stop stay stopped."}</span></span></label>
      <p className="text-xs leading-5 text-muted">{zh ? "任务很长时，智能体会自己拆成几段交给子智能体，子智能体还能再往下分；每一层都能写新章、修改和删除章节，改动同样列在右侧、可以撤销。现有工具不够用时，它会自己写脚本、造新工具（只能读书和计算）。审查全书或指定章节时，没读到的章节不会被当成已经查过。" : "Long tasks are split into parts for sub-agents, which can split further. Every level can write, edit and delete chapters; all changes are listed and can be undone. When its tools fall short it writes its own read-only scripts and tools."}</p>
      <LibraryManager novelId={novelId} />
    </section>
  </div>;
}

/** 服务端过程记录 → 前端过程条目：去掉序号，时刻换成毫秒，按同一套规则并入时间线。 */
function merge(items: TraceItem[], events: ServerEvent[], zh: boolean): TraceItem[] {
  return events.reduce((rows, event) => {
    const { seq, at, ...data } = event;
    void seq;
    return traceReducer(rows, "trace", data, zh, timeOf(at));
  }, items);
}

/** 一个任务：左边是过程时间线，右边是当前进展、留言、改动列表（可撤销）和工作笔记。按序号轮询，只取新的记录。 */
function JobPanel({ novelId, jobId, onChanged, onEnd, historyControl }: { novelId: string; jobId: string; onChanged: () => void; onEnd: () => void; historyControl?: ReactNode }) {
  const zh = useLocale() !== "en";
  const active = useContext(RetainedViewActive);
  const visible = useRef(active);
  useEffect(() => { visible.current = active; }, [active]);
  const base = `/api/novels/${novelId}/book-agent/jobs/${jobId}`;
  const questionOwner = `book-job-${novelId}-${jobId}`;
  const [job, setJob] = useState<Job | null>(null);
  const [items, setItems] = useState<TraceItem[]>([]);
  const [changes, setChanges] = useState<Change[]>([]);
  const [memoryProposals, setMemoryProposals] = useState<MemoryProposal[]>([]);
  const [libraryIds, setLibraryIds] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [concurrencyNotice, setConcurrencyNotice] = useState("");
  // 继续时用的模型和写法：默认沿用这个任务上次的设置，可以在这里换。
  const [next, setNext] = useState<BookContext & { workflow: WorkflowId; choice: ModelChoice; effort: string; rounds: number; untilPass: boolean; deslop: boolean; parallel: number; contextBudget: number } | null>(null);
  const seq = useRef(0);
  const changeCount = useRef<number | null>(null);
  const lastStatus = useRef<Status | undefined>(undefined);
  const liveBox = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    // 改动指纹：没变时后端不再返回整份改动列表。每次重新开始轮询都先取一次完整列表。
    let seen = "";
    const poll = async () => {
      try {
        const data = await apiGet<{ job: Job; events: ServerEvent[]; more: boolean; changes: Change[] | null; changes_signature?: string }>(
          `${base}?after=${seq.current}${seen ? `&changes_seen=${encodeURIComponent(seen)}` : ""}`);
        if (!alive) return;
        if (data.events.length) {
          seq.current = data.events.at(-1)!.seq;
          const proposals = data.events.filter((event) => event.kind === "memory_proposal").map((event) => {
            const proposal = { ...event } as Record<string, unknown>;
            const id = typeof proposal.id === "string" ? proposal.id : String(event.seq);
            for (const key of ["seq", "at", "kind"]) delete proposal[key];
            return { ...proposal, id } as unknown as MemoryProposal;
          });
          if (proposals.length) setMemoryProposals((current) => [...current, ...proposals.filter((item) => !current.some((old) => old.id === item.id))]);
          const library = data.events.filter((event) => event.kind === "library_proposal" && typeof event.id === "string").map((event) => String(event.id));
          if (library.length) setLibraryIds((current) => [...current, ...library.filter((id) => !current.includes(id))]);
          setItems((rows) => merge(rows, data.events, zh));
        }
        if (lastStatus.current !== undefined && isActive(lastStatus.current) !== isActive(data.job.status)) onChanged();
        lastStatus.current = data.job.status;
        setJob(data.job);
        setNext((current) => current ?? { reference_books: data.job.settings.reference_books ?? [], chapter_ids: data.job.settings.chapter_ids ?? [], outline_ids: data.job.settings.outline_ids ?? [], use_worldview: data.job.settings.use_worldview ?? false, choice: { provider: data.job.settings.provider ?? "", model: data.job.settings.model ?? "" },
          workflow: workflowId(data.job.settings.workflow),
          effort: effortFrom(data.job.settings.reasoning_effort), rounds: data.job.settings.review_rounds ?? 2, untilPass: data.job.settings.review_until_pass === true, deslop: data.job.settings.deslop === true,
          parallel: Math.min(16, Math.max(1, data.job.settings.parallel_agents ?? 3)),
          contextBudget: Math.min(2000000, Math.max(0, data.job.settings.context_budget ?? 0)) });
        if (data.changes) {
          setChanges(data.changes);
          // 智能体改了书：通知已打开的章节编辑、本书大纲等页面重新读取。
          if (changeCount.current !== null && seen !== data.changes_signature) notifyResourceChange({ novelId, source: "manual" });
          changeCount.current = data.changes.length;
        }
        seen = data.changes_signature ?? "";
        setBookBusy(novelId, "agent", isActive(data.job.status));
        setError("");
        if (data.more) { timer = window.setTimeout(poll, 0); return; }
        if (isActive(data.job.status)) timer = window.setTimeout(poll, visible.current ? POLL_MS : HIDDEN_POLL_MS);
        // 已中断的任务可能被后台自动接着做，低频查一下，开始后界面跟着切到运行中。
        else if (data.job.status === "interrupted") timer = window.setTimeout(poll, RESUME_POLL_MS);
      } catch (failure) {
        if (!alive) return;
        setError((failure as Error).message);
        timer = window.setTimeout(poll, HIDDEN_POLL_MS);
      }
    };
    void poll();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [base, novelId, onChanged, tick, zh]);
  useEffect(() => { const box = liveBox.current; if (box) box.scrollTop = box.scrollHeight; }, [job?.live?.text]);
  const pendingQuestionId = job?.status === "waiting" && job.question ? (job.question_id || job.question) : "";
  useEffect(() => () => clearAgentQuestionOwner(questionOwner), [questionOwner]);
  useEffect(() => {
    if (!pendingQuestionId || !job) { clearAgentQuestionOwner(questionOwner); return; }
    registerAgentQuestion(questionOwner, { id: pendingQuestionId, novelId, question: job.question,
      options: job.question_options ?? [], multiSelect: job.question_multi_select === true, source: "book" }, async (answer) => {
      await apiPost(`${base}/messages`, { text: answer, ...(job.question_id ? { question_id: job.question_id } : {}) });
      setTick((value) => value + 1); onChanged();
    }, active);
  }, [active, base, job, novelId, onChanged, pendingQuestionId, questionOwner]);

  const act = async (task: () => Promise<unknown>) => {
    setSending(true); setError("");
    try { await task(); setTick((value) => value + 1); onChanged(); } catch (failure) { setError((failure as Error).message); } finally { setSending(false); }
  };
  const send = () => { const text = message.trim(); if (text) void act(async () => { await apiPost(`${base}/messages`, { text, ...(job?.status === "waiting" && job.question_id ? { question_id: job.question_id } : {}) }); setMessage(""); }); };
  const resume = () => void act(async () => {
    const settings = next ? { reference_books: next.reference_books ?? [], chapter_ids: next.chapter_ids, outline_ids: next.outline_ids, use_worldview: next.use_worldview, workflow: next.workflow, provider: next.choice.provider, model: next.choice.model, reasoning_effort: next.effort || null, review_rounds: next.rounds, review_until_pass: next.untilPass, deslop: next.deslop, parallel_agents: next.parallel, context_budget: next.contextBudget } : undefined;
    await apiPost(`${base}/resume`, { text: message.trim(), ...(settings ? { settings } : {}) }); setMessage(""); setBookBusy(novelId, "agent", true);
  });
  const stop = () => void act(() => apiPost(`${base}/stop`, null));
  const changeConcurrency = (parallel: number) => void act(async () => {
    const updated = await apiPost<Job>(`${base}/concurrency`, { parallel_agents: parallel });
    setJob(updated);
    setNext((current) => current && { ...current, parallel });
    setConcurrencyNotice(zh ? "并发上限已更新。进行中的请求会继续，后续请求按新上限运行。" : "Concurrency updated. Active requests finish; subsequent requests use the new limit.");
    try {
      const saved = readSettings();
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...saved, parallel }));
    } catch { /* 本地记忆失败不影响服务端设置 */ }
  });
  // 结束任务：还在运行就先停下（改动都已保存），然后回到“交代任务”开始下一个。
  const end = async () => {
    if (job && isActive(job.status)) {
      if (!(await confirmDialog({ title: zh ? "结束当前任务？" : "End this task?", message: zh ? "智能体会停下，已经做的改动都保留。之后可以开始新任务。" : "The agent stops; all changes so far are kept.",
        confirmLabel: zh ? "结束任务" : "End task", cancelLabel: zh ? "继续运行" : "Keep running" }))) return;
      setSending(true); setError("");
      try { await apiPost(`${base}/stop`, null); } catch (failure) { setError((failure as Error).message); setSending(false); return; }
      setSending(false);
    }
    onEnd();
  };
  const undo = async (change: Change) => {
    if (!(await confirmDialog({ title: zh ? "撤销这处改动？" : "Undo this change?", message: change.note, confirmLabel: zh ? "撤销" : "Undo", cancelLabel: zh ? "保留" : "Keep" }))) return;
    void act(async () => { await apiPost(`${base}/changes/${change.id}/undo`, null); notifyResourceChange({ novelId, source: "manual" }); });
  };
  const undoAll = async () => {
    if (!(await confirmDialog({ title: zh ? "撤销这次任务的全部改动？" : "Undo all changes from this task?",
      message: zh ? "原有正文和大纲恢复到本次任务前，新建章节移入回收站。若之后有其他修改，会先提示冲突，不覆盖它们。" : "Restore existing text and outlines, and recycle chapters created by this task. Later edits are protected by version checks.",
      confirmLabel: zh ? "撤销本次全部改动" : "Undo entire task", cancelLabel: zh ? "保留" : "Keep" }))) return;
    void act(async () => {
      try { await apiPost(`${base}/undo`, null); }
      finally { notifyResourceChange({ novelId, source: "manual" }); }
    });
  };

  const batch = useMemo(() => activeBatch(items), [items]);
  if (!job) return <p role="status" className="text-sm text-muted">{error || (zh ? "读取中…" : "Loading…")}</p>;
  const running = job.status === "running" || job.status === "stopping";
  const live = isActive(job.status);
  const outcome: RunOutcome = live ? null : job.status === "done" ? "done" : job.status === "failed" || job.status === "refused" ? "error" : "stopped";
  const timeline: TraceItem[] = [...items.filter((item) => item.kind !== "plan" && item.kind !== "usage" && (item.kind as string) !== "library_proposal"),
    ...(job.plan.length ? [{ kind: "plan", items: job.plan } as Kind<"plan">] : []),
    { kind: "usage", input: job.usage.input ?? 0, output: job.usage.output ?? 0, total: job.usage.total ?? 0, calls: job.usage.calls ?? 0, estimated: job.usage.estimated, steps: job.steps, cost: job.usage.cost, currency: job.usage.currency, cache_read: job.usage.cache_read, cache_write: job.usage.cache_write } as Kind<"usage">];
  const reviewLog = live ? null : { passed: null, stopped_reason: job.report || job.error || STATUS[job.status][zh ? 0 : 1], rounds: [] };
  const [statusText, , tone] = STATUS[job.status];
  const stats = job.stats;
  const model = [job.settings.provider, job.settings.model].filter(Boolean).join(" / ");
  const stopButton = live ? <Button size="sm" variant="danger-soft" data-testid="book-agent-stop" isDisabled={sending || job.status === "stopping"} onPress={stop}>{zh ? "停止" : "Stop"}</Button>
    : job.status !== "refused" && <Button size="sm" variant="primary" data-testid="book-agent-resume" isDisabled={sending} onPress={resume}>{job.status === "done" ? (zh ? "接着做" : "Continue") : (zh ? "从中断处继续" : "Resume")}</Button>;
  const endButton = <Button size="sm" variant="secondary" data-testid="book-agent-end" isDisabled={sending || job.status === "stopping"} onPress={() => void end()}>{zh ? "结束任务" : "End task"}</Button>;
  const concurrencyControl = live && <div className="space-y-1" data-testid="book-agent-concurrency-control">
    <label className="flex items-center gap-2 text-xs text-muted"><span>{zh ? "并发上限" : "Concurrency"}</span>
      <select data-testid="book-agent-live-parallel" aria-label={zh ? "运行中的子智能体并发上限" : "Active sub-agent concurrency"} className={`${CONTROL} w-auto py-1.5`} value={job.settings.parallel_agents ?? 3} disabled={sending || job.status === "stopping"} onChange={(event) => changeConcurrency(Number(event.target.value))}>
        {Array.from({ length: 16 }, (_, index) => index + 1).map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
    </label>
    {concurrencyNotice && <p role="status" className="text-xs text-muted">{concurrencyNotice}</p>}
  </div>;
  const question = job.status === "waiting" && job.question && <section role="alert" data-testid="book-agent-question" className="space-y-2 rounded-2xl border border-accent/50 bg-accent/5 p-4">
    <p className="text-xs font-semibold text-accent">{zh ? "智能体在等你回答" : "The agent is asking"}</p><p className="whitespace-pre-wrap text-sm leading-6">{job.question}</p>
    <Button size="sm" variant="secondary" data-testid="book-agent-answer-options" onPress={() => reopenAgentQuestion(questionOwner, pendingQuestionId)}>{zh ? "选择并回答" : "Choose and answer"}</Button></section>;
  const history = historyControl && <details data-testid="book-agent-history-toggle" className="min-w-0 rounded-xl border border-border bg-surface px-3 py-2 text-xs">
    <summary className="cursor-pointer text-muted">{zh ? "任务与回退记录" : "Tasks and undo history"}</summary>
    <div className="pt-2">{historyControl}</div>
  </details>;

  // 几段同时进行：右侧的详细信息收成顶部一条，主区域横向并排显示各段；整批结束后回到原来的布局。
  if (batch && live) {
    const statusLine = job.status_text || (zh ? "子智能体正在同时工作…" : "Sub-agents are working…");
    return <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 lg:overflow-hidden" data-testid="book-agent-job" data-status={job.status} data-layout="parallel">
      <section className="aw-frame aw-parallel-bar" data-running={running ? "true" : "false"}>
        <span className="aw-pill" data-tone={tone} data-testid="book-agent-status">{zh ? statusText : STATUS[job.status][1]}</span>
        {model && <span className="aw-model" title={model}>{model}</span>}
        <p className="aw-bar-status text-muted" role="status" title={statusLine}>{statusLine}</p>
        <span className="aw-stat" title={zh ? "全部完成后可以逐条查看和撤销" : "Review and undo after the batch finishes"}>{zh ? `已改动 ${changes.length} 处` : `${changes.length} changes`}</span>
        <div className="aw-bar-message">
          <input data-testid="book-agent-message" className={`${CONTROL} py-1.5`} value={message} disabled={sending} aria-label={job.status === "waiting" ? (zh ? "回答智能体" : "Answer") : (zh ? "给智能体留言" : "Message the agent")}
            placeholder={job.status === "waiting" ? (zh ? "回答智能体的问题" : "Answer the question") : (zh ? "留言，每段下一步都会收到" : "Message every part")}
            onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} />
          <Button size="sm" variant="secondary" data-testid="book-agent-send" isDisabled={sending || !message.trim()} onPress={send}>{job.status === "waiting" ? (zh ? "回答" : "Answer") : (zh ? "发送" : "Send")}</Button>
        </div>
        {stopButton}
        {endButton}
        {concurrencyControl}
        {history}
        {error && <p role="alert" className="w-full text-sm text-danger">{error}</p>}
      </section>
      {question}
      <ParallelBoard items={items} lanes={batch} running={running || job.status === "waiting"} />
    </div>;
  }

  return <div className="grid min-h-0 min-w-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:overflow-hidden" data-testid="book-agent-job" data-status={job.status}>
    <div className="flex min-h-0 min-w-0 flex-col max-lg:max-h-[70dvh] lg:h-full">
      <AgentTimeline items={timeline} running={running} outcome={outcome} reviewLog={reviewLog} startedAt={timeOf(job.created_at)} testId="book-agent-trace" planInScroll />
    </div>
    <div className="min-h-0 min-w-0 space-y-4 lg:h-full lg:overflow-y-auto lg:overscroll-contain lg:pr-1">
      {history}
      <section className="aw-frame space-y-3 p-4" data-running={running ? "true" : "false"}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="aw-pill" data-tone={tone} data-testid="book-agent-status">{zh ? statusText : STATUS[job.status][1]}</span>
          {model && <span className="aw-model" title={model}>{model}</span>}
          {job.runs > 1 && <span className="text-xs text-muted">{zh ? `第 ${job.runs} 次运行` : `Run ${job.runs}`}</span>}
          <span className="flex-1" />
          {live && stopButton}
          <Button size="sm" variant="secondary" data-testid="book-agent-undo-last" isDisabled={sending || live || !changes.some((change) => !change.undone)} onPress={() => { const last = [...changes].reverse().find((change) => !change.undone); if (last) void undo(last); }}>{zh ? "撤销上一步改动" : "Undo last change"}</Button>
          <Button size="sm" variant="danger-soft" data-testid="book-agent-undo-all" isDisabled={sending || live || !changes.some((change) => !change.undone)} onPress={() => void undoAll()}>{zh ? "撤销本次全部改动" : "Undo entire task"}</Button>
          {endButton}
        </div>
        <p className="text-sm leading-6" role="status">{live ? (job.status_text || (zh ? "智能体正在工作…" : "Working…")) : job.status === "done" ? (zh ? "智能体认为任务已经完成。" : "The agent finished the task.") : (job.error || statusText)}</p>
        <p data-testid="book-agent-saved-count" className="text-xs text-muted">{zh ? `实际保存 ${changes.filter((change) => !change.undone).length} 处改动 · 已撤销 ${changes.filter((change) => change.undone).length} 处。${live ? "停止任务后可回退。" : "没有保存记录就代表尚未实际改书。"}` : `${changes.filter((change) => !change.undone).length} saved changes; ${changes.filter((change) => change.undone).length} undone.${live ? " Stop the task before undoing." : " No saved changes means the book has not been edited."}`}</p>
        {concurrencyControl}
        {job.live?.text && <div className="space-y-1"><p className="text-xs text-muted">{job.live.label}</p>
          <pre ref={liveBox} data-testid="book-agent-live" className="workspace-scrollbar max-h-56 overflow-y-auto whitespace-pre-wrap rounded-xl border border-border bg-background p-3 font-sans text-sm leading-7">{job.live.text}</pre></div>}
        <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
          {[[zh ? "新写章节" : "New chapters", stats.chapters_written ?? 0], [zh ? "新写字数" : "Words", compactNumber(stats.chars_written ?? 0)],
            [zh ? "修订 / 修改" : "Revised / edits", `${stats.chapters_revised ?? 0} / ${stats.edits ?? 0}`], [zh ? "新增章纲" : "Outlines", stats.outlines_written ?? 0],
            [zh ? "读过正文的章" : "Chapters read", job.coverage_count ?? 0], [zh ? "自造工具" : "Own tools", job.custom_tools?.length ?? 0]]
            .map(([name, value]) => <div key={String(name)} className="rounded-lg border border-border px-2 py-1.5"><dt className="text-muted">{name}</dt><dd className="font-mono text-sm tabular-nums">{value}</dd></div>)}
        </dl>
      </section>
      {memoryProposals.length > 0 && <MemoryProposalPrompt novelId={novelId} proposals={memoryProposals} />}
      {libraryIds.length > 0 && <LibraryProposalPrompt novelId={novelId} ids={libraryIds} />}
      {question}
      {(job.report && !live) && <section className="space-y-1 rounded-2xl border border-border bg-surface p-4"><p className="text-xs font-semibold text-muted">{zh ? "完成报告" : "Report"}</p>
        <p data-testid="book-agent-report" className="whitespace-pre-wrap text-sm leading-6">{job.report}</p></section>}
      <section className="space-y-2 rounded-2xl border border-border bg-surface p-4">
        <label className="grid gap-2 text-sm"><span className="font-medium">{job.status === "waiting" ? (zh ? "回答智能体" : "Answer") : live ? (zh ? "给智能体留言" : "Message the agent") : (zh ? "补充要求后继续（可留空）" : "Add a note and continue (optional)")}</span>
          <textarea data-testid="book-agent-message" rows={3} className={`${CONTROL} resize-y leading-6`} value={message} disabled={sending || job.status === "refused"}
            placeholder={live ? (zh ? "留言会在它下一步时交给它。" : "It reads your message at its next step.") : (zh ? "写下接下来要做什么，可以留空。" : "What to do next (optional).")}
            onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (isSubmitShortcut(event)) { event.preventDefault(); if (live) send(); else resume(); } }} /></label>
        {live && <Button size="sm" variant="secondary" data-testid="book-agent-send" isDisabled={sending || !message.trim()} onPress={send}>{job.status === "waiting" ? (zh ? "发送回答" : "Send answer") : (zh ? "发送留言" : "Send")}</Button>}
        {!live && job.status !== "refused" && next && <div className="grid gap-3 border-t border-border pt-3" data-testid="book-agent-resume-settings">
          <p className="text-xs text-muted">{zh ? "这次运行用的模型和写法（默认沿用上次，可以换）" : "Model and settings for this run (defaults to the last run)"}</p>
          <BookContextPicker novelId={novelId} value={next} onChange={(context) => setNext((current) => current && { ...current, ...context })} disabled={sending} />
          <ModelPicker value={next.choice} onChange={(choice) => setNext((current) => current && { ...current, choice })} disabled={sending} />
          <WorkflowPicker novelId={novelId} scope="book-agent" value={next.workflow} onChange={(workflow) => setNext((current) => current && { ...current, workflow })} disabled={sending} testId="book-agent-resume-workflow" />
          <EffortSelect value={next.effort} onChange={(effort) => setNext((current) => current && { ...current, effort })} provider={next.choice.provider} disabled={sending} testId="book-agent-resume-effort" />
          <ReviewModeControls rounds={next.rounds} untilPass={next.untilPass} disabled={sending} label={zh ? "每章写完后的自我审查轮数（0 为不审查）" : "Self-review rounds per chapter"} ariaLabel={zh ? "每章审查轮数" : "Review rounds"}
            selectClassName={CONTROL} onChange={(patch) => setNext((current) => current && { ...current, ...(patch.rounds !== undefined ? { rounds: patch.rounds } : {}), ...(patch.untilPass !== undefined ? { untilPass: patch.untilPass } : {}) })} />
          <DeslopToggle checked={next.deslop} disabled={sending} onChange={(deslop) => setNext((current) => current && { ...current, deslop })} />
          <label className="grid gap-1 text-xs text-muted"><span>{zh ? "继续时同时工作的子智能体数" : "Sub-agents working at once"}</span>
            <select data-testid="book-agent-resume-parallel" className={CONTROL} value={next.parallel} disabled={sending} onChange={(event) => setNext((current) => current && { ...current, parallel: Math.min(16, Math.max(1, Number(event.target.value))) })}>
              {Array.from({ length: 16 }, (_, index) => index + 1).map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-xs text-muted"><span>{zh ? "上下文预算（字数，0 为默认）" : "Context budget in characters (0 = default)"}</span>
            <input type="number" min={0} max={2000000} step={10000} data-testid="book-agent-resume-context" className={CONTROL} value={next.contextBudget} disabled={sending} onChange={(event) => setNext((current) => current && { ...current, contextBudget: Math.min(2000000, Math.max(0, Number(event.target.value) || 0)) })} />
          </label>
          <div>{stopButton}</div>
        </div>}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </section>
      <section className="space-y-2 rounded-2xl border border-border bg-surface p-4" data-testid="book-agent-changes">
        <h3 className="flex items-center justify-between text-sm font-semibold"><span>{zh ? "对这本书的改动" : "Changes to the book"}</span><span className="font-mono text-xs text-muted">{changes.length}</span></h3>
        {!changes.length ? <p className="text-xs text-muted">{zh ? "智能体还没有改动这本书。" : "No changes yet."}</p> :
          <ol className="max-h-80 space-y-1.5 overflow-y-auto text-sm">{[...changes].reverse().map((change) => <li key={change.id} data-change={change.action} className="flex flex-wrap items-start gap-2 rounded-lg border border-border px-2 py-1.5">
            <span aria-hidden="true" className="mt-0.5 shrink-0 font-mono text-[11px] text-muted">{change.kind === "worldview" ? (zh ? "世界观" : "WORLD") : change.kind === "chapter" ? (zh ? "正文" : "TXT") : (zh ? "大纲" : "OUT")}</span>
            <span className={`text-fill ${change.undone ? "text-muted line-through" : ""}`}>{change.note || change.title}</span>
            {change.undone ? <span className="shrink-0 text-xs text-muted">{zh ? "已撤销" : "Undone"}</span>
              : <button type="button" className="shrink-0 text-xs text-accent disabled:opacity-50" disabled={sending || live} onClick={() => void undo(change)}>{zh ? "撤销" : "Undo"}</button>}
          </li>)}</ol>}
      </section>
      {Boolean(job.custom_tools?.length) && <details className="rounded-2xl border border-border bg-surface p-4 text-sm" data-testid="book-agent-own-tools"><summary className="cursor-pointer font-medium">{zh ? "这次任务里自造的工具" : "Tools made in this task"}</summary>
        <ul className="mt-2 space-y-1 text-sm">{job.custom_tools!.map((tool) => <li key={tool.name}><span className="font-mono text-xs">{tool.name}</span> · <span className="text-muted">{tool.description}</span></li>)}</ul></details>}
      {job.notes && <details className="rounded-2xl border border-border bg-surface p-4 text-sm"><summary className="cursor-pointer font-medium">{zh ? "智能体的工作笔记" : "Agent notes"}</summary>
        <pre className="mt-2 whitespace-pre-wrap font-sans text-sm leading-6 text-muted">{job.notes}</pre></details>}
      <details className="rounded-2xl border border-border bg-surface p-4 text-sm"><summary className="cursor-pointer font-medium">{zh ? "任务要求" : "Task"}</summary>
        <p className="mt-2 whitespace-pre-wrap leading-6 text-muted">{job.instruction}</p></details>
    </div>
  </div>;
}
