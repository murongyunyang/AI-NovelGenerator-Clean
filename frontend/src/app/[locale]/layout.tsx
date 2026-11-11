import { hasLocale } from "next-intl";
import { notFound } from "next/navigation";
import { getMessages, getTranslations, setRequestLocale } from "next-intl/server";
import { NextIntlClientProvider } from "next-intl";
import { routing } from "@/i18n/routing";
import { Providers } from "./providers";
import { StartupGate } from "@/components/layout/StartupGate";
import Navbar from "@/components/layout/Navbar";
import BootScreen from "@/components/layout/BootScreen";
import { WorkspacePages } from "@/components/layout/WorkspacePages";
import InputAutoGrow from "@/components/layout/InputAutoGrow";
import { DEFAULT_PRESET_ID, THEME_PRESETS, presetPaletteCss } from "@/lib/themes";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

const LOOK_IDS = JSON.stringify(THEME_PRESETS.map((preset) => preset.id));
const PALETTE_CSS = presetPaletteCss();

/**
 * 首帧之前执行（早于 next-themes 自己的脚本）：
 * 1. 界面改版为科幻深色时只迁移一次：亮暗改为暗色、预设改为“科技”；自定义配色保持不动，之后用户的选择照常保存。
 * 2. 设好风格（html 的 data-look）和亮暗（.dark），自定义配色直接写成行内变量，第一帧就是用户选的风格和配色。
 * 启动动画在桌面客户端的启动页里随加载进度播放，进入界面后不再放。
 */
const PRE_PAINT_SCRIPT = `try{var k='novel-ui-version';if(localStorage.getItem(k)!=='hud-2'){localStorage.setItem('theme','dark');if(localStorage.getItem('novel-theme-preset')!=='custom')localStorage.setItem('novel-theme-preset','tech');localStorage.setItem(k,'hud-2')}}catch(e){}
var d=document.documentElement,L=${LOOK_IDS},look='${DEFAULT_PRESET_ID}';
try{var p=localStorage.getItem('novel-theme-preset')||look;look=p==='custom'?(localStorage.getItem('novel-theme-look')||look):p;if(localStorage.getItem('theme')!=='light')d.classList.add('dark');if(p==='custom'){var c=JSON.parse(localStorage.getItem('novel-theme-custom')||'null');c=c&&c[d.classList.contains('dark')?'dark':'light'];if(c)for(var n in c)if(/^--[a-z0-9-]+$/.test(n)&&/^#[0-9a-fA-F]{3,8}$/.test(c[n]))d.style.setProperty(n,c[n])}}catch(e){}
if(L.indexOf(look)<0)look='${DEFAULT_PRESET_ID}';d.dataset.look=look;`;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "nav" });
  return { title: t("title") };
}

export default async function LocaleLayout({
  children,
  modal,
  params,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  setRequestLocale(locale);

  const messages = await getMessages();

  return (
    <html lang={locale} className="h-full antialiased" suppressHydrationWarning>
      <head>
        <style dangerouslySetInnerHTML={{ __html: PALETTE_CSS }} />
        <script dangerouslySetInnerHTML={{ __html: PRE_PAINT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col text-foreground">
        {/* 设置页“预览启动动画”用的预览层；平时不渲染任何东西。 */}
        <BootScreen locale={locale} />
        <NextIntlClientProvider messages={messages}>
          <Providers locale={locale}>
            <StartupGate>
              <InputAutoGrow />
              <Navbar />
              <main className="flex min-h-0 flex-1 flex-col"><WorkspacePages>{children}</WorkspacePages></main>
              {modal}
            </StartupGate>
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
