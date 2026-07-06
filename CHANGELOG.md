# Changelog

All notable changes to this project will be documented in this file.

## [19.3.1] - 2026-07-06 — Cloud Tokens Saved Metric + Gemini Host Verification

### Added
- **`cloudTokensSavedEst`** counter in `inferenceMetrics.ts` — the honest local-inference routing metric. Accumulates `submittedEst + completionTokens` for every `used_cloud=false` call. Uses `submittedEst` (not `evaluated`) to correctly count KV-cached prompts. Displayed in both compact footer (`📊 … · N cloud tok saved`) and full `inference_metrics` block. Reset on session boundary.
- **`scripts/test-gemini-host.mjs`** — Gemini 2.5 Flash integration test for host-agnostic Arc 1 gates and Arc 2 routing. Spawns `dist/server.js` as a real subprocess over stdio JSON-RPC. 5 tests, 7 assertions: T1–T3 confirm gates are server-side (hard-block without context, pass after load, `""` hard-blocked); T4–T5 confirm Arc 2 routing instinct from tool descriptions alone without skill-file instructions. T4 is two-sided — "answered directly" fails. 7/7 across 4 independent runs.

## [19.3.0] - 2026-07-06 — 🔒 Host-Agnostic Session Enforcement + CI Guard

### Added
- **`src/session/sessionContext.ts`** — Server-side LRU session registry keyed on `conversation_id`. Replaces Claude Code-only hook enforcement; gates fire from the tool handler itself so every host (Gemini, cron, auto-push) sees the same behavior.
  - `markContextLoaded(conversationId, project, version)` — called by `session_load_context` handler after successful assembly.
  - `requireContextLoaded(conversationId | undefined) → GateResult` — fail-closed gate returning `null` (pass) | `{blocked:true, error}` | `{blocked:false, warning}`. `undefined` → allow (opt-in for session-agnostic hosts); `""` → block (not a bypass). LRU via Map insertion order + `touch()` (O(1)). TTL enforced on every read, not just eviction.
  - `noteInferenceForSession` — fire-and-forget telemetry; uses `sessions.get()` (not `getOrInit`) to prevent ghost stubs.
- **`src/session/__tests__/sessionContext.test.ts`** — Unit tests for the full gate surface: `undefined → null`, `"" → block`, expired TTL, LRU cap, ghost stub prevention.
- **`scripts/no-raw-inference.mjs`** — CI guard: scans all tracked `src/` TypeScript files for raw inference calls outside the allowlist. Exits 1 on untracked `src/` files. Uses `(?<!:)\/\/` negative lookbehind to preserve `http://` URLs while stripping comments. Individually-named allowlist entries with explicit reasons (no module-level allowlisting).
- **CI gate** (`ci.yml`) — `no-raw-inference.mjs` wired between Build and Test steps.
- **`conversation_id`** added to `SESSION_SAVE_HANDOFF_TOOL` and `SESSION_LOAD_CONTEXT_TOOL` schemas (was missing — caused permanent hard block for compliant clients).
- **Operating boundaries** prepended to every `session_load_context` response for non-Claude hosts (belt + suspenders: server enforces, payload informs).

### Fixed
- **13 bugs caught across 4 adversarial review rounds** (R1–R4):
  1. `(gate as any)` casts in `ledgerHandlers.ts` defeated TypeScript rename safety → proper discriminated-union narrowing
  2. `SESSION_SAVE_HANDOFF_TOOL` missing `conversation_id` schema → compliant clients were permanently hard-blocked
  3. `requireContextLoaded(undefined)` hard-blocked auto-push/resource-reader hosts → now returns `null` (allow)
  4. `evictStale` while-loop truthy check → `""` session key stalled the loop → changed to `!== undefined`
  5. `noteInferenceForSession` used `getOrInit` → created ghost stubs crowding out legitimate sessions → changed to `sessions.get()`
  6. Comment-strip regex `/\/\/.*/g` matched `://` in URLs → URL bypass patterns went blind → fixed with `(?<!:)\/\/` lookbehind
  7. Untracked `src/` files silently passed CI guard → exit 1 on untracked files
  8. Empty-string `conversation_id` bypassed gate (`!""` is truthy) → changed to `=== undefined`
  9. Stale intersection cast `args as typeof args & { conversation_id?: string }` after type guard → removed
  10. `(args as any).max_tokens` after type guard already narrows field → changed to `args.max_tokens`
  11. `isPrismInferArgs` missing `typeof a.conversation_id !== "string"` check → non-string truthy value passed guard
  12. `args.conversation_id!` non-null assertion across async `.then()` boundary → captured `const _convId` synchronously
  13. Stale ALLOWLIST entry for `layer1Integration.test.ts` → removed (file uses no SYMBOL_PATTERNS)
- **`isSessionSaveLedgerArgs` / `isSessionSaveHandoffArgs` / `isSessionLoadContextArgs`** — `conversation_id` validation added to all three type guards.
- **`isPrismInferArgs`** — `conversation_id` type-checked as string when present.

### Changed
- `session_save_ledger` and `session_save_handoff` now gate on `requireContextLoaded` at entry (hard block on unknown/expired session, soft warning on boundaries-version drift).
- `session_load_context` calls `markContextLoaded` in all 3 success paths (normal, fresh-project early-return, and third assembly branch).
- 3071 tests across 101 files.

---

## [19.2.9] - 2026-07-05 — ⚡ Auto-Evict + 27B Routing Fix

### Added
- **Auto-evict warm smaller models** — When `model_ceiling: "27b"` is requested and 27B is installed but not warm, the handler now automatically unloads any warm smaller-tier models (9B, 4B, 2B) if freeing them would provide sufficient RAM for 27B. Eliminates the need for callers to manually unload models before requesting a large-model ceiling.
  - Eviction is conditional: `freeBytes + warmBytes ≥ minFreeGb` must hold before any eviction fires.
  - Evictions run with `Promise.allSettled` (network error to Ollama cannot crash the inference call).
  - In-process mutex prevents concurrent requests from racing the eviction window.
  - 800ms settle before re-reading free RAM (measured Ollama buffer-release latency).
  - Live test: 9B warm (5.6 GB) → evicted → 27B loaded and ran locally. `used_cloud=false`, `attempts=[]`.

### Fixed
- **`model_ceiling: "27b"` ignored for enterprise plans** — Portal returns `model_ceiling: "32b"` for legacy enterprise/advanced accounts. Added normalization `32b → 27b` (same pattern as existing `14b → 9b`). Per-call `model_ceiling: "27b"` now resolves correctly without being clamped down.

### Changed
- 3096 tests across 101 files (up from 3031/101). 4 new auto-evict unit tests covering eviction condition guard (F1), parallel eviction with failure logging (F2), eviction mutex (F3), and ceiling-index guard (F4).

## [19.2.8] - 2026-06-24 — 🔧 ESM require() Fix + Schema-Code Audit Skill

### Fixed
- **`knowledge_ingest` broken** — `require("path")` in `ingestHandler.ts` crashes in ESM context (`"type": "module"`). Replaced with static `import { resolve } from "path"`. File-path ingestion was completely non-functional.
- **`sniffFormat` broken** — `require('node:fs')` in `migration/utils.ts` same ESM issue. Replaced with top-level `import { openSync, readSync, closeSync } from "node:fs"`.
- Zero `require()` calls remain in compiled output.

### Added
- **`schema-code-audit` skill** — Deep cross-reference audit technique: extracts every `.from()` call from API routes and verifies table names, column names, FK joins, onConflict constraints, and cross-table ID usage against actual migration DDL. Originated from a sweep that found 20 BLOCKER bugs across banking, billing, accounting, and clinical modules.
- **`pre-push-audit` rules 20-25** — Six new schema-code rules: phantom table, ghost column, invalid FK join, missing upsert constraint, nested insert anti-pattern, cross-table ID confusion.

## [19.2.7] - 2026-06-24 — 🔒 CodeQL Security Sweep

### Security
- **24 CodeQL alerts resolved** — full sweep of GitHub Code Scanning findings across prototype pollution, log injection, TOCTOU race conditions, insecure temp files, and URL sanitization.
- **Prototype pollution defense** — All dynamic-key objects use `Object.create(null)` + explicit `PROTO_KEYS` guards (`configStorage`, `commonHelpers`, `dashboard/server`).
- **Log injection hardened** — Exported `sanitizeForLog()` strips C0+C1 control characters (including 8-bit CSI U+009B) and ANSI sequences. Applied to 16 call sites across 8 production files.
- **TOCTOU file lock eliminated** — Scholar lock acquisition replaced with atomic `renameSync` pattern (POSIX atomic) + post-rename PID verification. No mutual-exclusion window.
- **Temp file prediction eliminated** — Export filenames now include `randomUUID` token in primary name, not just collision fallback.
- **URL substring sanitization** — DataDog URL check uses `new URL().hostname.endsWith()` instead of `.includes()`.
- **5 intentional file-access-to-http alerts dismissed** — ingest/API modules reading files and sending to first-party endpoints (Anthropic, Supabase, Synalux).

### Added
- `sanitizeForLog` test suite — 11 assertions covering C0, C1, ANSI, newline forgery, UTF-8 preservation.

### Changed
- 98 test files, 2880 tests (up from 97/2876).
- 17 test logger mocks updated with `sanitizeForLog` passthrough.
- Reviewed through 4 rounds including external adversarial review.

## [19.2.6] - 2026-06-22 — 📊 Analytics Stats Fix + Security Hardening

### Fixed
- **`api_analytics` now works** — Rewrote from dead `better-sqlite3` (never installed as a dependency) to `@libsql/client` (same SQLite client used by the storage layer). Tool calls are recorded to `~/.prism-mcp/data.db` with per-project and system-wide query support.
- **`recordInvocation` wired in dispatch** — Called on both success and error paths of the MCP tool dispatch loop. Isolated with try/catch so analytics never breaks tool responses. Timer `unref()`'d to avoid holding process open.
- **`api_analytics` scope param** — Handler now reads `scope` (matching the tool schema enum) instead of the undeclared `action` parameter.
- **Datadog context forwarding** — Added `tool`, `project`, `success`, `durationMs` to the DD `CONTEXT_ALLOWLIST`. Tool-level analytics now reach Datadog.
- **Analytics WAL mode** — `PRAGMA journal_mode=WAL` set during table init to prevent `SQLITE_BUSY` contention with the storage layer on the shared `data.db`.

### Security
- **Notifier DNS-rebinding TOCTOU closed** — Replaced `isAllowedUrl()` with `validateUrl()` that returns the resolved IP. New `pinnedDispatcher()` creates an undici `Agent` that forces `fetch` to connect to the pre-validated IP only — no DNS re-resolution between check and use. All 3 senders use pinned dispatchers with `dispatcher.close()` in `finally`.
- **Supergateway bind documented** — Supergateway has no `--host` CLI flag and ignores `HOST` env; binds `0.0.0.0:8001`. Security note added documenting that the proxy enforces bearer auth and the port is container-internal on Railway/Docker. Infra-level firewall recommended for other deployments.

### Added
- 31 new tests: analytics recording/flush/query (8), handler scope alignment (4), inference_metrics (3), DD allowlist (1), dispatch isolation (2), dispatch wiring guards (4), WAL mode (1), DNS pinning + dispatcher close (5), supergateway security (3).

### Changed
- 97 test files, 2876 tests (up from 96/2845).
- Reviewed through 6 rounds of adversarial external review.

## [19.2.5] - 2026-06-22 — 🔒 Security Advisory Fixes

### Security
- **GHSA-g3wf-5xg2-c4vh (Critical)** — HTTP bridge now requires bearer token auth (`PRISM_MCP_HTTP_TOKEN`). Constant-time HMAC comparison via `timingSafeEqual`. 503 if token not configured, 401 on mismatch.
- **GHSA-wpc9-r66q-pj2c (Medium)** — `session_export_memory` path confinement: `realpath` + allow-list, sensitive directory deny (resolves macOS `/private` symlinks), owner-only tmp subdir (mode 0700), exclusive-create write (`wx` flag) prevents symlink-following.
- **Notifier SSRF** — All notification senders now use `redirect: "error"` and DNS resolve-then-check to reject private/internal IPs.

### Added
- 4 security regression tests for export path confinement (outside-allow-list, sensitive-dir, positive control, symlink attack).

### Fixed
- Resolved 15 of 16 Dependabot vulnerabilities (hono, undici, ws, vite, tar, protobufjs, OpenTelemetry). Remaining: 1 low (esbuild Windows dev server, not applicable).

### Changed
- 96 test files, 2845 tests (up from 95/2841).
- Reviewed through 4 rounds of external security review.

## [19.2.4] - 2026-06-18 — 📊 `inference_metrics` Tool + Delegation Gate

### Added
- **`inference_metrics` MCP tool** — read-only, no args. Returns the session's local-delegation stats on demand (call count, local/cloud split, token totals, per-model breakdown). Description explicitly notes this tracks `prism_infer` delegation only, not Claude's own token spend.
- **Delegation opt-in gate** — `session_task_route` checks `delegation_enabled` setting before allowing local-model delegation. Off by default, enforced in code (not just skill prose). 4 tests.
- **Inline framing** — metrics title reads "local-model delegation (this session)" so the caveat travels with the data when relayed.

### Security
- Context allowlist applied to Datadog sink (was Supabase-only in 19.2.1). Both sinks now filter identically.
- `message` field capped at 200 chars.

