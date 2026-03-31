/**
 * Graph Router — Extracted from server.ts (Step 2: Temporal Decay Heatmaps)
 *
 * ═══════════════════════════════════════════════════════════════════
 * Handles all graph-related API endpoints for the Mind Palace dashboard.
 *
 * Endpoints:
 *   GET  /api/graph       → Knowledge graph data (nodes + edges + decay data)
 *   POST /api/graph/node  → Edit (rename/delete/merge) a keyword/category node
 *
 * Design Decisions:
 *   - Extracted to reduce server.ts coupling (flagged in reviews #2, #3)
 *   - `/api/graph` now returns `days_since_access` per node for heatmap viz
 *   - COALESCE(last_accessed_at, created_at) prevents NULL decay values
 * ═══════════════════════════════════════════════════════════════════
 */

import type * as http from "http";
import type { StorageBackend } from "../storage/interface.js";
import { PRISM_USER_ID } from "../config.js";

/** Typed graph node with optional decay metadata */
interface GraphNode {
  id: string;
  label: string;
  group: string;
  /** Days since this node's most recent underlying entry was accessed (null for keyword-only nodes) */
  days_since_access?: number | null;
  /** Effective importance (decayed) of the freshest entry behind this node */
  decayed_importance?: number | null;
  /** Raw importance of the freshest entry (pre-decay). Used by UI to check graduated status. */
  base_importance?: number | null;
}

/** Typed graph edge */
interface GraphEdge {
  from: string;
  to: string;
}

/** Read HTTP request body as string */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * Handle graph API routes. Returns `true` if the route was handled, `false` otherwise.
 *
 * Caller (server.ts) should call this before its own 404 handler:
 * ```ts
 * if (await handleGraphRoutes(url, req, res, getStorageSafe)) return;
 * ```
 */
