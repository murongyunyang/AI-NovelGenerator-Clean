/** Literal search using original UTF-16 offsets, as required by textarea selections. */
export type TextMatch = { start: number; end: number };

export function findTextMatches(text: string, query: string, matchCase = false): TextMatch[] {
  if (!query) return [];
  const pattern = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(pattern, matchCase ? "g" : "gi");
  const matches: TextMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = expression.exec(text)) !== null) {
    matches.push({ start: match.index, end: match.index + match[0].length });
  }
  return matches;
}

/** The replacement is literal too: $&, $1 and backslashes must never expand. */
export function replaceTextMatches(text: string, matches: readonly TextMatch[], replacement: string): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const match of matches) {
    parts.push(text.slice(cursor, match.start), replacement);
    cursor = match.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

export function nextTextMatch(matches: readonly TextMatch[], start: number, end: number, backwards = false): number {
  if (!matches.length) return -1;
  const selected = matches.findIndex((match) => match.start === start && match.end === end);
  if (selected >= 0) return (selected + (backwards ? -1 : 1) + matches.length) % matches.length;
  if (backwards) {
    for (let i = matches.length - 1; i >= 0; i--) if (matches[i].end <= start) return i;
    return matches.length - 1;
  }
  const next = matches.findIndex((match) => match.start >= end);
  return next < 0 ? 0 : next;
}

/** Measure wrapped lines with the editor's own typography, then reveal the selection. */
export function revealTextMatch(area: HTMLTextAreaElement, match: TextMatch): void {
  area.focus({ preventScroll: true });
  area.setSelectionRange(match.start, match.end);
  const style = window.getComputedStyle(area);
  const mirror = document.createElement("div");
  for (const property of ["font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "word-spacing", "text-indent", "tab-size", "padding-top", "padding-bottom", "padding-left", "padding-right", "word-break", "overflow-wrap"]) {
    mirror.style.setProperty(property, style.getPropertyValue(property));
  }
  Object.assign(mirror.style, { position: "fixed", top: "0", left: "-100000px", visibility: "hidden", boxSizing: "border-box", width: `${area.clientWidth}px`, whiteSpace: area.wrap === "off" ? "pre" : "pre-wrap" });
  mirror.appendChild(document.createTextNode(area.value.slice(0, match.start)));
  const marker = document.createElement("span");
  marker.textContent = area.value.slice(match.start, match.end) || "\u200b";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  try {
    const top = marker.getBoundingClientRect().top - mirror.getBoundingClientRect().top;
    area.scrollTop = Math.max(0, top - area.clientHeight / 2);
    area.scrollIntoView({ block: "nearest", inline: "nearest" });
  } finally { mirror.remove(); }
}
