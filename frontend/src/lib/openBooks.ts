"use client";

import { useSyncExternalStore } from "react";

/** 顶栏书签页：打开过的书（按打开顺序）以及每本书上正在运行的任务来源（续写、全自动智能体等）。query 是离开时所在的栏目，切回来时恢复。 */
export interface OpenBook { id: string; title: string; query?: string }
interface State { books: OpenBook[]; busy: Record<string, string[]> }

const KEY = "novel-open-books";
const MAX_BOOKS = 12;
const listeners = new Set<() => void>();
let state: State = { books: [], busy: {} };
let loaded = false;

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (Array.isArray(saved)) state = { ...state, books: saved.filter((row) => row && typeof row.id === "string").map((row) => ({ id: row.id, title: String(row.title ?? ""), query: typeof row.query === "string" ? row.query : "" })).slice(-MAX_BOOKS) };
  } catch { /* 只是记住上次打开的书，读不到就从空开始 */ }
}

function commit(next: State) {
  state = next;
  try { localStorage.setItem(KEY, JSON.stringify(state.books)); } catch { /* 同上 */ }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  load();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const EMPTY: State = { books: [], busy: {} };
export function useOpenBooks(): State {
  return useSyncExternalStore(subscribe, () => { load(); return state; }, () => EMPTY);
}

export function openBooksSnapshot(): State { load(); return state; }

/** 打开（或更新标题、所在栏目）一本书；已打开的保持原位置。超出上限时关掉最早打开且没有任务在运行的那本。 */
export function openBook(id: string, title = "", query?: string) {
  load();
  const index = state.books.findIndex((row) => row.id === id);
  if (index >= 0) {
    const row = state.books[index];
    const next = { ...row, ...(title ? { title } : {}), ...(query !== undefined ? { query } : {}) };
    if (next.title === row.title && next.query === row.query) return;
    commit({ ...state, books: state.books.map((item) => item.id === id ? next : item) });
    return;
  }
  let books = [...state.books, { id, title, query: query ?? "" }];
  while (books.length > MAX_BOOKS) {
    const idle = books.findIndex((row) => row.id !== id && !state.busy[row.id]?.length);
    if (idle < 0) break;
    books = books.filter((_, position) => position !== idle);
  }
  commit({ ...state, books });
}

export function closeBook(id: string) {
  load();
  if (!state.books.some((row) => row.id === id)) return;
  const busy = { ...state.busy };
  delete busy[id];
  commit({ books: state.books.filter((row) => row.id !== id), busy });
}

/** 某个来源报告这本书上有没有任务在跑；书签页据此显示小圆点，关闭时提醒。 */
export function setBookBusy(id: string, source: string, running: boolean) {
  load();
  const current = state.busy[id] ?? [];
  if (running === current.includes(source)) return;
  const next = running ? [...current, source] : current.filter((item) => item !== source);
  const busy = { ...state.busy };
  if (next.length) busy[id] = next; else delete busy[id];
  commit({ ...state, busy });
}
