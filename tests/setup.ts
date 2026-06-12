/**
 * Global Test Setup — Prism MCP Test Framework
 *
 * ═══════════════════════════════════════════════════════════════════
 * PURPOSE:
 *   This file runs ONCE before any test suite executes. It ensures:
 *   1. Environment variables are configured for test mode
 *   2. Temp directories for test SQLite databases exist
 *   3. Console output is directed to stderr (MCP safety)
 *
 * CRITICAL MCP SAFETY NOTE:
 *   The MCP server communicates via stdout. If any test accidentally
 *   writes to stdout, it could corrupt the JSON-RPC stream in a
 *   real server context. We set PRISM_STORAGE=local to keep tests
 *   isolated from any cloud Supabase backend.
 * ═══════════════════════════════════════════════════════════════════
 */

import { mkdirSync } from "fs";
import { join } from "path";
import { config } from "dotenv";

// Load .env from project root so tests can access API keys (GOOGLE_API_KEY, etc.)
// Must happen before any other Prism module imports resolve config.ts
config();

// Unset Synalux cloud credentials AFTER dotenv loads them — tests must
// never hit the live portal. This ensures SYNALUX_CONFIGURED=false in
// config.ts and getEntitlements() falls back to FREE_ENTITLEMENTS.
// (Without this, tests pass in CI but fail locally when .env has a key.)
delete process.env.PRISM_SYNALUX_API_KEY;
delete process.env.PRISM_SYNALUX_BASE_URL;

/**
 * TEMP_DIR is where test SQLite databases are created.
 * Each test suite gets its own unique DB file within this directory
 * to avoid cross-contamination between parallel test runs.
 */
export const TEMP_DIR = join(process.cwd(), "tests", ".tmp");

// ─── Environment Setup ───────────────────────────────────────────
// Force local storage mode so tests never hit Supabase
process.env.PRISM_STORAGE = "local";

// Use a test-specific data directory so real user data is never touched
process.env.PRISM_DATA_DIR = TEMP_DIR;

// Disable the dashboard server during tests to avoid port conflicts
process.env.PRISM_DASHBOARD_PORT = "0";

// Disable Hivemind by default — individual test suites enable it as needed
process.env.PRISM_ENABLE_HIVEMIND = "false";

// ─── Directory Setup ─────────────────────────────────────────────
// Ensure the temp directory exists before any test uses it
mkdirSync(TEMP_DIR, { recursive: true });
