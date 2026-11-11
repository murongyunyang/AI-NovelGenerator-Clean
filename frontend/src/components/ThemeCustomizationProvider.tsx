"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { useTheme } from "next-themes";
import type { ThemeColors } from "@/lib/themes";
import {
  THEME_PRESETS,
  DEFAULT_PRESET_ID,
  ALL_COLOR_KEYS,
  getPreset,
  createDefaultCustomColors,
} from "@/lib/themes";

const STORAGE_PRESET_KEY = "novel-theme-preset";
const STORAGE_CUSTOM_KEY = "novel-theme-custom";
/** 自定义配色沿用的风格（装饰和开机动画）：选择某个预设时记下，切到“自定义”后继续用它。 */
const STORAGE_LOOK_KEY = "novel-theme-look";
/** 桌面客户端的启动页在网页载入前显示，读不到 localStorage，所以把当前配色交给客户端保存。 */
const SAVE_LOOK_DELAY_MS = 600;

type StoredThemeColors = { light: ThemeColors; dark: ThemeColors };

interface ThemeCustomizationState {
  presetId: string;
  lookId: string;
  customColors: StoredThemeColors;
}

/* 上下文类型 */
interface ThemeCustomizationContextValue {
  presetId: string;
  /** 实际生效的风格：预设本身，或自定义配色沿用的那个预设。 */
  lookId: string;
  customLight: ThemeColors;
  customDark: ThemeColors;
  selectPreset: (id: string) => void;
  setCustomColors: (light: ThemeColors, dark: ThemeColors) => void;
}

const ThemeCustomizationContext =
  createContext<ThemeCustomizationContextValue | null>(null);

export function useThemeCustomization() {
  const ctx = useContext(ThemeCustomizationContext);
  if (!ctx) {
    throw new Error(
      "useThemeCustomization must be used within ThemeCustomizationProvider",
    );
  }

  return ctx;
}

/* 工具方法 */
function applyColors(colors: ThemeColors) {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(colors)) {
    root.style.setProperty(key, value);
  }
}

/** 预设配色由页面里的 CSS 按 data-look 提供，行内变量会盖住它，切回预设时要清掉。 */
function clearColors() {
  const root = document.documentElement;
  for (const key of ALL_COLOR_KEYS) {
    root.style.removeProperty(key);
  }
}

type DesktopApi = { save_look?: (look: Record<string, unknown>) => unknown };

/** 只在桌面客户端里存在；浏览器里打开时什么都不做。接口还没注入时等它的就绪事件，之后的变化会取消并重新排队，不会堆积监听。 */
function saveLookToDesktop(look: Record<string, unknown>): () => void {
  const send = () => {
    const api = (window as unknown as { pywebview?: { api?: DesktopApi } }).pywebview?.api;
    if (typeof api?.save_look !== "function") return false;
    void Promise.resolve(api.save_look(look)).catch(() => undefined);
    return true;
  };
  if (send()) return () => undefined;
  const onReady = () => { send(); };
  window.addEventListener("pywebviewready", onReady, { once: true });
  return () => window.removeEventListener("pywebviewready", onReady);
}

function readStorage<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 忽略存储额度错误 */
  }
}

function createDefaultThemeCustomizationState(): ThemeCustomizationState {
  return {
    presetId: DEFAULT_PRESET_ID,
    lookId: DEFAULT_PRESET_ID,
    customColors: createDefaultCustomColors(),
  };
}

const DEFAULT_THEME_CUSTOMIZATION_STATE =
  createDefaultThemeCustomizationState();

let currentThemeCustomizationState = DEFAULT_THEME_CUSTOMIZATION_STATE;
let hasLoadedThemeCustomizationState = false;
const themeCustomizationListeners = new Set<() => void>();

function normalizePresetId(id: string | null): string {
  if (id === "custom") {
    return id;
  }

  return id && getPreset(id) ? id : DEFAULT_PRESET_ID;
}

function normalizeLookId(id: string | null): string {
  return id && getPreset(id) ? id : DEFAULT_PRESET_ID;
}

function readThemeCustomizationState(): ThemeCustomizationState {
  const stored = readStorage<StoredThemeColors>(STORAGE_CUSTOM_KEY);
  const defaults = createDefaultCustomColors();
  const presetId = normalizePresetId(localStorage.getItem(STORAGE_PRESET_KEY));

  return {
    presetId,
    lookId: presetId === "custom" ? normalizeLookId(localStorage.getItem(STORAGE_LOOK_KEY)) : presetId,
    customColors: stored ?? defaults,
  };
}

