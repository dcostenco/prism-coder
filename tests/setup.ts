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

// Provide dummy API keys so LLM and Search instantiations don't throw warnings/errors in CI
if (!process.env.GOOGLE_API_KEY) process.env.GOOGLE_API_KEY = "dummy_google_key_for_tests";
if (!process.env.BRAVE_API_KEY) process.env.BRAVE_API_KEY = "dummy_brave_key_for_tests";

// ─── Directory Setup ─────────────────────────────────────────────
// Ensure the temp directory exists before any test uses it
mkdirSync(TEMP_DIR, { recursive: true });
