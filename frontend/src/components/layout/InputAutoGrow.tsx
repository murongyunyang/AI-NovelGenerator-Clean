"use client";

import { useEffect } from "react";
import { useLocale } from "next-intl";
import { scrollPastField, selectFieldContents } from "@/lib/inputInteraction";

/**
 * 全局输入框增强，挂一次即作用于全部页面：
 * 1. 多行输入框随内容自动变高，最高到窗口高度的一半，不会缩到比原来小。
 * 2. 单行输入框文字超出宽度时，原位浮出一个可换行的编辑框，随内容变高，同样最高半个窗口。
 * 3. 聚焦时右上角出现“扩大”按钮：多行框放大到原来约 2.5 倍，单行框直接展开成多行编辑框。
 * 不处理：只读、禁用、标了 data-autogrow="off" 的框；本身占满容器高度的正文编辑区；下拉联想、密码、数字等特殊输入。
 */
const TEXT_TYPES = new Set(["", "text", "search", "url", "email", "tel"]);
const MAX_RATIO = 0.5;
const EXPAND_RATIO = 2.5;
const base = new WeakMap<HTMLTextAreaElement, number>();
const expanded = new WeakSet<HTMLElement>();
let measurer: HTMLTextAreaElement | null = null;

const maxHeight = () => Math.round(window.innerHeight * MAX_RATIO);
const optedOut = (el: Element) => Boolean(el.closest('[data-autogrow="off"], .cm-editor'));

/** 本身靠布局撑满的正文框（flex-1、h-full）已经够大，不再改它的高度。 */
function fillsLayout(el: HTMLTextAreaElement) {
  const style = getComputedStyle(el);
  return Number(style.flexGrow) > 0 || /\bh-full\b|\bflex-1\b/.test(el.className);
}

function growable(el: EventTarget | null): el is HTMLTextAreaElement {
  return el instanceof HTMLTextAreaElement && !el.readOnly && !el.disabled && !optedOut(el) && !fillsLayout(el) && !el.dataset.autogrowOverlay;
}

function liftable(el: EventTarget | null): el is HTMLInputElement {
  return el instanceof HTMLInputElement && TEXT_TYPES.has(el.type) && !el.readOnly && !el.disabled && !optedOut(el)
    && !el.getAttribute("list") && el.getAttribute("role") !== "combobox" && !el.hasAttribute("aria-autocomplete")
    && el.getBoundingClientRect().width >= 120;
}

/** 用隐藏的同款文本框量出内容高度，不动真实输入框，避免页面跳动。 */
function contentHeight(el: HTMLTextAreaElement | HTMLInputElement, width: number) {
  if (!measurer) {
    measurer = document.createElement("textarea");
    measurer.setAttribute("aria-hidden", "true"); measurer.tabIndex = -1;
    Object.assign(measurer.style, { position: "fixed", top: "-9999px", left: "-9999px", visibility: "hidden", height: "0", minHeight: "0", overflow: "hidden", resize: "none" });
    document.body.appendChild(measurer);
  }
  const style = getComputedStyle(el);
  for (const name of ["boxSizing", "paddingTop", "paddingBottom", "paddingLeft", "paddingRight", "borderTopWidth", "borderBottomWidth", "borderLeftWidth", "borderRightWidth", "fontFamily", "fontSize", "fontWeight", "letterSpacing", "lineHeight", "wordSpacing", "textIndent"] as const) {
    measurer.style[name] = style[name];
  }
  measurer.style.width = `${width}px`; measurer.style.whiteSpace = "pre-wrap"; measurer.style.overflowWrap = "anywhere";
  measurer.value = el.value || " ";
  const borders = style.boxSizing === "border-box" ? parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth) : -(parseFloat(style.paddingTop) + parseFloat(style.paddingBottom));
  return measurer.scrollHeight + borders;
}

/** 多行框按内容定高：不低于原高，不高于半个窗口；扩大状态下至少原高的 2.5 倍。 */
function fit(el: HTMLTextAreaElement) {
  if (!el.isConnected || !growable(el)) return;
  if (!base.has(el)) base.set(el, el.getBoundingClientRect().height);
  const original = base.get(el)!;
  const limit = Math.max(original, maxHeight());
  const wanted = Math.max(contentHeight(el, el.getBoundingClientRect().width), expanded.has(el) ? original * EXPAND_RATIO : 0);
  const next = Math.round(Math.min(limit, Math.max(original, wanted)));
  if (Math.abs(el.getBoundingClientRect().height - next) < 1) return;
  el.style.height = `${next}px`;
  el.style.maxHeight = `${limit}px`;
  el.style.overflowY = wanted > limit ? "auto" : "";
}
/* ---------- 单行输入框：原位浮出可换行的编辑框 ---------- */
type Lift = { input: HTMLInputElement; area: HTMLTextAreaElement; tall: boolean; composing: boolean };
let lift: Lift | null = null;
const COPY = ["boxSizing", "paddingTop", "paddingBottom", "paddingLeft", "paddingRight", "fontFamily", "fontSize", "fontWeight", "letterSpacing", "lineHeight", "color", "borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius"] as const;

