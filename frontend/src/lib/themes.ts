export interface ThemeColors {
  "--background": string;
  "--foreground": string;
  "--color-warm-50": string;
  "--color-warm-100": string;
  "--color-warm-200": string;
  "--color-warm-300": string;
  "--color-warm-400": string;
  "--color-warm-500": string;
  "--color-warm-600": string;
  "--color-warm-700": string;
  "--color-warm-800": string;
  "--color-warm-900": string;
  "--color-accent": string;
  "--color-accent-foreground": string;
  "--color-accent-hover": string;
  "--color-surface": string;
  "--color-surface-secondary": string;
  "--color-surface-raised": string;
  "--color-selected": string;
  "--color-border": string;
  "--color-muted": string;
}

export interface ThemePreset {
  id: string;
  light: ThemeColors;
  dark: ThemeColors;
  /* 用于预览的 4 个代表性色块 */
  swatches: [string, string, string, string];
}


/* 雾蓝：亮色保留纸面质感，暗色用表面明度区分层次。 */
export const MIST_THEME: ThemePreset = {
  id: "mist",
  swatches: ["#456783", "#aac3df", "#e2eaf2", "#fafaf9"],
  light: {
    "--background": "#f1f3f5",
    "--foreground": "#303844",
    "--color-warm-50": "#f7f9fb",
    "--color-warm-100": "#edf2f7",
    "--color-warm-200": "#dce5ee",
    "--color-warm-300": "#c2d1df",
    "--color-warm-400": "#9bb1c6",
    "--color-warm-500": "#7995af",
    "--color-warm-600": "#5d7e9b",
    "--color-warm-700": "#456783",
    "--color-warm-800": "#344f68",
    "--color-warm-900": "#263b50",
    "--color-accent": "#456783",
    "--color-accent-foreground": "#f8fafc",
    "--color-accent-hover": "#3a5973",
    "--color-surface": "#fafaf9",
    "--color-surface-secondary": "#e9edf1",
    "--color-surface-raised": "#fdfdfc",
    "--color-selected": "#e2eaf2",
    "--color-border": "#d6dce3",
    "--color-muted": "#5b6877",
  },
  dark: {
    "--background": "#171b22",
    "--foreground": "#d9dfe7",
    "--color-warm-50": "#1b232e",
    "--color-warm-100": "#222d3a",
    "--color-warm-200": "#2c3b4d",
    "--color-warm-300": "#3b5068",
    "--color-warm-400": "#536f8e",
    "--color-warm-500": "#7392b2",
    "--color-warm-600": "#90adc9",
    "--color-warm-700": "#aac3df",
    "--color-warm-800": "#c6d7e9",
    "--color-warm-900": "#e0e9f2",
    "--color-accent": "#aac3df",
    "--color-accent-foreground": "#1c2a39",
    "--color-accent-hover": "#bed1e8",
    "--color-surface": "#20252e",
    "--color-surface-secondary": "#272e38",
    "--color-surface-raised": "#2a303b",
    "--color-selected": "#2c3b4d",
    "--color-border": "#3b4655",
    "--color-muted": "#a4b0bf",
  },
};


