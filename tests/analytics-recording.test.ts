import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { unlink } from "node:fs/promises";

const TEST_DB = `/tmp/prism-analytics-test-${process.pid}.db`;

beforeEach(() => {
    vi.resetModules();
    process.env.PRISM_ANALYTICS_DB_PATH = TEST_DB;
});

afterEach(async () => {
    delete process.env.PRISM_ANALYTICS_DB_PATH;
    try { await unlink(TEST_DB); } catch { /* ok */ }
});

describe("recordInvocation + flush", () => {
    it("records a successful invocation and flushes to SQLite", async () => {
        const { recordInvocation, flushBuffer, _resetDb } = await import("../src/utils/analytics.js");
        _resetDb();

        recordInvocation("session_load_context", "prism-mcp", { project: "prism-mcp" }, '{"ok":true}', 42, true);
        const flushed = await flushBuffer();
        expect(flushed).toBe(1);
    });

    it("records a failed invocation with error message", async () => {
        const { recordInvocation, flushBuffer, _resetDb } = await import("../src/utils/analytics.js");
        _resetDb();

        recordInvocation("knowledge_search", "prism-mcp", { query: "test" }, "", 100, false, "Session memory not configured");
        const flushed = await flushBuffer();
        expect(flushed).toBe(1);
    });

    it("batches multiple invocations", async () => {
        const { recordInvocation, flushBuffer, _resetDb } = await import("../src/utils/analytics.js");
        _resetDb();

        for (let i = 0; i < 5; i++) {
            recordInvocation(`tool_${i}`, "test-project", {}, `response_${i}`, 10 + i, true);
        }
        const flushed = await flushBuffer();
        expect(flushed).toBe(5);
    });

    it("handles empty buffer gracefully", async () => {
        const { flushBuffer, _resetDb } = await import("../src/utils/analytics.js");
        _resetDb();
        const flushed = await flushBuffer();
        expect(flushed).toBe(0);
    });
});

describe("getProjectAnalytics", () => {
    it("returns zero stats for unknown project", async () => {
        const { getProjectAnalytics, _resetDb } = await import("../src/utils/analytics.js");
        _resetDb();
        const stats = await getProjectAnalytics("nonexistent", 7);
        expect(stats.totalCalls).toBe(0);
        expect(stats.topTools).toEqual([]);
    });

    it("returns correct stats after recording invocations", async () => {
        const { recordInvocation, flushBuffer, getProjectAnalytics, _resetDb } = await import("../src/utils/analytics.js");
        _resetDb();

        recordInvocation("brave_web_search", "prism-mcp", { query: "test" }, '{"results":[]}', 200, true);
        recordInvocation("brave_web_search", "prism-mcp", { query: "other" }, '{"results":[]}', 150, true);
        recordInvocation("session_load_context", "prism-mcp", { project: "prism-mcp" }, '{"ok":true}', 50, true);
        recordInvocation("knowledge_search", "prism-mcp", { query: "fail" }, "", 30, false, "timeout");
        await flushBuffer();

        const stats = await getProjectAnalytics("prism-mcp", 1);
        expect(stats.totalCalls).toBe(4);
        expect(stats.successRate).toBeCloseTo(0.75, 1);
        expect(stats.topTools[0].tool).toBe("brave_web_search");
        expect(stats.topTools[0].count).toBe(2);
        expect(stats.totalInputTokens).toBeGreaterThan(0);
        expect(stats.totalOutputTokens).toBeGreaterThan(0);
    });

    it("scopes stats to the requested project only", async () => {
        const { recordInvocation, flushBuffer, getProjectAnalytics, _resetDb } = await import("../src/utils/analytics.js");
        _resetDb();

        recordInvocation("tool_a", "project-alpha", {}, "ok", 10, true);
        recordInvocation("tool_b", "project-beta", {}, "ok", 20, true);
        recordInvocation("tool_c", "project-alpha", {}, "ok", 15, true);
        await flushBuffer();

        const alpha = await getProjectAnalytics("project-alpha", 1);
        const beta = await getProjectAnalytics("project-beta", 1);
        expect(alpha.totalCalls).toBe(2);
        expect(beta.totalCalls).toBe(1);
    });
});

describe("getSystemAnalytics", () => {
    it("aggregates across all projects", async () => {
        const { recordInvocation, flushBuffer, getSystemAnalytics, _resetDb } = await import("../src/utils/analytics.js");
        _resetDb();

        recordInvocation("tool_a", "project-1", {}, "ok", 10, true);
        recordInvocation("tool_b", "project-2", {}, "ok", 20, true);
        recordInvocation("tool_a", "project-3", {}, "ok", 30, true);
        await flushBuffer();

        const sys = await getSystemAnalytics(1);
        expect(sys.totalProjects).toBe(3);
        expect(sys.totalCalls).toBe(3);
        expect(sys.topProjects.length).toBe(3);
        expect(sys.topTools[0].tool).toBe("tool_a");
        expect(sys.topTools[0].calls).toBe(2);
    });
});

