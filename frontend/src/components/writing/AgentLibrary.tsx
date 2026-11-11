"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { useLocale } from "next-intl";
import { apiGet, apiPost } from "@/lib/api";

export interface LibraryEntry {
  id: string; kind: "tool" | "lesson" | "tool_issue"; name: string; description: string; text: string; source: string; scope: "novel" | "global";
  status: "pending" | "approved" | "rejected" | "disabled" | "monitoring" | "flagged" | "resolved";
  reason: string; uses: number; version: number; hits?: number; failure_count?: number; last_error?: string; updated_at?: string | null;
  diagnosis?: Diagnosis | null; doctor_running?: boolean;
}

/** 诊断智能体的结论：setting 查阅范围、usage 用法错（已收进用法经验）、custom 自造工具、bug 内置工具问题、transient 偶发、error 诊断没完成。 */
interface Diagnosis { kind: "setting" | "usage" | "custom" | "bug" | "transient" | "error"; summary: string; fixed: boolean; lesson?: string; version?: number; at?: string | null }

const DIAGNOSIS_KIND: Record<Diagnosis["kind"], [string, string]> = {
  setting: ["查阅范围", "Scope setting"], usage: ["用法错误", "Wrong usage"], custom: ["自造工具", "Agent-made tool"],
  bug: ["内置工具问题", "Built-in tool problem"], transient: ["偶发问题", "Transient"], error: ["诊断未完成", "Diagnosis incomplete"],
};
const RECENT_DAYS = 7;

const scopeText = (scope: string, zh: boolean) => scope === "global" ? (zh ? "所有小说" : "All novels") : (zh ? "仅本书" : "This novel");

