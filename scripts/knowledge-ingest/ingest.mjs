#!/usr/bin/env node
/**
 * Bulk ingest Q&A data into Synalux portal → Supabase → knowledge_search.
 * Works locally or in GitHub Actions (pass SYNALUX_API_KEY env var).
 *
 * Usage:
 *   node ingest_via_api.mjs                         # ingest all Q&A files
 *   node ingest_via_api.mjs --dir /path/to/qa       # custom Q&A dir
 *   SYNALUX_API_KEY=sk_... node ingest_via_api.mjs  # in CI
 */
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, basename } from "path";

const BASE_URL = process.env.SYNALUX_BASE_URL || "https://synalux.ai";
const QA_DIR = process.argv.includes("--dir")
  ? process.argv[process.argv.indexOf("--dir") + 1]
  : "/tmp/training_qa";
const PROJECT = "synalux-codebase";
const BATCH_SIZE = 30;

function getApiKey() {
  if (process.env.SYNALUX_API_KEY) return process.env.SYNALUX_API_KEY;
  const envPath = join(process.env.HOME || "", "prism/.env");
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, "utf-8").match(/PRISM_SYNALUX_API_KEY=(\S+)/);
    if (m) return m[1];
  }
  throw new Error("No SYNALUX_API_KEY found");
}

async function getJwt(apiKey) {
  const res = await fetch(`${BASE_URL}/api/v1/auth/jwt`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`JWT auth failed: ${res.status}`);
  const data = await res.json();
  return data.jwt;
}

function parseQA(text) {
  const uParts = text.split("<|im_start|>user\n");
  if (uParts.length < 2) return null;
  const q = uParts[1].split("<|im_end|>")[0].trim();
  const aParts = text.split("<|im_start|>assistant\n");
  if (aParts.length < 2) return null;
  const a = aParts[1].split("<|im_end|>")[0].trim();
  return { q, a };
}

async function saveLedger(jwt, summary) {
  const res = await fetch(`${BASE_URL}/api/v1/prism/memory`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${jwt}` },
    body: JSON.stringify({
      action: "save_ledger",
      project: PROJECT,
      summary: summary.slice(0, 3800),
      keywords: [],
      decisions: [],
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function ingestFile(jwt, filepath) {
  const source = basename(filepath, ".jsonl").replace("qa_", "");
  const rows = readFileSync(filepath, "utf-8").split("\n").filter(l => l.trim()).map(l => JSON.parse(l));
  const totalBatches = Math.ceil(rows.length / BATCH_SIZE);
  let inserted = 0, errors = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const pairs = rows.slice(i, i + BATCH_SIZE).map(r => parseQA(r.text || "")).filter(Boolean);
    if (!pairs.length) continue;
    const bn = Math.floor(i / BATCH_SIZE) + 1;
    const summary = `[${source} ${bn}/${totalBatches}]\n` +
      pairs.map(p => `Q: ${p.q.slice(0, 150)}\nA: ${p.a.slice(0, 300)}`).join("\n---\n");
    try {
      await saveLedger(jwt, summary);
      inserted += pairs.length;
    } catch (err) {
      errors++;
      if (errors <= 3) console.error(`  batch ${bn}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return { inserted, errors, source };
}

async function main() {
  const apiKey = getApiKey();
  console.log("Authenticating...");
  const jwt = await getJwt(apiKey);

  const files = readdirSync(QA_DIR).filter(f => f.startsWith("qa_") && f.endsWith(".jsonl")).sort().map(f => join(QA_DIR, f));
  console.log(`Ingesting ${files.length} files → ${BASE_URL} (project: ${PROJECT})`);

  let total = 0, totalErr = 0;
  for (const f of files) {
    const { inserted, errors, source } = await ingestFile(jwt, f);
    console.log(`  ${source}: +${inserted}${errors ? ` (${errors} errors)` : ""}`);
    total += inserted;
    totalErr += errors;
  }
  console.log(`\nDone: ${total} ingested, ${totalErr} errors`);
}

main().catch(err => { console.error(err); process.exit(1); });
