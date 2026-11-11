/** 批量生成并保存概要：与单章概要小窗用同一个接口，逐章生成后按生成依据的版本保存。 */

import { apiPostSSE, apiPut } from "@/lib/api";
import { clearWritingDrafts } from "@/lib/writingDrafts";
import type { ModelChoice } from "@/components/shared/ModelPicker";

/** 正文章节：按原文生成概要，只更新概要字段。 */
export async function summarizeChapter(novelId: string, chapter: { chapter_id: string; version: number }, choice: ModelChoice, signal: AbortSignal) {
  let text = "", version = chapter.version;
  await apiPostSSE(`/api/novels/${novelId}/continuation/stream`, {
    action: "summarize", chapter_contexts: [{ chapter_id: chapter.chapter_id, mode: "original" }], ...choice,
  }, (event, data) => {
    if (data.basis) {
      const source = (data.basis as unknown as { sources: { chapter_id: string; version: number }[] }).sources.find((row) => row.chapter_id === chapter.chapter_id);
      if (source) version = source.version;
    }
    if (event === "delta") text += String(data.text ?? "");
    if (event === "done") text = String(data.text ?? text);
  }, { signal, allowedEvents: ["delta"] });
  if (signal.aborted) return;
  if (!text.trim()) throw new Error("模型没有返回概要");
  await apiPut(`/api/chapters/${chapter.chapter_id}`, { expected_version: version, summary: text });
  // 新概要已保存，旧的本地概要草稿不能再盖过它。
  await clearWritingDrafts(`${novelId}:chapter:${chapter.chapter_id}:summary`);
}

/** 章纲：按已保存的章纲生成大纲概要。 */
export async function summarizeOutline(novelId: string, row: { id: string; version: number }, choice: ModelChoice, signal: AbortSignal) {
  const path = `/api/novels/${novelId}/outline-chapters/${row.id}`;
  let result: { text: string; version: number } | null = null;
  await apiPostSSE(`${path}/summary/stream`, { expected_version: row.version, ...choice }, (event, data) => {
    if (event === "done") result = { text: String(data.text ?? ""), version: Number(data.version) };
  }, { signal });
  if (signal.aborted) return;
  const done = result as { text: string; version: number } | null;
  if (!done || !done.text.trim()) throw new Error("模型没有返回概要");
  await apiPut(`${path}/summary`, { expected_version: done.version, summary: done.text });
  await clearWritingDrafts(`${novelId}:outline-chapter:${row.id}:summary`);
}
