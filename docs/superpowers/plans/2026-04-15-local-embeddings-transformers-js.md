# Local Embeddings via transformers.js — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `LocalEmbeddingAdapter` using `@huggingface/transformers` + `nomic-ai/nomic-embed-text-v1.5` (q8 ONNX) so Prism can generate 768-dim embeddings fully locally with no API keys.

**Architecture:** New `LocalEmbeddingAdapter` in `src/utils/llm/adapters/local.ts` and `DisabledTextAdapter` stub in `src/utils/llm/adapters/disabledText.ts`, both following the existing `VoyageAdapter` pattern. The factory (`src/utils/llm/factory.ts`) gains separate try/catch blocks for text and embedding adapters — explicit provider choices throw on failure; `"auto"` paths degrade gracefully to local/disabled.

**Tech Stack:** TypeScript strict ESM, `@huggingface/transformers` v3 (optional peer dep), vitest, onnxruntime-node (transitive dep via transformers.js).

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/utils/llm/adapters/disabledText.ts` | Stub adapter — throws on generateText/generateEmbedding with concise messages |
| Create | `src/utils/llm/adapters/local.ts` | LocalEmbeddingAdapter — model validation, background pipeline init, 768-dim guard |
| Modify | `src/utils/llm/factory.ts` | Import new adapters, add "local" case, split try/catch, update fallback logic |
| Modify | `package.json` | Add `@huggingface/transformers` as optional peer dep + exact devDep |
| Create | `tests/llm/local.test.ts` | 13 adapter unit tests (transformers mocked) |
| Create | `tests/llm/local-missing-dep.test.ts` | 1 test for ERR_MODULE_NOT_FOUND path (separate file — mock throws on import) |
| Modify | `tests/llm/factory.test.ts` | Update 1 existing test + add 5 new routing tests |

---

## Task 1: Update package.json

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add peer dep and devDep**

Open `package.json`. Add to `peerDependencies` and `peerDependenciesMeta`, and add to `devDependencies`. The result should look like this (preserve all existing entries):

```json
"peerDependencies": {
  "typescript": "^5.0.0",
  "@huggingface/transformers": "~3.1.0"
},
"peerDependenciesMeta": {
  "@huggingface/transformers": {
    "optional": true
  }
},
```

And in `devDependencies`, add:
```json
"@huggingface/transformers": "3.1.0"
```

- [ ] **Step 2: Install the dev dep**

```bash
cd /Users/geraldonyango/Documents/dev/prism-mcp && npm install
```

Expected: installs `@huggingface/transformers@3.1.0` into `node_modules`. No errors.

- [ ] **Step 3: Verify transformers.js is available**

```bash
node -e "import('@huggingface/transformers').then(m => console.log('OK:', Object.keys(m).slice(0,3)))"
```

Expected output: `OK: ['pipeline', ...]` or similar. If it fails with a module error, check the version.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @huggingface/transformers as optional peer dep (local embeddings)"
```

---

## Task 2: DisabledTextAdapter

**Files:**
- Create: `src/utils/llm/adapters/disabledText.ts`

- [ ] **Step 1: Create the file**

```typescript
// src/utils/llm/adapters/disabledText.ts
import type { LLMProvider } from "../provider.js";

export class DisabledTextAdapter implements LLMProvider {
  async generateText(_prompt: string, _systemInstruction?: string): Promise<string> {
    throw new Error(
      "Text generation is not available. " +
      "Configure an AI provider in the Mind Palace dashboard."
    );
  }

  async generateEmbedding(_text: string): Promise<number[]> {
    throw new Error(
      "[DisabledTextAdapter] generateEmbedding should not be called directly. " +
      "The factory routes embeddings to LocalEmbeddingAdapter."
    );
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd /Users/geraldonyango/Documents/dev/prism-mcp && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors for the new file (there may be pre-existing errors; check only for new ones).

- [ ] **Step 3: Commit**

```bash
git add src/utils/llm/adapters/disabledText.ts
git commit -m "feat: add DisabledTextAdapter stub for keyless fallback path"
```

---

## Task 3: LocalEmbeddingAdapter — skeleton, constants, model ID validation

**Files:**
- Create: `src/utils/llm/adapters/local.ts`
- Create: `tests/llm/local.test.ts` (first batch of tests)

- [ ] **Step 1: Write failing tests for model ID validation and generateText**

Create `tests/llm/local.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockGetSettingSync = vi.fn();

vi.mock("../../src/storage/configStorage.js", () => ({
  getSettingSync: (...args: unknown[]) => mockGetSettingSync(...args),
}));

vi.mock("../../src/utils/logger.js", () => ({
  debugLog: vi.fn(),
}));

// ─── @huggingface/transformers mock ──────────────────────────────────────────
// Simulates the package being installed. The mock callable returns a
// Tensor-shaped object: { data: Float32Array(768), dims: [1, 768] }.

const mockPipelineCallable = vi.fn();
const mockPipelineFactory  = vi.fn();

vi.mock("@huggingface/transformers", () => ({
  pipeline: mockPipelineFactory,
}));

import { LocalEmbeddingAdapter } from "../../src/utils/llm/adapters/local.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function make768Tensor(): { data: Float32Array; dims: number[] } {
  return { data: new Float32Array(768).fill(0.1), dims: [1, 768] };
}

