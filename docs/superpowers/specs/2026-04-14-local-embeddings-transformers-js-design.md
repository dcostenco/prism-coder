# Local Embeddings via transformers.js — Design Spec

**Date:** 2026-04-14
**Status:** Plan review complete → ready for implementation
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
2. Use [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) to run [`nomic-ai/nomic-embed-text-v1.5`](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5) (q8 quantized ONNX) locally via onnxruntime-node.
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
- Architecture-enforced network isolation. The "no external requests" property is a guarantee of the default model, not the code. Model ID validation (§3.4) is the enforcement boundary — a user-supplied model could include ONNX operators that make outbound calls. Users requiring strict air-gap enforcement should apply OS-level network namespace restrictions.

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
src/utils/llm/factory.ts                 # New "local" case + separate text/embed fallback paths
package.json                             # @huggingface/transformers optional peer dep + devDep
tests/llm/factory.test.ts                # New routing + fallback tests
```

### 3.3 LocalEmbeddingAdapter contract

```ts
class LocalEmbeddingAdapter implements LLMProvider {
  private loadPromise: Promise<void>;
  // Typed as a callable to avoid importing FeatureExtractionPipeline directly
  // (dynamic import means the type is not available at compile time when the
  // peer dep is absent). Full type: Awaited<ReturnType<typeof pipeline>>.
  private pipe: ((text: string, opts: object) => Promise<unknown>) | null = null;
  private loadError: Error | null = null;

  constructor() {
    // Kick off background load. Returns immediately; server boot is not blocked.
    this.loadPromise = this.initPipeline();
  }

  async generateText(_prompt: string, _systemInstruction?: string): Promise<string> {
    // Embedding-only — same pattern as VoyageAdapter.
    // Client-facing message intentionally omits env var names (CWE-209).
    throw new Error(
      "LocalEmbeddingAdapter does not support text generation. " +
      "It is an embedding-only provider. " +
      "Configure a text provider in the Mind Palace dashboard."
    );
  }

  async generateEmbedding(text: string): Promise<number[]> {
    // 1. Empty/whitespace guard — same contract as all other adapters
    if (!text || !text.trim()) {
      throw new Error("[LocalEmbeddingAdapter] generateEmbedding called with empty text");
    }
    // 2. Truncate to MAX_EMBEDDING_CHARS (8000) with word-boundary snap
    //    (consistent with GeminiAdapter, OpenAIAdapter, VoyageAdapter)
    // 3. await this.loadPromise — waits for the background init to settle
    // 4. if (this.loadError) throw this.loadError — surfaces init failures
    // 5. Run this.pipe(`search_document: ${truncated}`, { pooling: "mean", normalize: true })
    // 6. Extract float vector: const vec = Array.from((result as any).data as Float32Array)
    //    NOTE: transformers.js returns Tensor { data: Float32Array, dims: [1, 768] }.
    //    Access .data directly — do NOT use .tolist(), [...result], or Array.from(result).
    //    Array.from(result.data) yields the flat 768-element float array.
    // 7. Hard 768-dim guard — throw on length mismatch
    //    (protects against user switching local_embedding_model to a 384-dim model)
  }

