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
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { exec } from "child_process";
import { getStorage } from "../storage/index.js";
import { PRISM_USER_ID, SERVER_CONFIG } from "../config.js";
import { renderDashboardHTML } from "./ui.js";
import { getAllSettings, setSetting, getSetting } from "../storage/configStorage.js";
import { compactLedgerHandler } from "../tools/compactionHandler.js";


const PORT = parseInt(process.env.PRISM_DASHBOARD_PORT || "3000", 10);

/** Read HTTP request body as string */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/**
 * Kill any existing process holding the dashboard port.
 * This prevents zombie dashboard processes from surviving IDE restarts
 * and serving stale versions of the UI.
 *
 * CRITICAL: Uses async exec() instead of execSync() to avoid blocking
 * the Node.js event loop. Blocking during startup prevents the MCP
 * stdio transport from responding to the initialize handshake in time,
 * causing Antigravity to report MCP_SERVER_INIT_ERROR.
 */
async function killPortHolder(port: number): Promise<void> {
  return new Promise((resolve) => {
    exec(`lsof -ti tcp:${port}`, { encoding: "utf-8" }, (err, stdout) => {
      if (err) {
        // lsof exits with code 1 when no matches found — that's expected.
        // Any other failure (lsof missing, permission denied, etc.) gets a warning.
        const isNoMatch = err.code === 1;
        if (!isNoMatch) {
          console.error(
            `[Dashboard] killPortHolder: could not check port ${port} (lsof may not be installed) — skipping.`
          );
        }
        return resolve();
      }

      const pids = stdout.trim().split("\n").filter(Boolean);
      if (pids.length === 0) return resolve();

      // Don't kill ourselves
      const myPid = String(process.pid);
      const stalePids = pids.filter(p => p !== myPid);

      if (stalePids.length > 0) {
        console.error(`[Dashboard] Killing stale process(es) on port ${port}: ${stalePids.join(", ")}`);
        exec(`kill ${stalePids.join(" ")}`, () => {
          // Brief pause to let the OS release the port
          setTimeout(resolve, 300);
        });
      } else {
        resolve();
      }
    });
  });
}

