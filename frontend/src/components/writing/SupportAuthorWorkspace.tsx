"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";
import { useId } from "react";

const METHODS = [
  { key: "wechat", color: "text-emerald-700 dark:text-emerald-300", background: "bg-emerald-500/10", size: 433 },
  { key: "alipay", color: "text-blue-700 dark:text-blue-300", background: "bg-blue-500/10", size: 720 },
] as const;

export default function SupportAuthorWorkspace() {
  const t = useTranslations("writing.supportAuthor");
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="workspace-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6 lg:p-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <header className="space-y-3">
          <span aria-hidden="true" className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-500/10 text-rose-600 dark:text-rose-300">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" />
            </svg>
          </span>
          <h1 id={headingId} className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
          <p className="text-sm leading-7 text-muted">{t("description")}</p>
        </header>

        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          {METHODS.map(({ key, color, background, size }) => (
            <article key={key} className="flex min-w-0 flex-col items-center gap-4 rounded-2xl border border-border bg-surface p-5 sm:p-6">
              <h2 className={`rounded-full px-4 py-1.5 text-sm font-semibold ${color} ${background}`}>{t(key)}</h2>
              <div className="w-full max-w-64 rounded-xl border border-black/10 bg-white p-3">
                <Image
                  src={`/sponsor/${key}-qr.png`}
                  alt={t(`${key}Alt`)}
                  width={size}
                  height={size}
                  unoptimized
                  className="h-auto w-full"
                />
              </div>
              <p className="text-center text-sm text-muted">{t(`${key}Hint`)}</p>
              <a href={`/sponsor/${key}.jpg`} download={`${key}-sponsor.jpg`} className="mt-auto inline-flex min-h-11 items-center justify-center rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
                {t("saveCode")}
                <span className="sr-only"> · {t(key)}</span>
              </a>
            </article>
          ))}
        </div>

        <div className="space-y-2 rounded-xl border border-border bg-surface-secondary/50 p-4 text-sm leading-6 text-muted">
          <p className="font-medium text-foreground">{t("voluntary")}</p>
          <p>{t("notice")}</p>
        </div>
        <p className="text-center text-sm leading-6 text-muted">{t("thanks")}</p>
      </div>
    </section>
  );
}