function getThemeCustomizationSnapshot(): ThemeCustomizationState {
  if (typeof window !== "undefined" && !hasLoadedThemeCustomizationState) {
    currentThemeCustomizationState = readThemeCustomizationState();
    hasLoadedThemeCustomizationState = true;
  }

  return currentThemeCustomizationState;
}

function getThemeCustomizationServerSnapshot(): ThemeCustomizationState {
  return DEFAULT_THEME_CUSTOMIZATION_STATE;
}

function emitThemeCustomizationChange(nextState?: ThemeCustomizationState) {
  if (typeof window === "undefined") {
    return;
  }

  hasLoadedThemeCustomizationState = true;
  currentThemeCustomizationState = nextState ?? readThemeCustomizationState();
  themeCustomizationListeners.forEach((listener) => listener());
}

function subscribeThemeCustomization(listener: () => void) {
  themeCustomizationListeners.add(listener);

  if (typeof window === "undefined") {
    return () => {
      themeCustomizationListeners.delete(listener);
    };
  }

  const handleStorage = (event: StorageEvent) => {
    if (
      event.key &&
      event.key !== STORAGE_PRESET_KEY &&
      event.key !== STORAGE_CUSTOM_KEY &&
      event.key !== STORAGE_LOOK_KEY
    ) {
      return;
    }

    emitThemeCustomizationChange();
  };

  window.addEventListener("storage", handleStorage);

  return () => {
    themeCustomizationListeners.delete(listener);
    window.removeEventListener("storage", handleStorage);
  };
}

/* 主题自定义 Provider */
export function ThemeCustomizationProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { resolvedTheme } = useTheme();
  const { presetId, lookId, customColors } = useSyncExternalStore(
    subscribeThemeCustomization,
    getThemeCustomizationSnapshot,
    getThemeCustomizationServerSnapshot,
  );

  /* 在主题或配色变化时同步风格标记和 CSS 变量；首帧脚本已经设过一次，这里负责之后的切换。 */
  useEffect(() => {
    const isDark = resolvedTheme === "dark";
    let colors: ThemeColors;

    document.documentElement.dataset.look = lookId;
    if (presetId === "custom") {
      colors = isDark ? customColors.dark : customColors.light;
      applyColors(colors);
    } else {
      const preset = getPreset(presetId) || THEME_PRESETS[0];
      colors = isDark ? preset.dark : preset.light;
      clearColors();
    }

    if (!resolvedTheme) return;
    let cancelSave = () => {};
    const timer = setTimeout(() => {
      cancelSave = saveLookToDesktop({
        look: lookId,
        dark: isDark,
        colors: {
          background: colors["--background"],
          foreground: colors["--foreground"],
          muted: colors["--color-muted"],
          accent: colors["--color-accent"],
          border: colors["--color-border"],
          surface: colors["--color-surface"],
        },
      });
    }, SAVE_LOOK_DELAY_MS);
    return () => { clearTimeout(timer); cancelSave(); };
  }, [resolvedTheme, presetId, lookId, customColors]);

  /* 对外操作 */
  const selectPreset = useCallback(
    (id: string) => {
      const nextPresetId = normalizePresetId(id);
      const nextLookId = nextPresetId === "custom" ? lookId : nextPresetId;

      try {
        localStorage.setItem(STORAGE_PRESET_KEY, nextPresetId);
        localStorage.setItem(STORAGE_LOOK_KEY, nextLookId);
      } catch {
        /* 忽略存储异常 */
      }

      emitThemeCustomizationChange({
        presetId: nextPresetId,
        lookId: nextLookId,
        customColors,
      });
    },
    [customColors, lookId],
  );

  const setCustomColors = useCallback((light: ThemeColors, dark: ThemeColors) => {
    const next = { light, dark };

    try {
      localStorage.setItem(STORAGE_PRESET_KEY, "custom");
      localStorage.setItem(STORAGE_LOOK_KEY, lookId);
    } catch {
      /* 忽略存储异常 */
    }

    writeStorage(STORAGE_CUSTOM_KEY, next);
    emitThemeCustomizationChange({
      presetId: "custom",
      lookId,
      customColors: next,
    });
  }, [lookId]);

  const value = useMemo(
    () => ({
      presetId,
      lookId,
      customLight: customColors.light,
      customDark: customColors.dark,
      selectPreset,
      setCustomColors,
    }),
    [presetId, lookId, customColors, selectPreset, setCustomColors],
  );

  return (
    <ThemeCustomizationContext.Provider value={value}>
      {children}
    </ThemeCustomizationContext.Provider>
  );
}
