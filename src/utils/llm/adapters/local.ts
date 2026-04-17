import { getSettingSync } from "../../../storage/configStorage.js";
import { debugLog } from "../../logger.js";
import type { LLMProvider } from "../provider.js";

const EMBEDDING_DIMS = 768;
const MAX_EMBEDDING_CHARS = 8000;
const DEFAULT_MODEL = "nomic-ai/nomic-embed-text-v1.5";
const DEFAULT_REVISION = "main";
// MODEL_ID_PATTERN allows '.' in the name segment — the separate '..' check below
// handles directory traversal (e.g., "owner/foo..bar" passes the regex but is invalid).
const MODEL_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}\/[a-zA-Z0-9._-]{1,128}$/;
// Allowed: "main", 40-char commit SHA, semver tag like "v1.5" or "v1.5.0"
const REVISION_PATTERN = /^(main|[a-f0-9]{40}|v\d+(\.\d+){0,2})$/;

export class LocalEmbeddingAdapter implements LLMProvider {
  /** @internal Resolves once pipeline initialization completes. Callers and tests await this for readiness. */
  readonly loadPromise: Promise<void>;
  private pipe: ((text: string, opts: object) => Promise<unknown>) | null = null;
  private loadError: Error | null = null;

  constructor() {
    this.loadPromise = this.initPipeline();
  }

  async generateText(_prompt: string, _systemInstruction?: string): Promise<string> {
    throw new Error(
      "LocalEmbeddingAdapter does not support text generation. " +
      "It is an embedding-only provider. Configure a text provider in the Mind Palace dashboard."
    );
  }

  async generateEmbedding(text: string): Promise<number[]> {
    if (!text || !text.trim()) {
      throw new Error("[LocalEmbeddingAdapter] generateEmbedding called with empty text");
    }

    let inputText = text;
    if (inputText.length > MAX_EMBEDDING_CHARS) {
      inputText = inputText.substring(0, MAX_EMBEDDING_CHARS);
      const lastSpace = inputText.lastIndexOf(" ");
      if (lastSpace > 0) inputText = inputText.substring(0, lastSpace);
    }

    await this.loadPromise;

    if (this.loadError) throw this.loadError;
    if (!this.pipe) {
      throw new Error("[LocalEmbeddingAdapter] Pipeline not initialized and no load error recorded");
    }

    const result = await this.pipe(`search_document: ${inputText}`, { pooling: "mean", normalize: true });
    const tensorData = (result as { data?: Float32Array }).data;
    if (!tensorData || !(tensorData instanceof Float32Array)) {
      throw new Error(
        "[LocalEmbeddingAdapter] Unexpected pipeline output shape — expected { data: Float32Array }. " +
        "This may indicate an incompatible @huggingface/transformers version."
      );
    }
    const vec = Array.from(tensorData);

    if (vec.length !== EMBEDDING_DIMS) {
      throw new Error(
        `[LocalEmbeddingAdapter] Embedding dimension mismatch: expected ${EMBEDDING_DIMS}, got ${vec.length}. ` +
        `Check the local_embedding_model setting.`
      );
    }

    return vec;
  }

  private async initPipeline(): Promise<void> {
    const model = process.env.LOCAL_EMBEDDING_MODEL ?? getSettingSync("local_embedding_model", DEFAULT_MODEL);

    if (!MODEL_ID_PATTERN.test(model) || model.includes("..")) {
      this.loadError = new Error(
        `[LocalEmbeddingAdapter] Invalid local_embedding_model: "${model}". ` +
        `Must be a HuggingFace model ID in "owner/name" format.`
      );
      return;
    }

    const hfEndpoint = process.env.HF_ENDPOINT;
    if (hfEndpoint) {
      try {
        const parsed = new URL(hfEndpoint);
        const isTrusted = parsed.hostname === "huggingface.co" ||
                          parsed.hostname.endsWith(".huggingface.co");
        if (!isTrusted) {
          console.warn(
            `[LocalEmbeddingAdapter] HF_ENDPOINT hostname "${parsed.hostname}" is not huggingface.co — ` +
            `model downloads are redirected. Only set if you control and trust this server.`
          );
        }
      } catch {
        console.warn(`[LocalEmbeddingAdapter] HF_ENDPOINT is not a valid URL: "${hfEndpoint}". Ignoring.`);
      }
    }

    let transformers: typeof import("@huggingface/transformers");
    try {
      transformers = await import("@huggingface/transformers");
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.loadError = (e as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND"
        ? new Error(
            "[LocalEmbeddingAdapter] @huggingface/transformers is not installed. " +
            "Run: npm install @huggingface/transformers"
          )
        : e;
      return;
    }

    const quantized = getSettingSync("local_embedding_quantized", "true") !== "false";
    const dtype = quantized ? "q8" : "fp32";
    const revision = getSettingSync("local_embedding_revision", DEFAULT_REVISION);

    if (!REVISION_PATTERN.test(revision)) {
      this.loadError = new Error(
        `[LocalEmbeddingAdapter] Invalid local_embedding_revision: "${revision}". ` +
        `Allowed values: "main", a 40-char commit SHA, or a semver tag like "v1.5".`
      );
      return;
    }

    try {
      const pipelineInstance = await transformers.pipeline("feature-extraction", model, { dtype, revision } as Parameters<typeof transformers.pipeline>[2]);
      this.pipe = pipelineInstance as (text: string, opts: object) => Promise<unknown>;

      try {
        await this.pipe("warmup text", { pooling: "mean", normalize: true });
        debugLog(`[LocalEmbeddingAdapter] Pipeline ready and warmed up: ${model} (${dtype})`);
      } catch (warmupErr) {
        const we = warmupErr instanceof Error ? warmupErr : new Error(String(warmupErr));
        console.warn(
          `[LocalEmbeddingAdapter] Warmup failed (non-fatal): ${we.message}. ` +
          `First embedding call may be slightly slower.`
        );
      }
    } catch (err) {
      this.loadError = err instanceof Error ? err : new Error(String(err));
      console.error(`[LocalEmbeddingAdapter] Failed to load pipeline: ${this.loadError.message}`);
    }
  }
}
