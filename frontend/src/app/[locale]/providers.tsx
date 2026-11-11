"use client";

import { I18nProvider } from "@heroui/react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { ThemeCustomizationProvider } from "@/components/ThemeCustomizationProvider";
import FileDropGuard from "@/components/layout/FileDropGuard";
import AmbientLayer from "@/components/layout/AmbientLayer";
import { ConfirmHost } from "@/components/shared/ConfirmDialog";
import { AgentQuestionHost } from "@/components/shared/AgentQuestionDialog";

export function Providers({ children, locale }: { children: React.ReactNode; locale: string }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="dark" enableSystem={false}>
      <ThemeCustomizationProvider>
        <I18nProvider locale={locale}>
          <FileDropGuard />
          <AmbientLayer />
          {children}
          <ConfirmHost />
          <AgentQuestionHost />
        </I18nProvider>
      </ThemeCustomizationProvider>
    </NextThemesProvider>
  );
}