/* 森林绿只用于强调；大面积背景和文字采用接近中性的颜色。 */
export const FOREST_THEME: ThemePreset = {
  id: "forest",
  swatches: ["#546B41", "#99AD7A", "#d9dfd6", "#f6f7f4"],
  light: {
    "--background": "#f6f7f4",
    "--foreground": "#252d28",
    "--color-warm-50": "#fffdf7",
    "--color-warm-100": "#FFF8EC",
    "--color-warm-200": "#f0e8d5",
    "--color-warm-300": "#DCCCAC",
    "--color-warm-400": "#b8b892",
    "--color-warm-500": "#99AD7A",
    "--color-warm-600": "#7a9460",
    "--color-warm-700": "#546B41",
    "--color-warm-800": "#3f5232",
    "--color-warm-900": "#2d3a24",
    "--color-accent": "#546B41",
    "--color-accent-foreground": "#ffffff",
    "--color-accent-hover": "#465a35",
    "--color-surface": "#ffffff",
    "--color-surface-secondary": "#edf0eb",
    "--color-surface-raised": "#ffffff",
    "--color-selected": "#edf0eb",
    "--color-border": "#d9dfd6",
    "--color-muted": "#626f65",
  },
  dark: {
    "--background": "#151917",
    "--foreground": "#e7ece7",
    "--color-warm-50": "#1a2015",
    "--color-warm-100": "#222b1b",
    "--color-warm-200": "#303d24",
    "--color-warm-300": "#3f5232",
    "--color-warm-400": "#546B41",
    "--color-warm-500": "#7a9460",
    "--color-warm-600": "#99AD7A",
    "--color-warm-700": "#b5c89e",
    "--color-warm-800": "#DCCCAC",
    "--color-warm-900": "#f0e8d5",
    "--color-accent": "#99AD7A",
    "--color-accent-foreground": "#172019",
    "--color-accent-hover": "#adc08e",
    "--color-surface": "#1c221e",
    "--color-surface-secondary": "#252d27",
    "--color-surface-raised": "#2a332d",
    "--color-selected": "#303930",
    "--color-border": "#364038",
    "--color-muted": "#a4b0a5",
  },
};


/* Warm — 项目原有暖棕配色 */
export const WARM_THEME: ThemePreset = {
  id: "warm",
  swatches: ["#945a34", "#b08850", "#dfd9cf", "#faf9f6"],
  light: {
    "--background": "#faf9f6",
    "--foreground": "#302d28",
    "--color-warm-50": "#fdfbf7",
    "--color-warm-100": "#faf6f1",
    "--color-warm-200": "#f0e6d6",
    "--color-warm-300": "#e2d0b8",
    "--color-warm-400": "#c9a87c",
    "--color-warm-500": "#b08850",
    "--color-warm-600": "#96703a",
    "--color-warm-700": "#7a5a2e",
    "--color-warm-800": "#5c4322",
    "--color-warm-900": "#3d2c16",
    "--color-accent": "#945a34",
    "--color-accent-foreground": "#ffffff",
    "--color-accent-hover": "#85502d",
    "--color-surface": "#ffffff",
    "--color-surface-secondary": "#f0ede6",
    "--color-surface-raised": "#ffffff",
    "--color-selected": "#f0ede6",
    "--color-border": "#dfd9cf",
    "--color-muted": "#736858",
  },
  dark: {
    "--background": "#191816",
    "--foreground": "#ede6dc",
    "--color-warm-50": "#1a1510",
    "--color-warm-100": "#231d15",
    "--color-warm-200": "#352a1c",
    "--color-warm-300": "#4a3b28",
    "--color-warm-400": "#6b5638",
    "--color-warm-500": "#8c7248",
    "--color-warm-600": "#b08850",
    "--color-warm-700": "#c9a87c",
    "--color-warm-800": "#e2d0b8",
    "--color-warm-900": "#f0e6d6",
    "--color-accent": "#d4864a",
    "--color-accent-foreground": "#241a11",
    "--color-accent-hover": "#e09558",
    "--color-surface": "#22201c",
    "--color-surface-secondary": "#2c2923",
    "--color-surface-raised": "#332f28",
    "--color-selected": "#36291f",
    "--color-border": "#403a31",
    "--color-muted": "#b7a996",
  },
};


