"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { apiGet } from "@/lib/api";
import { closeBook, openBook, openBooksSnapshot, setBookBusy, useOpenBooks } from "@/lib/openBooks";
import "./book-tabs.css";
import { confirmDialog } from "@/components/shared/ConfirmDialog";

const AGENT_POLL_MS = 6000;

/**
 * 顶栏书签页：每本打开过的书一个标签，切换时各自的续写、全自动智能体任务都不中断；有任务在运行的书显示小圆点。
 * 全自动智能体在服务端运行，这里定时查询哪些书上有智能体任务；续写由续写页自己报告。
 */
export default function BookTabs() {
  const router = useRouter();
  const pathname = usePathname();
  const { books, busy } = useOpenBooks();
  const locale = pathname.startsWith("/en") ? "en" : "zh";
  const zh = locale === "zh";
  const current = pathname.match(/^\/(?:zh|en)\/writing\/([0-9a-f]{24})/)?.[1] ?? null;
  const ids = books.map((row) => row.id).join(",");
  const checked = useRef(new Set<string>());

  // 每本书每次启动核对一次：取最新书名；书已被删除（回收或彻底删除）时关掉它的标签。
  useEffect(() => {
    if (!ids) return;
    for (const id of ids.split(",")) {
      if (checked.current.has(id)) continue;
      checked.current.add(id);
      void apiGet<{ title: string }>(`/api/novels/${id}`).then((novel) => openBook(id, novel.title || (zh ? "未命名" : "Untitled")))
        .catch((error) => {
          if ((error as { status?: number }).status === 404) closeBook(id);
          else checked.current.delete(id);  // 后端还没就绪，下次再查
        });
    }
  }, [ids, zh]);

  const watching = books.length > 0;
  // 窄屏标签放不下时，当前这本书的标签滚到看得见的位置。
  useEffect(() => {
    if (current) document.querySelector(`.book-tab[data-book="${current}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current, ids]);
  useEffect(() => {
    if (!watching) return;
    let alive = true;
    const poll = () => {
      if (document.hidden) return;
      void apiGet<{ novel_ids: string[] }>("/api/book-agent/active").then(({ novel_ids }) => {
        if (!alive) return;
        const running = new Set(novel_ids);
        for (const row of openBooksSnapshot().books) setBookBusy(row.id, "agent", running.has(row.id));
      }).catch(() => { /* 后端未就绪时下次再查 */ });
    };
    poll();
    const timer = window.setInterval(poll, AGENT_POLL_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, [watching]);

  if (!books.length) return null;
  const go = (id: string) => {
    if (id === current) return;
    const row = books.find((item) => item.id === id);
    router.push(`/${locale}/writing/${id}${row?.query ? `?${row.query}` : ""}`);
  };
  const close = async (id: string) => {
    const sources = busy[id] ?? [];
    // 续写在本页运行，关掉标签会停止它；全自动智能体在后台运行，关掉标签不影响。
    if (sources.includes("continuation") && !(await confirmDialog({
      title: zh ? "关闭这本书？" : "Close this book?",
      message: zh ? "这本书正在续写，关闭标签会停止生成。已写出的文字保留在草稿里。" : "This book is still generating. Closing the tab stops it; the draft is kept.",
      confirmLabel: zh ? "停止并关闭" : "Stop and close", cancelLabel: zh ? "继续写" : "Keep writing", tone: "danger",
    }))) return;
    if (id === current) {
      const rest = books.filter((row) => row.id !== id);
      const next = rest[Math.min(books.findIndex((row) => row.id === id), rest.length - 1)];
      router.push(next ? `/${locale}/writing/${next.id}${next.query ? `?${next.query}` : ""}` : `/${locale}`);
    }
    closeBook(id);
  };
  return <nav aria-label={zh ? "打开的书" : "Open books"} className="book-tabs workspace-scrollbar">
    {books.map((row) => {
      const active = row.id === current;
      const running = (busy[row.id] ?? []).length > 0;
      const label = row.title || (zh ? "读取中…" : "Loading…");
      return <div key={row.id} className="book-tab" data-book={row.id} data-active={active ? "true" : undefined} data-running={running ? "true" : undefined}>
        <button type="button" className="book-tab-main" aria-current={active ? "page" : undefined} title={running ? `${label} · ${zh ? "有任务在运行" : "task running"}` : label} onClick={() => go(row.id)}>
          {running && <span className="book-tab-dot" aria-hidden="true" />}
          <span className="book-tab-title">{label}</span>
          {running && <span className="sr-only">{zh ? "（有任务在运行）" : " (running)"}</span>}
        </button>
        <button type="button" className="book-tab-close" aria-label={zh ? `关闭《${label}》` : `Close ${label}`} onClick={() => void close(row.id)}>
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>;
    })}
  </nav>;
}
