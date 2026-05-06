/**
 * Vitest Configuration — Prism MCP Test Framework
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHY VITEST:
 *   - Native ESM support (Prism uses "type": "module")
 *   - TypeScript out of the box (no ts-jest shim needed)
 *   - Fast — uses Vite's transformer under the hood
 *   - Compatible with Node.js APIs (SQLite, fs, http)
 * ═══════════════════════════════════════════════════════════════════
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // ─── Test Discovery ───────────────────────────────────────────
    // Look for *.test.ts files in the tests/ directory
    include: ["tests/**/*.test.ts"],

    // ─── Environment ──────────────────────────────────────────────
    // Use Node environment (not jsdom) since Prism is a server-side
    // MCP application — no browser DOM needed
    environment: "node",

    // ─── Globals ──────────────────────────────────────────────────
    // Import describe/it/expect explicitly for clarity and tree-shaking
    globals: false,

    // ─── Timeouts ─────────────────────────────────────────────────
    // Default timeout per test: 10 seconds
    // Load tests may need more — they override individually
    testTimeout: 10_000,
    // hookTimeout default is 10s — Windows + Node 22.x SQLite test-db
    // creation in beforeEach can exceed that under CI load (we measured
    // tests/storage/isolation.test.ts at ~8s for the same operation,
    // and policyGateway/stateMachine beforeEach hooks have hit the
    // 10s ceiling in Windows-22.x runs). Bump to 30s so transient
    // Windows file-system slowness doesn't fail the build.
    hookTimeout: 30_000,

    // ─── Reporters ────────────────────────────────────────────────
    // Verbose reporter shows each test name + duration
    reporters: ["verbose"],

    // ─── Isolation ────────────────────────────────────────────────
    // Each test file runs in its own worker for clean state
    // This is critical for SQLite tests that create/destroy databases
    isolate: true,

    // ─── Setup ────────────────────────────────────────────────────
    // Global setup runs once before all test suites
    // Used to ensure temp directories exist and env vars are set
    setupFiles: ["tests/setup.ts"],
  },
});
