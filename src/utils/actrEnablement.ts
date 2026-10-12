import { getSettingSync } from "../storage/configStorage.js";

const SETTING_KEY = "PRISM_ACTR_ENABLED";
const DEFAULT_ENABLED = true;
export const ACTR_SETTINGS_UNAVAILABLE = "Automatic memory ranking settings unavailable. Retry when the server is reachable.";
export const ACTR_UI = {
  label: "Automatic Memory Ranking (ACT-R)",
  description: "Rank retrieved memories by relevance, recency, frequency and associations. Enabled by default. Restart your AI client after changing this setting.",
  loading: "Loading ranking state…",
};
let startupDecision: boolean | undefined;

export function resolveActrEnabled(env: string | undefined, saved: string | undefined): boolean {
  if (env === "true" || env === "false") return env === "true";
  return saved === "true" || saved === "false" ? saved === "true" : DEFAULT_ENABLED;
}

export function initializeActrEnabled(): boolean {
  startupDecision = resolveActrEnabled(process.env.PRISM_ACTR_ENABLED, getSettingSync(SETTING_KEY, String(DEFAULT_ENABLED)));
  return startupDecision;
}

export function isActrEnabled(): boolean {
  return startupDecision ?? initializeActrEnabled();
}

export function actrEnablementState() {
  const env = process.env.PRISM_ACTR_ENABLED;
  const envOverride = env === "true" || env === "false" ? env === "true" : null;
  const saved = resolveActrEnabled(undefined, getSettingSync(SETTING_KEY, String(DEFAULT_ENABLED)));
  const active = isActrEnabled();
  return { saved, active, envOverride, pendingRestart: envOverride === null && saved !== active };
}
