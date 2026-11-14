/**
 * Embedding failures on cloud memory, kept for this process. A save never waits for its embedding, so
 * a failure used to be logged where nobody saw it and the memory silently fell
 * out of semantic search. The count and the last reason are shown in
 * session_health_check, the dashboard and the next save's response.
 *
 * Only stores whose embeddings are server-metered record here (Synalux cloud
 * memory); other stores keep their existing behaviour.
 */
const MAX_REASON_CHARS = 160;

let pending = 0;
let lastReason: string | null = null;

function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const oneLine = text.replace(/\s+/g, " ").trim() || "unknown error";
  return oneLine.length > MAX_REASON_CHARS ? `${oneLine.slice(0, MAX_REASON_CHARS - 1)}…` : oneLine;
}

/** A save's embedding failed; that memory is not in semantic search until repaired. */
export function recordEmbeddingFailure(error: unknown): void {
  pending += 1;
  lastReason = reasonOf(error);
}

/** A repair run left nothing failed: the recorded failures are repaired. */
export function clearEmbeddingFailures(): void {
  pending = 0;
  lastReason = null;
}

export function embeddingFailures(): { pending: number; lastReason: string | null } {
  return { pending, lastReason };
}

/** The line a save's response carries while failures are pending, or "". */
export function embeddingFailureNotice(): string {
  if (pending === 0) return "";
  return `⚠️ ${pending} ${pending === 1 ? "save" : "saves"} pending semantic index: ${lastReason}\n`;
}
