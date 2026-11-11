"use client";

import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocale } from "next-intl";
import { copyText } from "@/lib/clipboard";
import { Loader } from "@/components/shared/Loader";
import { compactNumber, formatCost, inflightChars, liveLabel, stepOf, traceLogText, TRACE_ICONS, type Kind, type RunState, type TraceItem, type TraceReviewLog } from "./AgentTrace";
import "./agent-workbench.css";

/** 一次运行怎样结束：done 交稿，stopped 被作者停止，error 出错；null 表示还没跑过或正在跑。 */
export type RunOutcome = "done" | "stopped" | "error" | null;
export type PhaseId = "prepare" | "research" | "plan" | "draft" | "review" | "revise" | "deliver";
type PhaseState = "idle" | "active" | "done" | "skipped" | "halted";

export const PHASES: { id: PhaseId; zh: string; en: string; icon: string }[] = [
  { id: "prepare", zh: "接收任务", en: "Brief", icon: "status" },
  { id: "research", zh: "查阅资料", en: "Research", icon: "search" },
  { id: "plan", zh: "规划", en: "Plan", icon: "plan" },
  { id: "draft", zh: "起草", en: "Draft", icon: "draft" },
  { id: "review", zh: "自我审查", en: "Review", icon: "review" },
  { id: "revise", zh: "修改", en: "Revise", icon: "edit" },
  { id: "deliver", zh: "交稿", en: "Deliver", icon: "check" },
];

const TOOL_PHASE: Record<string, PhaseId> = {
  list_chapters: "research", read_chapter: "research", read_chapters: "research", list_outline: "research", read_outline: "research", search_book: "research",
  list_story_resources: "research", read_story_resource: "research", list_memories: "research", read_memory: "research", delegate: "research",
  plan_writing: "plan", update_plan: "plan", compose_draft: "draft", write_draft: "draft", edit_draft: "revise", reflect: "revise",
  review_draft: "review", read_draft: "review", save_memory: "deliver", finish: "deliver",
};

const ICON_EXTRA: Record<string, string> = {
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  book: "M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20",
  memory: "M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2zM9 21h6",
  flag: "M4 22V4M4 4h13l-2 4 2 4H4",
};
const iconPath = (name: string) => ICON_EXTRA[name] ?? TRACE_ICONS[name] ?? TRACE_ICONS.status;

/** 旧草稿里的工具行没有 tool 字段，只能按中文说明推断它属于哪一阶段。 */
function phaseFromLabel(label: string): PhaseId | null {
  if (/审查|送审|审稿/.test(label)) return "review";
  if (/修订|修改|返修|反思/.test(label)) return "revise";
  if (/起草|草稿|写作/.test(label)) return "draft";
  if (/规划|任务书|计划/.test(label)) return "plan";
  if (/阅读|搜索|查看|查阅|查找|读取|核对|子智能体|偏好/.test(label)) return "research";
  if (/通过|交稿|已完成/.test(label)) return "deliver";
  return null;
}

/** 一条记录属于哪个阶段；思考、实时文字和用量不改变当前阶段，返回 null。drafts 是它之前已有几份草稿。 */
function phaseOf(item: TraceItem, drafts: number): PhaseId | null {
  switch (item.kind) {
    case "tool": return item.tool === "workflow" ? "prepare" : (item.tool && TOOL_PHASE[item.tool]) || phaseFromLabel(item.label);
    case "live": return item.channel === "args" && item.tool ? TOOL_PHASE[item.tool] ?? null : null;
    case "draft": return drafts > 0 ? "revise" : "draft";
    case "edit": return "revise";
    case "review": return "review";
    case "subagent": return "research";
    case "plan": return "plan";
    case "status":
      if (item.stage === "revise") return "revise";
      if (item.stage) return "review";
      return phaseFromLabel(item.label);
    default: return null;
  }
}

export interface PhaseView { id: PhaseId; label: string; icon: string; state: PhaseState; count: number }

/** 按过程记录推算每个阶段：走过的为 done（可多次进入，count 为次数），当前的为 active，被跳过的为 skipped。 */
export function computePhases(items: TraceItem[], running: boolean, outcome: RunOutcome, reviewLog: TraceReviewLog | null | undefined, zh: boolean): { phases: PhaseView[]; current: PhaseId | null } {
  const visits: Record<PhaseId, number> = { prepare: 0, research: 0, plan: 0, draft: 0, review: 0, revise: 0, deliver: 0 };
  let current: PhaseId | null = items.length || running ? "prepare" : null;
  let drafts = 0;
  let previous: PhaseId | null = null;
  if (current) visits.prepare = 1;
  for (const item of items) {
    const phase = phaseOf(item, drafts);
    if (item.kind === "draft") drafts += 1;
    if (!phase) continue;
    // 同一阶段连续多条（例如连读三章）只算一次进入。
    if (phase !== previous) visits[phase] += 1;
    previous = phase;
    current = phase;
  }
  if (!items.some((item) => item.kind === "review") && reviewLog?.rounds.length) visits.review = Math.max(visits.review, reviewLog.rounds.length);
  if (outcome === "done") { visits.deliver = Math.max(1, visits.deliver); current = "deliver"; }
  const reached = current ? PHASES.findIndex((phase) => phase.id === current) : -1;
  const phases = PHASES.map((phase, index): PhaseView => {
    let state: PhaseState = "idle";
    if (phase.id === current && running) state = "active";
    else if (phase.id === current && (outcome === "stopped" || outcome === "error")) state = "halted";
    else if (visits[phase.id]) state = "done";
    else if (index < reached) state = "skipped";
    return { id: phase.id, label: zh ? phase.zh : phase.en, icon: phase.icon, state, count: visits[phase.id] };
  });
  return { phases, current };
}

