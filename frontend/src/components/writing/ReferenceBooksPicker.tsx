"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { apiGet } from "@/lib/api";

export interface BookReference { novel_id: string; chapter_ids: string[]; outline_ids: string[]; use_worldview: boolean }
interface Row { id: string; title: string }

export function ReferenceBooksPicker({ novelId, value, onChange, disabled }: {
  novelId: string; value: BookReference[]; onChange: (value: BookReference[]) => void; disabled?: boolean;
}) {
  const zh = useLocale() !== "en";
  const [books, setBooks] = useState<Row[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void apiGet<{ data: Row[] }>("/api/novels/list").then(({ data }) => { if (alive) setBooks(data.filter((row) => row.id !== novelId)); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [novelId]);
  return <fieldset disabled={disabled} className="space-y-3 rounded-xl border border-border p-3" data-testid="reference-books">
    <legend className="px-1 text-sm font-semibold">{zh ? "关联其他书 · 只读" : "Other books · Read only"}</legend>
    <p className="text-xs text-muted">{zh ? "可参考其他书的正文、内容结构、大纲和世界观。智能体不能修改参考书，也不会把其中的剧情当作本书事实。" : "Reference chapters, outline structure and worldbuilding. The agent cannot edit these books or treat their events as facts in this book."}</p>
    <select aria-label={zh ? "选择参考书" : "Choose reference book"} value="" className="w-full rounded-lg border border-border bg-background p-2 text-sm" onChange={(e) => {
      if (e.target.value) onChange([...value, { novel_id: e.target.value, chapter_ids: [], outline_ids: [], use_worldview: false }]);
    }}>
      <option value="">{zh ? "选择要参考的书…" : "Choose a book…"}</option>
      {books.filter((book) => !value.some((ref) => ref.novel_id === book.id)).map((book) => <option key={book.id} value={book.id}>{book.title}</option>)}
    </select>
    {value.map((ref) => <ReferenceSelection key={ref.novel_id} value={ref} title={books.find((book) => book.id === ref.novel_id)?.title ?? (zh ? "参考书" : "Reference book")}
      onChange={(next) => onChange(value.map((row) => row.novel_id === ref.novel_id ? next : row))}
      onRemove={() => onChange(value.filter((row) => row.novel_id !== ref.novel_id))} />)}
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </fieldset>;
}

function ReferenceSelection({ value, title, onChange, onRemove }: { value: BookReference; title: string; onChange: (value: BookReference) => void; onRemove: () => void }) {
  const zh = useLocale() !== "en";
  const [rows, setRows] = useState<{ chapter_ids: Row[]; outline_ids: Row[] }>({ chapter_ids: [], outline_ids: [] });
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    let alive = true;
    void Promise.all([
      apiGet<{ data: { chapter_id: string; chapter_number: number; title: string }[] }>(`/api/chapters/novel/${value.novel_id}`),
      apiGet<{ chapters: Row[] }>(`/api/novels/${value.novel_id}/outline-chapters`),
    ]).then(([chapters, outlines]) => { if (alive) setRows({ chapter_ids: chapters.data.map((row) => ({ id: row.chapter_id, title: `${row.chapter_number}. ${row.title}` })), outline_ids: outlines.chapters }); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [value.novel_id]);
  return <details open className="space-y-2 rounded-lg bg-surface p-3">
    <summary className="cursor-pointer text-sm font-medium">《{title}》 · {zh ? "只读" : "Read only"} · {value.chapter_ids.length + value.outline_ids.length}</summary>
    <button type="button" className="text-xs text-danger" onClick={onRemove}>{zh ? "移除关联" : "Remove reference"}</button>
    <input aria-label={zh ? "筛选参考书章节" : "Filter reference chapters"} value={query} onChange={(e) => setQuery(e.target.value)} className="w-full rounded border border-border bg-background p-2 text-sm" placeholder={zh ? "章号或标题" : "Number or title"} />
    {(["chapter_ids", "outline_ids"] as const).map((key) => {
      const shown = rows[key].filter((row) => row.title.toLowerCase().includes(query.toLowerCase()));
      return <div key={key} className="space-y-2 text-xs">
        <div className="flex gap-3"><strong>{key === "chapter_ids" ? (zh ? "正文" : "Chapters") : (zh ? "大纲" : "Outlines")}</strong>
          <button type="button" onClick={() => onChange({ ...value, [key]: [...new Set([...value[key], ...shown.map((row) => row.id)])] })}>{zh ? "勾选筛选结果" : "Select filtered"}</button>
          <button type="button" onClick={() => onChange({ ...value, [key]: [] })}>{zh ? "清空" : "Clear"}</button></div>
        <div className="max-h-48 space-y-1 overflow-y-auto">{shown.map((row) => <label key={row.id} className="flex gap-2 p-1">
          <input type="checkbox" checked={value[key].includes(row.id)} onChange={(e) => onChange({ ...value, [key]: e.target.checked ? [...value[key], row.id] : value[key].filter((id) => id !== row.id) })} />{row.title}
        </label>)}</div>
      </div>;
    })}
    <label className="flex gap-2 text-xs"><input type="checkbox" checked={value.use_worldview} onChange={(e) => onChange({ ...value, use_worldview: e.target.checked })} />{zh ? "参考这本书的世界观" : "Reference this book’s worldbuilding"}</label>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </details>;
}
