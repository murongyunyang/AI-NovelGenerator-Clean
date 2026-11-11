"use client";

import { useEffect, useRef, useState } from "react";
import { Loader } from "@/components/shared/Loader";
import { useLocale } from "next-intl";
import { copyText } from "@/lib/clipboard";
import "./agent-console.css";

export type PlanStatus = "pending" | "in_progress" | "done" | "cancelled";
export interface PlanEntry { id: string; text: string; status: PlanStatus }
/** 工具和子智能体的运行状态；stopped 只在界面侧使用，表示运行被中止时它还没有结束。 */
export type RunState = "queued" | "running" | "done" | "error" | "stopped" | "incomplete";
/** 一次请求内所有模型调用的累计用量；steps 是智能体已执行的步数（没有上限）。 */
export interface UsageInfo { input: number; output: number; total: number; calls: number; estimated?: boolean; steps?: number; cost?: number | null; currency?: string | null; priced?: boolean; cache_read?: number; cache_write?: number }
type ReviewIssue = { problem: string; suggestion?: string; severity?: string };
/** 前端收到事件时记下的时间（毫秒）：at 为开始，end 为结束；工作台用它显示每一步的时刻和耗时。旧草稿里没有。 */
type Stamp = { at?: number; end?: number };

/** 智能体过程中的一条记录：思考、实时预览、工具调用、草稿、局部修改、审查、计划、用量、子智能体，或固定流程的状态。全部可 JSON 序列化。 */
export type TraceItem = (
  | { kind: "thought"; text: string; id?: string; agent?: string }
  | { kind: "live"; id: string; channel: "thinking" | "text" | "args"; text: string; tool?: string; agent?: string }
  | { kind: "tool"; label: string; text?: string; error?: boolean; id?: string; state?: RunState; agent?: string; tool?: string; args?: string; result?: string }
  | { kind: "status"; label: string; step?: number; stage?: string }
  | { kind: "draft"; label: string; text: string; streaming?: boolean }
  | { kind: "edit"; label: string; old: string; new: string }
  | { kind: "review"; round: number; score: number; passed: boolean; summary: string; issues: ReviewIssue[] }
  | { kind: "plan"; items: PlanEntry[] }
  | ({ kind: "usage" } & UsageInfo)
  | { kind: "subagent"; id: string; role: "researcher" | "auditor" | "writer" | "reviser" | "outliner" | "worker" | "subworker"; goal: string; state: RunState; summary?: string; steps?: number; agent?: string; parallel?: boolean }
) & Stamp;
export type Kind<K extends TraceItem["kind"]> = Extract<TraceItem, { kind: K }>;

export interface TraceReviewLog { passed: boolean | null; stopped_reason: string; workflow_name?: string; workflow_name_en?: string;
  /** 智能体说明理由后不再送审 */ review_waived?: string; /** 分数连续不再提高而停止 */ stagnant?: boolean;
  /** 交稿前核对大纲是否写完的结果 */ coverage?: { reached_end: boolean; missing?: string[] } | null;
  rounds: { round: number; score: number; passed?: boolean; summary: string; issues: { problem: string; suggestion?:string }[] }[] }

/** 只从作品事件更新正文；思考、工具说明和审查报告不会进入编辑框。 */
export function candidateFromEvent(current: string, event: string, data: Record<string, unknown>): string | null {
  if (event === "done" && (data.answer || data.report)) return null;
  if (event === "delta" && typeof data.text === "string") return current + data.text;
  if ((event === "replacement" || event === "done") && typeof data.text === "string" && data.text.trim()) return data.text;
  return null;
}

const MAX_ITEMS = 400;
const LIVE_LIMIT = 4000;
// 计划、用量和子智能体行是“当前状态”，裁剪时始终保留。
const PINNED = new Set<TraceItem["kind"]>(["plan", "usage", "subagent"]);

function capItems(items: TraceItem[]): TraceItem[] {
  if (items.length <= MAX_ITEMS) return items;
  let drop = items.length - MAX_ITEMS;
  return items.filter((item) => {
    if (PINNED.has(item.kind) || drop <= 0) return true;
    drop -= 1;
    return false;
  });
}