/* 科技：深海军蓝底配青色、紫色点缀；亮色用冰白底和深一档的青，保证文字和细线清晰。 */
export const TECH_THEME: ThemePreset = {
  id: "tech",
  swatches: ["#22d3ee", "#8b5cf6", "#111b30", "#070b14"],
  light: {
    "--background": "#eef3f9",
    "--foreground": "#1b2a41",
    "--color-warm-50": "#f5f9fd",
    "--color-warm-100": "#e8f0f8",
    "--color-warm-200": "#d3e1f0",
    "--color-warm-300": "#b4c9e0",
    "--color-warm-400": "#8aa7c7",
    "--color-warm-500": "#6486ad",
    "--color-warm-600": "#476a92",
    "--color-warm-700": "#36557a",
    "--color-warm-800": "#274260",
    "--color-warm-900": "#1a2d45",
    "--color-accent": "#0e7490",
    "--color-accent-foreground": "#f0fdff",
    "--color-accent-hover": "#155e75",
    "--color-surface": "#f9fbfe",
    "--color-surface-secondary": "#e4edf6",
    "--color-surface-raised": "#ffffff",
    "--color-selected": "#dfeff8",
    "--color-border": "#cbd9e8",
    "--color-muted": "#4f6480",
  },
  dark: {
    "--background": "#060a13",
    "--foreground": "#dbe7ff",
    "--color-warm-50": "#0d1424",
    "--color-warm-100": "#111b30",
    "--color-warm-200": "#172540",
    "--color-warm-300": "#1c2a44",
    "--color-warm-400": "#2d4468",
    "--color-warm-500": "#4a6a99",
    "--color-warm-600": "#7a98c4",
    "--color-warm-700": "#a9c0e4",
    "--color-warm-800": "#cddcf3",
    "--color-warm-900": "#e6eefb",
    "--color-accent": "#22d3ee",
    "--color-accent-foreground": "#04222a",
    "--color-accent-hover": "#67e8f9",
    "--color-surface": "#0c1322",
    "--color-surface-secondary": "#111b2f",
    "--color-surface-raised": "#142039",
    "--color-selected": "#12304a",
    "--color-border": "#1d2e4a",
    "--color-muted": "#8ea4c8",
  },
};


/* 可爱：奶白底配莓粉，暗色是深梅色底配樱花粉。 */
export const CUTE_THEME: ThemePreset = {
  id: "cute",
  swatches: ["#b5365f", "#9b7ad8", "#fde8ef", "#fff6f8"],
  light: {
    "--background": "#fff6f8",
    "--foreground": "#3d2a33",
    "--color-warm-50": "#faf4f6",
    "--color-warm-100": "#f5e6eb",
    "--color-warm-200": "#edcfd9",
    "--color-warm-300": "#e2abbe",
    "--color-warm-400": "#d67b99",
    "--color-warm-500": "#cb4874",
    "--color-warm-600": "#b32d5a",
    "--color-warm-700": "#912147",
    "--color-warm-800": "#731736",
    "--color-warm-900": "#570f27",
    "--color-accent": "#b5365f",
    "--color-accent-foreground": "#ffffff",
    "--color-accent-hover": "#982b4f",
    "--color-surface": "#ffffff",
    "--color-surface-secondary": "#fdeef2",
    "--color-surface-raised": "#ffffff",
    "--color-selected": "#fde8ef",
    "--color-border": "#f2d4de",
    "--color-muted": "#7a5a68",
  },
  dark: {
    "--background": "#1d1519",
    "--foreground": "#f6e4ea",
    "--color-warm-50": "#241419",
    "--color-warm-100": "#321b22",
    "--color-warm-200": "#472430",
    "--color-warm-300": "#602f3f",
    "--color-warm-400": "#843e55",
    "--color-warm-500": "#b14e6f",
    "--color-warm-600": "#c67791",
    "--color-warm-700": "#d9a0b3",
    "--color-warm-800": "#e9c4d0",
    "--color-warm-900": "#f4e1e7",
    "--color-accent": "#f49ab6",
    "--color-accent-foreground": "#3a1222",
    "--color-accent-hover": "#f8b3c8",
    "--color-surface": "#261b21",
    "--color-surface-secondary": "#2f2229",
    "--color-surface-raised": "#33252c",
    "--color-selected": "#3d2833",
    "--color-border": "#45313b",
    "--color-muted": "#c3a6b2",
  },
};

