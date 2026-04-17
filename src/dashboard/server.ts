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

import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createServer, getAllPossibleTools } from "../server.js";
import { getStorage } from "../storage/index.js";
import { PRISM_USER_ID, SERVER_CONFIG } from "../config.js";
import { renderDashboardHTML } from "./ui.js";
import { computeIntentHealth } from "./intentHealth.js";
import { getAllSettings, setSetting, getSetting, getSettingSync } from "../storage/configStorage.js";
import { compactLedgerHandler } from "../tools/compactionHandler.js";
import { getLLMProvider } from "../utils/llm/factory.js";
import { buildVaultDirectory } from "../utils/vaultExporter.js";
import { redactSettings } from "../tools/commonHelpers.js";
import { handleGraphRoutes } from "./graphRouter.js";
import {
  safeCompare,
  generateToken,
  isAuthenticated,
  createRateLimiter,
  initJWKS,
  type AuthConfig,
  type PrismAuthenticatedRequest,
} from "./authUtils.js";


const PORT = parseInt(process.env.PRISM_DASHBOARD_PORT || "3000", 10);

/** Read HTTP request body as string (Buffer-based to avoid GC thrash on large imports) */
/** SECURITY: 10MB limit prevents memory exhaustion from oversized POST payloads. */
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy(new Error("Request body too large (>10MB)"));
        return reject(new Error("Request body too large"));
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export async function startDashboardServer(): Promise<void> {
  // Port 3000 conflicts are gracefully handled by server.ts catching EADDRINUSE
  // which will just disable the dashboard on secondary instances, keeping MCP alive.

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
  const AUTH_JWKS_URI = process.env.PRISM_JWKS_URI || process.env.AUTH_JWKS_URI || "";

  // Auth is enabled if basic auth is configured OR if JWKS is configured
  const AUTH_ENABLED = (AUTH_USER.length > 0 && AUTH_PASS.length > 0) || AUTH_JWKS_URI.length > 0;

  if (AUTH_JWKS_URI) {
    initJWKS(AUTH_JWKS_URI);
  }

  const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  const activeSessions = new Map<string, number>(); // token → expiry timestamp

  // Auth config object — injectable for testing via authUtils.ts
  const authConfig: AuthConfig = {
    authEnabled: AUTH_ENABLED,
    authUser: AUTH_USER,
    authPass: AUTH_PASS,
    activeSessions,
    jwtAudience: process.env.PRISM_JWT_AUDIENCE || undefined,
    jwtIssuer: process.env.PRISM_JWT_ISSUER || undefined,
  };

  // v6.5.1: Rate limiter for login endpoint — 5 attempts per 60 seconds per IP
  const loginRateLimiter = createRateLimiter({
    maxAttempts: 5,
    windowMs: 60 * 1000,
  });

  // Track active SSE transports for MCP
  const activeSSETransports = new Map<string, SSEServerTransport>();

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
    if (AUTH_USER) {
      console.error(`[Dashboard] 🔒 Basic auth enabled for user "${AUTH_USER}"`);
    }
    if (AUTH_JWKS_URI) {
      console.error(`[Dashboard] 🔑 JWKS auth enabled: ${AUTH_JWKS_URI}`);
      if (process.env.PRISM_JWT_AUDIENCE) {
        console.error(`[Dashboard]    Audience: ${process.env.PRISM_JWT_AUDIENCE}`);
      } else {
        console.error(`[Dashboard] ⚠️  No PRISM_JWT_AUDIENCE set — any valid JWT from this JWKS will be accepted.`);
      }
    }
    // Security advisory: HTTP Basic Auth transmits credentials in cleartext.
    // When auth is enabled for remote access, HTTPS (reverse proxy) is strongly recommended.
    console.error(
      `[Dashboard] ⚠️  WARNING: Dashboard uses HTTP (not HTTPS). ` +
      `Credentials are sent in cleartext. Use a reverse proxy (nginx/caddy) ` +
      `with TLS for remote access.`
    );
  }

  const httpServer = http.createServer(async (req, res) => {
    // v6.5.1: CORS — restrict origin when auth is enabled to prevent CSRF
    if (AUTH_ENABLED) {
      const origin = req.headers.origin || "";
      // SECURITY: Allowlist-based CORS — don't echo arbitrary origins with credentials
      const allowedOrigins = new Set([
        `http://localhost:${PORT}`,
        `http://127.0.0.1:${PORT}`,
        process.env.PRISM_DASHBOARD_ORIGIN || "",
      ].filter(Boolean));
      if (origin && allowedOrigins.has(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
      }
    } else {
      res.setHeader("Access-Control-Allow-Origin", "*");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    // SECURITY: Prevent clickjacking via X-Frame-Options and CSP
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    // ─── v5.1: Auth login endpoint (always accessible) ───
    const reqUrl = new URL(req.url || "/", `http://${req.headers.host}`);
    if (AUTH_ENABLED && reqUrl.pathname === "/api/auth/login" && req.method === "POST") {
      // v6.5.1: Rate limiting — prevent brute-force attacks
      const clientIP = (req.socket?.remoteAddress || "unknown").replace(/^::ffff:/, "");
      if (!loginRateLimiter.isAllowed(clientIP)) {
        res.writeHead(429, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Too many login attempts. Try again later." }));
      }

      const body = await readBody(req);
      try {
        const { user, pass } = JSON.parse(body);
        if (safeCompare(user || "", AUTH_USER) && safeCompare(pass || "", AUTH_PASS)) {
          const token = generateToken();
          activeSessions.set(token, Date.now() + SESSION_TTL_MS);
          // Reset rate limiter on successful login
          loginRateLimiter.reset(clientIP);
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

    // ─── v6.5.1: Logout endpoint — invalidates session server-side ───
    if (AUTH_ENABLED && reqUrl.pathname === "/api/auth/logout" && req.method === "POST") {
      // Extract and invalidate the session token from the cookie
      const cookies = req.headers.cookie || "";
      const match = cookies.match(/prism_session=([a-f0-9]{64})/);
      if (match) {
        activeSessions.delete(match[1]);
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        // Clear the cookie on the client side
        "Set-Cookie": `prism_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
      });
      return res.end(JSON.stringify({ ok: true }));
    }

    // ─── API: Smithery MCP Server Card (v7.4) ───
    // Smithery explicitly requests this file to skip slow stdio scanning.
    // MUST BE PLACED HERE (above Auth Gate) so it is a fully public manifest.
    if (reqUrl.pathname === "/.well-known/mcp/server-card.json" && req.method === "GET") {
      try {
        const tools = getAllPossibleTools();

        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=3600"
        });

        return res.end(JSON.stringify({
          $schema: "https://smithery.ai/schema/server-card.json",
          serverInfo: {
            name: SERVER_CONFIG.name,
            version: SERVER_CONFIG.version,
          },
          authentication: {
            required: AUTH_ENABLED
          },
          configSchema: {
            type: "object",
            required: [],
            properties: {
              braveApiKey: {
                type: "string",
                title: "Brave Search API Key",
                description: "API key for Brave Search (powers web search and research tools). Get one at https://brave.com/search/api/"
              },
              googleApiKey: {
                type: "string",
                title: "Google AI API Key",
                description: "API key for Google AI Studio / Gemini (powers synthesis, embeddings, paper analysis). Get one at https://aistudio.google.com/apikey"
              },
              storage: {
                type: "string",
                title: "Storage Backend",
                description: "Storage backend: 'local' (SQLite, zero-config) or 'supabase' (PostgreSQL, multi-device)",
                default: "local",
                enum: ["local", "supabase"]
              },
              supabaseUrl: {
                type: "string",
                title: "Supabase URL",
                description: "Your Supabase project URL (required if storage is 'supabase')"
              },
              supabaseServiceKey: {
                type: "string",
                title: "Supabase Service Key",
                description: "Your Supabase service role key (required if storage is 'supabase')"
              },
              firecrawlApiKey: {
                type: "string",
                title: "Firecrawl API Key",
                description: "Optional: API key for Firecrawl (enables Web Scholar pipeline). Get one at https://www.firecrawl.dev/"
              },
              braveAnswersApiKey: {
                type: "string",
                title: "Brave Answers API Key",
                description: "Optional: Separate key for AI-grounded answers (brave_answers tool)"
              },
              prismEnableHivemind: {
                type: "boolean",
                title: "Enable Multi-Agent Hivemind",
                description: "Set to true to enable multi-agent coordination tools.",
                default: false
              },
              prismDarkFactoryEnabled: {
                type: "boolean",
                title: "Enable Dark Factory",
                description: "Set to true to enable autonomous evaluation pipelines.",
                default: false
              },
              prismTaskRouterEnabled: {
                type: "boolean",
                title: "Enable Task Router",
                description: "Set to true to allow Prism to route tasks to local Ollama agents.",
                default: false
              }
            }
          },
          tools: tools.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema
          })),
          prompts: [],
          resources: []
        }));
      } catch (err: any) {
        console.error("[Dashboard] Error generating server card:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: err.message || "Failed to generate server card" }));
      }
    }

    // ─── AUTHENTICATION GATE ───
    // Basic Auth & Session & JWKS
    if (AUTH_ENABLED && !(await isAuthenticated(req, authConfig))) {
      // If it's an API request, return 401 JSON
      if (reqUrl.pathname.startsWith('/api/') || reqUrl.pathname === "/sse" || reqUrl.pathname === "/messages") {
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Authentication required" }));
      }
      // For page requests, show login page
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(renderLoginPage());
    }

    // ─── AUDIT LOGGING (JWKS / AgentLair) ───
    const authReq = req as PrismAuthenticatedRequest;
    // Log successful agent access (identified via JWKS JWT)
    if (authReq.agent_id && reqUrl.pathname !== "/api/scheduler") {
      let auditLog = `[Dashboard] 🚦 Access: ${req.method} ${reqUrl.pathname} by agent ${authReq.agent_id}`;
      if (authReq.al_name) auditLog += ` (${authReq.al_name})`;
      if (authReq.al_audit_url) auditLog += ` - Audit: ${authReq.al_audit_url}`;
      console.error(auditLog);
    }

    try {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);

      // ─── SSE: MCP Transport Endpoint ───
      if (url.pathname === "/sse" && req.method === "GET") {
        const transport = new SSEServerTransport("/messages", res);
        await transport.start();
        activeSSETransports.set(transport.sessionId, transport);

        transport.onclose = () => {
          activeSSETransports.delete(transport.sessionId);
        };

        try {
          const mcpServer = createServer();
          await mcpServer.connect(transport);
        } catch (err) {
          console.error("[Dashboard] SSE Connection failed:", err);
          activeSSETransports.delete(transport.sessionId);
        }

        return; // SSEServerTransport handles keeping the response open
      }

      // ─── SSE: MCP Message Receiver ───
      if (url.pathname === "/messages" && req.method === "POST") {
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          return res.end("Missing sessionId");
        }
        const transport = activeSSETransports.get(sessionId);
        if (!transport) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          return res.end("Session not found");
        }
        await transport.handlePostMessage(req, res);
        return;
      }


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
      // Deletes orphaned handoffs and backfills missing embeddings.
      if (url.pathname === "/api/health/cleanup" && req.method === "POST") {
        try {
          const { runHealthCheck } = await import("../utils/healthCheck.js");
          const s = await getStorageSafe();
          if (!s) { res.writeHead(503, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "Storage initializing..." })); }
          const stats = await s.getHealthStats(PRISM_USER_ID);
          const report = runHealthCheck(stats);

          let repairedCount = 0;
          let failedCount = 0;
          let cleanupMessages: string[] = [];

          // 1. Backfill embeddings if missing
          const embeddingIssue = report.issues.find(i => i.check === "missing_embeddings");
          if (embeddingIssue && embeddingIssue.count > 0) {
            try {
              const { backfillEmbeddingsHandler } = await import("../tools/hygieneHandlers.js");
              let hasMore = true;
              let cursorId: string | undefined = undefined;
              let iterations = 0;
              const MAX_ITERATIONS = 100; // safety cap: 100 × 50 = 5000 entries max

              while (hasMore && iterations < MAX_ITERATIONS) {
                iterations++;
                const result: any = await backfillEmbeddingsHandler({ dry_run: false, limit: 50, _cursor_id: cursorId });
                const bStats = result._stats;
                if (bStats) {
                  repairedCount += bStats.repaired;
                  failedCount += bStats.failed;
                  if (bStats.last_id) cursorId = bStats.last_id;
                  else hasMore = false;
                  if ((bStats.repaired + bStats.failed) < 50) hasMore = false;
                } else {
                  hasMore = false;
                }
              }
              cleanupMessages.push(`Repaired ${repairedCount} embeddings`);
              if (failedCount > 0) cleanupMessages.push(`Failed to repair ${failedCount} embeddings`);
            } catch (err) {
              console.error("[Dashboard] Failed to backfill embeddings:", err);
              cleanupMessages.push("Embedding backfill failed");
            }
          }

          // 2. Collect orphaned handoff projects from the health issues
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
          if (cleaned.length > 0) cleanupMessages.push(`Cleaned ${cleaned.length} orphaned handoffs`);

          const message = cleanupMessages.length > 0
            ? cleanupMessages.join(", ")
            : "No issues to clean up.";

          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({
            ok: true,
            cleaned,
            repairedCount,
            count: cleaned.length + repairedCount,
            message,
          }));
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : "Cleanup failed";
          console.error("[Dashboard] Health cleanup error:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ ok: false, error: errMsg, message: errMsg }));
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
        const body = await readBody(req);
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

      // ─── API: Knowledge Graph (v6.2 — extracted to graphRouter.ts) ───
      if (url.pathname.startsWith("/api/graph")) {
        if (await handleGraphRoutes(url, req, res, getStorageSafe)) return;
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
            // SECURITY: Allowlist of dashboard-settable keys to prevent
            // credential overwrite (SUPABASE_KEY, STRIPE_SECRET_KEY, etc.)
            const SETTABLE_KEYS = new Set([
              "PRISM_STORAGE", "SUPABASE_URL", "SUPABASE_KEY",
              "BRAVE_API_KEY", "BRAVE_ANSWERS_API_KEY",
              "GOOGLE_API_KEY", "VOYAGE_API_KEY",
              "FIRECRAWL_API_KEY", "TAVILY_API_KEY",
              "embedding_provider", "embedding_model",
              "PRISM_ENABLE_HIVEMIND", "PRISM_DARK_FACTORY_ENABLED",
              "PRISM_TASK_ROUTER_ENABLED", "PRISM_SCHOLAR_ENABLED",
              "PRISM_HDC_ENABLED", "PRISM_ACTR_ENABLED",
              "PRISM_GRAPH_PRUNING_ENABLED",
            ]);
            const isSkillKey = parsed.key.startsWith("skill:");
            const isTTLKey = parsed.key.startsWith("ttl:");
            const isAutoloadKey = parsed.key.startsWith("autoload:");
            if (!SETTABLE_KEYS.has(parsed.key) && !isSkillKey && !isTTLKey && !isAutoloadKey) {
              res.writeHead(403, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ error: `Setting key "${parsed.key}" is not allowed via the dashboard.` }));
            }
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
      // ─── API: PKM Export (v6.1 — Prism-Port Vault) ──────────────
      // /api/export?project=<name>         — legacy URL (keeps old links working)
      // /api/export/vault?project=<name>  — canonical vault URL
      //
      // Both routes produce the same Prism-Port vault ZIP:
      //   - YAML frontmatter + Wikilinks (Obsidian/Logseq compatible)
      //   - Keyword backlink index (Keywords/<slug>.md)
      //   - Visual memory index (Visual_Memory/Index.md)
      //   - Settings/handoff metadata (Settings.md)
      //   - One file per ledger entry (Ledger/<date>_<slug>.md)
      if (
        (url.pathname === "/api/export" || url.pathname === "/api/export/vault") &&
        req.method === "GET"
      ) {
        const projectName = url.searchParams.get("project");
        if (!projectName) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Missing ?project= parameter" }));
        }
        try {
          const s = await getStorageSafe();
          if (!s) {
            res.writeHead(503, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "Storage initializing..." }));
          }

          // Gather data (mirrors sessionExportMemoryHandler)
          const ctx = await s.loadContext(projectName, "deep", PRISM_USER_ID) as Record<string, unknown> | null;
          const rawLedger = await s.getLedgerEntries({
            project: `eq.${projectName}`,
            order: "created_at.asc",
            limit: "1000",
          }) as Array<Record<string, unknown>>;

          // Strip binary embedding fields
          const cleanLedger = rawLedger.map(({ embedding: _e, embedding_compressed: _ec, ...rest }) => rest);

          const rawSettings = await getAllSettings();
          const safeSettings = redactSettings(rawSettings);
          const visualMemory = (ctx?.metadata as Record<string, unknown> | undefined)?.visual_memory as unknown[] ?? [];

          const exportPayload = {
            prism_export: {
              version: "6.1",
              exported_at: new Date().toISOString(),
              project: projectName,
              settings: safeSettings,
              handoff: ctx ?? null,
              visual_memory: visualMemory,
              ledger: cleanLedger,
            },
          };

          // Build vault directory and ZIP
          const { zipSync } = await import("fflate");
          const vaultFiles = buildVaultDirectory(exportPayload);
          const zipped = zipSync(vaultFiles, { level: 6 });

          res.writeHead(200, {
            "Content-Type": "application/zip",
            "Content-Disposition": `attachment; filename="prism-vault-${projectName}-${new Date().toISOString().slice(0, 10)}.zip"`,
            "Content-Length": String(zipped.byteLength),
          });
          return res.end(Buffer.from(zipped));
        } catch (err) {
          console.error("[Dashboard] Vault export error:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Export failed" }));
        }
      }


      // ─── API: Universal History Import (v5.2) ───
      // NOTE: Transactional safety (BEGIN/COMMIT/ROLLBACK) is handled inside
      // universalImporter — each conversation is inserted atomically.
      // The dashboard handler provides HTTP-level error handling only.
      if (url.pathname === "/api/import" && req.method === "POST") {
        try {
          const body = await readBody(req);
          const { path: filePath, format, project, dryRun } = JSON.parse(body || "{}");
          if (!filePath) {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "path is required" }));
          }

          // SECURITY: Restrict import paths to prevent arbitrary file reads.
          // Only allow files from home directory, /tmp, and current working directory.
          const resolvedPath = path.resolve(filePath);
          const homeDir = os.homedir();
          const allowedPrefixes = [homeDir, os.tmpdir(), process.cwd()];
          const isAllowed = allowedPrefixes.some(prefix => resolvedPath.startsWith(prefix + path.sep) || resolvedPath === prefix);
          if (!isAllowed) {
            res.writeHead(403, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: `Import path must be under home directory or /tmp` }));
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
          const body = await readBody(req);
          const { filename, content, format, project, dryRun } = JSON.parse(body || "{}");
          if (!content || !filename) {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "filename and content are required" }));
          }

          // Write uploaded content to a temp file
          const tmpDir = path.join(os.tmpdir(), "prism-import");
          fs.mkdirSync(tmpDir, { recursive: true });
          const safeFilename = path.basename(filename); // prevent path traversal
          const tmpFile = path.join(tmpDir, `upload-${Date.now()}-${safeFilename}`);
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

      // ─── API: Background Scheduler Status (v5.4) ────────────
      if (url.pathname === "/api/scheduler" && req.method === "GET") {
        try {
          const { getSchedulerStatus } = await import("../backgroundScheduler.js");
          const status = getSchedulerStatus();
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify(status));
        } catch (err) {
          console.error("[Dashboard] Scheduler status error:", err);
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({
            running: false, startedAt: null, intervalMs: 0, lastSweep: null,
          }));
        }
      }

      // ─── API: Autonomous Web Scholar Trigger (v5.4) ─────────
      if (url.pathname === "/api/scholar/trigger" && req.method === "POST") {
        try {
          const { runWebScholar } = await import("../scholar/webScholar.js");

          // Fire and forget, don't block the request
          runWebScholar().catch(err => {
            console.error("[Dashboard] Web Scholar async trigger failed:", err);
          });

          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ ok: true, message: "Autonomous research started in background" }));
        } catch (err: any) {
          console.error("[Dashboard] Web Scholar trigger error:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: err.message || "Failed to trigger Web Scholar" }));
        }
      }

      // ─── API: Semantic Vector Search (v6.0) ───
      if (url.pathname === "/api/search" && req.method === "GET") {
        try {
          const q = url.searchParams.get("q");
          if (!q) {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "Missing ?q= parameter" }));
          }

          const project = url.searchParams.get("project") || null;
          const limit = Number(url.searchParams.get("limit")) || 10;
          const offset = Number(url.searchParams.get("offset")) || 0;
          const similarityThreshold = parseFloat(url.searchParams.get("threshold") || "0.6");
          const contextBoost = url.searchParams.get("boost") === "true";

          const s = await getStorageSafe();
          if (!s) {
            res.writeHead(503, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "Storage initializing..." }));
          }

          let queryText: string = q as string;
          if (contextBoost && project) {
            const context = await s!.loadContext(project as string, "quick", PRISM_USER_ID);
            if (context) queryText = `${project} scope: ${JSON.stringify(context)}\nQuery: ${q}`;
          }

          // Check LLM provider availability before attempting embedding
          let llm;
          try {
            llm = getLLMProvider();
          } catch {
            res.writeHead(503, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "LLM Provider not configured for semantic search. Configure an embedding provider in the Mind Palace dashboard." }));
          }

          const queryEmbedding = await llm.generateEmbedding(queryText);

          // We query limit + offset, then slice manually since the storage
          // layer interface limit parameter doesn't natively expose offset.
          const results = await s!.searchMemory({
            queryEmbedding: JSON.stringify(queryEmbedding),
            project: project || undefined,
            limit: limit + offset,
            similarityThreshold,
            userId: PRISM_USER_ID,
          });

          // Slice to emulate offset for pagination
          const paginated = results.slice(offset, offset + limit);

          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ query: q, project, results: paginated }));
        } catch (err: any) {
          console.error("[Dashboard] Search error:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: err.message || "Failed to search memory" }));
        }
      }


      // ─── API: Dark Factory Pipelines (v7.3) ───────────────────

      // GET /api/pipelines — List pipelines (optional ?status=RUNNING&project=myproj)
      if (url.pathname === "/api/pipelines" && req.method === "GET") {
        try {
          const s = await getStorageSafe();
          if (!s) {
            res.writeHead(503, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "Storage initializing..." }));
          }

          // Validate status filter against canonical set
          var rawStatus = url.searchParams.get("status") || undefined;
          var VALID_STATUSES = ['PENDING', 'RUNNING', 'PAUSED', 'ABORTED', 'COMPLETED', 'FAILED'];
          if (rawStatus && VALID_STATUSES.indexOf(rawStatus) === -1) {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: 'Invalid status filter: "' + rawStatus + '". Valid: ' + VALID_STATUSES.join(', ') }));
          }
          var statusFilter = rawStatus as import("../storage/interface.js").PipelineState["status"] | undefined;
          const projectFilter = url.searchParams.get("project") || undefined;

          const pipelines = await s.listPipelines(projectFilter, statusFilter, PRISM_USER_ID);

          // Parse spec JSON for frontend consumption
          const enriched = pipelines.map((p: any) => {
            let parsedSpec = null;
            try { parsedSpec = JSON.parse(p.spec); } catch { /* corrupt spec */ }
            return { ...p, parsedSpec };
          });

          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ pipelines: enriched }));
        } catch (err) {
          console.error("[Dashboard] Pipeline list error:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Failed to list pipelines" }));
        }
      }

      // GET /api/pipelines/:id — Single pipeline detail
      if (url.pathname.startsWith("/api/pipelines/") && !url.pathname.includes("/abort") && req.method === "GET") {
        try {
          const pipelineId = url.pathname.replace("/api/pipelines/", "");
          if (!pipelineId) {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "Missing pipeline ID" }));
          }

          const s = await getStorageSafe();
          if (!s) {
            res.writeHead(503, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "Storage initializing..." }));
          }

          const pipeline = await s.getPipeline(pipelineId, PRISM_USER_ID);
          if (!pipeline) {
            res.writeHead(404, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "Pipeline not found" }));
          }

          let parsedSpec = null;
          try { parsedSpec = JSON.parse(pipeline.spec); } catch { /* corrupt spec */ }

          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ ...pipeline, parsedSpec }));
        } catch (err) {
          console.error("[Dashboard] Pipeline detail error:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Failed to get pipeline" }));
        }
      }

      // POST /api/pipelines/:id/abort — Dashboard kill switch
      if (url.pathname.match(/^\/api\/pipelines\/[^/]+\/abort$/) && req.method === "POST") {
        try {
          const pipelineId = url.pathname.replace("/api/pipelines/", "").replace("/abort", "");

          const s = await getStorageSafe();
          if (!s) {
            res.writeHead(503, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "Storage initializing..." }));
          }

          const pipeline = await s.getPipeline(pipelineId, PRISM_USER_ID);
          if (!pipeline) {
            res.writeHead(404, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "Pipeline not found" }));
          }

          // Already terminated?
          if (["COMPLETED", "FAILED", "ABORTED"].includes(pipeline.status)) {
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: true, status: pipeline.status, message: `Pipeline already in terminal state: ${pipeline.status}` }));
          }

          await s.savePipeline({
            ...pipeline,
            status: "ABORTED",
            error: "Manually aborted via dashboard kill switch.",
          });

          console.error(`[Dashboard] Pipeline ${pipelineId} aborted via dashboard.`);

          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ ok: true, status: "ABORTED", message: "Pipeline aborted. Runner will stop on next tick." }));
        } catch (err) {
          console.error("[Dashboard] Pipeline abort error:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Failed to abort pipeline" }));
        }
      }


      if (url.pathname === "/manifest.json" && req.method === "GET") {
        const manifest = {
          name: "Prism Mind Palace",
          short_name: "Prism",
          description: "Prism MCP Mobile Dashboard",
          start_url: "/",
          display: "standalone",
          background_color: "#0a0e1a",
          theme_color: "#0a0e1a",
          icons: [
            { src: "/icon-192.svg", sizes: "192x192", type: "image/svg+xml", purpose: "any" },
            { src: "/icon-192-maskable.svg", sizes: "192x192", type: "image/svg+xml", purpose: "maskable" },
            { src: "/icon-512.svg", sizes: "512x512", type: "image/svg+xml", purpose: "any" },
            { src: "/icon-512-maskable.svg", sizes: "512x512", type: "image/svg+xml", purpose: "maskable" }
          ]
        };
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=86400"
        });
        return res.end(JSON.stringify(manifest));
      }

      // ─── PWA: Service Worker (v5.4) ───
      if (url.pathname === "/sw.js" && req.method === "GET") {
        const swContent = `
const CACHE_NAME = 'prism-pwa-v2.1';
const ASSETS = [
  '/',
  '/manifest.json',
  '/icon-192.svg',
  '/icon-192-maskable.svg',
  '/icon-512.svg',
  '/icon-512-maskable.svg',
  '/apple-touch-icon.png',
  '/offline.html'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => {
    return Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
  }));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // Serve offline page for HTML navigation
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/offline.html')));
    return;
  }
  // Network-first for API requests, Cache-first for Assets
  if (e.request.url.includes('/api/')) {
    e.respondWith(fetch(e.request).catch(() => new Response(JSON.stringify({ error: "Offline" }), { headers: { "Content-Type": "application/json" }, status: 503 })));
  } else {
    e.respondWith(caches.match(e.request).then((res) => res || fetch(e.request).then((fres) => {
      // Cache dynamically fetched non-API assets
      return caches.open(CACHE_NAME).then(c => { c.put(e.request, fres.clone()); return fres; });
    }).catch(() => null)));
  }
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.action === 'skipWaiting') {
    self.skipWaiting();
  }
});
        `.trim();
        res.writeHead(200, {
          "Content-Type": "application/javascript",
          "Cache-Control": "no-cache"
        });
        return res.end(swContent);
      }

      // ─── PWA: Offline Fallback HTML (v5.4) ───
      if (url.pathname === "/offline.html" && req.method === "GET") {
        const offlineHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Prism MCP — Offline</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#0a0e1a">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0a0e1a;
      color: #f1f5f9;
      font-family: 'Inter', sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 2rem;
    }
    .bg {
      position: fixed;
      inset: 0;
      background-image:
        radial-gradient(circle at 20% 30%, rgba(139, 92, 246, 0.08) 0%, transparent 50%),
        radial-gradient(circle at 80% 70%, rgba(59, 130, 246, 0.06) 0%, transparent 50%);
      z-index: 0;
    }
    .card {
      position: relative;
      z-index: 1;
      background: rgba(17, 24, 39, 0.6);
      backdrop-filter: blur(16px);
      border: 1px solid rgba(139, 92, 246, 0.15);
      border-radius: 16px;
      padding: 3rem 2rem;
      max-width: 400px;
      width: 100%;
    }
    .icon {
      font-size: 3rem;
      margin-bottom: 1.5rem;
      opacity: 0.8;
      filter: drop-shadow(0 0 10px rgba(139, 92, 246, 0.5));
    }
    h1 {
      font-size: 1.5rem;
      font-weight: 600;
      margin-bottom: 1rem;
      background: linear-gradient(135deg, #8b5cf6, #3b82f6);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    p {
      color: #94a3b8;
      font-size: 0.95rem;
      line-height: 1.5;
      margin-bottom: 2rem;
    }
    button {
      background: linear-gradient(135deg, #8b5cf6, #3b82f6);
      color: white;
      border: none;
      padding: 0.75rem 1.5rem;
      border-radius: 8px;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      font-family: 'Inter', sans-serif;
      transition: opacity 0.2s;
    }
    button:hover { opacity: 0.9; }
  </style>
</head>
<body>
  <div class="bg"></div>
  <div class="card">
    <div class="icon">🔌</div>
    <h1>You are currently offline.</h1>
    <p>The Prism Dashboard cannot reach the MCP server. Please check your internet connection to resume.</p>
    <button onclick="window.location.reload()">Try Again</button>
  </div>
</body>
</html>`;
        res.writeHead(200, {
          "Content-Type": "text/html",
          "Cache-Control": "public, max-age=86400"
        });
        return res.end(offlineHtml);
      }

      // ─── PWA: Dynamic SVG Icons (v5.4) ───
      if ((url.pathname === "/icon-192.svg" || url.pathname === "/icon-512.svg" || url.pathname === "/icon-192-maskable.svg" || url.pathname === "/icon-512-maskable.svg") && req.method === "GET") {
        const size = url.pathname.includes("192") ? 192 : 512;
        const isMaskable = url.pathname.includes("maskable");
        // For standard "any" icons, we might want rounded corners or a specific size ratio if needed,
        // but since we separate purposes, we can keep the SVG identical as adaptive scaling is handled by OS
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#8b5cf6" />
      <stop offset="50%" stop-color="#3b82f6" />
      <stop offset="100%" stop-color="#06b6d4" />
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${isMaskable ? 0 : Math.floor(size * 0.2)}" fill="#0a0e1a"/>
  <path d="M${size * 0.5} ${size * 0.25} L${size * 0.75} ${size * 0.75} L${size * 0.25} ${size * 0.75} Z" fill="url(#grad)" opacity="0.9"/>
  <circle cx="${size * 0.5}" cy="${size * 0.55}" r="${size * 0.15}" fill="#ffffff" opacity="0.1" />
</svg>`;
        res.writeHead(200, {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "public, max-age=86400"
        });
        return res.end(svg);
      }

      // ─── PWA: iOS Apple Touch Icon (v5.5) ───
      if (url.pathname === "/apple-touch-icon.png" && req.method === "GET") {
        // iOS Safari does not support SVG for apple-touch-icon; requires PNG.
        // We serve a robust Base64-encoded 180x180 opaque PNG to prevent the "black box" issue.
        const pngBase64 = "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";
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400"
        });
        return res.end(Buffer.from(pngBase64, "base64"));
      }

      // ─── API: Intent Health (Feature A) ───
      // GET /api/intent-health?project=xxx
      if (url.pathname === "/api/intent-health" && req.method === "GET") {
        const project = url.searchParams.get("project");
        if (!project) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "project is required" }));
        }

        try {
          const storage = await getStorageSafe();
          if (!storage) {
            res.writeHead(503, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "Storage initializing..." }));
          }
          // Load 'standard' context to get active_decisions and recent_sessions
          // Note: API MUST use "standard" level (deep skips recent_sessions, which breaks staleness).
          const ctx = await storage.loadContext(project, "standard", PRISM_USER_ID) as any;

          if (!ctx) {
            res.writeHead(404, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "Project not found" }));
          }

          // 1. Fetch configurable threshold (default 30 days, avoiding 7-day panic)
          const staleThresholdDays = parseInt(getSettingSync("intent_health_stale_threshold_days", "30"), 10) || 30;

          const healthResult = computeIntentHealth(ctx, staleThresholdDays);

          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify(healthResult));
        } catch (err: any) {
          console.error("[intent-health] Error computing intent health:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Failed to compute intent health" }));
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
  // with a delay (gives OS time to release the port).
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
  // NOTE (v5.4): The Background Scheduler in server.ts now also handles
  // TTL sweeps. This dashboard sweep is kept as a legacy fallback for
  // deployments where the scheduler is disabled. Both are idempotent.
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

