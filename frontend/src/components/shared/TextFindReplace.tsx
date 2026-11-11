"use client";

import { useEffect, useEffectEvent, useId, useMemo, useRef, useState, type RefObject } from "react";
import { Button } from "@heroui/react";
import { useLocale } from "next-intl";
import { findTextMatches, nextTextMatch, replaceTextMatches, revealTextMatch, type TextMatch } from "@/lib/textSearch";

const FIELD = "min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-accent/30";

/** Scoped to one editor. Replacements use its normal draft/save path. */
export function TextFindReplace({ textareaRef, value, onChange, disabled = false }: {
  textareaRef: RefObject<HTMLTextAreaElement | null>; value: string;
  onChange?: (next: string) => void; disabled?: boolean;
}) {
  const zh = useLocale() !== "en";
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [current, setCurrent] = useState<{ query: string; matchCase: boolean; match: TextMatch } | null>(null);
  const [undo, setUndo] = useState<{ before: string; after: string; count: number } | null>(null);
  const matches = useMemo(() => open ? findTextMatches(value, query, matchCase) : [], [open, value, query, matchCase]);
  const currentIndex = current?.query === query && current.matchCase === matchCase
    ? matches.findIndex((match) => match.start === current.match.start && match.end === current.match.end) : -1;

  const show = () => {
    const area = textareaRef.current;
    const selected = area?.value.slice(area.selectionStart, area.selectionEnd);
    if (selected && selected.length <= 500) setQuery(selected);
    setOpen(true);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
  };
  const close = () => { setOpen(false); textareaRef.current?.focus({ preventScroll: true }); };
  const reveal = (match: TextMatch) => {
    setCurrent({ query, matchCase, match });
    const area = textareaRef.current;
    if (area) revealTextMatch(area, match);
  };
  const move = (backwards = false, keepFocus = false) => {
    const area = textareaRef.current;
    if (!area || !matches.length) return;
    const focused = document.activeElement;
    reveal(matches[nextTextMatch(matches, area.selectionStart, area.selectionEnd, backwards)]);
    if (keepFocus && focused instanceof HTMLElement) focused.focus({ preventScroll: true });
  };
  const shortcut = useEffectEvent((event: KeyboardEvent) => {
    const target = event.target;
    if (!(target instanceof Node) || (target !== textareaRef.current && !panel.current?.contains(target))) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && ["h", "f"].includes(event.key.toLowerCase())) {
      event.preventDefault(); event.stopPropagation(); show();
    } else if (open && event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); close();
    } else if (open && event.key === "F3") {
      event.preventDefault(); event.stopPropagation(); move(event.shiftKey, target !== textareaRef.current);
    }
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => shortcut(event);
    document.addEventListener("keydown", listener, true);
    return () => document.removeEventListener("keydown", listener, true);
  }, []);

  const replace = (all: boolean) => {
    const area = textareaRef.current;
    if (!onChange || disabled || !area || area.disabled || area.readOnly || !matches.length) return;
    const selected = matches.findIndex((match) => match.start === area.selectionStart && match.end === area.selectionEnd);
    const index = selected >= 0 ? selected : nextTextMatch(matches, area.selectionStart, area.selectionEnd);
    // A single replacement must be a match the author can see first.
    if (!all && selected < 0) { reveal(matches[index]); return; }
    const targets = all ? matches : [matches[index]];
    const next = replaceTextMatches(value, targets, replacement);
    setUndo({ before: value, after: next, count: targets.length });
    onChange(next);
    const after = findTextMatches(next, query, matchCase);
    const offset = targets[0].start + replacement.length;
    const nextIndex = after.findIndex((match) => match.start >= offset);
    requestAnimationFrame(() => {
      if (area.value !== next) return;
      if (!all && after.length) reveal(after[nextIndex < 0 ? 0 : nextIndex]);
      else { area.focus({ preventScroll: true }); area.setSelectionRange(offset, offset); setCurrent(null); }
    });
  };

  return <div ref={panel} data-autogrow="off" data-testid="text-find-replace" className="shrink-0 text-xs">
    <Button size="sm" variant="ghost" data-testid="text-find-toggle" aria-expanded={open} aria-controls={id} onPress={() => open ? close() : show()}>
      {zh ? "查找 / 替换" : "Find / Replace"}<span className="ml-1 text-muted">Ctrl+H</span>
    </Button>
    {open && <div id={id} className="mt-1 space-y-2 rounded-xl border border-border bg-background/50 p-3" role="group" aria-label={zh ? "当前文稿内查找和替换" : "Find and replace in this draft"}>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-40 flex-1 items-center gap-2"><span>{zh ? "查找" : "Find"}</span><input ref={input} data-testid="text-find-query" aria-label={zh ? "查找内容" : "Find text"} className={FIELD} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); move(event.shiftKey, true); } }} /></label>
        <span role="status" aria-live="polite" data-testid="text-find-count" className="tabular-nums text-muted">{query ? (matches.length ? (currentIndex < 0 ? (zh ? `共 ${matches.length} 处` : `${matches.length} matches`) : `${currentIndex + 1} / ${matches.length}`) : (zh ? "未找到" : "No matches")) : (zh ? "输入关键词" : "Enter text")}</span>
        <Button size="sm" variant="secondary" data-testid="text-find-prev" isDisabled={!matches.length} onPress={() => move(true)}>{zh ? "上一处" : "Previous"}</Button>
        <Button size="sm" variant="secondary" data-testid="text-find-next" isDisabled={!matches.length} onPress={() => move()}>{zh ? "下一处" : "Next"}</Button>
        <Button size="sm" variant="ghost" aria-label={zh ? "关闭查找" : "Close find"} onPress={close}>×</Button>
      </div>
      {onChange && <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-40 flex-1 items-center gap-2"><span>{zh ? "替换为" : "Replace with"}</span><input data-testid="text-replace-value" aria-label={zh ? "替换为" : "Replace with"} className={FIELD} value={replacement} disabled={disabled} onChange={(event) => setReplacement(event.target.value)} /></label>
        <Button size="sm" variant="secondary" data-testid="text-replace-one" isDisabled={disabled || !matches.length} onPress={() => replace(false)}>{zh ? "替换" : "Replace"}</Button>
        <Button size="sm" variant="secondary" data-testid="text-replace-all" isDisabled={disabled || !matches.length} onPress={() => replace(true)}>{zh ? "全部替换" : "Replace all"}</Button>
        {undo && undo.before !== undo.after && undo.after === value && <Button size="sm" variant="ghost" data-testid="text-replace-undo" isDisabled={disabled} onPress={() => { onChange(undo.before); setUndo(null); setCurrent(null); }}>{zh ? "撤销替换" : "Undo replace"}</Button>}
      </div>}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted">
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={matchCase} onChange={(event) => setMatchCase(event.target.checked)} />{zh ? "区分大小写" : "Match case"}</label>
        <span>{zh ? `范围：当前文稿${onChange ? "；替换后请保存" : "（只读）"}` : `Scope: this draft${onChange ? "; save after replacing" : " (read only)"}`}</span>
        {undo?.after === value && <span role="status">{zh ? `已替换 ${undo.count} 处` : `Replaced ${undo.count} match(es)`}</span>}
      </div>
    </div>}
  </div>;
}