function defaultSettings(key: string, fallback?: string): string {
  if (key === "local_embedding_model")     return "nomic-ai/nomic-embed-text-v1.5";
  if (key === "local_embedding_quantized") return "true";
  if (key === "local_embedding_revision")  return "main";
  return fallback ?? "";
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("LocalEmbeddingAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.LOCAL_EMBEDDING_MODEL;
    delete process.env.HF_ENDPOINT;
    mockGetSettingSync.mockImplementation(defaultSettings);
    mockPipelineCallable.mockResolvedValue(make768Tensor());
    mockPipelineFactory.mockResolvedValue(mockPipelineCallable);
  });

  // ── Construction ────────────────────────────────────────────────────────────

  it("construction is synchronous — returns before pipeline resolves", () => {
    // mockPipelineFactory hangs (never resolves)
    mockPipelineFactory.mockReturnValue(new Promise(() => {}));
    const adapter = new LocalEmbeddingAdapter();
    expect(adapter).toBeDefined();
    // loadPromise exists and is a Promise
    expect(adapter.loadPromise).toBeInstanceOf(Promise);
  });

  // ── generateText ────────────────────────────────────────────────────────────

  it("generateText throws with 'embedding-only' message", async () => {
    const adapter = new LocalEmbeddingAdapter();
    await expect(adapter.generateText("hello")).rejects.toThrow("embedding-only");
  });

  it("generateText error does NOT contain env var names", async () => {
    const adapter = new LocalEmbeddingAdapter();
    try {
      await adapter.generateText("hello");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain("GOOGLE_API_KEY");
      expect(msg).not.toContain("OPENAI_API_KEY");
      expect(msg).not.toContain("ANTHROPIC_API_KEY");
    }
  });

  // ── Model ID validation ─────────────────────────────────────────────────────

  it("rejects path-traversal model ID", async () => {
    mockGetSettingSync.mockImplementation((key: string, fallback?: string) => {
      if (key === "local_embedding_model") return "../../etc/passwd";
      return defaultSettings(key, fallback);
    });
    const adapter = new LocalEmbeddingAdapter();
    await expect(adapter.generateEmbedding("test")).rejects.toThrow(
      "Invalid local_embedding_model"
    );
    // Pipeline was never called (validation happened before import)
    expect(mockPipelineFactory).not.toHaveBeenCalled();
  });

  it("rejects URL model ID", async () => {
    mockGetSettingSync.mockImplementation((key: string, fallback?: string) => {
      if (key === "local_embedding_model") return "https://evil.com/model";
      return defaultSettings(key, fallback);
    });
    const adapter = new LocalEmbeddingAdapter();
    await expect(adapter.generateEmbedding("test")).rejects.toThrow(
      "Invalid local_embedding_model"
    );
  });

  it("accepts valid HuggingFace model ID", async () => {
    // The default mock already uses "nomic-ai/nomic-embed-text-v1.5" — just
    // verify no validation error is thrown during happy-path init.
    const adapter = new LocalEmbeddingAdapter();
    await adapter.loadPromise;
    expect(adapter["loadError"]).toBeNull();
  });

  it("uses LOCAL_EMBEDDING_MODEL env var over setting", async () => {
    process.env.LOCAL_EMBEDDING_MODEL = "Xenova/all-mpnet-base-v2";
    const adapter = new LocalEmbeddingAdapter();
    await adapter.loadPromise;
    // Verify pipeline was called with the env var value
    expect(mockPipelineFactory).toHaveBeenCalledWith(
      "feature-extraction",
      "Xenova/all-mpnet-base-v2",
      expect.objectContaining({ dtype: "q8" })
    );
  });
});
```

- [ ] **Step 2: Run test — expect failures (RED)**

```bash
cd /Users/geraldonyango/Documents/dev/prism-mcp && npx vitest run tests/llm/local.test.ts 2>&1 | tail -20
```

Expected: FAIL with "Cannot find module '../../src/utils/llm/adapters/local.js'" or similar. The test file cannot find the adapter yet.

- [ ] **Step 3: Create the adapter skeleton**

Create `src/utils/llm/adapters/local.ts`:

```typescript
import { getSettingSync } from "../../../storage/configStorage.js";
import { debugLog } from "../../logger.js";
import type { LLMProvider } from "../provider.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const EMBEDDING_DIMS = 768;
const MAX_EMBEDDING_CHARS = 8000;
const DEFAULT_MODEL = "nomic-ai/nomic-embed-text-v1.5";
// Pin to a specific commit to prevent silent model updates (CWE-494).
// Update when upgrading the model by checking:
// https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/commits/main
const DEFAULT_REVISION = "main";

