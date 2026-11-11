/**
 * 每种风格开机画面的编排时长（毫秒），和 styles/looks/boot-*.css 里的动画一一对应：show 是从开始到画面成型，leave 是退场动画本身。
 * 桌面客户端的启动页（client/novel_client/splash.py）按真实加载进度把 0–show 这段动画往前推，全部就绪后再放 leave；
 * 设置页的“预览启动动画”按这个时长原速播放。由 scripts/build-splash.mjs 一起导出给启动页，两边用同一份。
 */
export const BOOT_TIMING: Record<string, { show: number; leave: number }> = {
  tech: { show: 6200, leave: 700 },
  mist: { show: 4800, leave: 800 },
  forest: { show: 4800, leave: 800 },
  warm: { show: 4800, leave: 800 },
  cute: { show: 4800, leave: 700 },
  casual: { show: 4800, leave: 800 },
  sunny: { show: 4800, leave: 800 },
  heal: { show: 4800, leave: 800 },
  ink: { show: 4800, leave: 800 },
  retro: { show: 5000, leave: 700 },
  minimal: { show: 4600, leave: 700 },
};
