/**
 * Embedding failures on cloud memory, kept for this process. A save never waits for its embedding, so
 * a failure used to be logged where nobody saw it and the memory silently fell
 * out of semantic search. The count and the last reason are shown in
 * session_health_check, the dashboard and the next save's response.
 *
 * Only stores whose embeddings are server-metered record here (Synalux cloud
 * memory); other stores keep their existing behaviour.
 */
import { SynaluxEmbeddingRefusedError } from "./llm/adapters/synalux.js";

const MAX_REASON_CHARS = 160;

let pending = 0;
let lastReason: string | null = null;
/** The plan has no cloud embeddings: saves stop asking for the rest of the process. */
let planRefusal: string | null = null;

function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const oneLine = text.replace(/\s+/g, " ").trim() || "unknown error";
  return oneLine.length > MAX_REASON_CHARS ? `${oneLine.slice(0, MAX_REASON_CHARS - 1)}…` : oneLine;
}

/** A save's embedding failed; that memory is not in semantic search until repaired. */
export function recordEmbeddingFailure(error: unknown): void {
  if (error instanceof SynaluxEmbeddingRefusedError && error.code === "plan_not_eligible") {
    planRefusal = reasonOf(error);
    return;
  }
  pending += 1;
  lastReason = reasonOf(error);
}

/** Whether saves should ask for no embedding: the plan has none, and nothing can repair them. */
export function embeddingsRefusedForPlan(): boolean {
  return planRefusal !== null;
}

/**
 * The recorded failures are repaired: a run over every project left nothing failed,
 * or the server reports no memory without a vector. Also on storage close, so a
 * count never carries over to another account.
 */
export function clearEmbeddingFailures(): void {
  pending = 0;
  lastReason = null;
}

/** Storage closed (sign-out, account switch): forget everything recorded for it. */
export function resetEmbeddingHealth(): void {
  clearEmbeddingFailures();
  planRefusal = null;
}

export function embeddingFailures(): { pending: number; lastReason: string | null; planRefusal: string | null } {
  return { pending, lastReason, planRefusal };
}

/** The line a save's response carries while failures are pending, or "". */
export function embeddingFailureNotice(): string {
  if (planRefusal) return `⚠️ Semantic index unavailable: ${planRefusal}\n`;
  if (pending === 0) return "";
  return `⚠️ ${pending} ${pending === 1 ? "save" : "saves"} pending semantic index: ${lastReason}\n`;
}