/** 运行中每秒刷新的当前时刻；不在运行时停住不动。 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, 1000);
    return () => { window.clearTimeout(first); window.clearInterval(timer); };
  }, [active]);
  return now;
}

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

/** 超过这么多秒没有新的过程记录，就说明一下可能的原因，免得看起来像卡死。 */
const QUIET_NOTICE_SECONDS = 20;

/** 过程记录的“指纹”：条目数和最后一条的类型、文字长度、状态。心跳只刷新状态文字、不产生条目，不改变指纹。 */
function signatureOf(items: TraceItem[]): string {
  const rows = items.filter((item) => item.kind !== "usage");
  const last = rows.at(-1);
  if (!last) return "0";
  const text = "text" in last && typeof last.text === "string" ? last.text.length : 0;
  const label = "label" in last && typeof last.label === "string" ? last.label : "";
  const state = "state" in last ? String(last.state ?? "") : "";
  return `${rows.length}|${last.kind}|${label}|${text}|${state}`;
}

/** 运行中距上一次过程记录变化已经过去的秒数；不在运行时为 0。 */
function useQuietSeconds(items: TraceItem[], running: boolean): number {
  const now = useNow(running);
  const signature = signatureOf(items);
  const [mark, setMark] = useState({ signature, at: 0 });
  if (running && now && (mark.signature !== signature || !mark.at)) setMark({ signature, at: now });
  return running && mark.at ? Math.max(0, Math.floor((now - mark.at) / 1000)) : 0;
}

const quietNote = (seconds: number, zh: boolean) => zh
  ? `当前步骤仍在处理（已持续 ${seconds} 秒）。中转服务可能正在缓冲或生成较长内容；若连接中断，会自动恢复本步，已完成的进度不会丢失。`
  : `This step is still running (${seconds}s). The relay may be buffering a long response. If the connection drops, this step will resume automatically and completed progress will be kept.`;
const duration = (ms: number) => ms < 10000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : ms < 60000 ? `${Math.round(ms / 1000)}s` : clock(ms);

/** 运行的起点：优先用宿主记下的开始时刻，旧草稿退回第一条有时刻的记录。 */
function startOf(items: TraceItem[], startedAt?: number | null): number | undefined {
  return startedAt ?? items.find((item) => item.at !== undefined)?.at;
}

/** 已结束运行的总时长：所有记录里最晚的时刻减去起点。 */
function lastMoment(items: TraceItem[]): number | undefined {
  let last: number | undefined;
  for (const item of items) for (const value of [item.at, item.end]) if (value !== undefined && (last === undefined || value > last)) last = value;
  return last;
}

interface RunStats { steps: number; tools: number; reviews: number; drafts: number; inTokens: number; outTokens: number; approximate: boolean; calls: number; total: number; cost?: number | null; currency?: string | null }

function statsOf(items: TraceItem[], running: boolean, reviewLog?: TraceReviewLog | null): RunStats {
  const usage = items.find((item): item is Kind<"usage"> => item.kind === "usage");
  const estimate = running ? Math.round(inflightChars(items) / 1.6) : 0;
  const reviewItems = items.filter((item) => item.kind === "review").length;
  return {
    steps: stepOf(items),
    tools: items.filter((item) => item.kind === "tool" && item.tool !== "workflow").length,
    reviews: reviewItems || reviewLog?.rounds.length || 0,
    drafts: items.filter((item) => item.kind === "draft").length,
    inTokens: usage?.input ?? 0,
    outTokens: (usage?.output ?? 0) + estimate,
    approximate: estimate > 0 || Boolean(usage?.estimated),
    calls: usage?.calls ?? 0,
    total: usage?.total ?? 0,
    cost: usage?.cost,
    currency: usage?.currency,
  };
}

function Svg({ name, className = "aw-ico", spin = false }: { name: string; className?: string; spin?: boolean }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
    className={className} data-spin={spin ? "true" : undefined}><path d={iconPath(name)} /></svg>;
}

/** 一句话说明当前状态：运行中显示后端的进度，结束后显示流程名和结束原因。 */
function headlineOf(running: boolean, status: string, outcome: RunOutcome, reviewLog: TraceReviewLog | null | undefined, zh: boolean, hasItems: boolean): string {
  if (running) return status || (zh ? "智能体思考中…" : "Thinking…");
  const name = zh ? reviewLog?.workflow_name : reviewLog?.workflow_name_en;
  if (outcome === "stopped") return [name, zh ? "已停止，收到的文字已保留" : "Stopped. Received text was kept"].filter(Boolean).join(" · ");
  if (outcome === "error") return [name, zh ? "未完成，可查看过程后重试" : "Not finished. Check the log and retry"].filter(Boolean).join(" · ");
  if (outcome === "done" || reviewLog) return [name, reviewLog?.stopped_reason || (zh ? "已完成" : "Done")].filter(Boolean).join(" · ");
  return hasItems ? (zh ? "上次运行的记录" : "Previous run") : (zh ? "等待任务：在“续写设置”里写好大纲后开始" : "Waiting for a task");
}

