/**
 * Synalux Storage Backend (v13 — thin HTTP client)
 *
 * The paid-tier write path. Forwards every storage operation to the
 * synalux portal at PRISM_SYNALUX_BASE_URL. Auth is a two-step dance:
 * `PRISM_SYNALUX_API_KEY` is a `synalux_sk_*` refresh token that the
 * client exchanges for a 15-minute EdDSA JWT via
 * `POST /api/v1/auth/jwt`. The JWT is what gets sent as Bearer on
 * memory endpoints. The portal owns project validation, tier gating,
 * audit logging, and the direct Supabase write — this client never
 * touches Supabase directly.
 *
 * ═══════════════════════════════════════════════════════════════════
 * MIGRATION POSTURE:
 *   Inherits from SupabaseStorage so methods that don't yet have a
 *   synalux portal endpoint still function. Each method that has been
 *   migrated overrides the parent and routes to the portal instead.
 *   When all methods are migrated, the inheritance can be removed.
 *
 *   Methods migrated to portal:
 *     - saveLedger        → POST /api/v1/prism/memory  action=save_ledger
 *     - saveHandoff       → POST /api/v1/prism/memory  action=save_handoff
 *     - saveHistorySnapshot → POST /api/v1/prism/memory  action=save_history_snapshot
 *     - loadContext       → POST /api/v1/prism/memory  action=load_context
 *     - searchKnowledge   → POST /api/v1/prism/memory  action=search
 *     - softDeleteLedger  → POST /api/v1/prism/memory  action=forget_memory (Phase 3 Tier A)
 *     - hardDeleteLedger  → POST /api/v1/prism/memory  action=forget_memory (Phase 3 Tier A)
 *     - searchMemory      → POST /api/v1/prism/memory  action=search_memory
 *     - getHistory        → POST /api/v1/prism/memory  action=memory_history
 *     - patchLedger       → POST /api/v1/prism/memory  action=save_embedding
 *     - getEntriesMissingEmbeddings → POST /api/v1/prism/memory  action=list_missing_embeddings
 *     - listProjects      → POST /api/v1/prism/memory  action=list_projects
 *     - exportLedger      → POST /api/v1/prism/memory  action=export_memory (paginated)
 *
 *   Methods still falling through to SupabaseStorage (Phase 3 Tier B+):
 *   save_experience direct entrypoint, compactLedger, image ops,
 *   hivemind, etc. Anything in this group requires a direct SUPABASE_URL
 *   and therefore does NOT work on paid-tier installs — that is precisely
 *   how embedding writes failed silently: patchLedger was inherited, threw
 *   against a URL that is not configured, and the caller swallowed it.
 *   Before relying on an inherited method, check it is actually reachable.
 *
 *   NOTE: this list was previously wrong — it named searchMemory and
 *   history as falling through when both had already been overridden.
 *   A stale routing map here sends the next reader down the wrong path,
 *   so amend it in the same commit that moves a method.
 *   See portal/docs/PHASE_3_PORTAL_ENDPOINTS.md for the full catalog.
 * ═══════════════════════════════════════════════════════════════════
 */

import { SupabaseStorage } from "./supabase.js";
import { debugLog } from "../utils/logger.js";
import { PRISM_SYNALUX_BASE_URL, PRISM_SYNALUX_API_KEY } from "../config.js";
import { KnowledgeSearchRequestSchema, KnowledgeSearchResponseSchema } from "./portalContracts.js";
import type {
  LedgerEntry,
  HandoffEntry,
  SaveHandoffResult,
  ContextResult,
  KnowledgeSearchResult,
  SemanticSearchResult,
  SpreadingActivationOptions,
  HistorySnapshot,
  HealthStats,
} from "./interface.js";

/**
 * Resolve the knowledge_search scope without baking a policy default here.
 * Precedence: caller-supplied value > PRISM_KNOWLEDGE_SCOPE env > undefined
 * (lets the portal apply its own default). Unrecognised env values are
 * ignored rather than coerced, so misconfiguration fails open to portal default.
 */
