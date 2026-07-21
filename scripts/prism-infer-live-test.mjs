#!/usr/bin/env node
/**
 * Prism local-routing live integration test
 * ───────────────────────────────────────────────────────────
 * Spawns the built prism-mcp server over stdio and verifies the real MCP
 * session_task_route -> prism_infer contract.
 *
 * Default (fast, no model load):
 *   1. Confirm session_task_route and prism_infer are exposed
 *   2. Verify deterministic 4B, 9B, and 27B routing
 *   3. Verify architecture, security, and host-tool workflows stay on host
 *
 * Optional (loads local models sequentially):
 *   --infer — feed each local route's recommended_args back into prism_infer,
 *             assert the selected tier, and unload Prism models between cases
 *
 * Usage:
 *   npm run test:routing:live
 *   npm run test:routing:models
 */

import { spawn, spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PRISM_ROOT = path.resolve(__dirname, "..");
const SERVER_PATH = path.join(PRISM_ROOT, "dist", "server.js");

/** Load ~/prism/.env into a plain object (no third-party deps). */
function loadDotenv(file) {
    const out = {};
    if (!fs.existsSync(file)) return out;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (!m) continue;
        let val = m[2];
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        out[m[1]] = val;
    }
    return out;
}

const FLAGS = new Set(process.argv.slice(2));
const TEST_INFERENCE = FLAGS.has("--infer");

const GB = 1024 ** 3;

const ROUTE_CASES = [
    {
        label: "4B — trivial bounded edit",
        expectedTarget: "claw",
        expectedTier: "4b",
        maxTokens: 128,
        args: {
            task_description: "fix typo in README, simple change",
            files_involved: ["README.md"],
            estimated_scope: "minor_edit",
        },
    },
    {
        label: "9B — bounded endpoint scaffold",
        expectedTarget: "claw",
        expectedTier: "9b",
        maxTokens: 512,
        args: {
            task_description: "scaffold a new REST endpoint",
            estimated_scope: "new_feature",
        },
    },
    {
        label: "27B — bounded difficult algorithm",
        expectedTarget: "claw",
        expectedTier: "27b",
        maxTokens: 768,
        args: {
            task_description:
                "Implement a self-contained dynamic programming algorithm from this complete specification with multiple edge cases.",
            files_involved: ["src/solver.ts"],
            estimated_scope: "new_feature",
        },
    },
    {
        label: "host — architecture judgment",
        expectedTarget: "host",
        args: {
            task_description: "Design the architecture and migration strategy for services and persistence",
            files_involved: ["src/service.ts"],
            estimated_scope: "new_feature",
        },
    },
    {
        label: "host — security judgment",
        expectedTarget: "host",
        args: {
            task_description: "Perform a security audit of authentication and investigate the vulnerability surface",
            files_involved: ["src/auth.ts"],
            estimated_scope: "bug_fix",
        },
    },
    {
        label: "host — real read-edit-verify regression",
        expectedTarget: "host",
        args: {
            task_description:
                "Read the Prism test harness, persist regression tests for the 4B, 9B, 27B and host-only routing matrix, update the real MCP live-test workflow, then run focused verification.",
            files_involved: [
                "tests/tools/task-router.test.ts",
                "scripts/prism-infer-live-test.mjs",
            ],
            estimated_scope: "bug_fix",
        },
    },
];

// ─── Pretty output ─────────────────────────────────────────

const C = {
    reset: "\x1b[0m",
    dim:   "\x1b[2m",
    red:   "\x1b[31m",
    green: "\x1b[32m",
    yel:   "\x1b[33m",
    blue:  "\x1b[34m",
    bold:  "\x1b[1m",
};
const log = (msg) => process.stdout.write(`${msg}\n`);
const ok  = (msg) => log(`${C.green}✓${C.reset} ${msg}`);
const bad = (msg) => log(`${C.red}✗${C.reset} ${msg}`);
const info = (msg) => log(`${C.dim}  ${msg}${C.reset}`);
const head = (msg) => log(`\n${C.bold}${C.blue}${msg}${C.reset}`);

