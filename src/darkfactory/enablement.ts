import { getSettingSync } from "../storage/configStorage.js";

const SETTING_KEY = "PRISM_DARK_FACTORY_ENABLED";
const DEFAULT_ENABLED = true;
export const DARK_FACTORY_TOOL_NAMES = ["session_start_pipeline", "session_check_pipeline_status", "session_abort_pipeline"] as const;
export const DARK_FACTORY_SETTINGS_UNAVAILABLE = "Factory startup settings unavailable. Retry when the server is reachable.";
let startupDecision: boolean | undefined;

export function resolveDarkFactoryEnabled(env: string | undefined, saved: string | undefined): boolean {
  if (env === "true" || env === "false") return env === "true";
  return saved === "true" || saved === "false" ? saved === "true" : DEFAULT_ENABLED;
}

/** Freeze one enablement decision for tool registration, dispatch, and runner startup. */
export function initializeDarkFactoryEnabled(): boolean {
  const env = process.env.PRISM_DARK_FACTORY_ENABLED;
  startupDecision = resolveDarkFactoryEnabled(env, getSettingSync(SETTING_KEY, String(DEFAULT_ENABLED)));
  return startupDecision;
}

export function isDarkFactoryEnabled(): boolean {
  return startupDecision ?? initializeDarkFactoryEnabled();
}

export function buildDarkFactoryEnablementState(saved: boolean, active: boolean, env: string | undefined) {
  const envOverride = env === "true" || env === "false" ? env === "true" : null;
  return { saved, active, envOverride, pendingRestart: envOverride === null && saved !== active };
}

export function darkFactoryEnablementState(): {
  saved: boolean;
  active: boolean;
  envOverride: boolean | null;
  pendingRestart: boolean;
} {
  const env = process.env.PRISM_DARK_FACTORY_ENABLED;
  const saved = resolveDarkFactoryEnabled(undefined, getSettingSync(SETTING_KEY, String(DEFAULT_ENABLED)));
  return buildDarkFactoryEnablementState(saved, isDarkFactoryEnabled(), env);
}