/** 按 match 原位替换（保留原来的开始时刻；从进行中变为结束时记下结束时刻），找不到就追加并记下开始时刻。 */
function upsert(items: TraceItem[], match: (item: TraceItem) => boolean, next: TraceItem, now?: number): TraceItem[] {
  const index = items.findIndex(match);
  if (index < 0) return [...items, now === undefined || next.at !== undefined ? next : { ...next, at: now }];
  const previous = items[index];
  const finished = now !== undefined && "state" in previous && previous.state === "running" && "state" in next && next.state !== "running";
  const merged = { ...next, at: previous.at ?? next.at ?? now, ...(finished ? { end: now } : previous.end !== undefined ? { end: previous.end } : {}) } as TraceItem;
  return items.map((item, position) => position === index ? merged : item);
}

function lastStreamingDraft(items: TraceItem[]): number {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item.kind === "draft" && item.streaming) return index;
  }
  return -1;
}

/** 运行结束、被中止或从草稿恢复时调用：丢掉实时预览，把还在“进行中”的条目定格。没有变化时原样返回同一个数组。 */
export function settleTrace(items: TraceItem[], outcome: "done" | "stopped" = "stopped", now?: number): TraceItem[] {
  const dirty = items.some((item) => item.kind === "live" || (item.kind === "draft" && item.streaming)
    || ((item.kind === "tool" || item.kind === "subagent") && (item.state === "running" || item.state === "queued")));
  if (!dirty) return items;
  const ended = now === undefined ? {} : { end: now };
  return items.filter((item) => item.kind !== "live").map((item): TraceItem => {
    if (item.kind === "draft" && item.streaming) return { ...item, streaming: false, ...ended };
    if ((item.kind === "tool" || item.kind === "subagent") && (item.state === "running" || item.state === "queued")) return { ...item, state: outcome, ...ended };
    return item;
  });
}

/** 把一条 trace 事件并入列表：live / tool / plan / usage / subagent 按 id 或类型原位更新，其余追加。 */
function applyTrace(items: TraceItem[], item: TraceItem, now?: number): TraceItem[] {
  const stamped = <T extends TraceItem>(row: T): T => now === undefined ? row : { ...row, at: row.at ?? now };
  switch (item.kind) {
    case "live": {
      const next: Kind<"live"> = { ...item, text: String(item.text ?? "").slice(-LIVE_LIMIT) };
      return upsert(items, (row) => row.kind === "live" && row.id === next.id && row.channel === next.channel, next, now);
    }
    case "thought": {
      // 每步结束都会发同 id 的 thought：先清掉这一步的实时预览，文字为空就不再添加。思考从实时预览出现时算起。
      const started = item.id ? items.find((row) => row.kind === "live" && row.id === item.id)?.at : undefined;
      const rest = item.id ? items.filter((row) => !(row.kind === "live" && row.id === item.id)) : items;
      if (!item.text?.trim()) return rest;
      return [...rest, now === undefined ? item : { ...item, at: started ?? now, end: now }];
    }
    case "tool":
      return item.id ? upsert(items, (row) => row.kind === "tool" && row.id === item.id, item, now) : [...items, stamped(item)];
    case "plan":
      return upsert(items, (row) => row.kind === "plan", { kind: "plan", items: Array.isArray(item.items) ? item.items : [] }, now);
    case "usage": {
      const previous = items.find((row): row is Kind<"usage"> => row.kind === "usage");
      // 一次调用结束，流式草稿的字数估算改用真实用量，不能再叠加。
      const settled = items.map((row): TraceItem => row.kind === "draft" && row.streaming ? { ...row, streaming: false, ...(now === undefined ? {} : { end: now }) } : row);
      return upsert(settled, (row) => row.kind === "usage", { ...item, steps: item.steps ?? previous?.steps }, now);
    }
    case "subagent": {
      const previous = items.find((row): row is Kind<"subagent"> => row.kind === "subagent" && row.id === item.id);
      return upsert(items, (row) => row.kind === "subagent" && row.id === item.id, { ...previous, ...item }, now);
    }
    default:
      return [...items, stamped(item)];
  }
}

