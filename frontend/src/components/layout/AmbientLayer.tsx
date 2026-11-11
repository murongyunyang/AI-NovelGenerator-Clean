"use client";

/* 背景里缓慢的小动静（雾、落叶、墨晕、光斑……），每种风格一套，样式在 styles/looks/ambient.css 与 theme-atmosphere.css。
   固定在内容下面、不接收指针；窗口切到后台时暂停，减少动态效果时不显示。 */

import { useEffect, type CSSProperties } from "react";

export const AMBIENT_PARTICLES = 7;

export function AmbientParticles() {
  return <div className="ambient" aria-hidden="true">
    {Array.from({ length: AMBIENT_PARTICLES }, (_, index) => <i key={index} />)}
    {[0, 1, 2, 3].map((index) => <b key={`accent-${index}`} style={{ "--i": index } as CSSProperties} />)}
  </div>;
}

export default function AmbientLayer() {
  useEffect(() => {
    const sync = () => { document.documentElement.dataset.hidden = document.hidden ? "true" : "false"; };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  return <AmbientParticles />;
}