describe("apiAnalyticsHandler scope param alignment", () => {
    it("scope=system returns dashboard stats", async () => {
        const { _resetDb } = await import("../src/utils/analytics.js");
        const { apiAnalyticsHandler } = await import("../src/tools/v12Handlers.js");
        _resetDb();

        const result = await apiAnalyticsHandler({ scope: "system", days: 1 });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.status).toBe("ok");
        expect(parsed.dashboard).toBeDefined();
        expect(parsed.dashboard.totalCalls).toBeTypeOf("number");
    });

    it("scope=project returns project-scoped stats", async () => {
        const { recordInvocation, flushBuffer, _resetDb } = await import("../src/utils/analytics.js");
        const { apiAnalyticsHandler } = await import("../src/tools/v12Handlers.js");
        _resetDb();

        recordInvocation("test_tool", "my-proj", {}, "ok", 5, true);
        await flushBuffer();

        const result = await apiAnalyticsHandler({ scope: "project", project: "my-proj", days: 1 });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.status).toBe("ok");
        expect(parsed.project).toBe("my-proj");
        expect(parsed.stats).toBeDefined();
        expect(parsed.stats.totalCalls).toBeGreaterThanOrEqual(1);
    });

    it("omitting scope defaults to system", async () => {
        const { _resetDb } = await import("../src/utils/analytics.js");
        const { apiAnalyticsHandler } = await import("../src/tools/v12Handlers.js");
        _resetDb();

        const result = await apiAnalyticsHandler({ days: 1 });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.status).toBe("ok");
        expect(parsed.dashboard).toBeDefined();
    });

    it("old 'action' param is ignored — regression guard", async () => {
        const { _resetDb } = await import("../src/utils/analytics.js");
        const { apiAnalyticsHandler } = await import("../src/tools/v12Handlers.js");
        _resetDb();

        const result = await apiAnalyticsHandler({ action: "project", project: "test" });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.dashboard).toBeDefined();
    });
});

describe("inference_metrics handler", () => {
    it("returns empty message when no prism_infer calls", async () => {
        const { inferenceMetricsHandler, resetInferenceMetrics } = await import("../src/utils/inferenceMetrics.js");
        resetInferenceMetrics();
        const result = await inferenceMetricsHandler();
        expect(result.content[0].text).toContain("No prism_infer calls");
    });

    it("returns local vs cloud breakdown", async () => {
        const { recordInference, inferenceMetricsHandler, resetInferenceMetrics } =
            await import("../src/utils/inferenceMetrics.js");
        resetInferenceMetrics();

        recordInference({ backend: "ollama", model_picked: "prism-coder:2b", used_cloud: false, latency_ms: 150, prompt_tokens: 100, completion_tokens: 50 });
        recordInference({ backend: "synalux-portal", model_picked: "claude-opus-4-6", used_cloud: true, latency_ms: 800, prompt_tokens: 200, completion_tokens: 300 });
        recordInference({ backend: "ollama", model_picked: "prism-coder:2b", used_cloud: false, latency_ms: 120, prompt_tokens: 80, completion_tokens: 40 });

        const result = await inferenceMetricsHandler();
        const text = result.content[0].text;
        expect(text).toContain("Total calls: 3");
        expect(text).toContain("Local: 2");
        expect(text).toContain("Cloud: 1");
        expect(text).toContain("prism-coder:2b");
        expect(text).toContain("claude-opus-4-6");

        resetInferenceMetrics();
    });

    it("skips safety_gate backend from metrics", async () => {
        const { recordInference, getInferenceSnapshot, resetInferenceMetrics } =
            await import("../src/utils/inferenceMetrics.js");
        resetInferenceMetrics();

        recordInference({ backend: "safety_gate", model_picked: null, used_cloud: false, latency_ms: 5 });
        expect(getInferenceSnapshot().totalCalls).toBe(0);

        resetInferenceMetrics();
    });
});

describe("ddLogger CONTEXT_ALLOWLIST includes tool analytics fields", () => {
    it("tool, project, success, durationMs pass through allowlist", async () => {
        const src = await import("fs/promises").then(fs => fs.readFile(
            new URL("../src/utils/ddLogger.ts", import.meta.url), "utf-8"
        ));
        for (const field of ["tool", "project", "success", "durationMs"]) {
            expect(src).toContain(`"${field}"`);
        }
    });
});