// ─── MCP stdio client ──────────────────────────────────────

class McpClient {
    constructor(serverPath) {
        const dotenv = loadDotenv(path.join(PRISM_ROOT, ".env"));
        this.proc = spawn("node", [serverPath], {
            stdio: ["pipe", "pipe", "pipe"],
            cwd: PRISM_ROOT,
            env: { ...dotenv, ...process.env, PRISM_FORCE_LOCAL: "true" },
        });
        this.proc.stderr.on("data", (b) => {
            if (process.env.PRISM_LIVE_DEBUG) process.stderr.write(`[srv] ${b}`);
        });
        this.buf = "";
        this.pending = new Map();
        this.nextId = 1;
        this.proc.stdout.on("data", (chunk) => {
            this.buf += chunk.toString();
            let nl;
            while ((nl = this.buf.indexOf("\n")) !== -1) {
                const line = this.buf.slice(0, nl).trim();
                this.buf = this.buf.slice(nl + 1);
                if (!line) continue;
                let msg;
                try { msg = JSON.parse(line); } catch { continue; }
                if (msg.id && this.pending.has(msg.id)) {
                    const { resolve, reject } = this.pending.get(msg.id);
                    this.pending.delete(msg.id);
                    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
                    else resolve(msg.result);
                }
            }
        });
    }
    async request(method, params, timeoutMs = 180_000) {
        const id = this.nextId++;
        const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (r) => { clearTimeout(t); resolve(r); },
                reject:  (e) => { clearTimeout(t); reject(e); },
            });
            this.proc.stdin.write(payload);
        });
    }
    async initialize() {
        return this.request("initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "prism-infer-live-test", version: "1.0.0" },
        });
    }
    async listTools() {
        return this.request("tools/list", {});
    }
    async callTool(name, args) {
        return this.request("tools/call", { name, arguments: args });
    }
    close() {
        try { this.proc.kill("SIGTERM"); } catch {}
    }
}

// ─── Assertions ────────────────────────────────────────────

let failures = 0;
function assert(cond, label) {
    if (cond) ok(label);
    else { bad(label); failures += 1; }
}

function parseFirstJsonBlock(result, label) {
    const block = result?.content?.find((item) => item.type === "text")?.text;
    if (!block) throw new Error(`${label}: tool returned no text content`);
    try {
        return JSON.parse(block);
    } catch (error) {
        throw new Error(`${label}: first text block is not JSON: ${error.message}`);
    }
}

function expectedTierForComplexity(complexity) {
    if (complexity <= 3) return "4b";
    if (complexity <= 6) return "9b";
    return "27b";
}

function loadedPrismModels() {
    const result = spawnSync("ollama", ["ps"], { encoding: "utf8" });
    if (result.error || result.status !== 0) return [];
    const matches = result.stdout.match(/(?:dcostenco\/)?prism-coder:(?:2b|4b|9b|27b)/g) || [];
    return [...new Set(matches)];
}

function waitMs(milliseconds) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function unloadPrismModels(timeoutMs = 10_000) {
    for (const model of loadedPrismModels()) {
        const result = spawnSync("ollama", ["stop", model], { encoding: "utf8" });
        assert(result.status === 0, `unloaded ${model}`);
    }

    const deadline = Date.now() + timeoutMs;
    let remaining = loadedPrismModels();
    while (remaining.length > 0 && Date.now() < deadline) {
        waitMs(250);
        remaining = loadedPrismModels();
    }
    assert(remaining.length === 0, `Prism model unload completed${remaining.length ? ` (still loaded: ${remaining.join(", ")})` : ""}`);
}

// ─── Main ──────────────────────────────────────────────────