  // No generateImageDescription (embedding-only)
}
```

### 3.4 Background pipeline init

```ts
private async initPipeline(): Promise<void> {
  // ── Step 1: Validate model ID before any outbound activity ────────────────
  const model = getSettingSync("local_embedding_model", DEFAULT_MODEL);
  const env = process.env.LOCAL_EMBEDDING_MODEL;
  const resolvedModel = env ?? model;

  // Enforce HuggingFace model ID format: "owner/name"
  // Rejects: absolute paths, relative paths (../), file:// URIs, full URLs.
  // A malicious or misconfigured model ID can trigger SSRF or load arbitrary
  // ONNX weights (CWE-918, CWE-73). Validate before touching the network.
  const MODEL_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}\/[a-zA-Z0-9._-]{1,128}$/;
  if (!MODEL_ID_PATTERN.test(resolvedModel) || resolvedModel.includes("..")) {
    this.loadError = new Error(
      `[LocalEmbeddingAdapter] Invalid local_embedding_model: "${resolvedModel}". ` +
      `Must be a HuggingFace model ID in the format "owner/name" ` +
      `(e.g., "${DEFAULT_MODEL}"). Paths and URLs are not permitted.`
    );
    return;
  }

  // ── Step 2: Warn if HF_ENDPOINT is set to a non-official domain ──────────
  // HF_ENDPOINT redirects ALL model downloads to the specified server.
  // If set to an attacker-controlled host, it bypasses HuggingFace's CDN
  // integrity guarantees and can deliver malicious ONNX weights (CWE-494).
  const hfEndpoint = process.env.HF_ENDPOINT;
  if (hfEndpoint && !hfEndpoint.includes("huggingface.co")) {
    console.warn(
      `[LocalEmbeddingAdapter] HF_ENDPOINT is set to "${hfEndpoint}" — ` +
      `model downloads are redirected to this host. ` +
      `Only set HF_ENDPOINT if you control and trust this server. ` +
      `Unset it to use the official HuggingFace CDN.`
    );
  }

  // ── Step 3: Dynamic import (optional peer dep) ────────────────────────────
  // transformers.js is not in dependencies; users who want local embeddings
  // install it separately. If absent, we store the error and let
  // generateEmbedding() surface a clear install instruction.
  let transformers: typeof import("@huggingface/transformers");
  try {
    transformers = await import("@huggingface/transformers");
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    if ((e as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") {
      this.loadError = new Error(
        "[LocalEmbeddingAdapter] @huggingface/transformers is not installed. " +
        "Run: npm install @huggingface/transformers"
      );
    } else {
      this.loadError = e;
    }
    return;
  }

  // ── Step 4: Load the pipeline ─────────────────────────────────────────────
  // dtype: "q8" is the correct v3 API. The old `quantized: boolean` option was
  // removed in @huggingface/transformers v3.x. Using `quantized` would be
  // silently ignored, causing the full ~550 MB fp32 model to load.
  const quantized = getSettingSync("local_embedding_quantized", "true") !== "false";
  const dtype = quantized ? "q8" : "fp32";

  // Pin to a specific model revision to prevent silent updates if the HuggingFace
  // repository is updated or compromised (CWE-494).
  // IMPORTANT: When updating DEFAULT_MODEL or DEFAULT_REVISION, verify the new
  // revision SHA from https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/commits/main
  const revision = getSettingSync("local_embedding_revision", DEFAULT_REVISION);

  try {
    const pipelineInstance = await transformers.pipeline(
      "feature-extraction",
      resolvedModel,
      { dtype, revision },
    );
    this.pipe = pipelineInstance as (text: string, opts: object) => Promise<unknown>;

    // Warmup forces ONNX session initialization so the first real call is fast.
    // Warmup failure is NOT fatal — it means a slightly slower first call.
    // It MUST NOT set this.loadError (which would permanently disable the adapter).
    try {
      await this.pipe("warmup text", { pooling: "mean", normalize: true });
      debugLog(`[LocalEmbeddingAdapter] Pipeline ready and warmed up: ${resolvedModel} (${dtype})`);
    } catch (warmupErr) {
      const we = warmupErr instanceof Error ? warmupErr : new Error(String(warmupErr));
      console.warn(
        `[LocalEmbeddingAdapter] Warmup failed (non-fatal): ${we.message}. ` +
        `First embedding call may be slightly slower.`
      );
      debugLog(`[LocalEmbeddingAdapter] Pipeline ready (no warmup): ${resolvedModel} (${dtype})`);
    }
  } catch (err) {
    this.loadError = err instanceof Error ? err : new Error(String(err));
    console.error(
      `[LocalEmbeddingAdapter] Failed to load pipeline: ${this.loadError.message}`
    );
  }
}
```

**Key corrections from plan review:**
- `dtype: "q8"` not `{ quantized: boolean }` (v3 API, not v2)
- Model ID validated before any network activity (SSRF/path traversal guard)
- `DEFAULT_REVISION` pins the commit SHA (integrity guard)
- Warmup has its own try/catch — failure warns but does NOT disable the adapter
- All `catch (err)` blocks normalize to `Error` via `instanceof` check

### 3.5 Factory wiring

`buildEmbeddingAdapter()` gains a `"local"` case (unchanged from earlier draft):

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

`getLLMProvider()` uses **separate try/catch blocks** for the text and embedding adapters, preserving original settings to honor explicit user choices:

```ts
const originalTextSetting  = getSettingSync("text_provider", "gemini");
const originalEmbedSetting = getSettingSync("embedding_provider", "auto");
let embedType = originalEmbedSetting;
let textType  = originalTextSetting;

