"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { apiGet } from "@/lib/api";
import type { AppConfig, ProviderConfig } from "@/types/config";

// 各类服务可用的思考强度，与设置页的 ReasoningControls 保持一致；空字符串表示沿用供应商默认值。
const EFFORTS: Record<ProviderConfig["type"], string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  gemini: ["minimal", "low", "medium", "high"],
  deepseek: ["none", "low", "high", "max"],
  openai: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
};
const ALL_EFFORTS = EFFORTS.openai;
const NAMES: Record<string, [string, string]> = {
  none: ["关闭思考", "Off"], minimal: ["极低", "Minimal"], low: ["低", "Low"], medium: ["中", "Medium"],
  high: ["高", "High"], xhigh: ["超高", "Extra high"], max: ["最大", "Max"],
};
const CONTROL = "min-h-10 w-full min-w-0 rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground disabled:opacity-60";

/** 旧设置里没有这个字段：原来开着审查的沿用为“审查到通过为止”，原来关闭审查（0 轮）的保持关闭。 */
export const untilPassFrom = (saved: unknown, rounds: number): boolean => typeof saved === "boolean" ? saved : rounds > 0;
/** 读出保存的思考强度；不认识的值当作“沿用默认”。 */
export const effortFrom = (saved: unknown): string => typeof saved === "string" && ALL_EFFORTS.includes(saved) ? saved : "";

/** 请求里与“怎么想、怎么审”有关的字段；思考强度留空时不发送，沿用供应商默认值。 */
export function agentRequestOptions(value: { rounds: number; untilPass: boolean; effort: string; deslop?: boolean }) {
  return { review_rounds: value.rounds, review_until_pass: value.untilPass, deslop: value.deslop === true, ...(value.effort ? { reasoning_effort: value.effort } : {}) };
}

/** Claude Code 去AI味：正文写完、审完后，按 oh-story 的 story-deslop 方法再改一轮。 */
export function DeslopToggle({ checked, onChange, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  const zh = useLocale() !== "en";
  return <label className="flex items-start gap-2 text-xs"><input type="checkbox" data-testid="agent-deslop" className="mt-0.5" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    <span>{zh ? "附加去AI味（Claude Code 方法）" : "Extra cleanup (Claude Code method)"}<span className="block text-muted">{zh
      ? "写作流程结束后，用当前模型按 story-deslop 方法局部修改，最多三轮。若只想去痕、不使用写作流程和偏好，请打开左侧独立的「AI 去痕」页面，可单独选择 Claude 模型。"
      : "After writing, applies the story-deslop method with the current model, up to 3 passes. For cleanup alone without writing workflows or preferences, open Prose cleanup in the sidebar and choose its model independently."}</span></span>
  </label>;
}

/** Ctrl/⌘ + Enter 提交；输入法正在组字时的回车不算。 */
export const isSubmitShortcut = (event: { key: string; ctrlKey: boolean; metaKey: boolean; nativeEvent: { isComposing?: boolean } }) =>
  event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing;

/** 每次生成单独选择的思考强度；选项随所选供应商的类型变化，切换供应商后不适用的取值会自动改回“沿用默认”。 */
export function EffortSelect({ value, onChange, provider, disabled = false, testId = "agent-effort" }: {
  value: string; onChange: (value: string) => void; provider: string; disabled?: boolean; testId?: string;
}) {
  const zh = useLocale() !== "en";
  const [config, setConfig] = useState<AppConfig | null>(null);
  useEffect(() => {
    let current = true;
    void apiGet<{ data: AppConfig }>("/api/config").then(({ data }) => { if (current) setConfig(data); }).catch(() => undefined);
    const changed = (event: Event) => setConfig((event as CustomEvent<AppConfig>).detail);
    window.addEventListener("app-config-saved", changed);
    return () => { current = false; window.removeEventListener("app-config-saved", changed); };
  }, []);
  const alias = provider || config?.llm.default_provider || "";
  const type = config?.llm.providers[alias]?.type;
  const options = type ? EFFORTS[type] : ALL_EFFORTS;
  useEffect(() => {
    if (type && value && !EFFORTS[type].includes(value)) onChange("");
  }, [type, value, onChange]);
  const name = (key: string) => NAMES[key]?.[zh ? 0 : 1] ?? key;
  return <label className="grid min-w-0 gap-1 text-xs text-muted">
    <span>{zh ? "思考强度" : "Thinking effort"}</span>
    <select data-testid={testId} aria-label={zh ? "思考强度" : "Thinking effort"} className={CONTROL} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      <option value="">{zh ? "跟随供应商默认" : "Provider default"}</option>
      {options.map((key) => <option key={key} value={key}>{name(key)}</option>)}
    </select>
    <span>{zh ? "越高越慢，也越费 token；简单任务选低一些更快。" : "Higher is slower and uses more tokens."}</span>
  </label>;
}

/** 审查方式：关闭（0 轮）、固定 1–5 轮，或审查到通过为止。轮数下拉框保持原样，勾选“审查到通过为止”后由智能体自己判断何时结束。 */
export function ReviewModeControls({ rounds, untilPass, onChange, disabled = false, label, ariaLabel, selectClassName = CONTROL, wrapperClassName = "grid gap-1 text-xs text-muted" }: {
  rounds: number; untilPass: boolean; onChange: (patch: { rounds?: number; untilPass?: boolean }) => void; disabled?: boolean;
  label: string; ariaLabel: string; selectClassName?: string; wrapperClassName?: string;
}) {
  const zh = useLocale() !== "en";
  return <div className="grid min-w-0 gap-2">
    <label className={wrapperClassName}><span>{label}</span>
      <select aria-label={ariaLabel} className={selectClassName} value={rounds} disabled={disabled || untilPass} onChange={(event) => onChange({ rounds: Number(event.target.value) })}>
        {[0, 1, 2, 3, 4, 5].map((count) => <option key={count} value={count}>{count}</option>)}
      </select>
    </label>
    <label className="flex items-start gap-2 text-xs"><input type="checkbox" data-testid="agent-until-pass" className="mt-0.5" checked={untilPass} disabled={disabled} onChange={(event) => onChange({ untilPass: event.target.checked })} />
      <span>{zh ? "审查到通过为止" : "Review until it passes"}<span className="block text-muted">{zh ? "不限轮数：不达标就继续修改再审，审查连续没有进步时由智能体收尾。" : "No round cap. Keeps revising and reviewing; stops when scores stop improving."}</span></span>
    </label>
  </div>;
}