export async function handleGraphRoutes(
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  getStorageSafe: () => Promise<StorageBackend | null>,
): Promise<boolean> {

  // ─── API: Knowledge Graph Data (v2.3.0 / v5.1 / v6.2 decay) ───
  if (url.pathname === "/api/graph" && req.method === "GET") {
    const project = url.searchParams.get("project") || undefined;
    const days = url.searchParams.get("days") || undefined;
    const min_importance = url.searchParams.get("min_importance") || undefined;

    const s = await getStorageSafe();
    if (!s) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Storage initializing..." }));
      return true;
    }

    // Build query params — include last_accessed_at + created_at for decay computation
    const params: Record<string, string> = {
      order: "created_at.desc",
      select: "project,keywords,created_at,importance,last_accessed_at",
    };

    if (!project && !days && !min_importance) {
      params.limit = "30";  // Keep default small to prevent Vis.js stack overflow
    } else {
      params.limit = "200"; // Bump limit when exploring specific filters
    }

    if (project) params.project = `eq.${project}`;
    if (days) {
      const past = new Date();
      past.setDate(past.getDate() - parseInt(days, 10));
      params.created_at = `gte.${past.toISOString()}`;
    }
    if (min_importance) params.importance = `gte.${parseInt(min_importance, 10)}`;

    const entries = await s.getLedgerEntries(params);
    const now = Date.now();

    // ── Decay tracking: aggregate per-keyword and per-project ──
    // For each keyword/project, track the *freshest* entry's decay info
    // so the UI can color nodes by recency.
    const nodeDecay = new Map<string, { days_since_access: number; decayed_importance: number; base_importance: number }>();

    /** Update decay for a node ID, keeping the freshest (lowest days_since) value */
    const trackDecay = (nodeId: string, row: any) => {
      const accessedAt = row.last_accessed_at || row.created_at;
      const daysSince = accessedAt
        ? Math.max(0, Math.floor((now - new Date(accessedAt).getTime()) / (1000 * 60 * 60 * 24)))
        : 999; // Never accessed, never created — treat as maximally stale

      const baseImportance = typeof row.importance === "number" ? row.importance : 0;
      // Ebbinghaus decay: effective = base * 0.95^days
      const decayed = baseImportance > 0
        ? Math.round(baseImportance * Math.pow(0.95, daysSince) * 100) / 100
        : 0;

      const existing = nodeDecay.get(nodeId);
      if (!existing || daysSince < existing.days_since_access) {
        nodeDecay.set(nodeId, { days_since_access: daysSince, decayed_importance: decayed, base_importance: baseImportance });
      }
    };

    // Deduplication sets for nodes and edges
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const nodeIds = new Set<string>();
    const edgeIds = new Set<string>();

    const addNode = (id: string, group: string, label?: string) => {
      if (!nodeIds.has(id)) {
        nodes.push({ id, label: label || id, group });
        nodeIds.add(id);
      }
    };

    const addEdge = (from: string, to: string) => {
      const id = `${from}-${to}`;
      if (!edgeIds.has(id)) {
        edges.push({ from, to });
        edgeIds.add(id);
      }
    };

    // Transform relational data into graph nodes & edges
    (entries as any[]).forEach(row => {
      if (!row.project) return;

      // 1. Project node (hub — large purple dot)
      addNode(row.project, "project");
      trackDecay(row.project, row);

      // 2. Keyword nodes (spokes)
      let keywords: string[] = [];
      if (Array.isArray(row.keywords)) {
        keywords = row.keywords;
      } else if (typeof row.keywords === "string") {
        try { keywords = JSON.parse(row.keywords); } catch { /* skip malformed */ }
      }

      keywords.forEach((kw: string) => {
        if (kw.length < 3) return;

        const isCat = kw.startsWith("cat:");
        const group = isCat ? "category" : "keyword";
        const label = isCat ? kw.replace("cat:", "") : kw;

        addNode(kw, group, label);
        trackDecay(kw, row);
        addEdge(row.project, kw);
      });
    });

    // ── Enrich nodes with decay metadata ──
    for (const node of nodes) {
      const decay = nodeDecay.get(node.id);
      if (decay) {
        node.days_since_access = decay.days_since_access;
        node.decayed_importance = decay.decayed_importance;
        node.base_importance = decay.base_importance;
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ nodes, edges }));
    return true;
  }

  // ─── API: Edit Knowledge Graph Node (v5.1) ───
  if (url.pathname === "/api/graph/node" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const { oldId, newId, group } = JSON.parse(body || "{}");

      if (!oldId || !group || (group !== "keyword" && group !== "category")) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid request" }));
        return true;
      }

      const s = await getStorageSafe();
      if (!s) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Storage not ready" }));
        return true;
      }

      // Reconstruct the full keyword string
      const searchKw = group === "category" ? `cat:${oldId}` : oldId;
      const newKw = newId ? (group === "category" ? `cat:${newId}` : newId) : null;

      // Fetch entries containing the old keyword
      const entries = await s.getLedgerEntries({
        keywords: `cs.{${searchKw}}`,
        select: "id,keywords",
      }) as Array<{ id: string; keywords: unknown }>;

      let updated = 0;
      for (const entry of entries) {
        let kws: string[] = [];
        if (Array.isArray(entry.keywords)) kws = entry.keywords as string[];
        else if (typeof entry.keywords === "string") {
          try { kws = JSON.parse(entry.keywords); } catch { continue; }
        }

        if (!kws.includes(searchKw)) continue;

        const newKws = kws.filter(k => k !== searchKw);
        if (newKw && !newKws.includes(newKw)) {
          newKws.push(newKw);
        }

        await s.patchLedger(entry.id, { keywords: newKws });
        updated++;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, updated }));
      return true;
    } catch (err) {
      console.error("[Dashboard] Node edit error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Edit failed" }));
      return true;
    }
  }

  // Not a graph route — let caller handle it
  return false;
}