/** 工作台顶栏：返回设置、任务名、停止/重新生成、阶段流水线和实时状态。 */
export function AgentConsoleBar({ items, running, status, outcome, reviewLog, kicker, title, model, onBack, onStop, action }: {
  items: TraceItem[]; running: boolean; status: string; outcome: RunOutcome; reviewLog?: TraceReviewLog | null;
  kicker: string; title: string; model: string; onBack: () => void; onStop: () => void; action?: ReactNode;
}) {
  const zh = useLocale() !== "en";
  const { phases } = computePhases(items, running, outcome, reviewLog, zh);
  const quiet = useQuietSeconds(items, running);
  const headline = headlineOf(running, status, outcome, reviewLog, zh, items.length > 0);
  const tone = running ? "run" : outcome === "error" ? "bad" : outcome === "stopped" ? "warn" : outcome === "done" || reviewLog ? "ok" : "idle";
  // 运行结束（包括重新打开时看到的上次记录）就收成一行，把高度让给下面的过程记录和正文。
  const settled = !running && Boolean(outcome || reviewLog || items.length);
  const [phasePreference, setPhasePreference] = useState({ running, open: running });
  const phasesOpen = phasePreference.running === running ? phasePreference.open : running;
  const collapsed = settled && !phasesOpen;
  return <section data-testid="agent-console" className="aw-console aw-frame" data-running={running ? "true" : "false"} data-settled={settled ? "true" : "false"} data-collapsed={collapsed ? "true" : "false"} data-phases-open={phasesOpen ? "true" : "false"} aria-label={zh ? "智能体工作台" : "Agent workbench"}>
    <div className="aw-console-top">
      <button type="button" className="aw-back" onClick={onBack}><Svg name="caret" className="aw-ico aw-back-ico" />{zh ? "续写设置" : "Setup"}</button>
      <Loader active={running} size={collapsed ? "md" : "lg"} className="aw-loader" />
      <div className="aw-heading">
        <p className="aw-kicker">AGENT · {kicker}</p>
        <h2 className="aw-title">{title}{collapsed && <span className="aw-summary" role="status" data-tone={tone}>{headline}</span>}</h2>
      </div>
      <span className="aw-pill" data-tone={tone}>{running ? (zh ? "运行中" : "Running") : tone === "ok" ? (zh ? "已交稿" : "Delivered") : tone === "bad" ? (zh ? "出错" : "Error") : tone === "warn" ? (zh ? "已停止" : "Stopped") : (zh ? "待命" : "Standby")}</span>
      {model && <span className="aw-model" title={model}>{model}</span>}
      <div className="aw-actions">
        {settled && <button type="button" className="aw-back" data-testid="agent-phases-toggle" aria-expanded={phasesOpen} aria-controls="agent-phase-list" onClick={() => setPhasePreference({ running, open: !phasesOpen })}>{phasesOpen ? (zh ? "收起进度" : "Hide progress") : (zh ? "展开进度" : "Show progress")}</button>}
        {running ? <button type="button" className="aw-stop" onClick={onStop}><span aria-hidden="true" className="aw-stop-square" />{zh ? "停止生成" : "Stop"}</button> : action}
      </div>
    </div>
    {(!settled || phasesOpen) && <ol id="agent-phase-list" className="aw-phases" aria-label={zh ? "工作阶段" : "Phases"}>
      {phases.map((phase) => <li key={phase.id} className="aw-phase" data-phase={phase.id} data-state={phase.state}>
        <span className="aw-phase-node"><Svg name={phase.state === "done" && phase.id === "deliver" ? "check" : phase.icon} className="aw-ico" spin={phase.state === "active"} /></span>
        <span className="aw-phase-label">{phase.label}{phase.count > 1 ? <em>×{phase.count}</em> : null}</span>
      </li>)}
    </ol>}
    {!collapsed && <p className="aw-ticker" role="status" data-tone={tone}><span aria-hidden="true">{running ? "▸" : tone === "ok" ? "✓" : "·"}</span><span className="aw-ticker-text">{headline}</span>{quiet >= QUIET_NOTICE_SECONDS && <span className="aw-quiet">{zh ? ` · 已 ${quiet} 秒没有新内容` : ` · nothing new for ${quiet}s`}</span>}</p>}
  </section>;
}
const TOOL_ICON: Record<string, string> = {
  list_chapters: "book", read_chapter: "book", read_chapters: "book", list_outline: "plan", read_outline: "plan", search_book: "search",
  list_story_resources: "subagent", read_story_resource: "subagent", list_memories: "memory", read_memory: "memory", save_memory: "memory",
  delegate: "subagent", plan_writing: "plan", compose_draft: "draft", review_draft: "review", read_draft: "draft", reflect: "thought", workflow: "flag",
  write_chapter: "draft", revise_chapter: "edit", revise_chapters: "edit", replace_in_chapters: "edit", edit_chapter: "edit", rename_chapter: "edit", delete_chapter: "x", summarize_chapter: "book",
  generate_outline: "plan", add_outline: "plan", rewrite_outline: "plan", edit_outline: "edit", delete_outline: "x",
  update_notes: "memory", ask_author: "thought", author: "flag", finish: "flag",
};
const ROLE = { researcher: ["资料员", "Researcher"], auditor: ["核对员", "Auditor"], writer: ["写手", "Writer"], reviser: ["修订", "Reviser"], outliner: ["大纲", "Outliner"],
  worker: ["子智能体", "Sub-agent"], subworker: ["孙智能体", "Sub-sub-agent"] } as const;
const SEVERITY: Record<string, [string, string]> = { high: ["严重", "high"], medium: ["中", "medium"], low: ["轻", "low"] };
/** 长任务只渲染最近这么多条顶层记录，更早的点“显示更早的记录”再展开；复制过程记录仍是全部。 */
const RENDER_LIMIT = 300;

type Row = { row: TraceItem; index: number };
interface NodeContext { running: boolean; zh: boolean; start?: number; lanes: Map<string, Row[]>; onAdopt?: (text: string) => void; compact?: boolean }
/** 并排显示时，每栏里嵌套的写手、修订只保留最近这么多条记录。 */
const COMPACT_CHILDREN = 4;

/** 长文字默认收起；内容始终在 DOM 里，展开只改变显示高度。 */
function Clamp({ text, limit = 260, className = "" }: { text: string; limit?: number; className?: string }) {
  const zh = useLocale() !== "en";
  const [open, setOpen] = useState(false);
  const long = text.length > limit;
  return <div className={className}>
    <p className="aw-text" data-clamped={long && !open ? "true" : undefined}>{text}</p>
    {long && <button type="button" className="aw-link" onClick={() => setOpen(!open)}>{open ? (zh ? "收起" : "Less") : (zh ? "展开全文" : "More")}</button>}
  </div>;
}

