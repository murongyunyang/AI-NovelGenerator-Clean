/** Shared text-field behavior, including fields rendered in dialog portals. */
const SELECTABLE_TYPES = new Set(["text", "search", "url", "tel", "email", "password"]);

function elementTarget(event: Event): HTMLElement | null {
  const target = event.composedPath().find((item) => item instanceof HTMLElement);
  return target instanceof HTMLElement ? target : null;
}

function editableRoot(target: HTMLElement | null): HTMLElement | null {
  if (!target) return null;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return target;
  if (!target.isContentEditable) return null;
  let root = target;
  while (root.parentElement?.isContentEditable) root = root.parentElement;
  return root;
}

/** Keep Ctrl/Cmd+A inside the focused field, even if the page has an old selection. */
export function selectFieldContents(event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing || event.key.toLowerCase() !== "a") return;
  const field = editableRoot(elementTarget(event)) ?? editableRoot(document.activeElement as HTMLElement | null);
  if (!field || field.closest(".cm-editor")) return; // CodeMirror selects its complete document, including virtual lines.
  if (field instanceof HTMLInputElement && (!SELECTABLE_TYPES.has(field.type) || field.disabled)) return;
  if (field instanceof HTMLTextAreaElement && field.disabled) return;
  event.preventDefault();
  event.stopPropagation();
  const selection = window.getSelection();
  selection?.removeAllRanges();
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    field.select();
  } else {
    const range = document.createRange();
    range.selectNodeContents(field);
    selection?.addRange(range);
  }
}

function canScroll(element: HTMLElement, direction: number) {
  const maximum = element.scrollHeight - element.clientHeight;
  return maximum > 1 && (direction > 0 ? element.scrollTop < maximum - 1 : element.scrollTop > 1);
}

/** At a text editor's edge, hand the wheel to its nearest scrollable page/panel. */
export function scrollPastField(event: WheelEvent, sourceFor: (field: HTMLElement) => HTMLElement = (field) => field) {
  if (!event.cancelable || event.ctrlKey || event.metaKey || event.shiftKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
  const target = elementTarget(event);
  if (!target) return;
  const codeScroller = target.closest<HTMLElement>(".cm-scroller");
  const field = codeScroller ?? editableRoot(target);
  if (!field) return;
  if (!(field instanceof HTMLInputElement) && canScroll(field, event.deltaY)) return;

  // The expanded single-line field lives in a portal; scroll the original field's panel.
  const source = sourceFor(field);
  const dialog = source.closest('[role="dialog"], [role="alertdialog"], dialog');
  for (let parent = source.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    const scrollable = /^(auto|scroll|overlay)$/.test(overflow)
      || (parent === document.scrollingElement && overflow !== "hidden" && overflow !== "clip");
    if (scrollable && canScroll(parent, event.deltaY)) {
      const lineHeight = parseFloat(getComputedStyle(field).lineHeight) || 16;
      const delta = event.deltaY * (event.deltaMode === 1 ? lineHeight : event.deltaMode === 2 ? parent.clientHeight : 1);
      event.preventDefault();
      event.stopPropagation();
      parent.scrollTop += delta;
      return;
    }
    // A dialog must not accidentally scroll the book behind it.
    if (parent === dialog) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
  }
}