describe("recordInvocation isolation from dispatch", () => {
    it("does not throw on circular args (isolation guarantee)", async () => {
        const { recordInvocation, _resetDb } = await import("../src/utils/analytics.js");
        _resetDb();

        const circular: Record<string, unknown> = { a: 1 };
        circular.self = circular;

        expect(() => {
            recordInvocation("test_tool", "prism-mcp", circular, "ok", 10, true);
        }).not.toThrow();
    });

    it("does not throw on undefined/null args", async () => {
        const { recordInvocation, _resetDb } = await import("../src/utils/analytics.js");
        _resetDb();

        expect(() => {
            recordInvocation("test_tool", "prism-mcp", undefined, "", 10, false, "err");
            recordInvocation("test_tool", "prism-mcp", null, "", 10, false, "err");
        }).not.toThrow();
    });
});

describe("server.ts dispatch wiring (source verification)", () => {
    const readServerSrc = () =>
        import("fs/promises").then(fs => fs.readFile(
            new URL("../src/server.ts", import.meta.url), "utf-8"
        ));

    it("imports recordInvocation from analytics", async () => {
        const src = await readServerSrc();
        expect(src).toContain('import { recordInvocation } from "./utils/analytics.js"');
    });

    it("calls recordInvocation on success path (after mcp.tool.success, before return)", async () => {
        const src = await readServerSrc();
        const anchor = src.indexOf('"mcp.tool.success"');
        const call = src.indexOf("recordInvocation(", anchor);
        const returnIndex = src.indexOf("return result", anchor);
        expect(anchor).toBeGreaterThan(-1);
        expect(call).toBeGreaterThan(anchor);
        expect(call).toBeLessThan(returnIndex);
    });

    it("calls recordInvocation on error path (after mcp.tool.error, before the error return)", async () => {
        const src = await readServerSrc();
        const anchor = src.indexOf('"mcp.tool.error"');
        const call = src.indexOf("recordInvocation(", anchor);
        const errReturn = src.indexOf("isError: true", anchor);
        expect(anchor).toBeGreaterThan(-1);
        expect(call).toBeGreaterThan(anchor);
        expect(errReturn).toBeGreaterThan(-1);
        expect(call).toBeLessThan(errReturn);
    });

    it("has exactly two recordInvocation call sites in dispatch", async () => {
        const src = await readServerSrc();
        const matches = src.match(/recordInvocation\(/g) || [];
        expect(matches.length).toBe(2);
    });
});

describe("analytics WAL mode", () => {
    it("ensureTable sets journal_mode=WAL", async () => {
        const src = await import("fs/promises").then(fs => fs.readFile(
            new URL("../src/utils/analytics.ts", import.meta.url), "utf-8"
        ));
        expect(src).toContain("PRAGMA journal_mode=WAL");
    });
});

describe("notifier DNS-pinning (SSRF TOCTOU fix)", () => {
    const readNotifierSrc = () =>
        import("fs/promises").then(fs => fs.readFile(
            new URL("../src/utils/notifier.ts", import.meta.url), "utf-8"
        ));

    it("all three senders use pinnedDispatcher", async () => {
        const src = await readNotifierSrc();
        const dispatcherCalls = (src.match(/pinnedDispatcher\(/g) || []).length;
        expect(dispatcherCalls).toBe(4);
    });

    it("all three senders close the dispatcher in finally", async () => {
        const src = await readNotifierSrc();
        const closeCalls = (src.match(/dispatcher\.close\(\)/g) || []).length;
        expect(closeCalls).toBe(3);
    });

    it("all three senders use redirect: error", async () => {
        const src = await readNotifierSrc();
        const redirectCalls = (src.match(/redirect:\s*"error"/g) || []).length;
        expect(redirectCalls).toBe(3);
    });

    it("validateUrl resolves DNS before allowing", async () => {
        const src = await readNotifierSrc();
        expect(src).toContain("await lookup(hostname, { all: true })");
        expect(src).toContain("resolvedAddr: addrs[0].address");
    });

    it("imports undici Agent for DNS pinning", async () => {
        const src = await readNotifierSrc();
        expect(src).toContain('import { Agent } from "undici"');
    });
});

describe("supergateway security", () => {
    it("documents that supergateway binds 0.0.0.0 (no --host flag)", async () => {
        const src = await import("fs/promises").then(fs => fs.readFile(
            new URL("../smithery-bridge.mjs", import.meta.url), "utf-8"
        ));
        expect(src).toContain("supergateway has no --host flag");
    });

    it("proxy connects to gateway via 127.0.0.1 only", async () => {
        const src = await import("fs/promises").then(fs => fs.readFile(
            new URL("../smithery-bridge.mjs", import.meta.url), "utf-8"
        ));
        expect(src).toContain("hostname: '127.0.0.1'");
        expect(src).toContain(`port: GATEWAY_PORT`);
    });

    it("proxy enforces bearer token auth on all proxied requests", async () => {
        const src = await import("fs/promises").then(fs => fs.readFile(
            new URL("../smithery-bridge.mjs", import.meta.url), "utf-8"
        ));
        expect(src).toContain("constantTimeEqual(authHeader");
        expect(src).toContain("PRISM_MCP_HTTP_TOKEN");
    });
});
