# Prism: Wow Features

A citation-grade catalogue of Prism's algorithms — what each one does, where it lives, and how external systems can reuse it.

This document was written for engineers building dev-tools / agents / hooks on top of Prism who want their thresholds backed by published implementations rather than guesswork. Every entry below names the source file and line range.

---

## The reuse pattern

When you adopt a Prism algorithm in your own codebase, port it with a citation comment:

```python
# Cited: actrActivation.ts:38 — ACT_R_DEFAULT_DECAY
ACT_R_DEFAULT_DECAY = 0.5
```

Pin the Prism version you're sourcing from. When Prism's CHANGELOG flags a deprecation cycle on the constant, your CI catches the divergence.

---

## 1. ACT-R cognitive memory decay

**Where:** [`src/utils/actrActivation.ts`](../src/utils/actrActivation.ts)
**Stable since:** v14.0.0

ACT-R (Adaptive Control of Thought—Rational) is a 30-year-old cognitive architecture from Carnegie Mellon. It models how human memory weights past experiences: more recent + more frequent → higher activation. Prism uses it to re-rank retrieval results.

### Equations

```
B_i  = ln(Σ t_j^(-d))                    # base-level activation
σ(x) = 1 / (1 + e^(-k(x - x₀)))          # parameterized sigmoid
Score = w_sim × similarity + w_act × σ(B + S)
```

### Constants (cited)

| Constant | Value | Source line | What it controls |
|---|---|---|---|
| `ACT_R_DEFAULT_DECAY` | 0.5 | actrActivation.ts:38 | Decay rate `d`. Higher = faster forgetting. ACT-R paper default. |
| `ACTIVATION_FLOOR` | -10.0 | actrActivation.ts:41 | Returned when no access history exists (guards against -∞). |
| `MIN_TIME_DELTA_SECONDS` | 1.0 | actrActivation.ts:48 | Time clamp `t ≥ 1.0s` prevents Infinity from sub-second deltas. |
| `DEFAULT_SIGMOID_MIDPOINT` | -2.0 | actrActivation.ts:51 | B = -2 → σ = 0.5 (calibrated for ACT-R activation distribution, not standard sigmoid centered at 0). |
| `DEFAULT_SIGMOID_STEEPNESS` | 1.0 | actrActivation.ts:54 | k parameter. Higher = sharper discrimination. |
| `DEFAULT_WEIGHT_SIMILARITY` | 0.7 | actrActivation.ts:57 | Weight on similarity in composite score. |
| `DEFAULT_WEIGHT_ACTIVATION` | 0.3 | actrActivation.ts:60 | Weight on activation. Similarity dominates; activation re-ranks. |

### Calibrated sigmoid values (pin in your tests)

```
B = -10  → σ ≈ 0.0003     (dead memory)
B =  -5  → σ ≈ 0.047       (cold memory, minimal boost)
B =  -2  → σ = 0.50        (midpoint)
B =   0  → σ ≈ 0.88        (fresh memory, strong boost)
B =  +3  → σ ≈ 0.99        (hot memory, maximum boost)
```

### When to use which decay rate

- **`d = 0.5` (raw)** — for episodic chatter. A single access becomes "stale" (σ < 0.15) within ~30 minutes.
- **`d = 0.25` (rollup, half rate)** — for long-term lessons. A single access stays active for ~31 days; 3 citations stay active for ~8 months. Per `graphHandlers.ts:553`, rollups use this rate so long-term context survives.

If you're storing "things the user wants the system to remember" (gotchas, lessons, recurring corrections), use `d = 0.25` — they're lessons by nature, not chatter.

---

## 2. Spreading activation hybrid score

**Where:** [`src/memory/spreadingActivation.ts`](../src/memory/spreadingActivation.ts)
**Stable since:** v14.0.0

Combines direct similarity with graph-traversal energy.

```typescript
node.hybridScore = (node.similarity * 0.7) + (activationScore * 0.3);
```

### Reusable as a generic blend

