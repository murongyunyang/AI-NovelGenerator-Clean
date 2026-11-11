"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";
import { LibraryManager } from "./AgentLibrary";

const CONTROL = "w-full min-w-0 rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-accent disabled:opacity-60";

export interface FeedbackMemory { id: string; title: string; text: string; category?: string; plot_specific?: boolean }

/** 后端 agent_feedback.record 的返回：意见直接整理成了一条写作偏好。 */
export interface FeedbackResult {
  action: "created" | "updated" | "exists";
  memory: FeedbackMemory;
  previous_text: string | null;
}

interface ModelOptions { provider?: string; model?: string }
interface Note { id: string; text: string; issue: string; created_at: string | null }

/**
 * 把作者给智能体的一条意见整理成写作偏好并保存。
 * 失败只返回 null：偏好没存下不影响按意见修改。
 */
export async function recordAgentFeedback(novelId: string, text: string, options: { target?: "chapter" | "outline"; excerpt?: string } & ModelOptions = {}): Promise<FeedbackResult | null> {
  try {
    return await apiPost<FeedbackResult>(`/api/novels/${novelId}/writing-agent/feedback`, {
      text, target: options.target ?? "chapter", excerpt: (options.excerpt ?? "").slice(0, 400),
      provider: options.provider ?? "", model: options.model ?? "",
    });
  } catch {
    return null;
  }
}

/** 给一条偏好提意见，由模型按意见改写；改写后显示前后对比，可以撤销。 */
export function PreferenceReviser({ novelId, memory, model = {}, onChanged, onClose }: { novelId: string; memory: FeedbackMemory; model?: ModelOptions; onChanged?: (memory: FeedbackMemory) => void; onClose?: () => void }) {
  const zh = useLocale() !== "en";
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [before, setBefore] = useState<{ text: string; title: string } | null>(null);
  const [after, setAfter] = useState<FeedbackMemory | null>(null);
  const base = `/api/novels/${novelId}/writing-agent/memories/${memory.id}`;
  const submit = async () => {
    setBusy(true); setError("");
    try {
      const result = await apiPost<{ before: { text: string; title: string }; memory: FeedbackMemory }>(`${base}/revise`, {
        instruction: instruction.trim(), provider: model.provider ?? "", model: model.model ?? "",
      });
      setBefore(result.before); setAfter(result.memory); setInstruction("");
      onChanged?.(result.memory);
    } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  };
  const undo = async () => {
    if (!before) return;
    setBusy(true); setError("");
    try {
      const restored = await apiPatch<FeedbackMemory>(base, { text: before.text, title: before.title });
      setBefore(null); setAfter(null);
      onChanged?.(restored);
    } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  };
  return <div className="mt-2 space-y-2 rounded-lg border border-border bg-background p-2 text-xs" data-testid="preference-reviser">
    {after && before && <div className="space-y-1" data-testid="preference-revised">
      <p className="text-muted">{zh ? "改写前：" : "Before: "}<span className="line-through">{before.text}</span></p>
      <p>{zh ? "改写后：" : "After: "}{after.text}</p>
      <button type="button" className="text-accent" disabled={busy} onClick={() => void undo()}>{zh ? "撤销这次改写" : "Undo this rewrite"}</button>
    </div>}
    <textarea aria-label={zh ? "对这条偏好的意见" : "Feedback on this preference"} className={`${CONTROL} min-h-16 resize-y`} value={instruction} maxLength={2000} disabled={busy}
      placeholder={zh ? "这条偏好哪里不对？例如：不用每章都这样，只在战斗场面" : "What should change? e.g. only in fight scenes"} onChange={(e) => setInstruction(e.target.value)} />
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className="text-accent disabled:opacity-60" disabled={busy || !instruction.trim()} onClick={() => void submit()}>{busy ? (zh ? "改写中…" : "Rewriting…") : (zh ? "按意见改写" : "Rewrite")}</button>
      {onClose && <button type="button" className="text-muted" disabled={busy} onClick={onClose}>{zh ? "收起" : "Close"}</button>}
    </div>
    {error && <p role="alert" className="text-danger">{error}</p>}
  </div>;
}

