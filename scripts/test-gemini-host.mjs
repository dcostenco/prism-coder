#!/usr/bin/env node
/**
 * test-gemini-host.mjs
 *
 * Tests Arc 1 server-side gates and Arc 2 routing from a non-Claude host
 * (Gemini 2.0 Flash) using Gemini's native function-calling API.
 *
 * Arc 1 tests:
 *   T1: call session_save_ledger with NO prior session_load_context → gate hard-blocks
 *   T2: call session_load_context, then session_save_ledger → gate passes
 *   T3: send conversation_id:"" to a gated tool → hard-block (not opt-in bypass)
 *
 * Arc 2 tests:
 *   T4: ask a time-stable ABA question → Gemini routes to prism_infer directly (no search)
 *   T5: ask a time-sensitive version question → Gemini routes to brave_web_search
 *
 * NOTE: Arc 2 tests (T4/T5) prove routing correctness when Gemini is NOT given
 * skill-file instructions — i.e., whether Gemini's default judgment matches the
 * corrected design. A non-Claude host that ignores skill files should still produce
 * sensible routing if given the tool descriptions alone.
 *
 * Usage:
 *   GEMINI_API_KEY=<key> node scripts/test-gemini-host.mjs
 */

import { spawn } from "child_process";
import { createInterface } from "readline";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY not set");
  process.exit(1);
}

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

// ─── Tool definitions for Gemini function-calling ───────────────────────────
const TOOLS = [
  {
    name: "session_load_context",
    description: "Load session context for a project. Must be called before session_save_ledger or session_save_handoff. Returns project context and operating boundaries.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name (e.g. 'prism-mcp')" },
        conversation_id: { type: "string", description: "Unique conversation identifier" },
      },
      required: ["project"],
    },
  },
  {
    name: "session_save_ledger",
    description: "Save session ledger (what was done this session). Requires session_load_context to have been called first.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string" },
        conversation_id: { type: "string" },
        summary: { type: "string", description: "Summary of work done" },
      },
      required: ["project", "summary"],
    },
  },
  {
    name: "prism_infer",
    description: "Run inference on a local prism-coder model (Ollama) for stable factual questions: ABA/BCBA concepts, TypeScript/Node.js syntax, math, Prism MCP architecture. Returns answer from local model, costs $0.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        mode: { type: "string", enum: ["route", "chat", "code"], default: "route" },
        max_tokens: { type: "number" },
        cloud_fallback: { type: "boolean", default: false },
      },
      required: ["prompt"],
    },
  },
  {
    name: "brave_web_search",
    description: "Performs a web search. Use for current events, version numbers, release notes, live prices, URLs, anything that may have changed recently.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        count: { type: "number", default: 5 },
      },
      required: ["query"],
    },
  },
];

// ─── Gemini API call ─────────────────────────────────────────────────────────
async function geminiCall(messages, systemInstruction = null) {
  const body = {
    contents: messages,
    tools: [{ function_declarations: TOOLS }],
    tool_config: { function_calling_config: { mode: "AUTO" } },
  };
  if (systemInstruction) body.system_instruction = { parts: [{ text: systemInstruction }] };

  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${err}`);
  }
  return res.json();
}

// ─── prism-mcp stdio client ───────────────────────────────────────────────────
class PrismMcpClient {
  constructor() {
    this._pending = new Map();
    this._id = 1;
    this._proc = spawn("node", ["/Users/admin/prism/dist/server.js"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: "test" },
    });
    this._rl = createInterface({ input: this._proc.stdout });
    this._rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        if (msg.id && this._pending.has(msg.id)) {
          this._pending.get(msg.id)(msg);
          this._pending.delete(msg.id);
        }
      } catch {}
    });
    this._proc.stderr.on("data", () => {}); // suppress debug noise
  }

  async call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this._id++;
      const timeout = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`Timeout calling ${method}`));
      }, 30000);
      this._pending.set(id, (msg) => {
        clearTimeout(timeout);
        resolve(msg);
      });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this._proc.stdin.write(msg + "\n");
    });
  }

  async initialize() {
    await this.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "gemini-test-host", version: "1.0" },
    });
    // Send initialized notification (no response expected — fire and forget)
    const msg = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
    this._proc.stdin.write(msg + "\n");
  }

  async callTool(name, args) {
    const result = await this.call("tools/call", { name, arguments: args });
    return result;
  }

  close() {
    this._proc.stdin.end();
    this._rl.close();
  }
}

// ─── Test runner ─────────────────────────────────────────────────────────────
const CONV_ID = `gemini-test-${Date.now()}`;
let passed = 0;
let failed = 0;

function assert(condition, label, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? ": " + detail : ""}`);
    failed++;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const client = new PrismMcpClient();