function StateTag({ state, running, zh }: { state?: RunState; running: boolean; zh: boolean }) {
  const shown = (state === "running" || state === "queued") && !running ? "stopped" : state;
  if (!shown) return null;
  const text = { queued: zh ? "排队中" : "queued", running: zh ? "执行中" : "running", done: zh ? "完成" : "done", error: zh ? "失败" : "failed", stopped: zh ? "已中断" : "stopped", incomplete: zh ? "没读完" : "incomplete" }[shown];
  return <span className="aw-tag" data-tone={shown}>{text}</span>;
}

function Meta({ item, ctx }: { item: TraceItem; ctx: NodeContext }) {
  const offset = item.at !== undefined && ctx.start !== undefined ? clock(item.at - ctx.start) : null;
  // 不足 0.1 秒的耗时没有意义（例如没有实时预览的思考），不显示。
  const took = item.at !== undefined && item.end !== undefined && item.end - item.at >= 100 ? duration(item.end - item.at) : null;
  if (!offset && !took) return null;
  return <span className="aw-meta">{offset && <span>+{offset}</span>}{took && <span>{ctx.zh ? "耗时" : "took"} {took}</span>}</span>;
}

function ScoreRing({ score, passed }: { score: number; passed: boolean }) {
  const value = Math.max(0, Math.min(10, score));
  return <span className="aw-score" data-passed={passed ? "true" : "false"} style={{ ["--aw-score" as string]: `${value * 36}deg` }}><b>{value}</b></span>;
}

function ReviewBody({ round, score, passed, summary, issues, zh, meta }: { round: number; score: number; passed: boolean; summary: string; issues: { problem: string; suggestion?: string; severity?: string }[]; zh: boolean; meta?: ReactNode }) {
  return <div className="aw-review">
    <ScoreRing score={score} passed={passed} />
    <div className="aw-review-main">
      <div className="aw-node-head"><span className="aw-node-title">{zh ? `第 ${round} 次审查` : `Review ${round}`} · {score}/10 · <span className="aw-verdict" data-passed={passed ? "true" : "false"}>{passed ? (zh ? "通过" : "passed") : (zh ? "未通过" : "not passed")}</span></span>{meta}</div>
      {summary && <p className="aw-text">{summary}</p>}
      {issues.length > 0 && <ol className="aw-issues">{issues.map((issue, index) => <li key={index} data-severity={issue.severity ?? "medium"}>
        {issue.severity && SEVERITY[issue.severity] && <span className="aw-sev">{SEVERITY[issue.severity][zh ? 0 : 1]}</span>}
        <span>{index + 1}. {issue.problem}{issue.suggestion ? ` — ${issue.suggestion}` : ""}</span>
      </li>)}</ol>}
    </div>
  </div>;
}

const nodeKey = (item: TraceItem, index: number) => item.kind === "live" ? `live:${item.id}:${item.channel}` : item.kind === "tool" && item.id ? `tool:${item.id}`
  : item.kind === "subagent" ? `sub:${item.id}` : `${item.kind}:${index}`;
const visible = (item: TraceItem, running: boolean) => item.kind !== "plan" && item.kind !== "usage" && (item.kind !== "live" || running);
const agentOf = (item: TraceItem) => "agent" in item ? item.agent : undefined;

/** 按归属分好的泳道：每条子智能体泳道下有哪些记录（含下一层的子智能体）。一次遍历建好，节点渲染时直接取。 */
function laneMap(items: TraceItem[], running: boolean): { lanes: Map<string, Row[]>; ids: Set<string> } {
  const ids = new Set<string>();
  for (const item of items) if (item.kind === "subagent") ids.add(item.id);
  const lanes = new Map<string, Row[]>();
  items.forEach((row, index) => {
    const owner = agentOf(row);
    if (!owner || !ids.has(owner) || !visible(row, running) || (row.kind === "subagent" && row.id === owner)) return;
    const list = lanes.get(owner);
    if (list) list.push({ row, index }); else lanes.set(owner, [{ row, index }]);
  });
  return { lanes, ids };
}

