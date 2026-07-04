#!/usr/bin/env node
/**
 * prism-agent.mjs — Agentic ReAct loop: prism-coder 27B + Brave web search
 *
 * Wraps Ollama's tool-calling API so prism-coder can search the web before
 * generating code, instead of hallucinating library/API details.
 *
 * Usage:
 *   node scripts/prism-agent.mjs "your question"
 *   PRISM_MODEL=dcostenco/prism-coder:9b node scripts/prism-agent.mjs "..."
 *   node scripts/prism-agent.mjs --ceiling 9b "your question"
 *
 * ARCHITECTURAL BOUNDARY — CLI tools (shell_run, read_file, list_directory):
 *   These tools execute on the USER'S LOCAL MACHINE with the user's own
 *   filesystem access and shell permissions. They are safe here because the
 *   user opts in by running the CLI. They MUST NOT be ported to the portal
 *   tool set — on the portal, shell_run/read_file/list_directory would execute
 *   server-side with portal credentials, turning any prompt-injection into
 *   server RCE. If any CLI tool is ever proposed for portal parity, that
 *   requires an explicit security review and must be rejected unless sandboxed
 *   in an isolated execution environment (e.g. ephemeral container per request).
 */

import { readFileSync, writeFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, extname, sep } from "node:path";
import { execSync } from "node:child_process";

// ── env ──────────────────────────────────────────────────────────────────────
const envPath = join(homedir(), "prism", ".env");
const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => {
      const idx = l.indexOf("=");
      const val = l.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      return [l.slice(0, idx).trim(), val];
    })
    .filter(([k]) => k)
);

const BRAVE_API_KEY = env.BRAVE_API_KEY;
const OLLAMA_HOST = "http://localhost:11434";

// ── model selection ───────────────────────────────────────────────────────────
const TIER_ORDER = ["27b", "9b", "4b", "2b"];
const TIER_RAM   = { "27b": 17_000, "9b": 7_000, "4b": 3_000, "2b": 1_500 }; // MB

function freeRamMB() {
  try {
    const out = execSync("vm_stat", { encoding: "utf8" });
    let free = 0, inactive = 0, spec = 0;
    for (const line of out.split("\n")) {
      const n = parseInt(line.match(/(\d+)/)?.[1] ?? "0") * 16;
      if (line.includes("Pages free"))        free     = n;
      if (line.includes("Pages inactive"))    inactive = n;
      if (line.includes("Pages speculative")) spec     = n;
    }
    return free + spec + inactive; // KB → divide by 1024 for MB
  } catch { return 8_000 * 1024; } // safe default
}

function pickModel(ceiling) {
  const ceilingIdx = ceiling ? TIER_ORDER.indexOf(ceiling) : 0;
  const freeKB = freeRamMB();
  const freeMB = freeKB / 1024;
  for (let i = Math.max(0, ceilingIdx); i < TIER_ORDER.length; i++) {
    const tier = TIER_ORDER[i];
    if (freeMB >= TIER_RAM[tier]) return `dcostenco/prism-coder:${tier}`;
  }
  return "dcostenco/prism-coder:2b";
}

// ── IS_MAIN detection (must come before args parsing so import doesn't exit) ──
const IS_MAIN = process.argv[1] && (
  process.argv[1].endsWith("prism-agent.mjs") ||
  process.argv[1].endsWith("prism-agent")
);

// ── CLI args (only parsed when run directly) ──────────────────────────────────
let ceiling = null;
let outputFile = null;
let MODEL = process.env.PRISM_MODEL || pickModel(null);
let MAX_ROUNDS = parseInt(process.env.PRISM_MAX_ROUNDS ?? "6");
let TIMEOUT_MS = parseInt(process.env.PRISM_TIMEOUT_MS ?? "120000");
let prompt = "";

