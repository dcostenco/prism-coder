import { PRISM_DEBUG_LOGGING } from "../config.js";

/**
 * Sanitize a string for safe logging — strips control characters,
 * newlines, and ANSI escape sequences that could be used for log
 * injection or terminal escape attacks.
 */
export function sanitizeForLog(msg: string): string {
  return msg
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")  // control chars (keep \n \r \t)
    .replace(/\r?\n/g, " ⏎ ")                              // newlines → visible marker
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");               // ANSI escape sequences
}

/**
 * Logs a message to stderr only if PRISM_DEBUG_LOGGING is true.
 * Input is sanitized to prevent log injection attacks.
 */
export function debugLog(message: string) {
  if (PRISM_DEBUG_LOGGING) {
    const safe = sanitizeForLog(message);
    console.error(safe);
  }
}
