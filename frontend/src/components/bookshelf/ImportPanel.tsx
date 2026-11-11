"use client";

import { useContext, useEffect, useEffectEvent, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@heroui/react";
import { apiPostForm, ApiRequestError } from "@/lib/api";
import { isFileDrag } from "@/lib/fileDrop";
import { RetainedViewActive } from "@/components/layout/RetainedViews";
import { compareImportFiles } from "@/lib/importFileOrder";

type SplitMode = "auto" | "regex" | "size" | "single" | "files";

interface ImportPreview {
  title: string;
  encoding: string;
  volume_count: number;
  chapter_count: number;
  word_count: number;
  warnings: string[];
  volumes: { title: string; chapter_count: number; word_count: number; first_titles: string[]; last_title: string }[];
  volumes_truncated: boolean;
}

interface ImportResult { id: string; chapter_count: number; volume_count: number; replayed: boolean }

const FIELD = "min-h-11 w-full rounded-xl border border-border bg-background/80 px-3 text-sm";

/** 从本机文件导入已有小说：选文件 → 预览识别结果 → 确认导入。 */
export default function ImportPanel({ onImported }: { onImported: (novelId: string) => void }) {
  const t = useTranslations("create.import");
  const active = useContext(RetainedViewActive);
  const [files, setFiles] = useState<File[]>([]);
  const [title, setTitle] = useState("");
  const [genre, setGenre] = useState("");
  const [mode, setMode] = useState<SplitMode>("auto");
  const [pattern, setPattern] = useState("");
  const [chunkSize, setChunkSize] = useState(3000);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const requestId = useRef(0);
  const importKey = useRef<string | null>(null);
  const titleEdited = useRef(false);

  const formFor = (extra: Record<string, string> = {}) => {
    const form = new FormData();
    files.forEach((file) => form.append("file", file));
    form.set("mode", mode);
    form.set("pattern", pattern);
    form.set("chunk_size", String(chunkSize));
    if (title.trim()) form.set("title", title.trim());
    Object.entries(extra).forEach(([key, value]) => form.set(key, value));
    return form;
  };

  // 文件或切分选项变化后自动重新预览；正则输入稍作等待，避免每敲一个字符就请求一次。
  useEffect(() => {
    if (!files.length) return;
    const current = ++requestId.current;
    importKey.current = null; // 选项变了就是另一次导入，换新的幂等键
    setPreviewing(true);
    setError("");
    const timer = window.setTimeout(async () => {
      try {
        const form = new FormData();
        files.forEach((file) => form.append("file", file));
        form.set("mode", mode);
        form.set("pattern", pattern);
        form.set("chunk_size", String(chunkSize));
        if (titleEdited.current && title.trim()) form.set("title", title.trim());
        const result = await apiPostForm<ImportPreview>("/api/novel-import/preview", form);
        if (current !== requestId.current) return; // 已有更新的请求，丢弃过期结果
        setPreview(result);
        if (!titleEdited.current) setTitle(result.title);
      } catch (caught) {
        if (current !== requestId.current) return;
        setPreview(null);
        setError(caught instanceof ApiRequestError ? caught.message : t("previewFailed"));
      } finally {
        if (current === requestId.current) setPreviewing(false);
      }
    }, mode === "regex" ? 500 : 0);
    return () => {
      window.clearTimeout(timer);
      requestId.current += 1;
    };
    // title 只在用户手动改过时才参与预览，所以不放进依赖，避免输入书名时反复请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, mode, pattern, chunkSize]);

  const updateFiles = (next: File[]) => {
    requestId.current += 1;
    importKey.current = null;
    if (!titleEdited.current) setTitle("");
    setPreview(null);
    setPreviewing(next.length > 0);
    setError("");
    setFiles(next);
  };

  const pickFiles = (picked: File[]) => {
    if (!picked.length || importing) return;
    const invalid = picked.find((file) => !/\.(txt|md|markdown|docx)$/i.test(file.name));
    if (invalid) {
      setError(t("unsupportedFileNamed", { name: invalid.name }));
      return;
    }
    const sameFile = (a: File, b: File) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
    const added = picked.filter((file, index) => !files.some((existing) => sameFile(existing, file)) &&
      picked.findIndex((other) => sameFile(other, file)) === index).sort(compareImportFiles);
    if (!added.length) { setError(t("alreadySelected")); return; }
    const next = [...files, ...added];
    if (next.length > 1000) { setError(t("tooManyFiles")); return; }
    if (next.reduce((total, file) => total + file.size, 0) > 30 * 1024 * 1024) {
      setError(t("filesTooLarge"));
      return;
    }
    if (next.length > 1 && files.length <= 1 && mode === "auto") setMode("files");
    updateFiles(next);
  };

  const moveFile = (index: number, direction: number) => {
    const next = [...files];
    const target = index + direction;
    if (importing || target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    updateFiles(next);
  };

  const handleDrop = useEffectEvent((event: DragEvent) => {
    if (!isFileDrag(event.dataTransfer)) return;
    // 接管浏览器的打开/下载行为，并复用点击选文件后的预览流程。
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = 0;
    setDragging(false);
    if (importing) return;
    pickFiles(Array.from(event.dataTransfer?.files ?? []));
  });

  const handleDragOver = useEffectEvent((event: DragEvent) => {
    if (!isFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = importing ? "none" : "copy";
  });

  const handleDragEnter = useEffectEvent((event: DragEvent) => {
    if (!isFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth.current += 1;
    if (!importing) setDragging(true);
  });

  useEffect(() => {
    // 页签会保持挂载；只有当前可见的导入页签能接收整个窗口拖入的文件。
    if (!active) return;
    const enter = (event: DragEvent) => handleDragEnter(event);
    const over = (event: DragEvent) => handleDragOver(event);
    const drop = (event: DragEvent) => handleDrop(event);
    const leave = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
      dragDepth.current = 0;
      setDragging(false);
    };
  }, [active]);

  const submit = async () => {
    if (!files.length || !preview || previewing || importing) return;
    setImporting(true);
    setError("");
    importKey.current ??= crypto.randomUUID().replace(/-/g, "");
    try {
      const result = await apiPostForm<ImportResult>("/api/novel-import/commit", formFor({ genre: genre.trim() || "unclassified" }), {
        headers: { "Idempotency-Key": importKey.current },
      });
      onImported(result.id);
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : t("importFailed"));
      setImporting(false);
    }
  };

  const words = (n: number) => (n >= 10000 ? t("wan", { n: (n / 10000).toFixed(1) }) : String(n));

  return (
    <div className="h-full min-h-0 space-y-5 overflow-y-auto px-4 py-5 sm:px-6">
      <p className="text-sm text-muted">{t("intro")}</p>

      <label className={`grid gap-2 rounded-xl border-2 border-dashed p-5 text-sm transition-colors focus-within:ring-2 focus-within:ring-accent/30 ${
        dragging ? "border-accent bg-accent/10" : "border-border bg-background/80"
      } ${importing ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}>
        <input
          type="file"
          multiple
          accept=".txt,.md,.markdown,.docx"
          aria-label={t("file")}
          className="sr-only"
          disabled={importing}
          onChange={(event) => {
            pickFiles(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <span className="font-medium">{t("file")}</span>
        <span className="text-muted">{t(dragging ? "dropNow" : "dropHint")}</span>
        {!!files.length && <span role="status" className="break-all font-medium">{files.length === 1
          ? t("selectedFile", { name: files[0].name }) : t("selectedFiles", { count: files.length })}</span>}
      </label>

      {!!files.length && (
        <>
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium">{t("fileOrder")}</h3>
              <Button size="sm" variant="ghost" isDisabled={importing} onPress={() => updateFiles([])}>{t("clearFiles")}</Button>
            </div>
            <p className="text-xs text-muted">{t("fileOrderHelp")}</p>
            <ol aria-label={t("fileOrder")} className="max-h-64 divide-y divide-border overflow-y-auto rounded-xl border border-border text-sm">
              {files.map((file, index) => (
                <li key={`${file.name}:${file.size}:${file.lastModified}:${index}`} className="flex flex-wrap items-center gap-2 px-3 py-1">
                  <span className="w-7 shrink-0 text-muted">{index + 1}</span>
                  <span className="text-fill">{file.name}</span>
                  <button type="button" className="min-h-11 min-w-9 rounded-lg hover:bg-background disabled:opacity-30"
                    aria-label={t("moveUp", { name: file.name })} disabled={importing || index === 0}
                    onClick={() => moveFile(index, -1)}>↑</button>
                  <button type="button" className="min-h-11 min-w-9 rounded-lg hover:bg-background disabled:opacity-30"
                    aria-label={t("moveDown", { name: file.name })} disabled={importing || index === files.length - 1}
                    onClick={() => moveFile(index, 1)}>↓</button>
                  <button type="button" className="min-h-11 min-w-9 rounded-lg text-danger hover:bg-background disabled:opacity-30"
                    aria-label={t("removeFile", { name: file.name })} disabled={importing}
                    onClick={() => updateFiles(files.filter((_, fileIndex) => fileIndex !== index))}>×</button>
                </li>
              ))}
            </ol>
          </section>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-2 text-sm">
              <span className="font-medium">{t("title")}</span>
              <input className={FIELD} value={title} disabled={importing}
                onChange={(event) => { titleEdited.current = true; setTitle(event.target.value); }} />
            </label>
            <label className="grid gap-2 text-sm">
              <span className="font-medium">{t("genre")}</span>
              <input className={FIELD} value={genre} placeholder={t("genrePlaceholder")} disabled={importing}
                onChange={(event) => setGenre(event.target.value)} />
            </label>
            <label className="grid gap-2 text-sm">
              <span className="font-medium">{t("splitMode")}</span>
              <select className={FIELD} value={mode} disabled={importing} onChange={(event) => setMode(event.target.value as SplitMode)}>
                <option value="files">{t("modes.files")}</option>
                <option value="auto">{t("modes.auto")}</option>
                <option value="regex">{t("modes.regex")}</option>
                <option value="size">{t("modes.size")}</option>
                <option value="single">{t("modes.single")}</option>
              </select>
              {mode === "files" && <span className="text-xs text-muted">{t("perFileHelp")}</span>}
            </label>
            {mode === "regex" && (
              <label className="grid gap-2 text-sm">
                <span className="font-medium">{t("pattern")}</span>
                <input className={`${FIELD} font-mono`} value={pattern} placeholder="^【\d+】" disabled={importing}
                  onChange={(event) => setPattern(event.target.value)} />
                <span className="text-xs text-muted">{t("patternHelp")}</span>
              </label>
            )}
            {mode === "size" && (
              <label className="grid gap-2 text-sm">
                <span className="font-medium">{t("chunkSize")}</span>
                <input className={FIELD} type="number" min={1} step={1} value={chunkSize} disabled={importing}
                  onChange={(event) => setChunkSize(Number(event.target.value))} />
              </label>
            )}
          </div>

          <section aria-live="polite" className="space-y-3 border-t border-border pt-4">
            <h3 className="text-sm font-semibold">{t("result")}</h3>
            {previewing && <p role="status" className="text-sm text-muted">{t("analyzing")}</p>}
            {!previewing && preview && (
              <>
                <p className="text-sm">
                  {t("summary", { volumes: preview.volume_count, chapters: preview.chapter_count, words: words(preview.word_count) })}
                  <span className="ml-2 text-xs text-muted">{t("encoding", { encoding: preview.encoding })}</span>
                </p>
                <ul className="divide-y divide-border rounded-xl border border-border text-sm">
                  {preview.volumes.map((volume, index) => (
                    <li key={index} className="grid gap-1 px-3 py-2">
                      <div className="flex flex-wrap justify-between gap-2">
                        <span className="font-medium break-words">{volume.title}</span>
                        <span className="text-muted">{t("volumeStats", { chapters: volume.chapter_count, words: words(volume.word_count) })}</span>
                      </div>
                      <span className="break-words text-xs text-muted">
                        {volume.first_titles.join(" · ")}{volume.chapter_count > 3 ? ` … ${volume.last_title}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
                {preview.volumes_truncated && <p className="text-xs text-muted">{t("truncated")}</p>}
                {preview.warnings.length > 0 && (
                  <ul role="alert" className="space-y-1 rounded-xl border border-border bg-background px-3 py-2 text-sm">
                    {preview.warnings.map((warning) => <li key={warning} className="break-words">⚠ {warning}</li>)}
                  </ul>
                )}
              </>
            )}
          </section>
        </>
      )}

      {error && <p role="alert" className="break-words text-sm text-danger">{error}</p>}

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onPress={() => void submit()} isDisabled={!files.length || !preview || previewing || importing || !title.trim()}>
          {importing ? t("importing") : t("start")}
        </Button>
        {importing && <span className="text-xs text-muted">{t("importingHint")}</span>}
      </div>
      <p className="text-xs text-muted">{t("note")}</p>
    </div>
  );
}
