"use client";

import { useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { useLocale } from "next-intl";
import { apiGet, apiPost } from "@/lib/api";
import { ModelPicker, type ModelChoice } from "@/components/shared/ModelPicker";

type Kind = "character" | "item" | "world_rule";
type Chapter = { id: string; title: string; chapter_number: number; word_count: number };
type Entry = {
  id: string; name: string; auto?: boolean; aliases?: string[]; identity?: string; appearance?: string; personality?: string;
  abilities?: string[]; sources?: string[]; item_type?: string; description?: string; status?: string; category?: string; statement?: string;
};
const CONTROL = "w-full rounded-xl border border-border bg-background px-3 py-2 text-sm";
const STATUS: Record<string, [string, string]> = {
  available: ["可用", "Available"], held: ["持有中", "Held"], consumed: ["已消耗", "Consumed"], destroyed: ["已毁坏", "Destroyed"],
  active: ["生效中", "Active"], draft: ["草稿", "Draft"], retired: ["已停用", "Retired"],
};

/** 简单设定页：人设可关联正文选章整理；物品和规则随每次正文生成自动维护。 */
export default function StoryAutoWorkspace({ novelId, kind }: { novelId: string; kind: Kind }) {
  const zh = useLocale() !== "en";
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [choice, setChoice] = useState<ModelChoice>({ provider: "", model: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const title = kind === "character" ? (zh ? "人设" : "Characters") : kind === "item" ? (zh ? "物品" : "Items") : (zh ? "设定规则" : "World rules");
  const load = async () => {
    const result = await apiGet<{ entries: Entry[] }>("/api/novels/" + novelId + "/story-auto/" + kind);
    setEntries(result.entries);
  };
  useEffect(() => {
    let current = true;
    setError("");
    void apiGet<{ entries: Entry[] }>("/api/novels/" + novelId + "/story-auto/" + kind).then((result) => { if (current) setEntries(result.entries); }).catch((e) => { if (current) setError(e.message); });
    if (kind === "character") {
      void apiGet<{ chapters: Chapter[] }>("/api/novels/" + novelId + "/story-auto/chapters").then((result) => {
        if (!current) return;
        setChapters(result.chapters);
        setSelected(result.chapters.slice(-1).map((row) => row.id));
      }).catch((e) => { if (current) setError(e.message); });
    }
    return () => { current = false; };
  }, [novelId, kind]);
  const extract = async () => {
    if (!selected.length || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await apiPost<{ created: number; updated: number; characters: number }>("/api/novels/" + novelId + "/story-auto/extract", {
        chapter_ids: selected, kinds: ["character"], ...choice,
      });
      await load();
      setNotice(zh ? "整理完成：新建 " + result.created + " 人，补充 " + result.updated + " 人；已有技能已合并。" : "Done: " + result.created + " created, " + result.updated + " updated.");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const filtered = (entries ?? []).filter((entry) => (entry.name + " " + (entry.identity ?? "") + " " + (entry.description ?? "") + " " + (entry.statement ?? "")).toLowerCase().includes(query.toLowerCase()));
  return <div className="workspace-scrollbar h-full min-h-0 overflow-y-auto p-4 sm:p-6" data-testid={"story-auto-" + kind}>
    <div className="mx-auto max-w-6xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-xl font-semibold">{title}</h1><p className="mt-1 text-sm text-muted">{kind === "character"
        ? (zh ? "勾选正文章节，AI 直接创建人设并合并新技能；不用先填规划或逐字段确认。" : "Select chapters to create profiles and merge new skills directly.")
        : (zh ? "每次生成正文后自动检查并整理，无需再单独生成候选卡。" : "Automatically checked and updated after each chapter is generated.")}</p></div><label className="w-full sm:w-64"><span className="sr-only">{zh ? "搜索" : "Search"}</span><input className={CONTROL} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={zh ? "搜索名称或内容" : "Search"} /></label></header>
      {kind === "character" && <section className="space-y-4 rounded-2xl border border-border bg-surface p-4" aria-label={zh ? "从正文创建人设" : "Create profiles from manuscript"}>
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-medium">{zh ? "从正文创建 / 补充人设" : "Create or update from manuscript"}</h2><span className="text-xs text-muted">{zh ? "已选 " + selected.length + " 章" : selected.length + " selected"}</span></div>
        {chapters.length ? <div className="max-h-56 space-y-1 overflow-y-auto rounded-xl border border-border p-2">{chapters.map((chapter) => <label key={chapter.id} className="flex cursor-pointer flex-wrap items-center gap-2 rounded-lg p-2 text-sm hover:bg-accent/5">
          <input type="checkbox" checked={selected.includes(chapter.id)} onChange={(e) => setSelected((current) => e.target.checked ? chapters.map((row) => row.id).filter((id) => id === chapter.id || current.includes(id)) : current.filter((id) => id !== chapter.id))} />
          <span className="text-fill">第{chapter.chapter_number}章 · {chapter.title}</span><span className="text-xs text-muted">{chapter.word_count} {zh ? "字" : "chars"}</span>
        </label>)}</div> : <p className="text-sm text-muted">{zh ? "还没有正文。生成并保存章节后，就能从这里直接整理人设。" : "No saved chapters yet."}</p>}
        <div className="grid gap-3 lg:grid-cols-[1fr_auto] lg:items-end"><ModelPicker value={choice} onChange={setChoice} disabled={busy} /><Button variant="primary" isDisabled={busy || !selected.length || !chapters.length} onPress={() => void extract()}>{busy ? (zh ? "正在阅读并整理…" : "Reading…") : (zh ? "创建 / 更新人设" : "Create / update")}</Button></div>
      </section>}
      {error && <p role="alert" className="rounded-xl border border-danger/30 p-3 text-sm text-danger">{error}</p>}
      {notice && <p role="status" className="rounded-xl border border-accent/30 bg-accent/5 p-3 text-sm text-accent">{notice}</p>}
      {entries === null ? <p role="status" className="text-sm text-muted">{zh ? "读取中…" : "Loading…"}</p> : !filtered.length ? <div className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted">{zh ? "还没有匹配的设定。正文生成后会自动整理到这里。" : "No matching entries yet."}</div> : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{filtered.map((entry) => <article key={entry.id} className="min-w-0 rounded-2xl border border-border bg-surface p-4" data-story-entry={entry.id}>
        <div className="flex items-start justify-between gap-2"><h2 className="min-w-0 break-words font-semibold">{entry.name}</h2>{entry.auto && <span className="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent">{zh ? "正文自动整理" : "Auto"}</span>}</div>
        {entry.aliases?.length ? <p className="mt-1 text-xs text-muted">{zh ? "别名：" : "Aliases: "}{entry.aliases.join("、")}</p> : null}
        {kind === "character" && <div className="mt-3 space-y-2 text-sm leading-6"><p>{entry.identity || (zh ? "正文中的角色" : "Character")}</p>{entry.personality && entry.personality !== "正文未明确" && <p className="text-muted">{entry.personality}</p>}{entry.abilities?.length ? <div><h3 className="text-xs font-medium text-muted">{zh ? "技能与能力" : "Skills"}</h3><ul className="mt-1 flex flex-wrap gap-1.5">{entry.abilities.map((ability) => <li key={ability} className="rounded-lg bg-accent/10 px-2 py-1 text-xs">{ability}</li>)}</ul></div> : null}{entry.sources?.length ? <p className="text-xs text-muted">{zh ? "来源：" : "From: "}{entry.sources.join("、")}</p> : null}</div>}
        {kind === "item" && <div className="mt-3 space-y-2 text-sm leading-6"><div className="flex flex-wrap gap-2 text-xs"><span className="rounded bg-surface-secondary px-2 py-1">{entry.item_type}</span><span className="rounded bg-surface-secondary px-2 py-1">{STATUS[entry.status ?? ""]?.[zh ? 0 : 1] ?? entry.status}</span></div><p className="whitespace-pre-wrap text-muted">{entry.description}</p>{entry.abilities?.length ? <p>{zh ? "作用：" : "Effects: "}{entry.abilities.join("；")}</p> : null}</div>}
        {kind === "world_rule" && <div className="mt-3 space-y-2 text-sm leading-6"><span className="inline-block rounded bg-surface-secondary px-2 py-1 text-xs">{entry.category}</span><p className="whitespace-pre-wrap">{entry.statement}</p></div>}
      </article>)}</div>}
    </div>
  </div>;
}
