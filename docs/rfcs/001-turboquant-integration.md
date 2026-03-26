# RFC-001: Quantized Agentic Memory (TurboQuant Integration)

**Status:** In Progress (Phase 1 Complete)  
**Author(s):** Prism Core Team  
**Created:** 2026-03-26  
**Target Version:** v5.0  

---

## Summary

Integrate Google's [TurboQuant](https://arxiv.org/abs/2504.19874) (ICLR 2026) vector quantization into Prism's embedding storage pipeline, compressing 768-dim `float32` embeddings (~3,072 bytes) to 3-bit quantized blobs (~288 bytes) — a **~10× storage reduction** with zero accuracy loss. This enables local-first users to maintain years of session history with negligible disk overhead.

This is a capability **no other MCP server has**: Quantized Agentic Memory.

## Motivation

Prism's semantic search stores 768-dim `float32` embeddings for every ledger entry. At scale:

| Entries | Current (float32) | With TurboQuant (turbo3) |
|---|---|---|
| 1,000 | ~3 MB | ~300 KB |
| 10,000 | ~30 MB | ~3 MB |
| 100,000 | ~300 MB | ~30 MB |

For a local-first tool promising years of persistent memory, 10× compression is transformative.

## Design

### TurboQuant Pipeline (Two Stages)

```
Input: float32[768] embedding
  │
  ├─ Stage 1: PolarQuant ──────────────────────────────────
  │   1. Apply Fast Walsh-Hadamard Transform (FWHT)  ← O(d log d)
  │   2. Convert to polar coordinates (radius + angles)
  │   3. Apply Lloyd-Max optimal scalar quantizer to angles
  │   → Output: quantized angles (majority of bits) + radius (1x float32)
  │
  └─ Stage 2: QJL Error Correction ────────────────────────
      1. Compute residual error from Stage 1
      2. Random projection → keep only sign bits (+1/-1)
      → Output: 1-bit error correction vector
  
Result: ~288-byte compressed blob + 4-byte radius float
```

#### Critical Implementation Detail: FWHT

The "random rotation" in PolarQuant uses a **Fast Walsh-Hadamard Transform** — not a generic random matrix. This runs in O(d log d) instead of O(d²), making it fast enough for the Node.js event loop without blocking. Zero-dependency JS implementations exist and port trivially to TypeScript.

### Two-Tier Search Architecture

Since `sqlite-vec` and `pgvector` only understand `float32` arrays, we **cannot** use their native search functions on compressed blobs. Instead:

```
searchMemory(query) →
  ├─ Tier 1: FTS5 keyword search OR lightweight candidate filter
  │  → Returns top ~100 candidate entry IDs
  │
  └─ Tier 2: Asymmetric Similarity (in JS)
     → query as float32 vs stored turbo3 blobs
     → Rank by TurboQuant's asymmetric attention score
     → Return top-K results
```

This bypasses the need for custom C++ SQLite extensions while still getting 10× storage savings.

### Storage Schema Changes

#### `LedgerEntry` (interface.ts)
```typescript
embedding?: string;              // Existing: JSON-stringified float32[]
embedding_compressed?: string;   // NEW: base64-encoded turbo3 blob
embedding_format?: 'float32' | 'turbo3' | 'turbo4'; // NEW: format discriminator
embedding_turbo_meta?: string;   // NEW: PolarQuant radius (magnitude)
```

Storing the radius separately (4-byte float) enables fast asymmetric scoring without decompressing the entire vector.

### New Module

#### `src/utils/turboquant.ts`
Pure TypeScript implementation:
- `compress(embedding: number[]): { blob: Buffer; radius: number }`
- `asymmetricSimilarity(query: number[], blob: Buffer, radius: number): number`
- Internal: `fwht()`, `polarQuantize()`, `qjlCorrect()`

## Verification Plan

Use Prism's existing 185-test suite plus:

```typescript
// Core invariant: compressed similarity must be near-identical to float32
const emb = await llm.generateEmbedding("test text");
const compressed = turboCompress(emb);
const score = asymmetricSimilarity(emb, compressed);
assert(score > 0.99, "Compression must preserve >99% similarity");
```

## Migration

- **Backward compatible**: Existing `float32` embeddings remain valid
- New entries get `turbo3` format; old entries searchable via fallback path
- Optional `prism migrate --compress-embeddings` CLI command for bulk conversion

## Phases

| Phase | Scope | Effort |
|---|---|---|
| **0 — Docs** | Document `OLLAMA_KV_CACHE_TYPE=turbo3` in self-hosting README | ~1 hour |
| **1 — TurboPalace** | Standalone `src/utils/turboquant.ts` with FWHT + PolarQuant + QJL | 2-3 sessions |
| **2 — Storage** | Add `embedding_format` + `embedding_turbo_meta` to schema + migration | 1 session |
| **3 — Search** | Two-Tier search in `searchMemory()` with asymmetric scoring | 1 session |

## References

- [TurboQuant paper (ICLR 2026)](https://arxiv.org/abs/2504.19874)
- [QJL (AAAI 2025)](https://arxiv.org/abs/2406.03482)
- [PolarQuant (AISTATS 2026)](https://arxiv.org/abs/2502.02617)
- [tonbistudio/turboquant-pytorch](https://github.com/tonbistudio/turboquant-pytorch) — community PyTorch reference
- [llama.cpp turbo3/turbo4 support](https://github.com/ggerganov/llama.cpp) — `--cache-type-k turbo3`