const overflows = (input: HTMLInputElement) => input.scrollWidth > input.clientWidth + 1;
const strip = (text: string) => text.replace(/[\r\n]+/g, "");
/** 弹窗有自己的焦点范围，浮层必须放在弹窗里面，否则焦点会被拉回去。 */
const hostFor = (el: Element) => el.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]') ?? document.body;

/** 绕过 React 受控输入的缓存写入原生值，再发 input 事件，让页面自己的 onChange 照常运行。 */
let syncing = false;
let returning: HTMLInputElement | null = null;
function setNative(input: HTMLInputElement, value: string) {
  if (input.value === value) return;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  syncing = true;
  try { input.dispatchEvent(new Event("input", { bubbles: true })); } finally { syncing = false; }
}

/** 带动画的弹窗会改变 fixed 的参照，先放再量，按偏差修正。 */
function place(node: HTMLElement, left: number, top: number) {
  node.style.left = `${left}px`; node.style.top = `${top}px`;
  const rect = node.getBoundingClientRect();
  if (Math.abs(rect.left - left) > 0.5 || Math.abs(rect.top - top) > 0.5) {
    node.style.left = `${left * 2 - rect.left}px`; node.style.top = `${top * 2 - rect.top}px`;
  }
}

function fitLift() {
  if (!lift) return;
  const { input, area } = lift;
  const rect = input.getBoundingClientRect();
  if (!input.isConnected || input.disabled || input.readOnly || rect.width === 0 || rect.bottom < 0 || rect.top > window.innerHeight) { closeLift(false); return; }
  area.style.width = `${rect.width}px`;
  const wanted = Math.max(rect.height, contentHeight(area, rect.width), lift.tall ? rect.height * EXPAND_RATIO : 0);
  const height = Math.min(Math.max(rect.height, maxHeight()), wanted);
  area.style.height = `${height}px`;
  area.style.overflowY = wanted > height ? "auto" : "hidden";
  // 靠近窗口底部时向上长，始终整块可见。
  place(area, rect.left, Math.max(8, Math.min(rect.top, window.innerHeight - 8 - height)));
}

function closeLift(refocus: boolean) {
  if (!lift) return;
  const { input, area } = lift;
  lift = null;
  setNative(input, strip(area.value));
  const start = area.selectionStart, end = area.selectionEnd;
  area.remove();
  if (!input.isConnected) return;
  if (refocus) {
    // 按 Esc／回车主动收起后回到原框，这次聚焦不再自动展开。
    returning = input;
    input.focus({ preventScroll: true });
    try { input.setSelectionRange(start, end); } catch { /* email 等类型不支持选区 */ }
  } else input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
}

function openLift(input: HTMLInputElement, tall: boolean) {
  if (lift?.input === input) { lift.tall ||= tall; fitLift(); lift.area.focus({ preventScroll: true }); return; }
  closeLift(false);
  const style = getComputedStyle(input);
  const area = document.createElement("textarea");
  area.dataset.autogrowOverlay = "1";
  area.value = input.value; area.placeholder = input.placeholder;
  area.setAttribute("aria-label", input.getAttribute("aria-label") || input.placeholder || input.name || "");
  if (input.maxLength > 0) area.maxLength = input.maxLength;
  for (const name of COPY) area.style[name] = style[name];
  const transparent = /rgba\(0, 0, 0, 0\)|transparent/.test(style.backgroundColor);
  Object.assign(area.style, {
    position: "fixed", zIndex: "2147483000", margin: "0", resize: "none", whiteSpace: "pre-wrap", overflowWrap: "anywhere",
    background: transparent ? "var(--color-surface, #fff)" : style.backgroundColor,
    border: "1px solid var(--color-accent, #0e7490)", boxShadow: "0 6px 16px rgb(0 0 0 / 0.12)", outline: "none",
  });
  const current: Lift = { input, area, tall, composing: false };
  const start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start;
  const sync = () => {
    if (current.composing) return;
    setNative(input, strip(area.value));
    // 页面若改写了值（例如长度限制），以页面为准。
    requestAnimationFrame(() => { if (lift === current && strip(area.value) !== input.value) area.value = input.value; fitLift(); });
    fitLift();
  };
  area.addEventListener("input", sync);
  area.addEventListener("compositionstart", () => { current.composing = true; });
  area.addEventListener("compositionend", () => { current.composing = false; sync(); });
  area.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeLift(true); return; }
    if (event.key !== "Enter") return;
    // 单行框不能换行：回车交还给原输入框，页面原有的回车操作照常生效。
    event.preventDefault(); event.stopPropagation();
    closeLift(true);
    const forwarded = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true });
    if (input.dispatchEvent(forwarded) && input.form?.querySelector('button[type="submit"], input[type="submit"], button:not([type])')) input.form.requestSubmit();
  });
  area.addEventListener("blur", () => { if (lift === current) closeLift(false); });
  hostFor(input).appendChild(area);
  lift = current;
  fitLift();
  area.focus({ preventScroll: true });
  area.setSelectionRange(start, end);
}