/** 时间线上的一个节点。data-trace-kind 只放在真实的过程记录上，测试和复制都按它计数。记录没变时不重新渲染。 */
const TimelineNode = memo(function TimelineNode({ item, ctx, delay }: { item: TraceItem; ctx: NodeContext; delay?: number }) {
  const { running, zh } = ctx;
  const node = (kind: string, icon: string, body: ReactNode, extra: Record<string, string | undefined> = {}) =>
    <li data-trace-kind={kind} className="aw-node" data-tone={extra.tone ?? kind} data-state={extra.state} data-error={extra.error}
      style={delay ? { animationDelay: `${delay}ms` } : undefined}>
      <span className="aw-pin"><Svg name={icon} spin={extra.state === "running"} /></span>
      <div className="aw-card">{body}</div>
    </li>;
  switch (item.kind) {
    case "thought":
      return node("thought", "thought", <>
        <div className="aw-node-head"><span className="aw-node-title">{zh ? "思考" : "Thinking"}</span><Meta item={item} ctx={ctx} /></div>
        <Clamp text={item.text} className="aw-thought" />
      </>);
    case "live":
      return node("live", item.channel === "thinking" ? "thought" : "live", <>
        <div className="aw-node-head"><span className="aw-node-title">{liveLabel(item, zh)}…</span><Meta item={item} ctx={ctx} /></div>
        <p className="aw-live" data-channel={item.channel}>{item.text.length > 600 ? `…${item.text.slice(-600)}` : item.text}</p>
      </>, { tone: "live", state: "running" });
    case "status":
      return node("status", "status", <div className="aw-node-head"><span className="aw-node-sub">{item.label}</span><Meta item={item} ctx={ctx} /></div>, { tone: "status" });
    case "tool": {
      const live = item.state === "running" && running;
      const failed = item.error || item.state === "error";
      return node("tool", live ? "live" : TOOL_ICON[item.tool ?? ""] ?? "tool", <>
        <div className="aw-node-head">
          <span className="aw-node-title">{item.label}</span>
          {item.tool && item.tool !== "workflow" && <code className="aw-fn">{item.tool}()</code>}
          <StateTag state={item.state} running={running} zh={zh} />
          <Meta item={item} ctx={ctx} />
        </div>
        {item.args && <p className="aw-args">{item.args}</p>}
        {item.result && <p className="aw-result">→ {item.result}</p>}
        {item.text && <details className="aw-more"><summary>{zh ? "查看内容" : "Details"}</summary><pre className="aw-pre">{item.text}</pre></details>}
      </>, { tone: failed ? "error" : "tool", state: live ? "running" : item.state, error: failed ? "true" : undefined });
    }
    case "draft": {
      const streaming = Boolean(item.streaming && running);
      const chars = item.text.replace(/\s/g, "").length;
      return node("draft", "draft", <>
        <div className="aw-node-head"><span className="aw-node-title">{item.label}{streaming ? (zh ? "（生成中）" : " (writing)") : ""}</span><span className="aw-tag" data-tone="draft">{chars} {zh ? "字" : "chars"}</span><Meta item={item} ctx={ctx} /></div>
        {streaming ? <p className="aw-live">{item.text.length > 220 ? `…${item.text.slice(-220)}` : item.text}</p>
          : <details className="aw-more"><summary>{item.text.slice(0, 90).replace(/\s+/g, " ")}{item.text.length > 90 ? "…" : ""}</summary>
            <pre className="aw-pre aw-prose">{item.text}</pre>
            {ctx.onAdopt && !running && <button type="button" className="aw-link" onClick={() => ctx.onAdopt?.(item.text)}>{zh ? "采用这一稿" : "Use this draft"}</button>}
          </details>}
      </>, { state: streaming ? "running" : undefined });
    }
    case "edit":
      return node("edit", "edit", <>
        <div className="aw-node-head"><span className="aw-node-title">{item.label}</span><code className="aw-fn">edit_draft()</code><Meta item={item} ctx={ctx} /></div>
        <div className="aw-diff"><p className="aw-del">{item.old}</p><p className="aw-ins">{item.new}</p></div>
      </>);
    case "review":
      return node("review", "review", <ReviewBody {...item} zh={zh} meta={<Meta item={item} ctx={ctx} />} />, { tone: item.passed ? "pass" : "fail" });
    case "subagent": {
      const all = ctx.lanes.get(item.id) ?? [];
      // 并排的栏里空间有限：嵌套的写手只显示最近几条，展开整段记录要等这一批结束。
      const children = ctx.compact && all.length > COMPACT_CHILDREN ? all.slice(-COMPACT_CHILDREN) : all;
      return node("subagent", "subagent", <>
        <div className="aw-node-head"><span className="aw-node-title">{ROLE[item.role]?.[zh ? 0 : 1] ?? item.role}</span><StateTag state={item.state} running={running} zh={zh} />{item.steps ? <span className="aw-tag">{zh ? `${item.steps} 步` : `${item.steps} steps`}</span> : null}<Meta item={item} ctx={ctx} /></div>
        <p className="aw-text">{item.goal}</p>
        {item.summary && <details className="aw-more"><summary>{zh ? "报告" : "Report"}</summary><pre className="aw-pre">{item.summary}</pre></details>}
        {children.length > 0 && <ol className="aw-lane">{children.map(({ row, index }) => <TimelineNode key={nodeKey(row, index)} item={row} ctx={ctx} />)}</ol>}
      </>, { state: item.state === "running" && running ? "running" : undefined });
    }
    default:
      return null;
  }
});

/** 用时：运行中每秒刷新，单独成一个小组件，时钟走动不会让整条时间线重新渲染。 */
function ElapsedStat({ items, running, start, zh }: { items: TraceItem[]; running: boolean; start?: number; zh: boolean }) {
  const now = useNow(running);
  const end = running ? Math.max(now, start ?? 0) : lastMoment(items);
  if (start === undefined || end === undefined) return null;
  return <span className="aw-stat">{zh ? "用时" : "Time"} {clock(end - start)}</span>;
}

/** 长时间没有新记录时的说明，同样单独计时。 */
function QuietNode({ items, running, zh }: { items: TraceItem[]; running: boolean; zh: boolean }) {
  const quiet = useQuietSeconds(items, running);
  if (!running || quiet < QUIET_NOTICE_SECONDS) return null;
  return <li className="aw-node aw-waiting" data-tone="status" data-state="running">
    <span className="aw-pin"><Loader size="sm" /></span>
    <div className="aw-card"><span className="aw-node-sub">{quietNote(quiet, zh)}</span></div>
  </li>;
}

/** 智能体时间线：统计、计划、逐步出现的过程节点和最终结果。运行时始终跟随最新一步，向上翻看时暂停跟随。 */
/** 交稿方式的小标签：不必再审、分数不再提高、大纲是否写完。原来这些只混在一句结束原因里。 */
function OutcomeTags({ log, zh }: { log?: TraceReviewLog | null; zh: boolean }) {
  if (!log) return null;
  const tags: { key: string; text: string; tone: string; title?: string }[] = [];
  if (log.review_waived) tags.push({ key: "waived", tone: "warn", text: zh ? "智能体判断不必再审" : "Review skipped by the agent", title: log.review_waived });
  if (log.stagnant) tags.push({ key: "stagnant", tone: "warn", text: zh ? "分数不再提高，已停止返修" : "Score stopped improving" });
  if (log.coverage) tags.push(log.coverage.reached_end || !log.coverage.missing?.length
    ? { key: "covered", tone: "ok", text: zh ? "已写到大纲结束点" : "Outline fully covered" }
    : { key: "uncovered", tone: "warn", text: zh ? `大纲还有 ${log.coverage.missing?.length ?? 0} 个事件没写到` : `${log.coverage.missing?.length ?? 0} outline events not written`,
        title: log.coverage.missing?.join("\n") });
  if (!tags.length) return null;
  return <p className="mt-1 flex flex-wrap gap-1.5" data-testid="agent-outcome-tags">{tags.map((tag) =>
    <span key={tag.key} data-tag={tag.key} title={tag.title} className="aw-pill" data-tone={tag.tone}>{tag.text}</span>)}</p>;
}

