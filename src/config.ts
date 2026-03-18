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
 *
 * If a required key is missing, the process exits immediately.
 * If an optional key is missing, a warning is logged but the server continues
 * with reduced functionality (the corresponding tools will be unavailable).
 */

// ─── Server Identity ──────────────────────────────────────────

export const SERVER_CONFIG = {
  name: "brave-gemini-research-mcp",
  version: "0.2.0",
};

// ─── Required: Brave Search API Key ───────────────────────────

export const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
if (!BRAVE_API_KEY) {
  console.error("Error: BRAVE_API_KEY environment variable is required");
  process.exit(1);
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
// When both SUPABASE_URL and SUPABASE_KEY are set, three additional tools
// are registered: session_save_ledger, session_save_handoff, session_load_context.
// These tools allow AI agents to persist and recover context between sessions.
// See the README "Session Memory Module" section for setup instructions.

export const SUPABASE_URL = process.env.SUPABASE_URL;
export const SUPABASE_KEY = process.env.SUPABASE_KEY;
export const SESSION_MEMORY_ENABLED = !!(SUPABASE_URL && SUPABASE_KEY);
if (SESSION_MEMORY_ENABLED) {
  console.error("Session memory enabled (Supabase configured)");
} else {
  console.error("Info: Session memory disabled (set SUPABASE_URL + SUPABASE_KEY to enable)");
}
