"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { Button } from "@heroui/react";
import { apiGet } from "@/lib/api";

type Entry = { id: string; title: string; source: string; created_at: string; status: string; preview: string; chars: number };
type Detail = Entry & { text: string; versions: string[] };

export default function OutputHistoryWorkspace({ novelId }: { novelId: string }) {
  const zh = useLocale() !== "en";
  const [rows, setRows] = useState<Entry[]>([]);
  const [sources, setSources] = useState<Record<string, string>>({});
  const [detail, setDetail] = useState<Detail | null>(null);
  const [version, setVersion] = useState(-1);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const sequence = useRef(0);
  const selection = useRef(0);
  const endpoint = `/api/novels/${novelId}/output-history`;
  const load = async (before?: string) => {
    const seq = ++sequence.current;
    setBusy(true); setError("");
    try {
      const page = await apiGet<{ entries: Entry[]; sources: Record<string, string>; has_more: boolean }>(`${endpoint}?${new URLSearchParams({ q: search, ...(before ? { before } : {}) })}`);
      if (seq !== sequence.current) return;
      setRows(old => before ? [...old, ...page.entries] : page.entries);
      setSources(page.sources); setMore(page.has_more);
    } catch (e) { if (seq === sequence.current) setError((e as Error).message); }
    finally { if (seq === sequence.current) setBusy(false); }
  };
  useEffect(() => {
    setDetail(null); ++selection.current;
    void load();
    // These counters invalidate in-flight requests, so cleanup needs their latest values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { ++sequence.current; ++selection.current; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [novelId, search]);
  const open = async (id: string) => {
    const seq = ++selection.current;
    setError(""); setDetail(null); setCopied(false);
    try {
      const row = await apiGet<Detail>(`${endpoint}/${id}`);
      if (seq === selection.current) { setDetail(row); setVersion(-1); }
    } catch (e) { if (seq === selection.current) setError((e as Error).message); }
  };
  const text = detail ? (version < 0 ? detail.text : detail.versions[version]) : "";
  return <section className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4 sm:p-6" data-testid="output-history-workspace">
    <h1 className="text-lg font-semibold">{zh ? "历史输出" : "Output history"}</h1>
    <p className="text-xs text-muted">{zh ? "续写、修改、大纲、概要和去痕的输出自动保留，未采用或中断的稿件也可查看。记录从更新后开始；复制后可粘贴到编辑器保存。" : "Generated drafts are retained even when interrupted or not saved to a chapter. History starts with this update; copy a draft into the editor to save it."}</p>
    <form className="flex gap-2" onSubmit={e => { e.preventDefault(); setSearch(query.trim()); }}>
      <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={zh ? "搜索输出内容" : "Search outputs"} aria-label={zh ? "搜索输出" : "Search outputs"} className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2" />
      <Button type="submit" size="sm">{zh ? "搜索" : "Search"}</Button>
      <Button size="sm" isDisabled={busy} onPress={() => void load()}>{zh ? "刷新" : "Refresh"}</Button>
    </form>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <div className="grid min-h-0 flex-1 gap-4 overflow-auto md:grid-cols-[minmax(220px,1fr)_2fr]">
      <div className="workspace-scrollbar space-y-2 overflow-auto">
        {!busy && !rows.length && <p className="text-sm text-muted">{zh ? "暂无符合条件的输出记录。" : "No matching outputs."}</p>}
        {rows.map(row => <button key={row.id} onClick={() => void open(row.id)} className={`block w-full rounded-xl border p-3 text-left ${detail?.id === row.id ? "border-accent" : "border-border"}`}>
          <div className="text-sm font-medium">{row.title || sources[row.source] || row.source}</div>
          <div className="my-1 text-xs text-muted">{new Date(row.created_at).toLocaleString()} · {row.chars} {zh ? "字" : "chars"} · {row.status === "done" ? (zh ? "完成" : "Complete") : (zh ? "未完成稿" : "Partial draft")}</div>
          <p className="line-clamp-3 whitespace-pre-wrap text-xs leading-5">{row.preview}</p>
        </button>)}
        {more && <Button size="sm" isDisabled={busy} onPress={() => void load(rows.at(-1)?.id)}>{zh ? "更早记录" : "Older outputs"}</Button>}
      </div>
      {detail ? <div className="flex min-h-80 flex-col gap-2 overflow-hidden">
        <div className="flex flex-wrap gap-2">
          <select aria-label={zh ? "稿件版本" : "Draft version"} value={version} onChange={e => { setVersion(Number(e.target.value)); setCopied(false); }} className="rounded-lg border border-border bg-background p-2 text-sm">
            <option value={-1}>{zh ? "最后输出" : "Latest output"}</option>
            {detail.versions.map((_, i) => <option key={i} value={i}>{zh ? `中间稿 ${i + 1}` : `Intermediate draft ${i + 1}`}</option>)}
          </select>
          <Button size="sm" onPress={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setError(zh ? "复制失败，请选中文字手动复制。" : "Select the text to copy manually."); } }}>{copied ? (zh ? "已复制" : "Copied") : (zh ? "复制全文" : "Copy")}</Button>
        </div>
        <textarea readOnly value={text} aria-label={zh ? "输出全文" : "Full output"} className="min-h-64 flex-1 resize-none rounded-xl border border-border bg-background p-4 text-sm leading-7" />
      </div> : <p className="text-sm text-muted">{zh ? "选择一条记录查看全文。" : "Select an output to read."}</p>}
    </div>
  </section>;
}