### Changed
- Architecture skill corrected from stale 19.2.0 thin-client description to 19.2.1 local-first reality.
- Delegation skill rewritten to v2 (reviewer's canonical version): off by default, principle-first framing.
- 95 test files, 2841 tests (up from 94/2835).

## [19.2.1] - 2026-06-17 — 📊 Inference Metrics: Local-First Fix

### Fixed
- **Metrics now work for all users.** Restored local accumulator as the sole display source — works immediately with zero config, no portal dependency, no env vars. The 19.2.0 thin-client architecture silently returned empty for every user because the portal infrastructure (token + migration) was never deployed.
- **Startup warning** — `console.warn` when `TELEMETRY_WRITE_TOKEN` is not set, so dead portal forwarding is visible instead of silent.
- Portal `ddLog` forwarding remains as best-effort analytics (independent of display). Egress allowlist and write-auth headers preserved.

### Architecture note
Local accumulator = user-facing display (what did MY session do). Portal forwarding = business analytics (what is the fleet doing). These are independent streams — display never depends on portal connectivity.

## [19.2.0] - 2026-06-17 — 📊 Inference Metrics + Write-Side Hardening

### Added
- **Inference metrics** — `session_save_ledger` and `session_save_handoff` now show local vs cloud usage percentage, token counts (actual from Ollama), per-model breakdown, and avg latency. Metrics are aggregated by the Synalux portal (thin-client architecture).
- **Ollama token parsing** — `prism_infer` now captures `prompt_eval_count` and `eval_count` from Ollama responses and includes them in the MCP response header.
- **Datadog telemetry** — Per-call `prism_infer.usage` events forwarded to Synalux portal for aggregation. Safety gate intercepts excluded (HIPAA).
- **SECURITY.md** — Data inventory for inference telemetry, behavioral metadata classification, and multi-user gate checklist.
- **Contract tests** — Cross-repo field name pinning (emitter ↔ allowlist ↔ SQL RPC ↔ portal headers). Catches silent-regression class.
- 26 new tests: ddLogger write headers + allowlist (11), inference metrics fetch (9), contract pinning (6).

### Security
- **ddLogger auth** — Now sends `Authorization: Bearer ${TELEMETRY_WRITE_TOKEN}` + `X-Prism-Client` headers. Previously silently 401'd (events never reached portal).
- **Context allowlist** — 15-field static allowlist applied to BOTH Supabase and Datadog sinks. Stack traces, file paths, error messages, and prompt fragments no longer reach either vendor.
- **Message cap** — `ddLog` message field capped at 200 chars as backstop against interpolated sensitive data.

### Changed
- `inferenceMetrics.ts` rewritten from 129-line in-memory accumulator to 74-line thin-client portal fetch. No local state, no dedup complexity.
- 94 test files, 2826 tests (up from 92/2807).

## [19.0.1] - 2026-06-15 — 🔒 Security: 15 verification fixes + 9B fleet

### Fleet

- **14B retired, 9B default.** Qwen3.5-9B achieves 100% BFCL × 3 seeds at 36% smaller (5.8 GB vs 8.4 GB). Cascade updated: `9b → 4b → 2b → 32b → cloud`.
- Model picker, entitlements, CLI, and all tests updated. `prism-coder:14b` references removed.

### Security (6-round external audit)

- `fix(F1)`: Entitlement fetch failure now **fail-closed** — keeps last-known-good entitlements instead of downgrading to free tier (which disabled the grounding verifier). Stale cache no longer re-cached with fresh TTL.
- `fix(F9)`: Verification runner HTTP fetch uses `redirect: "error"` — prevents SSRF via 302 → internal IP.
- `fix(F10)`: Skipped gate/abort-level assertions treated as failures — prevents dependency-chain manipulation to bypass critical checks.
- `fix(F11)`: `computeRubricHash` now includes `min_pass_rate` when provided, and `verifyRubricHash` passes it — closes threshold-tampering vulnerability.
- `fix(F19)`: Gatekeeper bypass actor from `process.env.USER` marked as unauthenticated in audit trail.

### Verification pipeline (documented in README)

- New README section: Multi-Layer Verification table (L1 crisis gate → L3 tool routing → L3 NLI verifier → L4 hallucination judge).
- Honest BFCL disclosure: "Routing accuracy includes the deterministic L3 correction layer."
- Scoped claims: "Fail-closed on the verified path (Standard tier and up)" — no longer overstates free tier coverage.

### Git hooks (portable)

- New `pre-commit` and `pre-push` hooks that work with any editor/AI tool (no Claude Code dependency).
- Advisory mode by default; `PRECOMMIT_MODE=block` / `PREPUSH_MODE=block` for hard enforcement.
- Hooks look in repo `hooks/lib/` first, `~/.claude/hooks/` fallback, then minimal inline checks.

### Tests

- 10 new tests covering all audit fixes (`verification-audit-fixes.test.ts`)
- Full suite: 89/89 files, 2,672 tests passing

## [18.0.2] - 2026-06-12 — 🔒 Security: PHI, JWKS, ingest (adversarial review round 2)

### Security

- `fix(H1)`: JWKS audience + issuer now **required** (defaults to `prism-mcp` / `https://synalux.ai`). Prevents cross-service token confusion. `al_audit_url` treated as untrusted — truncated to 256 chars, never fetched.
- `fix(H3)`: `files_changed` now passes through `sanitizeArray` → `scanAndRedactPHI` before portal POST. File paths with client names (e.g. `/clients/jane_smith/`) were previously sent raw.
- `fix(H4)`: `knowledge_ingest` now redacts chunks BEFORE sending to cloud LLM. Previously sent raw source code (which may contain PHI in clinical codebases) to `api.anthropic.com`.
- `fix(H2)`: README privacy table corrected — "Nothing" → "Nothing (free tier)" for data sent externally.

---

## [18.0.1] - 2026-06-12 — 🔧 External review fixes

### Fixed

- `fix`: Auto-Scholar file lock — atomic `wx` flag + PID-checked release (eliminates TOCTOU race)
- `fix`: dedup delimiter — `"ai"` no longer false-matches `"ai agents"` entries
- `fix`: removed dead `startScholarWatcher` code (10s polling loop, never called)
- `fix`: restore strong test assertions — entitlements + max_tokens tests now pin exact values with env isolation via setup.ts (`PRISM_SYNALUX_API_KEY` deleted before tests)
- `fix`: README PHI Guard claim — "Names" removed from "zero false negatives" (regex can't guarantee name detection)
- `docs`: CHANGELOG 17.x entries added (17.0.0 → 17.1.1 were missing)
- `docs`: version labels in README corrected (v17+ instead of "new in v17")

---

## [18.0.0] - 2026-06-12 — 🛡 PHI Guard + Skill Routing + Tier Enforcement

### What's new

**PHI Guard** — Automatic Protected Health Information detection and redaction in the save pipeline. Every `session_save_ledger` and `session_save_handoff` call passes through a deterministic PHI scanner (18 HIPAA identifier categories). Fail-closed: detection errors block the save and always log to stderr. (`d0bd1ed`, `a8c49f7`, `b54bbf1`)

**Prompt-based skill routing** — 114 agent skills auto-load based on prompt keywords. The MCP server scans the user's prompt on `session_load_context` and injects relevant skill instructions into context before the AI responds. No manual skill selection needed. (`fffc1d0`)

**Tier-based monetization enforcement** — `prism_infer` now gates model ceiling, max tokens, daily limits, and cloud fallback by subscription plan. Free users get local-only up to 4b; paid tiers unlock 14b/32b, higher token limits, and Claude Sonnet 4 fallback. Flat-rate seat caps via `max_seats` per plan. (`8d149cf`, `a38d189`)

**HRR semantic drift detection** — `session_detect_drift` MCP tool using Holographic Reduced Representations for temporal trajectory encoding. Three domains (BCBA/Coding/AAC) with domain-specific safety signals. 306 tests. (`be84f7b`)

**Synalux portal routing** — All search and scrape operations now route through the Synalux portal for unified auth, billing, and audit logging. Telemetry rewired from Datadog-primary to Synalux portal + Supabase (primary), Datadog Logs (fallback). (`9366e66`, `3051f68`)

### Fixed

- `fix`: session dates showing `[undefined]` in `load_context` response (`334337d`)
- `fix`: adversarial review — correct README claims, reduce cache TTL to prevent stale data (`f4052b7`, `fe66943`)
- `fix`: skill block cap 30K chars + plug 3 bypass paths in `session_load_context` (`76408d8`)
- `fix`: entitlements tests now environment-independent (work with or without `PRISM_SYNALUX_API_KEY`)
- `test`: 2,676 tests across 89 files (up from 2,418 across 81)

---

## [17.1.1] - 2026-06-10 — 🔒 Adversarial review security fixes

### Fixed

- `fix`: adversarial review — correct README claims, reduce cache TTL to prevent stale entitlement data (`f4052b7`, `fe66943`)
- `fix`: session dates showing `[undefined]` in `load_context` response (`334337d`)

---

## [17.1.0] - 2026-06-08 — 💰 Tier enforcement + competitive positioning

### What's new

**Tier-based monetization enforcement** — `prism_infer` now gates model ceiling, max tokens, daily limits, and cloud fallback by subscription plan. Free users get local-only up to 4b. (`8d149cf`)

**Max seats entitlement** — flat-rate seat caps per plan via `max_seats` field. (`a38d189`)

### Fixed

- `fix`: skill block cap 30K chars + plug 3 bypass paths in `session_load_context` (`76408d8`)

---

## [17.0.1] - 2026-06-05 — 🔗 Portal routing

### What's new

**Synalux portal routing** — All search and scrape operations now route through the portal for auth, billing, and audit. (`9366e66`)

---

## [17.0.0] - 2026-06-01 — 🧠 HRR Drift Detection + PHI Guard

### What's new

**HRR semantic drift detection** — `session_detect_drift` MCP tool using Holographic Reduced Representations for temporal trajectory encoding. Three domains (BCBA/Coding/AAC). 306 tests. (`be84f7b`)

**PHI Guard** — Automatic Protected Health Information detection and redaction in the save pipeline. 18 HIPAA identifier categories, deterministic, fail-closed. (`d0bd1ed`, `a8c49f7`)

**Prompt-based skill routing** — 114 agent skills auto-load based on prompt keywords. (`fffc1d0`)

**Telemetry rewire** — Primary: Synalux portal + Supabase. Fallback: Datadog Logs. (`3051f68`)

---

## [16.1.1] - 2026-05-30 — 🔍 Handoff semantic search + uncertainty gate fix

### What's new

**Handoff semantic search** — `session_search_memory` now finds handoff content, not just ledger entries. Previously, `session_save_handoff` never generated embeddings and `semantic_search_ledger` only queried `session_ledger`, making all handoff data invisible to semantic search. This affected all users.

### Fixed

- `fix(session_save_handoff)`: add fire-and-forget embedding generation (float32 + TurboQuant) matching the existing ledger handler pattern
- `fix(semantic_search_ledger)`: RPC now UNION ALLs `session_handoffs` alongside `session_ledger` — zero caller changes needed. Dropped stale 5-param overload that shadowed the fix
- `fix(Tier-2 fallback)`: TurboQuant JS-side search in `supabase.ts` now also scans `session_handoffs` with compressed embeddings
- `fix(search)`: HDC uncertainty rejection gate (0.85 threshold) now only fires when `PRISM_HDC_ENABLED=true` — was rejecting relevant results (0.847 similarity) even with HDC disabled
- `fix(migration)`: drop stale 5-param `semantic_search_ledger` overload that shadowed the new 6-param UNION ALL version — callers were silently hitting the old ledger-only function
- `feat(storage)`: add `patchHandoff(project, userId, data)` to interface + Supabase + SQLite backends for embedding backfill
- `migration(042)`: adds `embedding vector(768)`, `embedding_compressed`, `embedding_format`, `embedding_turbo_radius` columns + HNSW index to `session_handoffs`

### Root cause

Bug introduced in v0.4.0 (`8047226`, 2026-03-19) — `session_handoffs` and semantic search were built in the same release but never wired together. Handoff embedding generation was simply never added. Undetected for 72 days because the normal workflow (`session_save_handoff` → `session_load_context`) reads by project name and never touches search.

---

## [16.0.0] - 2026-05-30 — 🧪 E2E test suite + embedding cache + Datadog + security sweep

### What's new

**Comprehensive E2E test suite** — 161 tests covering full workflow + correctness/stability across handlers and storage (`522b87a`)

**Embedding LRU cache + in-flight dedup** — Gemini/OpenAI adapters now cache embeddings and deduplicate concurrent requests for the same text. Cache key includes model name to prevent cross-model collisions (`be17500`, `0aec029`)

**Datadog server-side logging** — HTTP intake, no agent required (`64765f3`)

**Rate limiting** — webhook + ingest endpoints now enforce request limits (`a60d5b0`)

### Fixed

- `chore`: remove 3,000 lines of dead code + fix console.log/telemetry (`1676d54`)

---

## [15.7.4] - 2026-05-29 — 🛡 Security sweep + knowledge ingestion + CLI docs

### What's new

**Knowledge ingestion** — open interface for codebase RAG (`c57ab6b`)

**CLI reference** — all 15 commands documented (`38fa3fc`)

### Fixed

- `security`: fix 4 critical vulnerabilities in webhook + notifier (`8f8afdd`)
- `security`: fix SSRF bypass + 4 dashboard XSS issues (`01ccc88`)
- `security`: fix CodeQL alerts — log injection, property injection, temp files (`9b1fdd8`)
- `security`: sanitize export filename to prevent path traversal (`1987da0`)
- `security`: block path traversal in knowledge_ingest file_path (`8c3dcc9`)
- `fix(deps)`: update qs to fix DoS vulnerability (`56c03c8`)
- `fix(prism-mcp)`: fetch skills from .well-known static JSON (`d0f5457`)
- `fix`: cascade default to 14b, verifier to 4b (`c4b6e4b`, `2d506a7`, `3fddf51`)
- `test`: military-grade storage round-trip tests — 12 cases (`214d6d0`)
- `test`: prismInferHandler + compactionHandler coverage — 110 tests (`a58f624`)

---

## [15.6.1] - 2026-05-28 — 🎯 prism-coder:32b hits 300/300 (100%) on eval_300

### What's new

**prism-coder:32b swe14 — 100% on eval_300** — 300/300 strict accuracy across 17 tools, 9 categories (abstention, adversarial traps, disambiguation, cascade, edge cases, multi-intent, natural phrasing, param extraction, verifier), 3-seed validated with zero failures and zero hallucinations. Pushed to Ollama Hub (`dcostenco/prism-coder:32b`) and HuggingFace (`dcostenco/prism-coder-32b`).

**eval_300 validate_tool_call fixes** — Seven regex gaps in the post-processing layer caused 8 persistent failures at 292/300. Fixes: broadened milestone→`session_save_experience` remap, added `repair` to backfill trigger, narrowed `\bproject\b` in PRISM_INTENT to avoid false matches on "React project", added GENERAL patterns for generators/meta/recommendations, expanded social rejection patterns, added initialize→`session_load_context` remap. (`79af48b7`)

---

## [15.6.0] - 2026-05-27 — 🧠 Grounding verifier + knowledge_search fixes + stale-dist guard

### What's new

**L3 grounding verifier** — `groundingVerifier` now guards `prism_infer` against hallucinations when evidence is provided. Auto-verify fires when the MCP call includes an evidence payload; unverified claims are flagged before returning to the caller. (`10c42b5`, `74f2dab`, `73ff0e7`)

**Opt-in workspace scope for `knowledge_search`** — Set `PRISM_KNOWLEDGE_SCOPE=workspace` to restrict search to the current workspace. Default remains global so existing installs are unaffected. (`02c0eab`)

**Stale-dist startup guard** — Server now detects at startup when `dist/` is older than source (derived from `package.json` + `tsconfig`) and exits with a clear error rather than silently running stale compiled output. (`61c9ba7`)

**Zod wire contracts** — `knowledge_search` input/output schemas are now Zod-validated at the boundary; live smoke test included. (`4ac482d`)

### Fixed

- `fix(knowledge_search)`: stop auto-deriving `keywords[]` from free-text query — this was inflating result noise when callers passed a full sentence as the query (`5b16071`)
- `fix`: re-register orphaned `SESSION_BACKFILL_EMBEDDINGS_TOOL` that was silently missing from the MCP tool list after a prior refactor (`779dcd5`)

### Eval / internal

- Grounded-recall eval harness + updated training corpus (`b9a3ce8`)
- Prism-routing benchmark harness improvements + 1b7 system prompt tuning (`69ce1ef`, `546fcd0`)

## [15.3.0] - 2026-05-14 — 🛡 Storage hardening + multi-region deploy + license switch

> v15.2.1 was published as a stub version bump with no CHANGELOG entry. This release supersedes it and documents every commit since 15.2.0.

### What's new

**Three-layer storage reliability** — Synalux portal stays the paid-tier default, but `getStorage()` now falls back through synalux env vars → synalux dashboard config (`~/.prism-mcp/prism-config.db`) → direct Supabase env → direct Supabase dashboard config → local SQLite. Closes the silent-data-loss path where MCP clients (some VSCode extensions) didn't propagate `PRISM_SYNALUX_*` env vars and the server quietly demoted to local without ever picking up the dashboard credentials. Symmetric helpers `ensureSynaluxCredentials()` / `ensureSupabaseCredentials()` probe env then DB and inject into `process.env` so downstream constructors and `SyncBus` see them. (`aef54e5`, `ef7fdfd`, `c1384f5`, `2078642`, `b4c079b`)

**Railway + Fly.io deployment stack** — `feat(railway)` ships `railway.toml`, `.railwayignore`, and an HTTP transport mode for the MCP server suitable for managed hosting. Fly.io standby config covers the Supabase outage scenario. (`0d56e59`, `b301b73`, `d0bfbef`, `b4c079b`)

**Prism Coder 1.7B BFCL eval** — `prism-coder:1b7-v19-q8` ships at 90.0% tool-call accuracy on the public BFCL benchmark (eval methodology pinned in `tests/eval/`). Replaces the misleading "100% BFCL" claim from earlier docs with the verified internal-domain vs. public-benchmark split. (`c5db866`, `3d73b9e`, `ad440e5`)

**Routing benchmark suite** — 100-case Prism routing eval covering the full model fleet (1.7B / 7B / 14B / 32B) plus Claude comparison. Includes a `nothink`-template fix for 32B and an MLX↔Ollama parity test that closed a 17-pt thinking-mode gap. 3-seed mean ± std with verified ~0% variance; per-category breakdown lives in `tests/benchmarks/prism-routing-100/README.md`. (`cc03853`, `70d6718`, `c32c83e`, `5f894ba`, `2ab3a19`, `604f4bc`, `133d27b`)

**Local-to-portal migration script** — `scripts/migrate-local-to-portal.mjs` reads `~/.prism-mcp/data.db` and pushes ledger + handoff entries through `POST /api/v1/prism/memory`. Dry-run mode, project filter, JWT caching with refresh-leeway, rate-limit pacing. Uses `@libsql/client` (already a runtime dep) instead of `better-sqlite3` so it runs from a fresh checkout without an extra native build dep. The earlier bash version was dropped — its subshell counter and JWT-refresh both ran inside `| while read` pipes and silently lost updates.

### Changed

**License switch: BUSL-1.1 → AGPL-3.0** — `LICENSE`, `package.json`, `package-lock.json` now match the README badge and prism-aac. Commercial use moves to the Synalux subscription path for hosted/managed deployment. (`5b30807`, this release)

### Fixed

- `fix(ci)`: skip onnxruntime CUDA download on CI runners with no GPU (`596d8db`)
- `fix(railway)`: `npm install` instead of `npm ci` to absorb lock-sync drift (`b301b73`); subsequent `package-lock.json` regeneration (`d0bfbef`)
- `fix(32b)`: nothink-template fix lifts 32B routing accuracy 97% → 99% (`70d6718`)
- `fix`: license string + Windows CI `hookTimeout` 30s → 60s (`5b30807`)
- `fix(docs)`: ASCII diagram repairs, P0 README claims (model names, fallback cascade, eval caveats, 7B addition), infrastructure diagram cleanup (`0c6b8e3`, `cd9e011`, `5d32db9`, `d0d1d5b`, `e2301c0`, `747a7ef`)

### Test coverage added

- `test(eval)`: MLX↔Ollama parity test closes a 17-pt thinking-mode gap (`0c40be7`)
- `test(conversion)`: pinned MLX-4bit → dequant → Q4_K_M GGUF regression that was producing 60s+ TTFT (`eb1bee6`)
- `test(training)`: pre-flight validation of `train_*.sh` scripts as a $0 guardrail before paid GPU runs (`8972fd0`)
- `test(training)`: pre-flight validation expanded — flags wrong-base lineage, known-bad corpora, and excessive iteration counts in `train_*.sh` scripts at `$0` before any GPU allocation (`66d99f2`)
- `test(storage)`: dropped a divergent test-mirror that had been testing a frozen copy of the resolver instead of source; replaced with `tests/storage-resolver.test.ts` driving real `getStorage()` through mocked dashboard creds (`2078642`)

### Docs

- iOS deployment story corrected: llama.cpp Swift SPM, not CoreML (`011cbff`)
- Local-AI security/speed/cost comparison table + install commands (`435ab13`)
- Production infrastructure diagram with 3-layer reliability story (`e2301c0`)
- Claude-comparison context for benchmark scores — what they mean, what they don't (`133d27b`)
- README "honest current eval state" + retrain-regression note (`5316e8d`, `63d3d99`)

## [15.2.0] - 2026-05-10 — 🛡 Two-namespace skill architecture + Synalux dynamic content

### What's new

**Two-namespace skill separation** — Platform skills (`skill:*`) are read-only. User-local skills get their own `user_skill:*` namespace, written by dashboard only when `user_local.enabled=true` in routing table (off by default).

**Synalux dynamic skill content** — `GET /api/v1/skills/content` checks Supabase `platform_skills` table first (admin-updatable without redeploy), falls back to filesystem. Admin endpoint `POST /api/v1/admin/skills` gates on `isPlatformAdmin()`.

**Skill routing schema v2** — `resolveSkillsForProject` returns `{ names, user_local }`. Routing table gains `user_local: { enabled, key_prefix }`.

**New universal skills** — `execute-method-literally` (26-case test suite, verbatim May 2026 replay), `pre-push-audit` Rule 19 (`tsc --noEmit` before every push).

## [15.1.0] - 2026-05-10 — 🔗 Skill content via Synalux for paid tier

`fetchSkillContent()` in SynaluxStorage, skill content batch-fetched from Synalux on `session_load_context`, `execute-method-literally` in universal routing, Architecture docs Section 12.

## [15.0.0] - 2026-05-10 — 🔄 Proactive drift detection + evidence-first behavioral protocol

### What's new

**Proactive session drift detection** (`session_cognitive_route` pattern)
Three direct Prism calls — no scripts, no cron, no hooks — detect when an AI agent has drifted from stated goals mid-session and self-correct before the user notices. Returns `on_track / minor_drift / major_drift`. Routes major drift alerts to Synalux portal for cross-session visibility. 10 behavioral test cases cover: obvious drift, scope creep, on-track false positive, promise gaps, repeated fixes, cascading violations, and Synalux routing. Documented as the flagship v15 feature.

**Evidence-first behavioral protocol** (new skill + CLAUDE.md gates)
Prevents AI agents from reporting `done / fixed / working / 90%+` without observable evidence. Five hard gates that supersede all other instructions: (1) no positive completion claim without evidence; (2) diagnose before asserting causes; (3) write test before pushing any bug fix; (4) training quality gate BFCL ≥90%; (5) 60-min drift check for long sessions. Born from five May 2026 failures that each wasted 1-3 hours of production work. Evidence gate table maps every claim type to required proof.

**TTS audio protection** (prism-aac)
- `PROTECT_PLAY_MS=600ms`: autoSpeak calls that arrive within 600ms of a playing source are gracefully dropped instead of killing the audio. Fixes complete silence from rapid prediction-tile taps.
- `interrupt` parameter threaded through `speakAzure → decodeAndPlay`: replaces the shared `_nextSpeakInterrupt` flag that could be stolen by concurrent autoSpeak calls, silencing the Speak button.
- `volume=0` guard in `speak()`: early exit with console.warn before any network call.
- `vol=` and `rate=` added to TTS log for live diagnostics.
- 10 unit tests covering: flag theft, rapid-tap protection, interrupt override, volume=0, NaN volume, suspended AudioContext, 3 concurrent autoSpeak, Speak wins among concurrent calls.

**SW auto-bump** (prism-aac)
`NEXT_PUBLIC_BUILD_ID = VERCEL_GIT_COMMIT_SHA[:8]` on every Vercel deploy. SW killswitch version changes automatically — no manual bump needed. Identical pattern applied to Synalux portal (`synalux-sw-v` key in localStorage, fires once per deploy not every session).

**Search keyboard** (prism-aac)
- Opening Search now shows the keyboard immediately (no second tap needed).
- On-screen keyboard keys route to the search input via `searchKeyBridge.ts` pub/sub — tile taps no longer land in the message bar while searching.

**Tone fix** (prism-aac)
`toneToAzureStyle()` replaced invalid `'general'` (default) and `'gentle'` (empathetic) with valid `ToneStyle` members. `tone=general` no longer appears in TTS logs.

**SSML rate formula restored** (prism-aac)
`rate × 2` formula (capped at 1.4) confirmed working via tts-live-diag-rate.mjs. Stored slider 0.5 → SSML 1.0 (normal speed). Fixes Romanian/Ukrainian 2× slower regression.

**Marketplace catalog** 
`marketplace_modules` table created via migration `20260510_marketplace_modules.sql`. Resolves 500 on every `/api/v1/marketplace/catalog` call (table was never applied to prod Supabase).

**13 synalux stub fixes**
Unread count, mail sync (IMAP→501, OAuth→real Gmail fetch), inbox thread 503, accounting providers removed (no longer returned as 'planned'), Zoom 501→422, chat providers cleaned, e-sign 501→422, feature-flags DB error returns success:false, SMS send 501→503, marketplace/installed 401, MathPanel + MathKeyboardRegion stub comments removed.

**Inbox / messages** (prism-aac)
- `/api/v1/prism-aac/inbox/poll` now returns real Gmail unread messages (via user's OAuth grant) and unclaimed SMS from `inbound_sms` table. Previously returned `[]`.
- Per-message TTS on arrival: speaks "New message from [sender]: [text]" for ≤3 messages.
- Reply button (↩) on schedule message tasks opens AACChatPanel and pre-selects the sender contact.

**Twilio env fix**
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` were set but empty in Vercel production. Values pushed from `.env.local`.

**Training infrastructure** (vast.ai)
- `autonomous-training-protocol` skill: mandatory layer3 corpus assert (≥40 examples), BFCL ≥90% gate before "done".
- `train_max_quality_vastai.py`: DoRA SFT script with paged_adamw_8bit, TRL API compat, crash.log, PID file, SIGTERM handler.
- `monitor_training.sh`: 5-min polling daemon with macOS alerts, crash dedup, GPU stall detection, disk threshold.
- Layer3 corpus (45 examples) merged into training data for 32B/35B tier.

### Why a major bump

The drift detection + evidence-first protocol represent a change in how Prism agents operate — not just what they can do. These behavioral guarantees are additive but meaningful enough to warrant a major version signal.

### npm

```
npm install -g prism-mcp-server@15.0.0
```

---

## [14.0.0] - 2026-05-07 — 🧠 Prism Coder: project rename + algorithm-stability contract

The project is renamed from **Prism MCP** to **Prism Coder** to reflect its full surface — the Mind Palace memory server *and* the `prism-coder:7b` / `prism-coder:14b` open-weights LLM fleet that ships alongside it. The npm package remains published as `prism-mcp-server` so existing install URLs (`npm install -g prism-mcp-server`, `npx prism-mcp-server`, the `mcp.json` entries every consumer already wrote) keep working without churn — but the `prism-coder` binary that package provides has been the canonical entry point since v12, and "Prism Coder" is now the user-facing project name across README, docs, and all new surfaces. v14.0.0 also formalises Prism's algorithm exports as a stable public contract so external consumers can depend on the constants without re-implementing them.

### What's new

- **Algorithm-stability contract.** The following exports are now considered stable public API under SemVer: `actrActivation.ts` (`baseLevelActivation`, `parameterizedSigmoid`, `compositeRetrievalScore`, all `ACT_R_*` / `DEFAULT_*` constants); `spreadingActivation.ts` (`applySpreadingActivation`, the 0.7/0.3 hybrid score blend, the `finalM=7` cap); `routerExperience.ts` (`getExperienceBias`, `MAX_BIAS_CAP=0.15`, `MIN_SAMPLES=5`, the bias-scale formula); `compactionHandler.ts` (default `threshold=50`, `keep_recent=10`, `MAX_ENTRIES_CHARS=25_000`); `graphMetrics.ts` warning ratios (0.20 / 0.30 / 0.40 / 0.85 with their min-sample gates); `config.ts` (`PRISM_ACTR_DECAY`, `PRISM_GRAPH_PRUNE_MIN_STRENGTH`, full `PRISM_GRAPH_PRUNE_*` family). Breaking changes go through deprecation cycles announced here in CHANGELOG.

- **`docs/WOW_FEATURES.md`** — citation-grade catalogue of Prism's algorithms with their constants, semantics, and reuse patterns. Written for engineers who want their thresholds backed by published implementations rather than guesswork.

- **`docs/releases/v14.0.0-prism-as-foundation.md`** — release notes covering what the contract guarantees, why now, and the migration path for systems that have been re-implementing Prism algorithms in their own code.

- **First reference consumer documented:** an external audit hooks framework (separate skill, not in this repo) that ports ACT-R decay, the spreading-activation hybrid blend, experience bias, and the graph-metrics warning ratios with citations. 327 tests in that consumer pin the constants — divergence from this repo's source is caught automatically.

### Why a major bump

External systems were already building on Prism algorithms with hand-tuned approximations. Two failure modes when that happens: (1) the consumer's thresholds drift from Prism's over time, and (2) a copy-pasted constant loses its citation in 6 months and nobody remembers why `0.15` was chosen. Formalizing the stability contract fixes both.

### What's NOT in this release

- No new MCP tools.
- No model changes — `prism-coder:7b` and `prism-coder:14b` unchanged from v13.1.x.
- No schema changes.

### npm

`prism-mcp-server` v14.0.0 is published to npm — same package name, semver-major bump aligned with the project rename + the new public API contract. Earlier 13.1.1 stays available for users who want the pre-rename release.

---

## [13.1.1] - 2026-05-05 — Tool-call format normalizer + Modal training resilience

### Local LLM client
- **`normalizeToolCallFormat`** new helper at `src/utils/normalizeToolCallFormat.ts` — coerces three stochastic v18-clean tool-call format variants into the canonical singular wrapper:
  1. Plural wrapper + XML-attr params: `<tool_calls><tool_call name="X"><param name="Y" value="Z"/></tool_call></tool_calls>`
  2. CJK angle brackets: `〈tool_call〉{...}〈/tool_call〉`
  3. `<functioncall>` envelope with stringified or object arguments
  
  All three normalize to: `<tool_call>{"name":"X","arguments":{"Y":"Z"}}</tool_call>`
- **`callLocalLlm`** pipes raw model output through the normalizer before the existing think-tag / multi-format extractor, so downstream parsers see only canonical input.
- **12-test suite** at `tests/normalizeToolCallFormat.test.ts` — covers each variant + multi-call + surrounding text + canonical pass-through + malformed JSON fallback.

### Training infra hardening
- **`modal-training-resilience` skill applied to 32B resume + polish scripts** (`training/modal_v18coder_32b_resume.py`, `training/modal_v18coder_32b_polish_phase1_5.py`):
  - `GracefulExitCallback` at `0.92 × MODAL_TIMEOUT_S` — saves + clean-stops before Modal's hard kill (Phase 1 lost 481 steps to a hard kill we want to never repeat)
  - `save_steps` tightened: resume 500→200, polish 200→100
  - `local_entrypoint()` now raises with explicit `--detach` instructions — the silent `.spawn()` failure mode is documented in the error message
- **103-file training infra catchup** committed — Python builders, deploy scripts, eval tools, DoRA YAML config, and research notes that had accumulated untracked over the v17/v18 campaign. `.gitignore` extended to drop iterative `Modelfile.v[0-9]*` experiments and BFCL output dumps.

### Production Modelfiles
- `training/Modelfile.published` and `training/Modelfile.restore` now committed — these were untracked but are the canonical production / rollback Modelfiles for `prism-coder:7b`.

### Test counts
- `tests/normalizeToolCallFormat.test.ts`: 12/12 passing in 82ms.

---

## [13.1.0] - 2026-05-04 — 🤖 Prism Coder 14B sibling + tier-aware local routing

Coordinated cross-product release with **portal v0.14.4** and **prism-aac v0.2.1**. No prism-mcp-server code changes (the model fleet lives in Ollama; npm package is unchanged) — this entry documents what ships through the Synalux portal that prism-mcp clients reach.

### Model fleet
- **`prism-coder:7b` re-trained from clean Qwen2.5-Coder-7B base.** Replaces v18aac-MAX (BFCL 47.2%) with v18clean-epoch0 (BFCL **88.1%** 3-run StdDev 0%, AAC realigned **47/48 (97.9%)**, caregiver targeted **20/20**, emergency_qa 13/13, text_correct 15/15, translate 8/8). +40.9pp BFCL recovery, no AAC regression.
- **`prism-coder:14b` sibling shipped.** Qwen2.5-Coder-14B base + AAC SYSTEM directive, **32K context**, BFCL 85.9%, AAC 46/48 (95.8%), caregiver targeted 18/20.
- **Rollback path:** `ollama cp prism-coder:7b-prev-20260504-1325 prism-coder:7b` (≤ 1 min restore).

### Tier-aware local routing (Synalux portal)
- New pure-function routing module with **39 TDD tests** pinning behaviour. Security-hardened: privilege boundary on tier sanitization, ReDoS-proof regexes, audit-safe reason strings (fixed enumeration), failsafe defaults, p99 < 1ms.
- Routing matrix:
  - `free` simple → `prism-coder:7b` local · medium → Gemini Flash · complex → Gemini Flash
  - `standard` simple → 7B · medium → `prism-coder:14b` local · complex → Claude Haiku
  - `advanced` / `enterprise` simple → 7B · medium → 14B local · complex → Claude Opus
- Saves ~$0.01–0.05 per paid-tier medium AAC query (Claude → local 14B). Estimated annual saving ≈ $190K–210K at 10K-user scale.

### Azure Neural TTS unblocked for all tiers
- Removed free-tier 403 gate on `/api/v1/tts`. Azure Neural voice + auto-tone-switch now work for every authenticated tier. Cost ≈ $480/mo at 10K users — acceptable AAC dignity baseline.

### Phase 0 of the 32B/72B campaign — Synalux/Prism-Memory training data
- Built `synalux_sft_pipeline.py` (~570 lines): extracts from local `~/.prism-mcp/data.db` SQLite + Prism Supabase, anonymises (PII / customer names / paths / secrets / clinical), chunks long content, renders Qwen `<|im_start|>` ChatML.
- 5,721 training rows generated, **zero PII leaks** across 5-pattern audit (customer names, emails, phones, paths, API keys).
- Phase 1 (32B SFT, ~$340) launched on Modal H100×4 today; Phase 2 (72B) queued.

## [13.0.1] - 2026-05-02 — 🔧 Executable bin permissions

Bug fix: when installed globally via `npm i -g prism-mcp-server`, the
binaries (`prism`, `prism-coder`, `prism-mcp-server`, `prism-import`)
ended up without the execute bit, so MCP clients (Claude Code, Claude
Desktop, Cursor, etc.) couldn't launch the server — they'd get a
"permission denied" when trying to spawn it.

Root cause: `tsc` doesn't preserve or set the +x bit on its compiled
output, and the published tarball inherited the missing perm.

Fix:
- Added `npm run chmod-bins` to set 0755 on `dist/cli.js`,
  `dist/server.js`, `dist/utils/universalImporter.js`.
- `build` now runs `tsc && npm run chmod-bins`.
- `prepublishOnly` runs the full build to guarantee published tarballs
  have the right perms regardless of how the maintainer publishes.

If you hit "permission denied" on 13.0.0, either upgrade to 13.0.1 or
manually `chmod +x` the files in `~/.npm-global/lib/node_modules/prism-mcp-server/dist/`.

## <a name="1300"></a>[13.0.0] - 2026-05-02 — 🧬 The Adaptive Release

> **prism-coder now feels.** Every response the model returns is shaped in real time by the user's emotional register, motor rhythm, and ambient environment — without anyone writing a "be empathetic" instruction. PrismAAC, Synalux, and prism-mcp now share a single behavioral profile that travels with the user across surfaces, and skill routing is canonical at synalux instead of duplicated across three repos.

### ✨ Wow factor — what users notice immediately

- **Auto Tone Switch.** When a child types `"I need help!"` on PrismAAC, the TTS voice automatically softens to a calm, slower, emergency register — *and* the prism-coder response is shaped to validate first, then offer concrete next steps. No flag, no setting. The model receives an `<adaptive_context>` block on every chat carrying `dominant_mood`, `current_utterance_guidance`, and the user's preferred categories.
- **Cursor that learns.** PrismAAC's head/body/finger trackers feed actual dwell-to-trigger latency back into the adaptive engine. After ~10 selections the dwell time, smoothing alpha, and cursor sensitivity all adapt to the child's motor rhythm, clamped to safe ranges (`400–3000ms` dwell, never silences voice).
- **Identity-locked tracking.** Multi-camera face tracker and pose tracker now reject other faces in the frame via IoU continuity — no more cursor jumping to a sibling who walks behind the user.
- **One source of truth.** Skill routing for the entire prism-coder ecosystem now lives in synalux at `/api/v1/skills/routing`. Adding a new project skill is one PR in synalux; prism-mcp + future surfaces pick it up within 5 minutes via cached fetch.

<details>
<summary>🧬 Adaptive Engine — 5 systems, BCBA-aligned</summary>

The adaptive engine observes 5 dimensions of user behavior and shapes runtime parameters accordingly. All adaptations are **additive** (never restrict capability), all guarded by hard safety clamps tested as invariants:

1. **Tone** — `detectTone(text)` returns one of `neutral | friendly | excited | empathetic | serious`. Routes Azure TTS style, speech rate, and a system-prompt addendum injected into prism-coder. Detection is Unicode-aware tokenize + light stem so `"hurts"`, `"hurting"`, `"bleeding"` all match.
2. **Gesture speed** — running average of dwell-to-trigger latency + cursor velocity. After 1000 samples, switches from straight average to EMA (α=0.02, half-life ≈ 35 samples) so a real motor regression is still tracked.
3. **Pronunciation** — learns "wawa → water" patterns. Hard guard: emergency words (help/hurt/scared/911/bleeding/choking/fire/stuck/lost) are *uncorrectable* — neither `recordMispronunciation` nor `correctPronunciation` will let them be shadowed.
4. **Background noise** — EMA noise floor with `threshold = floor + 15dB`, **clamped at ≤ -20dB** so a loud environment never pushes the threshold above what voice can hit.
5. **Prompt patterns** — frequency-weighted category preference (`count × exp(-age_days/14)`), 30-day decay on time-of-day vocabulary so summer routines don't haunt the autumn UI.

`PROFILE_VERSION = 2` with v1 → v2 migration. Schema lives canonically at `the Synalux portal`; PrismAAC mirrors it for offline operation, with `training/sync_adaptive_engine.sh` as a structural drift check.

Hysteresis: `dominantMood` only flips when ≥6 of last 10 events agree, so a single emergency doesn't trap the system in `'urgent'` for the next half hour.
</details>

<details>
<summary>📡 Cross-system wiring</summary>

```
PrismAAC client ──► autoSwitchTone() ──► Azure style + rate
       │
       ├─► localStorage profile (free tier)
       │
       └─► POST /api/v1/adaptive/profile (paid tier sync)
                    │
                    ▼
             Supabase adaptive_profiles (RLS'd)
                    │
                    ▼
       /api/v1/chat ──► buildSystemContext({ latestUtterance })
                    │
                    ▼
       prism-coder receives <adaptive_context> block
```

For MCP clients (Claude Desktop, IDE assistants, voice agents), 5 new tools expose the same profile via prism-mcp:

- `adaptive_get_profile` — current profile + signals snapshot
- `adaptive_set_profile` — caregiver/admin replace
- `adaptive_record_event` — incremental write
- `adaptive_detect_tone` — pure function, no side effects
- `adaptive_reset` — caregiver wipe (`confirm: true`)
</details>

<details>
<summary>🛡️ Security hardening</summary>

- **CSP**: Removed global `'unsafe-eval'` from synalux portal CSP. MediaPipe WASM runs on the proxied `prism-aac.vercel.app` origin, so synalux pages don't need eval relaxations. The prior policy disabled CSP's primary defense across the entire portal.
- **Permissions-Policy**: Per-route allowlist. `/prism-aac/*` and `/telehealth/*` get camera+mic; everywhere else explicitly denies.
- **PHI redaction**: 50+ ABA/clinical-vocabulary phrase allowlist — `Applied Behavior Analysis`, `Discrete Trial Training`, `Functional Behavior Assessment` etc no longer redacted to `[REDACTED] [REDACTED] Analysis`. Real names still redacted.
- **Emergency endpoint**: Added per-destination rate limit (3 calls/hr to the same number from any source IP), max 5 contacts/request, E.164 validation. Closes the Twilio-abuse vector where rotating IPs could spam arbitrary numbers.
- **prism-mcp encryptedSync**: Wrapped `JSON.parse` so a malformed packet from a misbehaving peer no longer crashes the receiver with an unhandled `SyntaxError`.
- **prism-mcp SSRF**: Loopback gated behind `PRISM_DEV_MODE` flag instead of unconditionally rejected (private RFC1918 ranges still always denied).
</details>

<details>
<summary>🧪 Testing</summary>

- prism-mcp: 17 new tests covering skill routing fallback chain + encryptedSync corruption guard.
- synalux portal: 31 new tests for PHI clinical-allowlist + emergency endpoint validation.
- prism-aac: 121 tests pass (48 adaptive, 53 camera tracking + identity locking, 20 head-tracker edge cases).

```bash
# Adaptive engine drift check across repos
bash /Users/admin/prism/training/sync_adaptive_engine.sh
```
</details>

### Migration

No client breaking changes. Adaptive profile localStorage is auto-migrated v1 → v2 on first read. Skill content keys (`skill:*`) unchanged — only the routing source moved.

### Acknowledgments

This release was driven by a deep code review that surfaced numerical correctness, safety, and cross-system architectural issues in prior agent-authored commits. The single-source-of-truth principle came from user direction: "do not just copy paste skills for each".

---

## <a name="1200"></a>[12.0.0] - 2026-04-23 — 💳 Unified Billing & Agent Skill Ecosystem

> **The Platform Unification Release.** Prism v12.0.0 aligns Prism and Synalux into a single, unified billing architecture with identical tier pricing, adds 54 production-ready agent skills, and introduces a 14-day free trial across all paid tiers.

### 💳 Unified Billing Architecture

- **Synalux-Priced Tiers** — Both Prism and Synalux now share identical pricing: Standard ($19/mo), Advanced ($49/mo), Enterprise ($99/mo). Prism retains an additional Free tier for community access.
- **14-Day Free Trial** — All paid tiers (Standard, Advanced, Enterprise) include a 14-day trial period. Configured via `DEFAULT_TRIAL_DAYS` constant with automatic Stripe `subscription_data.trial_period_days` injection.
- **Stripe Test-Mode** — Test-mode price IDs documented inline (`price_test_standard_19`, `price_test_advanced_49`, `price_test_enterprise_99`). Production IDs loaded from environment variables.
- **Removed Legacy Tiers** — Deleted `prism_pro` ($12) and `prism_elite` ($29) plan definitions. Synalux Free tier removed from `PlanId` type and `BASE_PRICE_TABLE`.
- **Prism Checkout Route** — Updated `/api/v1/prism/checkout` to use `DEFAULT_TRIAL_DAYS` (was hardcoded to 0). New users default to `prism_free` plan.

### 🧠 Agent Skill Ecosystem (54 Skills)

- **10 Super-Skills Compacted** — Reduced from 22,937 to 6,191 lines (73% reduction) by stripping verbose comparison matrices and code templates, retaining essential decision tables and checklists.
- **4 Medical Skills** — `hipaa-compliance`, `clinical-documentation`, `medical-billing-coding`, `patient-data-privacy` — healthcare-specific compliance and workflow automation.
- **10 Vendor Skills** — Vercel, Supabase, Stripe, Sentry, OpenAI, Addy Osmani, Garry Tan/gstack — tailored for the Synalux tech stack.
- **Skills Centralized** — Single source of truth at `/skills/`, symlinked to IDE extensions directory.

### 🎨 Pricing Page UI

- **Synalux Section** — 3-tier card layout (Standard, Advanced, Enterprise) with feature lists, hover animations, and CTA buttons wired to Stripe checkout.
- **Prism IDE Section** — New dedicated section for Prism Coder IDE Extension with 4-tier layout (Free, Standard, Advanced, Enterprise).
- **Multi-Currency Table** — USD, CAD, GBP, EUR, AUD, NZD pricing with volume discount tiers.
- **14-Day Trial Badge** — Prominent green banner across all paid tier cards.

### Engineering
- Files changed: `stripe.ts`, `pricing-engine.ts`, `pricing/page.tsx`, `prism/checkout/route.ts`, `package.json`, `CHANGELOG.md`
- Licenses verified: Prism (MIT), Synalux (BSL-1.1)
- TypeScript: clean, zero errors expected

---



## <a name="1160"></a>[11.6.0] - 2026-04-22 — 🏗️ Agent Infrastructure Resilience

> **The Multi-Agent Stability Release.** Prism v11.6.0 introduces production-grade infrastructure for running multiple AI agents concurrently without resource exhaustion, deadlocks, or zombie processes. Every component is cross-platform (macOS/Linux) with zero GNU dependencies.

### 🏗️ Agent Infrastructure

- **Serialized Execution Queue (`agent_queue.sh` v2.0)** — Complete rewrite replacing GNU `flock` with Python `fcntl.flock` for macOS-native file locking. Ensures strict mutual exclusion when loading Ollama models, preventing OOM crashes from concurrent model loads. Includes PID tracking and automatic cleanup on exit.
- **Memory Guardian Daemon (`memory_guardian.sh`)** — Background watchdog that proactively monitors RAM pressure via `vm_stat` page-out rate. Auto-evicts idle Ollama models before swap exhaustion occurs. Configurable thresholds with graceful degradation. Logs to `/tmp/memory_guardian.log`.
- **Queue Watchdog (`queue_watchdog.sh`)** — Detects and auto-drains hung queue entries based on PID file age (>10 min). Prevents deadlocks in long-running pipelines. Non-destructive: only removes entries whose owning process has exited.
- **Unified Status Dashboard (`agent_status.sh`)** — Color-coded CLI providing real-time visibility into queue depth, guardian health, Ollama model status, and system memory. Supports `--json` mode for programmatic consumption by other tools and CI/CD pipelines.

### 🧪 Testing & Verification

- **115/115 Tests Passing** across 5 test suites:
  - **Unit tests** (60) — Core `claw_agent_lite.py` logic: model selection, hardware detection, streaming buffer, error handling
  - **Concurrent tests** (17) — File lock contention, parallel agent serialization, race condition guards
  - **Shell integration tests** (21) — `agent_queue.sh`, `memory_guardian.sh`, `ollama_warmup.sh` lifecycle and interaction
  - **Mock Ollama integration** (8) — Self-contained HTTP mock server for deterministic pipeline testing without live models
  - **Live stress tests** (9) — Real Ollama integration under concurrent load with status dashboard verification

### 🔧 Codebase Hardening

- **Bash `set -e` Arithmetic Fix** — Resolved `((x++))` pitfall where zero-result arithmetic causes script exit under strict mode. Applied across all shell scripts.
- **macOS Compatibility** — Eliminated all GNU-specific dependencies (`flock`, `timeout`, `readlink -f`). All scripts work out-of-the-box on macOS and Linux.
- **10 Bug Fixes in `claw_agent_lite.py`** — JSON parsing resilience, null pointer guards, connection failure handling, streaming buffer for split `<think>` tags, and proper error propagation for programmatic integration.

### Engineering
- New files: `agent_queue.sh` (v2.0), `memory_guardian.sh`, `queue_watchdog.sh`, `agent_status.sh`, `test_integration_pipeline.py`, `test_shell_scripts.sh`, `test_live_stress.sh`
- Modified: `claw_agent_lite.py`, `ollama_warmup.sh`
- All changes verified on Apple M4 Max (36GB) and compatible with M3 (18GB)

---

## <a name="1151"></a>[11.5.1] - 2026-04-22 — 🛡️ Cross-Platform Reliability & CI Recovery

> **The Stability Patch.** This version fixes regressions in the CI pipeline and ensures the 100% precision release is fully compatible with Windows and macOS environments.

### 🛡️ CI & Cross-Platform Fixes
- **Cross-Platform Test Suite** — Replaced all hardcoded `/tmp` paths with `os.tmpdir()` across `imageCaptioner.test.ts`, `definitions.test.ts`, and `sessionExportMemory.test.ts`. This resolves test failures on Windows CI runners.
- **CI Workflow Optimization** — Split unit tests and heavyweight CLI integration tests into separate serial steps. This reduces resource contention and parallel load on GitHub Action runners, ensuring stable pass rates for process-level drift checks.
- **Broken Anchor Fix** — Corrected documentation links in README to point to the new v11.5.x changelog headers.

## <a name="1150"></a>[11.5.0] - 2026-04-22 — 🧠 Structural GRPO Alignment (100% Accuracy)

> **The Precision Release.** This version marks the successful completion of the Structural GRPO (Group Relative Policy Optimization) alignment phase, achieving perfect tool-calling scores and hardening the response pipeline against reasoning tag drift.

### 🧠 Structural GRPO Alignment & Hardening
- **100.0% Tool-Call Accuracy (Verified)** — Cross-validated the structural reward model on the Synalux clinical platform, achieving perfect scores in tool-name identification and parameter mapping.
- **Central Structural Tag Handler** — Added logic to `src/utils/localLlm.ts` to automatically strip `<|synalux_think|>` blocks and extract content from `<|tool_call|>` tags. This ensures downstream tools receive clean JSON even if the model's raw output contains internal reasoning tokens.
- **`<think>` Reasoning → `<tool_call>` Action** — Forced a strict response pattern where the model MUST provide CoT reasoning before invoking a tool. This eliminates "hallucinated action" by grounding every tool call in explicit logical steps.
- **Deterministic Reward Function** — Replaced stochastic reward models with a strict structural validator that penalizes non-standard tags and rewards project-standard structural blocks.

### 🧪 Benchmarks & Performance
- **JSON Validity: 100.0%** — Guaranteed schema adherence for all local model outputs.
- **Parameter Accuracy: 100.0% (Synalux) / 33.3% (Prism Base)** — Significant boost in parameter mapping for clinical toolsets; base Prism toolset undergoing Phase 2 alignment.
- **Inference Speed** — Optimized `prism-coder:7b` for 45.1 Tokens/sec on M4 Max hardware.

### Added
- **`grpo_align.py`** — New high-intensity alignment script with structural enforcement and synthetic preference injection.
- **`benchmark.py`** — Enhanced verification harness with robust JSON extraction and multi-format support.

---

## <a name="1101"></a>[11.0.1] - 2026-04-21 — 🧪 Zero-Search Field Testing & Security Refinement

> **Bridging Research and Practice.** This release documents the successful field testing of v11 Zero-Search Retrieval in the Synalux practice management system and finalizes the HIPAA-hardened security logic.

### 🔬 Zero-Search Retrieval (Field Testing)
- **Synalux Integration** — Verified the core mathematical unbinding engine (Circular Convolution + Superposition) in high-compliance clinical workflows.
- **O(1) Retrieval Performance** — Proved constant-time fact recovery regardless of working memory size. Synalux benchmarks show 1.17x speed advantage over traditional linear scans at 100+ facts.
- **Cognitive Suit Verification** — Full linkage to verified [math](./src/sdm/hdc.ts) and [tests](./tests/verification/cli-integration.test.ts).

### 🔒 HIPAA-Hardened Local LLM (Logic Merge)
- **Local Logic Finalization** — Complete merge of `prism-coder:7b` task routing and ledger compaction logic.
- **Fail-Closed Security** — Reinforced `PRISM_STRICT_LOCAL_MODE` behavior across all cognitive handlers to prevent accidental ePHI egress.
- **XML Injection Defense** — Universal escaping for user-controlled strings in compaction prompts.

### Engineering
- **Version Bump** — Incremented to `11.0.1` for formal release.
- **Cross-Repo Sync** — Documentation and roadmap alignment with Synalux private prototypes.

---

## <a name="1100"></a>[11.0.0] - 2026-04-18 — 🛡️ HIPAA-Hardened Local LLM Engine

> **The most security-hardened release in Prism history.** 22 adversarial findings identified and closed across 3 rounds of attack-surface review. Your agent's memory now runs entirely on-device — and stays there.

### 🔒 HIPAA-Grade Security Architecture

- **`PRISM_STRICT_LOCAL_MODE`** — New environment variable (default: `false`). When `true`, ledger compaction will **never** fall back to a cloud LLM if the local model fails. Throws a structured HIPAA error instead of silently exfiltrating ePHI to Gemini/OpenRouter. Critical for healthcare, legal, and defense deployments.
- **SSRF Redirect Prevention** — `fetch()` in `callLocalLlm()` now uses `redirect: "error"` to reject 3xx responses. Prevents SSRF chains where a malicious Ollama endpoint redirects to AWS IMDS (`169.254.169.254`) or internal services.
- **URL Credential Redaction** — New `redactUrl()` helper strips `user:pass@` from all log paths (startup log in `config.ts` + per-call `debugLog` in `localLlm.ts`). Malformed URLs safely return `"[invalid URL]"` via `try/catch`.
- **Entry-Boundary Truncation** — `buildCompactionPrompt()` truncation now splits on `\n\n` entry boundaries instead of raw character offsets. Prevents mid-tag XML breakout (`<raw_use` → malformed XML → prompt injection).
- **Full XML Escaping** — `escapeXml()` expanded from 2 entities (`< >`) to all 5 standard XML entities (`& < > " '`). Applied to all user-controlled fields: `summary`, `decisions[]`, `files_changed[]`, `id`, and `session_date`.
- **Task Boundary Tags** — `askLocalLlmForRoute()` wraps task descriptions in `<task></task>` delimiters with an explicit security boundary instruction. Description is XML-escaped before injection to prevent `</task>` breakout.
- **setTimeout Integer Overflow Guard** — `PRISM_LOCAL_LLM_TIMEOUT_MS` capped at `300,000` ms (5 min). Values exceeding `2^31-1` previously caused `setTimeout` to fire immediately, silently aborting every local LLM call.
- **Graceful HIPAA Error Handling** — `compactLedgerHandler()` wraps `summarizeEntries()` in `try/catch`. If `PRISM_STRICT_LOCAL_MODE` throws, returns a structured MCP error (`isError: true`) instead of crashing the server.

### Added
- **`callLocalLlm()` Utility** — New thin HTTP client for Ollama `/api/chat` (`src/utils/localLlm.ts`). Non-streaming, silent-fail (returns `null`), feature-gated by `PRISM_LOCAL_LLM_ENABLED`. Includes availability probe (`isLocalLlmAvailable()`).
- **Local Compaction Path** — `summarizeEntries()` now attempts `callLocalLlm()` first when `PRISM_LOCAL_LLM_ENABLED=true`. Falls back to `getLLMProvider()` (cloud) unless strict mode blocks it.
- **LLM Routing Tiebreaker** — `askLocalLlmForRoute()` in `taskRouterHandler.ts` consults `prism-coder:7b` when heuristic confidence is below threshold. Purely additive — timeouts and failures fall back to the original heuristic result.
- **4 New Environment Variables:**
  - `PRISM_LOCAL_LLM_ENABLED` (boolean, default: `false`) — Master switch for local LLM integration
  - `PRISM_LOCAL_LLM_MODEL` (string, default: `prism-coder:7b`) — Ollama model tag
  - `PRISM_LOCAL_LLM_URL` (string, default: `http://localhost:11434`) — Ollama base URL
  - `PRISM_LOCAL_LLM_TIMEOUT_MS` (number, default: `60000`, max: `300000`) — Per-call timeout
  - `PRISM_STRICT_LOCAL_MODE` (boolean, default: `false`) — Block cloud fallback for HIPAA

### Security Audit Summary

| Round | Scope | Findings | Fixed |
|:-----:|-------|:--------:|:-----:|
| 1 | Initial adversarial review | 6 | 6 |
| 2 | Verification of Round 1 fixes | 4 gaps | 4 |
| 3 | Final verification | 0 | — |
| **Total** | | **10** | **10 ✅** |

### Engineering
- 4 files changed: `src/config.ts`, `src/utils/localLlm.ts`, `src/tools/compactionHandler.ts`, `src/tools/taskRouterHandler.ts`
- TypeScript: clean, zero errors
- All changes verified across 3 rounds of adversarial review



### Added
- **Dynamic Hardware Routing** — `claw_agent_lite.py` now leverages platform-aware memory detection (`sysctl hw.memsize` on Darwin) to auto-select optimal models. Automatically targets 32b reasoning and coding models on hardware ≥32GB Unified Memory, degrading gracefully to 14b and 7b architectures for performance stability and OOM avoidance.
- **Nomic Semantic Tool Pruning (RAG)** — Decoupled the 17 MCP Tools from static system prompt bloat. Embedded all tools into offline vectors using `nomic-embed-text-v1.5`. At runtime, user queries undergo cosine similarity analysis, injecting only the Top-3 highest-scoring tool schemas into the active context limit, maximizing inference speed.
- **Chain-of-Thought (CoT) Distillation & GRPO** — Upgraded the model extraction compiler (`extract_traces.py`) to systematically inject strict `<think>` reasoning tags, training the LoRA adapters to map thought evaluation prior to `<tool_call>` emit cycles.
- **Enhanced MLX Training Safety** — Applied dynamic parameter caps (`--batch-size 1`, `--max-seq-length 1024`) to eliminate Metal OOM allocation errors natively inside local training sequences. 
- **Tested & Benchmarked Loop** — Integrated the `benchmark.py` evaluator capable of mapping reasoning accuracy correctly in compliance with GRPO constraints.



## <a name="9130"></a>[9.13.0] - 2026-04-17 — Local Embeddings & Zero-API-Key Setup

### Added
- **Local Embedding Adapter** — New `LocalEmbeddingAdapter` using `@huggingface/transformers` + `nomic-ai/nomic-embed-text-v1.5` (768 dims, quantized q8 by default). Generates embeddings entirely on-device with zero API keys required. Configurable via `embedding_provider=local` in the Mind Palace dashboard.
  - Async pipeline initialization with `loadPromise` pattern — server never blocks on model download
  - Automatic truncation at 8K chars with word-boundary-aware splitting
  - Warmup call on init for consistent first-query latency
  - `search_document:` prefix for optimal Nomic retrieval quality
- **Disabled Text Adapter** — New `DisabledTextAdapter` stub (`text_provider=none`) for setups that only need embeddings. Throws clear error messages directing users to configure a text provider.
- **Model Security Validation** — Configurable `local_embedding_model` and `local_embedding_revision` settings with strict input validation:
  - Model ID regex (`owner/name` format, length limits, no special characters)
  - Separate `..` directory traversal check
  - Revision restricted to `main`, 40-char SHA, or semver tags
  - `HF_ENDPOINT` hostname validation warns on non-HuggingFace domains

### Changed
- **Removed `GOOGLE_API_KEY` Guard** — `sessionSearchMemoryHandler`, `sessionSaveLedgerHandler`, and `sessionSaveHandoffHandler` no longer require `GOOGLE_API_KEY` to be set. Embedding generation now routes through the configured adapter (local, gemini, openai, voyage). Previously, missing `GOOGLE_API_KEY` would block semantic search entirely even when a local adapter could handle it.
- **Capability Matrix Updated** — Semantic vector search now shows ✅ for Local (Offline) mode with `embedding_provider=local`.

### Dependencies
- Bumped `follow-redirects` from 1.15.11 to 1.16.0 (security)
- Bumped npm_and_yarn group (2 updates)
- `@huggingface/transformers` added as optional peer dependency (~3.1.0)

### Tests
- **1622 total tests** across 55 suites (all passing, zero regressions)
- 3 new test files:
  - `tests/llm/local.test.ts` (341 lines) — Happy path, truncation, model ID validation, revision validation, HF_ENDPOINT, pipeline failures, determinism
  - `tests/llm/local-missing-dep.test.ts` (57 lines) — Graceful degradation when `@huggingface/transformers` is not installed
  - `tests/llm/factory.test.ts` (+54 lines) — `local` embedding selection, `none` text provider, combined `none+local`

### Engineering
- 15 files changed, +1760 / -466
- TypeScript: clean, zero errors
- Runtime verified: 768-dim normalized vectors, deterministic outputs, all 8 edge cases pass (empty text, whitespace, 10K+ chars, unicode, HTML injection, single char)
- Co-authored-by: Gerald Onyango ([@futuregerald](https://github.com/futuregerald)) — PR #56


## <a name="9120"></a>[9.12.0] — Memory Security Hardening (Stored Prompt Injection Prevention)

### Security
- [CRITICAL] Stored Prompt Injection Prevention — New `sanitizeMemoryInput()` function strips 8 categories of dangerous XML-like tags (`<system>`, `<instruction>`, `<user_input>`, `<assistant>`, `<tool_call>`, `<anti_pattern>`, `<desired_pattern>`, `<prism_memory>`) from all text fields before persistence. Without this, a compromised LLM could save `summary: "Fixed bug. <system>Ignore all instructions.</system>"` — and every *future* session loading this context would be hijacked (stored XSS equivalent for AI systems).
  - Applied to `sessionSaveLedgerHandler`: `summary`, `decisions[]`, `todos[]`
  - Applied to `sessionSaveHandoffHandler`: `last_summary`, `key_context`, `open_todos[]`
  - Zero-latency: pure regex, no API calls, runs on every save
  - Case-insensitive with attribute-aware matching
  - Tag list mirrors Synalux's `sanitizeMessages()` for cross-stack consistency
- **[HIGH] Context Output Boundary Tags** — All context output paths now wrap loaded memory in `<prism_memory context="historical">` boundary tags with an HTML comment instructing the LLM to treat the content as data, not instructions. Prevents context confusion attacks where historical memory text could be mistaken for system instructions.
  - Applied to `sessionLoadContextHandler` (MCP tool)
  - Applied to `GetPromptRequestSchema` handler (`/resume_session` prompt)
  - Applied to `ReadResourceRequestSchema` handler (`memory://` resource)
- **[HIGH] Boundary Tag Spoofing Prevention** — `<prism_memory>` is included in the sanitization regex, preventing attackers from injecting fake boundary tags into saved text to confuse the LLM's understanding of the memory structure.

### Added
- **`sanitizeMemoryInput()` Export** — Exported from `ledgerHandlers.ts` for use in tests and potential downstream consumers.
- **`sanitizeArray()` Helper** — Maps `sanitizeMemoryInput()` over string arrays (todos, decisions, open_todos).

### Tests
- **30 new security tests** (Section 24: "Prism Memory Security Hardening"):
  - 14 XML tag stripping vectors (system, instruction, user_input, assistant, tool_call, anti_pattern, desired_pattern, prism_memory, case variations, nested tags, attributes, self-closing)
  - 6 safe content preservation tests (HTML, markdown, code blocks, plain text)
  - 4 edge cases (empty string, whitespace-only, multiple tags, self-closing style)
  - 3 real-world attack scenarios (cross-session memory poisoning, Hivemind multi-agent poisoning, boundary tag spoofing)
  - 5 boundary tag structure verification tests
- **311 total tests**, all passing, zero regressions

### Engineering
- 3 files changed: `src/tools/ledgerHandlers.ts`, `src/server.ts`, `tests/intent-classification.test.ts`
- TypeScript: clean, zero errors
- Adapts Synalux security review findings #3 (unsanitized tool responses) and #4 (missing boundary tags) to Prism's MCP architecture

## [9.5.0] - 2026-04-15 — Adversarial Behavioral Hardening (Round 2)


### Added
- **Intent Classification Engine** — `tests/intent-classification.test.ts` with 84 tests covering:
  - 7 intent categories: tool_redirect, action_request, clinical_query, capability_query, dev_question, ambiguous, general
  - Cross-rule response validation (every response checked against ALL rules)
  - April 15 regression suite (5 exact production failures)
- **24 Forbidden Openers** — expanded from 6 to 24 negation/filler patterns:
  - Negation: I can't, Unfortunately, I apologize, Regrettably, I'm afraid, While I cannot, As an AI, I am prohibited, While I'd love to, To be honest
  - Sycophancy: Sure., Certainly, I can certainly + combo patterns (Yes/Sure/Certainly, let me...)
- **XML Anti-Tag System** — BAD→GOOD examples wrapped in `<anti_pattern>` / `<desired_pattern>` tags to prevent few-shot contamination
- **`<user_input>` Isolation** — user messages wrapped in XML tags, anti-injection instruction in system prompt
- **Uncertainty Escape Hatch** — "Missing: [item]" for specific required variables only (not generic refusal)
- **IF/ELSE Conflict Resolution** — replaces mathematical precedence (Rule 7 > Rule 6) with structural logic LLMs follow better
- **Binary Question Exception** — affirmative words ("Yes", "Absolutely") permitted only as direct answers to Yes/No questions

### Changed
- **Rule 4 expanded** — now covers both negation AND affirmative filler (renamed "No Negation/Filler Lead")
- **ABA Protocol** — upgraded from 5 rules to 7 rules across all 3 injection points (portal, VS Code, Prism)
- **Sycophancy regex broadened** — catches `Sure.`, `Sure!`, `Certainly,`, not just `Sure, I'd be happy to`
- **Escape hatch constrained** — only for specific system variables, prevents lazy model refusals

### Security
- XML prompt injection defense: strip `<anti_pattern>`, `<desired_pattern>`, `<user_input>` tags from user input
- Input sanitization in `sanitizeMessages()` prevents instruction hijacking via pasted XML

### Tests
- **282 total tests** (198 ABA rule + 84 intent classification)
- 19 sneaky negation variants (including 6 reviewer evasion patterns + 6 sycophancy patterns)
- Passed 2-round adversarial code review

## [9.4.7] - 2026-04-15 — ABA Precision Protocol (Foundational Behavioral Engine)

### Added
- **ABA Precision Protocol** — 5 foundational behavioral rules injected into every `session_load_context` output:
  1. **Observable Goals** — Every task must have a measurable, verifiable outcome (IOA ≥80%)
  2. **Precise Execution** — One step at a time, verify each step, stop-fix-verify on failure
  3. **No Reinforcement of Errors** — Read actual code/data before forming opinions; never repeat mistakes
  4. **Help First** — Always try to help with knowledge before redirecting to other tools
  5. **Fix Without Asking** — Fix bugs immediately; don't ask permission for obvious fixes
- **83-test behavioral verification suite** (`tests/v43-aba-precision.test.ts`) covering:
  - Rule 1: 28 tests (vague goal rejection, observable goal acceptance, IOA boundary at 80%/79%)
  - Rule 2: 17 tests (pipeline stop-on-fail, command verification, hung command detection, bulk dual-verification)
  - Rule 3: 28 tests (reinforcement detection, fix-without-asking, critical resolution memory, prompt efficiency)
  - Integration: 2 tests (full pipeline, failure-recovery)
  - Consolidation: 2 tests (contradiction proof, merged skill coverage)
- **Assessment document** — `examples/skills/aba-precision-protocol/ASSESSMENT.md` analyzing 6 domains where ABA concepts improve the platform

### Changed
- **Skills consolidation** — Merged 4 overlapping skills into unified ABA protocol:
  - `fix-without-asking` → ABA Rule 5
  - `command_verification` → ABA Rule 2 (hung-command specifics preserved)
  - `critical_resolution_memory` → ABA Rule 3
  - `ask-first` → **REMOVED** (contradicted `fix-without-asking`)
- **Split-brain detection** — Suppresses false warnings when Supabase is authoritative (cloud version > local)

## [9.4.6] - 2026-04-14 — Stealth Browser Automation Tool (`browse.py`)

### Added
- **`browse.py` — HIPAA-Hardened Stealth Browser CLI** — Local Playwright-based browser automation tool that replaces the unreliable cloud-based browser subagent. Runs entirely on localhost with zero cloud dependencies. Designed for healthcare-adjacent workflows with full HIPAA Security Rule compliance.

#### 6-Layer Anti-Detection Architecture
- **Layer 1: `playwright-stealth` v2.0.3** — JS evasion scripts (navigator.webdriver, plugins, permissions, languages)
- **Layer 2: Deep JS Init Script** — 12 custom fingerprint overrides injected before page scripts: WebGL vendor/renderer (Apple M3 Max Metal), `chrome.runtime/csi/loadTimes`, plugins, mimeTypes, `navigator.connection`, `outerHeight/Width`, `toString()` spoofing for overridden functions
- **Layer 3: Behavioral Stealth** — Human-like typing (30-120ms variable delays), scroll jitter, mouse movement with slight curves, occasional "thinking" pauses
- **Layer 4: Chromium Launch Args** — 20+ anti-automation flags, `--disable-blink-features=AutomationControlled`, `ignore_default_args=['--enable-automation']` to remove CDP detection vectors
- **Layer 5: Network Header Fixing** — Route handler fixes `sec-ch-ua`, `sec-ch-ua-platform`, `sec-fetch-*` headers on every HTTP request
- **Layer 6: Persistent Profiles** — Cookie jars survive restarts, consistent User-Agent per profile via hash-based selection (looks like a returning user)
- **100% pass rate on bot.sannysoft.com** — All 50+ detection tests passed (navigator.webdriver=null, plugins=5, WebGL=Apple Metal, Canvas consistent, all PHANTOM/HEADCHR/SELENIUM checks passed)

#### HIPAA Security Features
- **FileVault Enforcement** — Refuses to run if macOS Full Disk Encryption is disabled
- **Audit Log (`chmod 600`)** — `~/.browser_data/audit.log` tracks URLs + actions with strict file permissions, never logs PHI content
- **`--sanitize`** — Regex masks SSN, MRN, phone, email patterns before output reaches the LLM
- **`--cleanup` + Ephemeral Screenshots** — When active, screenshots are written to `/tmp` (avoids APFS Copy-on-Write residue on SSDs) then securely deleted after processing
- **UA ↔ WebGL Consistency Validation** — Startup validates User-Agent platform matches WebGL renderer to prevent enterprise WAF (Cloudflare Turnstile) mismatch detection

#### 3 Operating Modes
- **Single Command** — `browse.py open <url>`, `browse.py screenshot`, `browse.py read-dom`
- **Interactive REPL** — `browse.py repl` keeps browser open between commands with 10-minute idle timeout (prevents zombie Chromium), structured JSON output for agent parsing, and error resilience (exceptions caught, browser stays alive)
- **Pipe/Batch** — `echo "open https://..." | browse.py pipe` for scripted workflows

#### Google Docs Automation
- `gdoc-read` — Keyboard-shortcut extraction (Ctrl+A/C) bypasses Google Docs' canvas-based DOM
- `gdoc-type` — Human-like typing at cursor position
- `gdoc-find` — Ctrl+F navigation to specific text locations

### Engineering
- Dependencies: `playwright` + `playwright-stealth` (Python), Chromium browser binary
- 1 new file: `browse.py` (680 lines)
- Registered as `local-browser` Antigravity skill for future agent auto-routing
- Compatible with Prism Coder integration (Phase 3 planned)

---

## [9.4.5] - 2026-04-13 — Security: Command Injection Fix & Dependency Reduction

### Security
- **[HIGH] Command Injection in `isOrphanProcess`** — `lifecycle.ts:79` interpolated a PID from a file directly into an `execSync` template string (`ps -o ppid= -p ${pid}`). A local attacker could write a malicious PID file (e.g., `1; rm -rf /`) to execute arbitrary commands. Fixed by replacing `execSync` (shell) with `execFileSync` (no shell, args as array) and casting PID to `String(pid)`. Added 5-second timeout guard.
- **Dependency Reduction (25 → 23)** — Removed 2 unused runtime dependencies:
  - `@google-cloud/discoveryengine` — zero imports across `src/`
  - `dotenv` — zero runtime imports; moved to `devDependencies` (test-only)

### Engineering
- 3 files changed: `src/lifecycle.ts`, `package.json`, `package-lock.json`
- TypeScript: clean, zero errors
- CI: all 6 matrix jobs passing (ubuntu/macos/windows × Node 20/22)
- Closes [#53](https://github.com/dcostenco/prism-mcp/issues/53)

---

## [9.4.3] - 2026-04-13 — ESM Bundling Fix (async_hooks)

### Fixed
- **Dynamic require of "async_hooks" crash** — Previous dist was built by a bundler that inlined OpenTelemetry's CJS `require("async_hooks")` into ESM chunks, causing runtime failure (`Error: Dynamic require of "async_hooks" is not supported`). Rebuilt with `tsc` which emits proper ESM imports. Affects CLI (`prism`), session save/load, and MCP server startup.

### Engineering
- Build command remains `tsc` (not esbuild/tsup/bun). Bundler use for dist is now explicitly prohibited.
- Created `esm-bundling-fix` diagnostic skill for future prevention.
- TypeScript: clean, zero errors

---

## [9.4.2] - 2026-04-13 — Shell Injection Fix (Git Drift Detection)

### Security
- **Shell Injection in `getGitDrift`** — `oldSha` was interpolated directly into a template string passed to `execSync`, enabling arbitrary command execution via a corrupted database entry (e.g., `"; rm -rf /"`). Fixed by: (1) validating SHA format against `/^[0-9a-f]{4,40}$/i`, and (2) replacing `execSync` (shell) with `execFileSync` (no shell, args as array). Defense-in-depth: even if validation is bypassed, `execFileSync` prevents shell metacharacter injection.

### Engineering
- 1 file changed: `src/utils/git.ts`
- TypeScript: clean, zero errors

---

## [9.4.1] - 2026-04-12 — Adversarial Security Hardening & Bidirectional Sync

### Security — Adversarial Audit (18 Issues Found, 17 Fixed)

Two-pass adversarial code review treating the reviewer as an attacker. Final tally: 4 Critical, 5 High, 9 Medium — 17 resolved, 1 cosmetic deferred.

#### Critical Fixes
- **Fail-Closed Rate Limiter** — `atomicCheckAndIncrement` now returns `{ allowed: false }` on DB RPC failure instead of fail-open (previously granted unlimited free API access on any database outage)
- **Path Traversal Guard** — Import endpoints restricted to `$HOME` and `/tmp` directories. Paths validated against `isAbsolute()` + `existsSync()` before subprocess execution
- **Error Response Sanitization** — Chat route no longer leaks LLM provider names, error bodies, or stack traces to the client. All error paths return generic user-facing messages
- **Import Path Restriction** — Dashboard import API validates paths against an allowlist to prevent directory traversal attacks

#### High Fixes
- **Plan Name Alignment** — Tier keys renamed from `starter/pro` → `standard/advanced` to match DB `CHECK` constraint. Previously caused paying users to fall through to free-tier models (revenue-impacting)
- **CORS Allowlist** — Dashboard server replaces origin reflection with a strict allowlist (`localhost:PORT`, `127.0.0.1:PORT`, configurable via `PRISM_DASHBOARD_CORS_ORIGIN`)
- **Settings Key Allowlist** — Dashboard Settings API now rejects unknown keys. Only 15 explicit keys + `skill:`/`ttl:`/`autoload:` prefixes allowed. Prevents credential overwrite via arbitrary key injection
- **Config Default Regression** — `PRISM_STORAGE` default restored to `"local"` (had regressed to `"supabase"`)
- **Webhook Response Minimized** — Stripe webhook returns `{received: true}` instead of subscription lifecycle details

#### Medium Fixes
- **M1: Concurrency Counter Leak** — Refactored from 4 scattered `activeSessions` decrements to a single outer `try/finally`. Guarantees decrement on ALL exit paths (success, error, throw, stream abort)
- **M3: NextAuth JWT Enrichment** — Added `jwt` callback that enriches token with `dbUserId` and `plan` on initial sign-in. Extended `next-auth.d.ts` type declarations for both `Session` and `JWT` interfaces. Eliminates N+1 `getUserByEmail` queries on every API request
- **Token Name Sanitization** — 100-char limit + HTML tag stripping prevents XSS and storage abuse
- **Clickjacking Prevention** — `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` headers on all dashboard responses
- **SignIn Fail-Closed** — NextAuth `signIn` callback returns `false` on Stripe customer creation failure (previously swallowed error and allowed login without billing ID)
- **Request Body Size Limit** — `readBody()` in both `server.ts` and `graphRouter.ts` now enforces 10MB limit with early `req.destroy()` on oversize (prevents memory exhaustion DoS)

### Added
- **M4: Bidirectional Reconciliation** — New `pushReconciliation()` function (208 lines) in `reconcile.ts`. Reads local SQLite handoffs + ledger entries, compares timestamps with Supabase, upserts newer local data. Closes the architectural gap where locally-saved sessions were invisible to remote clients
- **`prism sync push` CLI Command** — Exposes bidirectional push to the CLI. Forces `PRISM_STORAGE=local`, resolves Supabase credentials, and reports push counts
- **`PushReconcileResult` Interface** — Typed return value: `{ handoffsPushed, ledgerEntriesPushed, projects }`

### Engineering
- 7 files changed
- TypeScript strict mode: zero errors
- Build verified clean: `npm run build`
- All original fixes verified holding in second review pass

---


### Added
- **ResidualNorm Tiebreaker for Tier-2 Search** — New configurable ranking optimization for TurboQuant asymmetric search. When two compressed cosine scores are within ε of each other, the candidate with lower `residualNorm` is preferred — its compressed representation captured more signal energy, making its score more trustworthy. Inspired by [@m13v's suggestion](https://github.com/xiaowu0162/LongMemEval/issues/31) in the LongMemEval benchmark discussion.
  - **`PRISM_TURBOQUANT_TIEBREAKER_EPSILON`** — New env var (default: `0`, disabled). Recommended: `0.005` for enterprise deployments with large corpora on Tier-2 fallback search. Applied to both SQLite and Supabase Tier-2 backends. Tier-1 native vector search (libSQL/pgvector) is unaffected.
  - **Input validation** — NaN, negative, and non-finite epsilon values are clamped to `0` (disabled).

### Performance
- **Empirical validation** (d=128, N=5K, 100 trials, M4 Max):
  - ε=0.005: **+2pp R@1, +1pp R@5** over standard cosine-only ranking
  - ε=0.020 too aggressive: **−9pp R@5** from over-reordering
  - 22% of queries have top-2 candidates within ε=0.005
- **R@k plateau confirmed** — Extended sweep (N=500 → 10K): R@5 stable at 84–92%, R@10 at 90–98%, zero degradation trend

### Security
- **Internal field stripping** — `_residualNorm` transient property is deleted from results before returning to callers, preventing implementation detail leakage

### Tests
- **11 new tests** (1066 total across 50 suites):
  - Tiebreaker A/B test at 4 ε thresholds with statistical validation
  - R@k sweep across 5 corpus sizes (500 → 10K)
  - 8 edge case tests: eps=0 disabled, reordering within ε, beyond-ε stability, missing residualNorm (corrupt data), single-element, empty array, identical values stability, NaN/negative config clamping, large-ε degenerate behavior

### Engineering
- 6 files changed: `src/config.ts`, `src/storage/sqlite.ts`, `src/storage/supabase.ts`, `tests/residual-tiebreaker.test.ts`
- 1066 tests, 50 suites, zero regressions
- TypeScript: clean, zero errors

---

## [9.2.7] - 2026-04-10 — Security Hardening: Typed Errors, Null-Byte Guard, CRDT Docs

### Security
- **Typed `PrototypePollutionError`** — `sanitizeForMerge()` now throws a `PrototypePollutionError` (with `offendingKey` property) instead of a generic `Error`. Enables callers to catch prototype pollution distinctly from other runtime errors and log the offending key for forensics.
- **Null-Byte Path Injection Guard** — `SafetyController.validateActionsInScope()` now explicitly rejects paths containing `\0` before `path.resolve()` processes them. Null bytes are a C-string truncation attack vector that could cause OS-level path resolution to silently truncate at the null boundary. Previously only crash-safe (test asserted `not.toThrow`); now deterministically rejected with `"targetPath contains null byte (injection attempt)"`.

### Fixed
- **CRDT Merge Semantics Documentation** — `mergeArray()` comment block incorrectly described "Add-Wins OR-Set" semantics. The actual implementation is **Remove-Wins-from-Either**: items removed by either agent are dropped from the base, fresh additions from either agent are preserved. Updated docstring to match the code and the test at `edge-cases.test.ts:269-303` which explicitly documented this discrepancy.

### Tests
- `edge-cases.test.ts` — Prototype pollution tests now assert `instanceof PrototypePollutionError` and verify the `offendingKey` property (`"__proto__"`, `"constructor"`).
- `darkfactory/edge-cases.test.ts` — Null-byte path test upgraded from crash-safety assertion (`not.toThrow`) to rejection assertion (`toContain('null byte')`).
- **Full suite: 49 files, 1055 tests passed, 0 regressions.**

### Engineering
- 4 files changed: `src/utils/crdtMerge.ts`, `src/darkfactory/safetyController.ts`, `tests/edge-cases.test.ts`, `tests/darkfactory/edge-cases.test.ts`

---

## [9.2.6] - 2026-04-09 — Windows CI Timeout Fix

### Fixed
- **Windows CI Flakiness** — CLI integration tests (`cli-integration.test.ts`) timed out on Windows + Node 22.x GitHub Actions runners. `npx tsx` cold-starts take 10-15s on Windows, exceeding Vitest's default 5s timeout. Added `{ timeout: 30_000 }` to the describe block. All 6 matrix combinations (ubuntu/macos/windows × Node 20/22) now pass reliably.

### Tests
- **Residual Norm Distribution & Long-Tail R@k Impact** (`tests/residual-distribution.test.ts`) — 6 new tests validating TurboQuant's QJL correction stability, directly backing the claim from [LongMemEval Issue #31](https://github.com/xiaowu0162/LongMemEval/issues/31) discussion with @m13v:
  - **ResidualNorm characterization** — CV=0.21 at d=128 (N=10K), CV=0.35 at d=768 (N=1K). P99/P50 ratio=2.57 confirms no extreme heavy tail.
  - **Long-tail R@k impact** — R@5=97% for BOTH low-residual (<P50) and high-residual (>P95) vectors. **Delta R@5 = 0.0 percentage points** — the key finding.
  - **Corpus scale stability** — R@5 degrades only 2pp from N=100 to N=2,000.
  - **QJL correction MAE** — Outlier MAE (P99) = 0.047, Inlier MAE (<P50) = 0.014. Ratio 3.3×, but absolute error bounded.
  - **Householder spread** — Max/min residualNorm ratio = 3.93 (bounded under 5.0).

### Engineering
- 1 file changed: `tests/residual-distribution.test.ts`

---

## [9.2.5] - 2026-04-09 — Reconciliation Credential Probe Fix

### Fixed
- **Reconciliation Not Firing** — The `supabaseReady` guard in `getStorage()` only resolved dashboard credentials (from `prism-config.db`) when `requestedBackend === "supabase"`. When backend was `"local"` (the entire point of reconciliation), credentials were never looked up, so `canReconcile` was always `false`. Added a second credential probe specifically for the local + reconciliation path.
- **Supabase Schema Mismatch** — The reconciliation `select` clause requested `key_context` column which doesn't exist in the Supabase `session_handoffs` table. Changed to `select: "*"` for schema-tolerant queries.

### Verified
- Live test: 9 handoffs + 43 ledger entries synced from Supabase → SQLite on first boot after fix.

### Engineering
- 2 files changed: `src/storage/index.ts`, `src/storage/reconcile.ts`
- 13/13 reconciliation tests passing

---

## [9.2.4] - 2026-04-09 — Cross-Backend Reconciliation

### Added
- **Automatic Supabase → SQLite Reconciliation** — New `src/storage/reconcile.ts` module implements two-layer sync that runs automatically during `getStorage()` initialization when the backend is local SQLite but Supabase credentials exist:
  - **Layer 1 (Handoffs):** Compares `updated_at` timestamps between Supabase and SQLite. Upserts newer remote handoffs into local SQLite.
  - **Layer 2 (Ledger):** For any project with a stale handoff, pulls the 20 most recent ledger entries from Supabase, deduplicating by ID against local entries.
- **13 New Tests** (`tests/storage/reconcile.test.ts`) — Syncing to empty local DB, skipping when local is newer, offline mode, ledger deduplication, malformed JSON resilience, multi-role project dedup, and Supabase timeout handling.

### Fixed
- **Race Condition** — Switched reconciliation from fire-and-forget to `await` in `getStorage()`, preventing `closeStorage()` from nulling the singleton mid-write.
- **Unbounded Queries** — Replaced full-table ledger scans with targeted ID-based lookups for deduplication.

### Performance
- **5s Timeout** — `withTimeout()` wrapper on all Supabase REST calls prevents startup freeze if Supabase is unreachable.
- **Safe JSON Parsing** — `safeParseArray()` prevents malformed Supabase JSON strings from aborting reconciliation.
- **Project Dedup** — `Set<string>` for project tracking avoids redundant network calls for multi-role projects.

### Design Decisions
- **Read-Only Sync** — Reconciliation only pulls from Supabase; it never writes to the cloud, preserving local-first integrity.
- **Targeted Ledger Sync** — Only the last 20 ledger entries per stale project are synced, keeping startup latency under 800ms even for large databases.

### Engineering
- 3 files changed: `src/storage/reconcile.ts` (new), `src/storage/index.ts`, `tests/storage/reconcile.test.ts` (new)
- 1049 tests across 48 suites, all passing

---

## [9.2.3] - 2026-04-09 — Code Review Hardening

### Performance
- **Split-Brain Check 10x Faster** — Replaced full `StorageBackend` construction (which ran migrations on every `session_load_context` call, adding 200-1000ms latency) with lightweight direct queries: `supabaseGet()` for Supabase REST, raw SQL via `@libsql/client` for SQLite. Check now completes in ~100ms.

### Fixed
- **Variable Shadowing** — `const storage` from CLI `--storage` option was shadowed by `const storage = await getStorage()` in JSON mode. Renamed inner variable to `storageBackend`.
- **Resource Leak** — SQLite alternate client in split-brain check was not closed if `execute()` threw. Added `try/finally` to guarantee `altClient.close()`.

### Engineering
- 1036 tests across 47 suites, all passing, zero regressions
- TypeScript: clean, zero errors
- 2 files changed: `src/cli.ts`, `src/tools/ledgerHandlers.ts`

---

## [9.2.2] - 2026-04-09 — Critical: Split-Brain Detection & Prevention

### ⚠️ Security / Data Integrity

- **Split-Brain Drift Detection** — `session_load_context` now detects when the active storage backend (e.g. SQLite) is out of sync with an alternate backend (e.g. Supabase). When both backends exist and have different versions, a `⚠️ SPLIT-BRAIN DETECTED` warning is injected prominently into the context response. This prevents agents from unknowingly acting on stale TODOs, outdated summaries, or completed tasks from a divergent backend.

### Added

- **`--storage` CLI Flag** — `prism load` now accepts `--storage <local|supabase>` to explicitly select which storage backend to read from. This is critical for environments where the CLI's shell environment inherits different `PRISM_STORAGE` settings than the MCP server config. Without this flag, `prism load` could silently read from Supabase while the MCP server writes to SQLite (or vice versa), returning stale state.

### Fixed

- **Session Loader Split-Brain** — `prism_session_loader.sh` now passes `--storage` flag (defaulting to `PRISM_STORAGE` env var, falling back to `local`) to prevent the CLI from reading the wrong backend when Supabase credentials are present but the MCP server is configured for local SQLite.

### Root Cause

When multiple MCP clients use different storage backends (e.g., Claude Desktop → Supabase, Antigravity → SQLite), the two backends operate as completely independent data silos with no sync mechanism. The `prism load` CLI inherited `PRISM_STORAGE` from the shell environment (defaulting to `supabase` when Supabase credentials exist), regardless of what the MCP server was configured to use. This caused the CLI to return state from the wrong backend — including stale TODOs that had already been completed in the real backend.

### Engineering
- TypeScript: clean, zero errors
- 3 files changed: `src/cli.ts`, `src/tools/ledgerHandlers.ts`, `README.md`
- Session loader script updated: `prism_session_loader.sh`

---



## [9.2.1] - 2026-04-09 — CLI Full Feature Parity

### Added
- **CLI Text Mode — Full MCP Parity** — `prism load` (text mode) now delegates to the real `sessionLoadContextHandler`, giving CLI-only users the same enriched output as MCP clients: morning briefings, reality drift detection, SDM intuitive recall, visual memory index, role-scoped skill injection, behavioral warnings, importance scores, recent validations, and agent identity block.
- **Agent Name in JSON Output** — `prism load --json` now includes `agent_name` from dashboard settings (`prism-config.db`) as a top-level field.
- **13 New CLI Tests** — Comprehensive vitest suite covering text mode handler delegation, JSON envelope structure, agent_name inclusion/exclusion, no-data edge cases, and feature parity verification.

### Fixed
- **Session Loader PATH Resolution** — `prism_session_loader.sh` now adds `/opt/homebrew/bin`, nvm, and volta paths to `PATH`, fixing the `node: command not found` error on macOS in non-interactive shells.

### Engineering
- TypeScript: clean, zero errors
- 3 files changed: `src/cli.ts`, `tests/tools/cli-load.test.ts` (new), `prism_session_loader.sh`
- Key architectural decision: CLI text mode delegates to the same handler function used by the MCP tool. No code duplication — future MCP enrichments automatically appear in CLI output.

---


## [9.1.1] - 2026-04-08 — Dashboard-First Credential Resolution

### Fixed
- **Dashboard Credentials Take Precedence** — `storage/index.ts` now reads `SUPABASE_URL` and `SUPABASE_KEY` from the dashboard config DB (`prism-config.db`) when environment variables are absent. Previously, starting the server without explicit env vars caused a hard fallback to local SQLite even when valid credentials were stored in the dashboard.
- **SyncBus Dashboard Fallback** — `sync/factory.ts` now checks dashboard config as a fallback for Supabase credentials, matching the storage layer behavior.
- **Supabase API Call-Time Credentials** — `utils/supabaseApi.ts` now reads `SUPABASE_URL`/`SUPABASE_KEY` from `process.env` at each request instead of capturing frozen values at module-import time. Dashboard-injected credentials are now visible to all downstream consumers.
- **Noisy Startup Warnings Silenced** — API key warnings (`BRAVE_API_KEY`, `GOOGLE_API_KEY`, `BRAVE_ANSWERS_API_KEY`) downgraded from `console.error` to debug-level logging. These fired on every server restart and were harmless (features degrade gracefully).

### Engineering
- TypeScript: clean, zero errors
- 4 files changed: `src/config.ts`, `src/storage/index.ts`, `src/sync/factory.ts`, `src/utils/supabaseApi.ts`

---

## [9.1.0] - 2026-04-08 — Task Router v2 & Local Agent Hardening

### Added
- **File-Type Complexity Signal** — New `fileTypeSignal` heuristic in the task router analyzes file extensions to bias routing decisions. Config/docs files (`.md`, `.json`, `.yml`, `.yaml`, `.toml`, `.cfg`, `.txt`, `.csv`, `.env`, `.ini`) bias toward local delegation; systems-programming files (`.cpp`, `.cc`, `.cxx`, `.c`, `.h`, `.hpp`, `.rs`, `.go`, `.java`, `.swift`, `.zig`) bias toward host. Common scripting/web langs (`.ts`, `.js`, `.py`) are intentionally neutral.
- **Claw Agent Streaming Buffer** — Local agent (`claw_agent_lite.py`) now uses a buffered stream parser to correctly handle `<think>` / `</think>` reasoning tags split across network chunks. Previously, partial tags would leak raw DeepSeek-R1 reasoning into stdout.
- **Claw Agent System Prompts** — Coding mode (`--code`) now injects a concise-output system prompt to prevent verbose explanations from the local model.
- **Claw Agent Memory Trimming** — REPL sessions now trim conversation history to the last 20 turns (preserving system prompt) to prevent unbounded memory growth during long sessions.
- **`--timeout` CLI Flag** — Configurable timeout for the local agent (default: 300s, up from 180s) to accommodate complex reasoning tasks on `deepseek-r1:32b`.

### Fixed
- **Multi-Step False Positives** — Removed bare `"1."`, `"2."`, `"3."` from `MULTI_STEP_MARKERS` — these matched version numbers (v1.2.3), decimal values, and IP addresses, inflating the multi-step detection signal and biasing tasks away from local delegation.
- **File-Type Double Counting** — Changed file classification from dual `if` to `if/else if`, preventing files from being counted as both simple and complex.
- **Claw Agent Error Output** — All error messages now go to `stderr` instead of `stdout`, keeping programmatic output clean for downstream tool consumption.
- **Claw Agent Unused Import** — Removed unused `import os`.

### Changed
- **Router Weight Distribution** — Updated from 5-signal to 6-signal routing: Keyword (0.35), File Count (0.15), File Type (0.10), Scope (0.20), Length (0.10), Multi-Step (0.10). Previous weights overallocated to file count (0.20) and scope (0.25).
- **Header Documentation** — Updated router header from v7.1.0/Qwen3 to v9.1.0/deepseek-r1+qwen2.5-coder, reflecting actual model names and weight table.
- **Claw Agent Ollama API** — Migrated from stateless `/api/generate` to stateful `/api/chat` for proper multi-turn conversation support.

### Engineering
- 1023 tests across 46 suites, all passing, zero regressions
- TypeScript: clean, zero errors
- 2 files changed: `src/tools/taskRouterHandler.ts`, `claw_agent_lite.py`

---

## [9.0.5] - 2026-04-07 — JWKS Auth Security Hardening

### Security
- **JWT Audience & Issuer Validation** — `jwtVerify()` now accepts `PRISM_JWT_AUDIENCE` and `PRISM_JWT_ISSUER` environment variables to validate `aud` and `iss` claims. Prevents cross-service token confusion attacks where a valid JWT from an unrelated service could authenticate against the dashboard.
- **Clock Tolerance** — Added 30-second clock skew tolerance to JWT verification, preventing false rejections from minor time drift between servers.
- **JWT Failure Logging** — Verification failures now emit structured error codes (`ERR_JWT_EXPIRED`, `ERR_JWT_CLAIM_VALIDATION_FAILED`, `ERR_JWS_INVALID`) to stderr. Previously silenced — essential for debugging in multi-agent deployments.
- **Server Card Fix** — `authentication.required` in the Smithery manifest (`/.well-known/mcp/server-card.json`) now reflects actual auth state instead of hardcoded `false`.

### Added
- **`PrismAuthenticatedRequest` Interface** — Typed `req.agent_id` mutation replaces `(req as any)`. Downstream handlers can now safely read agent identity for audit logging.
- **11 JWKS Unit Tests** — Full coverage for the Bearer JWT path using `jose`'s `generateKeyPair` + `SignJWT` (zero network, local key pairs):
  - Valid JWT accepted
  - Expired JWT rejected
  - Wrong audience rejected / correct audience accepted
  - Wrong issuer rejected / correct issuer accepted
  - JWKS cache null → fallthrough to cookie/basic
  - Invalid Bearer token string rejected
  - `agent_id` extracted from `payload.agent_id` (priority) and `payload.sub` (fallback)
- **JWKS Testing Hooks** — `_resetJWKS()` and `_getJWKSCache()` exports for test injection.
- **`.env.example` Documentation** — Added `PRISM_JWKS_URI`, `PRISM_JWT_AUDIENCE`, `PRISM_JWT_ISSUER` with usage examples.

### Changed
- **Startup Logging** — Distinguishes JWKS vs Basic Auth modes separately. Warns when no `PRISM_JWT_AUDIENCE` is configured (any valid JWT from the JWKS endpoint will be accepted).
- **JSDoc** — Updated `isAuthenticated` documentation to reflect the full 4-step auth priority chain: Auth disabled → Bearer JWT → Session cookie → Basic Auth.

## [7.8.2] - 2026-04-04

### Fixed
- **Docker / CI Build Failures** — Fixed an overly broad `.gitignore` rule that caused `src/memory/spreadingActivation.ts` to be excluded from version control, resulting in `TS2307` compiler errors during clean builds (like on Glama or Smithery).

## [7.8.0] - 2026-04-04 — Cognitive Architecture

> **The biggest leap forward yet.** Prism moves beyond flat vector search into a true cognitive architecture inspired by human brain mechanics. Your agents don't just remember; they learn.

### Added
- **Episodic → Semantic Consolidation (Hebbian Learning)** — Compaction no longer blindly summarizes text. Prism now extracts *principles* from raw event logs and writes them to a dedicated `semantic_knowledge` table with `confidence` scores that increase every time a pattern is observed. True Hebbian learning: neurons that fire together wire together.
- **Multi-Hop Causal Reasoning** — Compaction extracts causal links (`caused_by`, `led_to`) and persists them as `memory_links` graph edges. At retrieval time, ACT-R spreading activation propagates through these edges with damped fan effect (`1 / ln(fan + e)`), lateral inhibition, and configurable hop depth. Your agent follows trains of thought, not just keyword matches.
- **Uncertainty-Aware Rejection Gate** — Dual-signal safety layer (similarity floor + gap distance) that tells the LLM "I searched my memory, and I confidently do not know the answer" instead of feeding it garbage context. Agents that know their own boundaries don't hallucinate.
- **Dynamic Fast Weight Decay** — Semantic rollup nodes (`is_rollup`) decay 50% slower than episodic entries (`ageModifier = 0.5`), creating Long-Term Context anchors. The agent forgets raw chatter but permanently remembers core personality, project rules, and architectural decisions.
- **LoCoMo Benchmark Harness** — New standalone integration suite (`tests/benchmarks/locomo.ts`) deterministically benchmarks Long-Context Memory retrieval against multi-hop compaction structures via local `MockLLM` frameworks.

### Fixed
- **Schema Alignment (P0)** — Corrected `semantic_knowledge` DDL to match DML: renamed `rule` → `description`, added `instances`, `related_entities`, and `updated_at` columns. Added migration stubs.
- **Search SQL (P1)** — Updated Tier-1 (sqlite-vec) and Tier-2 (TurboQuant) search queries to include `is_rollup`, `importance`, and `last_accessed_at` for ACT-R decay consumption.
- **userId Threading (P2)** — Threaded `userId` through the entire `upsertSemanticKnowledge` stack (Interface → SQLite → Supabase Stub → Compaction Handler) to satisfy `NOT NULL` constraints.
- **Spreading Activation Performance (P1)** — Eliminated N+1 SQL round-trips by deriving fan-out counts locally from edge results. Added `LIMIT 200` to prevent memory pressure on high-degree nodes.
- **Keyword Rejection Gate Isolation** — Properly scoped uncertainty rejection strictly for vector-mapped threshold logic, bypassing FTS5 keyword (BM25) paths to prevent silent search failures.

## [7.7.1] - 2026-04-04

### Added
- **Smithery Registry Manifest** — Implemented an unauthenticated `/.well-known/mcp/server-card.json` endpoint to seamlessly expose MCP capabilities to cloud registries (like Smithery.ai) bypassing "chicken-and-egg" startup timeout blocks.
  - Manifest is hosted independently and ahead of the Dashboard Auth Gate to guarantee 100% public discovery while protecting active sessions.
  - Generates a static index via `getAllPossibleTools()` ensuring maximum visibility (exposing Hivemind and Dark Factory tools dynamically) without requiring local environment variable injection.
  - Includes extended boolean configuration schemas for `prismEnableHivemind`, `prismDarkFactoryEnabled`, and `prismTaskRouterEnabled` allowing instant configuration directly via Smithery UI.

## [7.7.0] - 2026-04-04

### Added
- **SSE Transport Mode** — Full native support for Server-Sent Events network connections (`SSEServerTransport`). Prism is now a cloud-ready, network-accessible MCP server capable of running on Render, Smithery, or any remote host.
  - Dynamically provisions unique `createServer()` instances per connection mapping them via a persistent `activeSSETransports` register.
  - Exposes `GET /sse` for stream initialization and `POST /messages` for JSON-RPC message delivery.
  - Strictly inherits Dashboard UI credentials via shared HTTP auth. Unauthenticated connections elegantly decline with `401 Unauthorized` JSON.

### Security
- **Auth Guard Integrity** — Enhanced the basic HTTP auth gate to explicitly catch MCP SSE endpoints alongside `/api/` returning clean JSON errors. Eliminates parsing crashes in remote MCP clients where unexpected HTML documents cause breaks.
- **Fail-Closed Network Guarding** — Wrapped SSE initialization handshake in `try/catch` and cleanup block. Protects the main NodeJS server loop against unhandled promise rejections triggering crashes on flaky client network connections.
- **Cors Hardening** — Pre-flight `OPTIONS` calls for `Access-Control-Allow-Headers` now comprehensively include `Authorization` allowing browsers to relay Dashboard Credentials seamlessly.

## [7.6.0] - 2026-04-04

### Added
- **Voyage AI Embedding Provider** — Introduced native `VoyageAdapter` as a pluggable embedding provider alongside OpenAI and Gemini. 
  - Allows semantic vector embedding using Voyage AI models inside the Mind Palace architecture.
  - Exposes config via `VOYAGE_API_KEY` mapped directly into the LLM adapter factory.
  - Added dedicated unit tests guaranteeing semantic fidelity.

## [7.5.0] - 2026-04-04

### Added
- **Intent Health Dashboard** — Per-project 0–100 health scoring in the Mind Palace, powered by a 3-signal algorithm: staleness decay (50pts, linear over `intent_health_stale_threshold_days`), TODO overload (30pts, tiered at 4/7+ thresholds), and decision presence (20pts). Renders as a gauge card with actionable signals per project.
- **`intent_health_stale_threshold_days` System Setting** — Configurable via Dashboard UI (default: 30 days). Controls when a project is considered fully stale.
- **14 Intent Health Tests** — Exhaustive coverage: fresh/stale/empty contexts, NaN timestamps, NaN thresholds, custom thresholds, TODO boundaries, multi-session decisions, score ceiling, signal severity matrix, clock skew, and signal shape validation.

### Changed
- **`computeIntentHealth` NaN Guard** — Extended `staleThresholdDays <= 0` guard to `!Number.isFinite(staleThresholdDays) || staleThresholdDays <= 0`. Catches `NaN`, `Infinity`, and negative values (previously `NaN <= 0` evaluated to `false` in JS, bypassing the guard).
- **Defensive Score Clamp** — `Math.min(100, Math.round(...))` ceiling on total score prevents future regressions from exceeding the 0–100 gauge range.

### Fixed
- **10 XSS Injection Vectors Patched** — Comprehensive `escapeHtml()` sweep across all dashboard innerHTML paths:
  - Pipeline `objective` (stored user input via `session_start_pipeline`)
  - Pipeline `project` name in factory tab
  - Pipeline `current_step` name in factory tab
  - Pipeline `error` message in factory tab
  - Factory catch handler `err.message`
  - Ledger `decisions` array members (`.join(', ')` → `.map(escapeHtml).join(', ')`)
  - Project `<option>` text in selector dropdowns
  - History timeline `h.version` badge
  - Health card `data.score` (typeof number guard)
  - CSS selector injection in `fetchNextHealth` (querySelector → safe array iteration)
- **Division-by-zero** — `staleThresholdDays=0` no longer produces `Infinity` score cascade.

## [7.4.0] - 2026-04-03

### Added
- **Adversarial Evaluation Framework** — `PLAN_CONTRACT` and `EVALUATE` steps added to the Dark Factory pipeline, implementing a native generator/evaluator sprint architecture with isolated contexts and pre-committed scoring contracts.
  - `PLAN_CONTRACT` — Before any code changes, generator and evaluator agree on a machine-parseable rubric (`ContractPayload`: criteria with `id` + `description` fields). Contract is written to `contract_rubric.json` in the working directory.
  - `EVALUATE` — After `EXECUTE`, an isolated adversarial evaluator scores the output against the contract. Structured findings include `severity`, `criterion_id`, `pass_fail`, and evidence pointers (`file`, `line`, `description`).
  - Pipeline state machine: `PLAN → PLAN_CONTRACT → EXECUTE → EVALUATE → VERIFY → FINALIZE`
- **`DEFAULT_MAX_REVISIONS` constant** — Replaces magic number `3` across `schema.ts` and `safetyController.ts`. Configurable via `spec.maxRevisions`.
- **78 new adversarial unit tests** (`tests/darkfactory/adversarial-eval.test.ts`) covering all parser branches, transition logic, deadlock/oscillation scenarios, conservative-default behavior, and context-bleed guards.

### Changed
- **`EvaluationPayload.findings[].evidence.line`** — Type corrected from `string` to `number` (1-indexed line number). `EVALUATE_SCHEMA` LLM prompt updated to match.
- **`PipelineState.contract_payload`** — Type narrowed from `any` to `PipelineContractPayload | null` for end-to-end type safety.
- **`evalPlanViable` conservative default** — When `EVALUATE` step output cannot be parsed (malformed LLM response), `planViable` now defaults to `false` (escalate to PLAN re-plan) instead of `true` (burn EXECUTE revisions). Prevents looping on systematically broken LLM output.
- **EVALUATE notes persisted** — `result.notes` from the `EVALUATE` step is now forwarded to `pipeline.notes` alongside `EXECUTE` notes. Previously, evaluator findings were discarded from the persistent pipeline record.
- **Generator Feedback Loop** — The Evaluator's critique (`EvaluationPayload.findings`) is now correctly serialized and injected directly into the `EXECUTE` prompt during revision loops (`eval_revisions > 0`). The Generator is no longer blind to why it failed — it receives the full line-by-line evidence (criterion, severity, file, line) from the previous evaluation.
- **TurboQuant warm-up** — Moved to `setImmediate` in `server.ts` to prevent event loop blocking during the MCP stdio handshake.

### Fixed
- **`parseContractOutput` per-criterion validation** — Each criterion element is now validated to have string `id` and `description` fields. Primitive elements (e.g. `[42, "bad"]`) are rejected with a position-keyed error message.
- **`parseEvaluationOutput` findings array guard** — `findings` field is now validated to be an array when present. Non-array values (e.g. `"findings": "none"`) are rejected at the parser boundary.
- **Strict Evidence Validation** — `parseEvaluationOutput` now enforces deep element-level validation on the `findings` array. Evaluator findings with `pass_fail: false` that are missing an `evidence` object (file and line pointers) are strictly rejected. Prevents LLM hallucination of unsupported severity claims with no evidence anchor.
- **`contract_rubric.json` write isolation** — `fs.writeFileSync` is now wrapped in try/catch. Disk/permission errors immediately mark the pipeline `FAILED` instead of leaving it stuck in `RUNNING` indefinitely.
- **Dead `STEP_ORDER` array removed** — Unused constant in `safetyController.ts` replaced by the authoritative `switch` statement.
- **`'evaluation_result' as any`** — Invalid event type replaced with the correct `'learning'` literal for the experience ledger call.
- **SQLite backfill migration** — `ALTER TABLE DEFAULT` only applies to new inserts; existing rows now explicitly have `eval_revisions = 0` set via a `WHERE eval_revisions IS NULL` backfill `UPDATE`.
- **Supabase `listPipelines` parity** — `contract_payload` was missing JSON deserialization in `listPipelines`. Fixed to match the behavior of `getPipeline`.

### Storage Schema (v7.4.0 migration)
- New columns on `dark_factory_pipelines`: `eval_revisions INTEGER DEFAULT 0`, `contract_payload TEXT`, `notes TEXT`
- Supabase: same columns via `prism_apply_ddl` RPC
- SQLite backfill: `UPDATE ... SET eval_revisions = 0 WHERE eval_revisions IS NULL`

### Engineering
- 978 tests across 44 suites (78 new adversarial evaluation tests), all passing, zero regressions
- TypeScript: clean, zero errors
- 10 files changed, +1027 / -73

---

## [7.0.0] - 2026-04-01

### Added
- **ACT-R Activation Memory** — Scientifically-grounded memory retrieval based on Anderson's ACT-R cognitive architecture. Base-level activation `B_i = ln(Σ t_j^{-d})` replaces flat similarity search with recency × frequency scoring that mirrors human cognitive decay. Memories accessed recently and frequently surface first; stale context fades naturally.
- **Candidate-Scoped Spreading Activation** — Activation spreads only within the current search result set, preventing "God node" centrality bias where highly-connected nodes dominate every query regardless of relevance.
- **Composite Scoring** — `0.7 × similarity + 0.3 × σ(activation)` blends semantic relevance with cognitive activation. Sigmoid normalization keeps activation in `[0,1]` regardless of access pattern. Weights configurable via `PRISM_ACTR_WEIGHT_SIMILARITY` / `PRISM_ACTR_WEIGHT_ACTIVATION`.
- **Verification Operator Contract & JSON Modes** — `verify status` and `verify generate` now fully support `--json` output modes providing strict schema adherence (`schema_version: 1`). Integrations guarantees deterministic exit codes (`0` for passing/warning/bypassed, `1` for blocked drift).
- **AccessLogBuffer** — In-memory batch-write buffer with 5-second flush window resolves `SQLITE_BUSY` contention during parallel multi-agent tool calls. Registered with `BackgroundTaskRegistry` for graceful shutdown — no orphaned writes on `SIGTERM`.
- **Zero Cold-Start** — Memory creation now seeds an initial access log entry. New memories are immediately rankable without a warm-up period.
- **Supabase Migration 037** — `actr_access_log` table + RPC functions for access log writes and activation computation. Full feature parity with SQLite backend.
- **5 New Environment Variables** — `PRISM_ACTR_ENABLED` (default: `true`), `PRISM_ACTR_DECAY` (default: `0.5`), `PRISM_ACTR_WEIGHT_SIMILARITY` (default: `0.7`), `PRISM_ACTR_WEIGHT_ACTIVATION` (default: `0.3`), `PRISM_ACTR_ACCESS_LOG_RETENTION_DAYS` (default: `90`).

### Changed
- **Cognitive Memory Pipeline** — `cognitiveMemory.ts` refactored to integrate ACT-R activation scoring into the retrieval pipeline. When `PRISM_ACTR_ENABLED=true`, search results are re-ranked with composite scores; when disabled, falls back to pure similarity.
- **Tracing Integration** — OpenTelemetry spans added for ACT-R activation computation, access log writes, and buffer flushes.

### Documentation
- **README Overhaul** — Added "Mind Palace" terminology definition, promoted Universal Import to top-level section, added Quick Start port-conflict collapsible, added "Recommended Minimal Setup" TL;DR for environment variables, updated dashboard screenshot to v7.0.0, added dashboard-runs-in-background reassurance.
- **ROADMAP** — v7.0.0 entry with full ACT-R feature table. "State of Prism" updated to v7.0.0. Future tracks bumped to v8.x/v9+.

### Architecture
- New file: `src/utils/actrActivation.ts` — 250 lines. ACT-R base-level activation, sigmoid normalization, composite scoring.
- New file: `src/utils/accessLogBuffer.ts` — 199 lines. In-memory batch-write buffer with 5s flush, `BackgroundTaskRegistry` integration.
- New migration: `supabase/migrations/037_actr_access_log_parity.sql` — 121 lines. Access log table, RPC functions, retention cleanup.
- Extended: `src/storage/sqlite.ts` — Access log table creation, write/query methods, retention sweep.
- Extended: `src/storage/supabase.ts` — Access log RPC calls, activation computation.
- Extended: `src/tools/graphHandlers.ts` — ACT-R activation integration in search handler.
- Extended: `src/utils/cognitiveMemory.ts` — Composite scoring pipeline with ACT-R re-ranking.
- Extended: `src/utils/tracing.ts` — ACT-R span instrumentation.

### Engineering
- 705 tests across 32 suites (49 new ACT-R tests), all passing, zero regressions
- New file: `tests/utils/actr-activation.test.ts` — 695 lines covering activation math, buffer flush, cold-start seeding, SQLite/Supabase parity, decay parameter edge cases
- TypeScript strict mode: zero errors

---

## [6.5.3] - 2026-04-01

### Added
- **Dashboard Auth Test Suite** — 42 new tests (`tests/dashboard/auth.test.ts`) covering the entire auth system: `safeCompare` timing-safety, `generateToken` entropy, `isAuthenticated` cookie/Basic Auth flows, `createRateLimiter` sliding window, and full HTTP integration tests for login, logout, auth gate, rate limiting, and CORS.
- **Rate Limiting** — `POST /api/auth/login` is now protected by a sliding-window rate limiter (5 attempts per 60 seconds per IP). Resets on successful login. Stale entries are auto-pruned to prevent memory leaks.
- **Logout Endpoint** — `POST /api/auth/logout` invalidates the session token server-side (deletes from `activeSessions` map) and clears the client cookie via `Max-Age=0`.
- **Auth Utilities Module** — Extracted `safeCompare`, `generateToken`, `isAuthenticated`, and `createRateLimiter` from `server.ts` closures into `src/dashboard/authUtils.ts` for testability and reuse.

### Security
- **CORS Hardening** — When `AUTH_ENABLED`, `Access-Control-Allow-Origin` is now set dynamically to the request's `Origin` header (not wildcard `*`), and `Access-Control-Allow-Credentials: true` is sent. Wildcard `*` is only used when auth is disabled.
- **Cryptographic Token Generation** — `generateToken()` now uses `crypto.randomBytes(32).toString("hex")` instead of `Math.random()` for session tokens.
- **Colon-Safe Password Parsing** — Basic Auth credential extraction now uses `indexOf(":")` instead of `split(":")` to correctly handle passwords containing colon characters.

### Engineering
- 42 new auth tests (unit + HTTP integration), zero regressions in existing 14 dashboard API tests
- New file: `src/dashboard/authUtils.ts` — extracted pure functions with injectable `AuthConfig`
- New file: `tests/dashboard/auth.test.ts` — 5 describe blocks, 42 test cases

---

## [6.5.2] - 2026-04-01

### Engineering
- **SDM/HDC Edge-Case Test Hardening** — 37 new tests (571 → 608 total) covering critical boundary conditions across the cognitive routing pipeline:
  - **HDC Engine** — Bind length mismatch rejection, empty bundle handling, single-vector identity, XOR self-inverse property, permute empty/single-word edge cases, density preservation invariant.
  - **PolicyGateway** — All 4 constructor rejection paths, exact-at-threshold boundary routing (0.85 → CLARIFY, 0.95 → AUTO_ROUTE), null-concept override behavior.
  - **StateMachine** — Constructor/transition dimension guards, defensive cloning, `injectStateForTesting` guard, initial-state immutability.
  - **SDM Engine** — Hamming identity/complement properties, reverse mode cross-talk isolation, write/read dimension guards, k=0 boundary, `importState` guard, `exportState` → `importState` lossless roundtrip.

---

## [6.5.1] - 2026-04-01

### Fixed
- **Dashboard Project Selector Bootstrap Failure** — Resolved a startup failure where `/api/projects` returned errors and the selector remained stuck on "Loading projects..." when `SUPABASE_URL`/`SUPABASE_KEY` were unresolved template placeholders (e.g. `${SUPABASE_URL}`).
- **Storage Backend Fallback Safety** — Added runtime guardrails to automatically fall back to local SQLite storage when Supabase is requested but env configuration is invalid/unresolved, preventing dashboard hard-failure in mixed/local setups.

### Changed
- **Config Sanitization** — Added Supabase env sanitization and URL validation to ignore unresolved placeholder strings and invalid non-http(s) values.

### Release Process
- Delivered as a **single pull request** post-publish hardening pass to keep code + docs + release notes aligned in one review artifact.

---

## [6.5.0] - 2026-04-01

### Added
- **HDC Cognitive Routing** — New `session_cognitive_route` MCP tool composes an agent's current state, role, and action into a single 768-dim binary hypervector via XOR binding, resolves it to a semantic concept via Hamming distance, and routes through a three-outcome policy gateway (`direct` / `clarify` / `fallback`). Powered by `ConceptDictionary`, `HdcStateMachine`, and `PolicyGateway` in `src/sdm/`.
- **Per-Project Threshold Overrides** — Fallback and clarify thresholds are configurable per-project via tool arguments and persisted via `getSetting()`/`setSetting()`. **Phase 2 storage-parity scope note:** No new storage migrations are required — the existing `prism_settings` key-value table already abstracts SQLite/Supabase parity. Threshold values are stored as decimal strings (e.g., `"0.45"`) and parsed back to `Number` on read.
- **Explainability Mode** — When `explain: true`, responses include `convergence_steps`, raw `distance`, and `ambiguity` flag. Controlled by `PRISM_HDC_EXPLAINABILITY_ENABLED` (default: `true`).
- **Cognitive Observability** — `recordCognitiveRoute()` in `graphMetrics.ts` tracks 14 cognitive metrics: total routes, route distribution (direct/clarify/fallback), rolling confidence/distance averages, ambiguity count, null-concept count, and last-route timestamp. Warning heuristics fire when `fallback_rate > 30%` or `ambiguous_resolution_rate > 40%`.
- **Dashboard Cognitive Card** — Route distribution bar, confidence/distance gauges, and warning badges in the Mind Palace metrics panel (ES5-safe). On-demand "Cognitive Route" button in the Node Editor panel.
- **Dashboard API Endpoint** — `GET /api/graph/cognitive-route` in `graphRouter.ts` exposes the handler for dashboard consumption with query parameter parsing (project, state, role, action, thresholds, explain).

### Architecture
- New tool: `session_cognitive_route` — `src/tools/graphHandlers.ts` (`sessionCognitiveRouteHandler`)
- New API route: `GET /api/graph/cognitive-route` — `src/dashboard/graphRouter.ts`
- Extended: `src/observability/graphMetrics.ts` — `CognitiveMetrics` interface, `recordCognitiveRoute()`, cognitive warning heuristics
- Extended: `src/dashboard/ui.ts` — Cognitive metrics card, cognitive route button (ES5-safe)
- Config: `PRISM_HDC_ENABLED` (default: `true`), `PRISM_HDC_EXPLAINABILITY_ENABLED` (default: `true`)

### Fixed
- **Dashboard `triggerTestMe` Regression** — Restored `async function triggerTestMe()` declaration that was stripped during v6.5 code insertion. Removed duplicate `cognitiveRouteBtn` DOM block (duplicate IDs). Restored `testMeContainer` div in panel flow.

### Engineering
- 566 tests across 30 suites (all passing, zero regressions)
- 42 new tests: 26 handler integration tests (`tests/tools/cognitiveRoute.test.ts`) + 16 dashboard API tests (`tests/dashboard/cognitiveRoute.test.ts`)
- TypeScript strict mode: zero errors

---


## [6.2.1] - 2026-04-01

### Fixed
- **Dashboard ES5 Compatibility** — Refactored all inline `<script>` code in the Mind Palace dashboard to strict ES5 syntax. Replaced `const`/`let`, arrow functions, optional chaining (`?.`), and template literals with ES5 equivalents (`var`, `function` expressions, manual null checks, string concatenation). Fixes `SyntaxError: Unexpected identifier 'block'` that prevented the dashboard from initializing in certain browser environments.
- **Compatibility Rule Enforcement** — Added a mandatory ES5-only compatibility comment block at the top of the inline `<script>` tag to prevent future regressions.

### Engineering
- 510 tests across 28 suites (all passing)
- TypeScript strict mode: zero errors

---

## [6.2.0] - 2026-03-31

### Added
- **Edge Synthesis ("The Dream Procedure")** — Automated background linker (`session_synthesize_edges`) discovers semantically similar but disconnected memory nodes via cosine similarity (threshold ≥ 0.7). Batch-limited to 50 sources × 3 neighbors per sweep to prevent runaway graph growth.
- **Graph Pruning (Soft-Prune)** — Configurable strength-based pruning (`PRISM_GRAPH_PRUNING_ENABLED`) soft-deletes weak links below a configurable minimum strength. Includes per-project cooldown, backpressure guards, and sweep budget controls.
- **SLO Observability Layer** — `graphMetrics.ts` module tracks synthesis success rate, net new links, prune ratio, and sweep duration. Exposes `slo` and `warnings` fields for proactive health monitoring.
- **Dashboard Metrics Integration** — New SLO cards, warning badges, and pruning skip breakdown (backpressure / cooldown / budget) in the Mind Palace dashboard at `/api/graph/metrics`.
- **Temporal Decay Heatmaps** — UI overlay toggle where un-accessed nodes desaturate while Graduated nodes stay vibrant. Graph router extraction + decay view toggle.
- **Active Recall Prompt Generation** — "Test Me" utility in the node editor panel generates synthetic quizzes from semantic neighbors for knowledge activation.
- **Supabase Weak-Link RPC (WS4.1)** — New `prism_summarize_weak_links` Postgres function (migration 036) aggregates pruning server-side in one RPC call, eliminating N+1 network roundtrips. TypeScript fast-path with automatic fallback.
- **Migration 035** — Tenant-safe graph writes + soft-delete hardening for MemoryLinks.

### Fixed
- **Scheduler `projects_processed` Semantics** — Now tracks all attempted projects, not just successes, for accurate SLO derivation.
- **Router Integration Test** — Added `GET /api/graph/metrics` integration test to validate the full metrics pipeline.
- **Export Test Mock Staleness** — Added missing `PRISM_GRAPH_PRUNE*` config exports to `sessionExportMemory.test.ts` mock (transitive import fix).
- **Dashboard `const` in Switch** — Fixed `const` declaration in switch-case scope (`pruneSkipParts`) that caused strict-mode errors in some browsers.

### Architecture
- New module: `src/observability/graphMetrics.ts` — in-memory metrics with SLO derivation and warning heuristics.
- New migration: `supabase/migrations/036_prune_summary_rpc.sql` — server-side aggregate RPC.
- Extended: `src/backgroundScheduler.ts` — synthesis telemetry, pruning telemetry, sweep duration recording.
- Extended: `src/dashboard/graphRouter.ts` — `GET /api/graph/metrics` endpoint.
- Extended: `src/dashboard/ui.ts` — SLO cards, warning badges, pruning breakdown.

### Engineering
- 510 tests across 28 suites (all passing)
- TypeScript strict mode: zero errors

---

## [6.1.9] - 2026-03-31

### Added
- **Tavily Support** — Added `@tavily/core` integration as a robust alternative to Brave + Firecrawl for the Web Scholar pipeline. Supports `performTavilySearch` and `performTavilyExtract`.

### Fixed
- **Tavily Chunking & Error Handling** — Implemented URL array chunking (batches of 20 URLs) for `performTavilyExtract` to bypass API limits and prevent data loss.
- **Upstream Network Resilience** — `performTavilySearch` is wrapped in a `try...catch` block to cleanly return empty arrays on API failure/timeout, avoiding unhandled promise rejections.

---

## [6.1.8] - 2026-03-30

### Fixed
- **Missing Type Guard** — Added `isSessionCompactLedgerArgs` for `SESSION_COMPACT_LEDGER_TOOL`. The tool existed with no corresponding guard; an LLM hallucinating `{threshold: "many"}` would reach the handler unchecked.
- **Array Field Validation** — `isSessionSaveLedgerArgs` now validates `todos`, `files_changed`, and `decisions` with `Array.isArray`, preventing string coercion into array-typed fields.
- **Enum Literal Guard** — `isSessionExportMemoryArgs` now rejects `format` values outside the literal union `'json' | 'markdown' | 'vault'` at the MCP boundary.
- **Numeric Guards** — `isSessionIntuitiveRecallArgs` now validates `limit` and `threshold` as `typeof number`, blocking `{limit: "many"}` style coercion.
- **Legacy Guard Migration** — `isMemoryHistoryArgs`, `isMemoryCheckoutArgs`, `isSessionSaveImageArgs` migrated to the uniform `Record<string, unknown>` pattern. `isMemoryHistoryArgs` also gains a missing `limit` number check.

---

## [6.1.7] - 2026-03-30

### Fixed
- **Toggle Persistence** — `saveSetting()` now returns `Promise<boolean>` and UI toggles (Hivemind, Auto-Capture) roll back their optimistic state on server failure.
- **Cache-Busting** — `loadSettings()` appends `?t=<timestamp>` to bypass stale browser/service-worker caches.
- **HTTP Error Propagation** — Explicit 4xx/5xx detection in `saveSetting()` surfaces toast notifications to the user on failed saves.

---

## [6.1.6] - 2026-03-30

### Fixed
- **Type Guard Hardening (Round 1)** — Audited and refactored 11 MCP tool argument type guards to include explicit `typeof` validation for all optional fields. Prevents LLM-hallucinated payloads from causing runtime type coercion errors in handlers.

---

## [6.1.5] - 2026-03-30

### Added
- **`maintenance_vacuum` Tool** — New MCP tool to run `VACUUM` on the local SQLite database after large purge operations, reclaiming page allocations that SQLite retains until explicitly vacuumed.

### Fixed
- **Prototype Pollution Guards** — CRDT merge pipeline hardened against `__proto__` / `constructor` injection via `Object.create(null)` scratchpads.

### Tests
- **425-test Edge-Case Suite** — Added comprehensive tests across 20 files covering CRDT merges, TurboQuant mathematical invariants, prototype pollution guards, and SQLite retention TTL boundary conditions.

---

## [6.1.0] - 2026-03-30

### Added
- **Smart Memory Merge UI (Knowledge Gardening)**: Integrated a dynamic dropdown directly into the graph's `nodeEditorPanel`. Users can now instantly merge duplicate or fragmented keywords directly from the UI without backend refactoring.
- **Deep Purge Visualization (Memory Density)**: Added an intuitive "Memory Density" analytical stat within the `schedulerCard`. This zero-overhead metric visualizes the ratio of standard insights versus highly-reinforced (Graduated) ideas, rendering immediate feedback on the project's learning efficiency.
- **Semantic Search Highlighting**: Re-engineered the payload rendering for vector results to utilize a RegEx-powered match engine. Found context fragments dynamically wrap exact keyword matches in a vibrant `<mark>` tag, instantly explaining *why* a vector was pulled.

---

## [6.0.0] - 2026-03-29

### Added
- **Context-Boosted Vector Search**: Intelligent API param `context_boost` biases semantic queries by organically injecting current handoff state/working context into the embedding model alongside user queries.
- **AbortController Concurrency Safety**: Hardened the UI `performSearch` loop to elegantly cancel in-flight API requests during rapid debounce typing.

---

## [5.4.0] - 2026-03-28
- **CRDT Handoff Merging**: Replaced strict OCC rejection with automatic conflict-free multi-agent state merging. When two agents save concurrently, Prism now auto-merges instead of rejecting.
  - Custom OR-Map engine (`crdtMerge.ts`): Add-Wins OR-Set for arrays (`open_todos`), Last-Writer-Wins for scalars (`last_summary`, `key_context`).
  - 3-way merge with `getHandoffAtVersion()` base retrieval from SQLite and Supabase.
  - `disable_merge` bypass parameter for strict OCC when needed.
  - `totalCrdtMerges` tracked in health stats and dashboard.
- **Background Purge Scheduler**: Unified automated maintenance system that replaces all manual storage management.
  - Single `setInterval` loop (default: 12 hours, configurable via `PRISM_SCHEDULER_INTERVAL_MS`).
  - 4 maintenance tasks: TTL sweep, Ebbinghaus importance decay, auto-compaction, deep storage purge.
  - Dashboard status card with last sweep timestamp, duration, and per-task results.
  - `PRISM_SCHEDULER_ENABLED` env var (default: `true`).
- **Autonomous Web Scholar**: Agent-driven background research pipeline.
  - Brave Search → Firecrawl scrape → LLM synthesis → Prism ledger injection.
  - Task-aware topic selection: biases research toward active Hivemind agent tasks.
  - Reentrancy guard prevents concurrent pipeline runs.
  - 15K character content cap per scraped article for cost control.
  - Configurable: `PRISM_SCHOLAR_ENABLED`, `PRISM_SCHOLAR_INTERVAL_MS`, `PRISM_SCHOLAR_TOPICS`, `PRISM_SCHOLAR_MAX_ARTICLES_PER_RUN`.
- **Scholar ↔ Hivemind Integration**: Scholar registers as `scholar` role agent with lifecycle heartbeats at each pipeline stage. Telepathy broadcast fires on completion to notify active agents. Task-aware topic selection biases research toward topics matching active agent tasks.
- **Updated Architecture Documentation**: 3 new sections in `docs/ARCHITECTURE.md` covering Agent Hivemind, Background Scheduler, and Web Scholar with mermaid diagrams.

### Architecture
- New module: `src/scholar/webScholar.ts` — 281 lines, full pipeline with Hivemind integration.
- New module: `src/crdtMerge.ts` — OR-Map engine with 3-way merge algorithm.
- Extended: `src/backgroundScheduler.ts` — unified maintenance + Scholar scheduling.
- Storage interface: `getHandoffAtVersion()` for CRDT base retrieval.

### Engineering
- 362 tests across 16 suites (10 new Scholar tests)
- Clean TypeScript build, zero errors
- Backward compatible: all new features are opt-in via env vars

---

## [5.3.0] - 2026-03-28

### Added
- **Hivemind Health Watchdog**: Server-side active monitoring system for multi-agent coordination. Transforms the Hivemind from a passive registry into a self-healing orchestrator.
  - **State Machine**: Agents transition through `ACTIVE → STALE (5m) → FROZEN (15m) → OFFLINE (30m, auto-pruned)` based on heartbeat freshness.
  - **OVERDUE Detection**: Agents can declare `expected_duration_minutes` on heartbeat. If the task exceeds this ETA, the Watchdog flags the agent as OVERDUE.
  - **Loop Detection**: DJB2 hash of `current_task` is computed on every heartbeat. If the same task repeats ≥5 times consecutively, the agent is flagged as LOOPING. Detection runs inline in the heartbeat hot path (~0.01ms overhead).
  - **Telepathy (Alert Injection)**: Watchdog alerts are appended **directly to `result.content[]`** of tool responses, bypassing MCP's `sendLoggingMessage` limitation where LLMs don't read debug logs. This guarantees the LLM reads the alert in its reasoning loop.
  - **Configurable Thresholds**: All thresholds configurable via env vars (`PRISM_WATCHDOG_INTERVAL_MS`, `PRISM_WATCHDOG_STALE_MIN`, `PRISM_WATCHDOG_FROZEN_MIN`, `PRISM_WATCHDOG_OFFLINE_MIN`, `PRISM_WATCHDOG_LOOP_THRESHOLD`).
- **`expected_duration_minutes` parameter**: New optional parameter on `agent_heartbeat` tool for task ETA declarations.
- **Health-State Dashboard**: Hivemind Radar now shows color-coded health indicators (🟢/🟡/🔴/⏰/🔄), loop count badges, and auto-refreshes every 15 seconds.
- **`getAllAgents()` / `updateAgentStatus()`**: New storage backend methods for cross-project agent sweeps and whitelist-guarded status transitions.
- **Supabase Migration 032**: `task_start_time`, `expected_duration_minutes`, `task_hash`, `loop_count` columns + user_id index.

### Architecture
- New module: `src/hivemindWatchdog.ts` — 270 lines of pure business logic, zero MCP Server dependency, fully testable in isolation.
- Alert queue: In-memory `Map<string, WatchdogAlert>` with dedup key `project:role:status` — fire-and-forget, no persistence needed.
- Dual-mode alerting: Direct content injection (primary, for LLMs) + `sendLoggingMessage` (secondary, for operators).
- Graceful degradation: All sweep errors are caught and logged, never crash the server. `PRISM_ENABLE_HIVEMIND` gate prevents any CPU overhead for single-agent users.

### Engineering
- 10 files changed, ~600 lines added
- Clean TypeScript build, zero errors
- Backward compatible: all new columns have defaults, watchdog is no-op without `PRISM_ENABLE_HIVEMIND=true`

---

## [5.2.0] - 2026-03-27

### Added
- **Cognitive Memory — Ebbinghaus Importance Decay**: Entries now have `last_accessed_at` tracking. At retrieval time, `effective_importance = base × 0.95^days` computes a time-decayed relevance score. Frequently accessed memories stay prominent; neglected ones fade naturally.
- **Context-Weighted Retrieval** (`context_boost` parameter): When enabled on `session_search_memory`, the active project's branch, keywords, and context are prepended to the search query before embedding generation — naturally biasing the vector toward contextually relevant results.
- **Smart Consolidation**: Enhanced the `session_compact_ledger` prompt to extract recurring principles and patterns alongside summaries, producing richer rollup entries.
- **Universal History Migration**: Modular migration utility using the Strategy Pattern. Ingest historical sessions from Claude Code (JSONL streaming), Gemini (OOM-safe StreamArray), and OpenAI/ChatGPT (JSON) into the Mind Palace.
  - **Conversation Grouping**: Turns are grouped into logical conversations using a 30-minute time-gap heuristic. A 100MB file with 200 conversations → 200 summary entries (not 50,000 raw turns).
  - **Idempotent Deduplication**: Each conversation gets a deterministic ID. Re-running the same import is a no-op.
  - **Dashboard Import UI**: File picker (📂 Browse) + manual path input, auto-format detection, real-time result display.
  - Features `p-limit(5)` concurrency control and `--dry-run` support.

### Security
- **SQL Injection Prevention**: Added 17-column allowlist to `patchLedger()` in SQLite storage. Dynamic column interpolation now rejects any column not in the allowlist.

### Fixed
- **Supabase DDL v31**: Added missing `last_accessed_at` column migration for Supabase users. Without this, the Ebbinghaus decay logic would have thrown a column-not-found error.
- **context_boost guard**: Now logs a warning and continues gracefully when `context_boost=true` is passed without a `project` parameter, instead of silently failing.
- **Redundant getStorage() call**: Removed duplicate storage initialization in the Ebbinghaus decay block.
- **README dead link**: Fixed `#supabase-setup` anchor (inside `<details>` blocks, GitHub doesn't generate anchors).

### Engineering
- 9 new migration tests (adapter parsing, conversation grouping, dedup, tool keyword preservation)
- 352 tests across 15 suites
- 17 files changed, +1,016 lines

---

## [5.1.0] - 2026-03-27
### Added
- **Deep Storage Mode**: New `deep_storage_purge` tool to reclaim ~90% of vector storage by dropping float32 vectors for entries with TurboQuant compressed blobs.
- **Knowledge Graph Editor**: Transformed the Mind Palace Neural Graph into an interactive editor with dynamic filtering, node renaming, and surgical keyword deletion.
### Fixed
- **Auto-Load Reliability**: Hardened auto-load prompt instructions and added hook scripts for Claude Code / Antigravity to ensure memory is loaded on the first turn (bypassing model CoT hallucinations).
### Engineering
- 303/303 automated tests passing across 13 suites.

## 🚀 v5.0.0 — The TurboQuant Update (2026-03-26)

**Quantized Agentic Memory is here.**

### ✨ Features

- **10× Storage Reduction:** Integrated Google's TurboQuant algorithm (ICLR 2026) to compress 768-dim embeddings from 3,072 bytes to ~400 bytes. Zero external dependencies — pure TypeScript math core with Householder QR, Lloyd-Max scalar quantization, and QJL residual correction.
- **Two-Tier Search:** Introduced a JS-land asymmetric similarity search fallback (`asymmetricCosineSimilarity`), ensuring semantic search works even without native DB vector extensions (`sqlite-vec` / `pgvector`).
- **Atomic Backfill:** Optimized background workers to repair and compress embeddings in a single atomic database update (`patchLedger`), reducing lock contention for multi-agent Hivemind use cases.
- **Supabase Parity:** Full support for quantized blobs in the cloud backend (migration v29 + `saveLedger` insert).

### 🏗️ Architecture

- New file: `src/utils/turboquant.ts` — 665 lines, zero-dependency math core
- Storage schema: `embedding_compressed` (TEXT/base64), `embedding_format` (turbo3/turbo4/float32), `embedding_turbo_radius` (REAL)
- SQLite migration v5.0 (3 idempotent ALTER TABLE)
- Supabase migration v29 via `prism_apply_ddl` RPC

### 📊 Benchmarks

| Metric | Value |
|--------|-------|
| Compression ratio (d=768, 4-bit) | **~7.7:1** (400 bytes vs 3,072) |
| Compression ratio (d=768, 3-bit) | **~10.1:1** (304 bytes vs 3,072) |
| Similarity correlation (4-bit) | >0.85 |
| Top-1 retrieval accuracy (N=100) | >90% |
| Tests | 295/295 pass |

### 📚 Documentation

- Published RFC-001: Quantized Agentic Memory (`docs/rfcs/001-turboquant-integration.md`)

---

## v4.6.1 — Stability (2026-03-25)

- Fixed auto-load reliability for `session_load_context` tool
- Dashboard project dropdown freeze resolved

## v4.6.0 — Observable AI (2026-03-25)

- OpenTelemetry distributed tracing integration
- Visual Language Model (VLM) image captioning
- Mind Palace dashboard improvements

## v4.3.0 — IDE Rules Sync (2026-03-25)

- `knowledge_sync_rules` tool: graduated insights → `.cursorrules` / `.clauderules`
- Sentinel-based idempotent file writing

## v4.0.0 — Behavioral Memory (2026-03-24)

- Active Behavioral Memory with experience events
- Importance scoring and graduated insights
- Pluggable LLM providers (OpenAI, Anthropic, Gemini, Ollama)

## v3.0.0 — Hivemind (2026-03-23)

- Multi-agent role-based scoping
- Team roster injection on context load

## v2.0.0 — Time Travel (2026-03-22)

- Version-controlled handoff snapshots
- `memory_history` + `memory_checkout` tools
- Visual memory (image save/view)

## v1.0.0 — Foundation (2026-03-20)

- Session ledger with keyword extraction
- Handoff state persistence
- SQLite + Supabase dual backends
- Semantic search via pgvector / sqlite-vec
- GDPR export and surgical deletion
