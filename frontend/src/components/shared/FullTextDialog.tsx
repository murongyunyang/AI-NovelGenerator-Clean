"use client";

import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { Button, Modal } from "@heroui/react";
import { useLocale } from "next-intl";
import { RetainedModalBackdrop } from "@/components/layout/RetainedViews";
import { TextFindReplace } from "./TextFindReplace";

/**
 * 全屏阅读正文：几乎占满窗口的编辑框，改动直接写回原草稿。生成中只读并停在最新文字上，向上翻看时不再拉回。
 * Args: title 窗口标题；value 正文；onChange 为空时只读；streaming 正在生成；areaRef 本窗口编辑框（顶栏的“AI 修改选段”读它的选区）；tools 顶栏的额外按钮。
 * Returns: 打开时的全屏窗口。
 */
export function FullTextDialog({ title, value, onChange, streaming = false, onClose, areaRef, tools }: {
  title: string; value: string; onChange?: (next: string) => void; streaming?: boolean; onClose: () => void;
  areaRef?: RefObject<HTMLTextAreaElement | null>; tools?: ReactNode;
}) {
  const zh = useLocale() !== "en";
  const own = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const follow = useRef(true);
  // 编辑框的 ref 可能由调用方持有，这里按 id 找到它来跟随最新文字。
  useEffect(() => {
    const element = document.getElementById(id);
    if (element && streaming && follow.current) element.scrollTop = element.scrollHeight;
  }, [id, value, streaming]);
  const chars = value.replace(/\s/g, "").length;
  return <RetainedModalBackdrop isOpen variant="blur" onOpenChange={(open) => { if (!open) onClose(); }}>
    <Modal.Container size="full" scroll="inside" className="p-0 sm:p-4">
      <Modal.Dialog data-testid="full-text-dialog" aria-label={title} className="flex h-[100dvh] min-h-0 w-full flex-col overflow-hidden sm:h-[94dvh] sm:max-h-[94dvh] sm:max-w-6xl">
        <Modal.Header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-baseline gap-3">
            <Modal.Heading className="truncate text-base font-semibold">{title}</Modal.Heading>
            <span className="shrink-0 font-mono text-xs text-muted tabular-nums">{chars} {zh ? "字" : "chars"}{streaming ? (zh ? " · 生成中" : " · writing") : ""}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {tools}
            <Button size="sm" variant="ghost" data-testid="full-text-close" onPress={onClose}>{zh ? "收起" : "Close"}</Button>
          </div>
        </Modal.Header>
        <Modal.Body className="flex min-h-0 flex-1 flex-col p-0">
          <div className="shrink-0 px-4 py-2"><TextFindReplace textareaRef={areaRef ?? own} value={value} onChange={onChange} disabled={streaming} /></div>
          <textarea ref={areaRef ?? own} id={id} data-testid="full-text-body" aria-label={title} value={value} readOnly={!onChange || streaming}
            onChange={(event) => onChange?.(event.target.value)}
            onScroll={(event) => { const element = event.currentTarget; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60; }}
            className="workspace-scrollbar min-h-0 w-full flex-1 resize-none overflow-y-auto bg-background px-5 py-5 text-[15px] leading-9 text-foreground outline-none sm:px-[max(2rem,calc((100%_-_48rem)_/_2))] sm:py-8" />
        </Modal.Body>
      </Modal.Dialog>
    </Modal.Container>
  </RetainedModalBackdrop>;
}