if (IS_MAIN) {
  const args = process.argv.slice(2);

  // --ceiling <tier>
  const ceilingIdx = args.indexOf("--ceiling");
  if (ceilingIdx !== -1) {
    ceiling = args[ceilingIdx + 1];
    args.splice(ceilingIdx, 2);
  }

  // --output <file>  (or -o <file>)
  const outIdx = args.findIndex((a) => a === "--output" || a === "-o");
  if (outIdx !== -1) {
    outputFile = resolve(args[outIdx + 1]);
    args.splice(outIdx, 2);
  }

  MODEL = process.env.PRISM_MODEL || pickModel(ceiling);
  MAX_ROUNDS = parseInt(process.env.PRISM_MAX_ROUNDS ?? "6");
  TIMEOUT_MS = parseInt(process.env.PRISM_TIMEOUT_MS ?? "120000");

  prompt = args.join(" ").trim();
  if (!prompt) {
    console.error("Usage: node scripts/prism-agent.mjs [--ceiling 9b] [-o output.py] \"your question\"");
    process.exit(1);
  }
}

// ── tool definitions (OpenAI-compatible) ─────────────────────────────────────
const TOOLS = [
  {
    type: "function",
    function: {
      name: "brave_web_search",
      description:
        "Search the web for current documentation, API specs, changelogs, or anything uncertain. " +
        "Always call this before generating code that depends on specific library/framework APIs.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          count: { type: "integer", description: "Results to return (1-10)", default: 5 },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description:
        "Fetch the full content of a web page or documentation URL. " +
        "Use AFTER brave_web_search when you need the complete spec or example from a specific URL. " +
        "Strips HTML and returns readable text.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full URL to fetch (http or https)" },
          max_chars: { type: "integer", description: "Max characters to return (default 4000)", default: 4000 },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "npm_package_info",
      description:
        "Get the latest version, description, and peer dependencies for an npm package. " +
        "Use when you need the exact API surface of a JavaScript/TypeScript library.",
      parameters: {
        type: "object",
        properties: {
          package_name: { type: "string", description: "npm package name, e.g. 'react', 'zod'" },
        },
        required: ["package_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pypi_package_info",
      description:
        "Get the latest version and requirements for a Python package from PyPI. " +
        "Use when generating Python code that depends on specific library versions.",
      parameters: {
        type: "object",
        properties: {
          package_name: { type: "string", description: "PyPI package name, e.g. 'fastapi', 'numpy'" },
        },
        required: ["package_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the contents of a local file. " +
        "Use to inspect existing code, config files, or docs before generating additions.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative file path" },
          max_chars: { type: "integer", description: "Max characters to return (default 8000)", default: 8000 },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description:
        "List files and directories at a path. " +
        "Use to understand project structure before reading or generating code.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path (default: current directory)", default: "." },
          depth: { type: "integer", description: "Recursion depth (1=flat, 2=one level deep, default 1)", default: 1 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell_run",
      description:
        "Run a safe, read-only shell command to verify code syntax or run tests. " +
        "Allowed commands: node --check, python3 -c (syntax only), tsc --noEmit, npm test, pytest, cargo check, git log/status/diff.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run" },
        },
        required: ["command"],
      },
    },
  },
];