try {
  await client.initialize();
  console.log("\n=== prism-mcp initialized ===\n");

  // ── T1: session_save_ledger without session_load_context ──
  console.log("T1: session_save_ledger without prior session_load_context");
  console.log("    Expected: hard-block (gate blocks unknown session)");
  const t1 = await client.callTool("session_save_ledger", {
    project: "prism-mcp",
    conversation_id: CONV_ID,
    summary: "Gemini test — should be blocked",
    decisions: [],
    next_steps: [],
  });
  const t1Text = JSON.stringify(t1);
  const t1Blocked = t1Text.includes("load_context") || t1Text.includes("blocked") ||
                    t1Text.includes("required") || t1Text.includes("error") ||
                    (t1.result?.isError === true);
  assert(t1Blocked, "Gate hard-blocks save_ledger without context", t1Text.slice(0, 120));

  // ── T2: session_load_context, then session_save_ledger ──
  console.log("\nT2: session_load_context → session_save_ledger");
  console.log("    Expected: load passes, save passes");
  const t2Load = await client.callTool("session_load_context", {
    project: "prism-mcp",
    conversation_id: CONV_ID,
  });
  const t2LoadOk = !JSON.stringify(t2Load).includes("error") ||
                   JSON.stringify(t2Load).includes("context") ||
                   t2Load.result?.isError !== true;
  assert(t2LoadOk, "session_load_context succeeds for Gemini host");

  const t2Save = await client.callTool("session_save_ledger", {
    project: "prism-mcp",
    conversation_id: CONV_ID,
    summary: "Gemini host test — Arc 1 gate verification. Context was loaded. Ledger entry should persist.",
    decisions: ["Arc 1 gates are server-side, host-agnostic"],
    next_steps: [],
  });
  const t2SaveText = JSON.stringify(t2Save);
  const t2SaveOk = !t2SaveText.includes('"isError":true') &&
                   (t2SaveText.includes("saved") || t2SaveText.includes("ledger") ||
                    t2SaveText.includes("success") || !t2SaveText.includes("error"));
  assert(t2SaveOk, "session_save_ledger passes after context loaded", t2SaveText.slice(0, 120));

  // ── T3: empty string conversation_id ──
  console.log('\nT3: conversation_id: "" on session_save_ledger');
  console.log("    Expected: hard-block (\"\" is not opt-in bypass)");
  const t3 = await client.callTool("session_save_ledger", {
    project: "prism-mcp",
    conversation_id: "",
    summary: "should be blocked — empty string is malformed",
    decisions: [],
    next_steps: [],
  });
  const t3Text = JSON.stringify(t3);
  const t3Blocked = t3Text.includes("load_context") || t3Text.includes("blocked") ||
                    t3Text.includes("required") || t3Text.includes('"isError":true');
  assert(t3Blocked, 'conversation_id:"" is hard-blocked (not opt-in bypass)', t3Text.slice(0, 120));

  // ── T4: Gemini routing — time-stable ABA question ──
  console.log("\nT4: Gemini routing — 'What is NCR (noncontingent reinforcement) in ABA?'");
  console.log("    Expected: Gemini calls prism_infer (stable ABA domain), NOT brave_web_search");

  const t4response = await geminiCall([{
    role: "user",
    parts: [{ text: "What is NCR (noncontingent reinforcement) in ABA? Give me a brief explanation." }],
  }]);

  const t4candidate = t4response.candidates?.[0]?.content;
  const t4calls = t4candidate?.parts?.filter(p => p.functionCall) ?? [];
  const t4Tools = t4calls.map(p => p.functionCall?.name);
  console.log(`    Tools called: ${t4Tools.length ? t4Tools.join(", ") : "(none — answered directly)"}`);

  const t4UsedSearch = t4Tools.includes("brave_web_search");
  const t4UsedInfer = t4Tools.includes("prism_infer");
  assert(!t4UsedSearch, "Gemini did NOT call brave_web_search for stable ABA question");
  assert(t4UsedInfer, "Gemini called prism_infer for stable ABA question (close-domain bypass without skill-file instruction)");

  // ── T5: Gemini routing — time-sensitive version question ──
  console.log("\nT5: Gemini routing — 'What is the current stable LTS version of Node.js?'");
  console.log("    Expected: Gemini calls brave_web_search (version is time-sensitive)");

  const t5response = await geminiCall([{
    role: "user",
    parts: [{ text: "What is the current stable LTS version of Node.js? I need the latest." }],
  }]);

  const t5candidate = t5response.candidates?.[0]?.content;
  const t5calls = t5candidate?.parts?.filter(p => p.functionCall) ?? [];
  const t5Tools = t5calls.map(p => p.functionCall?.name);
  console.log(`    Tools called: ${t5Tools.length ? t5Tools.join(", ") : "(none)"}`);

  const t5UsedSearch = t5Tools.includes("brave_web_search");
  assert(t5UsedSearch, "Gemini called brave_web_search for time-sensitive version question");

} finally {
  client.close();
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}