/** 把一条 SSE 事件并入过程记录；正文同时展示在编辑框，日志保留每一稿。now 为收到事件的时刻，传入后条目带上开始与结束时刻。 */
export function traceReducer(items: TraceItem[], event: string, data: Record<string, unknown>, zh: boolean, now?: number): TraceItem[] {
  const at = now === undefined ? {} : { at: now };
  if (event === "trace") return capItems(applyTrace(items, data as unknown as TraceItem, now));
  if (event === "delta") {
    const index = lastStreamingDraft(items);
    const text = String(data.text ?? "");
    if (index >= 0) return items.map((item, position) => position === index && item.kind === "draft" ? { ...item, text: item.text + text } : item);
    return capItems([...items, { kind: "draft", label: zh ? "初稿" : "First draft", text, streaming: true, ...at }]);
  }
  if (event === "replacement") {
    if (data.draft_snapshot) return items; // 工具草稿/局部修改已另有 trace，不重复存全文。
    const count = items.filter((item) => item.kind === "draft").length;
    const settled = items.map((item): TraceItem => item.kind === "draft" && item.streaming ? { ...item, streaming: false, ...(now === undefined ? {} : { end: now }) } : item);
    return capItems([...settled, { kind: "draft", label: zh ? `修改稿 ${count}` : `Revision ${count}`, text: String(data.text ?? ""), ...at }]);
  }
  if (event === "progress" && !data.heartbeat && data.message) {
    const label = String(data.message);
    const step = typeof data.step === "number" ? data.step : undefined;
    const stage = typeof data.review_stage === "string" ? data.review_stage : undefined;
    const last = items.at(-1);
    if (last?.kind === "status" && last.label === label) return items;
    // 带步数的状态只保留最新一条，避免每一步都在时间线上留下一行“第 N 步”。
    const rest = step === undefined ? items : items.filter((item) => !(item.kind === "status" && item.step !== undefined));
    return capItems([...rest, { kind: "status", label, ...(step === undefined ? {} : { step }), ...(stage ? { stage } : {}), ...at }]);
  }
  if (event === "done") {
    const usage = data.usage as Partial<UsageInfo> | undefined;
    const steps = typeof data.steps === "number" ? data.steps : undefined;
    let next = settleTrace(items, "done", now);
    if (steps !== undefined) next = next.filter((item) => !(item.kind === "status" && item.step !== undefined));
    if (!usage && steps === undefined) return next;
    const previous = next.find((item): item is Kind<"usage"> => item.kind === "usage");
    const merged: Kind<"usage"> = { kind: "usage", input: 0, output: 0, total: 0, calls: 0, ...previous, ...usage, steps: steps ?? previous?.steps };
    return upsert(next, (item) => item.kind === "usage", merged, now);
  }
  if (event === "error") return settleTrace(items, "stopped", now);
  return items;
}

export const compactNumber = (value: number) => value >= 10000 ? `${(value / 1000).toFixed(1)}k` : String(value);
const compact = compactNumber;
export function formatCost(cost: number, currency: string, zh: boolean): string {
  try {
    return new Intl.NumberFormat(zh ? "zh-CN" : "en-US", { style: "currency", currency, minimumFractionDigits: 0, maximumFractionDigits: cost < 0.01 ? 6 : 4 }).format(cost);
  } catch { return `${cost.toFixed(6)} ${currency}`; }
}

/** 当前步数：优先用后端报告的步数（没有上限），旧版后端没有时按动作条目数估算。 */
export function stepOf(items: TraceItem[]): number {
  let step = 0;
  let actions = 0;
  for (const item of items) {
    if (item.kind === "status" && item.step !== undefined) step = Math.max(step, item.step);
    else if (item.kind === "usage" && item.steps !== undefined) step = Math.max(step, item.steps);
    else if (["tool", "thought", "draft", "edit", "review"].includes(item.kind)) actions += 1;
  }
  return step || actions;
}

/** 正在进行的模型调用已经流出的字符数；用量事件要等调用结束才到，这段时间只能估算。 */
export function inflightChars(items: TraceItem[]): number {
  let chars = 0;
  for (const item of items) if (item.kind === "live" || (item.kind === "draft" && item.streaming)) chars += item.text.length;
  return chars;
}

/** 给宿主用的一句话小结，例如“用了 12 步 · 输入 12.3k / 输出 4.5k token”。 */
export function runSummary(items: TraceItem[], zh: boolean): string {
  const usage = items.find((item): item is Kind<"usage"> => item.kind === "usage");
  const steps = stepOf(items);
  const parts = [steps ? (zh ? `用了 ${steps} 步` : `${steps} steps`) : ""];
  if (usage?.total) parts.push(zh ? `输入 ${compact(usage.input)} / 输出 ${compact(usage.output)} token` : `in ${compact(usage.input)} / out ${compact(usage.output)} tokens`);
  if (usage?.cost != null && usage.currency) parts.push(`${zh ? "费用约" : "Est. cost"} ${formatCost(usage.cost, usage.currency, zh)}`);
  return parts.filter(Boolean).join(" · ");
}

