"use client";

import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { useLocale } from "next-intl";

import { ReferenceBooksPicker, type BookReference } from "./ReferenceBooksPicker";

export interface BookContext { reference_books?: BookReference[]; chapter_ids: string[]; outline_ids: string[]; use_worldview: boolean }
export const EMPTY_CONTEXT: BookContext = { chapter_ids: [], outline_ids: [], use_worldview: false };
interface Row { id: string; title: string; word_count: number }

export function BookContextPicker({ novelId, value, onChange, disabled }: {
  novelId: string; value: BookContext; onChange: (value: BookContext) => void; disabled?: boolean;
}) {
  const zh = useLocale() !== "en";
  const [chapters, setChapters] = useState<Row[]>([]);
  const [outlines, setOutlines] = useState<Row[]>([]);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    let alive = true;
    void Promise.all([
      apiGet<{ data: { chapter_id: string; title: string; chapter_number: number; word_count: number }[] }>(`/api/chapters/novel/${novelId}`),
      apiGet<{ chapters: Row[] }>(`/api/novels/${novelId}/outline-chapters`),
    ]).then(([body, outline]) => {
      if (!alive) return;
      setChapters(body.data.map((row) => ({ id: row.chapter_id, title: `${row.chapter_number}. ${row.title}`, word_count: row.word_count })));
      setOutlines(outline.chapters);
    }).catch((failure) => { if (alive) setError((failure as Error).message); });
    return () => { alive = false; };
  }, [novelId]);
  const chars = chapters.filter((row) => value.chapter_ids.includes(row.id)).reduce((sum, row) => sum + row.word_count, 0)
    + outlines.filter((row) => value.outline_ids.includes(row.id)).reduce((sum, row) => sum + row.word_count, 0);
  return <fieldset disabled={disabled} className="space-y-3 rounded-xl border border-border p-3" data-testid="book-context-picker">
    <legend className="px-1 text-sm font-semibold">{zh ? "关联范围" : "Linked context"}</legend>
    <p className="text-xs text-muted">{zh ? `已选 ${value.chapter_ids.length} 章正文、${value.outline_ids.length} 章大纲，约 ${chars.toLocaleString()} 字。` : `${value.chapter_ids.length} chapters, ${value.outline_ids.length} outlines, about ${chars.toLocaleString()} characters.`}</p>
    <p className="text-xs text-muted">{zh ? "只可读取和修改勾选的已有章节。未勾选不会自动加入；本任务新写出的内容可继续使用。字数不含任务要求、偏好和生成内容。" : "Only selected existing chapters can be read or edited. Content created by this task remains available. Counts exclude instructions, preferences and generated text."}</p>
    <input aria-label={zh ? "筛选关联章节" : "Filter linked chapters"} className="w-full rounded-lg border border-border bg-background p-2 text-sm" placeholder={zh ? "输入章号或标题筛选" : "Filter by number or title"} value={query} onChange={(event) => setQuery(event.target.value)} />
    {([['chapter_ids', chapters, zh ? '前文正文' : 'Chapters'], ['outline_ids', outlines, zh ? '已有大纲' : 'Outlines']] as const).map(([key, rows, label]) => {
      const shown = rows.filter((row) => row.title.includes(query));
      return <details key={key} open className="text-xs">
        <summary className="cursor-pointer font-medium">{label} · {value[key].length}</summary>
        <div className="my-2 flex gap-3">
          <button type="button" onClick={() => onChange({ ...value, [key]: [...new Set([...value[key], ...shown.map((row) => row.id)])] })}>{zh ? "勾选筛选结果" : "Select filtered"}</button>
          <button type="button" onClick={() => onChange({ ...value, [key]: [] })}>{zh ? "清空" : "Clear"}</button>
        </div>
        <div className="max-h-48 space-y-1 overflow-y-auto">
          {shown.map((row) => <label key={row.id} className="flex items-start gap-2 p-1">
            <input type="checkbox" checked={value[key].includes(row.id)} onChange={(event) => onChange({ ...value, [key]: event.target.checked ? [...value[key], row.id] : value[key].filter((id) => id !== row.id) })} />
            <span>{row.title} <span className="text-muted">({row.word_count.toLocaleString()})</span></span>
          </label>)}
        </div>
      </details>;
    })}
    <label className="flex gap-2 text-xs"><input type="checkbox" checked={value.use_worldview} onChange={(event) => onChange({ ...value, use_worldview: event.target.checked })} />{zh ? "关联本书世界观（智能体可阅读和编辑）" : "Include worldbuilding for planning and outlines"}</label>
    <ReferenceBooksPicker novelId={novelId} value={value.reference_books ?? []} onChange={(reference_books) => onChange({ ...value, reference_books })} disabled={disabled} />
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </fieldset>;
}