/* 休闲：沙滩米色底配海水绿，珊瑚色只做点缀；暗色是夜里的海。 */
export const CASUAL_THEME: ThemePreset = {
  id: "casual",
  swatches: ["#0f7177", "#e8735a", "#efe9dc", "#f7f3ea"],
  light: {
    "--background": "#f7f3ea",
    "--foreground": "#24343a",
    "--color-warm-50": "#f5f9fa",
    "--color-warm-100": "#e7f2f3",
    "--color-warm-200": "#d2e9ea",
    "--color-warm-300": "#b1dadc",
    "--color-warm-400": "#85c8cc",
    "--color-warm-500": "#56b8bd",
    "--color-warm-600": "#3c9fa5",
    "--color-warm-700": "#2d8185",
    "--color-warm-800": "#216569",
    "--color-warm-900": "#174c4f",
    "--color-accent": "#0f7177",
    "--color-accent-foreground": "#ffffff",
    "--color-accent-hover": "#0b5c61",
    "--color-surface": "#fffdf8",
    "--color-surface-secondary": "#efe9dc",
    "--color-surface-raised": "#ffffff",
    "--color-selected": "#e4f2f0",
    "--color-border": "#e2dbcc",
    "--color-muted": "#5e6b6d",
  },
  dark: {
    "--background": "#121a1d",
    "--foreground": "#e3eceb",
    "--color-warm-50": "#162222",
    "--color-warm-100": "#1d2f30",
    "--color-warm-200": "#284244",
    "--color-warm-300": "#33595b",
    "--color-warm-400": "#447b7e",
    "--color-warm-500": "#57a4a8",
    "--color-warm-600": "#7ebbbe",
    "--color-warm-700": "#a5d2d4",
    "--color-warm-800": "#c7e4e5",
    "--color-warm-900": "#e3f2f2",
    "--color-accent": "#4fc2c0",
    "--color-accent-foreground": "#082022",
    "--color-accent-hover": "#6fd3d1",
    "--color-surface": "#18242a",
    "--color-surface-secondary": "#1e2c33",
    "--color-surface-raised": "#223239",
    "--color-selected": "#183a3d",
    "--color-border": "#2a3b42",
    "--color-muted": "#9db1b2",
  },
};

/* 阳光：暖白底配橙金，暗色是傍晚的暖褐底配亮金。 */
export const SUNNY_THEME: ThemePreset = {
  id: "sunny",
  swatches: ["#a64d00", "#f2a516", "#ffeccb", "#fffaee"],
  light: {
    "--background": "#fffaee",
    "--foreground": "#3a2a12",
    "--color-warm-50": "#fbf8f4",
    "--color-warm-100": "#f6efe5",
    "--color-warm-200": "#efe1cd",
    "--color-warm-300": "#e6cda7",
    "--color-warm-400": "#dcb374",
    "--color-warm-500": "#d5993f",
    "--color-warm-600": "#bc7f24",
    "--color-warm-700": "#9a6619",
    "--color-warm-800": "#794f11",
    "--color-warm-900": "#5c3b0a",
    "--color-accent": "#a64d00",
    "--color-accent-foreground": "#ffffff",
    "--color-accent-hover": "#8a3f00",
    "--color-surface": "#ffffff",
    "--color-surface-secondary": "#fdf1d6",
    "--color-surface-raised": "#ffffff",
    "--color-selected": "#ffeccb",
    "--color-border": "#f1e2c0",
    "--color-muted": "#7a6036",
  },
  dark: {
    "--background": "#1c1710",
    "--foreground": "#f8ecd6",
    "--color-warm-50": "#241e14",
    "--color-warm-100": "#33291a",
    "--color-warm-200": "#483923",
    "--color-warm-300": "#624d2d",
    "--color-warm-400": "#87693b",
    "--color-warm-500": "#b58a4a",
    "--color-warm-600": "#c9a773",
    "--color-warm-700": "#dcc39e",
    "--color-warm-800": "#eadac2",
    "--color-warm-900": "#f5ede0",
    "--color-accent": "#ffb547",
    "--color-accent-foreground": "#2e1c00",
    "--color-accent-hover": "#ffc76f",
    "--color-surface": "#252016",
    "--color-surface-secondary": "#2e271b",
    "--color-surface-raised": "#342c1f",
    "--color-selected": "#40311a",
    "--color-border": "#463b29",
    "--color-muted": "#c9b48e",
  },
};

