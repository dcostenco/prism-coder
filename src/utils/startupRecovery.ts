const RECOVERABLE_STARTUP_STORAGE_ERROR =
  /(?:rate limit|(?:HTTP|status)\s*(?:408|425|429|5\d{2})\b|network error|fetch failed|timed?\s*out|timeout|ECONN(?:RESET|REFUSED)|ENOTFOUND|EAI_AGAIN|socket hang up)/i;
const RECOVERABLE_ENTITLEMENT_PROBE_ERROR =
  /\[Prism Storage\]\s+Could not verify the Synalux cloud-memory entitlement\b/i;

export const LOCAL_STARTUP_FALLBACK_NOTICE =
  "⚠️ Synalux cloud context is temporarily unavailable; showing local last-good context for this startup only.";

/**
 * Startup may degrade to the local last-good snapshot only for transient
 * storage failures. Validation, formatting, and programmer errors must still
 * fail loud instead of being hidden by an unrelated fallback.
 */
export function isRecoverableStartupStorageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return RECOVERABLE_STARTUP_STORAGE_ERROR.test(message)
    || RECOVERABLE_ENTITLEMENT_PROBE_ERROR.test(message);
}
