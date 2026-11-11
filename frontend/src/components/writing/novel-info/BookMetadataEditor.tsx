"use client";
import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { Button } from "@heroui/react";
import { apiGet, apiPut } from "@/lib/api";
import { openBook } from "@/lib/openBooks";
import type { NovelDetail } from "@/types/novel";

export default function BookMetadataEditor({ novelId, onSaved }: { novelId: string; onSaved: () => void }) {
  const zh = useLocale() !== "en";
  const [book, setBook] = useState<NovelDetail | null>(null);
  const [title, setTitle] = useState("");
  const [introduction, setIntroduction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    apiGet<NovelDetail>(`/api/novels/${novelId}`).then(row => {
      if (active) { setBook(row); setTitle(row.title); setIntroduction(row.introduction || ""); }
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [novelId]);
  return <form className="workspace-scrollbar min-h-0 flex-1 space-y-5 overflow-auto p-6" onSubmit={async e => {
    e.preventDefault(); if (!book || !title.trim()) return;
    setBusy(true); setError(""); setSaved(false);
    try {
      const row = await apiPut<NovelDetail>(`/api/novels/${novelId}`, { expected_version: book.version, title: title.trim(), introduction });
      setBook(row); openBook(novelId, row.title); setSaved(true); onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }}>
    <h1 className="text-lg font-semibold">{zh ? "小说信息" : "Book information"}</h1>
    <label className="grid gap-2 text-sm">{zh ? "书名" : "Title"}<input required disabled={busy || !book} value={title} onChange={e => { setTitle(e.target.value); setSaved(false); }} className="rounded-xl border border-border bg-background p-3" /></label>
    <label className="grid gap-2 text-sm">{zh ? "简介" : "Introduction"}<textarea disabled={busy || !book} value={introduction} onChange={e => { setIntroduction(e.target.value); setSaved(false); }} className="min-h-64 rounded-xl border border-border bg-background p-3 leading-7" /></label>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {saved && <p role="status" className="text-sm text-muted">{zh ? "已保存" : "Saved"}</p>}
    <Button type="submit" isDisabled={busy || !book || !title.trim()}>{busy ? (zh ? "保存中…" : "Saving…") : (zh ? "保存" : "Save")}</Button>
  </form>;
}
