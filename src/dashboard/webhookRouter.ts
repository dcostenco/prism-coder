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
const PRISM_INGEST_API_KEY = process.env.PRISM_INGEST_API_KEY || "";
const IS_PRODUCTION = process.env.NODE_ENV === "production";

// ─── Signature Verification ────────────────────────────────────

function verifySignature(payload: string, signature: string | undefined): boolean {
  if (!WEBHOOK_SECRET) {
    if (IS_PRODUCTION) {
      debugLog("[webhook] GITHUB_WEBHOOK_SECRET not set in production — rejecting");
      return false;
    }
    debugLog("[webhook] GITHUB_WEBHOOK_SECRET not set — accepting (dev mode only)");
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

// ─── Input Validation ──────────────────────────────────────────

const REPO_NAME_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;
const SAFE_PATH_RE = /^[a-zA-Z0-9._\-\/]+$/;

function validateRepoName(name: string): boolean {
  return REPO_NAME_RE.test(name) && !name.includes("..");
}

function validateFilePath(path: string): boolean {
  return SAFE_PATH_RE.test(path) && !path.includes("..") && !path.startsWith("/");
}

// ─── Ingest API Auth ───────────────────────────────────────────

function verifyIngestAuth(authHeader: string): boolean {
  if (!authHeader) return false;
  if (!PRISM_INGEST_API_KEY && !WEBHOOK_SECRET) {
    if (IS_PRODUCTION) return false;
    return true;
  }
  const expectedKey = PRISM_INGEST_API_KEY || WEBHOOK_SECRET;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (token.length !== expectedKey.length) return false;
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expectedKey));
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
  if (!validateRepoName(repoFullName)) {
    debugLog(`[webhook] Invalid repo name rejected: ${repoFullName}`);
    return null;
  }
  if (!validateFilePath(filePath)) {
    debugLog(`[webhook] Invalid file path rejected: ${filePath}`);
    return null;
  }

  const headers: Record<string, string> = {
    "Accept": "application/vnd.github.v3.raw",
    "User-Agent": "prism-mcp-webhook",
  };
  if (GITHUB_TOKEN) {
    headers["Authorization"] = `Bearer ${GITHUB_TOKEN}`;
  }

  try {
    const url = `https://api.github.com/repos/${encodeURIComponent(repoFullName.split("/")[0])}/${encodeURIComponent(repoFullName.split("/")[1])}/contents/${filePath.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
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

      if (!payload.repository?.full_name || !validateRepoName(payload.repository.full_name)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid repository name" }));
        return true;
      }

      debugLog(`[webhook] GitHub event: ${event}, repo: ${payload.repository.full_name}`);

      const result = await handleGitHubWebhook(event, payload, fetchFileFromGitHub);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debugLog(`[webhook] Error: ${msg}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, message: "Internal error" }));
    }
    return true;
  }

  // ── Generic Ingest API (open interface) ────────────────────
  if (pathname === "/api/v1/prism/ingest" && req.method === "POST") {
    try {
      const auth = req.headers["authorization"] || "";
      if (!verifyIngestAuth(auth)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid or missing API key" }));
        return true;
      }

      const body = await readBody(req);
      const payload = JSON.parse(body);

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
      res.end(JSON.stringify({ ok: false, message: "Internal error" }));
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
      ingest_key_configured: !!PRISM_INGEST_API_KEY,
    }));
    return true;
  }

  return false;
}
