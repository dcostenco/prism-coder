/**
 * One definition of "never send this over plaintext".
 *
 * This lived inside storage/index.ts, so only the storage path applied it. When
 * startup hydration began publishing PRISM_SYNALUX_BASE_URL from the settings
 * store, it bypassed the control entirely: a self-hosted portal stored as
 * `http://portal.internal.example` was published unchanged, and the search
 * client then POSTed the query plus `Authorization: Bearer <JWT>` to it in the
 * clear. Measured 2026-09-16.
 *
 * Loopback is exempt because there is no network to intercept.
 */
import { debugLog } from "./logger.js";

export function upgradeInsecureCloudUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:") return raw;
    const host = parsed.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return raw;
    parsed.protocol = "https:";
    const upgraded = parsed.toString().replace(/\/+$/, "");
    debugLog(`[Prism] Upgraded ${raw} to ${upgraded}: content is never sent over plaintext to a remote host.`);
    return upgraded;
  } catch {
    return raw;
  }
}