// ── tool implementations ──────────────────────────────────────────────────────
async function braveSearch(query, count = 5) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}&text_decorations=false`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": BRAVE_API_KEY,
    },
  });
  if (!res.ok) return `Search error: ${res.status} ${res.statusText}`;
  const data = await res.json();
  const results = (data.web?.results ?? []).slice(0, count).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.description ?? "",
  }));
  return results.length
    ? results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join("\n\n")
    : "No results found.";
}

// ::ffff: prefix covers IPv4-mapped IPv6 (::ffff:127.0.0.1 → hex ::ffff:7f00:1)
// which URL.parse rewrites, causing bare IPv4 checks to miss it.
const PRIVATE_HOST_RE = /^(localhost|127\.|0\.0\.0\.0|::ffff:|::1|fc00:|fd[0-9a-f]{2}:|fe80:|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/i;

export async function fetchUrlTool(url, maxChars = 4000) {
  if (!/^https?:\/\//i.test(url)) return "[fetch_url error: only http/https URLs allowed]";
  try {
    // SSRF guard: strip IPv6 brackets then check private ranges (incl. ::ffff: mapped)
    const { hostname } = new URL(url);
    const bare = hostname.replace(/^\[|\]$/, "");
    if (PRIVATE_HOST_RE.test(bare)) return "[fetch_url error: URL blocked (private/loopback host)]";
  } catch {
    return "[fetch_url error: invalid URL]";
  }
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; PrismCoder/1.0)", Accept: "text/html,*/*" },
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
    });
    // Re-check final URL after redirect chain
    if (res.url && res.url !== url) {
      try {
        const { hostname: finalHost } = new URL(res.url);
        if (PRIVATE_HOST_RE.test(finalHost.replace(/^\[|\]$/, ""))) {
          return "[fetch_url error: redirect target blocked]";
        }
      } catch { /* ignore unparseable final URL */ }
    }
    if (!res.ok) return `[fetch_url error: HTTP ${res.status}]`;
    const cl = parseInt(res.headers.get("content-length") ?? "0", 10);
    if (!isNaN(cl) && cl > 5 * 1024 * 1024) return "[fetch_url error: response too large (>5MB)]";
    const contentType = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    // Decode &amp; LAST to avoid double-decode of &amp;lt; → &lt; → <
    const readable = contentType.includes("text/html")
      ? raw
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
          .replace(/\s{2,}/g, " ").trim()
      : raw.trim();
    if (!readable) return "[fetch_url: empty response]";
    const clamped = Math.min(Math.max(maxChars, 500), 12_000);
    return readable.length > clamped
      ? `${readable.slice(0, clamped)}\n\n[... truncated at ${clamped} chars]`
      : readable;
  } catch (err) {
    return `[fetch_url error: ${err.message}]`;
  }
}

async function npmPackageInfoTool(name) {
  if (!name.trim()) return "[npm_package_info error: empty name]";
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name.trim())}/latest`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return `[npm_package_info error: HTTP ${res.status}]`;
    const d = await res.json();
    return JSON.stringify({ name: d.name, version: d.version, description: d.description, types: d.types ?? d.typings, peerDependencies: d.peerDependencies, engines: d.engines, keywords: d.keywords }, null, 2);
  } catch (err) {
    return `[npm_package_info error: ${err.message}]`;
  }
}