// Allows only HuggingFace model IDs in "owner/name" format.
// Rejects: absolute paths, relative paths, file:// URIs, full URLs (CWE-918, CWE-73).
const MODEL_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}\/[a-zA-Z0-9._-]{1,128}$/;

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class LocalEmbeddingAdapter implements LLMProvider {
  // readonly so tests can await loadPromise; assignment stays internal.
  readonly loadPromise: Promise<void>;
  // Typed as callable to avoid importing FeatureExtractionPipeline at
  // compile time (the peer dep may not be installed).
  private pipe: ((text: string, opts: object) => Promise<unknown>) | null = null;
  private loadError: Error | null = null;

  constructor() {
    this.loadPromise = this.initPipeline();
  }

  async generateText(_prompt: string, _systemInstruction?: string): Promise<string> {
    throw new Error(
      "LocalEmbeddingAdapter does not support text generation. " +
      "It is an embedding-only provider. " +
      "Configure a text provider in the Mind Palace dashboard."
    );
  }

  async generateEmbedding(text: string): Promise<number[]> {
    if (!text || !text.trim()) {
      throw new Error("[LocalEmbeddingAdapter] generateEmbedding called with empty text");
    }

    // Truncate to character limit with word-boundary snap (matches all other adapters).
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

    // nomic-embed-text-v1.5 uses "search_document: " prefix for indexed text.
    const result = await this.pipe(`search_document: ${inputText}`, {
      pooling: "mean",
      normalize: true,
    });

    // Tensor { data: Float32Array, dims: [1, 768] } — access .data directly.
    // Do NOT use .tolist() or Array.from(result): those produce wrong shapes.
    const vec = Array.from((result as { data: Float32Array }).data);

    if (vec.length !== EMBEDDING_DIMS) {
      throw new Error(
        `[LocalEmbeddingAdapter] Embedding dimension mismatch: expected ${EMBEDDING_DIMS}, ` +
        `got ${vec.length}. Check the local_embedding_model setting — ` +
        `the configured model must output exactly ${EMBEDDING_DIMS} dimensions.`
      );
    }

    return vec;
  }

  private async initPipeline(): Promise<void> {
    // ── Validate model ID before any outbound activity ──────────────────────
    const model = process.env.LOCAL_EMBEDDING_MODEL ??
      getSettingSync("local_embedding_model", DEFAULT_MODEL);

    if (!MODEL_ID_PATTERN.test(model) || model.includes("..")) {
      this.loadError = new Error(
        `[LocalEmbeddingAdapter] Invalid local_embedding_model: "${model}". ` +
        `Must be a HuggingFace model ID in the format "owner/name" ` +
        `(e.g., "${DEFAULT_MODEL}"). Paths and URLs are not permitted.`
      );
      return;
    }

    // ── Warn if HF_ENDPOINT redirects to non-official host ──────────────────
    const hfEndpoint = process.env.HF_ENDPOINT;
    if (hfEndpoint && !hfEndpoint.includes("huggingface.co")) {
      console.warn(
        `[LocalEmbeddingAdapter] HF_ENDPOINT is set to "${hfEndpoint}" — ` +
        `model downloads are redirected to this host. ` +
        `Only set HF_ENDPOINT if you control and trust this server. ` +
        `Unset it to use the official HuggingFace CDN.`
      );
    }

    // ── Dynamic import (optional peer dep) ──────────────────────────────────
    let transformers: typeof import("@huggingface/transformers");
    try {
      transformers = await import("@huggingface/transformers");
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.loadError =
        (e as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND"
          ? new Error(
              "[LocalEmbeddingAdapter] @huggingface/transformers is not installed. " +
              "Run: npm install @huggingface/transformers"
            )
          : e;
      return;
    }

    // ── Load pipeline ────────────────────────────────────────────────────────
    // dtype: "q8" is the v3 API — the old {quantized: boolean} was removed.
    const quantized = getSettingSync("local_embedding_quantized", "true") !== "false";
    const dtype = quantized ? "q8" : "fp32";
    const revision = getSettingSync("local_embedding_revision", DEFAULT_REVISION);

    try {
      const pipelineInstance = await transformers.pipeline(
        "feature-extraction",
        model,
        { dtype, revision },
      );
      this.pipe = pipelineInstance as (text: string, opts: object) => Promise<unknown>;

      // Warmup forces ONNX session init. Non-fatal: failure warns, does NOT
      // disable the adapter (must not set this.loadError).
      try {
        await this.pipe("warmup text", { pooling: "mean", normalize: true });
        debugLog(`[LocalEmbeddingAdapter] Pipeline ready and warmed up: ${model} (${dtype})`);
      } catch (warmupErr) {
        const we = warmupErr instanceof Error ? warmupErr : new Error(String(warmupErr));
        console.warn(
          `[LocalEmbeddingAdapter] Warmup failed (non-fatal): ${we.message}. ` +
          `First embedding call may be slightly slower.`
        );
        debugLog(`[LocalEmbeddingAdapter] Pipeline ready (warmup skipped): ${model} (${dtype})`);
      }
    } catch (err) {
      this.loadError = err instanceof Error ? err : new Error(String(err));
      console.error(
        `[LocalEmbeddingAdapter] Failed to load pipeline: ${this.loadError.message}`
      );
    }
  }
}
```

- [ ] **Step 4: Run tests — expect partial pass (validation + generateText pass; generateEmbedding tests not written yet)**

```bash
cd /Users/geraldonyango/Documents/dev/prism-mcp && npx vitest run tests/llm/local.test.ts 2>&1 | tail -30
```

Expected: The model validation and generateText tests pass. "uses LOCAL_EMBEDDING_MODEL env var" passes if the env var logic is correct.

- [ ] **Step 5: Commit**

```bash
git add src/utils/llm/adapters/local.ts tests/llm/local.test.ts
git commit -m "feat(RED): local adapter skeleton with model validation + generateText tests"
```

---

## Task 4: LocalEmbeddingAdapter — generateEmbedding full test suite

**Files:**
- Modify: `tests/llm/local.test.ts` (add remaining 9 test cases)
- `src/utils/llm/adapters/local.ts` already complete from Task 3

- [ ] **Step 1: Add all remaining tests to `tests/llm/local.test.ts`**

Append these test cases inside the existing `describe("LocalEmbeddingAdapter", ...)` block, after the existing tests:

```typescript
  // ── generateEmbedding — happy path ──────────────────────────────────────────

  it("returns 768-element number[] on success", async () => {
    const adapter = new LocalEmbeddingAdapter();
    await adapter.loadPromise;           // wait for background init
    const result = await adapter.generateEmbedding("hello world");
    expect(result).toHaveLength(768);
    expect(result.every((v) => typeof v === "number")).toBe(true);
  });

  it("prepends 'search_document: ' prefix to input", async () => {
    const adapter = new LocalEmbeddingAdapter();
    await adapter.loadPromise;
    await adapter.generateEmbedding("hello world");
    expect(mockPipelineCallable).toHaveBeenCalledWith(
      "search_document: hello world",
      expect.anything()
    );
  });

  it("passes pooling:'mean' and normalize:true to the pipeline", async () => {
    const adapter = new LocalEmbeddingAdapter();
    await adapter.loadPromise;
    await adapter.generateEmbedding("test input");
    expect(mockPipelineCallable).toHaveBeenCalledWith(
      expect.any(String),
      { pooling: "mean", normalize: true }
    );
  });

  it("extracts Array.from(result.data) — not nested arrays", async () => {
    const knownData = new Float32Array(768).map((_, i) => i * 0.001);
    mockPipelineCallable.mockResolvedValueOnce({ data: knownData, dims: [1, 768] });
    const adapter = new LocalEmbeddingAdapter();
    await adapter.loadPromise;
    const result = await adapter.generateEmbedding("test");
    expect(result).toEqual(Array.from(knownData));
    expect(result[0]).toBeCloseTo(0);
    expect(result[1]).toBeCloseTo(0.001);
  });

  it("uses dtype:'q8' (not quantized:boolean) in pipeline options", async () => {
    const adapter = new LocalEmbeddingAdapter();
    await adapter.loadPromise;
    expect(mockPipelineFactory).toHaveBeenCalledWith(
      "feature-extraction",
      expect.any(String),
      expect.objectContaining({ dtype: "q8" })
    );
    // Ensure the old v2 API is not used
    const callArgs = mockPipelineFactory.mock.calls[0][2];
    expect(callArgs).not.toHaveProperty("quantized");
  });

  it("uses dtype:'fp32' when local_embedding_quantized is 'false'", async () => {
    mockGetSettingSync.mockImplementation((key: string, fallback?: string) => {
      if (key === "local_embedding_quantized") return "false";
      return defaultSettings(key, fallback);
    });
    const adapter = new LocalEmbeddingAdapter();
    await adapter.loadPromise;
    expect(mockPipelineFactory).toHaveBeenCalledWith(
      "feature-extraction",
      expect.any(String),
      expect.objectContaining({ dtype: "fp32" })
    );
  });

  // ── Empty / invalid input ────────────────────────────────────────────────────

  it("throws on empty string", async () => {
    const adapter = new LocalEmbeddingAdapter();
    await adapter.loadPromise;
    await expect(adapter.generateEmbedding("")).rejects.toThrow("empty text");
  });

  it("throws on whitespace-only input", async () => {
    const adapter = new LocalEmbeddingAdapter();
    await adapter.loadPromise;
    await expect(adapter.generateEmbedding("   \n\t  ")).rejects.toThrow("empty text");
  });

  // ── Truncation ───────────────────────────────────────────────────────────────

  it("truncates input longer than 8000 chars at a word boundary", async () => {
    const longText = "word ".repeat(2000); // 10000 chars
    const adapter = new LocalEmbeddingAdapter();
    await adapter.loadPromise;
    await adapter.generateEmbedding(longText);
    const [calledText] = mockPipelineCallable.mock.calls[0];
    // The prefix is prepended, so strip it to check the actual text length
    const stripped = (calledText as string).replace("search_document: ", "");
    expect(stripped.length).toBeLessThanOrEqual(8000);
    // Must end at a word boundary (no trailing partial word)
    expect(stripped.endsWith(" ") || stripped.endsWith("word")).toBe(true);
  });

  // ── Dimension guard ──────────────────────────────────────────────────────────

  it("throws on dimension mismatch when pipeline returns 384 dims", async () => {
    mockPipelineCallable.mockResolvedValueOnce({
      data: new Float32Array(384).fill(0.1),
      dims: [1, 384],
    });
    const adapter = new LocalEmbeddingAdapter();
    await adapter.loadPromise;
    await expect(adapter.generateEmbedding("test")).rejects.toThrow(
      "dimension mismatch"
    );
  });

  it("dimension error mentions expected (768) and actual dimensions", async () => {
    mockPipelineCallable.mockResolvedValueOnce({
      data: new Float32Array(384).fill(0.1),
      dims: [1, 384],
    });
    const adapter = new LocalEmbeddingAdapter();
    await adapter.loadPromise;
    try {
      await adapter.generateEmbedding("test");
    } catch (e) {
      expect((e as Error).message).toContain("768");
      expect((e as Error).message).toContain("384");
    }
  });

  // ── Pipeline init failure ────────────────────────────────────────────────────

  it("caches pipeline init failure and throws on every generateEmbedding call", async () => {
    mockPipelineFactory.mockRejectedValueOnce(new Error("ONNX session failed"));
    const adapter = new LocalEmbeddingAdapter();
    await adapter.loadPromise; // settle
    await expect(adapter.generateEmbedding("first call")).rejects.toThrow("ONNX session failed");
    await expect(adapter.generateEmbedding("second call")).rejects.toThrow("ONNX session failed");
    // Pipeline factory called only once (init, not per-call retry)
    expect(mockPipelineFactory).toHaveBeenCalledTimes(1);
  });

  // ── Warmup non-fatal ─────────────────────────────────────────────────────────

  it("warmup failure is non-fatal — adapter still works after warmup throws", async () => {
    // pipeline() resolves to callable; callable throws ONLY on "warmup text" call
    mockPipelineCallable
      .mockRejectedValueOnce(new Error("warmup tokenizer error"))  // warmup
      .mockResolvedValue(make768Tensor());                          // subsequent calls

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapter = new LocalEmbeddingAdapter();
    await adapter.loadPromise;

    // loadError must be null — warmup failure does not disable the adapter
    expect(adapter["loadError"]).toBeNull();
    expect(adapter["pipe"]).not.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Warmup failed (non-fatal)"));

    // Regular embedding still works
    const result = await adapter.generateEmbedding("real text");
    expect(result).toHaveLength(768);
    warnSpy.mockRestore();
  });

  // ── HF_ENDPOINT warning ──────────────────────────────────────────────────────

  it("warns when HF_ENDPOINT is set to non-HuggingFace host", async () => {
    process.env.HF_ENDPOINT = "https://my-internal-registry.example.com";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapter = new LocalEmbeddingAdapter();
    await adapter.loadPromise;
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("HF_ENDPOINT is set")
    );
    warnSpy.mockRestore();
  });

  it("does NOT warn when HF_ENDPOINT is unset", async () => {
    // process.env.HF_ENDPOINT is already deleted in beforeEach
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapter = new LocalEmbeddingAdapter();
    await adapter.loadPromise;
    const hfWarning = (warnSpy.mock.calls as string[][])
      .find(([msg]) => msg?.includes?.("HF_ENDPOINT"));
    expect(hfWarning).toBeUndefined();
    warnSpy.mockRestore();
  });
