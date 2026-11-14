/** Thin embedding client. Synalux owns credentials, live tier checks, and quota. */
import { resolvePortalBaseUrl } from "../../synaluxSearch.js";
import { getSynaluxJwt, invalidateSynaluxJwt } from "../../synaluxJwt.js";
import type { LLMProvider } from "../provider.js";

const MODEL = "gemini-embedding-001";
const DIMENSIONS = 768;
const TASK_TYPE = "SEMANTIC_SIMILARITY";
const MAX_CHARS = 8_000;
const MIN_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;

type Sleep = (delayMs: number) => Promise<void>;

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

function retryDelayMs(header: string | null): number {
  let delayMs = MIN_RETRY_DELAY_MS;
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) {
      delayMs = seconds * 1_000;
    } else {
      const retryAt = Date.parse(header);
      if (Number.isFinite(retryAt)) delayMs = retryAt - Date.now();
    }
  }
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(MIN_RETRY_DELAY_MS, Math.ceil(delayMs)));
}

function truncateAtWordBoundary(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_CHARS) return trimmed;
  const bounded = trimmed.slice(0, MAX_CHARS);
  const boundary = bounded.lastIndexOf(" ");
  return boundary > 0 ? bounded.slice(0, boundary) : bounded;
}

/** The Portal's 403 codes for embeddings. */
export type EmbeddingRefusalCode = "embedding_daily_allowance" | "plan_not_eligible";

/**
 * The Portal refused the embedding: the day's allowance is used, or the plan has
 * no cloud memory. Not retried; repair loops stop on it.
 */
export class SynaluxEmbeddingRefusedError extends Error {
  constructor(readonly code: EmbeddingRefusalCode | null, readonly resetAt: string | null) {
    super(code === "embedding_daily_allowance"
      ? `Synalux embedding allowance used for today${resetAt ? ` (resets ${resetAt})` : ""}`
      : code === "plan_not_eligible"
        ? "Embeddings are not included in this Synalux plan"
        : "Synalux embedding request refused (HTTP 403)");
    this.name = "SynaluxEmbeddingRefusedError";
  }
}

async function refusal(response: Response): Promise<SynaluxEmbeddingRefusedError> {
  type RefusalBody = { code?: unknown; reset_at?: unknown };
  const body: RefusalBody = await response.json().then((b: unknown) => (b && typeof b === "object" ? b as RefusalBody : {}), () => ({}));
  const code: EmbeddingRefusalCode | null = body.code === "embedding_daily_allowance" || body.code === "plan_not_eligible" ? body.code : null;
  const resetAt = typeof body.reset_at === "string" && Number.isFinite(Date.parse(body.reset_at)) ? body.reset_at : null;
  return new SynaluxEmbeddingRefusedError(code, code === "embedding_daily_allowance" ? resetAt : null);
}

export class SynaluxEmbeddingAdapter implements LLMProvider {
  constructor(private readonly sleep: Sleep = defaultSleep) {}

  async generateText(): Promise<string> {
    throw new Error("SynaluxEmbeddingAdapter is embedding-only");
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const input = truncateAtWordBoundary(text);
    if (!input) throw new Error("Cannot embed empty text");

    const configuredBase = resolvePortalBaseUrl();
    if (!configuredBase) throw new Error("Synalux embedding origin is not configured");
    const base = configuredBase.replace(/\/+$/, "");
    let authRetried = false;
    let rateRetried = false;

    while (true) {
      const jwt = await getSynaluxJwt();
      if (!jwt) throw new Error("Synalux authentication unavailable for embeddings");

      const response = await fetch(`${base}/api/v1/prism/embeddings`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(35_000),
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: input }),
      });

      if (response.status === 401 && !authRetried) {
        authRetried = true;
        invalidateSynaluxJwt();
        continue;
      }
      if (response.status === 429 && !rateRetried) {
        rateRetried = true;
        await this.sleep(retryDelayMs(response.headers.get("Retry-After")));
        continue;
      }
      if (response.status === 403) throw await refusal(response);
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error("Synalux embedding endpoint is not deployed yet");
        }
        throw new Error(`Synalux embedding request failed (HTTP ${response.status})`);
      }

      const data = await response.json();
      const values: unknown = data?.embedding;
      if (
        data?.model !== MODEL
        || data?.dimensions !== DIMENSIONS
        || data?.task_type !== TASK_TYPE
        || !Array.isArray(values)
        || values.length !== DIMENSIONS
        || !values.every(value => typeof value === "number" && Number.isFinite(value))
        || !values.some(value => value !== 0)
      ) {
        throw new Error("Synalux returned an incompatible embedding response");
      }
      return values;
    }
  }
}
