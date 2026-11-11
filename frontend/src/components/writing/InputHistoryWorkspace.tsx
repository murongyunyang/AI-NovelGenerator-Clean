"use client";

import { useContext, useEffect, useEffectEvent, useRef, useState } from "react";
import { Button } from "@heroui/react";
import { useLocale } from "next-intl";
import { RetainedViewActive } from "@/components/layout/RetainedViews";
import { apiGet } from "@/lib/api";
import { formatFull, parseServerTime } from "@/lib/lastModified";
import { useResourceRefresh } from "@/hooks/useResourceRefresh";

type Entry = { id: string; source: string; label: string; text: string; truncated: boolean; detail: Record<string, unknown>; created_at: string };
type Page = { entries: Entry[]; has_more: boolean; sources: Record<string, string> };
const EN: Record<string, string> = {
  assistant: "Assistant", book_agent: "Autonomous agent", selection_agent: "AI selection edit",
  continuation: "Continuation", outline: "Next outline", summary: "Summary", materials: "Materials",
};
const KIND: Record<string, [string, string]> = { start: ["开始任务", "Start"], message: ["中途留言", "Message"], resume: ["继续时补充", "Resume"], turn: ["对话", "Chat"], answer: ["回答提问", "Answer"] };

/** 本书里作者发给各个智能体的全部指令，按时间倒序，可按来源筛选、搜索和复制。 */
export default function InputHistoryWorkspace({ novelId }: { novelId: string }) {
  const zh = useLocale() !== "en";
  const active = useContext(RetainedViewActive);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [sources, setSources] = useState<Record<string, string>>({});
  const [source, setSource] = useState("");
  const [allBooks, setAllBooks] = useState(true);
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [open, setOpen] = useState<string[]>([]);
  const request = useRef(0);

  const load = async (before?: string) => {
    const token = ++request.current;
    setBusy(true); setError("");
    try {
      const params = new URLSearchParams({ limit: "50", all_books: String(allBooks), ...(source ? { source } : {}), ...(applied ? { q: applied } : {}), ...(before ? { before } : {}) });
      const page = await apiGet<Page>(`/api/novels/${novelId}/input-history?${params}`);
      if (token !== request.current) return;
      setSources(page.sources); setMore(page.has_more);
      setEntries((current) => before ? [...current, ...page.entries] : page.entries);
    } catch (e) { if (token === request.current) setError((e as Error).message); }
    finally { if (token === request.current) setBusy(false); }
  };
  const loadLatest = useEffectEvent(() => load());
  useEffect(() => { void loadLatest(); }, [novelId, source, applied, allBooks, active]);
  // 回到本页或其他地方保存后刷新第一页。
  const reload = useRef(load); reload.current = load;
  useResourceRefresh(novelId, () => reload.current(), active);

  const copy = async (entry: Entry) => {
    try { await navigator.clipboard.writeText(entry.text); setCopied(entry.id); setTimeout(() => setCopied((id) => id === entry.id ? "" : id), 1500); }
    catch { setError(zh ? "无法写入剪贴板，请手动选中文字复制。" : "Clipboard unavailable; select the text to copy."); }
  };
  const name = (key: string) => zh ? (sources[key] ?? key) : (EN[key] ?? key);

  return <section data-testid="input-history-workspace" className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4 sm:p-6">
    <header className="flex shrink-0 flex-wrap items-baseline justify-between gap-2">
      <h1 className="text-lg font-semibold">{zh ? "输入记录" : "Input history"}</h1>
      <p className="text-xs text-muted">{zh ? "所有来源的 AI 输入和追问，停止、失败或撤回后仍保留。" : "AI inputs and follow-ups remain after stopping, errors, or undo."}</p>
    </header>
    <form className="flex shrink-0 flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); setApplied(query.trim()); }}>
      <select aria-label={zh ? "记录范围" : "Scope"} className="rounded-xl border border-border bg-background px-3 py-2 text-sm" value={allBooks ? "all" : "book"} onChange={(e) => setAllBooks(e.target.value === "all")}>
        <option value="all">{zh ? "整个软件" : "Entire app"}</option><option value="book">{zh ? "仅本书" : "This book"}</option>
      </select>
      <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => void load()}>{zh ? "刷新" : "Refresh"}</Button>
      <select aria-label={zh ? "来源" : "Source"} className="rounded-xl border border-border bg-background px-3 py-2 text-sm" value={source} onChange={(e) => setSource(e.target.value)}>
        <option value="">{zh ? "全部来源" : "All sources"}</option>
        {Object.keys(sources).map((key) => <option key={key} value={key}>{name(key)}</option>)}
      </select>
      <input type="search" aria-label={zh ? "搜索记录" : "Search"} placeholder={zh ? "搜索指令内容" : "Search instructions"} className="min-w-48 flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm" value={query} onChange={(e) => setQuery(e.target.value)} />
      <Button type="submit" size="sm" variant="secondary" isDisabled={busy}>{zh ? "搜索" : "Search"}</Button>
      {applied && <Button size="sm" variant="ghost" onPress={() => { setQuery(""); setApplied(""); }}>{zh ? "清除搜索" : "Clear"}</Button>}
    </form>
    {error && <p role="alert" className="shrink-0 text-sm text-danger">{error}</p>}
    <ol className="workspace-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain pr-1">
      {!busy && !entries.length && <li className="rounded-2xl border border-border bg-surface p-6 text-sm text-muted">{applied || source ? (zh ? "没有符合条件的记录。" : "No matching entries.") : (zh ? "还没有记录。从现在开始，你发给续写、全自动智能体、协作助手、AI 修改选段和生成大纲的指令都会记在这里。" : "Nothing yet. Instructions you send to agents will appear here.")}</li>}
      {entries.map((entry) => {
        const date = parseServerTime(entry.created_at);
        const expanded = open.includes(entry.id);
        const long = entry.text.length > 280 || entry.text.split("\n").length > 6;
        const kind = typeof entry.detail.kind === "string" ? KIND[entry.detail.kind] : undefined;
        return <li key={entry.id} data-history-entry={entry.id} className="rounded-2xl border border-border bg-surface p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className="rounded-md bg-accent/10 px-2 py-0.5 font-medium text-accent">{name(entry.source)}</span>
            {kind && <span>{kind[zh ? 0 : 1]}</span>}
            {date && <time dateTime={date.toISOString()} className="tabular-nums">{formatFull(date)}</time>}
            <span className="ml-auto flex gap-1">
              {long && <Button size="sm" variant="ghost" onPress={() => setOpen((ids) => expanded ? ids.filter((id) => id !== entry.id) : [...ids, entry.id])}>{expanded ? (zh ? "收起" : "Less") : (zh ? "展开全文" : "More")}</Button>}
              <Button size="sm" variant="ghost" onPress={() => void copy(entry)}>{copied === entry.id ? (zh ? "已复制" : "Copied") : (zh ? "复制" : "Copy")}</Button>
            </span>
          </div>
          <p className={`whitespace-pre-wrap break-words text-sm leading-7 ${long && !expanded ? "line-clamp-6" : ""}`}>{entry.text}</p>
          {entry.truncated && <p className="mt-1 text-xs text-muted">{zh ? "（内容过长，只保存了前 20 万字）" : "(Truncated)"}</p>}
        </li>;
      })}
      {more && <li className="flex justify-center py-2"><Button size="sm" variant="secondary" isDisabled={busy} onPress={() => void load(entries[entries.length - 1]?.id)}>{busy ? (zh ? "正在读取…" : "Loading…") : (zh ? "加载更早的记录" : "Load older")}</Button></li>}
    </ol>
  </section>;
}