export function AgentTimeline({ items, running, outcome, reviewLog, startedAt, onAdopt, testId = "agent-trace", planInScroll = false }: {
  items: TraceItem[]; running: boolean; outcome: RunOutcome; reviewLog?: TraceReviewLog | null; startedAt?: number | null; onAdopt?: (text: string) => void; testId?: string; planInScroll?: boolean;
}) {
  const zh = useLocale() !== "en";
  const list = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // 每次新运行开始时恢复跟随最新一步。
  const [wasRunning, setWasRunning] = useState(running);
  if (running !== wasRunning) { setWasRunning(running); if (running) setFollow(true); }
  useEffect(() => {
    const element = list.current;
    if (element && running && follow) element.scrollTop = element.scrollHeight;
  }, [items, running, follow]);
  const start = startOf(items, startedAt);
  const stats = statsOf(items, running, reviewLog);
  const plan = items.find((item): item is Kind<"plan"> => item.kind === "plan")?.items ?? [];
  const { lanes, ids } = useMemo(() => laneMap(items, running), [items, running]);
  const top = useMemo(() => items.map((item, index) => ({ item, index })).filter(({ item }) => visible(item, running) && !ids.has(agentOf(item) ?? "")), [items, running, ids]);
  const hidden = showAll ? 0 : Math.max(0, top.length - RENDER_LIMIT);
  const shown = hidden ? top.slice(hidden) : top;
  const hasReviews = items.some((item) => item.kind === "review");
  const ctx = useMemo<NodeContext>(() => ({ running, zh, start, lanes, onAdopt }), [running, zh, start, lanes, onAdopt]);
  const finished = !running && (outcome || reviewLog);
  // 一次到达多条记录（例如中转服务整段缓冲后一起发来）时，新节点逐条出现，不会一下子跳过好几步。
  const keys = shown.map(({ item, index }) => nodeKey(item, index));
  const [arrival, setArrival] = useState<{ seen: Set<string>; delay: Record<string, number> }>(() => ({ seen: new Set(keys), delay: {} }));
  const fresh = keys.filter((key) => !arrival.seen.has(key));
  if (fresh.length) setArrival({ seen: new Set([...arrival.seen, ...fresh]), delay: { ...arrival.delay, ...Object.fromEntries(fresh.map((key, order) => [key, Math.min(order, 8) * 110])) } });
  const copy = () => { void copyText(traceLogText(items)).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); }).catch(() => undefined); };
  const planPanel = plan.length > 0 && <div className="aw-plan" data-testid="agent-plan">
    <p className="aw-plan-title">{zh ? "智能体的计划" : "Agent plan"} · {plan.filter((entry) => entry.status === "done").length}/{plan.length}</p>
    <ol>{plan.map((entry) => <li key={entry.id} data-status={entry.status}>
      <Svg name={entry.status === "done" ? "check" : entry.status === "cancelled" ? "x" : entry.status === "in_progress" ? "live" : "circle"} spin={entry.status === "in_progress" && running} />
      <span>{entry.text}</span>
    </li>)}</ol>
  </div>;
  return <section data-testid={testId} className="aw-timeline aw-frame" data-running={running ? "true" : "false"} aria-label={zh ? "思考与审查记录" : "Thinking & review"}>
    <div className="aw-panel-head">
      <div><p className="aw-kicker">EXECUTION LOG</p><h3 className="aw-panel-title">{zh ? "思考与审查记录" : "Thinking & review"}</h3></div>
      <div className="aw-tools">
        <button type="button" className="aw-link" onClick={copy} disabled={!items.length}>{copied ? (zh ? "已复制" : "Copied") : (zh ? "复制过程记录" : "Copy log")}</button>
      </div>
    </div>
    <div className="aw-stats">
      {stats.steps > 0 && <span className="aw-stat" data-hot={running ? "true" : undefined}>{running ? (zh ? `第 ${stats.steps} 步` : `Step ${stats.steps}`) : (zh ? `共 ${stats.steps} 步` : `${stats.steps} steps`)}</span>}
      <ElapsedStat items={items} running={running} start={start} zh={zh} />
      {stats.tools > 0 && <span className="aw-stat">{zh ? `工具调用 ${stats.tools}` : `${stats.tools} tool calls`}</span>}
      {stats.reviews > 0 && <span className="aw-stat">{zh ? `审查 ${stats.reviews} 次` : `${stats.reviews} reviews`}</span>}
      {(stats.inTokens > 0 || stats.outTokens > 0) && <span className="aw-stat" data-hot={running ? "true" : undefined} title={stats.approximate ? (zh ? "含估算：模型调用结束后会换成服务商返回的真实用量" : "Includes an estimate until the provider reports exact usage") : undefined}>
        {stats.approximate ? "≈ " : ""}{zh ? "输入" : "in"} {compactNumber(stats.inTokens)} · {zh ? "输出" : "out"} {compactNumber(stats.outTokens)}</span>}
      {stats.calls > 0 && !running && <span className="aw-stat">{zh ? `${stats.calls} 次模型调用` : `${stats.calls} model calls`}</span>}
      {stats.cost != null && stats.currency && <span className="aw-stat" title={zh ? "按设置中的模型单价估算，以供应商账单为准" : "Estimated from configured prices"}>{zh ? "费用约" : "Est. cost"} {formatCost(stats.cost, stats.currency, zh)}</span>}
    </div>
    {!planInScroll && planPanel}
    <div ref={list} className="aw-scroll workspace-scrollbar" onScroll={(event) => { const element = event.currentTarget; const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 48; if (atEnd !== follow) setFollow(atEnd); }}>
      {planInScroll && planPanel}
      {!items.length && !running && <p className="aw-empty">{zh ? "点“按大纲续写”后，这里会逐步显示智能体读了哪些章节、调用了哪些工具、写了几稿、每次审查的分数和问题。" : "Each step the agent takes appears here once you start."}</p>}
      {hidden > 0 && <button type="button" className="aw-link aw-earlier" data-testid="agent-trace-earlier" onClick={() => setShowAll(true)}>{zh ? `显示更早的 ${hidden} 条记录` : `Show ${hidden} earlier entries`}</button>}
      <ol className="aw-track">
        {running && !top.length && <li className="aw-node" data-tone="live" data-state="running"><span className="aw-pin"><Svg name="live" spin /></span><div className="aw-card"><span className="aw-node-title">{zh ? "正在接收任务、准备上下文…" : "Preparing the task…"}</span></div></li>}
        {shown.map(({ item, index }) => { const key = nodeKey(item, index); return <TimelineNode key={key} item={item} ctx={ctx} delay={arrival.delay[key]} />; })}
        <QuietNode items={items} running={running} zh={zh} />
        {!hasReviews && reviewLog?.rounds.map((row) => <li key={`log-${row.round}`} data-trace-kind="review" className="aw-node" data-tone={row.passed ? "pass" : "fail"}>
          <span className="aw-pin"><Svg name="review" /></span><div className="aw-card"><ReviewBody round={row.round} score={row.score} passed={Boolean(row.passed)} summary={row.summary} issues={row.issues} zh={zh} /></div></li>)}
        {finished && <li className="aw-node aw-outcome" data-tone={outcome === "error" ? "error" : outcome === "stopped" ? "warn" : "pass"}>
          <span className="aw-pin"><Svg name={outcome === "error" ? "x" : outcome === "stopped" ? "status" : "flag"} /></span>
          <div className="aw-card"><span className="aw-node-title">{outcome === "stopped" ? (zh ? "已停止" : "Stopped") : outcome === "error" ? (zh ? "运行未完成" : "Not finished") : (zh ? "交稿" : "Delivered")}</span>
            {reviewLog?.stopped_reason && <p className="aw-text">{reviewLog.stopped_reason}</p>}
            <OutcomeTags log={reviewLog} zh={zh} /></div>
        </li>}
      </ol>
    </div>
    {running && !follow && <button type="button" className="aw-follow" onClick={() => setFollow(true)}>{zh ? "↓ 跟随最新一步" : "↓ Follow latest"}</button>}
  </section>;
}