if (embedType === "auto") {
  // Existing anthropic→gemini auto-bridge logic (unchanged)
  embedType = textType === "anthropic" ? "gemini" : textType;
  if (textType === "anthropic") { /* existing info log */ }
}

// ── Build text adapter (may fail if API key missing) ──────────────────────
let textAdapter: LLMProvider;
try {
  textAdapter = buildTextAdapter(textType);
} catch (textErr) {
  if (originalTextSetting !== "gemini" && originalEmbedSetting !== "auto") {
    // User explicitly chose both providers — bubble the error.
    throw textErr;
  }
  // text_provider was default ("gemini") or embedding was "auto":
  // degrade to DisabledTextAdapter. Log with warn (expected path, not an error).
  console.warn(
    `[LLMFactory] text_provider=${textType} failed to init: ${textErr}. ` +
    `Falling back to DisabledTextAdapter for text generation.`
  );
  textAdapter = new DisabledTextAdapter();
}

// ── Build embedding adapter (may fail if API key missing) ─────────────────
let embedAdapter: LLMProvider;
try {
  embedAdapter = buildEmbeddingAdapter(embedType);
} catch (embedErr) {
  if (originalEmbedSetting !== "auto") {
    // User explicitly chose an embedding provider — honor that choice, bubble.
    throw embedErr;
  }
  // embedding_provider was "auto" — fall back to local embeddings.
  console.warn(
    `[LLMFactory] embedding_provider=auto resolved to ${embedType} but failed: ${embedErr}. ` +
    `Falling back to LocalEmbeddingAdapter. ` +
    `⚠️  Embedding model has changed. Existing vectors may be incompatible — ` +
    `re-index all entries to restore search quality.`
  );
  embedAdapter = new LocalEmbeddingAdapter();
}

