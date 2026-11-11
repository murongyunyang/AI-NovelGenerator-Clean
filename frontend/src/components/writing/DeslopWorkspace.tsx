"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { Button } from "@heroui/react";
import { apiGet, apiPostSSE } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { ModelPicker, type ModelChoice } from "@/components/shared/ModelPicker";
import { confirmDialog } from "@/components/shared/ConfirmDialog";
import { EffortSelect } from "./AgentSettings";
import { countChars, diffText } from "@/lib/textDiff";

function formatDelta(delta: number, zh: boolean) {
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
  return zh ? `较原稿 ${sign}${Math.abs(delta).toLocaleString()}` : `${sign}${Math.abs(delta).toLocaleString()} vs original`;
}

const FIELD = "w-full rounded-xl border border-border bg-background p-3 text-sm text-foreground";
type ChapterRow = { chapter_id: string; title: string };
type Report = { stopped_reason?: string; gaps?: string[]; remaining?: { excerpt: string; message: string }[] };

export default function DeslopWorkspace({ novelId }: { novelId: string }) {
  const zh = useLocale() !== "en";
  const [text, setText] = useState("");
  const [result, setResult] = useState("");
  const [requirements, setRequirements] = useState("");
  const [choice, setChoice] = useState<ModelChoice>({ provider: "", model: "" });
  const [effort, setEffort] = useState("");
  const [rounds, setRounds] = useState(1);
  const [rows, setRows] = useState<ChapterRow[]>([]);
  const [chapter, setChapter] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [traces, setTraces] = useState<string[]>([]);
  const controller = useRef<AbortController | null>(null);
  const key = `deslop-draft:${novelId}`;
  const deferredText = useDeferredValue(text);
  const deferredResult = useDeferredValue(result);
  const diff = useMemo(() => deferredResult ? diffText(deferredText, deferredResult) : null, [deferredText, deferredResult]);
  const diffStats = useMemo(() => {
    let removed = 0, added = 0;
    for (const part of diff ?? []) {
      if (part.type === "removed") removed += countChars(part.text);
      else if (part.type === "added") added += countChars(part.text);
    }
    return { removed, added };
  }, [diff]);

  useEffect(() => {
    let current = true;
    try {
      const saved = JSON.parse(localStorage.getItem(key) || "null");
      if (saved && typeof saved.text === "string" && typeof saved.result === "string" && typeof saved.requirements === "string") {
        setText(saved.text); setResult(saved.result); setRequirements(saved.requirements);
      }
    } catch { setError(zh ? "本机草稿读取失败，请保留文本副本。" : "Could not restore the local draft."); }
    setReady(true);
    void apiGet<{ data: ChapterRow[] }>(`/api/chapters/novel/${novelId}`).then(({ data }) => {
      if (current) setRows(data);
    }).catch((e) => { if (current) setError(e.message); });
    return () => { current = false; controller.current?.abort(); };
  }, [key, novelId, zh]);

  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(key, JSON.stringify({ text, result, requirements })); }
    catch { setError(zh ? "本机草稿保存失败，请复制文本保存。" : "Could not save locally. Copy your text."); }
  }, [key, ready, text, result, requirements, zh]);

  const loadChapter = async () => {
    if (!chapter || controller.current) return;
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError("");
    try {
      if ((text || result) && !await confirmDialog({
        title: zh ? "载入章节为原稿？" : "Load chapter as source?",
        message: zh ? "这会替换当前原稿和去痕结果，请先复制需要保留的文字。" : "This replaces the current source and result. Copy any text you wish to keep first.",
        confirmLabel: zh ? "载入章节" : "Load chapter",
      })) return;
      if (abort.signal.aborted) return;
      const record = await apiGet<{ novel_id: string; content: string }>(`/api/chapters/${chapter}`, { signal: abort.signal });
      if (record.novel_id !== novelId) throw new Error(zh ? "章节不属于本书" : "Chapter belongs to another book");
      setText(record.content); setResult(""); setReport(null); setTraces([]); setStatus("");
    } catch (e) { if (!abort.signal.aborted) setError((e as Error).message); }
    finally { controller.current = null; setBusy(false); }
  };

  const run = async () => {
    if (!text.trim() || controller.current) return;
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError(""); setReport(null); setTraces([]); setResult("");
    setStatus(zh ? "正在进行独立去痕…" : "Reviewing prose…");
    try {
      await apiPostSSE(`/api/novels/${novelId}/continuation/deslop/stream`, {
        text, requirements, ...choice, max_rounds: rounds, ...(effort ? { reasoning_effort: effort } : {}),
      }, (event, data) => {
        if (event === "progress" && typeof data.message === "string") setStatus(data.message);
        if (event === "trace" && typeof data.label === "string") setTraces((items) => [...items, data.label as string]);
        if ((event === "replacement" || event === "done") && typeof data.text === "string") setResult(data.text);
        if (event === "done") {
          const log = data.log as Report;
          setReport(log); setStatus(log.stopped_reason || (zh ? "去痕完成" : "Complete"));
        }
      }, { signal: abort.signal, allowedEvents: ["trace", "replacement"] });
    } catch (e) {
      if (abort.signal.aborted) setStatus(zh ? "已停止，原稿和已收到的修改保留。" : "Stopped. Received text is preserved.");
      else { setError((e as Error).message); setStatus(zh ? "去痕未完成" : "Review incomplete"); }
    } finally { controller.current = null; setBusy(false); }
  };

  return <section data-testid="deslop-workspace" className="workspace-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 sm:p-6">
    <header><h1 className="text-lg font-semibold">{zh ? "AI 去痕" : "Prose cleanup"}</h1>
      <p className="mt-1 text-sm text-muted">{zh ? "仅用 Claude Code story-deslop 方法审查并局部修改，保留原文风格与剧情。" : "Review and patch prose using the Claude Code story-deslop method, preserving style and plot."}</p>
      <p className="mt-1 text-xs text-muted">{zh ? "使用下方所选模型（可选 Claude），不调用 Claude Code 程序。不加载软件通用写法、偏好记忆、历史经验或其他审查提示词。" : "Runs with the selected model, including Claude, rather than the Claude Code application. No app writing preferences, memories, lessons or other review prompts are loaded."}</p>
    </header>
    <div className="grid gap-4 lg:grid-cols-2">
      <ModelPicker value={choice} onChange={setChoice} disabled={busy} />
      <div className="grid gap-3 sm:grid-cols-2">
        <EffortSelect value={effort} onChange={setEffort} provider={choice.provider} disabled={busy} />
        <label className="grid content-start gap-1 text-xs text-muted">{zh ? "去痕轮数上限" : "Maximum passes"}<select className={FIELD} value={rounds} disabled={busy} onChange={(e) => setRounds(Number(e.target.value))}>{[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}</select><span>{zh ? "默认一轮；后续只处理复扫问题，不反复全文重写。" : "One pass by default; later passes target remaining issues."}</span></label>
      </div>
    </div>
    <label className="grid gap-1 text-xs text-muted">{zh ? "本次要求（可空）" : "Requirements for this pass (optional)"}<textarea className={FIELD} rows={2} value={requirements} disabled={busy} onChange={(e) => setRequirements(e.target.value)} placeholder={zh ? "例如：保留口语、心理描写和人物吐槽。" : "For example: preserve colloquial speech and inner thoughts."} /></label>
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label={zh ? "导入章节" : "Import chapter"} className={`${FIELD} max-w-sm`} value={chapter} disabled={busy || !ready} onChange={(e) => setChapter(e.target.value)}><option value="">{zh ? "选择已保存章节，或直接粘贴原稿" : "Choose a chapter or paste text below"}</option>{rows.map((row) => <option key={row.chapter_id} value={row.chapter_id}>{row.title}</option>)}</select>
      <Button variant="secondary" isDisabled={busy || !chapter} onPress={() => void loadChapter()}>{zh ? "载入为原稿" : "Load source"}</Button>
      <Button variant="primary" isDisabled={busy || !ready || !text.trim()} onPress={() => void run()}>{zh ? "仅运行去痕审查" : "Run cleanup only"}</Button>
      {busy && <Button variant="ghost" onPress={() => controller.current?.abort()}>{zh ? "停止" : "Stop"}</Button>}
    </div>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {status && <p role="status" className="text-sm text-muted">{status}</p>}
    <div className="grid min-h-96 gap-4 lg:grid-cols-2">
      <label className="flex flex-col gap-2 text-sm"><span className="flex flex-wrap items-baseline justify-between gap-x-3"><span>{zh ? "原稿" : "Original"}</span><span data-testid="deslop-original-count" className="text-xs text-muted tabular-nums">{zh ? `${countChars(text).toLocaleString()} 字` : `${countChars(text).toLocaleString()} chars`}</span></span><textarea data-testid="deslop-original" className={`${FIELD} min-h-80 flex-1 leading-7`} value={text} disabled={busy || !ready} onChange={(e) => { setText(e.target.value); setResult(""); setReport(null); setStatus(""); setTraces([]); }} /></label>
      <label className="flex flex-col gap-2 text-sm"><span className="flex flex-wrap items-baseline justify-between gap-x-3"><span>{zh ? "去痕结果（可编辑）" : "Result (editable)"}</span><span data-testid="deslop-result-count" className="text-xs text-muted tabular-nums">{zh ? `${countChars(result).toLocaleString()} 字` : `${countChars(result).toLocaleString()} chars`}{result && <> · {formatDelta(countChars(result) - countChars(text), zh)}</>}</span></span><textarea data-testid="deslop-result" className={`${FIELD} min-h-80 flex-1 leading-7`} value={result} disabled={busy || !ready} onChange={(e) => setResult(e.target.value)} /></label>
    </div>
    {diff && <div data-testid="deslop-diff" className="rounded-xl border border-border">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border px-3 py-2 text-sm">
        <span className="font-medium">{zh ? "修改对照" : "Changes"}</span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span><del className="rounded bg-danger/10 px-1 text-danger">{zh ? "删去" : "Removed"}</del> {zh ? `${diffStats.removed.toLocaleString()} 字` : diffStats.removed.toLocaleString()}</span>
          <span><ins className="rounded bg-success/15 px-1 text-success no-underline">{zh ? "新增" : "Added"}</ins> {zh ? `${diffStats.added.toLocaleString()} 字` : diffStats.added.toLocaleString()}</span>
        </span>
      </div>
      {diffStats.removed === 0 && diffStats.added === 0
        ? <p className="p-3 text-sm text-muted">{zh ? "结果与原稿完全相同。" : "No changes."}</p>
        : <div className="workspace-scrollbar max-h-[32rem] overflow-y-auto whitespace-pre-wrap break-words p-3 text-sm leading-7">{diff.map((part, i) => part.type === "same"
          ? <span key={i}>{part.text}</span>
          : part.type === "removed"
            ? <del key={i} className="rounded-sm bg-danger/10 text-danger">{part.text}</del>
            : <ins key={i} className="rounded-sm bg-success/15 text-success no-underline">{part.text}</ins>)}</div>}
    </div>}
    <div className="flex flex-wrap items-center gap-3"><Button variant="secondary" isDisabled={busy || !result} onPress={() => { void copyText(result).then(() => setStatus(zh ? "结果已复制" : "Copied")).catch((e) => setError(e.message)); }}>{zh ? "复制结果" : "Copy result"}</Button><span className="text-xs text-muted">{zh ? "原稿和结果在本机保留；检查后可复制到章节编辑保存，不自动覆盖章节。" : "Drafts are kept locally. Copy the reviewed result into the chapter editor to save."}</span></div>
    {report?.gaps?.length ? <div className="rounded-xl border border-border p-3"><h2 className="text-sm font-medium">{zh ? "需要作者决定的剧情问题" : "Plot questions for the author"}</h2><ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{report.gaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul></div> : null}
    {report?.remaining?.length ? <details><summary className="cursor-pointer text-sm">{zh ? "剩余问题" : "Remaining issues"}</summary><ul className="mt-2 list-disc pl-5 text-sm">{report.remaining.map((item, i) => <li key={i}>{item.excerpt}：{item.message}</li>)}</ul></details> : null}
    {traces.length > 0 && <details><summary className="cursor-pointer text-sm">{zh ? "去痕过程" : "Review log"}</summary><ul className="mt-2 space-y-1 text-xs text-muted">{traces.map((line, i) => <li key={i}>{line}</li>)}</ul></details>}
  </section>;
}
