"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useOpenBooks } from "@/lib/openBooks";
import { agentQuestionsServerSnapshot, agentQuestionsSnapshot, completeAgentQuestion, minimizeAgentQuestion, questionAnswer,
  readAgentQuestionDraft, reopenAgentQuestion, saveAgentQuestionDraft, subscribeAgentQuestions, type PendingAgentQuestion } from "@/lib/agentQuestions";

/** Explicit selection and submission are required; Escape and the close button only minimize. */
export function AgentQuestionDialog({ question, open, zh, bookTitle, onDismiss }: {
  question: PendingAgentQuestion; open: boolean; zh: boolean; bookTitle?: string; onDismiss: () => void;
}) {
  const [selected, setSelected] = useState<number[]>(() => readAgentQuestionDraft(question.key).selected);
  const [note, setNote] = useState(() => readAgentQuestionDraft(question.key).note);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const restore = useRef<HTMLElement | null>(null);
  const answer = questionAnswer(question.options, selected, note);
  const dialogId = useId();
  const titleId = `${dialogId}-title`;
  const bodyId = `${dialogId}-body`;

  useEffect(() => {
    if (!open) return;
    restore.current = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => box.current?.querySelector<HTMLElement>("input, textarea, button")?.focus(), 30);
    return () => { window.clearTimeout(timer); restore.current?.focus?.(); };
  }, [open]);

  const send = async () => {
    if (submitting.current || !answer) return;
    submitting.current = true; setSending(true); setError("");
    try {
      await question.submit(answer);
      completeAgentQuestion(question.owner, question.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : (zh ? "回答未发送，请重试。" : "Could not send your answer. Try again."));
    } finally { submitting.current = false; setSending(false); }
  };
  const dismiss = () => { if (!submitting.current) onDismiss(); };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); return; }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
      event.preventDefault(); event.stopPropagation(); void send(); return;
    }
    if (event.key !== "Tab" || !box.current) return;
    const focusable = [...box.current.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), textarea:not([disabled])")];
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  if (!open || typeof document === "undefined") return null;
  return createPortal(<div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50 p-3 backdrop-blur-sm" data-agent-question-backdrop data-react-aria-top-layer="true" onKeyDown={onKeyDown}>
    <div ref={box} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} data-testid="agent-question-dialog"
      data-question-id={question.id} data-novel-id={question.novelId} className="workspace-scrollbar max-h-[90dvh] w-full max-w-xl space-y-4 overflow-y-auto rounded-2xl border border-accent/40 bg-background p-5 text-foreground shadow-2xl">
      <header className="flex items-start justify-between gap-3">
        <div><h2 id={titleId} className="font-semibold">{zh ? "智能体需要你选择" : "The agent needs your answer"}</h2>
          <p className="mt-1 text-xs text-muted">{bookTitle ? `《${bookTitle}》 · ` : ""}{question.source === "book" ? (zh ? "全自动智能体" : "Book agent") : (zh ? "写作工作流程" : "Writing workflow")}</p></div>
        <button type="button" data-testid="agent-question-close" disabled={sending} className="rounded-lg px-2 py-1 text-sm text-muted hover:bg-surface disabled:opacity-50" aria-label={zh ? "稍后回答" : "Answer later"} onClick={dismiss}>×</button>
      </header>
      <p id={bodyId} data-testid="agent-question-text" className="whitespace-pre-wrap text-sm leading-7">{question.question}</p>
      {question.options.length > 0 && <fieldset disabled={sending} className="space-y-2">
        <legend className="mb-2 text-xs text-muted">{question.multiSelect ? (zh ? "可选择多项" : "Choose one or more") : (zh ? "请选择一项，也可以在下方填写其他回答" : "Choose one, or write your own answer below")}</legend>
        {question.options.map((option, index) => <label key={`${index}:${option}`} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm leading-6 ${selected.includes(index) ? "border-accent bg-accent/10" : "border-border hover:bg-surface"}`}>
          <input type={question.multiSelect ? "checkbox" : "radio"} name={`question-${question.key}`} data-testid="agent-question-option" className="mt-1 accent-[var(--accent)]" checked={selected.includes(index)}
            onChange={() => {
              const next = question.multiSelect ? (selected.includes(index) ? selected.filter((value) => value !== index) : [...selected, index]) : [index];
              setSelected(next); saveAgentQuestionDraft(question.key, { selected: next, note });
            }} />
          <span className="whitespace-pre-wrap">{option}</span>
        </label>)}
      </fieldset>}
      <label className="grid gap-2 text-sm"><span>{question.options.length ? (zh ? "补充说明 / 其他回答" : "Add details / another answer") : (zh ? "你的回答" : "Your answer")}</span>
        <textarea data-testid="agent-question-answer" rows={3} value={note} disabled={sending} className="w-full resize-y rounded-xl border border-border bg-background p-3 text-sm leading-6 outline-none focus:border-accent" onChange={(event) => {
          setNote(event.target.value); saveAgentQuestionDraft(question.key, { selected, note: event.target.value });
        }} /></label>
      {error && <p role="alert" data-testid="agent-question-error" className="whitespace-pre-wrap text-sm text-danger">{error}</p>}
      <p className="text-xs leading-5 text-muted">{zh ? "提交后智能体会接着当前任务工作。稍后回答会保留问题并继续等待。" : "Submitting continues the current task. Answer later keeps the question waiting."}</p>
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" disabled={sending} className="rounded-xl border border-border px-4 py-2 text-sm disabled:opacity-50" onClick={dismiss}>{zh ? "稍后回答" : "Answer later"}</button>
        <button type="button" data-testid="agent-question-submit" disabled={sending || !answer} className="rounded-xl bg-accent px-4 py-2 text-sm text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50" onClick={() => void send()}>{sending ? (zh ? "正在发送…" : "Sending…") : (zh ? "提交并继续" : "Submit and continue")}</button>
      </div>
    </div>
  </div>, document.body);
}

/** All workflows share one queue, so parallel questions never stack modal dialogs. */
export function AgentQuestionHost() {
  const questions = useSyncExternalStore(subscribeAgentQuestions, agentQuestionsSnapshot, agentQuestionsServerSnapshot);
  const { books } = useOpenBooks();
  const pending = questions.filter((question) => question.visible);
  const current = pending.find((question) => !question.minimized) ?? pending[0];
  const zh = typeof document === "undefined" || document.documentElement.lang !== "en";
  if (!current) return null;
  return <>
    <AgentQuestionDialog key={current.key} question={current} open={!current.minimized} zh={zh} bookTitle={books.find((book) => book.id === current.novelId)?.title} onDismiss={() => minimizeAgentQuestion(current.key)} />
    {current.minimized && <button type="button" data-testid="agent-question-reopen" className="fixed bottom-5 right-5 z-[999] max-w-[calc(100vw-2.5rem)] rounded-2xl border border-accent bg-background px-4 py-3 text-sm text-accent shadow-xl" onClick={() => reopenAgentQuestion(current.owner, current.id)}>
      {zh ? "智能体在等你回答" : "The agent is waiting for you"}{pending.length > 1 ? ` (${pending.length})` : ""}
    </button>}
  </>;
}
