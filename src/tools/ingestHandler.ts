/**
 * Knowledge Ingestion Handler
 *
 * Server-side pipeline that chunks source code, generates Q&A pairs
 * via Claude Haiku, and stores them in the knowledge graph.
 *
 * Entry points:
 *   1. MCP tool:     knowledge_ingest (AI agent says "learn this code")
 *   2. REST API:     POST /api/v1/prism/ingest (CLI, GitHub webhook, any client)
 *   3. GitHub hook:  POST /api/github/webhook (auto-triggered on push)
 *
 * The handler is storage-agnostic — works with SQLite (local) or Supabase (remote).
 */

import { readFileSync, existsSync } from "fs";
import { basename } from "path";
import { PRISM_USER_ID } from "../config.js";
import { getStorage } from "../storage/index.js";
import { sanitizeMemoryInput } from "./ledgerHandlers.js";
import { debugLog } from "../utils/logger.js";
import { randomUUID } from "crypto";

// ─── Types ──────────────────────────────────────────────────────

interface IngestArgs {
  project: string;
  content?: string;
  file_path?: string;
  source_label?: string;
  chunk_size?: number;
}

interface ChunkResult {
  chunks: string[];
  source: string;
  totalChars: number;
}

interface IngestResult {
  project: string;
  source: string;
  chunks_processed: number;
  entries_created: number;
  status: "complete" | "partial" | "failed";
  errors: string[];
}

// ─── Type Guard ─────────────────────────────────────────────────

export function isIngestArgs(args: unknown): args is IngestArgs {
  if (!args || typeof args !== "object") return false;
  const a = args as Record<string, unknown>;
  if (typeof a.project !== "string" || !a.project) return false;
  if (!a.content && !a.file_path) return false;
  return true;
}

// ─── Chunker ────────────────────────────────────────────────────

function chunkSource(content: string, chunkSize: number, source: string): ChunkResult {
  const lines = content.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;

  for (const line of lines) {
    if (currentLen + line.length > chunkSize && current.length > 0) {
      chunks.push(current.join("\n"));
      current = [];
      currentLen = 0;
    }
    current.push(line);
    currentLen += line.length + 1;
  }
  if (current.length > 0) {
    chunks.push(current.join("\n"));
  }

  return {
    chunks: chunks.filter(c => c.trim().length > 200),
    source,
    totalChars: content.length,
  };
}

// ─── Q&A Generator (Claude Haiku) ───────────────────────────────

async function generateQAPairs(chunk: string, source: string): Promise<Array<{ prompt: string; response: string }>> {
  const apiKey = process.env.ANTHROPIC_API_KEY ||
    (existsSync(`${process.env.HOME}/.anthropic_key`)
      ? readFileSync(`${process.env.HOME}/.anthropic_key`, "utf-8").trim()
      : null);

  if (!apiKey) {
    debugLog("[ingest] No ANTHROPIC_API_KEY — skipping Q&A generation, storing raw chunks");
    return [{ prompt: `What does this ${source} code do?`, response: chunk.slice(0, 500) }];
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2048,
        system: 'Generate 3 Q&A training pairs as JSON array: [{"prompt":"...","response":"..."}]. Focus on what the code does, how it works, and key patterns.',
        messages: [{ role: "user", content: `Source: ${source}\n\`\`\`\n${chunk.slice(0, 5000)}\n\`\`\`` }],
      }),
    });

    if (!res.ok) {
      debugLog(`[ingest] Claude API error: ${res.status}`);
      return [];
    }

    const data = await res.json() as { content: Array<{ text: string }> };
    const text = data.content?.[0]?.text || "";
    const match = text.match(/\[.*\]/s);
    if (match) {
      return JSON.parse(match[0]);
    }
  } catch (err) {
    debugLog(`[ingest] Q&A generation error: ${err}`);
  }
  return [];
}

// ─── Main Ingest Pipeline ───────────────────────────────────────