/** 先商量再保存：模型给出的偏好草案（还没有保存）。 */
export interface FeedbackDraft {
  understanding: string;
  text: string;
  title: string;
  category: string;
  plot_specific: boolean;
  memory_id: string | null;
  alternatives: string[];
  question: string;
  replaces: { id: string; text: string } | null;
}

/** 给智能体提的一条意见，等作者确认方向后才存成偏好。 */
export interface PendingFeedback { text: string; excerpt: string; target: "chapter" | "outline" }

/**
 * 意见先不存：模型说出它理解的方向、给出偏好草案并提问，作者逐轮调整，确认后才保存。
 * 每条新意见重新挂载，状态不沿用上一条。
 */
export function FeedbackPreferenceDraft(props: { novelId: string; feedback: PendingFeedback; model?: ModelOptions; onChanged?: () => void }) {
  return <PreferenceDraft key={`${props.feedback.target}:${props.feedback.text}`} {...props} />;
}

function PreferenceDraft({ novelId, feedback, model = {}, onChanged }: { novelId: string; feedback: PendingFeedback; model?: ModelOptions; onChanged?: () => void }) {
  const zh = useLocale() !== "en";
  const [turns, setTurns] = useState<{ proposal: string; reply: string }[]>([]);
  const [current, setCurrent] = useState<FeedbackDraft | null>(null);
  const [chosen, setChosen] = useState("");
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<FeedbackResult | null>(null);
  const [skipped, setSkipped] = useState(false);
  const base = `/api/novels/${novelId}/writing-agent/feedback`;

  const ask = useCallback(async (history: { proposal: string; reply: string }[]) => {
    setBusy(true); setError("");
    try {
      const result = await apiPost<FeedbackDraft>(`${base}/draft`, {
        text: feedback.text, target: feedback.target, excerpt: feedback.excerpt.slice(0, 400), turns: history,
        provider: model.provider ?? "", model: model.model ?? "",
      });
      setCurrent(result); setChosen(result.text);
    } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  }, [base, feedback, model.provider, model.model]);

  useEffect(() => { void ask([]); }, [ask]);

  const adjust = () => {
    if (!reply.trim()) return;
    const history = [...turns, { proposal: chosen, reply: reply.trim() }];
    setTurns(history); setReply("");
    void ask(history);
  };
  const save = async () => {
    if (!current || !chosen.trim()) return;
    setBusy(true); setError("");
    try {
      const result = await apiPost<FeedbackResult>(`${base}/confirm`, {
        text: chosen.trim(), title: chosen === current.text ? current.title : "", category: current.category,
        plot_specific: current.plot_specific, memory_id: chosen === current.text ? current.memory_id : null,
      });
      setSaved(result); onChanged?.();
    } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  };

  if (saved) return <FeedbackPreferenceNotice novelId={novelId} result={saved} model={model} onChanged={onChanged} />;
  if (skipped) return <p role="status" data-testid="feedback-draft" className="text-xs text-muted">{zh ? "这条意见只用于这次修改，没有存成写作偏好。" : "Used for this revision only; not saved as a preference."}</p>;
  const options = current ? [current.text, ...current.alternatives.filter((item) => item.trim() && item !== current.text)] : [];
  return <div role="status" data-testid="feedback-draft" className="space-y-2 rounded-lg border border-border bg-background p-2 text-xs">
    <p className="font-medium">{zh ? "要把这条意见记成写作偏好吗？先确认方向" : "Save this as a writing preference? Confirm the direction first"}</p>
    {!current && busy && <p className="text-muted">{zh ? "正在理解你的意见…" : "Reading your feedback…"}</p>}
    {current && <>
      {current.understanding && <p>{zh ? "我理解你想要的效果：" : "What I think you want: "}{current.understanding}</p>}
      <div className="space-y-1">
        <p className="text-muted">{options.length > 1 ? (zh ? "可以这样记（选一条）：" : "Possible rules (pick one):") : (zh ? "打算这样记：" : "Proposed rule:")}</p>
        {options.map((option) => <label key={option} className="flex items-start gap-2 rounded-md border border-border px-2 py-1.5">
          <input type="radio" className="mt-0.5 shrink-0" name={`draft-${feedback.text.length}`} checked={chosen === option} disabled={busy} onChange={() => setChosen(option)} />
          <span className="min-w-0 flex-1 leading-5">{option}</span>
        </label>)}
        {current.replaces && chosen === current.text && <p className="text-muted">{zh ? "会改写已有的一条：" : "Will rewrite: "}{current.replaces.text}</p>}
      </div>
      {current.question && <p>{zh ? "想确认一下：" : "One question: "}{current.question}</p>}
    </>}
    <textarea aria-label={zh ? "对偏好方向的回应" : "Reply about the direction"} className={`${CONTROL} min-h-14 resize-y`} value={reply} maxLength={2000} disabled={busy}
      placeholder={zh ? "哪里不对就直接说，例如：不是每章都要，只在打斗后写主角的心理" : "Say what's off, e.g. only after fight scenes"} onChange={(e) => setReply(e.target.value)} />
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className="text-accent disabled:opacity-60" disabled={busy || !reply.trim()} onClick={adjust}>{busy && current ? (zh ? "调整中…" : "Adjusting…") : (zh ? "按我说的再调整" : "Adjust")}</button>
      <button type="button" className="text-accent disabled:opacity-60" disabled={busy || !current || !chosen.trim()} onClick={() => void save()}>{zh ? "就按这条保存" : "Save this rule"}</button>
      <button type="button" className="text-muted disabled:opacity-60" disabled={busy} onClick={() => setSkipped(true)}>{zh ? "这次不存" : "Don't save"}</button>
    </div>
    {turns.length > 0 && <p className="text-muted">{zh ? `已调整 ${turns.length} 轮` : `${turns.length} adjustment(s)`}</p>}
    {error && <p role="alert" className="text-danger">{error}{!current && <button type="button" className="ml-2 text-accent" onClick={() => void ask(turns)}>{zh ? "重试" : "Retry"}</button>}</p>}
  </div>;
}