/* 治愈：米白底配薰衣草紫，鼠尾草绿做点缀；暗色是低饱和的紫灰。 */
export const HEAL_THEME: ThemePreset = {
  id: "heal",
  swatches: ["#7059b3", "#8fb59a", "#ebe5f6", "#faf7f2"],
  light: {
    "--background": "#faf7f2",
    "--foreground": "#33303f",
    "--color-warm-50": "#f7f6f9",
    "--color-warm-100": "#ece9f1",
    "--color-warm-200": "#dcd6e5",
    "--color-warm-300": "#c3b9d5",
    "--color-warm-400": "#a292bf",
    "--color-warm-500": "#8169ab",
    "--color-warm-600": "#674f92",
    "--color-warm-700": "#523d75",
    "--color-warm-800": "#3f2e5c",
    "--color-warm-900": "#2e2145",
    "--color-accent": "#7059b3",
    "--color-accent-foreground": "#ffffff",
    "--color-accent-hover": "#5d4899",
    "--color-surface": "#ffffff",
    "--color-surface-secondary": "#f2eef6",
    "--color-surface-raised": "#ffffff",
    "--color-selected": "#ebe5f6",
    "--color-border": "#e6e0ec",
    "--color-muted": "#6b6578",
  },
  dark: {
    "--background": "#17161d",
    "--foreground": "#e8e5f0",
    "--color-warm-50": "#1b1820",
    "--color-warm-100": "#25202c",
    "--color-warm-200": "#332d3e",
    "--color-warm-300": "#443b54",
    "--color-warm-400": "#5c4f73",
    "--color-warm-500": "#796798",
    "--color-warm-600": "#998ab2",
    "--color-warm-700": "#b9aecb",
    "--color-warm-800": "#d4cde0",
    "--color-warm-900": "#e9e6f0",
    "--color-accent": "#b4a3e8",
    "--color-accent-foreground": "#231a3d",
    "--color-accent-hover": "#c5b8ee",
    "--color-surface": "#1f1e27",
    "--color-surface-secondary": "#262531",
    "--color-surface-raised": "#2b2a36",
    "--color-selected": "#312c45",
    "--color-border": "#363442",
    "--color-muted": "#a9a4ba",
  },
};

/* 水墨：宣纸底配墨色，朱红只用于印章和当前项；暗色把墨和纸反过来。 */
export const INK_THEME: ThemePreset = {
  id: "ink",
  swatches: ["#2b2925", "#b8322a", "#e4ded1", "#f4f1ea"],
  light: {
    "--background": "#f4f1ea",
    "--foreground": "#1f1d1a",
    "--color-warm-50": "#f8f7f7",
    "--color-warm-100": "#eeeeec",
    "--color-warm-200": "#e0dfdc",
    "--color-warm-300": "#cbc8c3",
    "--color-warm-400": "#afaaa2",
    "--color-warm-500": "#938d80",
    "--color-warm-600": "#7a7367",
    "--color-warm-700": "#615c51",
    "--color-warm-800": "#4b473e",
    "--color-warm-900": "#38352e",
    "--color-accent": "#2b2925",
    "--color-accent-foreground": "#f4f1ea",
    "--color-accent-hover": "#45413a",
    "--color-surface": "#faf8f3",
    "--color-surface-secondary": "#ebe6dc",
    "--color-surface-raised": "#fdfcf8",
    "--color-selected": "#e4ded1",
    "--color-border": "#d8d1c3",
    "--color-muted": "#6b655b",
  },
  dark: {
    "--background": "#141312",
    "--foreground": "#e9e4d8",
    "--color-warm-50": "#1d1c1b",
    "--color-warm-100": "#282725",
    "--color-warm-200": "#383633",
    "--color-warm-300": "#4b4944",
    "--color-warm-400": "#66635c",
    "--color-warm-500": "#878278",
    "--color-warm-600": "#a4a098",
    "--color-warm-700": "#c1beb9",
    "--color-warm-800": "#d9d7d4",
    "--color-warm-900": "#ecebe9",
    "--color-accent": "#e9e4d8",
    "--color-accent-foreground": "#1a1816",
    "--color-accent-hover": "#ffffff",
    "--color-surface": "#1c1a18",
    "--color-surface-secondary": "#23211e",
    "--color-surface-raised": "#292623",
    "--color-selected": "#302c27",
    "--color-border": "#38342e",
    "--color-muted": "#a59e90",
  },
};