export async function ingestKnowledge(args: IngestArgs): Promise<IngestResult> {
  const {
    project,
    source_label,
    chunk_size = 4000,
  } = args;

  let content = args.content || "";
  if (args.file_path && existsSync(args.file_path)) {
    content = readFileSync(args.file_path, "utf-8");
  }

  if (!content || content.trim().length < 100) {
    return {
      project,
      source: source_label || "unknown",
      chunks_processed: 0,
      entries_created: 0,
      status: "failed",
      errors: ["Content too short or empty (min 100 chars)"],
    };
  }

  const source = source_label || (args.file_path ? basename(args.file_path, ".ts") : "inline");
  const { chunks } = chunkSource(content, chunk_size, source);

  debugLog(`[ingest] ${source}: ${chunks.length} chunks from ${content.length} chars`);

  const storage = await getStorage();
  const errors: string[] = [];
  let entriesCreated = 0;
  const BATCH_SIZE = 20;

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batchChunks = chunks.slice(i, i + BATCH_SIZE);
    const allPairs: Array<{ prompt: string; response: string }> = [];

    for (const chunk of batchChunks) {
      const pairs = await generateQAPairs(chunk, source);
      allPairs.push(...pairs);
    }

    if (allPairs.length === 0) continue;

    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(chunks.length / BATCH_SIZE);
    const summary = sanitizeMemoryInput(
      `[${source} ${batchNum}/${totalBatches}]\n` +
      allPairs.map(p => `Q: ${p.prompt.slice(0, 150)}\nA: ${p.response.slice(0, 300)}`).join("\n---\n")
    );

    try {
      await storage.saveLedger({
        id: randomUUID(),
        project,
        conversation_id: `ingest-${source}-${Date.now()}`,
        user_id: PRISM_USER_ID,
        summary: summary.slice(0, 4000),
        todos: [],
        files_changed: [],
        decisions: [],
        keywords: extractKeywords(`${source} ${allPairs.map(p => p.prompt).join(" ")}`),
        session_date: new Date().toISOString(),
      });
      entriesCreated++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Batch ${batchNum}: ${msg}`);
      debugLog(`[ingest] Save error: ${msg}`);
    }
  }

  const status = errors.length === 0 ? "complete"
    : entriesCreated > 0 ? "partial"
    : "failed";

  debugLog(`[ingest] ${source}: ${status} — ${entriesCreated} entries, ${errors.length} errors`);

  return {
    project,
    source,
    chunks_processed: chunks.length,
    entries_created: entriesCreated,
    status,
    errors,
  };
}

function extractKeywords(text: string, max = 10): string[] {
  const stop = new Set(["the","and","for","that","this","with","from","are","was","has",
    "have","will","not","but","can","you","your","what","how","does","when","where",
    "which","would","should","could","been","function","const","import","return",
    "export","type","string","number","true","false"]);
  const freq: Record<string, number> = {};
  for (const m of text.matchAll(/\b[a-zA-Z_][a-zA-Z0-9_]{2,}\b/g)) {
    const w = m[0].toLowerCase();
    if (!stop.has(w) && w.length > 2) freq[w] = (freq[w] || 0) + 1;
  }
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, max).map(e => e[0]);
}

// ─── MCP Tool Handler ───────────────────────────────────────────

export async function knowledgeIngestHandler(args: unknown) {
  if (!isIngestArgs(args)) {
    throw new Error("Invalid arguments for knowledge_ingest. Required: project + (content or file_path)");
  }

  const result = await ingestKnowledge(args as IngestArgs);

  const statusIcon = result.status === "complete" ? "✅"
    : result.status === "partial" ? "⚠️"
    : "❌";

  let text = `${statusIcon} Knowledge ingestion ${result.status} for "${result.project}"\n` +
    `Source: ${result.source}\n` +
    `Chunks: ${result.chunks_processed} processed\n` +
    `Entries: ${result.entries_created} created\n`;

  if (result.errors.length > 0) {
    text += `Errors: ${result.errors.slice(0, 3).join("; ")}`;
  }

  text += `\nSearch with: knowledge_search(project="${result.project}", query="...")`;

  return {
    content: [{ type: "text" as const, text }],
    isError: result.status === "failed",
  };
}

// ─── GitHub Webhook Handler (called from dashboard server) ──────

interface GitHubPushPayload {
  ref: string;
  repository: { full_name: string; name: string };
  commits: Array<{
    id: string;
    message: string;
    added: string[];
    modified: string[];
    removed: string[];
  }>;
  head_commit?: { message: string };
}

export async function handleGitHubWebhook(
  event: string,
  payload: GitHubPushPayload,
  fetchFileContent: (repo: string, path: string, ref: string) => Promise<string | null>,
): Promise<{ ok: boolean; message: string }> {
  if (event !== "push") {
    return { ok: true, message: `Ignored event: ${event}` };
  }

  const repo = payload.repository.name;
  const ref = payload.ref.replace("refs/heads/", "");
  const project = `${repo}`;

  const changedFiles = new Set<string>();
  for (const commit of payload.commits) {
    for (const f of [...commit.added, ...commit.modified]) {
      if (/\.(ts|tsx|py|swift|js|jsx|mjs|md|rs|go)$/.test(f)) {
        changedFiles.add(f);
      }
    }
  }

  if (changedFiles.size === 0) {
    return { ok: true, message: "No indexable files changed" };
  }

  if (changedFiles.size > 50) {
    return { ok: true, message: `Skipped: ${changedFiles.size} files (likely merge)` };
  }

  debugLog(`[webhook] ${repo}@${ref}: ${changedFiles.size} files to ingest`);

  let combinedContent = "";
  for (const file of changedFiles) {
    const content = await fetchFileContent(payload.repository.full_name, file, ref);
    if (content) {
      combinedContent += `// === ${file} ===\n${content}\n\n`;
    }
  }

  if (combinedContent.length < 200) {
    return { ok: true, message: "Changed content too small to index" };
  }

  // Fire-and-forget: ingest in background
  ingestKnowledge({
    project,
    content: combinedContent,
    source_label: `${repo}@${ref}`,
  }).then(result => {
    debugLog(`[webhook] Ingest complete: ${result.entries_created} entries for ${repo}`);
  }).catch(err => {
    debugLog(`[webhook] Ingest failed: ${err}`);
  });

  return {
    ok: true,
    message: `Ingesting ${changedFiles.size} files from ${repo}@${ref}`,
  };
}