async function pypiPackageInfoTool(name) {
  if (!name.trim()) return "[pypi_package_info error: empty name]";
  try {
    const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name.trim())}/json`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return `[pypi_package_info error: HTTP ${res.status}]`;
    const d = await res.json();
    const info = d.info ?? {};
    return JSON.stringify({ name: info.name, version: info.version, summary: info.summary, requires_python: info.requires_python, requires_dist: (info.requires_dist ?? []).slice(0, 20), keywords: info.keywords }, null, 2);
  } catch (err) {
    return `[pypi_package_info error: ${err.message}]`;
  }
}

// Sensitive filename/extension patterns blocked regardless of path position
const SENSITIVE_NAME_RE = /^\.|\.(env|key|pem|p12|pfx|p8|secret|cred(ential)?s?)$/i;

export function readFileTool(filePath, maxChars = 8000) {
  const cwd = process.cwd();
  let absPath;
  try {
    const raw = filePath.startsWith("/") ? filePath : resolve(cwd, filePath);
    // Resolve symlinks BEFORE the jail check — readFileSync follows them, so
    // a symlink inside cwd pointing to /etc/passwd would otherwise pass.
    absPath = realpathSync(raw);
  } catch {
    return "[read_file error: invalid path or symlink target does not exist]";
  }
  // Jail to working directory (checked against the real, resolved path)
  const cwdSlash = cwd.endsWith(sep) ? cwd : cwd + sep;
  if (absPath !== cwd && !absPath.startsWith(cwdSlash)) {
    return "[read_file error: path outside working directory]";
  }
  // Block dotfiles and sensitive extensions at any path component
  const relative = absPath.startsWith(cwdSlash) ? absPath.slice(cwdSlash.length) : "";
  const parts = relative.split(sep).filter(Boolean);
  if (parts.some(p => SENSITIVE_NAME_RE.test(p) || p === "node_modules")) {
    return "[read_file error: path blocked (dotfile or sensitive extension)]";
  }
  try {
    const content = readFileSync(absPath, "utf8");
    const clamped = Math.min(Math.max(maxChars, 500), 32_000);
    return content.length > clamped
      ? `${content.slice(0, clamped)}\n\n[... truncated at ${clamped} chars]`
      : content;
  } catch (err) {
    return `[read_file error: ${err.message}]`;
  }
}

export function listDirectoryTool(dirPath = ".", depth = 1) {
  const cwd = process.cwd();
  let absPath;
  try {
    absPath = dirPath.startsWith("/") ? dirPath : resolve(cwd, dirPath);
  } catch {
    return "[list_directory error: invalid path]";
  }
  // Jail to working directory (mirrors readFileTool — intentionally does NOT call
  // realpathSync on the arg, so a non-existent path gives a clear error rather than ENOENT)
  const cwdSlash = cwd.endsWith(sep) ? cwd : cwd + sep;
  if (absPath !== cwd && !absPath.startsWith(cwdSlash)) {
    return "[list_directory error: path outside working directory]";
  }
  // Known gap: readdirSync does not resolve symlinks on child entries.
  // A symlink inside cwd pointing outside it appears as a plain file — the jail is not
  // checked on symlink targets. readFileTool is safe (uses realpathSync); this tool only
  // lists names and does not read content, so the risk is information disclosure, not exfil.
  const results = [];
  function walk(p, d) {
    let entries;
    try { entries = readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === ".git") continue;
      const fullPath = join(p, e.name);
      // Slice the absolute prefix (with trailing sep) to get a clean relative path
      const rel = fullPath.slice(absPath.length).replace(/^[/\\]/, "");
      results.push(e.isDirectory() ? `${rel}/` : rel);
      if (e.isDirectory() && d > 1) walk(fullPath, d - 1);
    }
  }
  try {
    walk(absPath, Math.min(Math.max(depth, 1), 3));
  } catch (err) {
    return `[list_directory error: ${err.message}]`;
  }
  return results.slice(0, 200).join("\n") || "(empty directory)";
}

// All regexes are fully anchored (^ and $) and the newline check runs FIRST,
// so neither \n-based separation nor trailing-suffix tricks can bypass them.
const SHELL_ALLOWLIST = [
  /^node\s+--check\s+\S+$/,
  /^python3?\s+-c\s+['"]import\s+ast\b[^'"]*['"]$/,
  /^tsc(?:\s+(?:--noEmit|--version|--listFiles))*$/,
  /^npm\s+(?:test|run\s+(?:test|build|typecheck))$/,
  /^npx\s+(?:vitest|jest)(?:\s+\S+)*$/,
  /^pytest(?:\s+\S+)*$/,
  /^cargo\s+(?:check|test|build)$/,
  /^git\s+(?:log|status|diff|show|branch)(?:\s+\S+)*$/,
];

export function shellRunTool(command) {
  const trimmed = command.trim();
  // A4: newlines are shell command separators not caught by regex flags — reject first
  if (/[\n\r\0]/.test(trimmed)) return "[shell_run error: newlines and null bytes not allowed]";
  const allowed = SHELL_ALLOWLIST.some((re) => re.test(trimmed));
  if (!allowed) return `[shell_run error: command not in allowlist — ${trimmed.slice(0, 80)}]`;
  // Block remaining shell metacharacters (defense-in-depth; execSync still invokes a shell)
  if (/[;&|`$(){}[\]<>\\]/.test(trimmed)) return "[shell_run error: shell metacharacters not allowed]";
  try {
    const output = execSync(trimmed, { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
    return output.trim() || "(no output)";
  } catch (err) {
    return `[shell_run error: ${err.message.split("\n")[0]}]`;
  }
}

// ── tool executor ─────────────────────────────────────────────────────────────
async function executeTool(name, args) {
  if (name === "brave_web_search") return braveSearch(args.query, Math.min(Math.max(args.count ?? 5, 1), 10));
  if (name === "fetch_url")        return fetchUrlTool(args.url, args.max_chars ?? 4000);
  if (name === "npm_package_info") return npmPackageInfoTool(args.package_name ?? "");
  if (name === "pypi_package_info") return pypiPackageInfoTool(args.package_name ?? "");
  if (name === "read_file")        return readFileTool(args.path ?? ".", args.max_chars ?? 8000);
  if (name === "list_directory")   return listDirectoryTool(args.path ?? ".", args.depth ?? 1);
  if (name === "shell_run")        return shellRunTool(args.command ?? "");
  return JSON.stringify({ error: `Unknown tool: ${name}` });
}

// ── agentic loop ──────────────────────────────────────────────────────────────
async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runAgent(userPrompt) {
  const messages = [
    {
      role: "system",
      content:
        "You are Prism Coder, an expert coding assistant. " +
        "IMPORTANT: Before generating any code that depends on specific library or framework APIs, " +
        "ALWAYS call brave_web_search to verify current syntax. " +
        "This prevents hallucinating outdated or wrong API shapes. " +
        "Search first, code second.",
    },
    { role: "user", content: userPrompt },
  ];

  console.error(`[prism-agent] model=${MODEL} max_rounds=${MAX_ROUNDS}`);

  const MAX_TOOL_CALLS_PER_ROUND = 3;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const t0 = Date.now();
    const isLastRound = round === MAX_ROUNDS - 1;

    const fetchPromise = fetch(`${OLLAMA_HOST}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages,
        // On the last round omit tools so the model synthesizes an answer instead of looping
        tools: isLastRound ? [] : TOOLS,
        stream: false,
        options: { temperature: 0, num_predict: 4096, num_ctx: 16_384 },
      }),
    }).then((r) => {
      if (!r.ok) throw new Error(`Ollama error: ${r.status}`);
      return r.json();
    });

    let data;
    try {
      data = await withTimeout(fetchPromise, TIMEOUT_MS, `round ${round + 1}`);
    } catch (err) {
      console.error(`[round ${round + 1}] ERROR: ${err.message}`);
      break;
    }

    const msg = data.message;
    const latency = Date.now() - t0;
    const toolCalls = msg.tool_calls ?? [];
    // Cap to prevent transcript/result mismatch (A3: positional pairing requires equal counts)
    const cappedToolCalls = toolCalls.slice(0, MAX_TOOL_CALLS_PER_ROUND);

    console.error(
      `[round ${round + 1}] ${latency}ms | tools=${cappedToolCalls.length}/${toolCalls.length} | ` +
        `tokens_in=${data.prompt_eval_count ?? "?"} out=${data.eval_count ?? "?"}`
    );

    messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: cappedToolCalls.length ? cappedToolCalls : undefined });

    if (cappedToolCalls.length === 0) {
      // Final answer
      return msg.content ?? "";
    }

    // Execute each tool call and append results
    for (const tc of cappedToolCalls) {
      const fn = tc.function;
      let fnArgs;
      try {
        fnArgs = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments;
      } catch {
        fnArgs = { query: fn.arguments };
      }
      console.error(`  → ${fn.name}(${JSON.stringify(fnArgs)})`);
      const result = await executeTool(fn.name, fnArgs);
      console.error(`    ${result.slice(0, 120).replace(/\n/g, " ")}…`);
      messages.push({ role: "tool", content: result });
    }
  }

  // Fallback: return last assistant message if loop exhausted
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  return last?.content ?? "(no response)";
}

// ── main ──────────────────────────────────────────────────────────────────────
if (IS_MAIN) {
  const answer = await runAgent(prompt);
  if (outputFile) {
    writeFileSync(outputFile, answer, "utf8");
    console.error(`[prism-agent] output saved → ${outputFile}`);
  } else {
    console.log("\n" + answer);
  }
}
