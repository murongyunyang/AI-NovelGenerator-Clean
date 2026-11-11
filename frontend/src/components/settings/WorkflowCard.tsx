"use client";

import { FLOW_INPUT_CLASS } from "@/components/task-flows/TaskFlowForm";
import { supportsStructuredOutput, type AppConfig } from "@/types/config";
import { useLocale,useTranslations } from "next-intl";

interface Props {
  config: AppConfig;
  onChange: (config: AppConfig) => void;
}

/**
 * 配置全局模型、格式审校及故障修复。
 * Args:
 *   config: 尚未保存的设置草稿。
 *   onChange: 仅更新设置草稿，保存仍由设置页负责。
 * Returns:
 *   公共模型与修复设置。
 */
export function WorkflowCard({ config, onChange }: Props) {
  const t = useTranslations("settings.workflow");
  const locale = useLocale();
  const providers = config.llm.providers ?? {};
  return (
    <section
      aria-labelledby="workflow-settings-title"
      className="flex min-h-0 flex-col bg-surface lg:h-full lg:overflow-hidden"
    >
      <header className="shrink-0 border-b border-border px-4 py-3 sm:px-6">
        <h2 id="workflow-settings-title" className="text-lg font-semibold">
          {t("title")}
        </h2>
      </header>
      <div className="workspace-scrollbar min-h-0 flex-1 overflow-auto px-4 py-5 sm:px-6">
        <div className="grid gap-5 md:grid-cols-2">
          <label className="grid gap-2 text-xs font-medium text-muted">
            {t("globalDefaultProvider")}
            <select
              className={FLOW_INPUT_CLASS}
              value={config.llm.default_provider ?? ""}
              onChange={(event) =>
                onChange({
                  ...config,
                  llm: { ...config.llm, default_provider: event.target.value },
                })
              }
            >
              <option value="">{t("noGlobalDefault")}</option>
              {config.llm.default_provider &&
                !providers[config.llm.default_provider] && (
                  <option value={config.llm.default_provider} disabled>
                    {config.llm.default_provider}
                  </option>
                )}
              {Object.entries(providers).map(([alias, provider]) => (
                <option key={alias} value={alias} disabled={!provider.enabled}>
                  {alias}
                  {!provider.enabled ? ` · ${t("providerDisabledShort")}` : ""}
                </option>
              ))}
            </select>
            {config.llm.default_provider &&
              !providers[config.llm.default_provider] && (
                <span role="alert" className="text-danger">
                  {t("providerNotExist")}
                </span>
              )}
          </label>
          <label className="grid gap-2 text-xs font-medium text-muted">
            {t("formatReviewProvider")}
            <select
              className={FLOW_INPUT_CLASS}
              value={config.llm.format_review_provider ?? ""}
              onChange={(event) =>
                onChange({
                  ...config,
                  llm: {
                    ...config.llm,
                    format_review_provider: event.target.value,
                  },
                })
              }
            >
              <option value="">{t("globalDefault")}</option>
              {config.llm.format_review_provider &&
                !providers[config.llm.format_review_provider] && (
                  <option value={config.llm.format_review_provider} disabled>
                    {config.llm.format_review_provider}
                  </option>
                )}
              {Object.entries(providers).map(([alias, provider]) => (
                <option
                  key={alias}
                  value={alias}
                  disabled={
                    !provider.enabled ||
                    !supportsStructuredOutput(provider)
                  }
                >
                  {alias}
                  {!provider.enabled ? ` · ${t("providerDisabledShort")}` : ""}
                </option>
              ))}
            </select>
            {config.llm.format_review_provider &&
              !providers[config.llm.format_review_provider] && (
                <span role="alert" className="text-danger">
                  {t("providerNotExist")}
                </span>
              )}
          </label>
        </div>
        <div className="mt-5 grid gap-4 rounded-xl border border-border p-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={config.llm.auto_repair_enabled ?? true}
              onChange={e => onChange({...config, llm: {...config.llm, auto_repair_enabled: e.target.checked}})} />
            {locale === "en" ? "Automatically repair failed tools and workflow nodes" : "工具或工作流节点失败时自动修复"}
          </label>
          <label className="grid gap-2 text-xs text-muted">
            {locale === "en" ? "Repair provider" : "专用修复模型服务"}
            <select className={FLOW_INPUT_CLASS} value={config.llm.repair_provider ?? ""}
              onChange={e => onChange({...config, llm: {...config.llm, repair_provider: e.target.value, repair_model: ""}})}>
              <option value="">{t("globalDefault")}</option>
              {Object.entries(providers).map(([alias, provider]) => <option key={alias} value={alias} disabled={!provider.enabled}>{alias}</option>)}
            </select>
          </label>
          <label className="grid gap-2 text-xs text-muted">
            {locale === "en" ? "Repair model ID (empty uses provider default)" : "修复模型 ID（留空使用服务默认模型）"}
            <input className={FLOW_INPUT_CLASS} value={config.llm.repair_model ?? ""}
              onChange={e => onChange({...config, llm: {...config.llm, repair_model: e.target.value}})} />
          </label>
          <p className="text-xs leading-5 text-muted">{locale === "en"
            ? "Retry failed operations with a bounded repair budget. Repair calls consume tokens. Permissions and task budgets remain in effect."
            : "失败后由修复模型介入，最多修复重试三次，仍失败则返回任务处理。修复调用会消耗模型额度；资料权限和任务预算仍然有效。"}</p>
        </div>

      </div>
    </section>
  );
}