/* ---------- 扩大按钮 ---------- */
let button: HTMLButtonElement | null = null;
let buttonTarget: HTMLElement | null = null;
let labels = { grow: "扩大输入框", shrink: "缩小输入框" };
const ICON_GROW = '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>';
const ICON_SHRINK = '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>';

function isGrown(el: HTMLElement) {
  return el instanceof HTMLTextAreaElement && el.dataset.autogrowOverlay ? Boolean(lift?.tall) : expanded.has(el);
}

function placeButton() {
  if (!button || !buttonTarget) return;
  const rect = buttonTarget.getBoundingClientRect();
  if (!buttonTarget.isConnected || rect.width === 0) { hideButton(); return; }
  const grown = isGrown(buttonTarget);
  const label = grown ? labels.shrink : labels.grow;
  button.setAttribute("aria-label", label); button.title = label;
  button.innerHTML = `<svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${grown ? ICON_SHRINK : ICON_GROW}</svg>`;
  // 压在输入框右上角的边框上，不挡文字和滚动条。
  place(button, rect.right - 30, rect.top - 11);
}

function showButton(el: HTMLElement) {
  if (!button) {
    button = document.createElement("button");
    button.type = "button"; button.tabIndex = -1; button.dataset.autogrowButton = "1";
    Object.assign(button.style, {
      position: "fixed", zIndex: "2147483001", width: "22px", height: "22px", display: "flex", alignItems: "center", justifyContent: "center",
      padding: "0", borderRadius: "6px", border: "1px solid var(--color-border, #cbd5e1)", background: "var(--color-surface, #fff)",
      color: "var(--color-muted, #64748b)", cursor: "pointer",
    });
    // 按下时不抢焦点，输入框保持编辑状态。
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      const target = buttonTarget;
      if (!target) return;
      if (target instanceof HTMLTextAreaElement && target.dataset.autogrowOverlay) { if (lift) { lift.tall = !lift.tall; fitLift(); } }
      else if (target instanceof HTMLTextAreaElement) { if (expanded.has(target)) expanded.delete(target); else expanded.add(target); fit(target); }
      else if (target instanceof HTMLInputElement) { openLift(target, true); return; }
      placeButton();
    });
  }
  buttonTarget = el;
  const host = hostFor(el);
  if (button.parentElement !== host) host.appendChild(button);
  placeButton();
}

function hideButton() {
  button?.remove();
  buttonTarget = null;
}

/** 根布局挂一次；只在浏览器里运行，不渲染任何节点。 */
export default function InputAutoGrow() {
  const zh = useLocale() !== "en";
  useEffect(() => {
    labels = zh ? { grow: "扩大输入框", shrink: "缩小输入框" } : { grow: "Enlarge field", shrink: "Shrink field" };
    placeButton();
  }, [zh]);
  useEffect(() => {
    const onWheel = (event: WheelEvent) => scrollPastField(event, (field) => lift?.area === field ? lift.input : field);
    const onInput = (event: Event) => {
      if (syncing) return;
      const target = event.target;
      if (growable(target)) { fit(target); placeButton(); }
      else if (liftable(target) && !(event as InputEvent).isComposing && overflows(target)) openLift(target, false);
    };
    const onComposed = (event: Event) => { const target = event.target; if (liftable(target) && overflows(target)) openLift(target, false); };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLTextAreaElement && target.dataset.autogrowOverlay) { showButton(target); return; }
      if (growable(target)) { fit(target); showButton(target); return; }
      if (liftable(target)) {
        showButton(target);
        if (returning === target) { returning = null; return; }
        // 已经超出宽度的长文字，一聚焦就展开，免得看不全。
        if (overflows(target)) requestAnimationFrame(() => { if (document.activeElement === target) openLift(target, false); });
        return;
      }
      hideButton();
    };
    const onFocusOut = () => requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body || (active !== buttonTarget && !(active instanceof HTMLElement && active.dataset.autogrowOverlay))) hideButton();
    });
    const reposition = () => { fitLift(); placeButton(); };
    const scan = () => {
      // 窗口在后台或最小化时不量，避免空闲时反复触发布局计算。
      if (document.hidden) return;
      // 生成中的文字由程序写入，不触发 input 事件；定时补量一次。
      for (const area of document.querySelectorAll("textarea")) {
        if (area.offsetParent && (base.has(area) || area.scrollHeight > area.clientHeight + 2)) fit(area);
      }
      reposition();
    };
    document.addEventListener("input", onInput, true);
    document.addEventListener("keydown", selectFieldContents, true);
    document.addEventListener("wheel", onWheel, { capture: true, passive: false });
    document.addEventListener("compositionend", onComposed, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    window.addEventListener("resize", scan);
    window.addEventListener("scroll", reposition, { capture: true, passive: true });
    const timer = window.setInterval(scan, 1000);
    return () => {
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("keydown", selectFieldContents, true);
      document.removeEventListener("wheel", onWheel, { capture: true });
      document.removeEventListener("compositionend", onComposed, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      window.removeEventListener("resize", scan);
      window.removeEventListener("scroll", reposition, { capture: true });
      window.clearInterval(timer);
      closeLift(false); hideButton(); measurer?.remove(); measurer = null;
    };
  }, []);
  return null;
}