type KnowledgeScope = "user" | "workspace";
function resolveKnowledgeScope(callerScope: unknown): KnowledgeScope | undefined {
  if (callerScope === "user" || callerScope === "workspace") {
    return callerScope;
  }
  const envScope = process.env.PRISM_KNOWLEDGE_SCOPE;
  if (envScope === "user" || envScope === "workspace") {
    return envScope;
  }
  return undefined;
}

interface PortalResponse {
  status: "success" | "error";
  error?: string;
  [key: string]: unknown;
}

interface JwtExchangeResponse {
  status: "success" | "error";
  jwt?: string;
  expires_in?: number;
  error?: string;
}

/** Refresh JWT this many ms before expiry to avoid edge-case 401s. */
const JWT_REFRESH_LEEWAY_MS = 60_000;

function buildContextLoadKey(project: string, level: string, userId: string, role?: string): string {
  return JSON.stringify({ project, level, userId, role: role ?? "" });
}

export class SynaluxStorage extends SupabaseStorage {
  private readonly baseUrl: string;
  private readonly refreshToken: string;
  private cachedJwt: string | null = null;
  private cachedJwtExpiresAt = 0;
  private inflightExchange: Promise<string> | null = null;
  private readonly inflightContextLoads = new Map<string, Promise<ContextResult>>();

  constructor() {
    super();
    const url = process.env.PRISM_SYNALUX_BASE_URL || PRISM_SYNALUX_BASE_URL;
    const key = process.env.PRISM_SYNALUX_API_KEY || PRISM_SYNALUX_API_KEY;
    if (!url || !key) {
      throw new Error(
        "[SynaluxStorage] PRISM_SYNALUX_BASE_URL and PRISM_SYNALUX_API_KEY must be set. " +
        "Set them, or use PRISM_STORAGE=local for offline mode."
      );
    }
    if (!key.startsWith("synalux_sk_")) {
      throw new Error(
        "[SynaluxStorage] PRISM_SYNALUX_API_KEY must be a synalux_sk_* refresh token. " +
        "Generate one in the synalux portal dashboard."
      );
    }
    this.baseUrl = url.replace(/\/+$/, "");
    this.refreshToken = key;
  }

  async initialize(_isLocal: boolean = false): Promise<void> {
    debugLog(`[SynaluxStorage] Initializing (portal=${this.baseUrl})`);
  }

  async close(): Promise<void> {
    debugLog("[SynaluxStorage] Closed (no-op for HTTP)");
  }

  /**
   * Returns a valid JWT, exchanging the refresh token if the cached
   * JWT is missing or near expiry. Concurrent callers share a single
   * inflight exchange so we don't trip the portal's 5s rate limit.
   */
  private async ensureJwt(): Promise<string> {
    const now = Date.now();
    if (this.cachedJwt && now < this.cachedJwtExpiresAt - JWT_REFRESH_LEEWAY_MS) {
      return this.cachedJwt;
    }
    if (this.inflightExchange) {
      return this.inflightExchange;
    }

    this.inflightExchange = (async () => {
      const url = `${this.baseUrl}/api/v1/auth/jwt`;
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.refreshToken}`,
            "X-Prism-Client": "prism-mcp-thin-client",
          },
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        throw new Error(
          `[SynaluxStorage] JWT exchange network error: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      let data: JwtExchangeResponse;
      try {
        data = await res.json() as JwtExchangeResponse;
      } catch {
        throw new Error(`[SynaluxStorage] JWT exchange returned non-JSON (HTTP ${res.status})`);
      }

      if (!res.ok || data.status !== "success" || !data.jwt) {
        throw new Error(
          `[SynaluxStorage] JWT exchange failed: ${data.error || `HTTP ${res.status}`}`
        );
      }

      this.cachedJwt = data.jwt;
      this.cachedJwtExpiresAt = Date.now() + (data.expires_in ?? 900) * 1000;
      debugLog(`[SynaluxStorage] JWT refreshed (expires in ${data.expires_in ?? 900}s)`);
      return data.jwt;
    })();