// ── Compose & wrap (existing happy-path logic) ────────────────────────────
const composed: LLMProvider = {
  generateText:      textAdapter.generateText.bind(textAdapter),
  generateEmbedding: embedAdapter.generateEmbedding.bind(embedAdapter),
};
if (textAdapter.generateImageDescription) {
  composed.generateImageDescription = textAdapter.generateImageDescription.bind(textAdapter);
}
providerInstance = new TracingLLMProvider(composed, textType);
```

**Why separate try/catch blocks matter:**
- Explicit `text_provider=openai` + missing key: text adapter throws → surfaced as error (not silently replaced with Disabled)
- Explicit `embedding_provider=voyage` + missing key: embedding adapter throws → surfaced as error (not silently replaced with Local)
- Both on `"auto"` / default + missing keys: both degrade gracefully — this is the "truly keyless" path

`DisabledTextAdapter` (`src/utils/llm/adapters/disabledText.ts`):
```ts
export class DisabledTextAdapter implements LLMProvider {
  async generateText(_prompt: string, _systemInstruction?: string): Promise<string> {
    // Client-facing message is intentionally brief (CWE-209 — env var enumeration).
    // Actionable guidance lives in the server-side console.warn above.
    throw new Error(
      "Text generation is not available. " +
      "Configure an AI provider in the Mind Palace dashboard."
    );
  }
  async generateEmbedding(_text: string): Promise<number[]> {
    // Should never be called — factory routes embeddings to LocalEmbeddingAdapter.
    throw new Error("[DisabledTextAdapter] generateEmbedding should not be called directly.");
  }
}
```

### 3.6 Dependency wiring

`package.json`:

```json
{
  "peerDependencies": {
    "typescript": "^5.0.0",
    "@huggingface/transformers": "~3.1.0"
  },
  "peerDependenciesMeta": {
    "@huggingface/transformers": { "optional": true }
  },
  "devDependencies": {
    "@huggingface/transformers": "3.1.0"
  }
}
```

**Version pinning rationale (IMPORTANT from review):**
- `^3.0.0` (any 3.x) was rejected: onnxruntime-node C++ native changes in a minor release could silently change model loading behavior, or a compromised `3.x` release could introduce RCE via the ONNX loading path.
- `~3.1.0` (patch-level updates only) limits exposure to security patches within the tested minor.
- The `devDependency` at an exact version ensures the package-lock.json is authoritative for CI. Users get `~3.1.0` compatibility; CI tests against exactly `3.1.0`.
- When upgrading: update both `peerDependencies` and `devDependencies`, verify in CI, update `DEFAULT_REVISION` if the default model changes.

---

## 4. Configuration Surface

| Setting key | Default | Read via | Purpose |
|---|---|---|---|
| `embedding_provider` | `"auto"` | `getSettingSync` | New accepted value: `"local"` |
| `local_embedding_model` | `"nomic-ai/nomic-embed-text-v1.5"` | `getSettingSync`, then `process.env.LOCAL_EMBEDDING_MODEL` | HuggingFace model ID (format: `owner/name` only) |
| `local_embedding_quantized` | `"true"` | `getSettingSync` | Maps to `dtype: "q8"` (true) or `dtype: "fp32"` (false) |
| `local_embedding_revision` | pinned SHA | `getSettingSync` | HuggingFace model revision commit SHA |

**Note on env var support:** `getSettingSync` reads from the Prism config SQLite store. The `local_embedding_model` key is the exception — it also checks `process.env.LOCAL_EMBEDDING_MODEL` directly to support Docker/container deployments where config DB is not convenient. Other `local_*` keys read only from the config store; no env var fallback.

**Model cache:** `~/.cache/huggingface/hub/` (transformers.js default). Override via `HF_ENDPOINT` (see §3.4 warning) or `HF_HOME`. Cache directory should be owned and writable only by the MCP server process user.

**`HF_ENDPOINT` risk:** If set to a non-HuggingFace host in the server's environment, all model downloads are redirected. The `LocalEmbeddingAdapter` warns at startup if this is detected. Never set `HF_ENDPOINT` unless you control and trust the target server.

---

## 5. Failure Modes

| Failure | Server state | Behavior on `generateEmbedding()` |
|---|---|---|
| `@huggingface/transformers` not installed | Up | Throws: `"@huggingface/transformers is not installed. Run: npm install @huggingface/transformers"` |
| Invalid `local_embedding_model` format (path, URL) | Up | Throws validation error at init; `generateEmbedding()` throws on every call |
| Model download fails (network, disk full, HF outage) | Up | Throws underlying error |
| Warmup fails | Up | **Non-fatal** — adapter continues; first real call pays ~200ms ONNX init cost |
| Model loaded but inference throws | Up | Bubbles the error; next call retries (transient ONNX failures recover) |
| Wrong dimension returned (user switched to a 384-dim model) | Up | Throws: `"dimension mismatch: expected 768, got N. Check local_embedding_model setting."` |
| Auto-fallback path: no API keys at all | Up | Local adapter handles embeddings; `DisabledTextAdapter` throws on `generateText` with concise message |
| **Embedding model changed mid-lifecycle** | Up | ⚠️ Silent quality degradation — vectors from different models coexist in the DB. Factory logs a prominent `console.warn`. Re-index all entries to restore search quality (no automated migration). |

**Mixed-vector risk:** If the `embedding_provider` auto-fallback fires and the previous provider was different (e.g., Gemini → Local), embeddings from different model families coexist in the vector store. Cosine similarity between them is meaningless. The factory warns loudly when this happens. A follow-up task should add an `embedding_model` metadata column to vector entries for detection and targeted re-indexing.

---

## 6. Testing Strategy

### 6.1 Unit tests — `tests/llm/local.test.ts`

`@huggingface/transformers` is fully mocked via `vi.mock`. The mock exposes a fake `pipeline()` factory that returns a callable. That callable returns an object shaped like `{ data: new Float32Array(768).fill(0.1), dims: [1, 768] }` (simulating the Tensor shape).

Test cases:

1. **Construction is synchronous** — `new LocalEmbeddingAdapter()` returns immediately even if `initPipeline()` hangs.
2. **`generateText()` throws** with a message containing "embedding-only" (does NOT leak env var names).
3. **Happy path** — `await adapter.loadPromise` first to let background init settle, then `generateEmbedding("hello world")` returns `number[]` of length 768. Explicitly awaiting `loadPromise` before calling `generateEmbedding` is acceptable since `generateEmbedding` also awaits it internally — the test should verify the round-trip, not just the final array length.
4. **search_document prefix is applied** — mock pipeline callable's `calls[0][0]` equals `"search_document: hello world"`.
5. **Empty input throws** — `""` and `"   \n  "` both throw.
6. **Long text is truncated word-safely** to `MAX_EMBEDDING_CHARS = 8000` — verify the mock receives ≤8000 chars.
7. **Dimension guard** — mock callable returns 384-element array → `generateEmbedding` throws with "expected 768".
8. **Module not found** — mock the dynamic import to throw with `code: "ERR_MODULE_NOT_FOUND"` → first embedding call throws with "not installed" message; `loadError` is cached, subsequent calls throw the same error.
9. **Pipeline init failure** — mock `pipeline()` factory to throw → first embedding call throws; warmup failure does NOT block this (test verifies init error propagation, not warmup).
10. **Pooling + normalize options are passed** — mock callable records call args; verify `{ pooling: "mean", normalize: true }` is in the options.
11. **Warmup failure is non-fatal** — mock warmup call to throw, but `pipeline()` itself succeeds → `generateEmbedding` still works (no `loadError` set).
12. **Model ID validation** — supply `"../evil/path"` or `"https://bad.com/model"` as `local_embedding_model` → `generateEmbedding` throws with "Invalid local_embedding_model".
13. **`Array.from(result.data)` extraction** — mock returns `{ data: Float32Array([...768 floats...]), dims: [1, 768] }` with known values; verify returned array equals `Array.from(data)` exactly (not a nested array, not `Array.from(result)`).

### 6.2 Factory tests — extend `tests/llm/factory.test.ts`

New cases:

14. **`embedding_provider=local`** → builds `LocalEmbeddingAdapter`, no other embedding adapters constructed.
15. **Auto-fallback: embedding adapter throws + `embedding_provider=auto`** → factory builds `LocalEmbeddingAdapter`; logs a `console.warn` containing "re-index".
16. **Auto-fallback: text adapter throws + default `text_provider`** → factory builds `DisabledTextAdapter` for text; `DisabledTextAdapter.generateText()` throws a concise message (no env var names).
17. **Explicit `embedding_provider=voyage` + voyage throws** → factory throws (explicit choice not silently overridden).
18. **Explicit `text_provider=openai` + OpenAI throws** → factory throws (explicit text choice not silently overridden).
19. **Existing tests still pass** unchanged (all prior routing and singleton tests).

### 6.3 No real model loads

Unit tests must not download or run the real ONNX model. CI stays fast. An optional `tests/llm/local.integration.test.ts` gated on `process.env.RUN_INTEGRATION === "1"` can be added later for a real end-to-end check.

---

## 7. Migration & Rollout

- **Existing users unaffected.** Default `embedding_provider=auto` with API keys configured continues routing exactly as before.
- **No DB migration.** Vector dimension is unchanged (768).
- **No lockfile bloat for non-users.** `@huggingface/transformers` is a peer dep, not a regular dep.
- **Opt-in flow:**
  1. `npm install @huggingface/transformers@3.1.x`
  2. Set `embedding_provider=local` in the dashboard
  3. Restart MCP server
  4. First request triggers background download; first embedding call awaits it
- **Implicit fallback flow:** Users with no API keys configured will silently get local embeddings (after peer dep install). Without the peer dep, they see the friendly install error.
- **⚠️ Mixed-vector risk on first fallback:** If a deployment was previously using Gemini/OpenAI/Voyage embeddings and the adapter switches to Local (via auto-fallback after key deletion), existing vectors and new vectors are from different model families. Re-indexing all entries is required to restore semantic search quality. The factory warns prominently when this transition occurs.

---

## 8. Open Questions / Follow-ups

These are explicitly out of scope for this PR:

1. **Dashboard UI** for picking the local provider, model, and quantization. Follow-up PR.
2. **Query vs. document prefix distinction.** Would require interface change to `generateEmbedding(text, kind?)`. Defer until it's measured to matter.
3. **Multiple model variants** (e.g., a code-specialized model). Defer.
4. **Worker thread isolation** of ONNX inference. `onnxruntime-node` releases the libuv thread pool; event loop stays responsive on multi-core. Worker thread unnecessary for v1.
5. **Integration test** with real model load, gated on `RUN_INTEGRATION=1`. Defer to post-ship.
6. **`embedding_model` metadata column** in vector entries for mixed-model detection and targeted re-indexing. Follow-up.
7. **Re-indexing tooling** for when the embedding model changes (e.g., a `prism reindex` CLI command). Follow-up.

---

## 9. Acceptance Criteria

- [ ] `LocalEmbeddingAdapter` exists and implements `LLMProvider`.
- [ ] `DisabledTextAdapter` exists and throws concise errors (no env var enumeration) on text calls.
- [ ] Model ID is validated before `transformers.pipeline()` is called (rejects paths, URLs).
- [ ] Factory uses **separate try/catch** for text and embedding adapter construction.
- [ ] Factory routes `embedding_provider=local` to `LocalEmbeddingAdapter`.
- [ ] Factory auto-falls-back to Local only when `embedding_provider=auto` fails; explicit choices throw.
- [ ] Factory auto-falls-back to Disabled text only when `text_provider` is default/unset; explicit text choices throw.
- [ ] `package.json` has `@huggingface/transformers ~3.1.0` as optional peer dep + exact version devDep.
- [ ] `DEFAULT_REVISION` constant is set to the pinned commit SHA for `nomic-ai/nomic-embed-text-v1.5`.
- [ ] Warmup failure is non-fatal (logs warn, does NOT set `loadError`).
- [ ] `dtype: "q8"` (not `quantized: boolean`) is used in the pipeline options.
- [ ] Tensor extraction uses `Array.from(result.data)` (`Float32Array` access, not nested array).
- [ ] Unit tests cover all 13 adapter test cases (§6.1).
- [ ] Factory tests cover all 5 new routing cases (§6.2, tests 14–18).
- [ ] All existing tests still pass.
- [ ] `npm run build` (tsc) passes with zero errors.
- [ ] No 768-dim assumption is broken anywhere in the stack.