/** 意见保存成偏好后的提示：显示这条偏好，可以提意见改写，或撤销这次保存。每条新结果重新挂载，状态不沿用上一条。 */
export function FeedbackPreferenceNotice(props: { novelId: string; result: FeedbackResult | null; model?: ModelOptions; onChanged?: () => void }) {
  const key = props.result ? `${props.result.action}:${props.result.memory.id}:${props.result.memory.text}` : "none";
  return <PreferenceNotice key={key} {...props} />;
}

function PreferenceNotice({ novelId, result, model, onChanged }: { novelId: string; result: FeedbackResult | null; model?: ModelOptions; onChanged?: () => void }) {
  const zh = useLocale() !== "en";
  const [memory, setMemory] = useState<FeedbackMemory | null>(result?.memory ?? null);
  const [revising, setRevising] = useState(false);
  const [undone, setUndone] = useState(false);
  const [error, setError] = useState("");
  if (!result || !memory) return <p role="status" data-testid="feedback-preference-notice" className="text-xs text-muted">{zh ? "意见没能存成写作偏好（不影响这次修改）。" : "The feedback could not be saved as a preference (the revision still runs)."}</p>;
  const base = `/api/novels/${novelId}/writing-agent/memories/${memory.id}`;
  const undo = async () => {
    setError("");
    try {
      if (result.action === "created") await apiDelete(base);
      else if (result.action === "updated" && result.previous_text !== null) await apiPatch(base, { text: result.previous_text });
      setUndone(true); setRevising(false); onChanged?.();
    } catch (failure) { setError((failure as Error).message); }
  };
  if (undone) return <p role="status" data-testid="feedback-preference-notice" className="text-xs text-muted">{zh ? "已撤销，这条意见只用于这次修改。" : "Undone. The feedback applies to this revision only."}</p>;
  const heading = result.action === "created" ? (zh ? "已加入写作偏好" : "Added to writing preferences")
    : result.action === "updated" ? (zh ? "已更新写作偏好" : "Updated a writing preference")
    : (zh ? "写作偏好里已有这一条" : "Already in writing preferences");
  return <div role="status" data-testid="feedback-preference-notice" className="space-y-1 rounded-lg border border-accent/40 bg-accent/5 p-2 text-xs">
    <p><span className="font-medium">{heading}</span>{memory.plot_specific ? (zh ? "（只用于本书）" : " (this book only)") : ""}：{memory.text}</p>
    {result.action === "updated" && result.previous_text && <p className="text-muted">{zh ? "原来是：" : "Was: "}{result.previous_text}</p>}
    <div className="flex flex-wrap gap-3">
      <button type="button" className="text-accent" onClick={() => setRevising(!revising)}>{zh ? "不太对，提意见修改" : "Not quite, revise it"}</button>
      {result.action !== "exists" && <button type="button" className="text-muted" onClick={() => void undo()}>{zh ? "撤销" : "Undo"}</button>}
    </div>
    {revising && <PreferenceReviser novelId={novelId} memory={memory} model={model} onChanged={(next) => { setMemory(next); onChanged?.(); }} onClose={() => setRevising(false)} />}
    {error && <p role="alert" className="text-danger">{error}</p>}
  </div>;
}

