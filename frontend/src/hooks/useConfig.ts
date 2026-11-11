"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { ApiRequestError, apiGet, apiPost, apiPut } from "@/lib/api";
import {
  buildConfigSavePayload,
  normalizeAppConfig,
  type AppConfig,
  type AppConfigSavePayload,
  type ProviderRenameOperation,
} from "@/types/config";

interface ConfigState {
  config: AppConfig | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  success: string | null;
  conflict: boolean;
}

export interface CCSwitchImportResult {
  data: AppConfig;
  imported_aliases: string[];
  imported_count: number;
  duplicate_count: number;
  skipped_count: number;
  warnings: string[];
}

export function useConfig() {
  const originalConfig = useRef<AppConfig | null>(null);
  const [pendingProviderRenames, setPendingProviderRenames] = useState<ProviderRenameOperation[]>([]);
  const [state, setState] = useState<ConfigState>({
    config: null,
    loading: true,
    saving: false,
    error: null,
    success: null,
    conflict: false,
  });

  const clearMessages = useCallback(() => {
    setState((s) => ({ ...s, error: null, success: null }));
  }, []);

  const fetchConfig = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null, conflict: false }));
    try {
      const res = await apiGet<{ data: AppConfig }>("/api/config");
      const normalized = normalizeAppConfig(res.data);
      originalConfig.current = normalized;
      setPendingProviderRenames([]);
      setState((s) => ({
        ...s,
        config: normalized,
        loading: false,
      }));
      return normalized;
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : "Unknown error",
      }));
      return null;
    }
  }, []);

  const saveConfig = useCallback(
    async (data: AppConfig, successMsg: string, validate?: (payload: AppConfigSavePayload) => string | null) => {
      if (!originalConfig.current) return false;
      setState((s) => ({ ...s, saving: true, error: null, success: null, conflict: false }));
      try {
        const payload: AppConfigSavePayload = buildConfigSavePayload(
          data,
          originalConfig.current,
          pendingProviderRenames
        );
        const validationError = validate?.(payload);
        if (validationError) {
          setState((s) => ({ ...s, saving: false, error: validationError }));
          return false;
        }
        if (Object.keys(payload.patch).length === 0) {
          setState((s) => ({ ...s, saving: false, success: successMsg }));
          return true;
        }
        const res = await apiPut<{ message: string; data: AppConfig }>(
          "/api/config",
          payload
        );
        const normalized = normalizeAppConfig(res.data);
        originalConfig.current = normalized;
        window.dispatchEvent(new CustomEvent("app-config-saved", { detail: normalized }));
        setPendingProviderRenames([]);
        setState((s) => ({
          ...s,
          config: normalized,
          saving: false,
          success: successMsg,
          conflict: false,
        }));
        return true;
      } catch (err) {
        setState((s) => ({
          ...s,
          saving: false,
          error: err instanceof Error ? err.message : "Unknown error",
          conflict: err instanceof ApiRequestError && err.status === 409,
        }));
        return false;
      }
    },
    [pendingProviderRenames]
  );

  const importCCSwitch = useCallback(async (sourcePath?: string): Promise<CCSwitchImportResult | null> => {
    if (!originalConfig.current || !state.config || state.saving) return null;
    setState((s) => ({ ...s, saving: true, error: null, success: null, conflict: false }));
    try {
      const result = await apiPost<CCSwitchImportResult>("/api/config/llm-providers/import-cc-switch", {
        expected_config_version: originalConfig.current.config_version,
        source_path: sourcePath?.trim() || null,
        reserved_aliases: Object.keys(state.config.llm.providers),
      });
      const normalized = normalizeAppConfig(result.data);
      originalConfig.current = normalized;
      const additions = Object.fromEntries(result.imported_aliases.map((alias) => [alias, normalized.llm.providers[alias]]));
      // Only the newly saved providers enter the draft; unsaved fields, secret
      // replacement actions, removals and pending renames keep their exact state.
      setState((s) => ({
        ...s,
        config: s.config ? {
          ...s.config, config_version: normalized.config_version,
          llm: { ...s.config.llm, providers: { ...s.config.llm.providers, ...additions } },
        } : normalized,
        saving: false,
        success: [
          result.imported_count ? `已从 CC Switch 导入并保存 ${result.imported_count} 个 API。` : "没有新增 API。",
          result.duplicate_count ? `${result.duplicate_count} 个相同配置已跳过。` : "",
          ...result.warnings,
        ].filter(Boolean).join(" "),
      }));
      window.dispatchEvent(new CustomEvent("app-config-saved", { detail: normalized }));
      return result;
    } catch (err) {
      setState((s) => ({ ...s, saving: false,
        error: err instanceof Error ? err.message : "CC Switch 导入失败",
        conflict: err instanceof ApiRequestError && err.status === 409,
      }));
      return null;
    }
  }, [state.config, state.saving]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  return {
    ...state,
    fetchConfig,
    saveConfig,
    importCCSwitch,
    queueProviderRename: (rename: ProviderRenameOperation) =>
      setPendingProviderRenames((current) => [...current, rename]),
    setConfig: (config: AppConfig) =>
      setState((s) => ({ ...s, config })),
    clearMessages,
  };
}
