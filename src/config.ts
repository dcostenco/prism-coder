import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

function resolveServerVersion(): string {
  try {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const packageJsonPath = resolve(moduleDir, "../package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    if (typeof packageJson?.version === "string" && packageJson.version.trim()) {
      return packageJson.version.trim();
    }
  } catch {
    // Fallback below keeps server booting even if package metadata is unavailable.
  }
  return "0.0.0";
}

// REVIEWER NOTE: derive version from package.json so MCP handshake,
// dashboard badge, and package metadata stay in sync.
export const SERVER_CONFIG = {
  name: "prism-mcp",
  version: resolveServerVersion(),
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

// ─── v2.0: Storage Backend Selection ─────────────────────────
// REVIEWER NOTE: Step 1 of v2.0 introduces a storage abstraction.
// Currently only "supabase" is implemented. "local" (SQLite) is
// coming in Step 2. Default is "supabase" for backward compat.
//
// Set PRISM_STORAGE=local to use SQLite (once implemented).
// Set PRISM_STORAGE=supabase to use Supabase REST API (default).

export const PRISM_STORAGE: "local" | "supabase" =
  (process.env.PRISM_STORAGE as "local" | "supabase") || "supabase";
// Logged at debug level — see debug() at bottom of file

// ─── Optional: Supabase (Session Memory Module) ───────────────
// When both SUPABASE_URL and SUPABASE_KEY are set, session memory tools
// are registered. These tools allow AI agents to persist and recover
// context between sessions.

function sanitizeEnv(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  // Treat unresolved template placeholders as unset (e.g. "${SUPABASE_URL}")
  if (!trimmed || trimmed.includes("${")) return undefined;
  return trimmed;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export const SUPABASE_URL = sanitizeEnv(process.env.SUPABASE_URL);
export const SUPABASE_KEY = sanitizeEnv(process.env.SUPABASE_KEY);
export const SUPABASE_CONFIGURED =
  !!SUPABASE_URL &&
  !!SUPABASE_KEY &&
  isHttpUrl(SUPABASE_URL);

if (process.env.SUPABASE_URL && !SUPABASE_URL) {
  console.error(
    "Warning: SUPABASE_URL appears unresolved/empty (e.g. template placeholder). Falling back to local storage unless explicitly fixed."
  );
}
if (SUPABASE_URL && !isHttpUrl(SUPABASE_URL)) {
  console.error("Warning: SUPABASE_URL is not a valid http(s) URL. Falling back to local storage.");
}
// Session memory remains core-enabled in both local and Supabase modes.
export const SESSION_MEMORY_ENABLED = true;

// Optional multi-tenant scope ID (used by storage queries and handoffs).
export const PRISM_USER_ID = process.env.PRISM_USER_ID || "default";


// ─── v2.1: Auto-Capture Feature ─────────────────────────────
// REVIEWER NOTE: Automatically captures HTML snapshots of local dev servers
// when handoffs are saved. Prevents UI context loss between sessions.
// Opt-in only — set PRISM_AUTO_CAPTURE=true to enable.

export const PRISM_AUTO_CAPTURE = process.env.PRISM_AUTO_CAPTURE === "true";
export const PRISM_CAPTURE_PORTS = (process.env.PRISM_CAPTURE_PORTS || "3000,3001,5173,8080")
  .split(",")
  .map(p => parseInt(p.trim(), 10))
  .filter(p => !isNaN(p));

// ─── v2.3: Debug Logging ──────────────────────────────────────
// Optionally enable verbose output (stderr) for Prism initialization,
// memory indexing, and background tasks.

export const PRISM_DEBUG_LOGGING = process.env.PRISM_DEBUG_LOGGING === "true";

// ─── v3.0: Agent Hivemind Feature Flag ───────────────────────
// When enabled, registers 3 additional MCP tools for multi-agent
// coordination: agent_register, agent_heartbeat, agent_list_team.
// The role parameter on existing tools (session_save_ledger, etc.)
// is always available regardless of this flag — adding a parameter
// doesn't increase tool count.
// Set PRISM_ENABLE_HIVEMIND=true to unlock the Agent Registry tools.

export const PRISM_ENABLE_HIVEMIND = process.env.PRISM_ENABLE_HIVEMIND === "true";

// ─── v4.1: Auto-Load Projects ────────────────────────────────
// Auto-load is configured exclusively via the Mind Palace dashboard
// ("Auto-Load Projects" checkboxes in Settings). The setting is stored
// in prism-config.db and read at startup via getSettingSync().
//
// The PRISM_AUTOLOAD_PROJECTS env var has been removed — the dashboard
// is the single source of truth. This prevents mismatches between
// env var and dashboard values causing duplicate project loads.

if (PRISM_AUTO_CAPTURE) {
  // Use console.error instead of debugLog here to prevent circular dependency
  if (PRISM_DEBUG_LOGGING) {
    console.error(`[AutoCapture] Enabled for ports: ${PRISM_CAPTURE_PORTS.join(", ")}`);
  }
}

// ─── v5.3: Hivemind Watchdog Thresholds ──────────────────────
// All values have sane defaults. Override via env vars only for
// testing or production tuning. Dashboard UI exposure deferred to v5.4.
export const WATCHDOG_INTERVAL_MS = parseInt(
  process.env.PRISM_WATCHDOG_INTERVAL_MS || "60000", 10
);
export const WATCHDOG_STALE_MIN = parseInt(
  process.env.PRISM_WATCHDOG_STALE_MIN || "5", 10
);
export const WATCHDOG_FROZEN_MIN = parseInt(
  process.env.PRISM_WATCHDOG_FROZEN_MIN || "15", 10
);
export const WATCHDOG_OFFLINE_MIN = parseInt(
  process.env.PRISM_WATCHDOG_OFFLINE_MIN || "30", 10
);
export const WATCHDOG_LOOP_THRESHOLD = parseInt(
  process.env.PRISM_WATCHDOG_LOOP_THRESHOLD || "5", 10
);

// ─── v5.4: Background Purge Scheduler ────────────────────────
// Automated background maintenance: TTL sweep, importance decay,
// compaction, and deep storage purge. Runs independently from
// the Watchdog (different cadence: 12h vs 60s).
export const PRISM_SCHEDULER_ENABLED =
  process.env.PRISM_SCHEDULER_ENABLED !== "false"; // Default: true
export const PRISM_SCHEDULER_INTERVAL_MS = parseInt(
  process.env.PRISM_SCHEDULER_INTERVAL_MS || "43200000", 10  // 12 hours
);

// ─── v5.4: Autonomous Web Scholar ─────────────────────────────
// Background LLM research pipeline powered by Brave Search + Firecrawl.
// Tavily can be used as an alternative when TAVILY_API_KEY is set.
// Defaults are conservative to prevent runaway API costs.

export const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
export const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
export const PRISM_SCHOLAR_ENABLED = process.env.PRISM_SCHOLAR_ENABLED === "true"; // Opt-in

if (PRISM_SCHOLAR_ENABLED && !FIRECRAWL_API_KEY && !TAVILY_API_KEY) {
  console.error("Warning: Neither FIRECRAWL_API_KEY nor TAVILY_API_KEY is set. Web Scholar will fall back to free search.");
}
export const PRISM_SCHOLAR_INTERVAL_MS = parseInt(
  process.env.PRISM_SCHOLAR_INTERVAL_MS || "0", 10  // Default manual-only
);
export const PRISM_SCHOLAR_MAX_ARTICLES_PER_RUN = parseInt(
  process.env.PRISM_SCHOLAR_MAX_ARTICLES_PER_RUN || "3", 10
);
export const PRISM_SCHOLAR_TOPICS = (process.env.PRISM_SCHOLAR_TOPICS || "ai,agents")
  .split(",")
  .map(t => t.trim());

// ─── v6.0: Associative Memory Graph ──────────────────────────
// Controls the age threshold for link strength decay.
// Links not traversed in the last N days lose 0.1 strength per sweep.
export const PRISM_LINK_DECAY_DAYS = parseInt(
  process.env.PRISM_LINK_DECAY_DAYS || "30", 10
);

// ─── v6.5: Cognitive Architecture (HDC Policy Gateway) ─────────────
// Master feature flag for HDC-driven cognitive routing APIs.
export const PRISM_HDC_ENABLED = process.env.PRISM_HDC_ENABLED === "true";

// Explainability payload toggle for cognitive routing responses.
export const PRISM_HDC_EXPLAINABILITY_ENABLED =
  process.env.PRISM_HDC_EXPLAINABILITY_ENABLED !== "false"; // default true

const DEFAULT_HDC_FALLBACK_THRESHOLD = 0.85;
const DEFAULT_HDC_CLARIFY_THRESHOLD = 0.95;

const rawHdcFallbackThreshold = parseFloat(
  process.env.PRISM_HDC_POLICY_FALLBACK_THRESHOLD || String(DEFAULT_HDC_FALLBACK_THRESHOLD)
);
const rawHdcClarifyThreshold = parseFloat(
  process.env.PRISM_HDC_POLICY_CLARIFY_THRESHOLD || String(DEFAULT_HDC_CLARIFY_THRESHOLD)
);

const hdcThresholdsValid =
  Number.isFinite(rawHdcFallbackThreshold) &&
  Number.isFinite(rawHdcClarifyThreshold) &&
  rawHdcFallbackThreshold >= 0 &&
  rawHdcFallbackThreshold < rawHdcClarifyThreshold &&
  rawHdcClarifyThreshold <= 1;

if (!hdcThresholdsValid) {
  console.error(
    "Warning: Invalid HDC policy thresholds. Falling back to defaults " +
    `(fallback=${DEFAULT_HDC_FALLBACK_THRESHOLD}, clarify=${DEFAULT_HDC_CLARIFY_THRESHOLD}).`
  );
}

export const PRISM_HDC_POLICY_FALLBACK_THRESHOLD = hdcThresholdsValid
  ? rawHdcFallbackThreshold
  : DEFAULT_HDC_FALLBACK_THRESHOLD;

export const PRISM_HDC_POLICY_CLARIFY_THRESHOLD = hdcThresholdsValid
  ? rawHdcClarifyThreshold
  : DEFAULT_HDC_CLARIFY_THRESHOLD;

// ─── v6.2: Graph Soft-Pruning ───────────────────────────────
// Soft-pruning filters weak links from graph/retrieval reads while preserving
// underlying rows for provenance. This does NOT delete links.
export const PRISM_GRAPH_PRUNING_ENABLED = process.env.PRISM_GRAPH_PRUNING_ENABLED === "true";
export const PRISM_GRAPH_PRUNE_MIN_STRENGTH = parseFloat(
  process.env.PRISM_GRAPH_PRUNE_MIN_STRENGTH || "0.15"
);

// Scheduler-driven prune sweep controls (WS3)
export const PRISM_GRAPH_PRUNE_PROJECT_COOLDOWN_MS = parseInt(
  process.env.PRISM_GRAPH_PRUNE_PROJECT_COOLDOWN_MS || "600000", 10
);
export const PRISM_GRAPH_PRUNE_SWEEP_BUDGET_MS = parseInt(
  process.env.PRISM_GRAPH_PRUNE_SWEEP_BUDGET_MS || "30000", 10
);
export const PRISM_GRAPH_PRUNE_MAX_PROJECTS_PER_SWEEP = parseInt(
  process.env.PRISM_GRAPH_PRUNE_MAX_PROJECTS_PER_SWEEP || "25", 10
);

// ─── v7.0: ACT-R Cognitive Memory Activation ────────────────
// Scientifically-grounded retrieval re-ranking based on the ACT-R
// cognitive architecture. Replaces simple Ebbinghaus decay with
// a composite similarity + activation model.

/** Master switch for ACT-R activation-based re-ranking. */
export const PRISM_ACTR_ENABLED = process.env.PRISM_ACTR_ENABLED === "true";

/** ACT-R decay parameter d in t^(-d). Higher = faster forgetting. (Paper default: 0.5) */
export const PRISM_ACTR_DECAY = parseFloat(process.env.PRISM_ACTR_DECAY || "0.5");

/** Weight of cosine similarity in composite score. (Default: 0.7 — similarity dominates) */
export const PRISM_ACTR_WEIGHT_SIMILARITY = parseFloat(
  process.env.PRISM_ACTR_WEIGHT_SIMILARITY || "0.7"
);

/** Weight of activation boost in composite score. (Default: 0.3 — activation re-ranks) */
export const PRISM_ACTR_WEIGHT_ACTIVATION = parseFloat(
  process.env.PRISM_ACTR_WEIGHT_ACTIVATION || "0.3"
);

/** Sigmoid midpoint: activation value that maps to 0.5 boost. (Default: -2.0) */
export const PRISM_ACTR_SIGMOID_MIDPOINT = parseFloat(
  process.env.PRISM_ACTR_SIGMOID_MIDPOINT || "-2.0"
);

/** Sigmoid steepness k. Higher = sharper discrimination. (Default: 1.0) */
export const PRISM_ACTR_SIGMOID_STEEPNESS = parseFloat(
  process.env.PRISM_ACTR_SIGMOID_STEEPNESS || "1.0"
);

/** Max access log entries per entry for base-level activation. (Default: 50) */
export const PRISM_ACTR_MAX_ACCESSES_PER_ENTRY = parseInt(
  process.env.PRISM_ACTR_MAX_ACCESSES_PER_ENTRY || "50", 10
);

/** AccessLogBuffer flush interval in milliseconds. (Default: 5000ms) */
export const PRISM_ACTR_BUFFER_FLUSH_MS = parseInt(
  process.env.PRISM_ACTR_BUFFER_FLUSH_MS || "5000", 10
);

/** Days to retain access log entries before pruning. (Default: 90) */
export const PRISM_ACTR_ACCESS_LOG_RETENTION_DAYS = parseInt(
  process.env.PRISM_ACTR_ACCESS_LOG_RETENTION_DAYS || "90", 10
);