/** 同一批里的一段：编号和总段数从“第 i/N 段：”里读出。 */
export interface BatchLane { item: Kind<"subagent">; part: number; total: number; goal: string }
const PART = /^第 (\d+)\/(\d+) 段：/;
const LANE_ID = /^(.*?)t([0-9a-f]{6})(\d+)$/;

/**
 * 找出正在同时进行的一批子智能体。新任务的事件带 parallel 标记；旧事件没有标记，
 * 同一批里有两段同时处于执行中就算并行。逐段进行的批次同一时刻只有一段在跑，不会被当成并行。
 */
export function activeBatch(items: TraceItem[]): BatchLane[] | null {
  const groups = new Map<string, { parent: string; start: number; lanes: BatchLane[] }>();
  items.forEach((item, index) => {
    if (item.kind !== "subagent" || (item.role !== "worker" && item.role !== "subworker")) return;
    const id = LANE_ID.exec(item.id), part = PART.exec(item.goal);
    if (!id || !part) return;
    const parent = item.agent ?? "";
    const key = `${parent}|${id[1]}t${id[2]}`;
    const group = groups.get(key) ?? { parent, start: index, lanes: [] };
    group.lanes.push({ item, part: Number(part[1]), total: Number(part[2]), goal: item.goal.slice(part[0].length) });
    groups.set(key, group);
  });
  // 上一层在这批开始之后又有了自己的记录（停止、继续、新的一步），说明这批已经结束；
  // 任务被停止时各段收不到结束记录，不能再当成正在进行。
  // 作者在批次进行中调整并发上限时，运行器以总控身份记一条，这一条不代表批次结束。
  const resumed = (parent: string, start: number) => items.some((row, index) => index > start && row.kind !== "subagent"
    && row.kind !== "usage" && (agentOf(row) ?? "") === parent
    && !(row.kind === "tool" && row.label.startsWith("作者将并发上限调整为")));
  let best: BatchLane[] | null = null;
  for (const { parent, start, lanes } of groups.values()) {
    const live = lanes.filter(({ item }) => item.state === "running" || item.state === "queued");
    if (!live.length || resumed(parent, start)) continue;
    const parallel = lanes.some(({ item }) => item.parallel) || lanes.filter(({ item }) => item.state === "running").length > 1;
    if (parallel) best = lanes; // 记录按时间排列，取最后一批（嵌套时是最里层正在跑的那批）
  }
  return best ? [...best].sort((a, b) => a.part - b.part) : null;
}

