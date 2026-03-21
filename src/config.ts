/**
 * Configuration & Environment Variables
 *
 * This file is loaded once at startup. It reads environment variables,
 * validates required ones, and exports them for use throughout the server.
 *
 * Environment variable guide:
 *   BRAVE_API_KEY          — (required) API key for Brave Search Pro. Get one at https://brave.com/search/api/
 *   GOOGLE_API_KEY         — (optional) API key for Google AI Studio / Gemini. Enables paper analysis.
 *   BRAVE_ANSWERS_API_KEY  — (optional) API key for Brave Answers (AI grounding). Enables brave_answers tool.
 *   SUPABASE_URL           — (optional) Your Supabase project URL. Enables session memory tools.
 *   SUPABASE_KEY           — (optional) Your Supabase anon/service key. Enables session memory tools.
 *   PRISM_USER_ID          — (optional) Unique tenant ID for multi-user Supabase instances.
 *                            Defaults to "default". Set per-user in Claude Desktop config.
 *
 * If a required key is missing, the process exits immediately.
 * If an optional key is missing, a warning is logged but the server continues
 * with reduced functionality (the corresponding tools will be unavailable).
 */

// ─── Server Identity ──────────────────────────────────────────

// REVIEWER NOTE: v1.5.0 includes all v0.4.0 enhancements PLUS
// multi-tenant Row Level Security (RLS) for production hosting.
export const SERVER_CONFIG = {
  name: "prism-mcp",
  version: "2.3.7",
};

// ─── Required: Brave Search API Key ───────────────────────────

export const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
if (!BRAVE_API_KEY) {
  console.error("Warning: BRAVE_API_KEY environment variable is missing. Search tools will return errors when called.");
}

// ─── Optional: Google Gemini API Key ──────────────────────────
// Used by the gemini_research_paper_analysis tool.
// Without this, the tool will still appear but will error when called.

export const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
if (!GOOGLE_API_KEY) {
  console.error("Warning: GOOGLE_API_KEY environment variable is missing. Gemini research features will be unavailable.");
}

// ─── Optional: Brave Answers API Key ──────────────────────────
// Used by the brave_answers tool for AI-grounded answers.
// This is a separate API key from the main Brave Search key.

export const BRAVE_ANSWERS_API_KEY = process.env.BRAVE_ANSWERS_API_KEY;
if (!BRAVE_ANSWERS_API_KEY) {
  console.error("Warning: BRAVE_ANSWERS_API_KEY environment variable is missing. Brave Answers tool will be unavailable.");
}

// ─── Optional: Supabase (Session Memory Module) ───────────────
// When both SUPABASE_URL and SUPABASE_KEY are set, session memory tools
// are registered. These tools allow AI agents to persist and recover
// context between sessions.

export const SUPABASE_URL = process.env.SUPABASE_URL;
export const SUPABASE_KEY = process.env.SUPABASE_KEY;
export const SESSION_MEMORY_ENABLED = !!(SUPABASE_URL && SUPABASE_KEY);
if (SESSION_MEMORY_ENABLED) {
  console.error("Session memory enabled (Supabase configured)");
} else {
  console.error("Info: Session memory disabled (set SUPABASE_URL + SUPABASE_KEY to enable)");
}

// ─── v2.0: Storage Backend Selection ─────────────────────────
// REVIEWER NOTE: Step 1 of v2.0 introduces a storage abstraction.
// Currently only "supabase" is implemented. "local" (SQLite) is
// coming in Step 2. Default is "supabase" for backward compat.
//
// Set PRISM_STORAGE=local to use SQLite (once implemented).
// Set PRISM_STORAGE=supabase to use Supabase REST API (default).

export const PRISM_STORAGE: "local" | "supabase" =
  (process.env.PRISM_STORAGE as "local" | "supabase") || "supabase";
console.error(`Storage backend: ${PRISM_STORAGE}`);

// ─── Optional: Multi-Tenant User ID ──────────────────────────
// REVIEWER NOTE: When multiple users share the same Supabase instance,
// PRISM_USER_ID isolates their data. Each user sets a unique ID in their
// Claude Desktop config. All queries are scoped to this user_id.
//
// Defaults to "default" for backward compatibility — existing single-user
// installations work without any config changes.
//
// For enterprise: use a stable unique identifier (UUID, email hash, etc.)
// For personal use: any unique string works (e.g., "alice", "bob")

export const PRISM_USER_ID = process.env.PRISM_USER_ID || "default";
if (PRISM_USER_ID !== "default") {
  console.error(`Multi-tenant mode: user_id="${PRISM_USER_ID}"`);
}

// ─── v2.1: Auto-Capture Feature ─────────────────────────────
// REVIEWER NOTE: Automatically captures HTML snapshots of local dev servers
// when handoffs are saved. Prevents UI context loss between sessions.
// Opt-in only — set PRISM_AUTO_CAPTURE=true to enable.

export const PRISM_AUTO_CAPTURE = process.env.PRISM_AUTO_CAPTURE === "true";
export const PRISM_CAPTURE_PORTS = (process.env.PRISM_CAPTURE_PORTS || "3000,3001,5173,8080")
  .split(",")
  .map(p => parseInt(p.trim(), 10))
  .filter(p => !isNaN(p));

if (PRISM_AUTO_CAPTURE) {
  console.error(`[AutoCapture] Enabled for ports: ${PRISM_CAPTURE_PORTS.join(", ")}`);
}