    try {
      return await this.inflightExchange;
    } finally {
      this.inflightExchange = null;
    }
  }

  /**
   * POST to a synalux portal endpoint with JWT bearer auth. Refreshes
   * the JWT once and retries on 401 to handle the rare race where the
   * cached JWT was just invalidated (e.g. token revoked, leeway too
   * tight). Returns parsed JSON or throws on non-2xx / malformed.
   */
  private async portalPost(path: string, body: Record<string, unknown>): Promise<PortalResponse> {
    const url = `${this.baseUrl}${path}`;
    const send = async (jwt: string): Promise<Response> => {
      try {
        return await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${jwt}`,
            "X-Prism-Client": "prism-mcp-thin-client",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        throw new Error(
          `[SynaluxStorage] Network error calling ${url}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    };

    let jwt = await this.ensureJwt();
    let res = await send(jwt);

    if (res.status === 401) {
      this.cachedJwt = null;
      this.cachedJwtExpiresAt = 0;
      jwt = await this.ensureJwt();
      res = await send(jwt);
    }

    let data: PortalResponse;
    try {
      data = await res.json() as PortalResponse;
    } catch {
      throw new Error(
        `[SynaluxStorage] Invalid JSON from ${url} (status ${res.status})`
      );
    }

    if (!res.ok || data.status === "error") {
      const msg = data?.error || `HTTP ${res.status}`;
      throw new Error(`[SynaluxStorage] ${path} failed: ${msg}`);
    }

    return data;
  }

  // ─── Ledger ──────────────────────────────────────────────────

  async saveLedger(entry: LedgerEntry): Promise<unknown> {
    const result = await this.portalPost("/api/v1/prism/memory", {
      action: "save_ledger",
      project: entry.project,
      summary: entry.summary,
      conversation_id: entry.conversation_id,
      decisions: entry.decisions,
      todos: entry.todos,
      files_changed: entry.files_changed,
      role: entry.role,
      event_type: entry.event_type,
      confidence_score: entry.confidence_score,
    });
    return result.entry ?? result;
  }

  // ─── Handoff ─────────────────────────────────────────────────

  async saveHandoff(handoff: HandoffEntry, expectedVersion?: number | null): Promise<SaveHandoffResult> {
    const result = await this.portalPost("/api/v1/prism/memory", {
      action: "save_handoff",
      project: handoff.project,
      last_summary: handoff.last_summary,
      key_context: handoff.key_context,
      open_todos: handoff.pending_todo,
      active_branch: handoff.active_branch,
      role: handoff.role,
      expected_version: expectedVersion ?? undefined,
    });
    const candidate = Object.prototype.hasOwnProperty.call(result, "result")
      ? result.result
      : Object.prototype.hasOwnProperty.call(result, "handoff")
        ? result.handoff
        : result;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("[SynaluxStorage] Invalid save_handoff response: missing result");
    }

    const value = candidate as Record<string, unknown>;
    if (value.status === "conflict" && Number.isSafeInteger(value.current_version)) {
      return {
        status: "conflict",
        current_version: value.current_version as number,
      };
    }
    if ((value.status === "created" || value.status === "updated")
      && Number.isSafeInteger(value.version)) {
      return {
        status: value.status,
        version: value.version as number,
      };
    }
    // Older portal RPC wrappers returned only the new version. Preserve that
    // rolling-upgrade contract without accepting an unversioned success.
    if (value.status === undefined && Number.isSafeInteger(value.version)) {
      return {
        status: "updated",
        version: value.version as number,
      };
    }
    throw new Error("[SynaluxStorage] Invalid save_handoff response: malformed OCC result");
  }

  async saveHistorySnapshot(handoff: HandoffEntry, branch: string = "main"): Promise<void> {
    await this.portalPost("/api/v1/prism/memory", {
      action: "save_history_snapshot",
      project: handoff.project,
      version: handoff.version,
      snapshot: handoff,
      branch,
    });
  }

  // ─── Context ─────────────────────────────────────────────────

  async loadContext(project: string, level: string, userId: string, role?: string): Promise<ContextResult> {
    const key = buildContextLoadKey(project, level, userId, role);
    const existing = this.inflightContextLoads.get(key);
    if (existing) return existing;

    const request = (async (): Promise<ContextResult> => {
      const result = await this.portalPost("/api/v1/prism/memory", {
        action: "load_context",
        project,
        level,
        user_id: userId,
        role,
      });
      // Current portals return the canonical flat `context`. Older deployed
      // portals returned `{ handoff, recent_sessions }`; normalize that envelope
      // here so the formatter can still see last_summary, TODOs, version, and
      // session history during a rolling portal/client upgrade.
      if (result.context === null) return null;
      if (result.context && typeof result.context === "object" && !Array.isArray(result.context)) {
        return result.context as Record<string, unknown>;
      }
      if (result.handoff === null) return null;
      if (result.handoff && typeof result.handoff === "object" && !Array.isArray(result.handoff)) {
        return {
          ...(result.handoff as Record<string, unknown>),
          recent_sessions: Array.isArray(result.recent_sessions) ? result.recent_sessions : [],
        };
      }
      return result as ContextResult;
    })();
    this.inflightContextLoads.set(key, request);

    try {
      return await request;
    } finally {
      if (this.inflightContextLoads.get(key) === request) {
        this.inflightContextLoads.delete(key);
      }
    }
  }

  // ─── Forget memory (GDPR surgical deletion) ──────────────────
  // Phase 3 Tier A: route both soft and hard delete through the
  // portal's forget_memory action. The portal scopes deletes to the
  // caller's user_id server-side (defense-in-depth: even if the
  // client is compromised, it can only delete its own entries).

  async softDeleteLedger(id: string, _userId: string, reason?: string): Promise<void> {
    await this.portalPost("/api/v1/prism/memory", {
      action: "forget_memory",
      memory_id: id,
      hard_delete: false,
      reason: reason ?? null,
    });
  }

  async hardDeleteLedger(id: string, _userId: string): Promise<void> {
    await this.portalPost("/api/v1/prism/memory", {
      action: "forget_memory",
      memory_id: id,
      hard_delete: true,
    });
  }

  // ─── Semantic search (pgvector) ──────────────────────────────
  // Phase 3 Tier B.2: routes through the `search_memory` action.
  // The portal expects query_embedding as a number[]; the storage
  // interface passes it as a JSON-stringified array, so we parse
  // before sending. Activation (spreading-activation graph traversal)
  // is currently not supported through the portal — that's done
  // client-side after results return; the portal just runs the
  // pgvector cosine-similarity match.

  async searchMemory(params: {
    queryEmbedding: string;
    queryText?: string;
    project?: string | null;
    limit: number;
    similarityThreshold: number;
    userId: string;
    role?: string | null;
    activation?: SpreadingActivationOptions;
  }): Promise<SemanticSearchResult[]> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(params.queryEmbedding);
    } catch {
      throw new Error("[SynaluxStorage] queryEmbedding must be a JSON-stringified number[]");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("[SynaluxStorage] queryEmbedding must parse to an array");
    }

    const result = await this.portalPost("/api/v1/prism/memory", {
      action: "search_memory",
      project: params.project ?? undefined,
      // Enables the portal's hybrid lexical+semantic fusion (see interface).
      query: params.queryText || undefined,
      query_embedding: parsed,
      similarity_threshold: params.similarityThreshold,
      limit: params.limit,
      role: params.role ?? undefined,
    });
    return (Array.isArray(result.results) ? result.results : []) as SemanticSearchResult[];
  }

  // ─── Knowledge search (keyword + category) ───────────────────
  // Phase 3 Tier B: routes through `knowledge_search` (full schema)
  // instead of the project-only `search` action. The portal returns
  // full ledger fields, supports keywords[] intersection via Postgres
  // array overlap, and accepts optional project / category / role
  // filters. Falls back to plain text search when only queryText is
  // supplied.

  async searchKnowledge(params: {
    project?: string | null;
    keywords?: string[];
    category?: string | null;
    queryText?: string | null;
    limit?: number;
    role?: string | null;
    [key: string]: unknown;
  }): Promise<KnowledgeSearchResult | null> {
    const wireBody = KnowledgeSearchRequestSchema.parse({
      action: "knowledge_search",
      project: params.project ?? undefined,
      keywords: params.keywords ?? [],
      category: params.category ?? undefined,
      query: params.queryText ?? undefined,
      limit: params.limit ?? 10,
      role: params.role ?? undefined,
      // Scope precedence: explicit caller param > PRISM_KNOWLEDGE_SCOPE env
      // > undefined (portal decides). No hardcoded default here.
      scope: resolveKnowledgeScope(params.scope),
    });
    const result = await this.portalPost("/api/v1/prism/memory", wireBody as Record<string, unknown>);

    // Validate the RESPONSE against the shared contract, not just the request.
    // Before this, only the outgoing shape was checked — so a portal-side
    // field rename would have gone unnoticed on both sides, which is exactly
    // the 2026-05-24 class of incident this file exists to prevent.
    // safeParse (not parse) on purpose: drift must be loud, but it must not
    // take knowledge_search offline. The build-time contract test is what
    // fails hard; at runtime we log and degrade to lenient extraction.
    const validated = KnowledgeSearchResponseSchema.safeParse(result);
    if (!validated.success) {
      console.error(
        "[synalux] knowledge_search response failed contract validation — " +
        "portal and client may have drifted: " +
        JSON.stringify(validated.error.issues.map(i => ({ path: i.path, code: i.code }))),
      );
    }

    const count = typeof result.count === "number" ? result.count : 0;
    const results = Array.isArray(result.results) ? result.results : [];
    const matchMode = validated.success ? validated.data.match_mode : undefined;
    return { count, results, match_mode: matchMode } as KnowledgeSearchResult;
  }

  /**
   * Persist embedding data for an already-saved entry.
   *
   * MUST be overridden here. SupabaseStorage.patchLedger writes straight to
   * Supabase via supabasePatch, which needs a direct SUPABASE_URL — not
   * configured for paid-tier installs. Inheriting it meant every embedding
   * write threw, and session_save_ledger's fire-and-forget catch swallowed
   * the error while still reporting "Embedding generation queued". The
   * result was 0 of 8,560 rows carrying an embedding and semantic search
   * silently returning nothing.
   *
   * Only the vector is sent. embedding_compressed / embedding_format /
   * embedding_turbo_radius are local-SQLite columns that do not exist on the
   * portal schema; forwarding them would fail the whole write for fields the
   * server has nowhere to put.
   */
  async patchLedger(id: string, data: Record<string, unknown>): Promise<void> {
    const raw = data.embedding;
    if (raw === undefined || raw === null) return;

    // ledgerHandlers JSON-stringifies the vector before patching; accept both.
    let vector: unknown = raw;
    if (typeof raw === "string") {
      try {
        vector = JSON.parse(raw);
      } catch {
        throw new Error("patchLedger: embedding string is not valid JSON");
      }
    }
    if (!Array.isArray(vector)) {
      throw new Error("patchLedger: embedding must be an array");
    }

    await this.portalPost("/api/v1/prism/memory", {
      action: "save_embedding",
      memory_id: id,
      embedding: vector,
    });
  }

  /**
   * Rows semantic search cannot find, read through the portal.
   *
   * The backfill tool used to reach these via inherited getLedgerEntries —
   * a direct Supabase read paid-tier installs cannot make (NXDOMAIN), so the
   * repair tool could never see what needed repairing. The portal endpoint
   * ignores cursorId (it always returns the oldest missing rows, and rows
   * gain embeddings as the backfill proceeds, so the frontier advances by
   * itself); it is accepted here to satisfy the shared signature.
   */
  async getEntriesMissingEmbeddings(params: {
    project?: string;
    limit: number;
    cursorId?: string;
  }): Promise<Array<{ id: string; summary: string; decisions?: string[]; project: string }>> {
    const result = await this.portalPost("/api/v1/prism/memory", {
      action: "list_missing_embeddings",
      limit: params.limit,
      ...(params.project ? { project: params.project } : {}),
    });
    const entries = Array.isArray(result.entries) ? result.entries : [];
    return entries as Array<{ id: string; summary: string; decisions?: string[]; project: string }>;
  }

  // ─── Project inventory + export ──────────────────────────────
  // Both portal actions shipped in Phase 3 but the client was never
  // wired: listProjects and the export path fell through to
  // SupabaseStorage and threw "Supabase not configured" on every
  // paid-tier install (2026-08-18 audit).

  async listProjects(): Promise<string[]> {
    const result = await this.portalPost("/api/v1/prism/memory", {
      action: "list_projects",
    });
    // Strict on drift: a 200 without a projects ARRAY is a contract change,
    // not "no projects" — the portal returns projects:[] for genuinely none.
    // Coercing drift to [] would make callers report empty inventories while
    // claiming success. (R1 adversarial review 2026-08-18.)
    if (!Array.isArray(result.projects)) {
      throw new Error("[SynaluxStorage] list_projects: portal response missing projects[] — contract drift");
    }
    return result.projects
      .map((p: any) => (typeof p === "string" ? p : p?.project))
      .filter((name: unknown): name is string => typeof name === "string" && name.length > 0);
  }

  async exportLedger(project: string): Promise<unknown[]> {
    // action=export_memory is paginated (EXPORT_PAGE_SIZE=1000). Follow
    // next_offset until has_more is false, capped at 10 pages to match the
    // local path's 10k-row OOM guard.
    //
    // Strict on drift (R1 adversarial review 2026-08-18): this feeds a
    // BACKUP. A 200 missing ledger[] or page{} must throw, not degrade —
    // coercing either would write an empty or silently-truncated export
    // file that reports ✅ success, which is worse than any error.
    const rows: unknown[] = [];
    let offset = 0;
    for (let page = 0; page < 10; page++) {
      const result = await this.portalPost("/api/v1/prism/memory", {
        action: "export_memory",
        project,
        offset,
        limit: 1000,
      });
      if (!Array.isArray(result.ledger)) {
        throw new Error("[SynaluxStorage] export_memory: portal response missing ledger[] — contract drift");
      }
      const pageInfo = result.page as { has_more?: boolean; next_offset?: number | null } | undefined;
      if (typeof pageInfo?.has_more !== "boolean") {
        throw new Error("[SynaluxStorage] export_memory: portal response missing page.has_more — refusing a possibly-truncated export");
      }
      rows.push(...result.ledger);
      if (!pageInfo.has_more || typeof pageInfo.next_offset !== "number") break;
      offset = pageInfo.next_offset;
    }
    return rows;
  }

  // ─── Time Travel ─────────────────────────────────────────────
  // Phase 3 Tier B: route memory_history through portal instead of
  // falling through to SupabaseStorage (which requires a direct
  // SUPABASE_URL that is no longer configured for paid-tier installs).

  async getHistory(project: string, _userId: string, limit: number = 10): Promise<HistorySnapshot[]> {
    const result = await this.portalPost("/api/v1/prism/memory", {
      action: "memory_history",
      project,
      limit,
    });
    const versions = Array.isArray(result.versions) ? result.versions : [];
    return versions.map((v: any, i: number) => ({
      id: `${project}-v${v.version ?? i}`,
      project,
      user_id: _userId,
      version: typeof v.version === "number" ? v.version : i + 1,
      snapshot: v.snapshot ?? {},
      branch: v.branch ?? "main",
      created_at: v.created_at ?? new Date().toISOString(),
    })) as HistorySnapshot[];
  }

  // ─── Health Check ─────────────────────────────────────────────
  // Phase 3 Tier B: route health_check through portal. The portal
  // returns summary counts only (no per-entry duplicate scan), so
  // activeLedgerSummaries is returned empty — the hygiene handler
  // skips duplicate detection gracefully when the array is empty.

  async getHealthStats(_userId: string): Promise<HealthStats> {
    try {
      const result = await this.portalPost("/api/v1/prism/memory", {
        action: "health_check",
        project: "prism-mcp",
      });
      const inventory = result.inventory as Record<string, number> | undefined;
      const totalActiveEntries = typeof inventory?.ledger_entries === "number" ? inventory.ledger_entries : 0;
      const totalHandoffs = typeof inventory?.active_projects === "number" ? inventory.active_projects : 0;
      // Hardcoding 0 here certified a 100%-missing-embeddings outage as
      // "HEALTHY — all clean". Use the portal's real count; if the portal
      // predates the field, report -1 so healthCheck can say "unknown"
      // instead of lying in either direction.
      const missingEmbeddings = typeof inventory?.ledger_missing_embeddings === "number"
        ? inventory.ledger_missing_embeddings
        : -1;
      return {
        missingEmbeddings,
        activeLedgerSummaries: [],
        orphanedHandoffs: [],
        staleRollups: 0,
        totalActiveEntries,
        totalHandoffs,
        totalRollups: 0,
        totalCrdtMerges: 0,
      };
    } catch (e) {
      debugLog("[SynaluxStorage] getHealthStats failed: " + (e instanceof Error ? e.message : String(e)));
      return {
        // Portal unreachable: coverage is UNKNOWN, not zero. -1 makes the
        // health check say so rather than certify blind.
        missingEmbeddings: -1,
        activeLedgerSummaries: [],
        orphanedHandoffs: [],
        staleRollups: 0,
        totalActiveEntries: 0,
        totalHandoffs: 0,
        totalRollups: 0,
        totalCrdtMerges: 0,
      };
    }
  }

  /**
   * Detect semantic drift between the session goal and recent ledger entries.
   * Delegates embedding + detection to the Synalux portal (source of truth for
   * the HRR/GloVe/cosine stack). Prism-mcp never does NLP directly.
   */
  async detectDrift(
    project: string,
    goal: string,
    windowHours?: number,
    minDirectionalRatio?: number,
    extraParams?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { action: "detect_drift", project, goal };
    if (typeof windowHours === "number") body.window_hours = windowHours;
    if (typeof minDirectionalRatio === "number") body.min_directional_ratio = minDirectionalRatio;
    if (extraParams) Object.assign(body, extraParams);
    const result = await this.portalPost("/api/v1/prism/memory", body);
    return result as Record<string, unknown>;
  }

  /**
   * Fetch skill content from Synalux portal (paid-tier single source of truth).
   * Returns a map of { skillName → SKILL.md content } for all names that exist.
   * Missing skills are absent from the map — caller falls back to local SQLite.
   *
   * Uses a public GET (no auth required) since skill content is not sensitive
   * and the route is portal-side at /api/v1/skills/content.
   */
  async fetchSkillContent(names: string[]): Promise<Record<string, string>> {
    if (names.length === 0) return {};
    const url = `${this.baseUrl}/api/v1/skills/content?names=${encodeURIComponent(names.join(","))}`;
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) return {};
      const body = await res.json() as { skills?: Record<string, string> };
      return typeof body.skills === "object" && body.skills !== null ? body.skills : {};
    } catch {
      return {};
    }
  }
}
