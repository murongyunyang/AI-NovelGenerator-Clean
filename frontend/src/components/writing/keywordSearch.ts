"use client";

import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";

export interface KeywordHit { hits: number; in_title: boolean; snippet: string }
export interface KeywordHits { query: string; chapters: Map<string, KeywordHit>; outlines: Map<string, KeywordHit> }
type Found = { query: string; chapters: ({ chapter_id: string } & KeywordHit)[]; outlines: ({ id: string } & KeywordHit)[] };

/** 按关键词在全书的章节和章纲里查找（标题、正文、概要逐字匹配，不调用模型）。停止输入 0.3 秒后才查询；结果没回来时 hits 为 null，调用方先按标题筛选。 */
export function useKeywordHits(novelId: string, query: string): { hits: KeywordHits | null; searching: boolean; error: string } {
  const text = query.trim().slice(0, 60);
  const [state, setState] = useState<{ query: string; hits: KeywordHits | null; error: string }>({ query: "", hits: null, error: "" });
  useEffect(() => {
    if (!text) return;
    let current = true;
    const timer = window.setTimeout(() => {
      apiGet<Found>(`/api/novels/${novelId}/writing-agent/keyword-search?q=${encodeURIComponent(text)}`).then((found) => {
        if (current) setState({ query: text, error: "", hits: {
          query: text, chapters: new Map(found.chapters.map((item) => [item.chapter_id, item])), outlines: new Map(found.outlines.map((item) => [item.id, item])),
        } });
      }).catch((e) => { if (current) setState({ query: text, hits: null, error: (e as Error).message }); });
    }, 300);
    return () => { current = false; window.clearTimeout(timer); };
  }, [novelId, text]);
  const fresh = Boolean(text) && state.query === text;
  return { hits: fresh ? state.hits : null, searching: Boolean(text) && !fresh, error: fresh ? state.error : "" };
}

/** 命中说明：正文里出现几处；只有标题命中时不显示次数。 */
export function hitLabel(hit: KeywordHit | undefined, zh: boolean): string {
  if (!hit?.hits) return "";
  return zh ? `内容命中 ${hit.hits} 处` : `${hit.hits} match${hit.hits > 1 ? "es" : ""}`;
}
