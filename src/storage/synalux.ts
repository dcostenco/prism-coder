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
 *     - loadContext       → POST /api/v1/prism/memory  action=load_context
 *     - searchKnowledge   → POST /api/v1/prism/memory  action=search
 *     - softDeleteLedger  → POST /api/v1/prism/memory  action=forget_memory (Phase 3 Tier A)
 *     - hardDeleteLedger  → POST /api/v1/prism/memory  action=forget_memory (Phase 3 Tier A)
 *
 *   Methods still falling through to SupabaseStorage (Phase 3 Tier B+):
 *   semantic searchMemory, save_experience direct entrypoint,
 *   compactLedger, image ops, history, hivemind, etc.
 *   See portal/docs/PHASE_3_PORTAL_ENDPOINTS.md for the full catalog.
 * ═══════════════════════════════════════════════════════════════════
 */

import { SupabaseStorage } from "./supabase.js";
import { debugLog } from "../utils/logger.js";
import { PRISM_SYNALUX_BASE_URL, PRISM_SYNALUX_API_KEY } from "../config.js";
import type {
  LedgerEntry,
  HandoffEntry,
  SaveHandoffResult,
  ContextResult,
  KnowledgeSearchResult,
} from "./interface.js";

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

export class SynaluxStorage extends SupabaseStorage {
  private readonly baseUrl: string;
  private readonly refreshToken: string;
  private cachedJwt: string | null = null;
  private cachedJwtExpiresAt = 0;
  private inflightExchange: Promise<string> | null = null;

  constructor() {
    super();
    if (!PRISM_SYNALUX_BASE_URL || !PRISM_SYNALUX_API_KEY) {
      throw new Error(
        "[SynaluxStorage] PRISM_SYNALUX_BASE_URL and PRISM_SYNALUX_API_KEY must be set. " +
        "Set them, or use PRISM_STORAGE=local for offline mode."
      );
    }
    if (!PRISM_SYNALUX_API_KEY.startsWith("synalux_sk_")) {
      throw new Error(
        "[SynaluxStorage] PRISM_SYNALUX_API_KEY must be a synalux_sk_* refresh token. " +
        "Generate one in the synalux portal dashboard."
      );
    }
    this.baseUrl = PRISM_SYNALUX_BASE_URL.replace(/\/+$/, "");
    this.refreshToken = PRISM_SYNALUX_API_KEY;
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
    return (result.handoff ?? result) as SaveHandoffResult;
  }

  // ─── Context ─────────────────────────────────────────────────

  async loadContext(project: string, level: string, userId: string, role?: string): Promise<ContextResult> {
    const result = await this.portalPost("/api/v1/prism/memory", {
      action: "load_context",
      project,
      level,
      user_id: userId,
      role,
    });
    return (result.context ?? result) as ContextResult;
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
    const result = await this.portalPost("/api/v1/prism/memory", {
      action: "knowledge_search",
      project: params.project ?? undefined,
      keywords: params.keywords ?? [],
      category: params.category ?? undefined,
      queryText: params.queryText ?? undefined,
      limit: params.limit ?? 10,
      role: params.role ?? undefined,
    });
    const count = typeof result.count === "number" ? result.count : 0;
    const results = Array.isArray(result.results) ? result.results : [];
    return { count, results } as KnowledgeSearchResult;
  }
}