/** 把一条 `done` 事件里的用量和步数整理成一句话小结（宿主的事件回调里拿不到最新的过程记录，直接用事件数据）。 */
export function doneSummary(data: Record<string, unknown>, zh: boolean): string {
  return runSummary(traceReducer([], "done", data, zh), zh);
}

/** 把过程记录整理成可复制的纯文本。 */
export function traceLogText(items: TraceItem[]): string {
  return items.map((item) => {
    switch (item.kind) {
      case "thought": return `[思考] ${item.text}`;
      case "tool": return `[工具${item.tool ? `·${item.tool}` : ""}] ${item.label}${item.args ? `（${item.args}）` : ""}${item.result ? ` → ${item.result}` : ""}${item.text ? `\n${item.text}` : ""}`;
      case "status": return `[状态] ${item.label}`;
      case "draft": return `[${item.label}] ${item.text.length} 字\n${item.text}`;
      case "edit": return `[${item.label}]\n- ${item.old}\n+ ${item.new}`;
      case "review": return `[第 ${item.round} 次审查] ${item.score}/10 ${item.passed ? "通过" : "未通过"} ${item.summary}${item.issues.map((issue, index) => `\n${index + 1}. ${issue.problem}${issue.suggestion ? ` — ${issue.suggestion}` : ""}`).join("")}`;
      case "plan": return `[计划]\n${item.items.map((entry) => `- [${entry.status}] ${entry.text}`).join("\n")}`;
      case "subagent": return `[子智能体·${item.role}] ${item.goal} (${item.state})${item.summary ? `\n${item.summary}` : ""}`;
      case "usage": return `[用量] 输入 ${item.input} 输出 ${item.output} 合计 ${item.total} 调用 ${item.calls} 次${item.cost != null && item.currency ? ` 参考费用 ${formatCost(item.cost, item.currency, true)}` : ""}`;
      default: return "";
    }
  }).filter(Boolean).join("\n\n");
}

export const TRACE_ICONS: Record<string, string> = {
  thought: "M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z",
  tool: "M4 17l6-6-6-6M12 19h8",
  status: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 6v6l4 2",
  draft: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8",
  edit: "M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z",
  review: "M22 11.1V12a10 10 0 1 1-5.9-9.1M22 4L12 14l-3-3",
  plan: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  subagent: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  live: "M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.2 16.2l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.2 7.8l2.8-2.8",
  circle: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z",
  check: "M20 6L9 17l-5-5",
  x: "M18 6L6 18M6 6l12 12",
  caret: "M6 9l6 6 6-6",
};

function Icon({ name, spin = false, className = "ac-ico" }: { name: string; spin?: boolean; className?: string }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    className={className} style={spin ? { animation: "ac-spin 1s linear infinite" } : undefined}><path d={TRACE_ICONS[name] ?? TRACE_ICONS.status} /></svg>;
}

const agentOf = (item: TraceItem) => "agent" in item ? item.agent : undefined;
/** 计划和用量显示在专门的区域；实时预览只在运行时出现。 */
const shown = (item: TraceItem, running: boolean) => item.kind === "plan" || item.kind === "usage" ? false : item.kind === "live" ? running : true;
const rowKey = (item: TraceItem, index: number) => item.kind === "live" ? `live:${item.id}:${item.channel}` : item.kind === "tool" && item.id ? `tool:${item.id}`
  : item.kind === "subagent" ? `sub:${item.id}` : `${item.kind}:${index}`;

export function liveLabel(item: Kind<"live">, zh: boolean): string {
  if (item.channel === "thinking") return zh ? "思考中" : "Thinking";
  if (item.channel === "text") return zh ? "输出中" : "Writing";
  if (item.tool === "write_draft") return zh ? "正在写草稿" : "Writing a draft";
  if (item.tool === "edit_draft") return zh ? "正在准备局部修改" : "Preparing an edit";
  return zh ? `正在准备调用 ${item.tool || "工具"}` : `Preparing ${item.tool || "a tool"}`;
}

