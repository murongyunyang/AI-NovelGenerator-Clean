"use client";

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { Button } from "@heroui/react";
import { apiGet, apiPut } from "@/lib/api";
import { readWritingDraft, writeWritingDraft } from "@/lib/writingDrafts";
import { notifyResourceChange, subscribeResourceChanges } from "@/lib/resourceChanges";
import { RetainedViewActive } from "@/components/layout/RetainedViews";
import type { NovelDetail } from "@/types/novel";

interface Draft { text: string; base: string }

export default function WorldviewWorkspace({ novelId }: { novelId: string }) {
  const zh = useLocale() !== "en";
  const active = useContext(RetainedViewActive);
  const key = `${novelId}:worldview`;
  const [text, setText] = useState("");
  const [base, setBase] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [savedComparison, setSavedComparison] = useState<string | null>(null);
  const current = useRef({ text, base });
  useEffect(() => { current.current = { text, base }; }, [text, base]);
  useEffect(() => {
    let alive = true;
    void Promise.all([apiGet<NovelDetail>(`/api/novels/${novelId}`), readWritingDraft<Draft>(key), readWritingDraft<{ worldview?: string }>(`${novelId}:outline-tools`)])
      .then(([book, draft, legacy]) => {
        if (!alive) return;
        const saved = book.worldview ?? "";
        setText(draft?.value.text ?? legacy?.value.worldview ?? saved);
        setBase(draft?.value.base ?? saved); setReady(true);
      }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [key, novelId]);
  useEffect(() => {
    if (ready) void writeWritingDraft(key, 1, { text, base }).catch((e) => setError(e.message));
  }, [key, ready, text, base]);
  const refresh = useCallback(async () => {
    try {
      const book = await apiGet<NovelDetail>(`/api/novels/${novelId}`);
      const saved = book.worldview ?? "";
      if (current.current.text === current.current.base) { setText(saved); setBase(saved); }
      else if (saved !== current.current.base) setNotice(zh ? "世界观已有新版本。你的草稿仍保留，请核对后再保存。" : "Worldbuilding changed elsewhere. Your draft is kept; compare before saving.");
    } catch (e) { setError((e as Error).message); }
  }, [novelId, zh]);
  useEffect(() => { if (ready && active) void refresh(); }, [ready, active, refresh]);
  useEffect(() => subscribeResourceChanges((event) => { if (event.novelId === novelId) void refresh(); }), [novelId, refresh]);
  const save = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const fresh = await apiGet<NovelDetail>(`/api/novels/${novelId}`);
      if ((fresh.worldview ?? "") !== base) throw new Error(zh ? "世界观已被智能体或其他页面修改，未覆盖新版本。请复制草稿，重新载入后合并。" : "Worldbuilding changed elsewhere. Copy your draft and reload to merge.");
      const saved = await apiPut<NovelDetail>(`/api/novels/${novelId}`, { expected_version: fresh.version, worldview: text });
      setText(saved.worldview ?? ""); setBase(saved.worldview ?? ""); setNotice(zh ? "世界观已保存" : "Worldbuilding saved");
      notifyResourceChange({ novelId, resources: [{ resource_type: "novel", id: novelId }], source: "manual" });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <section data-testid="worldview-workspace" className="flex h-full min-h-0 flex-col gap-4 p-4 sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-xl font-semibold">{zh ? "世界观" : "Worldbuilding"}</h1>
      <Button isDisabled={!ready || busy || text === base} onPress={() => void save()}>{zh ? "保存世界观" : "Save worldbuilding"}</Button></div>
    <p className="text-sm text-muted">{zh ? "在这里整理时代背景、地理、力量体系、社会规则及设定边界。全自动智能体关联本书世界观后可以阅读、编辑，改动记录支持撤销。" : "Develop the setting, geography, powers and rules here. The book agent can read and edit linked worldbuilding, with undoable changes."}</p>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {notice && <p role="status" className="text-sm text-accent">{notice}</p>}
    <textarea data-testid="worldview-input" aria-label={zh ? "本书世界观" : "Worldbuilding"} value={text} disabled={!ready || busy} onChange={(e) => setText(e.target.value)}
      className="min-h-[55vh] flex-1 resize-y rounded-xl border border-border bg-background p-5 text-base leading-8 outline-none focus:border-accent" />
    <div className="flex flex-wrap items-center gap-4">
      <p className="text-xs text-muted">{text.length.toLocaleString()} {zh ? `字 · ${text === base ? "已保存" : "草稿未保存"}` : `characters · ${text === base ? "Saved" : "Unsaved draft"}`}</p>
      <Button size="sm" variant="secondary" isDisabled={!ready || busy} onPress={() => {
        void apiGet<NovelDetail>(`/api/novels/${novelId}`).then((book) => {
          setNotice(zh ? "下方是最新保存版本，可复制需要的内容合并到草稿。" : "The latest saved version is shown below for comparison.");
          setSavedComparison(book.worldview ?? "");
        }).catch((e) => setError(e.message));
      }}>{zh ? "查看已保存版本" : "View saved version"}</Button>
      {savedComparison !== null && <Button size="sm" variant="ghost" onPress={() => { setBase(savedComparison); setSavedComparison(null); setNotice(zh ? "已更新保存基准，请核对草稿后点击保存。" : "Save basis updated. Review your draft before saving."); }}>{zh ? "已核对，以此版本为基准" : "Use this version as save basis"}</Button>}
    </div>
    {savedComparison !== null && <textarea readOnly aria-label={zh ? "已保存的世界观" : "Saved worldbuilding"} value={savedComparison} className="min-h-48 rounded-xl border border-border bg-surface p-4 text-sm leading-7" />}
  </section>;
}