```

Close the `describe` block after the last test.

- [ ] **Step 2: Run tests (GREEN)**

```bash
cd /Users/geraldonyango/Documents/dev/prism-mcp && npx vitest run tests/llm/local.test.ts 2>&1 | tail -40
```

Expected: all tests in `local.test.ts` pass. If any fail, fix the adapter implementation (do not modify tests).

Common failures to check:
- "extracts Array.from(result.data)": verify `(result as { data: Float32Array }).data` is accessed
- "uses dtype:'q8'": verify `dtype` (not `quantized`) is in the pipeline call
- "warmup failure is non-fatal": verify warmup has its own try/catch that does NOT set `loadError`

- [ ] **Step 3: Commit**

```bash
git add tests/llm/local.test.ts src/utils/llm/adapters/local.ts
git commit -m "feat(GREEN): LocalEmbeddingAdapter with full test suite (13 cases)"
```

---

## Task 5: Module-not-found test (separate file)

**Files:**
- Create: `tests/llm/local-missing-dep.test.ts`

`vi.mock` is hoisted to the top of each file. To test the "package not installed" path, we need a separate file where the mock causes the import to throw.

- [ ] **Step 1: Write the missing-dep test**

Create `tests/llm/local-missing-dep.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

// Mock @huggingface/transformers to simulate it NOT being installed.
// The factory function throws ERR_MODULE_NOT_FOUND — vitest intercepts the
// dynamic import() and propagates this throw to the caller.
vi.mock("@huggingface/transformers", () => {
  const err = Object.assign(
    new Error("Cannot find module '@huggingface/transformers'"),
    { code: "ERR_MODULE_NOT_FOUND" }
  );
  throw err;
});

