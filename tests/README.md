# 🧪 Prism MCP — Test Suite

> **425 tests across 20 test files.** All passing. `npm test` to verify.

---

## Running Tests

```bash
# Full suite
npm test

# Watch mode (during development)
npx vitest

# Single file
npx vitest run edge-cases
npx vitest run vaultExporter
npx vitest run sessionExportMemory
npx vitest run turboquant

# TypeScript typecheck (no emit)
npx tsc --noEmit
```

---

## Test Structure

```
tests/
├── edge-cases.test.ts               # 46 tests — gap matrix (CRDT, vault, TurboQuant, SQLite)
├── tools/                           # MCP tool handler tests
│   ├── sessionExportMemory.test.ts  # 14 groups, ~85 tests — export pipeline
│   ├── definitions.test.ts          # Tool schema & arg validation
│   └── utils/
│       └── vaultExporter.test.ts    # vaultExporter unit tests
├── storage/
│   ├── sqlite.test.ts               # SQLite backend — CRUD, FTS5, migrations
│   └── isolation.test.ts            # Multi-tenant data isolation
├── turboquant.test.ts               # TurboQuant math & compression tests
├── deep-storage.test.ts             # Deep storage purge + VACUUM
├── migration.test.ts                # Schema migration paths
├── migration-edge.test.ts           # Edge cases: partial migrations, column adds
├── v31-lifecycle.test.ts            # PID lock / lifecycle manager
├── v40-behavioral-memory.test.ts    # Experience recording & importance decay
├── v42-sync-rules.test.ts           # .cursorrules / .clauderules sync
├── dashboard/                       # Dashboard HTTP server tests
├── llm/                             # LLM adapter & factory tests
├── load/                            # Context load (quick/standard/deep)
├── sdm/                             # Sparse Distributed Memory tests
├── scholar/                         # Web Scholar pipeline tests
├── helpers/                         # Shared test helpers and mocks
└── setup.ts                        # Global vitest setup (mocks, env)
```

---

## Key Test Files

### `tests/edge-cases.test.ts` *(v6.1.5 — new)*
The **gap matrix** file: 46 tests across 12 groups, closing failure modes NOT exercised by the main suites:

| Group | Area | What it tests |
|-------|------|---------------|
| 1 | CRDT — sanitizeForMerge | `__proto__` via JSON.parse, nested pollution, `constructor`/`prototype` keys, clean passthrough, primitives |
| 2 | CRDT — mergeHandoff | LWW scalar (incoming/current/both/neither), OR-Set union, Remove-Wins-from-either, null base, idempotency |
| 3 | CRDT — dbToHandoffSchema | `last_summary` mapping, precedence, JSON array parse, malformed JSON → null, null row |
| 4 | Vault — binary field strip | `embedding` + `embedding_compressed` absent from Ledger `.md` files, blob length ceiling |
| 5 | Vault — OOM ceiling | 10,001-entry ledger completes without throwing |
| 6 | Vault — collision counter | 100 dupes → 100 unique paths, dash suffix format (`-1`, `-2` not `_2`) |
| 7 | Vault — visual memory index | Generated when present, absent when empty/missing, null entries skipped |
| 8 | Vault — Handoff.md | Always present, populated from handoff fields, no `undefined`/`null` leak |
| 9 | Vault — Settings.md | Pipe `\|` → `\\|` escaping in table values |
| 10 | Vault — envelope guard | Missing `prism_export` throws, `null as any` throws, `undefined as any` throws |
| 11 | TurboQuant — bits guard | bits=1 throws, bits=7 throws, bits=2/4/6 accepted |
| 12 | Deep Storage — handler TTL | `older_than_days=0` → `isError=false` (no-op sentinel), dry-run variant, omit→default 30 |

### `tests/tools/sessionExportMemory.test.ts`
The most comprehensive file in the suite (~1,200 lines, 14 test groups). Covers:

| Group | What it tests |
|-------|---------------|
| 1 — Input Validation | Missing `output_dir`, bad types |
| 2 — Missing Output Dir | Non-existent directory error path |
| 3 — Storage Failure | Storage init failure → clean error |
| 4 — Empty Projects | No projects found → graceful message |
| 5 — JSON Format | Full round-trip: write → parse → assert schema |
| 6 — Markdown Format | Markdown rendering, section headers |
| 7 — API Key Redaction | `_api_key`, `_secret`, `password` patterns stripped |
| 8 — Extended Redaction | Additional suffix patterns |
| 9 — Storage API Shape | `getLedgerEntries` called with PostgREST filter + limit |
| 10 — Visual Memory | Image metadata keys (`filename`, `timestamp`) |
| 11 — Embedding Strip | `embedding` and `embedding_compressed` removed |
| 12 — Multi-Project | `listProjects()` called when no project specified |
| 13 — Concurrent Safety | 5 parallel exports don't race or throw |
| 14 — Vault Format | ZIP generated, decompressible, contains `_Index.md` |

### `tests/utils/vaultExporter.test.ts`
Unit tests for the `buildVaultDirectory` function:
- `slugify` edge cases: empty string, unicode, very long slugs, special chars, collision suffix
- `escapeYaml` edge cases: backslash ordering, quotes, control characters, null bytes
- Visual memory: `filename`/`timestamp` keys correctly rendered
- Keyword backlink: vault-relative path (no `../` prefix) for Obsidian compatibility