/** 一条工具库记录：异常显示失败原因，工具可展开看代码，经验显示原文。 */
function Entry({ entry, zh }: { entry: LibraryEntry; zh: boolean }) {
  const issue = entry.kind === "tool_issue";
  return <div className="min-w-0">
    <p className="text-sm leading-6">{entry.kind !== "lesson"
      ? <><span className="font-mono text-xs">{entry.name}</span>{!issue && entry.version > 1 && <span className="ml-1 text-xs text-muted">v{entry.version}</span>} · {entry.description}</>
      : entry.text}</p>
    <p className="mt-0.5 text-xs text-muted">{issue ? (zh ? "调用异常" : "Tool issue") : entry.kind === "tool" ? (zh ? "自造工具" : "Tool") : (zh ? "经验" : "Lesson")} · {scopeText(entry.scope, zh)}
      {issue && <> · {zh ? "累计失败 " + (entry.failure_count ?? 0) + " 次" : (entry.failure_count ?? 0) + " failed calls"}</>}
      {entry.reason && <> · {zh ? "推荐理由：" : "Why: "}{entry.reason}</>}{entry.uses > 0 && <> · {zh ? "用过 " + entry.uses + " 次" : "used " + entry.uses + "×"}</>}
      {(entry.hits ?? 0) > 0 && <> · {zh ? "作者意见里出现过 " + entry.hits + " 次" : "raised " + entry.hits + "× in feedback"}</>}</p>
    {issue && entry.last_error && <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-danger">{zh ? "最近错误：" : "Latest error: "}{entry.last_error}</p>}
    {issue && entry.doctor_running && <p className="mt-1 text-xs text-muted">{zh ? "诊断智能体正在查原因…" : "Diagnosing…"}</p>}
    {issue && entry.diagnosis && <p data-testid="library-diagnosis" className="mt-1 whitespace-pre-wrap break-words rounded-lg border border-border bg-surface px-2 py-1 text-xs leading-5">
      <span className="font-medium">{zh ? "诊断" : "Diagnosis"} · {DIAGNOSIS_KIND[entry.diagnosis.kind]?.[zh ? 0 : 1] ?? entry.diagnosis.kind} · {entry.diagnosis.fixed ? (zh ? "已处理" : "handled") : (zh ? "没能自动修好" : "not fixed")}</span>
      {entry.diagnosis.version ? <> · v{entry.diagnosis.version}</> : null}<span className="block">{entry.diagnosis.summary}</span>
      {entry.diagnosis.lesson && <span className="block">{zh ? "已收进用法经验：" : "Saved as a lesson: "}{entry.diagnosis.lesson}</span>}</p>}
    {entry.kind !== "lesson" && entry.source && <details className="mt-1"><summary className="cursor-pointer text-xs text-accent">{zh ? "查看代码" : "Show code"}</summary>
      <pre className="workspace-scrollbar mt-1 max-h-60 overflow-auto rounded-lg border border-border bg-background p-2 text-xs leading-5">{entry.source}</pre></details>}
  </div>;
}

/** 智能体推荐的工具和经验：自动显示为绿色，作者添加后才会进入以后的任务。 */
export function LibraryProposalPrompt({ novelId, ids }: { novelId: string; ids: string[] }) {
  const zh = useLocale() !== "en";
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const base = `/api/novels/${novelId}/book-agent/library`;
  const key = ids.join(",");
  useEffect(() => {
    if (!key) return;
    let alive = true;
    void apiGet<{ entries: LibraryEntry[] }>(`${base}?status=pending`).then((data) => {
      if (alive) setEntries(data.entries.filter((entry) => key.split(",").includes(entry.id)));
    }).catch((failure) => { if (alive) setError((failure as Error).message); });
    return () => { alive = false; };
  }, [base, key]);
  if (!entries.length) return null;
  const decide = async (entry: LibraryEntry, decision: "approve" | "reject") => {
    setBusy(entry.id); setError("");
    try {
      await apiPost(`${base}/${entry.id}`, { decision });
      setEntries((rows) => rows.filter((row) => row.id !== entry.id));
    } catch (failure) { setError((failure as Error).message); } finally { setBusy(""); }
  };
  return <section data-testid="library-proposals" className="space-y-2 rounded-2xl border border-emerald-500/50 bg-emerald-500/10 p-4" aria-label={zh ? "工具库推荐" : "Tool recommendations"}>
    <h3 className="text-sm font-medium text-emerald-700 dark:text-emerald-300">{zh ? "智能体推荐添加到工具库" : "Recommended for the tool library"}</h3>
    <p className="text-xs text-muted">{zh ? "智能体认为这些工具或经验通用且好用。添加后，以后的任务会自动带上：工具可以直接调用，经验会放进任务提示。工具只能读书和计算，不能改书。" : "The agent considers these reusable. Approved tools become available to later tasks and lessons go into their prompts. Tools can only read the book."}</p>
    {entries.map((entry) => <article key={entry.id} data-library-proposal={entry.id} className="space-y-2 rounded-lg border border-border bg-surface p-3">
      <Entry entry={entry} zh={zh} />
      <div className="flex gap-2"><Button size="sm" variant="primary" isDisabled={Boolean(busy)} onPress={() => void decide(entry, "approve")}>{busy === entry.id ? (zh ? "添加中…" : "Adding…") : (zh ? "添加到工具库" : "Add to library")}</Button>
        <Button size="sm" variant="ghost" isDisabled={Boolean(busy)} onPress={() => void decide(entry, "reject")}>{zh ? "不要" : "Reject"}</Button></div>
    </article>)}
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </section>;
}

/** 工具库：红色异常提醒、绿色待添加推荐和已收录能力；折叠时也自动刷新数量提醒。 */
export function LibraryManager({ novelId }: { novelId: string }) {
  const zh = useLocale() !== "en";
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const base = `/api/novels/${novelId}/book-agent/library`;
  const load = useCallback(async () => {
    try {
      const data = await apiGet<{ entries: LibraryEntry[] }>(base);
      setEntries(data.entries);
      setError("");
    } catch (failure) { setError((failure as Error).message); }
  }, [base]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, open ? 5000 : 15000);
    return () => window.clearInterval(timer);
  }, [load, open]);
  const decide = async (entry: LibraryEntry, decision: "approve" | "reject" | "disable" | "resolve") => {
    setBusy(entry.id);
    setError("");
    try { await apiPost(`${base}/${entry.id}`, { decision }); await load(); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(""); }
  };
  const diagnose = async (entry: LibraryEntry) => {
    setBusy(entry.id);
    setError("");
    try { await apiPost(`${base}/${entry.id}/diagnose`, {}); await load(); }
    catch (failure) { setError((failure as Error).message); await load(); }
    finally { setBusy(""); }
  };
  const issues = (entries ?? []).filter((entry) => entry.kind === "tool_issue" && entry.status === "flagged");
  // 诊断智能体最近处理掉的问题：标红消失后作者仍能看到它做了什么。
  const since = Date.now() - RECENT_DAYS * 86400000;
  const treated = (entries ?? []).filter((entry) => entry.kind === "tool_issue" && entry.status === "resolved" && entry.diagnosis?.fixed
    && entry.diagnosis.at && Date.parse(entry.diagnosis.at) >= since);
  const recommendations = (entries ?? []).filter((entry) => entry.status === "pending");
  const approved = (entries ?? []).filter((entry) => entry.status === "approved");
  const visibleCount = issues.length + recommendations.length + approved.length + treated.length;
  return <details data-testid="agent-library" className="rounded-xl border border-border p-3 text-sm" onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
    <summary className="cursor-pointer font-medium">{zh ? "工具库" : "Tool library"}
      {issues.length > 0 && <span className="ml-2 rounded-full bg-danger/10 px-2 py-0.5 text-xs text-danger">{zh ? `${issues.length} 个异常` : `${issues.length} issues`}</span>}
      {recommendations.length > 0 && <span className="ml-2 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-300">{zh ? `${recommendations.length} 个推荐` : `${recommendations.length} recommendations`}</span>}</summary>
    <p className="mt-2 text-xs text-muted">{zh ? "同一工具连续失败 3 次会标红，诊断智能体会当场查原因并直接处理：查阅范围的问题告诉你该开哪个设置；内置工具用法错就收进用法经验；智能体自造的工具写出修好的版本，通过沙箱试运行才替换。软件内置工具本身的问题只写诊断，不改软件代码。成功调用后也会自动恢复。通用且好用的自造工具会标绿，你添加后才会进入以后的任务。" : "Tools turn red after 3 consecutive failures. The diagnosis agent then handles them: scope problems name the setting to change, wrong usage of built-in tools becomes a lesson, and agent-made tools are rewritten and replaced once they pass a sandbox test run. Problems inside built-in tools are only reported. Recommended tools turn green and only load after you add them."}</p>
    {entries === null ? <p className="mt-3 text-xs text-muted">{error || (zh ? "读取中…" : "Loading…")}</p>
      : visibleCount === 0 ? <p className="mt-3 text-xs text-muted">{zh ? "暂时没有异常提醒、待添加推荐或已收录能力。" : "No issues, recommendations or saved entries yet."}</p>
      : <div className="mt-3 space-y-4">
        {issues.length > 0 && <section data-testid="tool-library-issues" aria-label={zh ? "可能存在问题的工具" : "Tools with possible issues"}>
          <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold text-danger"><span className="size-2 rounded-full bg-danger" />{zh ? "可能存在问题" : "Possible issues"}</h3>
          <div className="space-y-2">{issues.map((entry) => <article key={entry.id} data-library-issue={entry.id} className="rounded-lg border border-danger/60 bg-danger/10 p-3">
            <Entry entry={entry} zh={zh} />
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="primary" data-testid="library-diagnose" isDisabled={Boolean(busy) || entry.doctor_running} onPress={() => void diagnose(entry)}>{busy === entry.id ? (zh ? "诊断中…" : "Diagnosing…") : (zh ? "诊断并修复" : "Diagnose and fix")}</Button>
              <Button size="sm" variant="ghost" className="text-danger" isDisabled={Boolean(busy)} onPress={() => void decide(entry, "resolve")}>{zh ? "已处理，重新统计" : "Resolved; reset count"}</Button>
            </div>
          </article>)}</div></section>}
        {treated.length > 0 && <section data-testid="tool-library-treated" aria-label={zh ? "诊断智能体最近处理的问题" : "Recently handled by the diagnosis agent"}>
          <h3 className="mb-2 text-xs font-semibold text-muted">{zh ? `诊断智能体最近 ${RECENT_DAYS} 天处理的问题` : `Handled in the last ${RECENT_DAYS} days`}</h3>
          <div className="space-y-2">{treated.map((entry) => <article key={entry.id} className="rounded-lg border border-border p-3"><Entry entry={entry} zh={zh} /></article>)}</div></section>}
        {recommendations.length > 0 && <section data-testid="tool-library-recommendations" aria-label={zh ? "智能体推荐的工具" : "Agent recommendations"}>
          <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold text-emerald-700 dark:text-emerald-300"><span className="size-2 rounded-full bg-emerald-500" />{zh ? "智能体推荐，等待添加" : "Recommended by the agent"}</h3>
          <div className="space-y-2">{recommendations.map((entry) => <article key={entry.id} data-library-recommendation={entry.id} className="rounded-lg border border-emerald-500/60 bg-emerald-500/10 p-3">
            <Entry entry={entry} zh={zh} />
            <div className="mt-2 flex gap-2"><Button size="sm" variant="primary" isDisabled={Boolean(busy)} onPress={() => void decide(entry, "approve")}>{busy === entry.id ? (zh ? "添加中…" : "Adding…") : (zh ? "添加到工具库" : "Add to library")}</Button>
              <Button size="sm" variant="ghost" isDisabled={Boolean(busy)} onPress={() => void decide(entry, "reject")}>{zh ? "忽略" : "Dismiss"}</Button></div>
          </article>)}</div></section>}
        {approved.length > 0 && <section data-testid="tool-library-approved" aria-label={zh ? "已收录的工具和经验" : "Saved tools and lessons"}>
          <h3 className="mb-2 text-xs font-semibold text-muted">{zh ? "已收录" : "Saved"}</h3>
          <div className="space-y-2">{approved.map((entry) => <article key={entry.id} className="flex items-start gap-2 rounded-lg border border-border p-3">
            <div className="min-w-0 flex-1"><Entry entry={entry} zh={zh} /></div>
            <button type="button" disabled={Boolean(busy)} className="shrink-0 text-xs text-accent disabled:opacity-40" onClick={() => void decide(entry, "disable")}>{zh ? "停用" : "Disable"}</button>
          </article>)}</div></section>}
      </div>}
    {error && entries !== null && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
  </details>;
}