function StateBadge({ state, running, zh }: { state?: RunState; running: boolean; zh: boolean }) {
  const shownState = (state === "running" || state === "queued") && !running ? "stopped" : state;
  if (!shownState || shownState === "done") return null;
  const text = { queued: zh ? "排队中" : "queued", running: zh ? "进行中" : "running", error: zh ? "失败" : "failed", stopped: zh ? "已停止" : "stopped", incomplete: zh ? "没读完" : "incomplete" }[shownState];
  return <span className="ac-badge" data-tone={shownState === "running" ? "run" : shownState === "error" ? "bad" : undefined}>{text}</span>;
}

interface RowContext { running: boolean; zh: boolean; items: TraceItem[]; onAdopt?: (text: string) => void }

/** 时间线上的一行；子智能体行会把属于它的条目嵌套在自己下面。 */
function TraceRow({ item, ctx }: { item: TraceItem; ctx: RowContext }) {
  const { running, zh } = ctx;
  switch (item.kind) {
    case "thought":
      return <li data-trace-kind="thought" className="ac-item"><Icon name="thought" /><p className="ac-main whitespace-pre-wrap text-muted italic">{item.text}</p></li>;
    case "status":
      return <li data-trace-kind="status" className="ac-item"><Icon name="status" /><p className="ac-main text-muted">{item.label}</p></li>;
    case "tool": {
      const live = item.state === "running" && running;
      return <li data-trace-kind="tool" className="ac-item" data-error={item.error || item.state === "error" ? "true" : undefined} data-state={live ? "running" : undefined}>
        <Icon name={live ? "live" : "tool"} spin={live} />
        <div className="ac-main"><p className={item.error ? "text-danger" : "text-muted"}>{item.label}<StateBadge state={item.state} running={running} zh={zh} /></p>
          {item.result && <p className="ac-result">→ {item.result}</p>}
          {item.text && <details><summary className="cursor-pointer text-muted">{zh ? "查看内容" : "View details"}</summary><p className="max-h-60 overflow-y-auto whitespace-pre-wrap text-muted">{item.text}</p></details>}</div>
      </li>;
    }
    case "live":
      return <li data-trace-kind="live" data-live="true" className="ac-item"><Icon name="live" spin />
        <div className="ac-main"><p className="text-muted">{liveLabel(item, zh)}…</p><p className="ac-live" data-channel={item.channel}>{item.text.length > 800 ? `…${item.text.slice(-800)}` : item.text}</p></div></li>;
    case "draft":
      return <li data-trace-kind="draft" className="ac-item"><Icon name="draft" />
        <div className="ac-main"><details><summary className="cursor-pointer">{item.label}{item.streaming && running ? (zh ? "（生成中）" : " (writing)") : ""} · {item.text.length} {zh ? "字" : "chars"}</summary>
          <p className="mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-background p-2 leading-6">{item.text}</p>
          {ctx.onAdopt && !running && <button type="button" className="mt-1 text-accent" onClick={() => ctx.onAdopt?.(item.text)}>{zh ? "采用这一稿" : "Use this draft"}</button>}
        </details></div></li>;
    case "edit":
      return <li data-trace-kind="edit" className="ac-item"><Icon name="edit" />
        <div className="ac-main"><details><summary className="cursor-pointer">{item.label}</summary><p className="mt-1 whitespace-pre-wrap text-danger line-through">{item.old}</p><p className="whitespace-pre-wrap text-accent">{item.new}</p></details></div></li>;
    case "review":
      return <li data-trace-kind="review" className="ac-item"><Icon name="review" /><div className="ac-main"><ReviewRow round={item.round} score={item.score} passed={item.passed} summary={item.summary} issues={item.issues} /></div></li>;
    case "subagent": {
      const children = ctx.items.map((row, index) => ({ row, index })).filter(({ row }) => row.kind !== "subagent" && agentOf(row) === item.id && shown(row, running));
      return <li data-trace-kind="subagent" className="ac-item"><Icon name="subagent" />
        <div className="ac-main"><p><span className="font-medium">{zh ? (item.role === "auditor" ? "审稿员" : "资料员") : item.role}</span> · {item.goal}<StateBadge state={item.state} running={running} zh={zh} />{item.steps ? <span className="ac-badge">{zh ? `${item.steps} 步` : `${item.steps} steps`}</span> : null}</p>
          {item.summary && <details><summary className="cursor-pointer text-muted">{zh ? "报告" : "Report"}</summary><p className="max-h-60 overflow-y-auto whitespace-pre-wrap text-muted">{item.summary}</p></details>}
          {children.length > 0 && <div className="ac-lane"><ol>{children.map(({ row, index }) => <TraceRow key={rowKey(row, index)} item={row} ctx={ctx} />)}</ol></div>}</div></li>;
    }
    default:
      return null;
  }
}