/** 以前暂存的意见（旧版“出现 3 次才总结”留下的）和已总结的经验。 */
export function FeedbackNotesPanel({ novelId, refreshKey = 0 }: { novelId: string; refreshKey?: number }) {
  const zh = useLocale() !== "en";
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [error, setError] = useState("");
  const base = `/api/novels/${novelId}/writing-agent/feedback`;
  const load = useCallback(() => {
    void apiGet<{ notes: Note[] }>(base).then((data) => { setNotes(data.notes); setError(""); })
      .catch((failure) => setError((failure as Error).message));
  }, [base]);
  useEffect(() => { load(); }, [load, refreshKey]);
  const remove = async (note: Note) => {
    try { await apiDelete(`${base}/${note.id}`); load(); } catch (failure) { setError((failure as Error).message); }
  };
  return <div className="space-y-3" data-testid="agent-feedback-notes">
    <p className="text-xs leading-5 text-muted">{zh
      ? "点“给智能体提意见”后，智能体会先说出它打算怎么记这条偏好，你确认或调整方向后才保存；在“写作偏好”里可以查看、修改或删除。下面是以前暂存的意见和已总结的经验。"
      : "“Give the agent feedback” proposes a preference and saves it only after you confirm. Older kept notes and lessons are listed below."}</p>
    {notes === null ? <p className="text-xs text-muted">{error || (zh ? "读取中…" : "Loading…")}</p>
      : notes.length > 0 && <ul className="space-y-1.5">{notes.map((note) => <li key={note.id} className="flex items-start gap-2 rounded-lg border border-border px-2 py-1.5 text-sm">
        <div className="min-w-0 flex-1"><p className="leading-6">{note.text}</p>{note.issue && <p className="text-xs text-muted">{zh ? "问题类型：" : "Issue: "}{note.issue}</p>}</div>
        <button type="button" className="shrink-0 text-xs text-accent" onClick={() => void remove(note)}>{zh ? "删除" : "Delete"}</button></li>)}</ul>}
    {error && notes !== null && <p role="alert" className="text-xs text-danger">{error}</p>}
    <LibraryManager novelId={novelId} />
  </div>;
}
