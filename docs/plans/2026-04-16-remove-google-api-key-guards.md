# Remove Hardcoded GOOGLE_API_KEY Guards Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace all hardcoded `GOOGLE_API_KEY` checks that gate embedding functionality with provider-aware capability checks, so local embeddings (and any future provider) work without requiring a Google API key.

**Architecture:** The factory (`src/utils/llm/factory.ts`) already supports local embeddings via `embedding_provider=local`. The problem is that handler code in `graphHandlers.ts` and `ledgerHandlers.ts` bypasses the factory entirely by checking for `GOOGLE_API_KEY` before calling `getLLMProvider().generateEmbedding()`. The fix adds an `embeddingsAvailable()` helper to the factory that checks whether the configured provider can actually generate embeddings, and replaces all `GOOGLE_API_KEY` guards with calls to this helper.

**Tech Stack:** TypeScript, Vitest, MCP server (stdio)

---

### Task 1: Add `embeddingsAvailable()` helper to factory

**Files:**
- Modify: `src/utils/llm/factory.ts`
- Test: `tests/llm/factory.test.ts`

**Step 1: Write the failing test**

In `tests/llm/factory.test.ts`, add a new describe block:

```typescript
describe("embeddingsAvailable()", () => {
  it("returns true when embedding_provider=local", () => {
    mockProviders("none", "local");
    expect(embeddingsAvailable()).toBe(true);
  });

  it("returns true when embedding_provider=gemini (default)", () => {
    mockProviders("gemini", "auto");
    expect(embeddingsAvailable()).toBe(true);
  });

  it("returns true when embedding_provider=voyage", () => {
    mockProviders("gemini", "voyage");
    expect(embeddingsAvailable()).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/llm/factory.test.ts`
Expected: FAIL — `embeddingsAvailable` is not exported

**Step 3: Implement `embeddingsAvailable()`**

In `src/utils/llm/factory.ts`, add after `getLLMProvider()`:

```typescript
/**
 * Returns true if the configured embedding provider is expected to work.
 * Use this instead of checking for specific API keys (e.g. GOOGLE_API_KEY).
 * The factory always resolves to *some* embedding adapter, so this returns
 * true as long as the factory initialized without falling back to a
 * provider that will throw on first call.
 *
 * This is a synchronous, cheap check — it does NOT call generateEmbedding().
 */
export function embeddingsAvailable(): boolean {
  try {
    getLLMProvider(); // ensure singleton is initialized
    return true;
  } catch {
    return false;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/llm/factory.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat: add embeddingsAvailable() helper to LLM factory
```

---

### Task 2: Fix `graphHandlers.ts` — semantic search guard

**Files:**
- Modify: `src/tools/graphHandlers.ts`
- Test: `tests/tools/graphHandlers.test.ts`

**Step 1: Replace the GOOGLE_API_KEY guard**

At line ~395, replace:

```typescript
if (!GOOGLE_API_KEY) {
  return {
    content: [{
      type: "text",
      text: `❌ Semantic search requires GOOGLE_API_KEY for embedding generation.\n` +
        `Set this environment variable and restart the server.\n\n` +
        `💡 As a workaround, try knowledge_search (keyword-based) instead.`,
    }],
    isError: true,
  };
}
```

With:

```typescript
if (!embeddingsAvailable()) {
  return {
    content: [{
      type: "text",
      text: `❌ Semantic search requires an embedding provider.\n` +
        `Configure embedding_provider in the Mind Palace dashboard ` +
        `(local, gemini, openai, or voyage) and restart the server.\n\n` +
        `💡 As a workaround, try knowledge_search (keyword-based) instead.`,
    }],
    isError: true,
  };
}
```

Also update the import at the top: add `embeddingsAvailable` from `../utils/llm/factory.js` and remove `GOOGLE_API_KEY` from the config import if no other usage remains in this file.

**Step 2: Update the "no results" hint at line ~494**

Replace `requires GOOGLE_API_KEY` reference with generic embedding provider message.