/* 复古：牛皮纸底配酒红，像旧打字稿；暗色是灯下的旧书桌。 */
export const RETRO_THEME: ThemePreset = {
  id: "retro",
  swatches: ["#8c2f39", "#b08a3e", "#e6dbc3", "#efe6d2"],
  light: {
    "--background": "#efe6d2",
    "--foreground": "#3b2a22",
    "--color-warm-50": "#f9f7f6",
    "--color-warm-100": "#f0edea",
    "--color-warm-200": "#e4ddd7",
    "--color-warm-300": "#d3c5bb",
    "--color-warm-400": "#bca595",
    "--color-warm-500": "#a6856e",
    "--color-warm-600": "#8d6b54",
    "--color-warm-700": "#715541",
    "--color-warm-800": "#584231",
    "--color-warm-900": "#423024",
    "--color-accent": "#8c2f39",
    "--color-accent-foreground": "#fdf6ea",
    "--color-accent-hover": "#74252e",
    "--color-surface": "#f8f1e2",
    "--color-surface-secondary": "#e6dbc3",
    "--color-surface-raised": "#fbf6ec",
    "--color-selected": "#ead3c8",
    "--color-border": "#d6c7a8",
    "--color-muted": "#6e5a4a",
  },
  dark: {
    "--background": "#1b1714",
    "--foreground": "#eadfca",
    "--color-warm-50": "#201b19",
    "--color-warm-100": "#2b2521",
    "--color-warm-200": "#3d342e",
    "--color-warm-300": "#52463c",
    "--color-warm-400": "#715e51",
    "--color-warm-500": "#967c69",
    "--color-warm-600": "#b09b8c",
    "--color-warm-700": "#cabbb0",
    "--color-warm-800": "#dfd5ce",
    "--color-warm-900": "#efeae6",
    "--color-accent": "#d9826f",
    "--color-accent-foreground": "#2a110b",
    "--color-accent-hover": "#e69a89",
    "--color-surface": "#231e1a",
    "--color-surface-secondary": "#2b2520",
    "--color-surface-raised": "#312a24",
    "--color-selected": "#3d2a25",
    "--color-border": "#40372e",
    "--color-muted": "#b3a38c",
  },
};

/* 极简：黑白灰，只留一种克莱因蓝做强调。 */
export const MINIMAL_THEME: ThemePreset = {
  id: "minimal",
  swatches: ["#111111", "#1f3fbf", "#e2e2e2", "#fafafa"],
  light: {
    "--background": "#fafafa",
    "--foreground": "#111111",
    "--color-warm-50": "#f7f7f8",
    "--color-warm-100": "#ededee",
    "--color-warm-200": "#dddddf",
    "--color-warm-300": "#c5c5c9",
    "--color-warm-400": "#a4a6ac",
    "--color-warm-500": "#84868f",
    "--color-warm-600": "#6a6d76",
    "--color-warm-700": "#54565e",
    "--color-warm-800": "#414249",
    "--color-warm-900": "#303136",
    "--color-accent": "#1f3fbf",
    "--color-accent-foreground": "#ffffff",
    "--color-accent-hover": "#18339c",
    "--color-surface": "#ffffff",
    "--color-surface-secondary": "#f2f2f2",
    "--color-surface-raised": "#ffffff",
    "--color-selected": "#ebeefa",
    "--color-border": "#e2e2e2",
    "--color-muted": "#5c5c5c",
  },
  dark: {
    "--background": "#0d0d0d",
    "--foreground": "#f2f2f2",
    "--color-warm-50": "#1b1c1d",
    "--color-warm-100": "#252627",
    "--color-warm-200": "#343537",
    "--color-warm-300": "#45464a",
    "--color-warm-400": "#5e5f64",
    "--color-warm-500": "#7b7d84",
    "--color-warm-600": "#9b9ca2",
    "--color-warm-700": "#babbbf",
    "--color-warm-800": "#d5d5d8",
    "--color-warm-900": "#eaeaeb",
    "--color-accent": "#8ea4ff",
    "--color-accent-foreground": "#0a1240",
    "--color-accent-hover": "#a9baff",
    "--color-surface": "#151515",
    "--color-surface-secondary": "#1b1b1b",
    "--color-surface-raised": "#202020",
    "--color-selected": "#1c2240",
    "--color-border": "#2a2a2a",
    "--color-muted": "#a0a0a0",
  },
};