/** 一段的一栏：标题、这一段自己的过程记录（独立滚动，跟随最新一步）。 */
function LaneColumn({ lane, ctx }: { lane: BatchLane; ctx: NodeContext }) {
  const { item } = lane;
  const box = useRef<HTMLOListElement>(null);
  const rows = ctx.lanes.get(item.id);
  const shown = (rows ?? []).slice(-60);
  useEffect(() => {
    const element = box.current;
    // 只有原本就在底部时才跟随，作者向上翻看某一栏时不打断。
    if (element && element.scrollHeight - element.scrollTop - element.clientHeight < 120) element.scrollTop = element.scrollHeight;
  }, [rows]);
  const live = item.state === "running" && ctx.running;
  return <section className="aw-col aw-frame" data-testid="parallel-lane" data-state={item.state} data-running={live ? "true" : "false"}>
    <header className="aw-col-head">
      <div className="aw-node-head"><span className="aw-node-title">{ctx.zh ? `第 ${lane.part}/${lane.total} 段` : `Part ${lane.part}/${lane.total}`}</span>
        <StateTag state={item.state} running={ctx.running} zh={ctx.zh} />{item.steps ? <span className="aw-tag">{ctx.zh ? `${item.steps} 步` : `${item.steps} steps`}</span> : null}</div>
      <p className="aw-col-goal" title={lane.goal}>{lane.goal}</p>
    </header>
    <ol ref={box} className="aw-col-body aw-track workspace-scrollbar">
      {!shown.length && <li className="aw-node-sub aw-col-empty">{item.state === "queued" ? (ctx.zh ? "等待空位，前面的段完成后开始" : "Waiting for a free slot") : item.state === "running" ? (ctx.zh ? "正在开始…" : "Starting…") : (ctx.zh ? "没有过程记录" : "No steps")}</li>}
      {shown.map(({ row, index }) => <TimelineNode key={nodeKey(row, index)} item={row} ctx={ctx} />)}
    </ol>
    {item.state !== "running" && item.state !== "queued" && item.summary && <p className="aw-col-foot" title={item.summary}>{item.summary}</p>}
  </section>;
}

/** 几段同时进行时的并排视图：每段一栏，各自显示进程；还没开始的段显示为排队。 */
export function ParallelBoard({ items, lanes: batch, running, total }: { items: TraceItem[]; lanes: BatchLane[]; running: boolean; total?: number }) {
  const zh = useLocale() !== "en";
  const { lanes } = useMemo(() => laneMap(items, running), [items, running]);
  const ctx = useMemo<NodeContext>(() => ({ running, zh, start: startOf(items), lanes, compact: true }), [running, zh, items, lanes]);
  const count = total ?? Math.max(...batch.map((lane) => lane.total));
  const known = new Set(batch.map((lane) => lane.part));
  const done = batch.filter(({ item }) => item.state !== "running" && item.state !== "queued").length;
  const working = batch.filter(({ item }) => item.state === "running").length;
  // 旧任务没有排队记录：按总段数补上还没开始的段。
  const missing = Array.from({ length: count }, (_, index) => index + 1).filter((part) => !known.has(part));
  return <section className="aw-board" data-testid="parallel-board" aria-label={zh ? "同时进行的子智能体" : "Parallel sub-agents"}>
    <div className="aw-board-head">
      <p className="aw-kicker">PARALLEL</p>
      <span className="aw-stat" data-hot={running ? "true" : undefined}>{zh ? `${working} 段进行中` : `${working} running`}</span>
      <span className="aw-stat">{zh ? `已完成 ${done}/${count}` : `${done}/${count} done`}</span>
      <span className="aw-node-sub text-xs">{zh ? "全部完成后显示完整报告和改动明细" : "Full reports appear when every part finishes"}</span>
    </div>
    <div className="aw-board-cols workspace-scrollbar">
      {batch.map((lane) => <LaneColumn key={lane.item.id} lane={lane} ctx={ctx} />)}
      {missing.map((part) => <section key={`wait-${part}`} className="aw-col aw-frame" data-testid="parallel-lane" data-state="queued">
        <header className="aw-col-head"><div className="aw-node-head"><span className="aw-node-title">{zh ? `第 ${part}/${count} 段` : `Part ${part}/${count}`}</span><StateTag state="queued" running={running} zh={zh} /></div></header>
        <p className="aw-node-sub aw-col-empty">{zh ? "等待空位，前面的段完成后开始" : "Waiting for a free slot"}</p></section>)}
    </div>
  </section>;
}

/** 设置页上的运行摘要：跑过就显示结果并能打开工作台；没跑过就预告工作流程。 */
export function AgentRunCard({ items, running, outcome, reviewLog, status, onOpen }: {
  items: TraceItem[]; running: boolean; outcome: RunOutcome; reviewLog?: TraceReviewLog | null; status: string; onOpen: () => void;
}) {
  const zh = useLocale() !== "en";
  const stats = statsOf(items, running, reviewLog);
  const hasRun = running || items.length > 0 || Boolean(reviewLog);
  return <div className="aw-runcard aw-frame" data-running={running ? "true" : "false"}>
    <Loader active={running} size="md" className="aw-loader" />
    <div className="min-w-0 flex-1">
      <p className="aw-kicker">WRITING AGENT</p>
      {hasRun ? <>
        <p className="aw-runcard-title">{headlineOf(running, status, outcome, reviewLog, zh, items.length > 0)}</p>
        <p className="aw-runcard-meta">{[stats.steps ? (zh ? `${stats.steps} 步` : `${stats.steps} steps`) : "", stats.tools ? (zh ? `${stats.tools} 次工具调用` : `${stats.tools} tool calls`) : "", stats.reviews ? (zh ? `${stats.reviews} 次审查` : `${stats.reviews} reviews`) : ""].filter(Boolean).join(" · ")}</p>
      </> : <>
        <p className="aw-runcard-title">{zh ? "点“按大纲续写”后自动进入智能体工作台" : "Starting a chapter opens the agent workbench"}</p>
        <ol className="aw-flow">{PHASES.map((phase) => <li key={phase.id}>{zh ? phase.zh : phase.en}</li>)}</ol>
      </>}
    </div>
    {hasRun && <button type="button" className="aw-open" onClick={onOpen}>{running ? (zh ? "查看实时过程" : "Watch live") : (zh ? "打开智能体工作台" : "Open workbench")}</button>}
  </div>;
}