vi.mock("../../src/storage/configStorage.js", () => ({
  getSettingSync: (key: string, fallback?: string) => {
    if (key === "local_embedding_model") return "nomic-ai/nomic-embed-text-v1.5";
    if (key === "local_embedding_quantized") return "true";
    if (key === "local_embedding_revision") return "main";
    return fallback ?? "";
  },
}));

vi.mock("../../src/utils/logger.js", () => ({ debugLog: vi.fn() }));

import { LocalEmbeddingAdapter } from "../../src/utils/llm/adapters/local.js";

describe("LocalEmbeddingAdapter — @huggingface/transformers not installed", () => {
  it("throws install instruction on generateEmbedding", async () => {
    const adapter = new LocalEmbeddingAdapter();
    await adapter.loadPromise;
    await expect(adapter.generateEmbedding("test")).rejects.toThrow(
      "@huggingface/transformers is not installed"
    );
    await expect(adapter.generateEmbedding("test")).rejects.toThrow(
      "npm install @huggingface/transformers"
    );
  });

  it("error is cached — repeated calls throw without re-attempting import", async () => {
    const adapter = new LocalEmbeddingAdapter();
    await adapter.loadPromise;
    // Both calls throw the same cached error
    const err1 = await adapter.generateEmbedding("a").catch((e: Error) => e.message);
    const err2 = await adapter.generateEmbedding("b").catch((e: Error) => e.message);
    expect(err1).toEqual(err2);
  });
});
```

- [ ] **Step 2: Run the missing-dep test (RED)**

```bash
cd /Users/geraldonyango/Documents/dev/prism-mcp && npx vitest run tests/llm/local-missing-dep.test.ts 2>&1 | tail -20
```

Expected: These tests pass immediately since the adapter is already implemented. If they fail, check that the `ERR_MODULE_NOT_FOUND` handling in `initPipeline` is correct (see Task 3, Step 3).

- [ ] **Step 3: Commit**

```bash
git add tests/llm/local-missing-dep.test.ts
git commit -m "test: ERR_MODULE_NOT_FOUND path via separate mock-throw test file"
```

---

## Task 6: Factory wiring — tests and implementation

**Files:**
- Modify: `tests/llm/factory.test.ts`
- Modify: `src/utils/llm/factory.ts`

This task has one important behavioral change: the existing test "falls back to Gemini+Gemini when text adapter throws on init" tested the old behavior (always fall back to Gemini). The new design surfaces errors when providers are explicitly configured. That test must be updated.

- [ ] **Step 1: Update imports and mocks in `tests/llm/factory.test.ts`**

Open `tests/llm/factory.test.ts`. Add mocks for the two new adapters alongside the existing ones (after the existing `vi.mock` for VoyageAdapter):

```typescript
vi.mock("../../src/utils/llm/adapters/local.js", () => ({
  LocalEmbeddingAdapter: vi.fn(function (this: any) {
    this.generateEmbedding = vi.fn();
    this.generateText = vi.fn().mockRejectedValue(
      new Error("LocalEmbeddingAdapter does not support text generation")
    );
    this.loadPromise = Promise.resolve();
  }),
}));

