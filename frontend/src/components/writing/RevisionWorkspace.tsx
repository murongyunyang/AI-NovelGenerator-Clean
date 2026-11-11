"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { Button } from "@heroui/react";
import { ApiRequestError, apiGet, apiPut } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { learnFromAccepted, MemoryProposalPrompt, SelectionAgentDialog, type Accepted, type MemoryProposal } from "./SelectionAgent";
import { hitLabel, useKeywordHits } from "./keywordSearch";

type Chapter = { chapter_id: string; novel_id: string; content: string; title: string; version: number };
type Source = { text: string; chapter: Chapter | null };
type Part = { start: number; end: number };
const FIELD = "rounded-xl border border-border bg-background p-3 text-sm";
// 只改一段时带给智能体的前后文长度，与章节编辑里“AI 修改选中内容”一致。
const CONTEXT_BEFORE = 3000;
const CONTEXT_AFTER = 1500;

export default function RevisionWorkspace({ novelId }: { novelId: string }) {
  const zh = useLocale() !== "en";
  const key = `revision-workspace:${novelId}`;
  const [ready, setReady] = useState(false);
  const [source, setSource] = useState<Source | null>(null);
  const [pasted, setPasted] = useState("");
  const [rows, setRows] = useState<Chapter[]>([]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // 只改原稿里的一段：part 是这一段在原稿中的位置，picked 是作者在原稿框里当前选中的范围。
  const [part, setPart] = useState<Part | null>(null);
  const [picked, setPicked] = useState<Part | null>(null);
  // 保存时章节已被别处改过：留下要保存的全文和最新版本，由作者决定覆盖还是复制。
  const [conflict, setConflict] = useState<{ text: string; latest: Chapter } | null>(null);
  const [proposals, setProposals] = useState<MemoryProposal[]>([]);
  const [keyword, setKeyword] = useState("");
  const { hits, searching } = useKeywordHits(novelId, keyword);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    let active = true;
    try {
      const saved = JSON.parse(localStorage.getItem(key) || "null");
      if (saved?.source && typeof saved.source.text === "string") setSource(saved.source);
      if (typeof saved?.pasted === "string") setPasted(saved.pasted);
      if (saved?.part && Number.isInteger(saved.part.start) && Number.isInteger(saved.part.end) && saved.part.start < saved.part.end
        && saved.part.end <= (saved.source?.text?.length ?? 0)) setPart(saved.part);
    } catch { setError(zh ? "读取本机草稿失败。" : "Could not restore the draft."); }
    setReady(true);
    void apiGet<{ data: Chapter[] }>(`/api/chapters/novel/${novelId}`).then(({ data }) => {
      if (active) setRows(data);
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; request.current?.abort(); };
  }, [key, novelId, zh]);
  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(key, JSON.stringify({ source, pasted, part })); }
    catch { setError(zh ? "本机草稿保存失败，请复制文本留存。" : "Could not save the draft. Copy your text."); }
  }, [key, ready, source, pasted, part, zh]);

  const adopt = (next: Source) => { setSource(next); setPart(null); setPicked(null); setConflict(null); setNotice(""); };
  const load = async () => {
    if (!selected || request.current || busy) return;
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setError(""); setNotice("");
    try {
      const chapter = await apiGet<Chapter>(`/api/chapters/${selected}`, { signal: controller.signal });
      if (chapter.novel_id !== novelId) throw new Error(zh ? "章节不属于本书" : "Chapter belongs to another book");
      if (!controller.signal.aborted) adopt({ text: chapter.content, chapter });
    } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
    finally { request.current = null; setLoading(false); }
  };
  // text 是要保存的全文；version 默认用载入时的版本，冲突后由作者确认才用最新版本覆盖。
  const save = async (text: string, version?: number) => {
    if (!source || request.current) return false;
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setError(""); setNotice("");
    try {
      if (source.chapter) {
        const chapter = await apiPut<Chapter>(`/api/chapters/${source.chapter.chapter_id}`, {
          expected_version: version ?? source.chapter.version, content: text,
        });
        if (!controller.signal.aborted) {
          setConflict(null);
          // 只改一段时，保存后的全文成为新的原稿，可以接着选下一段；整章修改保留原稿供对照。
          if (part) { setSource({ text, chapter }); setPart(null); setPicked(null); }
          else setSource({ ...source, chapter });
          setNotice(part ? (zh ? "这一段的修改已保存到章节，可以接着选下一段。" : "The passage was saved to the chapter.") : (zh ? "修改稿已保存到章节，修改意见与原稿仍保留。" : "Revision saved to the chapter. Instructions and original retained."));
        }
      } else {
        await copyText(text);
        setNotice(part ? (zh ? "已复制替换好这一段的全文，可粘贴到章节编辑器。" : "Full text with the revised passage copied.") : (zh ? "已复制修改稿，可粘贴到章节编辑器。" : "Revision copied. Paste it into the chapter editor."));
      }
      return true;
    } catch (e) {
      if (controller.signal.aborted) return false;
      if (e instanceof ApiRequestError && e.status === 409 && source.chapter) {
        // 章节在别处被改过：不自动覆盖，读出最新版本让作者决定。
        try { setConflict({ text, latest: await apiGet<Chapter>(`/api/chapters/${source.chapter.chapter_id}`) }); }
        catch { setError(`${(e as Error).message}${zh ? " 修改稿与意见仍保留。" : " Your draft is retained."}`); }
      } else setError(`${(e as Error).message}${zh ? " 修改稿与意见仍保留，未自动覆盖其他版本。" : " Your draft and instructions are retained."}`);
      return false;
    }
    finally { request.current = null; setLoading(false); }
  };
  const accept = async (result: Accepted) => {
    if (!source) return;
    const text = part ? source.text.slice(0, part.start) + result.final + source.text.slice(part.end) : result.final;
    if (!await save(text)) return;
    const found = await learnFromAccepted(novelId, "chapter", result);
    if (found.length) setProposals((current) => [...current, ...found]);
  };

  const text = keyword.trim();
  const shown = rows.map((row, index) => ({ row, index })).filter(({ row }) => !text || row.title.includes(text) || row.chapter_id === selected || hits?.chapters.has(row.chapter_id));
  const selection = source && (part
    ? { start: part.start, end: part.end, text: source.text.slice(part.start, part.end), before: source.text.slice(Math.max(0, part.start - CONTEXT_BEFORE), part.start), after: source.text.slice(part.end, part.end + CONTEXT_AFTER) }
    : { start: 0, end: source.text.length, text: source.text, before: "", after: "" });
  const trackPick = (event: { currentTarget: HTMLTextAreaElement }) => {
    const { selectionStart: start, selectionEnd: end, value } = event.currentTarget;
    setPicked(value.slice(start, end).trim() ? { start, end } : null);
  };

  return <section className="workspace-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 sm:p-6" data-testid="revision-workspace">
    <header><h1 className="text-lg font-semibold">{zh ? "AI 修改" : "AI revision"}</h1>
      <p className="mt-1 text-sm text-muted">{zh ? "载入整章或粘贴片段，写下修改意见；也可以只问问题，智能体会判断是回答还是动手改。原稿、意见、修改稿和追问会自动保存在本机，切换页面后可接着改。切换页面会停止正在生成的请求，已收到的稿件保留。" : "Load a chapter or paste text. Originals, instructions, revisions and follow-ups are saved locally. Leaving stops generation and keeps received text."}</p></header>
    <div className="flex flex-wrap gap-2">
      <input data-testid="revision-filter" aria-label={zh ? "按关键词筛选章节" : "Filter chapters by keyword"} className={`${FIELD} w-full sm:w-64`} value={keyword} maxLength={60} placeholder={zh ? "筛选：标题或正文里的关键词" : "Filter by title or text"} disabled={busy || loading} onChange={e => setKeyword(e.target.value)} />
      <select aria-label={zh ? "选择修改章节" : "Chapter to revise"} className={`${FIELD} min-w-0 flex-1`} value={selected} disabled={busy || loading} onChange={e => setSelected(e.target.value)}>
        <option value="">{zh ? "选择已保存的章节" : "Choose a saved chapter"}</option>
        {shown.map(({ row, index }) => <option key={row.chapter_id} value={row.chapter_id}>{index + 1}. {row.title}{text && hits?.chapters.get(row.chapter_id)?.hits ? `（${hitLabel(hits.chapters.get(row.chapter_id), zh)}）` : ""}</option>)}
      </select>
      <Button isDisabled={!ready || !selected || busy || loading} onPress={() => void load()}>{zh ? "载入整章" : "Load full chapter"}</Button>
    </div>
    {text && <p role="status" data-testid="revision-filter-status" className="text-xs text-muted">{searching ? (zh ? "正在查找正文里的关键词…" : "Searching text…") : (zh ? `筛出 ${shown.length} / ${rows.length} 章` : `${shown.length} / ${rows.length} chapters`)}
      {!searching && selected && hits?.chapters.get(selected)?.snippet ? <span className="block leading-5">…{hits.chapters.get(selected)!.snippet}…</span> : null}</p>}
    <details><summary className="cursor-pointer text-sm text-accent">{zh ? "粘贴需要修改的文字" : "Paste text to revise"}</summary>
      <textarea aria-label={zh ? "待修改原稿" : "Original text"} className={`${FIELD} mt-2 w-full`} rows={6} value={pasted} disabled={!ready || busy || loading} onChange={e => setPasted(e.target.value)} />
      <Button isDisabled={!ready || !pasted.trim() || busy || loading} onPress={() => adopt({ text: pasted, chapter: null })}>{zh ? "使用这份原稿" : "Use this original"}</Button>
    </details>
    {source?.chapter && <p className="text-sm font-medium">{zh ? "正在修改：" : "Revising: "}{source.chapter.title}{part ? (zh ? `（只改其中 ${part.end - part.start} 字的一段）` : ` (one passage, ${part.end - part.start} chars)`) : ""}</p>}
    {source?.text.trim() && <details data-testid="revision-part" open={Boolean(part) || undefined}><summary className="cursor-pointer text-sm text-accent">{zh ? "只改原稿里的一段" : "Revise only one passage"}</summary>
      <p className="mt-2 text-xs leading-5 text-muted">{zh ? "在下面的原稿里用鼠标选中一段再点按钮：智能体只改这一段，并参考它前后的文字；保存时把改好的这一段放回原处。" : "Select a passage below; only it is revised, with its surrounding text as context."}</p>
      <textarea readOnly aria-label={zh ? "原稿（用于选段）" : "Original (select a passage)"} className={`${FIELD} workspace-scrollbar mt-2 h-56 w-full resize-y leading-7`} value={source.text} onSelect={trackPick} onMouseUp={trackPick} onKeyUp={trackPick} />
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <Button size="sm" variant="secondary" data-testid="revision-part-use" isDisabled={!picked || busy || loading} onPress={() => { setPart(picked); setConflict(null); setNotice(""); }}>{picked ? (zh ? `只改选中的 ${picked.end - picked.start} 字` : `Revise ${picked.end - picked.start} selected chars`) : (zh ? "先在原稿里选中一段" : "Select a passage first")}</Button>
        {part && <Button size="sm" variant="ghost" data-testid="revision-part-clear" isDisabled={busy || loading} onPress={() => { setPart(null); setConflict(null); }}>{zh ? "改回整篇" : "Back to whole text"}</Button>}
      </div>
    </details>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {conflict && <div role="alert" data-testid="revision-conflict" className="space-y-2 rounded-xl border border-danger/40 p-3 text-sm">
      <p>{zh ? `章节「${conflict.latest.title}」在你修改期间已被别处保存过（现在是第 ${conflict.latest.version} 版），所以没有自动覆盖。修改稿和意见都还在。` : `“${conflict.latest.title}” was saved elsewhere while you were revising (now version ${conflict.latest.version}), so nothing was overwritten.`}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="danger-soft" isDisabled={busy || loading} onPress={() => void save(conflict.text, conflict.latest.version)}>{zh ? "用我的修改稿覆盖最新版本" : "Overwrite with my revision"}</Button>
        <Button size="sm" variant="secondary" isDisabled={busy || loading} onPress={() => void copyText(conflict.text).then(() => setNotice(zh ? "已复制修改稿。" : "Revision copied."))}>{zh ? "复制修改稿" : "Copy revision"}</Button>
        <Button size="sm" variant="ghost" isDisabled={busy || loading} onPress={() => adopt({ text: conflict.latest.content, chapter: conflict.latest })}>{zh ? "放弃修改稿，载入最新版本" : "Discard and load latest"}</Button>
      </div>
      <p className="text-xs text-muted">{zh ? "覆盖后，别处保存的那一版仍在章节的历史版本里。" : "The other version stays in the chapter history."}</p>
    </div>}
    {notice && <p role="status" className="text-sm text-accent">{notice}</p>}
    {proposals.length > 0 && <MemoryProposalPrompt novelId={novelId} proposals={proposals} />}
    <div inert={loading || undefined}>
      {ready && source?.text.trim() && selection ? <SelectionAgentDialog key={`${source.chapter?.chapter_id ?? "paste"}:${part ? `${part.start}-${part.end}` : "all"}:${source.text}`} inline novelId={novelId} target="chapter"
        selection={selection} sourceId={source.chapter?.chapter_id} onBusyChange={setBusy}
        acceptLabel={source.chapter ? (part ? (zh ? "把这一段保存到章节" : "Save passage to chapter") : (zh ? "保存修改稿到章节" : "Save revision to chapter")) : (zh ? "复制修改稿" : "Copy revision")}
        onAccept={result => void accept(result)} onClose={() => {}} />
        : <p className="text-sm text-muted">{zh ? "载入整章即可开始，不需要手动全选。" : "Load a chapter to begin; no manual selection needed."}</p>}
    </div>
  </section>;
}