async function main() {
    head("Prism Local-Routing Live Test");
    info(`server=${SERVER_PATH}`);
    info(`os.freemem=${(os.freemem() / GB).toFixed(1)} GB`);
    info(`os.totalmem=${(os.totalmem() / GB).toFixed(1)} GB`);
    info(`actual local inference=${TEST_INFERENCE}`);

    const client = new McpClient(SERVER_PATH);
    try {
        await client.initialize();

        // ── 1. Sanity: both halves of the MCP contract are exposed ──
        head("1. Sanity — tools/list");
        const listed = await client.listTools();
        const names = (listed.tools || []).map((t) => t.name);
        assert(names.includes("session_task_route"), `session_task_route is in tools/list (found ${names.length} tools)`);
        assert(names.includes("prism_infer"), `prism_infer is in tools/list (found ${names.length} tools)`);

        // ── 2. Route matrix through the real stdio MCP server ──
        head("2. session_task_route matrix");
        const localRoutes = [];
        for (const testCase of ROUTE_CASES) {
            const response = await client.callTool("session_task_route", testCase.args);
            assert(!response.isError, `${testCase.label}: no MCP error envelope`);
            const route = parseFirstJsonBlock(response, testCase.label);
            info(`${testCase.label}: target=${route.target} complexity=${route.complexity_score}`);
            assert(route.target === testCase.expectedTarget, `${testCase.label}: target=${testCase.expectedTarget}`);

            if (testCase.expectedTarget === "host") {
                assert(route.recommended_tool === null, `${testCase.label}: no local executor`);
                assert(route.recommended_args === undefined, `${testCase.label}: no local arguments`);
                continue;
            }

            assert(route.recommended_tool === "prism_infer", `${testCase.label}: recommends prism_infer`);
            const recommendedArgs = route.recommended_args || {};
            assert(route.recommended_args !== undefined, `${testCase.label}: returns local arguments`);
            assert(recommendedArgs.task_complexity === route.complexity_score, `${testCase.label}: forwards full complexity`);
            assert(recommendedArgs.cloud_fallback === false, `${testCase.label}: disables cloud fallback`);
            assert(recommendedArgs.escalation === "report", `${testCase.label}: reports local failures`);
            assert(!("model_ceiling" in recommendedArgs), `${testCase.label}: prism_infer owns model selection`);
            assert(!("think" in recommendedArgs), `${testCase.label}: prism_infer owns thinking selection`);

            const selectedTier = expectedTierForComplexity(route.complexity_score);
            assert(selectedTier === testCase.expectedTier, `${testCase.label}: complexity selects ${testCase.expectedTier}`);
            localRoutes.push({ testCase, route });
        }

        // ── 3. Optional: execute the returned local arguments verbatim ──
        if (TEST_INFERENCE) {
            head("3. session_task_route -> prism_infer model execution");
            unloadPrismModels();

            for (const { testCase, route } of localRoutes) {
                const result = await client.callTool("prism_infer", {
                    ...route.recommended_args,
                    max_tokens: testCase.maxTokens,
                    temperature: 0,
                    verify: false,
                });
                const header = result?.content?.[0]?.text ?? "";
                const body = result?.content?.[1]?.text ?? "";
                info(`${testCase.label}: ${header}`);
                info(`output: ${body.slice(0, 100).replace(/\n/g, " ")}${body.length > 100 ? "…" : ""}`);
                assert(!result.isError, `${testCase.label}: inference succeeded`);
                assert(header.includes(`backend=ollama-${testCase.expectedTier}`), `${testCase.label}: used ${testCase.expectedTier} backend`);
                assert(header.includes("used_cloud=false"), `${testCase.label}: stayed local`);
                assert(/free_ram=\d+MB/.test(header), `${testCase.label}: reported RAM evidence`);
                assert(!header.includes("quality_gate_failed=true"), `${testCase.label}: output was not truncated or degraded`);
                unloadPrismModels();
            }

            assert(loadedPrismModels().length === 0, "no Prism model remains loaded after live tests");
        }
    } finally {
        client.close();
    }

    head("Result");
    if (failures === 0) {
        ok(`All checks passed (${failures} failures)`);
        process.exit(0);
    } else {
        bad(`${failures} assertion(s) failed`);
        process.exit(1);
    }
}

main().catch((err) => {
    bad(`fatal: ${err?.stack || err}`);
    process.exit(2);
});