vi.mock("../../src/utils/llm/adapters/disabledText.js", () => ({
  DisabledTextAdapter: vi.fn(function (this: any) {
    this.generateText = vi.fn().mockRejectedValue(
      new Error("Text generation is not available")
    );
    this.generateEmbedding = vi.fn().mockRejectedValue(
      new Error("DisabledTextAdapter.generateEmbedding should not be called")
    );
  }),
}));
```

Add the new imports at the top of the file (after existing imports):

```typescript
import { LocalEmbeddingAdapter } from "../../src/utils/llm/adapters/local.js";
import { DisabledTextAdapter } from "../../src/utils/llm/adapters/disabledText.js";
const mockLocalAdapter    = vi.mocked(LocalEmbeddingAdapter);
const mockDisabledAdapter = vi.mocked(DisabledTextAdapter);
```

- [ ] **Step 2: Update the existing "falls back to Gemini" test**

Find this test (around line 215 in `tests/llm/factory.test.ts`):

```typescript
it("falls back to Gemini+Gemini when text adapter throws on init", () => {
  mockProviders("openai", "auto", { openai_api_key: "" }); // missing key
  vi.mocked(OpenAIAdapter).mockImplementationOnce(() => {
    throw new Error("Missing API key");
  });

  const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const provider = getLLMProvider();
  expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Falling back to GeminiAdapter for both"));
  expect(GeminiAdapter).toHaveBeenCalledOnce();
  expect(provider).toBeDefined();
  consoleSpy.mockRestore();
});
```

Replace it with TWO tests — one for the explicit case (now throws) and one for the default case (now gracefully falls back):

```typescript
it("throws when EXPLICIT text_provider=openai fails (explicit choice honored)", () => {
  mockProviders("openai", "auto", { openai_api_key: "" });
  vi.mocked(OpenAIAdapter).mockImplementationOnce(() => {
    throw new Error("Missing API key");
  });

  // explicit text_provider=openai → should throw, NOT silently fall back
  expect(() => getLLMProvider()).toThrow("Missing API key");
  expect(GeminiAdapter).not.toHaveBeenCalled();
  expect(mockLocalAdapter).not.toHaveBeenCalled();
});

