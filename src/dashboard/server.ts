/**
 * Mind Palace Dashboard — HTTP Server (v2.0 — Step 8)
 *
 * Zero-dependency HTTP server serving the Prism Mind Palace UI.
 * Runs alongside the MCP stdio server on a separate port.
 *
 * ═══════════════════════════════════════════════════════════════════
 * CRITICAL MCP SAFETY:
 *   The MCP server communicates via stdout. ANY console.log() here
 *   will corrupt the JSON-RPC stream and crash the agent.
 *   All logging uses console.error() exclusively.
 *
 * ENDPOINTS:
 *   GET /                   → Dashboard UI (HTML)
 *   GET /api/projects       → List all projects with handoff data
 *   GET /api/project?name=  → Full project data (context, ledger, history)
 * ═══════════════════════════════════════════════════════════════════
 */

import * as http from "http";
import { execSync } from "child_process";
import { getStorage } from "../storage/index.js";
import { PRISM_USER_ID, SERVER_CONFIG } from "../config.js";
import { renderDashboardHTML } from "./ui.js";

const PORT = parseInt(process.env.PRISM_DASHBOARD_PORT || "3000", 10);

/**
 * Kill any existing process holding the dashboard port.
 * This prevents zombie dashboard processes from surviving IDE restarts
 * and serving stale versions of the UI.
 */
function killPortHolder(port: number): void {
  try {
    // lsof returns PIDs listening on the port; -t gives terse (PID-only) output
    const pids = execSync(`lsof -ti tcp:${port}`, { encoding: "utf-8" })
      .trim()
      .split("\n")
      .filter(Boolean);

    if (pids.length === 0) return;

    // Don't kill ourselves
    const myPid = String(process.pid);
    const stalePids = pids.filter(p => p !== myPid);

    if (stalePids.length > 0) {
      console.error(`[Dashboard] Killing stale process(es) on port ${port}: ${stalePids.join(", ")}`);
      execSync(`kill ${stalePids.join(" ")}`, { encoding: "utf-8" });
      // Brief pause to let the OS release the port
      execSync("sleep 0.3");
    }
  } catch (err: unknown) {
    // lsof exits with code 1 when no matches found — that's expected.
    // Any other failure (lsof missing, permission denied, etc.) gets a warning.
    const isNoMatch =
      err instanceof Error &&
      "status" in err &&
      (err as any).status === 1;

    if (!isNoMatch) {
      console.error(
        `[Dashboard] killPortHolder: could not check port ${port} (lsof may not be installed) — skipping.`
      );
    }
  }
}

export async function startDashboardServer(): Promise<void> {
  // Clean up any zombie dashboard process from a previous session
  killPortHolder(PORT);

  const storage = await getStorage();

  const httpServer = http.createServer(async (req, res) => {
    // CORS headers for local dev
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    try {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);

      // ─── Serve the Dashboard UI ───
      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate",
        });
        return res.end(renderDashboardHTML(SERVER_CONFIG.version));
      }

      // ─── API: List all projects ───
      if (url.pathname === "/api/projects") {
        const projects = await storage.listProjects();
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ projects }));
      }

      // ─── API: Get full project data ───
      if (url.pathname === "/api/project") {
        const projectName = url.searchParams.get("name");
        if (!projectName) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Missing ?name= parameter" }));
        }

        const context = await storage.loadContext(projectName, "deep", PRISM_USER_ID);
        const ledger = await storage.getLedgerEntries({
          project: `eq.${projectName}`,
          order: "created_at.desc",
          limit: "20",
        });
        let history: unknown[] = [];
        try {
          history = await storage.getHistory(projectName, PRISM_USER_ID, 10);
        } catch {
          // History may not exist for all projects
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ context, ledger, history }));
      }

      // ─── API: Brain Health Check (v2.2.0) ───
      if (url.pathname === "/api/health") {
        try {
          const { runHealthCheck } = await import("../utils/healthCheck.js");
          const stats = await storage.getHealthStats(PRISM_USER_ID);
          const report = runHealthCheck(stats);
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify(report));
        } catch (err) {
          console.error("[Dashboard] Health check error:", err);
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({
            status: "unknown",
            summary: "Health check unavailable",
            issues: [],
            counts: { errors: 0, warnings: 0, infos: 0 },
            totals: { activeEntries: 0, handoffs: 0, rollups: 0 },
            timestamp: new Date().toISOString(),
          }));
        }
      }

      // ─── API: Knowledge Graph Data (v2.3.0) ───
      if (url.pathname === "/api/graph") {
        // Fetch recent ledger entries to build the graph
        // We look at the last 100 entries to keep the graph relevant but performant
        const entries = await storage.getLedgerEntries({
          limit: "100",
          order: "created_at.desc",
          select: "project,keywords",
        });

        // Deduplication sets for nodes and edges
        const nodes: { id: string; label: string; group: string }[] = [];
        const edges: { from: string; to: string }[] = [];
        const nodeIds = new Set<string>();   // track unique node IDs
        const edgeIds = new Set<string>();   // track unique edges

        // Helper: add a node only if it doesn't already exist
        const addNode = (id: string, group: string, label?: string) => {
          if (!nodeIds.has(id)) {
            nodes.push({ id, label: label || id, group });
            nodeIds.add(id);
          }
        };

        // Helper: add an edge only if it doesn't already exist
        const addEdge = (from: string, to: string) => {
          const id = `${from}-${to}`;  // deterministic edge ID
          if (!edgeIds.has(id)) {
            edges.push({ from, to });
            edgeIds.add(id);
          }
        };

        // Transform relational data into graph nodes & edges
        (entries as any[]).forEach(row => {
          if (!row.project) return;  // skip rows without project

          // 1. Project node (hub — large purple dot)
          addNode(row.project, "project");

          // 2. Keyword nodes (spokes — small dots)
          let keywords: string[] = [];

          // Handle SQLite (JSON string) vs Supabase (native array)
          if (Array.isArray(row.keywords)) {
            keywords = row.keywords;
          } else if (typeof row.keywords === "string") {
            try { keywords = JSON.parse(row.keywords); } catch { /* skip malformed */ }
          }

          // Create nodes + edges for each keyword
          keywords.forEach((kw: string) => {
            if (kw.length < 3) return;  // skip noise like "a", "is"

            // Handle categories (cat:debugging) vs raw keywords
            const isCat = kw.startsWith("cat:");
            const group = isCat ? "category" : "keyword";
            const label = isCat ? kw.replace("cat:", "") : kw;

            addNode(kw, group, label);  // keyword/category node
            addEdge(row.project, kw);   // edge: project → keyword
          });
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ nodes, edges }));
      }

      // ─── 404 ───
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");

    } catch (error) {
      console.error("[Dashboard] Error handling request:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    }
  });

  // Gracefully handle port conflicts (non-fatal — MCP server keeps running)
  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[Dashboard] Port ${PORT} is in use — Mind Palace disabled. ` +
          `Set PRISM_DASHBOARD_PORT to use a different port.`
      );
    } else {
      console.error(`[Dashboard] HTTP server error: ${err.message}`);
    }
  });

  httpServer.listen(PORT, () => {
    console.error(`[Prism] 🧠 Mind Palace Dashboard → http://localhost:${PORT}`);
  });
}