export async function startDashboardServer(): Promise<void> {
  // Await port cleanup before binding. This adds ~300ms from lsof + setTimeout,
  // but is safe because startDashboardServer() is already deferred to
  // setTimeout(0) in server.ts — the MCP stdio handshake is long finished.
  // The old fire-and-forget approach caused a deadly race condition:
  //   1. listen() fired BEFORE killPortHolder cleared the port → EADDRINUSE
  //   2. killPortHolder then killed the OTHER instance's entire process
  //   3. Result: no instance ever held port 3000
  await killPortHolder(PORT).catch(() => {});

  // Lazy storage accessor — returns null if storage isn't ready yet.
  // API routes gracefully degrade with 503 instead of blocking startup.
  let _storage: Awaited<ReturnType<typeof getStorage>> | null = null;
  const getStorageSafe = async (): Promise<Awaited<ReturnType<typeof getStorage>> | null> => {
    if (_storage) return _storage;
    try {
      _storage = await getStorage();
      return _storage;
    } catch {
      return null;
    }
  };

  /**
   * v5.1: Optional HTTP Basic Auth for remote dashboard access.
   *
   * HOW IT WORKS:
   *   1. If PRISM_DASHBOARD_USER and PRISM_DASHBOARD_PASS are NOT set → auth is disabled (backward compatible)
   *   2. If set → every request must provide Basic Auth credentials OR a valid session cookie
   *   3. On successful auth → a session cookie (24h) is set so users don't re-authenticate on every request
   *   4. On failure → a styled login page is shown (not a raw 401 popup)
   *
   * SECURITY NOTES:
   *   - This is HTTP Basic Auth — suitable for LAN/VPN access, NOT public internet without HTTPS
   *   - Session tokens are random 64-char hex strings stored in-memory (cleared on server restart)
   *   - Timing-safe comparison prevents credential timing attacks
   */
  const AUTH_USER = process.env.PRISM_DASHBOARD_USER || "";
  const AUTH_PASS = process.env.PRISM_DASHBOARD_PASS || "";
  const AUTH_ENABLED = AUTH_USER.length > 0 && AUTH_PASS.length > 0;
  const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  const activeSessions = new Map<string, number>(); // token → expiry timestamp

  /** Generate a random session token */
  function generateToken(): string {
    const chars = "abcdef0123456789";
    let token = "";
    for (let i = 0; i < 64; i++) {
      token += chars[Math.floor(Math.random() * chars.length)];
    }
    return token;
  }

  /** Timing-safe string comparison to prevent timing attacks */
  function safeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
  }

  /** Check if request is authenticated (returns true if auth is disabled) */
  function isAuthenticated(req: http.IncomingMessage): boolean {
    if (!AUTH_ENABLED) return true;

    // Check session cookie first
    const cookies = req.headers.cookie || "";
    const match = cookies.match(/prism_session=([a-f0-9]{64})/);
    if (match) {
      const token = match[1];
      const expiry = activeSessions.get(token);
      if (expiry && expiry > Date.now()) return true;
      // Expired — clean up
      if (expiry) activeSessions.delete(token);
    }

    // Check Basic Auth header
    const authHeader = req.headers.authorization || "";
    if (authHeader.startsWith("Basic ")) {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf-8");
      const [user, pass] = decoded.split(":");
      return safeCompare(user || "", AUTH_USER) && safeCompare(pass || "", AUTH_PASS);
    }

    return false;
  }

  /** Render a styled login page matching the Mind Palace theme */
  function renderLoginPage(): string {
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Prism MCP — Login</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0e1a;color:#f1f5f9;font-family:'Inter',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
.bg{position:fixed;inset:0;background-image:radial-gradient(circle at 20% 30%,rgba(139,92,246,0.08) 0%,transparent 50%),radial-gradient(circle at 80% 70%,rgba(59,130,246,0.06) 0%,transparent 50%)}
.login-card{position:relative;z-index:1;background:rgba(17,24,39,0.6);backdrop-filter:blur(16px);border:1px solid rgba(139,92,246,0.15);border-radius:16px;padding:2.5rem;width:380px;max-width:90vw;text-align:center}
.logo{font-size:1.75rem;font-weight:700;background:linear-gradient(135deg,#8b5cf6,#3b82f6,#06b6d4);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:0.5rem}
.subtitle{color:#64748b;font-size:0.85rem;margin-bottom:2rem}
.field{margin-bottom:1rem}
.field input{width:100%;padding:0.7rem 1rem;background:#111827;border:1px solid rgba(139,92,246,0.15);border-radius:10px;color:#f1f5f9;font-size:0.9rem;font-family:'Inter',sans-serif;outline:none;transition:border-color 0.2s}
.field input:focus{border-color:rgba(139,92,246,0.5)}
.field input::placeholder{color:#475569}
.login-btn{width:100%;padding:0.75rem;background:linear-gradient(135deg,#8b5cf6,#3b82f6);color:white;border:none;border-radius:10px;font-size:0.95rem;font-weight:600;cursor:pointer;transition:opacity 0.2s;margin-top:0.5rem}
.login-btn:hover{opacity:0.9}
.error{color:#f43f5e;font-size:0.8rem;margin-top:1rem;display:none}
.lock{font-size:2rem;margin-bottom:1rem}
</style></head><body>
<div class="bg"></div>
<div class="login-card">
<div class="lock">🔒</div>
<div class="logo">🧠 Prism Mind Palace</div>
<div class="subtitle">Authentication required for remote access</div>
<form id="loginForm" onsubmit="return handleLogin(event)">
<div class="field"><input type="text" id="user" placeholder="Username" autocomplete="username" required></div>
<div class="field"><input type="password" id="pass" placeholder="Password" autocomplete="current-password" required></div>
<button type="submit" class="login-btn">Sign In</button>
</form>
<div class="error" id="error">Invalid credentials</div>
</div>
<script>
async function handleLogin(e){e.preventDefault();
var u=document.getElementById('user').value,p=document.getElementById('pass').value;
var r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:u,pass:p})});
if(r.ok){window.location.reload();}else{document.getElementById('error').style.display='block';}
return false;}
</script></body></html>`;
  }

  if (AUTH_ENABLED) {
    console.error(`[Dashboard] 🔒 Auth enabled for user "${AUTH_USER}"`);
  }

  const httpServer = http.createServer(async (req, res) => {
    // CORS headers for local dev
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    // ─── v5.1: Auth login endpoint (always accessible) ───
    const reqUrl = new URL(req.url || "/", `http://${req.headers.host}`);
    if (AUTH_ENABLED && reqUrl.pathname === "/api/auth/login" && req.method === "POST") {
      const body = await readBody(req);
      try {
        const { user, pass } = JSON.parse(body);
        if (safeCompare(user || "", AUTH_USER) && safeCompare(pass || "", AUTH_PASS)) {
          const token = generateToken();
          activeSessions.set(token, Date.now() + SESSION_TTL_MS);
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Set-Cookie": `prism_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`,
          });
          return res.end(JSON.stringify({ ok: true }));
        }
      } catch { /* fall through to 401 */ }
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Invalid credentials" }));
    }

    // ─── v5.1: Auth gate — block unauthenticated requests ───
    if (AUTH_ENABLED && !isAuthenticated(req)) {
      // For API calls, return 401 JSON
      if (reqUrl.pathname.startsWith("/api/")) {
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Authentication required" }));
      }
      // For page requests, show login page
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(renderLoginPage());
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
        const s = await getStorageSafe();
        if (!s) { res.writeHead(503, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "Storage initializing..." })); }
        const projects = await s.listProjects();
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

        const s = await getStorageSafe();
        if (!s) { res.writeHead(503, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "Storage initializing..." })); }
        const context = await s.loadContext(projectName, "deep", PRISM_USER_ID);
        const ledger = await s.getLedgerEntries({
          project: `eq.${projectName}`,
          order: "created_at.desc",
          limit: "20",
        });
        let history: unknown[] = [];
        try {
          history = await s.getHistory(projectName, PRISM_USER_ID, 10);
        } catch {
          // History may not exist for all projects
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ context, ledger, history }));
      }

      // ─── API: Brain Health Check (v2.2.0) ───
      if (url.pathname === "/api/health" && req.method === "GET") {
        try {
          const { runHealthCheck } = await import("../utils/healthCheck.js");
          const s = await getStorageSafe();
          if (!s) { res.writeHead(503, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "Storage initializing..." })); }
          const stats = await s.getHealthStats(PRISM_USER_ID);
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

      // ─── API: Brain Health Cleanup (v3.1) ───
      // Deletes orphaned handoffs (handoffs with no backing ledger entries).
      if (url.pathname === "/api/health/cleanup" && req.method === "POST") {
        try {
          const { runHealthCheck } = await import("../utils/healthCheck.js");
          const s = await getStorageSafe();
          if (!s) { res.writeHead(503, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "Storage initializing..." })); }
          const stats = await s.getHealthStats(PRISM_USER_ID);
          const report = runHealthCheck(stats);

          // Collect orphaned handoff projects from the health issues
          const orphaned = stats.orphanedHandoffs || [];
          const cleaned: string[] = [];

          for (const { project } of orphaned) {
            try {
              await s.deleteHandoff(project, PRISM_USER_ID);
              cleaned.push(project);
              console.error(`[Dashboard] Cleaned up orphaned handoff: ${project}`);
            } catch (delErr) {
              console.error(`[Dashboard] Failed to delete handoff for ${project}:`, delErr);
            }
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({
            ok: true,
            cleaned,
            count: cleaned.length,
            message: cleaned.length > 0
              ? `Cleaned up ${cleaned.length} orphaned handoff(s): ${cleaned.join(", ")}`
              : "No orphaned handoffs to clean up.",
          }));
        } catch (err) {
          console.error("[Dashboard] Health cleanup error:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ ok: false, error: "Cleanup failed" }));
        }
      }

      // ─── API: Role-Scoped Skills (v3.1) ───

      // GET /api/skills → { skills: { dev: "...", qa: "..." } }
      if (url.pathname === "/api/skills" && req.method === "GET") {
        const all = await getAllSettings();
        const skills: Record<string, string> = {};
        for (const [k, v] of Object.entries(all)) {
          if (k.startsWith("skill:") && v) {
            skills[k.replace("skill:", "")] = v;
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ skills }));
      }

      // POST /api/skills → { role, content } saves skill:<role>
      if (url.pathname === "/api/skills" && req.method === "POST") {
        const body = await new Promise<string>(resolve => {
          let data = ""; req.on("data", c => data += c); req.on("end", () => resolve(data));
        });
        const { role, content } = JSON.parse(body || "{}");
        if (!role) { res.writeHead(400); return res.end(JSON.stringify({ error: "role required" })); }
        await setSetting(`skill:${role}`, content || "");
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true, role }));
      }

      // DELETE /api/skills/:role → clears skill:<role>
      if (url.pathname.startsWith("/api/skills/") && req.method === "DELETE") {
        const role = url.pathname.replace("/api/skills/", "");
        await setSetting(`skill:${role}`, "");
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true, role }));
      }

      // ─── API: Knowledge Graph Data (v2.3.0 / v5.1) ───
      if (url.pathname === "/api/graph" && req.method === "GET") {
        const project = url.searchParams.get("project") || undefined;
        const days = url.searchParams.get("days") || undefined;
        const min_importance = url.searchParams.get("min_importance") || undefined;

        // Fetch recent ledger entries to build the graph
        // We look at the last 100 entries to keep the graph relevant but performant
        const s = await getStorageSafe();
        if (!s) { res.writeHead(503, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "Storage initializing..." })); }

        const params: any = {
          order: "created_at.desc",
          select: "project,keywords,created_at,importance",
        };

        if (!project && !days && !min_importance) {
          params.limit = "30";  // Keep default small to prevent Vis.js stack overflow (426 nodes @ 100 entries)
        } else {
          params.limit = "200"; // Bump limit when exploring specific filters (capped by frontend maxNodes)
        }

        if (project) {
          params.project = `eq.${project}`;
        }
        if (days) {
          const past = new Date();
          past.setDate(past.getDate() - parseInt(days, 10));
          params.created_at = `gte.${past.toISOString()}`;
        }
        if (min_importance) {
          params.importance = `gte.${parseInt(min_importance, 10)}`;
        }

        const entries = await s.getLedgerEntries(params);

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

      // ─── API: Edit Knowledge Graph Node (v5.1) ───
      // Surgically patches keywords in the session_ledger.
      // Supports two operations:
      //   1. RENAME: old keyword → new keyword across all entries
      //   2. DELETE: remove a keyword from all entries (newId = null)
      //
      // HOW IT WORKS:
      //   - Reconstructs the full PostgREST-style keyword (e.g. cat:debugging)
      //   - Uses LIKE-based search to find candidate entries
      //   - Validates exact array membership in JS (prevents substring matches)
      //   - Idempotently strips or replaces the keyword via patchLedger()
      //
      // SECURITY: Protected by the v5.1 Dashboard Auth gate above.
      if (url.pathname === "/api/graph/node" && req.method === "POST") {
        try {
          const body = await readBody(req);
          const { oldId, newId, group } = JSON.parse(body || "{}");

          if (!oldId || !group || (group !== "keyword" && group !== "category")) {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "Invalid request" }));
          }

          const s = await getStorageSafe();
          if (!s) { res.writeHead(503, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "Storage not ready" })); }

          // 1. Reconstruct the full string as stored in DB
          //    Categories are prefixed with "cat:" (e.g. cat:debugging)
          //    Keywords are stored as bare strings (e.g. authentication)
          const searchKw = group === "category" ? `cat:${oldId}` : oldId;
          const newKw = newId ? (group === "category" ? `cat:${newId}` : newId) : null;

          // 2. Fetch all entries containing the old keyword (LIKE search)
          //    Note: LIKE '%auth%' would also match 'authentication',
          //    so we verify exact array membership in the JS loop below.
          const entries = await s.getLedgerEntries({
            keywords: `cs.{${searchKw}}`,
            select: "id,keywords",
          }) as Array<{ id: string; keywords: unknown }>;

          let updated = 0;
          for (const entry of entries) {
            // Parse keywords — handle both SQLite (JSON string) and Supabase (array)
            let kws: string[] = [];
            if (Array.isArray(entry.keywords)) kws = entry.keywords as string[];
            else if (typeof entry.keywords === "string") {
              try { kws = JSON.parse(entry.keywords); } catch { continue; }
            }

            // Exact match check — guards against substring false positives
            if (!kws.includes(searchKw)) continue;

            // Remove the old keyword
            const newKws = kws.filter(k => k !== searchKw);

            // If renaming (not deleting), add the new keyword (no duplicates)
            if (newKw && !newKws.includes(newKw)) {
              newKws.push(newKw);
            }

            // 3. Patch the entry — patchLedger handles JSON serialization
            await s.patchLedger(entry.id, { keywords: newKws });
            updated++;
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ ok: true, updated }));
        } catch (err) {
          console.error("[Dashboard] Node edit error:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Edit failed" }));
        }
      }

      // ─── API: Hivemind Team Roster (v3.0) ───
      if (url.pathname === "/api/team") {
        const projectName = url.searchParams.get("project");
        if (!projectName) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Missing ?project= parameter" }));
        }
        try {
          const s = await getStorageSafe();
          if (!s) { res.writeHead(503, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "Storage initializing..." })); }
          const team = await s.listTeam(projectName, PRISM_USER_ID);
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ team }));
        } catch {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ team: [] }));
        }
      }

      // ─── API: Settings — GET (v3.0 Dashboard Settings) ───
      if (url.pathname === "/api/settings" && req.method === "GET") {
        try {
          const { getAllSettings } = await import("../storage/configStorage.js");
          const settings = await getAllSettings();
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ settings }));
        } catch {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ settings: {} }));
        }
      }

      // ─── API: Settings — POST (v3.0 Dashboard Settings) ───
      if (url.pathname === "/api/settings" && req.method === "POST") {
        try {
          const body = await readBody(req);
          const parsed = JSON.parse(body);
          if (parsed.key && parsed.value !== undefined) {
            const { setSetting } = await import("../storage/configStorage.js");
            await setSetting(parsed.key, String(parsed.value));
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: true, key: parsed.key, value: parsed.value }));
          }
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Missing key or value" }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Invalid JSON body" }));
        }

      }

      // ─── API: Memory Analytics (v3.1) ────────────────────
      if (url.pathname === "/api/analytics" && req.method === "GET") {
        const projectName = url.searchParams.get("project");
        if (!projectName) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Missing ?project= parameter" }));
        }
        try {
          const s = await getStorageSafe();
          if (!s) { res.writeHead(503, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "Storage initializing..." })); }
          const analytics = await s.getAnalytics(projectName, PRISM_USER_ID);
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify(analytics));
        } catch (err) {
          console.error("[Dashboard] Analytics error:", err);
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({
            totalEntries: 0, totalRollups: 0, rollupSavings: 0,
            avgSummaryLength: 0, sessionsByDay: [],
          }));
        }
      }

      // ─── API: Retention (TTL) Settings (v3.1) ──────────────
      // GET /api/retention?project= → current TTL setting
      // POST /api/retention → { project, ttl_days } → saves + runs sweep
      if (url.pathname === "/api/retention") {
        if (req.method === "GET") {
          const projectName = url.searchParams.get("project");
          if (!projectName) {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "Missing ?project= parameter" }));
          }
          const ttlRaw = await getSetting(`ttl:${projectName}`, "0");
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ project: projectName, ttl_days: parseInt(ttlRaw, 10) || 0 }));
        }

        if (req.method === "POST") {
          const body = await readBody(req);
          const { project, ttl_days } = JSON.parse(body || "{}");
          if (!project || ttl_days === undefined) {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "project and ttl_days required" }));
          }
          if (ttl_days > 0 && ttl_days < 7) {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "Minimum TTL is 7 days" }));
          }
          await setSetting(`ttl:${project}`, String(ttl_days));
          let expired = 0;
          if (ttl_days > 0) {
            const s = await getStorageSafe();
            if (!s) { res.writeHead(503, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "Storage initializing..." })); }
            const result = await s.expireByTTL(project, ttl_days, PRISM_USER_ID);
            expired = result.expired;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ ok: true, project, ttl_days, expired }));
        }
      }

      // ─── API: Compact Now (v3.1 — Dashboard button) ──────────
      if (url.pathname === "/api/compact" && req.method === "POST") {
        const body = await readBody(req);
        const { project } = JSON.parse(body || "{}");
        if (!project) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "project required" }));
        }
        try {
          const result = await compactLedgerHandler({ project });
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          console.error("[Dashboard] Compact error:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ ok: false, error: "Compaction failed" }));
        }
      }

      // ─── API: PKM Export — Obsidian/Logseq ZIP (v3.1) ──────
      if (url.pathname === "/api/export" && req.method === "GET") {
        const projectName = url.searchParams.get("project");
        if (!projectName) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Missing ?project= parameter" }));
        }
        try {
          // Lazy-import fflate to keep startup fast
          const { strToU8, zipSync } = await import("fflate");

          // Fetch all active ledger entries for this project
          const s = await getStorageSafe();
          if (!s) { res.writeHead(503, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "Storage initializing..." })); }
          const entries = await s.getLedgerEntries({
            project: `eq.${projectName}`,
            order: "created_at.asc",
            limit: "1000",
          }) as Array<Record<string, unknown>>;

          const files: Record<string, Uint8Array> = {};

          // One MD file per session
          for (const entry of entries) {
            const date = (entry.created_at as string | undefined)?.slice(0, 10) ?? "unknown";
            const id = (entry.id as string | undefined)?.slice(0, 8) ?? "xxxxxxxx";
            const filename = `${projectName}/${date}-${id}.md`;

            const todos = Array.isArray(entry.todos) ? (entry.todos as string[]) : [];
            const decisions = Array.isArray(entry.decisions) ? (entry.decisions as string[]) : [];
            const files_changed = Array.isArray(entry.files_changed) ? (entry.files_changed as string[]) : [];
            const tags = ((Array.isArray(entry.keywords) ? entry.keywords : []) as string[]).slice(0, 10);

            const content = [
              `# Session: ${date}`,
              ``,
              `**Project:** ${projectName}`,
              `**Date:** ${date}`,
              `**Role:** ${(entry.role as string) || "global"}`,
              tags.length ? `**Tags:** ${tags.map(t => `#${t.replace(/\s+/g, "_")}`).join(" ")}` : "",
              ``,
              `## Summary`,
              ``,
              entry.summary as string,
              ``,
              todos.length ? `## TODOs\n\n${todos.map(t => `- [ ] ${t}`).join("\n")}` : "",
              decisions.length ? `## Decisions\n\n${decisions.map(d => `- ${d}`).join("\n")}` : "",
              files_changed.length ? `## Files Changed\n\n${files_changed.map(f => `- \`${f}\``).join("\n")}` : "",
            ].filter(Boolean).join("\n");

            files[filename] = strToU8(content);
          }

          // Index file linking all sessions
          const indexLines = [
            `# ${projectName} — Session Index`,
            ``,
            `> Exported from Prism MCP on ${new Date().toISOString().slice(0, 10)}`,
            ``,
            ...entries.map(e => {
              const d = (e.created_at as string | undefined)?.slice(0, 10) ?? "unknown";
              const i = (e.id as string | undefined)?.slice(0, 8) ?? "xxxxxxxx";
              return `- [[${projectName}/${d}-${i}]]`;
            }),
          ];
          files[`${projectName}/_index.md`] = strToU8(indexLines.join("\n"));

          const zipped = zipSync(files, { level: 6 });

          res.writeHead(200, {
            "Content-Type": "application/zip",
            "Content-Disposition": `attachment; filename="prism-export-${projectName}-${Date.now()}.zip"`,
            "Content-Length": String(zipped.byteLength),
          });
          return res.end(Buffer.from(zipped));
        } catch (err) {
          console.error("[Dashboard] PKM export error:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Export failed" }));
        }
      }

      // ─── API: Universal History Import (v5.2) ───
      if (url.pathname === "/api/import" && req.method === "POST") {
        try {
          const body = await new Promise<string>(resolve => {
            let data = ""; req.on("data", c => data += c); req.on("end", () => resolve(data));
          });
          const { path: filePath, format, project, dryRun } = JSON.parse(body || "{}");
          if (!filePath) {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "path is required" }));
          }

          // Verify file exists before starting import
          if (!fs.existsSync(filePath)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: `File not found: ${filePath}` }));
          }

          const { universalImporter } = await import("../utils/universalImporter.js");
          const result = await universalImporter({
            path: filePath,
            format: format || undefined,
            project: project || undefined,
            dryRun: !!dryRun,
            verbose: false,
          });

          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({
            ok: true,
            ...result,
            message: `Imported ${result.conversationCount} conversations (${result.successCount} turns)${result.skipCount > 0 ? `, ${result.skipCount} skipped (dup)` : ""}${result.failCount > 0 ? `, ${result.failCount} failed` : ""}${dryRun ? " [DRY RUN]" : ""}`,
          }));
        } catch (err: any) {
          console.error("[Dashboard] Import error:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: err.message || "Import failed" }));
        }
      }

      // ─── API: Universal History Import via File Upload (v5.2) ───
      if (url.pathname === "/api/import-upload" && req.method === "POST") {
        try {
          const body = await new Promise<string>(resolve => {
            let data = ""; req.on("data", c => data += c); req.on("end", () => resolve(data));
          });
          const { filename, content, format, project, dryRun } = JSON.parse(body || "{}");
          if (!content || !filename) {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "filename and content are required" }));
          }

          // Write uploaded content to a temp file
          const tmpDir = path.join(os.tmpdir(), "prism-import");
          fs.mkdirSync(tmpDir, { recursive: true });
          const tmpFile = path.join(tmpDir, `upload-${Date.now()}-${filename}`);
          fs.writeFileSync(tmpFile, content, "utf-8");

          try {
            const { universalImporter } = await import("../utils/universalImporter.js");
            const result = await universalImporter({
              path: tmpFile,
              format: format || undefined,
              project: project || undefined,
              dryRun: !!dryRun,
              verbose: false,
            });

            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({
              ok: true,
              ...result,
              message: `Imported ${result.conversationCount} conversations (${result.successCount} turns)${result.skipCount > 0 ? `, ${result.skipCount} skipped (dup)` : ""}${result.failCount > 0 ? `, ${result.failCount} failed` : ""}${dryRun ? " [DRY RUN]" : ""} from ${filename}`,
            }));
          } finally {
            // Clean up temp file
            try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
          }
        } catch (err: any) {
          console.error("[Dashboard] Import upload error:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: err.message || "Import failed" }));
        }
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

  // ─── Resilient port binding with retry ───
  // Wraps listen() in a Promise to detect EADDRINUSE failures and retry
  // with a delay (gives OS time to release the port after killPortHolder).
  // Falls back to PORT+1, PORT+2 if the preferred port is permanently taken.
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 500;

  const tryListen = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        httpServer.removeListener("error", onError);
        reject(err);
      };
      httpServer.on("error", onError);
      httpServer.listen(port, () => {
        httpServer.removeListener("error", onError);
        // Re-register a permanent error handler for runtime errors
        httpServer.on("error", (err: NodeJS.ErrnoException) => {
          console.error(`[Dashboard] HTTP server error: ${err.message}`);
        });
        resolve(port);
      });
    });

  let boundPort = PORT;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      boundPort = await tryListen(PORT + attempt);
      break; // Success
    } catch (err: any) {
      if (err.code === "EADDRINUSE") {
        console.error(
          `[Dashboard] Port ${PORT + attempt} is in use (attempt ${attempt + 1}/${MAX_RETRIES}).`
        );
        if (attempt < MAX_RETRIES - 1) {
          // Wait for OS to release the port, then try next port
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        } else {
          console.error(
            `[Dashboard] All ports ${PORT}–${PORT + MAX_RETRIES - 1} in use — Mind Palace disabled. ` +
            `Set PRISM_DASHBOARD_PORT to use a different port.`
          );
          return; // Give up — MCP server keeps running
        }
      } else {
        console.error(`[Dashboard] HTTP server error: ${err.message}`);
        return; // Non-retryable error
      }
    }
  }

  // Write the active port to a file for discoverability
  try {
    const portFile = path.join(os.homedir(), ".prism-mcp", "dashboard.port");
    fs.writeFileSync(portFile, String(boundPort), "utf8");
  } catch {
    // Non-fatal — just means the user has to know the port
  }

  console.error(`[Prism] 🧠 Mind Palace Dashboard → http://localhost:${boundPort}`);

  // ─── v3.1: TTL Sweep — runs at startup + every 12 hours ───────────
  async function runTtlSweep() {
    try {
      const allSettings = await getAllSettings();
      for (const [key, val] of Object.entries(allSettings)) {
        if (!key.startsWith("ttl:")) continue;
        const project = key.replace("ttl:", "");
        const ttlDays = parseInt(val, 10);
        if (!ttlDays || ttlDays <= 0) continue;
        const s = await getStorageSafe();
        if (!s) continue;
        const result = await s.expireByTTL(project, ttlDays, PRISM_USER_ID);
        if (result.expired > 0) {
          console.error(`[Dashboard] TTL sweep: expired ${result.expired} entries for "${project}" (ttl=${ttlDays}d)`);
        }
      }
    } catch (err) {
      console.error("[Dashboard] TTL sweep error (non-fatal):", err);
    }
  }

  // Run immediately on startup, then every 12 hours
  runTtlSweep().catch(() => {});
  setInterval(() => { runTtlSweep().catch(() => {}); }, 12 * 60 * 60 * 1000);
}

