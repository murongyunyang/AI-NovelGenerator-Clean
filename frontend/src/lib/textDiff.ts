export type DiffPart = { type: "same" | "removed" | "added"; text: string };

/** 中文写作常用的字数口径：不计空白字符。 */
export function countChars(text: string): number {
  let n = 0;
  for (const ch of text) if (!/\s/.test(ch)) n += 1;
  return n;
}

function splitSentences(text: string): string[] {
  return text.match(/[^。！？!?；;…\n]*(?:[。！？!?；;…]+[”’」』"')）]*|\n+|$)/g)?.filter(Boolean) ?? [];
}

type Op<T> = { type: DiffPart["type"]; items: T[] };

/** 经典 LCS 回溯；调用方保证规模可控。 */
function lcsDiff<T>(a: T[], b: T[]): Op<T>[] {
  const n = a.length, m = b.length, w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  const ops: Op<T>[] = [];
  const push = (type: Op<T>["type"], item: T) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.items.push(item); else ops.push({ type, items: [item] });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push("same", a[i]); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) push("removed", a[i++]);
    else push("added", b[j++]);
  }
  while (i < n) push("removed", a[i++]);
  while (j < m) push("added", b[j++]);
  return ops;
}

const CHAR_LIMIT = 4_000_000;
const SENTENCE_LIMIT = 4_000_000;

function charDiff(a: string, b: string, out: DiffPart[]) {
  const ac = Array.from(a), bc = Array.from(b);
  if (ac.length * bc.length > CHAR_LIMIT) {
    if (a) out.push({ type: "removed", text: a });
    if (b) out.push({ type: "added", text: b });
    return;
  }
  for (const op of lcsDiff(ac, bc)) out.push({ type: op.type, text: op.items.join("") });
}

/** 先按句比对，再对改动的句段逐字比对，长章节也不会卡顿。 */
export function diffText(a: string, b: string): DiffPart[] {
  const sa = splitSentences(a), sb = splitSentences(b);
  const raw: DiffPart[] = [];
  if (sa.length * sb.length > SENTENCE_LIMIT) charDiff(a, b, raw);
  else {
    const ops = lcsDiff(sa, sb);
    for (let k = 0; k < ops.length; k++) {
      const op = ops[k];
      if (op.type === "same") { raw.push({ type: "same", text: op.items.join("") }); continue; }
      const next = ops[k + 1];
      const removed = op.type === "removed" ? op.items.join("") : "";
      const added = op.type === "added" ? op.items.join("") : next?.type === "added" && op.type === "removed" ? next.items.join("") : "";
      if (op.type === "removed" && next?.type === "added") k++;
      charDiff(removed, added, raw);
    }
  }
  const merged: DiffPart[] = [];
  for (const part of raw) {
    if (!part.text) continue;
    const last = merged[merged.length - 1];
    if (last && last.type === part.type) last.text += part.text; else merged.push({ ...part });
  }
  return merged;
}