### `tests/turboquant.test.ts`
Mathematical correctness for TurboQuant compression:
- **Similarity Preservation** — Pearson correlation >0.85 at 4-bit, >0.75 at 3-bit
- **QJL Zero-Bias** — mean estimator bias <0.05 across 200 random pairs
- **Compression Ratio** — 4-bit d=768 serializes to <500 bytes (vs. 3,072 float32)
- **Needle-in-Haystack** — top-1 accuracy >90%, top-5 >95% at d=128
- **Edge Cases** — zero vector, non-unit input, wrong-dimension throws, non-normalized query
- **Production Scale** — full roundtrip at d=768 (Gemini embedding dimension)

### `tests/storage/sqlite.test.ts`
- Full CRUD on session ledger (insert, read, soft-delete, hard-delete)
- FTS5 keyword search correctness
- Handoff upsert + OCC version conflict detection
- CRDT merge on concurrent writes
- `getLedgerEntries` PostgREST filter parsing (eq., is.null, order, limit)

### `tests/deep-storage.test.ts`
- Dry-run: reports eligible count without modifying data
- Execute: NULLs `embedding`, preserves `embedding_compressed`
- Safety: rejects `olderThanDays < 7`, respects project filter
- Edge cases: soft-deleted excluded, idempotent second purge

---

## Design Principles

### 1. Mocked Storage — No Real DB in Unit Tests
All `tools/` and `utils/` tests use a `vi.mock()` storage stub (see `helpers/`). This keeps tests fast (~3.7s for the full suite) and deterministic.

```ts
// Pattern used in sessionExportMemory.test.ts
vi.mock("../../../src/storage/index.js", () => ({
  getStorage: vi.fn().mockResolvedValue(storage),
}));
```

### 2. Real SQLite — Integration Tests via `createTestDb()`
Tests that need real storage (deep-storage, sqlite, isolation, edge-cases Group 12) use `createTestDb()` from `helpers/fixtures.ts`. Each call creates an ephemeral SQLite database in a temp directory, fully isolated from other tests:

```ts
const { storage, cleanup } = await createTestDb("my-test");
afterEach(() => cleanup());
```

### 3. PostgREST Filter Format
As of v6.1.4, `getLedgerEntries` in the export handler uses PostgREST-style filters:
```ts
{ project: "eq.my-project", order: "created_at.asc", limit: "10000" }
```
Tests that verify the call shape must use this format. The `eq.` prefix is stripped by the SQLite adapter's `parsePostgRESTFilters()`.

### 4. Embedding Fields Must Be Absent in Exports
Both `embedding` (raw float32) and `embedding_compressed` (TurboQuant Uint8Array) are stripped before export. Tests verify:
```ts
expect(prism_export.ledger[0]).not.toHaveProperty("embedding");
expect(prism_export.ledger[0]).not.toHaveProperty("embedding_compressed");
```

### 5. Vault Wikilinks Use Vault-Relative Paths
Obsidian resolves `[[Wikilinks]]` from vault root, not relative to the current file. All `path` fields in keyword mentions must use `Ledger/filename.md` (not `../Ledger/filename.md`).

### 6. Visual Memory Key Contract
`sessionSaveImageHandler` stores images with these keys:
```ts
{ id, description, filename, original_path, timestamp }
```
`vaultExporter` reads `vm.filename` and `vm.timestamp`. Tests for the visual memory index verify these exact keys produce real values (not `"Unknown"`).

### 7. TypeScript Strict Null Tests
When testing runtime safety against `null`/`undefined` inputs that TypeScript's type system would reject at compile time, use `as any` casts (not `@ts-expect-error`) with an ESLint suppression comment:
```ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
expect(() => buildVaultDirectory(null as any)).toThrow();
```

---

## Adding New Tests

1. **Tool handler tests** → `tests/tools/`
2. **Utility unit tests** → `tests/utils/`
3. **Storage tests** → `tests/storage/`
4. **Gap matrix / edge cases** → `tests/edge-cases.test.ts` (add a new group)
5. Always mock `getStorage()` for non-storage tests
6. Use `createTestDb()` + `afterEach(cleanup)` for real-SQLite tests
7. Run `npx tsc --noEmit` before committing to catch type errors

---

## Coverage Notes

| Area | Status | Notes |
|------|--------|-------|
| `sessionExportMemory` handler | ✅ Comprehensive (14 groups) | |
| `vaultExporter.ts` | ✅ Unit + edge cases | `edge-cases.test.ts` Groups 4–10 |
| `turboquant.ts` | ✅ Math + production scale + bounds | `edge-cases.test.ts` Group 11 |
| `crdtMerge.ts` | ✅ Full CRDT semantics | `edge-cases.test.ts` Groups 1–3 |
| `hygieneHandlers.ts` — purge | ✅ TTL=0 guard + real-SQLite | `edge-cases.test.ts` Group 12 |
| `deep-storage.ts` storage layer | ✅ Comprehensive (4 describe groups) | |
| Dashboard `/api/export` | ⚠️ Handler-level; no HTTP integration test yet | |
| Web Scholar pipeline | ⚠️ Mocked (Brave API requires live key) | |
