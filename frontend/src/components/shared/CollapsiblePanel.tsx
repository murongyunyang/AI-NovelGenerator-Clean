"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";

/** 侧栏收起状态；按 key 记在本机，读写失败时只在本次会话有效。 */
export function useCollapsed(key: string): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try { setCollapsed(localStorage.getItem(`novel-panel:${key}`) === "1"); } catch { /* 无痕模式等读不到时保持展开 */ }
  }, [key]);
  const set = (next: boolean) => {
    setCollapsed(next);
    try { localStorage.setItem(`novel-panel:${key}`, next ? "1" : "0"); } catch { /* 只影响下次打开 */ }
  };
  return [collapsed, set];
}

/** 侧栏标题里的“收起”按钮。 */
export function CollapseButton({ onPress, label, controls }: { onPress: () => void; label?: string; controls?: string }) {
  const zh = useLocale() !== "en";
  const text = label ?? (zh ? "收起侧栏" : "Collapse");
  return <button type="button" data-testid="panel-collapse" aria-label={text} title={text} aria-controls={controls} aria-expanded
    className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-background hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
    onClick={onPress}>
    <svg aria-hidden="true" className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m11 17-5-5 5-5M18 17l-5-5 5-5" /></svg>
  </button>;
}

/** 收起后留下的窄条：点一下展开，竖排显示栏目名。 */
export function CollapsedRail({ onExpand, label, controls, count }: { onExpand: () => void; label: string; controls?: string; count?: number }) {
  const zh = useLocale() !== "en";
  return <button type="button" data-testid="panel-expand" aria-label={zh ? `展开${label}` : `Expand ${label}`} title={zh ? `展开${label}` : `Expand ${label}`} aria-controls={controls} aria-expanded={false}
    className="flex min-h-0 w-full shrink-0 items-center justify-center gap-3 rounded-2xl border border-border bg-surface px-3 py-2 text-muted hover:text-accent focus-visible:outline-2 focus-visible:outline-accent md:w-10 md:flex-col md:justify-start md:px-0 md:py-3"
    onClick={onExpand}>
    <svg aria-hidden="true" className="size-4 rotate-90 md:rotate-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m13 17 5-5-5-5M6 17l5-5-5-5" /></svg>
    <span className="text-xs md:[writing-mode:vertical-rl]">{label}{count !== undefined ? ` · ${count}` : ""}</span>
  </button>;
}
