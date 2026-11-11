"use client";

import { useRef, useState } from "react";
import { Button } from "@heroui/react";
import { useLocale } from "next-intl";

/**
 * 批量选择工具条：全选本页、从上次选中处往后连选 N 章、清空，以及调用方给的批量操作。
 * Args: ids 当前页（或当前列表）按顺序的 ID；selected 已选；onChange 新的选择；anchor 没有选中时从哪一章开始连选；children 批量操作按钮。
 */
export function BatchSelectBar({ ids, selected, onChange, anchor, disabled = false, pageLabel, children }: {
  ids: string[]; selected: string[]; onChange: (next: string[]) => void; anchor?: string | null;
  disabled?: boolean; pageLabel?: string; children?: React.ReactNode;
}) {
  const zh = useLocale() !== "en";
  const [count, setCount] = useState("10");
  const chosen = new Set(selected);
  const allOnPage = ids.length > 0 && ids.every((id) => chosen.has(id));
  const selectNext = () => {
    const n = Math.max(1, Math.min(10000, Math.floor(Number(count)) || 0));
    // 从最后一个已选章往后；没有已选时从当前打开的章开始（含当前章）。
    const last = ids.reduce((at, id, index) => chosen.has(id) ? index : at, -1);
    const start = last >= 0 ? last + 1 : Math.max(0, anchor ? ids.indexOf(anchor) : 0);
    const added = ids.slice(start).filter((id) => !chosen.has(id)).slice(0, n);
    onChange([...selected, ...added]);
  };
  return <div data-testid="batch-select-bar" className="space-y-2 rounded-xl border border-accent/30 bg-accent/5 p-2 text-xs">
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-medium text-foreground">{zh ? `已选 ${selected.length} 章` : `${selected.length} selected`}</span>
      <Button size="sm" variant="ghost" isDisabled={disabled || !ids.length} onPress={() => onChange(allOnPage ? selected.filter((id) => !ids.includes(id)) : [...selected, ...ids.filter((id) => !chosen.has(id))])}>
        {allOnPage ? (zh ? "取消全选本页" : "Unselect page") : (pageLabel ?? (zh ? "全选本页" : "Select page"))}
      </Button>
      {selected.length > 0 && <Button size="sm" variant="ghost" isDisabled={disabled} onPress={() => onChange([])}>{zh ? "清空" : "Clear"}</Button>}
    </div>
    <div className="flex flex-wrap items-center gap-1">
      <span>{zh ? "往后增选" : "Add next"}</span>
      <input type="number" min={1} inputMode="numeric" aria-label={zh ? "增选章数" : "Chapters to add"} data-autogrow="off" disabled={disabled}
        className="w-16 rounded-lg border border-border bg-background px-2 py-1 text-foreground" value={count} onChange={(e) => setCount(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); selectNext(); } }} />
      <span>{zh ? "章" : ""}</span>
      <Button size="sm" variant="secondary" isDisabled={disabled || !ids.length} onPress={selectNext}>{zh ? "增选" : "Add"}</Button>
    </div>
    {children && <div className="flex flex-wrap items-center gap-2 border-t border-accent/20 pt-2">{children}</div>}
  </div>;
}

export type BatchProgress = { done: number; total: number; current: string; failures: { title: string; message: string }[] };

/**
 * 依次处理选中的章节，可中途停止；单章失败只记下原因，继续下一章。
 * Returns: run 开始；stop 停止；progress 进度（未运行时为 null）；running 是否在运行。
 */
export function useBatchRun() {
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [running, setRunning] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const run = async <T,>(items: T[], title: (item: T) => string, work: (item: T, signal: AbortSignal) => Promise<void>) => {
    if (controller.current) return null;
    const abort = new AbortController(); controller.current = abort;
    const state: BatchProgress = { done: 0, total: items.length, current: "", failures: [] };
    // 项目开了 React Compiler：每次都给新的对象和数组，不能原地改。
    const publish = () => setProgress({ ...state, failures: [...state.failures] });
    setRunning(true); publish();
    try {
      for (const item of items) {
        if (abort.signal.aborted) break;
        state.current = title(item); publish();
        try { await work(item, abort.signal); }
        catch (e) { if (!abort.signal.aborted) state.failures = [...state.failures, { title: title(item), message: (e as Error).message }]; }
        if (!abort.signal.aborted) state.done++;
        publish();
      }
    } finally {
      state.current = ""; publish(); setRunning(false); controller.current = null;
    }
    return { ...state, stopped: abort.signal.aborted };
  };
  return { run, stop: () => controller.current?.abort(), progress, running, clear: () => setProgress(null) };
}

/** 批量任务进度与失败明细。 */
export function BatchProgressView({ progress, running, onStop, onClose }: { progress: BatchProgress | null; running: boolean; onStop: () => void; onClose: () => void }) {
  const zh = useLocale() !== "en";
  if (!progress) return null;
  return <div role="status" data-testid="batch-progress" className="space-y-1 rounded-xl border border-border bg-background p-2 text-xs">
    <div className="flex flex-wrap items-center gap-2">
      <span className="tabular-nums">{zh ? `进度 ${progress.done}/${progress.total}` : `${progress.done}/${progress.total}`}</span>
      {progress.current && <span className="text-fill truncate text-muted">{zh ? `正在处理：${progress.current}` : `Working on: ${progress.current}`}</span>}
      {running ? <Button size="sm" variant="ghost" onPress={onStop}>{zh ? "停止" : "Stop"}</Button> : <Button size="sm" variant="ghost" onPress={onClose}>{zh ? "关闭" : "Close"}</Button>}
    </div>
    {progress.failures.length > 0 && <details><summary className="cursor-pointer text-danger">{zh ? `${progress.failures.length} 章未完成` : `${progress.failures.length} failed`}</summary>
      <ul className="mt-1 max-h-32 list-disc space-y-0.5 overflow-y-auto pl-5">{progress.failures.map((f, i) => <li key={i}>{f.title}：{f.message}</li>)}</ul></details>}
  </div>;
}
