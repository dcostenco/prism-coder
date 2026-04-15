# Local Embeddings via transformers.js — Design Spec

**Date:** 2026-04-14
**Status:** Draft → in implementation
**Author:** Gerald Onyango (via Claude)
**Scope:** `prism-mcp` fork (`futuregerald/prism-mcp`)

---

## 1. Problem

Prism currently generates embeddings for semantic memory search via four cloud / API-driven adapters (`gemini`, `openai`, `anthropic` (auto-bridged), `voyage`). Every embedding write costs an outbound HTTPS call, an API quota slot, and (for keyless self-hosters) a hard dependency on third-party services being reachable.

We want a **fully local embedding path** so Prism can:

- Run with zero API keys configured (truly offline / air-gapped friendly).
- Avoid leaking session memory text to third parties for users who want it.
- Let the existing `auto` resolution silently degrade to local instead of crashing when no API keys exist.

---

## 2. Goals & Non-Goals

**Goals**

1. Add a `LocalEmbeddingAdapter` that satisfies the existing `LLMProvider` interface for the embedding half (text generation explicitly unsupported, mirroring `VoyageAdapter`).
2. Use [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) to run [`Xenova/nomic-embed-text-v1.5`](https://huggingface.co/Xenova/nomic-embed-text-v1.5) (q8 quantized ONNX) locally via onnxruntime-node.
3. Output exactly **768-dim** vectors so existing storage schemas, TurboQuant compression, and SDM cognitive engine work unchanged.
4. Activate via two paths:
   - Explicit: `embedding_provider=local`
   - Implicit: `embedding_provider=auto` AND text adapter construction fails (no API keys) → fall through to Local for embeddings + a `DisabledTextAdapter` for text.
5. Ship transformers.js as an **optional peer dependency** so users who don't want it pay zero install cost.
6. Background-load the model at server startup; never block server boot.
7. Server stays up even if local model can't be loaded — embedding calls throw with actionable errors.

**Non-Goals**

- Local text generation (no Phi/Llama/Mistral). This adapter is embedding-only.
- Schema migrations or making embedding dimension configurable. We commit to 768 dims permanently.
- Dashboard UI changes for the new provider. Deferred to a follow-up PR.
- GPU acceleration. CPU-only via WASM/onnxruntime-node. Performance is sufficient for Prism's bursty write workload.
- Multiple concurrent local model variants. One model loaded per process.
- Distinguishing query vs. document embeddings (nomic supports `search_query: ` vs `search_document: ` prefixes). The `LLMProvider` interface has a single method; we use `search_document: ` for everything. Recall hit on query-side is ~1-2% per nomic's own benchmarks. Documented as a follow-up if it becomes load-bearing.

---

## 3. Architecture

### 3.1 New files

```
src/utils/llm/adapters/local.ts          # LocalEmbeddingAdapter
src/utils/llm/adapters/disabledText.ts   # DisabledTextAdapter (text-side stub)
tests/llm/local.test.ts                  # Adapter unit tests
```

### 3.2 Modified files

```
src/utils/llm/factory.ts                 # New "local" case + auto-fallback path
package.json                             # Add @huggingface/transformers as optional peer dep
tests/llm/factory.test.ts                # New routing + fallback tests
```

### 3.3 LocalEmbeddingAdapter contract

```ts
class LocalEmbeddingAdapter implements LLMProvider {
  private loadPromise: Promise<void> | null = null;
  private pipeline: FeatureExtractionPipeline | null = null;
  private loadError: Error | null = null;

  constructor() {
    // Read settings, kick off background load. Returns immediately.
    this.loadPromise = this.initPipeline();
  }

  async generateText(): Promise<string> {
    throw new Error(
      "LocalEmbeddingAdapter does not support text generation. " +
      "It is an embedding-only provider. " +
      "Set text_provider to 'gemini', 'openai', or 'anthropic' in the dashboard."
    );
  }

  async generateEmbedding(text: string): Promise<number[]> {
    // 1. Empty/whitespace guard
    // 2. Truncate to MAX_EMBEDDING_CHARS (8000) with word-boundary snap
    // 3. await loadPromise; throw loadError if set
    // 4. Run pipeline with "search_document: " prefix, mean pooling, L2 normalize
    // 5. Convert Tensor → number[]
    // 6. Hard 768-dim guard → throw on mismatch
  }

  // No generateImageDescription
}
```

### 3.4 Background pipeline init

```ts
private async initPipeline(): Promise<void> {
  let transformers: typeof import("@huggingface/transformers");
  try {
    transformers = await import("@huggingface/transformers");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ERR_MODULE_NOT_FOUND") {
      this.loadError = new Error(
        "Local embeddings require @huggingface/transformers. " +
        "Run: npm install @huggingface/transformers"
      );
      return;
    }
    this.loadError = err as Error;
    return;
  }

  try {
    const model = getSettingSync("local_embedding_model", DEFAULT_MODEL);
    const quantized = getSettingSync("local_embedding_quantized", "true") !== "false";
    this.pipeline = await transformers.pipeline("feature-extraction", model, {
      quantized,
      // dtype: quantized ? "q8" : "fp32",  // newer API; fall back to {quantized} if unavailable
    });
    // Warmup forces ONNX session init so the first real call isn't slow
    await this.pipeline("warmup", { pooling: "mean", normalize: true });
    debugLog(`[LocalEmbeddingAdapter] Pipeline ready: ${model}`);
  } catch (err) {
    this.loadError = err as Error;
  }
}
```

### 3.5 Factory wiring

`buildEmbeddingAdapter()` gains a `"local"` case:

```ts
function buildEmbeddingAdapter(type: string): LLMProvider {
  switch (type) {
    case "openai": return new OpenAIAdapter();
    case "voyage": return new VoyageAdapter();
    case "local":  return new LocalEmbeddingAdapter();
    case "gemini":
    default:       return new GeminiAdapter();
  }
}
```

The `getLLMProvider()` resolution adds an auto-fallback path. **Critically, the fallback only triggers when the user did not explicitly choose providers** — i.e. when the *original* `embedding_provider` setting was `"auto"`. If a user explicitly set `embedding_provider=voyage` and Voyage construction throws, we surface the error rather than silently overriding their choice.

The factory must preserve the *original* setting (before `"auto"` was resolved to a concrete provider name) to know whether the auto-fallback path is allowed. Implementation captures it in a local `originalEmbedSetting` variable.

```ts
const textType = getSettingSync("text_provider", "gemini");
const originalEmbedSetting = getSettingSync("embedding_provider", "auto");
let embedType = originalEmbedSetting;

if (embedType === "auto") {
  // ...existing anthropic→gemini auto-bridge logic...
}

try {
  const textAdapter  = buildTextAdapter(textType);
  const embedAdapter = buildEmbeddingAdapter(embedType);
  // ...existing happy-path composition...
} catch (err) {
  // Only auto-fall-back to local when the user did NOT explicitly choose
  // an embedding provider. Explicit choices are honored: the error bubbles.
  if (originalEmbedSetting !== "auto") {
    throw err;
  }
  console.error(
    `[LLMFactory] Failed to initialise providers (text=${textType}, embed=${embedType}): ${err}. ` +
    `embedding_provider was 'auto' → falling back to LocalEmbeddingAdapter for embeddings ` +
    `and DisabledTextAdapter for text.`
  );
  const embed = new LocalEmbeddingAdapter();
  const text  = new DisabledTextAdapter();
  // ...compose & return as before, wrapped in TracingLLMProvider...
}
```

**Why this matters:** the previous draft said "fall through to local on any error" but the code example matched a different (looser) policy. The tightened version keeps explicit user intent intact and is testable: a test with `embedding_provider=voyage` + missing voyage key must throw, not silently degrade.

`DisabledTextAdapter` is a 20-line stub whose `generateText()` throws `"No text provider is configured. Set GOOGLE_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY, or configure a provider in the Mind Palace dashboard."` Its `generateEmbedding()` also throws (it should never be called — the factory routes embeddings through Local).

### 3.6 Dependency wiring

`package.json`:

```json
{
  "peerDependencies": {
    "typescript": "^5.0.0",
    "@huggingface/transformers": "^3.0.0"
  },
  "peerDependenciesMeta": {
    "@huggingface/transformers": { "optional": true }
  }
}
```

Users who never set `embedding_provider=local` are unaffected. Users who do see a clear error pointing them to the install command.

---

## 4. Configuration Surface

| Setting key | Env var | Default | Purpose |
|---|---|---|---|
| `embedding_provider` | — | `"auto"` | New accepted value: `"local"` |
| `local_embedding_model` | `LOCAL_EMBEDDING_MODEL` | `"Xenova/nomic-embed-text-v1.5"` | HuggingFace model ID |
| `local_embedding_quantized` | `LOCAL_EMBEDDING_QUANTIZED` | `true` | q8 vs fp32 |

Model cache lives in the default transformers.js cache: `~/.cache/huggingface/hub/`. Users can override via `HF_HOME` env var if they need a different location (handled by transformers.js, not us).

---

## 5. Failure Modes

| Failure | Server state | Behavior on `generateEmbedding()` |
|---|---|---|
| `@huggingface/transformers` not installed | Up | Throws: `"Local embeddings require @huggingface/transformers. Run: npm install @huggingface/transformers"` |
| Model download fails (network, disk full, HF outage) | Up | Throws underlying error with hint |
| Model loaded but inference throws | Up | Bubbles the error, next call retries (transient ONNX failures recover) |
| Wrong dimension returned (e.g., user swapped model to a 384-dim one) | Up | Throws dimension mismatch error pointing to `local_embedding_model` setting |
| Auto-fallback path: no API keys at all | Up | Local adapter handles embeddings; `DisabledTextAdapter` throws on `generateText` |

The server **never** crashes due to local adapter failures. The worst case is "embeddings are unavailable but everything else works," which matches Prism's existing behavior under transient cloud failures.

---

## 6. Testing Strategy

### 6.1 Unit tests — `tests/llm/local.test.ts`

`@huggingface/transformers` is fully mocked via `vi.mock`. The mock exposes a fake `pipeline()` that returns a callable returning an object shaped like `{ data: Float32Array, dims: [1, 768] }`.

Test cases:

1. **Construction is synchronous** — `new LocalEmbeddingAdapter()` doesn't await anything; the constructor returns immediately even if the mocked pipeline factory hangs.
2. **`generateText()` throws** with an actionable message containing "embedding-only".
3. **Happy path** — `generateEmbedding("hello world")` returns `number[]` of length 768 after the background load resolves.
4. **search_document prefix is applied** — the mocked pipeline receives the input text *with* `"search_document: "` prepended.
5. **Empty input throws** — `""` and `"   \n  "` both throw.
6. **Long text is truncated word-safely** to `MAX_EMBEDDING_CHARS = 8000`.
7. **Dimension guard** — mock returns 384-dim vector → throws with "expected 768".
8. **Module not found** — mock throws `ERR_MODULE_NOT_FOUND` on import → first embedding call throws the friendly install message; subsequent calls also throw (cached load error).
9. **Pipeline init failure** — mock throws on `pipeline()` call → first embedding call throws the underlying error.
10. **Pooling + normalize options are passed** to the pipeline call.

### 6.2 Factory tests — extend `tests/llm/factory.test.ts`

New cases:

11. **`embedding_provider=local`** → builds `LocalEmbeddingAdapter`, no other embedding adapters constructed.
12. **Auto-fallback to Local** — text adapter construction throws AND `embedding_provider=auto` → factory builds `LocalEmbeddingAdapter` and `DisabledTextAdapter`.
13. **Auto-fallback log message** mentions both Local and Disabled.
14. **`DisabledTextAdapter.generateText()`** throws an actionable error.
15. **Explicit embedding_provider is preserved on failure** — `text_provider=anthropic`, `embedding_provider=voyage`, voyage throws → factory throws (no silent override). This guards the explicit-choice contract.
16. **Existing tests still pass** unchanged.

### 6.3 No real model loads

Unit tests must not download or run the real ONNX model. Keeps CI under 60 seconds and avoids flakiness. An optional `tests/llm/local.integration.test.ts` gated on `process.env.RUN_INTEGRATION === "1"` can be added later for a real end-to-end check.

---

## 7. Migration & Rollout

- **Existing users unaffected.** Default `embedding_provider=auto` continues to route to gemini/openai/anthropic+gemini exactly as today as long as keys are present.
- **No DB migration.** Vector dimension is unchanged.
- **No lockfile bloat for non-users.** `@huggingface/transformers` is a peer dep, not a regular dep.
- **Opt-in flow:**
  1. `npm install @huggingface/transformers`
  2. Set `embedding_provider=local` in the dashboard or `embedding_provider=local` in env/config
  3. Restart MCP server
  4. First request triggers background download; first embedding call may briefly wait for it
- **Implicit fallback flow:** Users with no API keys configured will silently get local embeddings (after `npm install @huggingface/transformers`). Without the peer dep installed, they see the friendly error message.

---

## 8. Open Questions / Follow-ups

These are explicitly out of scope for this PR:

1. **Dashboard UI** for picking the local provider, model, and quantization. Follow-up PR.
2. **Query vs. document prefix distinction.** Would require interface change to `generateEmbedding(text, kind?)`. Defer until it's measured to matter.
3. **Multiple model variants** (e.g., a code-specialized model for code-heavy sessions). Defer.
4. **Worker thread isolation** of ONNX inference. onnxruntime-node releases the libuv thread pool, so the event loop stays responsive on a multi-core machine. Worker thread is unnecessary for v1.
5. **Integration test** with a real model load. Worth adding as a `RUN_INTEGRATION=1`-gated test once the adapter has shipped and stabilized.

---

## 9. Acceptance Criteria

- [ ] `LocalEmbeddingAdapter` exists and implements `LLMProvider`.
- [ ] `DisabledTextAdapter` exists and throws actionable errors on text calls.
- [ ] Factory routes `embedding_provider=local` to `LocalEmbeddingAdapter`.
- [ ] Factory falls back to Local + Disabled when text adapter construction throws and `embedding_provider=auto`.
- [ ] `package.json` has `@huggingface/transformers` as an optional peer dependency.
- [ ] Unit tests in `tests/llm/local.test.ts` cover all 10 adapter test cases.
- [ ] Factory tests in `tests/llm/factory.test.ts` cover the 4 new cases.
- [ ] All existing tests still pass.
- [ ] `npm run build` (tsc) passes with zero errors.
- [ ] No 768-dim assumption is broken anywhere in the stack.
