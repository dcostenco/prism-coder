---
description: Deep code review checklist — mandatory protocol for reviewing new features before release
---

# Deep Code Review Protocol

This protocol prevents the class of bugs found during v9.0 review: features wired in one handler but disconnected in another, function signatures not matching callsites, and missing migrations.

## Pre-Review: Identify the Feature Surface

Before reading any code, list:
1. **All new functions/exports** introduced by the feature
2. **All existing handlers** that should integrate the feature
3. **All storage backends** that must implement new methods(SQLite + Supabase)

## Phase 1: Cross-Module Wiring (**Highest priority**)

For each new function, trace EVERY callsite:

// turbo-all

### 1.1 — Function Signature Parity
```
For each exported function:
  → grep all import sites
  → verify number of arguments matches the signature
  → verify argument TYPES match (not just count)
  → verify return type is consumed correctly
```
**Anti-pattern caught:** `propagateValence(results, valenceLookup)` called with 2 args when signature requires 3 (missing `flowWeights`).

### 1.2 — Handler Symmetry Check
```
For each feature wired in handler A:
  → Find ALL other handlers that deal with the same data type
  → Verify the feature is ALSO wired in those handlers
```
**Anti-pattern caught:** `deriveValence()` called in `sessionSaveLedgerHandler` but NOT in `sessionSaveExperienceHandler` — the handler that matters most for typed events.

### 1.3 — Storage Backend Parity
```
For each new storage method:
  → Verify it exists in interface.ts
  → Verify it's implemented in sqlite.ts
  → Verify it's implemented in supabase.ts
  → Verify the SQL/API matches (same column names, same COALESCE defaults)
```
**Anti-pattern caught:** `patchHandoffBudgetDelta` defined in interface but Supabase migration lacked the corresponding RPC function.

## Phase 2: Mathematical Correctness

### 2.1 — Precision Loss
```
For each numeric computation:
  → Check for Math.floor/Math.ceil on values that should stay fractional
  → Check division-by-zero guards
  → Check NaN/Infinity guards (Number.isFinite)
  → Check clamping ranges match expected domain
```
**Anti-pattern caught:** `Math.floor(hoursElapsed * 100)` destroyed fractional UBI on frequent saves.

### 2.2 — Display Rounding
```
For each numeric value displayed to users:
  → Verify it's rounded at the DISPLAY layer, not the STORAGE layer
  → Use Math.round() or toFixed() only in format functions
```

## Phase 3: Security & Game Theory

### 3.1 — Self-Report Exploits
```
For each user-controlled input that affects scoring/budget/ranking:
  → Can an LLM set this value to game the system?
  → Is the check enforced server-side, not client-side?
```
**Anti-pattern caught:** LLMs self-declaring `event_type: "success"` to mint free budget tokens.

### 3.2 — Concurrency
```
For each read-modify-write pattern:
  → Can two agents execute concurrently?
  → Would the second write overwrite the first?
  → Use delta-based updates (COALESCE + delta) instead
```

## Phase 4: Migration Completeness

### 4.1 — Schema Parity
```
For each new column/index:
  → Verify it appears in the SQLite CREATE TABLE
  → Verify it appears in the SQLite ALTER TABLE migration
  → Verify it appears in the Supabase migration SQL
  → Verify indexes match across backends
```

### 4.2 — RPC/Function Parity
```
For each supabaseRpc() call in code:
  → Verify the function exists in a migration file
  → Verify parameter names match between code and SQL
```

## Phase 5: Feature Flags & Fallbacks

### 5.1 — Feature Gate Consistency
```
For each feature flag (e.g., PRISM_VALENCE_ENABLED):
  → Verify ALL code paths check the flag before using the feature
  → Verify behaving correctly when flag is OFF (no errors, no NULL deref)
```

### 5.2 — Graceful Fallbacks
```
For each non-critical system (embeddings, surprisal, valence):
  → Verify try/catch with non-fatal logging
  → Verify fallback value is documented and sensible
  → Verify the fallback doesn't silently produce wrong results
```
**Anti-pattern caught:** Hardcoded `surprisal = 0.5` used as "fallback" but was actually the ONLY value ever used because the real computation wasn't wired.

## Execution

Run this checklist by grepping for every `export function` in the new modules, then tracing each one's imports. The entire process should take 15-30 minutes but catches 90%+ of integration bugs.

```bash
# Step 1: List all new exports
grep -n "export function\|export async function" src/memory/valenceEngine.ts src/memory/cognitiveBudget.ts src/memory/surprisalGate.ts

# Step 2: For each, find all callsites
grep -rn "deriveValence\|propagateValence\|computeUBI\|computeVectorSurprisal\|spendBudget\|patchHandoffBudgetDelta" src/ --include="*.ts" | grep -v "\.test\."

# Step 3: Verify argument counts at each callsite match the signature
```