Any system that has BOTH a "direct user-signal" term AND a "background graph context" term can reuse the 0.7/0.3 split. We've used the same coefficients elsewhere because they happen to match the cognitive-architecture convention (`actrActivation.ts:57-60`).

Example: in the audit hooks framework's prompt scorer:

```python
# spreadingActivation.ts:128 — same blend, different terms
score(P) = 0.7 * user_text_signal + 0.3 * graph_signal
```

### Other constants in the module

| Constant | Value | Source line | Reused as |
|---|---|---|---|
| `T` (iterations) | 3 | spreadingActivation.ts:17 | Maximum hop count for traversal (don't go more than 3 deep). |
| `S` (spread factor) | 0.8 | spreadingActivation.ts:18 | Forward propagation gain on each hop. |
| `S × 0.5` (back-flow) | 0.4 | spreadingActivation.ts:79 | Backward edges weighted at half — failures shouldn't penalize at the same rate successes boost. |
| `softM` (soft inhibition) | 20 | spreadingActivation.ts:19 | Top-N candidates kept during propagation. |
| `finalM` (final inhibition) | 7 | spreadingActivation.ts:20 | Top-N candidates returned. **Miller's Law cap.** |

---

## 3. Experience bias (warm-corpus adjustments)

**Where:** [`src/tools/routerExperience.ts`](../src/tools/routerExperience.ts)
**Stable since:** v14.0.0

When you have a corpus of past outcomes and want to bias the current decision toward what's worked before, the formula is:

```typescript
const bias = (winRate - 0.5) * (MAX_BIAS_CAP * 2);
```

### Constants

| Constant | Value | Source line | Semantics |
|---|---|---|---|
| `MAX_BIAS_CAP` | 0.15 | routerExperience.ts:6 | Maximum ± adjustment from prior outcomes. Even 100% wins can only shift confidence by 15%. |
| `MIN_SAMPLES` | 5 | routerExperience.ts:8 | **Cold-start gate.** Below 5 similar prior samples, return `bias=0` regardless of win rate. |

### Why ±0.15 cap

15% is "noticeable but not overriding." The system's primary signal is still the current request's content; experience bias modulates confidence at the margins. Without a cap, a streak of identical successes would lock in a behavior that the user can't easily override.

### Why 5 samples

Below 5, win rate is either 0 or 1 with high probability — the bias signal is too noisy to trust. ACT-R's analogue is "no activation without access history."

### Reuse pattern

Any system that wants to learn from past success/failure on a per-fingerprint basis: port the formula verbatim. The audit hooks framework uses it to scale tier-escalation thresholds — fingerprints that historically succeed intervene earlier; ones that fail get more rope.

---

## 4. Graph-metrics warning thresholds

**Where:** [`src/observability/graphMetrics.ts`](../src/observability/graphMetrics.ts)
**Stable since:** v14.0.0

Per-rate ratio thresholds at which Prism flags a system in distress.

| Threshold | Value | Source lines | What it means |
|---|---|---|---|
| `synthesis_failure_warning` | > 0.20 fail rate, ≥ 5 runs | graphMetrics.ts:481-483 | "20% of recent runs failed — investigate before continuing." |
| `cognitive_fallback_rate_warning` | > 0.30 fallback rate, ≥ 10 evals | graphMetrics.ts:486-488 | "30%+ of decisions are deferred to fallback — the primary classifier needs help." |
| `cognitive_ambiguity_rate_warning` | > 0.40 ambiguous, ≥ 10 evals | graphMetrics.ts:491-493 | "40%+ of decisions are ambiguous — the input space exceeds classifier capacity." |
| `synthesis_quality_warning` | > 0.85 below-threshold ratio, ≥ 50 candidates | graphMetrics.ts:472-474 | "85% of candidates fall below the quality bar — the source is degrading." |

### Reuse pattern: tier-escalation

In a sequential decision system (turn-by-turn coding agent, request-by-request RPC, etc.), these ratios map cleanly to tier-counts when scaled to typical run length:

```
Tier 1 trigger : N_negative >= 0.20 × typical_run_length   (synthesis_failure)
Tier 2 trigger : N_negative >= 0.30 × typical_run_length   (cognitive_fallback)
Tier 3 trigger : N_negative >= 0.40 × typical_run_length   (cognitive_ambiguity)
Tier 4 trigger : N_negative >= 0.50 × typical_run_length   (catastrophic)
```

The audit hooks framework uses exactly this mapping with `typical_run_length = 10` to derive tier counts of 2 / 3 / 4 / 5+.

### Sample-size gates

The minimum-sample requirement (≥ 5, ≥ 10, ≥ 50) is what keeps the warnings from firing on noise. **Always pair a ratio threshold with a minimum sample count.** Single data points are not signal.

---

## 5. Soft-prune threshold

**Where:** [`src/config.ts`](../src/config.ts)
**Stable since:** v14.0.0

```typescript
export const PRISM_GRAPH_PRUNE_MIN_STRENGTH = parseFloat(
  process.env.PRISM_GRAPH_PRUNE_MIN_STRENGTH || "0.15"
);
```

### Use cases

- **Filtering weak graph links** during retrieval traversal (the original use).
- **Filtering decayed memories** below activation strength of 0.15. Reusable: any normalized-activation source feeds the same threshold.
- **Cutoff for "stale lessons"** in long-term reuse contexts.

### Why 0.15

Empirically calibrated such that:
- Single access ~31 days ago at `d=0.25` decay rate → ~ 0.30 (still active)
- 3 citations 5 years ago at `d=0.25` → ~ 0.15 (at threshold)
- Single access ~30 minutes ago at `d=0.5` (raw) → ~ 0.15 (at threshold)

The number is not arbitrary. It's the activation level at which retrieval stops adding value to ranking — below 0.15 the contribution disappears in the noise of similarity scoring.

---

## 6. Compaction prompt-budget cap

**Where:** [`src/tools/compactionHandler.ts`](../src/tools/compactionHandler.ts)
**Stable since:** v14.0.0

```typescript
const MAX_ENTRIES_CHARS = 25_000;
```

### When to use

Anywhere you're stuffing user-controlled content into an LLM prompt. The 25KB cap is small enough to leave room for system prompts and response budget on a typical 32K-context model, large enough to hold ~50 substantial entries.

### Pair with truncation discipline

Truncate at logical boundaries (entries, paragraphs), not character offsets — slicing a structured tag mid-string produces malformed input.

```typescript
// Cite the rule when implementing a parallel cap elsewhere:
const MAX_INJECT_CHARS = 25_000;  // compactionHandler.ts:81 — same prompt-budget convention
```

### Other compaction defaults worth pinning

| Constant | Value | Source | Use |
|---|---|---|---|
| `threshold` | 50 entries | compactionHandler default arg | Entry count at which compaction kicks in. |
| `keep_recent` | 10 entries | compactionHandler default arg | Always preserve the N newest entries uncompacted. |
| `COMPACTION_CHUNK_SIZE` | 10 | compactionHandler.ts:19 | Batch size for LLM summarization passes. |
| `MAX_ENTRIES_PER_RUN` | 100 | compactionHandler.ts:20 | Hard cap on per-run work. |

---

## 7. HRR zero-search retrieval

**Where:** Synalux portal engine (HRR core + Rust WASM bindings)
**Stable since:** v16.0.0

Holographic Reduced Representations encode key-value pairs into a single fixed-size vector via circular convolution. Retrieval is a mathematical unbind — no index, no database, no network. ~0.2ms per probe.

### Equations

```
Encode:  hologram += FFT⁻¹(FFT(key) ⊙ FFT(value))
Probe:   result   = FFT⁻¹(FFT(hologram) ⊙ conj(FFT(query)))
Cleanup: argmax cosine_similarity(result, known_concepts)
```

Based on Tony Plate's HRR (1995). The WASM implementation uses `rustfft` for O(n log n) convolution.

### Constants (cited)

| Constant | Value | Source | What it controls |
|---|---|---|---|
| `DIM` | 1024 | hrrContext.ts:17, engine.ts:106 | Holographic vector dimension. Capacity ≈ √dim ≈ 32 concepts before interference. |
| `MAX_CONCEPTS` | 10,000 | engine.ts:149 | LRU eviction threshold for concept→summary map. |
| `MIN_PHRASE_WORDS` | 2 | hrrContext.ts:18 | Single-word phrases skip n-gram encoding (no bigram signal). |
| `MAX_PHRASE_LEN` | 500 | hrrContext.ts:19 | Input length cap for AAC phrase encoding. |
| `SAVE_DEBOUNCE_MS` | 5,000 | engine.ts:22, hrrContext.ts:190 | Persistence debounce (localStorage / Supabase). |
| `confidenceThreshold` | 0.15 | types.ts:16 | Minimum similarity for HRR to short-circuit FTS5 fallback. |

### Retrieval cascade

HRR is Tier 0 in a 3-tier cascade:

```
Query → HRR probe (~0.2ms)
         ├─ confidence > 0.15 → return (skip tiers 1-2)
         └─ confidence < 0.15 → fall through
       → FTS5 keyword search (~50ms)
       → Supabase vector search (~200ms)
```

### Embedding strategies

The adaptive strategy picker (adaptive.ts) selects the best embedding for HRR encoding:

| Strategy | When | Accuracy | Latency | Source |
|---|---|---|---|---|
| GloVe (50K words, 50-dim) | Offline, model loaded | 87% Top-1 | ~0.2ms | embeddings.ts:loadGlove |
| API (Gemini/Voyage pre-computed) | Online, embedding available | 90%+ | 0ms | embeddings.ts:apiEmbeddingToHrr |
| NeurIPS 2021 projection | Always (additive, stacks on top) | +20% boost | +0.05ms | embeddings.ts:neuripsProjection |
| Hash fallback | No GloVe, no API | ~30% | ~0.1ms | embeddings.ts:hashEmbed |

### AAC n-gram encoding

For word prediction, spoken phrases are encoded as bigrams + trigrams:

```
Phrase: "I want water"
→ phrase:  "I want water" → "I want water"
→ bigram:  "w:i"          → "want"
→ bigram:  "w:want"       → "water"
→ trigram: "w:i want"     → "water"
```

Probe returns the concept KEY; use `get_summary(key)` to retrieve the actual next word.

### Benchmark (10 scenarios, 69 tests)

| Scenario | Baseline Top-1 | +HRR Top-1 | MRR Lift |
|---|---|---|---|
| Core AAC phrases (1×) | 36.7% | 46.7% | +6.0% |
| Personal vocabulary (3×) | 70.4% | 81.5% | +9.2% |
| Mixed (all phrases) | 47.2% | 56.9% | +5.7% |

Top-1 = correct word is the first tile. MRR = Mean Reciprocal Rank. Zero Top-5 regressions across all scenarios. HRR inserts max 1 suggestion at tile slot 1 (never displaces slot 0 / emergency vocabulary).

### Cascade latency benchmark (15 queries, 8 tests)

| Metric | Without HRR | With HRR | Impact |
|---|---|---|---|
| Precision | 68.2% | 68.6% | +0.6% |
| Avg Latency | 46.7ms | 29.2ms | **-37.5%** |
| False Positive Rate | — | 0.0% | Zero false positives |
| HRR Hit Rate | — | 35.0% | 35% of results from Tier 0 |

### Safety hardening (28 fixes across 4 sweeps)

- Init mutex (promise lock, retry on WASM failure)
- Corruption detection (validate dimension, NaN, Infinity)
- LRU eviction (delete-then-set for correct Map iteration order)
- Rate limiting (60 req/min per user)
- Input validation (type + length on all API inputs)
- Sanitization (HTML entities stripped from system prompt injection)
- Emergency vocab preservation (HRR at slot 1, never slot 0)
- Cross-language filter (isAllowedInLang on HRR word suggestions)
- Offline resilience (WASM failure → graceful degradation, iOS 1.5s race timeout)
- iPadOS persistence (visibilitychange + beforeunload flush)
- Production logging (errors always log, HRR_DEBUG for verbose)
- Mock/WASM parity (probe returns keys, get_summary for values)

### Reuse pattern

```typescript
// Encode a concept
import { hrrEncode } from '@/lib/hrr';
hrrEncode('patient prefers mornings', 'scheduling preference noted during intake');

// Probe (synchronous, ~0.2ms)
import { hrrProbe, hrrGetSummary } from '@/lib/hrr';
const results = hrrProbe('when does the patient prefer', 5);
results.forEach(r => console.log(hrrGetSummary(r.concept), r.similarity));

// REST API (browser/iOS)
POST /api/v1/hrr { action: "encode", concept: "...", summary: "..." }
POST /api/v1/hrr { action: "probe", query: "...", top_k: 5 }
GET  /api/v1/hrr → { ready, count, strategies, dimension }
```

### WASM binary

229KB, built from Rust with `wasm-pack`. Package: `synalux-hrr` (npm). Dependencies: `wasm-bindgen`, `rustfft`, `serde`.

---

## 8. Embedding LRU cache with in-flight deduplication

**Where:** [`src/utils/llm/adapters/gemini.ts`](../src/utils/llm/adapters/gemini.ts), [`src/utils/llm/adapters/openai.ts`](../src/utils/llm/adapters/openai.ts)
**Stable since:** v16.0.0

Caches embedding API responses in a 256-entry LRU Map with 5-minute TTL. Concurrent requests for the same text await the same in-flight promise instead of making duplicate API calls.

### Constants

| Constant | Value | Source | What it controls |
|---|---|---|---|
| `EMBED_CACHE_MAX` | 256 | gemini.ts:102, openai.ts:128 | Maximum cache entries before LRU eviction. |
| `EMBED_CACHE_TTL_MS` | 300,000 | gemini.ts:103, openai.ts:129 | Cache entry lifetime (5 minutes). |

### Cache key format

```
{model}|{text.substring(0, 500)}|L{text.length}
```

Model name is included (OpenAI) to prevent cross-model collisions when users switch embedding models mid-session. Length suffix prevents collisions on texts with identical 500-char prefixes.

### LRU behavior

- **On write**: delete-then-set moves key to Map tail (correct eviction order)
- **On read**: same delete-then-set promotes recently-accessed entries
- **Eviction**: `Map.keys().next().value` targets the true LRU entry

### Impact

Saves 50-2000ms per cache hit on embedding generation (Gemini API latency varies by load).

---

## 9. The recipe: combining all of the above

The audit hooks framework at `~/.agent/skills/hooks/` is the canonical example. Its design (now with HRR as Tier 0):

1. **HRR pre-filter** (#7) probes the hologram in ~0.2ms. If confidence > 0.15, short-circuits FTS5/vector search entirely.
2. **Postflight** harvests outcomes from session transcripts → stores `Experience(level, gotchas, fingerprint)` rows.
3. **Pre-execution gate** queries the corpus by fingerprint, applies `MIN_SAMPLES=5` cold-start gate (#3), then `synthesis_failure_warning > 0.20` ratio (#4), then ACT-R decay on each gotcha (#1, lesson rate `d=0.25`), then `PRISM_GRAPH_PRUNE_MIN_STRENGTH=0.15` cutoff (#5).
4. **Score blend** uses the spreading-activation hybridScore coefficients (#2): 0.7 × user_text_signal + 0.3 × graph_signal.
5. **Output budget** caps clarification context at 25KB (#6).
6. **Tier escalation** maps the cited ratios (#4) onto turn-counts.
7. **Embedding cache** (#8) deduplicates concurrent embedding requests and caches results for 5 minutes.

Every threshold cited. No magic constants. Behavior changes when Prism's CHANGELOG announces them, with deprecation cycles.

---

## How to consume this

1. Decide which algorithm(s) you need.
2. Port the relevant constants AND a comment pointing at the source line.
3. Pin the Prism version you sourced from.
4. Watch CHANGELOG for deprecation flags on those names.
5. Bump your pinned version when Prism's deprecation period elapses.

That's the contract. Behavior of the named exports changes only between major versions, with a deprecation cycle published in the CHANGELOG. Patch and minor releases will not silently shift these constants.