**Step 3: Run tests**

Run: `npx vitest run tests/tools/graphHandlers.test.ts`
Expected: PASS (or fix any test that asserts on the old error message)

**Step 4: Commit**

```
fix: replace GOOGLE_API_KEY guard in semantic search with embeddingsAvailable()
```

---

### Task 3: Fix `ledgerHandlers.ts` — five GOOGLE_API_KEY guards

**Files:**
- Modify: `src/tools/ledgerHandlers.ts`

**Locations to fix:**

1. **Line ~144** — `session_save_ledger` fire-and-forget embedding:
   Replace `if (GOOGLE_API_KEY && result)` with `if (embeddingsAvailable() && result)`

2. **Line ~254** — `session_save_ledger` response message:
   Replace `(GOOGLE_API_KEY ? "📊 Embedding..." : "")` with `(embeddingsAvailable() ? "📊 Embedding..." : "")`

3. **Line ~531** — `session_save_handoff` fact merger guard:
   Replace `if (GOOGLE_API_KEY && data.status === "updated" && key_context)` with `if (embeddingsAvailable() && data.status === "updated" && key_context)`
   Note: factMerger uses `generateText()` not `generateEmbedding()`. The guard here should check if the text provider is available too. But the factMerger already handles errors gracefully (fire-and-forget with catch). Keep using `embeddingsAvailable()` for now since it's the same "is an LLM configured" signal — the factMerger will throw its own error if text is disabled.

4. **Line ~904** — `session_load_context` SDM intuitive recall:
   Replace `if (level !== "quick" && GOOGLE_API_KEY)` with `if (level !== "quick" && embeddingsAvailable())`

5. **Line ~1384** — `session_save_experience` fire-and-forget embedding:
   Replace `if (GOOGLE_API_KEY && result)` with `if (embeddingsAvailable() && result)`

**Step 1: Make all five replacements**

Add `import { embeddingsAvailable } from "../utils/llm/factory.js"` (it already imports `getLLMProvider` from there).

Remove `GOOGLE_API_KEY` from the config import if no other usage remains.

**Step 2: Run tests**

Run: `npx vitest run tests/tools`
Expected: PASS

**Step 3: Commit**

```
fix: replace GOOGLE_API_KEY guards in ledgerHandlers with embeddingsAvailable()
```

---

### Task 4: Fix dashboard `server.ts` error message

**Files:**
- Modify: `src/dashboard/server.ts:1011`

**Step 1: Update error message**

Replace:
```typescript
return res.end(JSON.stringify({ error: "LLM Provider not configured for semantic search. Provide a GOOGLE_API_KEY or equivalent." }));
```

With:
```typescript
return res.end(JSON.stringify({ error: "LLM Provider not configured for semantic search. Configure an embedding provider in the Mind Palace dashboard." }));
```

This endpoint already uses try/catch around `getLLMProvider()` — no guard replacement needed, just the error message text.

**Step 2: Commit**

```
fix: update dashboard semantic search error to not reference GOOGLE_API_KEY
```

---

### Task 5: Update comments referencing GOOGLE_API_KEY as embedding requirement

**Files:**
- Modify: `src/tools/definitions.ts:253` — update comment
- Modify: `src/utils/factMerger.ts:32` — update comment
- Modify: `src/utils/llm/factory.ts` — update header doc comment to mention local provider

**Step 1: Update each comment**

- `definitions.ts:253`: Change "Requires GOOGLE_API_KEY" to "Requires a configured text provider (Gemini, OpenAI, or Anthropic)"
- `factMerger.ts:32`: Change "GOOGLE_API_KEY must be set" to "A text provider must be configured"
- `factory.ts` header: Add `"local"` to the embedding_provider options list in the header comment

**Step 2: Commit**

```
docs: update comments to reflect provider-agnostic embedding support
```

---

### Task 6: Run full test suite and build

Run: `npx vitest run && npm run build`
Expected: All tests pass, build succeeds.