/** 智能体自己维护的计划清单；它想怎么拆步骤都由模型决定，界面只如实显示。 */
function PlanBlock({ plan, running, zh }: { plan: PlanEntry[]; running: boolean; zh: boolean }) {
  const done = plan.filter((entry) => entry.status === "done").length;
  return <div className="ac-plan" data-testid="agent-plan">
    <p className="mb-1 font-medium">{zh ? "计划" : "Plan"} · {done}/{plan.length}</p>
    <ol>{plan.map((entry) => <li key={entry.id} data-status={entry.status}>
      <Icon name={entry.status === "done" ? "check" : entry.status === "cancelled" ? "x" : entry.status === "in_progress" ? "live" : "circle"} spin={entry.status === "in_progress" && running} />
      <span>{entry.text}</span>
    </li>)}</ol>
  </div>;
}

/** 只在运行期间挂载，所以每次运行都从 0 开始计时。 */
function Elapsed({ zh }: { zh: boolean }) {
  const [since] = useState(() => Date.now());
  const [now, setNow] = useState(since);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return <>{seconds >= 60 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : `${seconds}${zh ? " 秒" : "s"}`}</>;
}

/** 智能体控制台：运行时自动展开并实时显示每一步；结束后折叠成一行摘要，展开可看思考、查过的资料、每一稿和每次审查。 */
export function AgentTrace({ items, running, status, reviewLog, onAdopt, onStop, testId = "agent-trace" }: {
  items: TraceItem[]; running: boolean; status: string; reviewLog?: TraceReviewLog | null; onAdopt?: (text: string) => void; onStop?: () => void; testId?: string;
}) {
  const zh = useLocale() !== "en";
  // 用户手动展开或收起以后以用户为准；每次新运行开始时恢复为自动。
  const [manual, setManual] = useState<boolean | null>(null);
  const [wasRunning, setWasRunning] = useState(running);
  if (running !== wasRunning) { setWasRunning(running); if (running) setManual(null); }
  const open = manual ?? running;
  const [copied, setCopied] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    // 运行中且用户没有向上翻看时，始终停在最新一条；新一轮开始（过程记录被清空）时重新跟随。
    const element = list.current;
    if (!items.length) pinned.current = true;
    if (element && running && pinned.current) element.scrollTop = element.scrollHeight;
  }, [items, open, running]);
  if (!items.length && !running && !reviewLog?.rounds.length) return null;
  const plan = items.find((item): item is Kind<"plan"> => item.kind === "plan")?.items ?? [];
  const usage = items.find((item): item is Kind<"usage"> => item.kind === "usage");
  const lanes = new Set(items.flatMap((item) => item.kind === "subagent" ? [item.id] : []));
  const top = items.map((item, index) => ({ item, index })).filter(({ item }) => shown(item, running) && !lanes.has(agentOf(item) ?? ""));
  const steps = stepOf(items);
  const reviews = items.some((item) => item.kind === "review");
  const estimate = running ? Math.round(inflightChars(items) / 1.6) : 0;
  const inTokens = usage?.input ?? 0;
  const outTokens = (usage?.output ?? 0) + estimate;
  const approximate = estimate > 0 || Boolean(usage?.estimated);
  const headline = running ? (status || (zh ? "思考中…" : "Thinking…")) : [zh ? reviewLog?.workflow_name : reviewLog?.workflow_name_en, reviewLog?.stopped_reason || (zh ? "已完成" : "Done")].filter(Boolean).join(" · ");
  const ctx: RowContext = { running, zh, items, onAdopt };
  const copy = () => { void copyText(traceLogText(items)).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); }).catch(() => undefined); };
  return <details data-testid={testId} className="ac-root" data-running={running ? "true" : "false"} open={open}
    onToggle={(event) => { const next = event.currentTarget.open; if (next !== open) setManual(next); }}>
    <summary className="ac-head">
      <span className="ac-row">
        <Loader active={running} size="sm" className="ac-orbit" />
        <span className="ac-title">{zh ? "思考与审查记录" : "Thinking & review"}</span>
        <span className="ac-headline">· {headline}</span>
        {running && onStop && <button type="button" className="ac-stop" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onStop(); }}>{zh ? "停止" : "Stop"}</button>}
        <Icon name="caret" className="ac-ico ac-caret" />
      </span>
      <span className="ac-chips">
        {steps > 0 && <span className="ac-chip" data-hot={running ? "true" : undefined}>{running ? (zh ? `第 ${steps} 步` : `Step ${steps}`) : (zh ? `共 ${steps} 步` : `${steps} steps`)}</span>}
        {running && <span className="ac-chip"><Elapsed zh={zh} /></span>}
        {(inTokens > 0 || outTokens > 0) && <span className="ac-chip" data-hot={running ? "true" : undefined} title={approximate ? (zh ? "含估算：模型调用结束后会换成服务商返回的真实用量" : "Includes an estimate until the provider reports exact usage") : undefined}>
          {approximate ? "≈ " : ""}{zh ? "输入" : "in"} {compact(inTokens)} · {zh ? "输出" : "out"} {compact(outTokens)}</span>}
        {usage?.cache_read !== undefined && <span className="ac-chip" title={zh ? "服务商报告的缓存读取与写入 token，已包含在输入总量中，不重复相加。0 表示尚未命中或上游未报告；折扣与写入价格以服务商账单为准。" : "Provider-reported cached reads and writes, already included in input tokens. Zero means no hit yet or no report. Rates depend on the provider."}>{zh ? "缓存读取" : "cache read"} {compact(usage.cache_read)} · {zh ? "写入" : "written"} {compact(usage.cache_write ?? 0)}</span>}
        {usage?.cost != null && usage.currency && <span className="ac-chip" title={zh ? "按设置中的模型单价估算，以供应商账单为准" : "Estimated from configured model prices; provider billing is authoritative"}>{zh ? "费用约" : "Est."} {formatCost(usage.cost, usage.currency, zh)}</span>}
      </span>
    </summary>
    <div className="ac-body">
      <div className="ac-tools">
        <button type="button" className="ac-link" onClick={copy}>{copied ? (zh ? "已复制" : "Copied") : (zh ? "复制过程记录" : "Copy log")}</button>
        {usage && usage.calls > 0 && <span>{zh ? `${usage.calls} 次模型调用 · 合计 ${compact(usage.total)} token` : `${usage.calls} model calls · ${compact(usage.total)} tokens`}{usage.cost != null && usage.currency ? ` · ${zh ? "费用约" : "Est. cost"} ${formatCost(usage.cost, usage.currency, zh)}` : ""}</span>}
      </div>
      {plan.length > 0 && <PlanBlock plan={plan} running={running} zh={zh} />}
      <ol ref={list} className="ac-list workspace-scrollbar" onScroll={(event) => { const element = event.currentTarget; pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48; }}>
        {top.map(({ item, index }) => <TraceRow key={rowKey(item, index)} item={item} ctx={ctx} />)}
        {!reviews && reviewLog?.rounds.map((row) => <li key={`log-${row.round}`} data-trace-kind="review" className="ac-item"><Icon name="review" /><div className="ac-main"><ReviewRow round={row.round} score={row.score} passed={Boolean(row.passed)} summary={row.summary} issues={row.issues} /></div></li>)}
      </ol>
    </div>
  </details>;
}

function ReviewRow({ round, score, passed, summary, issues }: { round: number; score: number; passed: boolean; summary: string; issues: ReviewIssue[] }) {
  const zh = useLocale() !== "en";
  return <div className="rounded-lg border border-border p-2">
    <p>{zh ? `第 ${round} 次审查` : `Review ${round}`} · {score}/10 · <span className={passed ? "text-accent" : "text-danger"}>{passed ? (zh ? "通过" : "passed") : (zh ? "未通过" : "not passed")}</span> · {summary}</p>
    {issues.map((issue, index) => <p key={index} className="pl-3 text-muted">{index + 1}. {issue.problem}{issue.suggestion ? ` — ${issue.suggestion}` : ""}</p>)}
  </div>;
}