it("falls back to DisabledTextAdapter when DEFAULT text provider (gemini) fails", () => {
  // text_provider defaults to "gemini" (not explicitly set)
  mockProviders("gemini", "auto");
  vi.mocked(GeminiAdapter).mockImplementationOnce(() => {
    throw new Error("GOOGLE_API_KEY not set");
  });

  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const provider = getLLMProvider();
  expect(mockDisabledAdapter).toHaveBeenCalledOnce();
  // Gemini was tried for text (failed) AND still used for embedding (auto→gemini)
  // so GeminiAdapter is called once for embed (second attempt)
  expect(provider).toBeDefined();
  expect(typeof provider.generateText).toBe("function");
  warnSpy.mockRestore();
});
```

- [ ] **Step 3: Add the 5 new factory test cases**

Append these inside the main `describe` block in `tests/llm/factory.test.ts`:

```typescript
  // ── Local embedding provider ───────────────────────────────────────────────

  it("embedding_provider=local → uses LocalEmbeddingAdapter", () => {
    mockProviders("gemini", "local");
    getLLMProvider();
    expect(mockLocalAdapter).toHaveBeenCalledOnce();
    expect(GeminiAdapter).toHaveBeenCalledOnce(); // text only
    expect(VoyageAdapter).not.toHaveBeenCalled();
    expect(OpenAIAdapter).not.toHaveBeenCalled();
  });

  it("auto-fallback to LocalEmbeddingAdapter when embedding_provider=auto resolve fails", () => {
    // embedding_provider=auto resolves to "gemini"; GeminiAdapter (embed) throws
    mockProviders("anthropic", "auto", { anthropic_api_key: "sk-ant-test" });
    // First GeminiAdapter call (for embed) throws; text (AnthropicAdapter) succeeds
    vi.mocked(GeminiAdapter)
      .mockImplementationOnce(function (this: any) {
        // The text uses Anthropic, embed tries Gemini — make the embed call throw
        throw new Error("GOOGLE_API_KEY not set");
      });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const provider = getLLMProvider();
    expect(mockLocalAdapter).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("re-index"));
    expect(provider).toBeDefined();
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it("auto-fallback log mentions embedding model change risk", () => {
    mockProviders("gemini", "auto");
    vi.mocked(GeminiAdapter).mockImplementationOnce(() => {
      throw new Error("GOOGLE_API_KEY not set");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    getLLMProvider();
    const calls = warnSpy.mock.calls.map(([msg]) => msg as string);
    const hasReindexWarning = calls.some((msg) => msg?.includes("re-index"));
    expect(hasReindexWarning).toBe(true);
    warnSpy.mockRestore();
  });

  it("DisabledTextAdapter.generateText() throws concise message without env var names", async () => {
    mockProviders("gemini", "auto");
    vi.mocked(GeminiAdapter).mockImplementationOnce(() => {
      throw new Error("GOOGLE_API_KEY not set");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const provider = getLLMProvider();
    try {
      await provider.generateText("hello");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("not available");
      expect(msg).not.toContain("GOOGLE_API_KEY");
      expect(msg).not.toContain("OPENAI_API_KEY");
      expect(msg).not.toContain("ANTHROPIC_API_KEY");
    }
    warnSpy.mockRestore();
  });

  it("explicit embedding_provider=voyage + voyage fails → throws (not overridden)", () => {
    mockProviders("gemini", "voyage", { voyage_api_key: "" });
    vi.mocked(VoyageAdapter).mockImplementationOnce(() => {
      throw new Error("Voyage AI API key not set");
    });
    expect(() => getLLMProvider()).toThrow("Voyage AI API key not set");
    expect(mockLocalAdapter).not.toHaveBeenCalled();
  });
```

- [ ] **Step 4: Run factory tests (RED — should fail until factory is updated)**

```bash
cd /Users/geraldonyango/Documents/dev/prism-mcp && npx vitest run tests/llm/factory.test.ts 2>&1 | tail -40
```

Expected: New tests fail. The "throws when EXPLICIT text_provider=openai fails" test will fail because the current factory still falls back to Gemini instead of throwing.

- [ ] **Step 5: Update factory.ts imports**

Open `src/utils/llm/factory.ts`. Add imports for the new adapters after the VoyageAdapter import:

```typescript
import { LocalEmbeddingAdapter } from "./adapters/local.js";
import { DisabledTextAdapter } from "./adapters/disabledText.js";
```

- [ ] **Step 6: Update `buildEmbeddingAdapter` in factory.ts**

Find the existing `buildEmbeddingAdapter` function and add the `"local"` case:

```typescript
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

- [ ] **Step 7: Refactor `getLLMProvider` in factory.ts**

Replace the entire `getLLMProvider` function body (keeping the JSDoc comment above it) with:

```typescript
export function getLLMProvider(): LLMProvider {
  if (providerInstance) return providerInstance;

  const textType            = getSettingSync("text_provider", "gemini");
  const originalEmbedSetting = getSettingSync("embedding_provider", "auto");
  let embedType             = originalEmbedSetting;

  if (embedType === "auto") {
    embedType = textType === "anthropic" ? "gemini" : textType;
    if (textType === "anthropic") {
      console.info(
        "[LLMFactory] text_provider=anthropic with embedding_provider=auto: " +
        "routing embeddings to GeminiAdapter (Anthropic has no native embedding API). " +
        "For the Anthropic-recommended pairing, set embedding_provider=voyage in the dashboard " +
        "(voyage-3 supports 768-dim output via MRL). " +
        "Alternatively, set embedding_provider=openai to use Ollama/OpenAI."
      );
    }
  }

  // ── Build text adapter ─────────────────────────────────────────────────────
  // Explicit text_provider choice (anything other than the default "gemini") is
  // honored: failures surface as errors rather than silent fallback.
  let textAdapter: LLMProvider;
  try {
    textAdapter = buildTextAdapter(textType);
  } catch (textErr) {
    if (textType !== "gemini") {
      // User explicitly configured a text provider — surface the error.
      throw textErr;
    }
    // Default Gemini text provider failed (no API key configured) → degrade.
    console.warn(
      `[LLMFactory] Default text provider (gemini) failed to init: ` +
      `${textErr instanceof Error ? textErr.message : String(textErr)}. ` +
      `Text generation will be unavailable. Set GOOGLE_API_KEY or configure ` +
      `a text provider in the dashboard.`
    );
    textAdapter = new DisabledTextAdapter();
  }

  // ── Build embedding adapter ────────────────────────────────────────────────
  // Explicit embedding_provider choice is honored: failures surface as errors.
  // embedding_provider=auto failures degrade to LocalEmbeddingAdapter.
  let embedAdapter: LLMProvider;
  try {
    embedAdapter = buildEmbeddingAdapter(embedType);
  } catch (embedErr) {
    if (originalEmbedSetting !== "auto") {
      // User explicitly set embedding_provider — honor that choice.
      throw embedErr;
    }
    // Auto-resolved embedding provider failed → fall back to local.
    console.warn(
      `[LLMFactory] embedding_provider=auto resolved to "${embedType}" but failed: ` +
      `${embedErr instanceof Error ? embedErr.message : String(embedErr)}. ` +
      `Falling back to LocalEmbeddingAdapter. ` +
      `⚠️  Embedding model has changed. Existing vectors may be incompatible — ` +
      `re-index all entries to restore search quality.`
    );
    embedAdapter = new LocalEmbeddingAdapter();
  }

  // ── Compose and wrap ───────────────────────────────────────────────────────
  const composed: LLMProvider = {
    generateText:      textAdapter.generateText.bind(textAdapter),
    generateEmbedding: embedAdapter.generateEmbedding.bind(embedAdapter),
  };
  if (textAdapter.generateImageDescription) {
    composed.generateImageDescription = textAdapter.generateImageDescription.bind(textAdapter);
  }

  if (textType !== embedType) {
    console.info(`[LLMFactory] Split provider: text=${textType}, embedding=${embedType}`);
  }

  providerInstance = new TracingLLMProvider(composed, textType);
  return providerInstance;
}
```

- [ ] **Step 8: Run all factory tests (GREEN)**

```bash
cd /Users/geraldonyango/Documents/dev/prism-mcp && npx vitest run tests/llm/factory.test.ts 2>&1 | tail -50
```

Expected: all tests pass. Watch for:
- "Singleton" test: should still work (GeminiAdapter × 2 on first call, same instance on second)
- "Gemini+Gemini default" test: GeminiAdapter called twice (text + embed)
- The new "explicit text throws" test: verify factory throws, not falls back
- The new "local" routing test: LocalEmbeddingAdapter constructed

If the "Singleton" test says `GeminiAdapter called 4 times` instead of 2: check that the singleton path (`if (providerInstance) return providerInstance`) is reached on the second call.

- [ ] **Step 9: Commit factory changes**

```bash
git add src/utils/llm/factory.ts tests/llm/factory.test.ts src/utils/llm/adapters/local.ts
git commit -m "feat(GREEN): factory wiring — local case, split try/catch, explicit-choice-preserving fallback"
```

---

## Task 7: Full test suite + TypeScript build

**Files:** none — verification only

- [ ] **Step 1: Run full test suite**

```bash
cd /Users/geraldonyango/Documents/dev/prism-mcp && npm test 2>&1 | tail -50
```

Expected: all tests pass with zero failures. If existing tests fail, check:
- The "Gemini+Gemini singleton" test — `GeminiAdapter` called count may have changed
- The "anthropic auto-bridge" test — still works (logic is preserved in new getLLMProvider)
- The "split provider" tests — still work

- [ ] **Step 2: TypeScript build**

```bash
cd /Users/geraldonyango/Documents/dev/prism-mcp && npm run build 2>&1 | head -30
```

Expected: zero errors. Common errors to fix:
- `FeatureExtractionPipeline` type not found → already handled with callable type in `local.ts`
- `dtype` not in pipeline options type → add `as any` or type assertion on the options object if needed: `{ dtype, revision } as Record<string, unknown>`
- `loadPromise` not accessible in test → already declared as `readonly`

- [ ] **Step 3: Fix any build errors then re-run tests**

If `npm run build` reports type errors for the pipeline options (transformers.js v3 types may not include `dtype` in the options type definition), update the pipeline call in `local.ts`:

```typescript
const pipelineInstance = await (transformers as any).pipeline(
  "feature-extraction",
  model,
  { dtype, revision },
);
```

Or cast only the options:
```typescript
const pipelineInstance = await transformers.pipeline(
  "feature-extraction",
  model,
  { dtype, revision } as Parameters<typeof transformers.pipeline>[2],
);
```

Re-run tests after any fix to confirm nothing broke.

- [ ] **Step 4: Commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: resolve tsc type errors for transformers.js pipeline options"
```

---

## Task 8: Simplify and clean up

- [ ] **Step 1: Review changed files for duplication and clarity**

Check these specific things:

1. `src/utils/llm/adapters/local.ts`: does the `initPipeline` error handling have any redundancy? Is `this.pipe` ever accessed after `loadError` is set? (It shouldn't be — the guard `if (this.loadError) throw` fires first.)

2. `src/utils/llm/factory.ts`: are the two warn messages (text fallback and embedding fallback) distinct enough that an operator can tell them apart in logs? They should both include `[LLMFactory]` and different context.

3. `tests/llm/local.test.ts`: the `beforeEach` clears `process.env.LOCAL_EMBEDDING_MODEL` and `process.env.HF_ENDPOINT`. Verify this prevents test pollution.

- [ ] **Step 2: Commit any simplifications**

```bash
git add -A
git commit -m "refactor: simplify local adapter and factory after review"
```

---

## Task 9: Final commit

- [ ] **Step 1: Run full test suite one more time**

```bash
cd /Users/geraldonyango/Documents/dev/prism-mcp && npm test 2>&1 | tail -20
```

Expected: all tests pass, zero failures.

- [ ] **Step 2: Run build one more time**

```bash
cd /Users/geraldonyango/Documents/dev/prism-mcp && npm run build 2>&1 | tail -10
```

Expected: zero errors.

- [ ] **Step 3: Verify git log shows feature branch with clean commits**

```bash
git log --oneline feat/local-embeddings-transformers-js 2>&1 | head -15
```

- [ ] **Step 4: Final summary commit if needed**

If there are any uncommitted changes:

```bash
git add -A
git commit -m "feat: local embedding provider via transformers.js + nomic-embed-text-v1.5

Adds LocalEmbeddingAdapter using @huggingface/transformers (optional peer dep)
to generate 768-dim embeddings fully locally. Factory falls back to Local when
embedding_provider=auto and all configured API keys are absent. Explicit provider
choices throw on failure rather than silently degrading.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Self-Review Checklist

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| `LocalEmbeddingAdapter` implements `LLMProvider` | Task 3 |
| `DisabledTextAdapter` stub | Task 2 |
| Model ID validation (rejects paths/URLs) | Task 3 |
| `dtype: "q8"` (not `quantized:boolean`) | Task 3 |
| `Array.from(result.data)` Tensor extraction | Task 3 |
| Warmup non-fatal | Task 3 |
| Background init (non-blocking constructor) | Task 3 |
| Factory "local" case in `buildEmbeddingAdapter` | Task 6 |
| Separate text/embed try/catch in factory | Task 6 |
| Explicit choices throw; auto paths degrade | Task 6 |
| `@huggingface/transformers` optional peer dep | Task 1 |
| `~3.1.0` semver + exact devDep | Task 1 |
| `DEFAULT_REVISION` pin | Task 3 |
| `HF_ENDPOINT` warning | Task 3 |
| 13 adapter unit tests | Task 4 |
| ERR_MODULE_NOT_FOUND test | Task 5 |
| 5 new factory tests (14–18) | Task 6 |
| Updated "explicit throws" factory test | Task 6 |
| `npm test` passes | Task 7 |
| `npm run build` passes | Task 7 |

All spec requirements have a corresponding task. No gaps.