/* 导出项。顺序就是设置页里的展示顺序。 */
export const THEME_PRESETS: ThemePreset[] = [
  TECH_THEME, MIST_THEME, FOREST_THEME, WARM_THEME, CUTE_THEME, CASUAL_THEME,
  SUNNY_THEME, HEAL_THEME, INK_THEME, RETRO_THEME, MINIMAL_THEME,
];

export const DEFAULT_PRESET_ID = "tech";

/**
 * 生成每种风格的亮色、暗色变量表，由服务端布局直接写进页面的 <style>。
 * 首帧之前的脚本只要设好 html 的 data-look 和 .dark，配色就已经到位，开机动画和界面都不会先闪成默认配色。
 * Returns: 以 :root[data-look="风格"] 为选择器的 CSS 文本；自定义配色是行内样式，优先级仍高于它。
 */
export function presetPaletteCss(): string {
  const block = (selector: string, colors: ThemeColors) =>
    `${selector}{${Object.entries(colors).map(([key, value]) => `${key}:${value}`).join(";")}}`;
  return THEME_PRESETS.map((preset) =>
    block(`:root[data-look="${preset.id}"]`, preset.light) + block(`:root[data-look="${preset.id}"].dark`, preset.dark),
  ).join("\n");
}

/**
 * 按保存的名称查找预设，保留用户之前选择的配色。
 * Args:
 *   id: 预设名称。
 * Returns:
 *   匹配的预设；名称不存在时返回 undefined。
 */
export function getPreset(id: string): ThemePreset | undefined {
  return THEME_PRESETS.find((p) => p.id === id);
}

/* 在自定义编辑器中优先展示的语义颜色键 */
export const SEMANTIC_COLOR_KEYS: (keyof ThemeColors)[] = [
  "--background",
  "--foreground",
  "--color-accent",
  "--color-accent-foreground",
  "--color-accent-hover",
  "--color-surface",
  "--color-surface-secondary",
  "--color-surface-raised",
  "--color-selected",
  "--color-border",
  "--color-muted",
];

/* 在高级区域中展示的暖色阶颜色键 */
export const SCALE_COLOR_KEYS: (keyof ThemeColors)[] = [
  "--color-warm-50",
  "--color-warm-100",
  "--color-warm-200",
  "--color-warm-300",
  "--color-warm-400",
  "--color-warm-500",
  "--color-warm-600",
  "--color-warm-700",
  "--color-warm-800",
  "--color-warm-900",
];

export const ALL_COLOR_KEYS = Object.keys(MIST_THEME.light) as (keyof ThemeColors)[];

/**
 * 创建独立的雾蓝配色，供首次自定义时编辑。
 * Args:
 *   无。
 * Returns:
 *   亮色与暗色的颜色副本。
 */
export function createDefaultCustomColors(): { light: ThemeColors; dark: ThemeColors } {
  return {
    light: { ...MIST_THEME.light },
    dark: { ...MIST_THEME.dark },
  };
}
