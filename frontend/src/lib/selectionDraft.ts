/** 按书、目标和原选段隔离草稿，关闭小窗或刷新后仍可恢复。 */
export function selectionDraftKey(novelId: string, target: string, selection: string): string {
  let hash = 2166136261;
  for (let index = 0; index < selection.length; index++) hash = Math.imul(hash ^ selection.charCodeAt(index), 16777619);
  return `selection-agent:draft:${novelId}:${target}:${hash >>> 0}`;
}

export function readSelectionDraft(key: string, selection: string): { instruction: string; feedback: string; candidate: string; attempts: { text: string; feedback: string }[] } {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null");
    if (saved?.selection === selection) return { instruction: typeof saved.instruction === "string" ? saved.instruction : "", feedback: typeof saved.feedback === "string" ? saved.feedback : "", candidate: typeof saved.candidate === "string" ? saved.candidate : "", attempts: Array.isArray(saved.attempts) ? saved.attempts.filter((item: { text?: unknown; feedback?: unknown } | null) => item && typeof item.text === "string" && typeof item.feedback === "string") : [] };
  } catch { /* 不影响打开编辑器 */ }
  return { instruction: "", feedback: "", candidate: "", attempts: [] };
}
