import * as crypto from "node:crypto";

const FINGERPRINTED_ENV_KEYS = [
  "PRISM_USER_ID",
  "PRISM_STORAGE",
  "PRISM_STORAGE_BACKEND",
  "SUPABASE_URL",
  "SUPABASE_KEY",
  "SUPABASE_ANON_KEY",
  "PRISM_JWT_ISSUER",
  "PRISM_JWT_AUDIENCE",
  "PRISM_DASHBOARD_USER",
  "PRISM_DASHBOARD_PASS",
  "PRISM_DASHBOARD_ORIGIN",
  "PRISM_DASHBOARD_PORT",
  "PRISM_INSTANCE",
  "PRISM_HDC_ENABLED",
  "PRISM_ENABLE_HIVEMIND",
] as const;

export function computeConfigFingerprint(env: NodeJS.ProcessEnv = process.env): string {
  const parts = FINGERPRINTED_ENV_KEYS.map(key => `${key}=${env[key] ?? ""}`);
  return crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex");
}
