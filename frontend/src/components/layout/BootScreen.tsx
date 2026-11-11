"use client";

import { useEffect, useState } from "react";
import BootScenes from "./BootScenes";
import { BOOT_TIMING } from "./bootTiming";

/** 点击或按键跳过：不放各风格自己的退场，统一快速淡出（boot-base.css 的 [data-skip]）。 */
const SKIP_LEAVE_MS = 280;
/** 设置页“预览启动动画”按钮派发这个事件，原速播放一遍当前风格的启动动画。 */
export const REPLAY_BOOT_EVENT = "novel-replay-boot";

/**
 * 启动动画的预览层。真正的启动动画在桌面客户端的启动页里，跟着数据库、后端、界面的加载进度播放（client/novel_client/splash.py），
 * 进入界面后不再额外放一遍；这里只在设置页点“预览启动动画”时出现，按 bootTiming 的时长原速放完再退场。
 * 播放中任意点击或按键立即退场；预览层自身不接收指针事件，这次点击照常落到下面的按钮上。它只是装饰（aria-hidden，文字由 CSS 绘制）。
 * Args: locale 当前语言。
 * Returns: 预览层；没在预览时返回 null。
 */
export default function BootScreen({ locale }: { locale: string }) {
  const [phase, setPhase] = useState<"visible" | "leaving" | "gone">("gone");
  const [skipped, setSkipped] = useState(false);
  const [run, setRun] = useState(0);
  const lang = locale.startsWith("en") ? "en" : "zh";

  useEffect(() => {
    const replay = () => { setRun((n) => n + 1); setSkipped(false); setPhase("visible"); };
    window.addEventListener(REPLAY_BOOT_EVENT, replay);
    return () => window.removeEventListener(REPLAY_BOOT_EVENT, replay);
  }, []);

  useEffect(() => {
    if (!run) return;
    const timing = BOOT_TIMING[document.documentElement.dataset.look ?? ""] ?? BOOT_TIMING.tech;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let left = false;
    const detach = () => {
      window.removeEventListener("pointerdown", skip, true);
      window.removeEventListener("keydown", skip, true);
    };
    const leave = (byUser: boolean) => {
      if (left) return;
      left = true;
      detach();
      timers.forEach(clearTimeout);
      if (byUser) setSkipped(true);
      setPhase("leaving");
      timers.push(setTimeout(() => setPhase("gone"), (byUser ? SKIP_LEAVE_MS : timing.leave) + 40));
    };
    // 捕获阶段监听、不阻止默认行为：跳过动画的同时，这次点击或按键照常交给页面。
    function skip() { leave(true); }
    // 点“预览”的那一下也是 pointerdown，等它过去再开始监听跳过。
    timers.push(setTimeout(() => {
      window.addEventListener("pointerdown", skip, true);
      window.addEventListener("keydown", skip, true);
    }, 0));
    timers.push(setTimeout(() => leave(false), timing.show));
    return () => { detach(); timers.forEach(clearTimeout); };
  }, [run]);

  if (phase === "gone") return null;
  return (
    <div key={run} className="boot-screen" data-phase={phase} data-skip={skipped ? "1" : undefined} data-lang={lang} aria-hidden="true">
      <BootScenes lang={lang} />
    </div>
  );
}
