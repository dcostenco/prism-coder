/**
 * GitHub Webhook Router
 *
 * Handles incoming GitHub webhook events and triggers knowledge ingestion.
 * Public endpoint — secured by HMAC-SHA256 signature verification.
 *
 * Setup:
 *   1. Set GITHUB_WEBHOOK_SECRET in your environment
 *   2. In GitHub repo → Settings → Webhooks → Add webhook:
 *      - Payload URL: https://your-prism.com/api/github/webhook
 *      - Content type: application/json
 *      - Secret: (same as GITHUB_WEBHOOK_SECRET)
 *      - Events: "Just the push event"
 *
 * Open interface — any git forge (GitLab, Gitea, etc.) can be adapted
 * by adding a new handler function following the same pattern.
 */

import { createHmac, timingSafeEqual } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import { handleGitHubWebhook } from "../tools/ingestHandler.js";
import { debugLog } from "../utils/logger.js";

const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";

// ─── Signature Verification ────────────────────────────────────

function verifySignature(payload: string, signature: string | undefined): boolean {
  if (!WEBHOOK_SECRET) {
    debugLog("[webhook] GITHUB_WEBHOOK_SECRET not set — accepting all requests (dev mode)");
    return true;
  }
  if (!signature) return false;

  const expected = "sha256=" + createHmac("sha256", WEBHOOK_SECRET)
    .update(payload)
    .digest("hex");

  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ─── Fetch File Content from GitHub API ─────────────────────────

async function fetchFileFromGitHub(
  repoFullName: string,
  filePath: string,
  ref: string,
): Promise<string | null> {
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github.v3.raw",
    "User-Agent": "prism-mcp-webhook",
  };
  if (GITHUB_TOKEN) {
    headers["Authorization"] = `Bearer ${GITHUB_TOKEN}`;
  }

  try {
    const url = `https://api.github.com/repos/${repoFullName}/contents/${filePath}?ref=${ref}`;
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// ─── Read Request Body ──────────────────────────────────────────

function readBody(req: IncomingMessage, maxBytes = 10_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("Payload too large"));
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ─── Main Router ────────────────────────────────────────────────

export async function handleWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {

  // ── GitHub Webhook ─────────────────────────────────────────
  if (pathname === "/api/github/webhook" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const signature = req.headers["x-hub-signature-256"] as string | undefined;

      if (!verifySignature(body, signature)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid signature" }));
        return true;
      }

      const event = req.headers["x-github-event"] as string || "unknown";
      const payload = JSON.parse(body);

      debugLog(`[webhook] GitHub event: ${event}, repo: ${payload.repository?.full_name}`);

      const result = await handleGitHubWebhook(event, payload, fetchFileFromGitHub);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debugLog(`[webhook] Error: ${msg}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, message: msg }));
    }
    return true;
  }

  // ── Generic Ingest API (open interface) ────────────────────
  if (pathname === "/api/v1/prism/ingest" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body);

      // Minimal auth: require API key or JWT in Authorization header
      const auth = req.headers["authorization"] || "";
      if (!auth && WEBHOOK_SECRET) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Authorization required" }));
        return true;
      }

      const { ingestKnowledge } = await import("../tools/ingestHandler.js");
      const result = await ingestKnowledge({
        project: payload.project || "default",
        content: payload.content,
        file_path: payload.file_path,
        source_label: payload.source_label,
        chunk_size: payload.chunk_size,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, message: msg }));
    }
    return true;
  }

  // ── Webhook Status ─────────────────────────────────────────
  if (pathname === "/api/github/webhook" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ready",
      secret_configured: !!WEBHOOK_SECRET,
      github_token_configured: !!GITHUB_TOKEN,
      setup_instructions: {
        step1: "Set GITHUB_WEBHOOK_SECRET environment variable",
        step2: "In GitHub: Settings → Webhooks → Add webhook",
        step3: "Payload URL: https://your-domain/api/github/webhook",
        step4: "Content type: application/json",
        step5: "Secret: (same as GITHUB_WEBHOOK_SECRET)",
        step6: "Events: Just the push event",
      },
    }));
    return true;
  }

  return false;
}
