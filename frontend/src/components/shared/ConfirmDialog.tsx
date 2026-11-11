"use client";

/* 统一的确认小窗，代替浏览器自带的 window.confirm：随风格换外观，有入场/退场动效，Esc 取消、Enter 确认，焦点留在小窗里。
   用法：if (!(await confirmDialog({ message: "…" }))) return;  宿主 <ConfirmHost /> 在 providers.tsx 里挂一次。 */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useSyncExternalStore } from "react";

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "default";
  /** 额外的一个按钮（例如“导出草稿”）：点了执行，小窗不关。 */
  extra?: { label: string; onPress: () => void };
}

interface Pending extends ConfirmOptions { id: number; resolve: (ok: boolean) => void }

let queue: Pending[] = [];
let serial = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => queue[0] ?? null;
const serverSnapshot = () => null;

const isNative = (fn: unknown) => typeof fn === "function" && /\[native code\]/.test(Function.prototype.toString.call(fn));

/** 弹出确认小窗，确认时返回 true。界面测试会把 window.confirm 换成自己的函数，此时直接用它，测试不必改。 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (!isNative(window.confirm)) return Promise.resolve(Boolean(window.confirm([options.title, options.message].filter(Boolean).join("\n"))));
  return new Promise((resolve) => {
    queue = [...queue, { ...options, id: ++serial, resolve }];
    emit();
  });
}

function settle(id: number, ok: boolean) {
  const item = queue.find((entry) => entry.id === id);
  if (!item) return;
  queue = queue.filter((entry) => entry.id !== id);
  item.resolve(ok);
  emit();
}

export function ConfirmHost() {
  const current = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const reduce = useReducedMotion();
  const zh = typeof document === "undefined" || document.documentElement.lang !== "en";
  const box = useRef<HTMLDivElement>(null);
  const restore = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!current) {
      // 小窗全部关闭后把焦点还给打开它之前的按钮。
      restore.current?.focus?.();
      restore.current = null;
      return;
    }
    restore.current ??= document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => box.current?.querySelector<HTMLButtonElement>("[data-confirm-ok]")?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [current]);

  const onKey = (event: React.KeyboardEvent) => {
    if (!current) return;
    if (event.key === "Escape") { event.preventDefault(); settle(current.id, false); return; }
    if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); settle(current.id, true); return; }
    if (event.key !== "Tab" || !box.current) return;
    const focusable = [...box.current.querySelectorAll<HTMLElement>("button:not([disabled])")];
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  return <AnimatePresence>
    {current && <motion.div key={current.id} className="cd-backdrop" onKeyDown={onKey} data-react-aria-top-layer="true"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduce ? 0 : 0.18 }}
      onMouseDown={(event) => { if (event.target === event.currentTarget) settle(current.id, false); }}>
      <motion.div ref={box} role="alertdialog" aria-modal="true" aria-labelledby={`cd-title-${current.id}`} aria-describedby={`cd-msg-${current.id}`}
        className="cd-box" data-tone={current.tone ?? "default"}
        initial={reduce ? false : { opacity: 0, y: 14, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reduce ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
        transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 32, mass: 0.7 }}>
        <span aria-hidden="true" className="cd-mark" />
        <h2 id={`cd-title-${current.id}`} className="cd-title">{current.title ?? (current.tone === "danger" ? (zh ? "确认删除" : "Confirm") : (zh ? "请确认" : "Please confirm"))}</h2>
        <p id={`cd-msg-${current.id}`} className="cd-msg">{current.message}</p>
        <div className="cd-actions">
          {current.extra && <button type="button" className="cd-btn cd-extra" onClick={current.extra.onPress}>{current.extra.label}</button>}
          <button type="button" className="cd-btn cd-cancel" onClick={() => settle(current.id, false)}>{current.cancelLabel ?? (zh ? "取消" : "Cancel")}</button>
          <button type="button" data-confirm-ok className="cd-btn cd-ok" onClick={() => settle(current.id, true)}>{current.confirmLabel ?? (zh ? "确定" : "OK")}</button>
        </div>
      </motion.div>
    </motion.div>}
  </AnimatePresence>;
}
