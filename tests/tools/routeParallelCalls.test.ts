/**
 * Route mode and parallel tool calls. By default a route reply is one call and
 * anything else fails closed. A caller that advertises several tools can opt in
 * with `allow_parallel_calls`: a reply of several complete calls is then served
 * only when every call is well formed and advertised.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import {
    PRISM_INFER_TOOL,
    runInfer,
    isPrismInferArgs,
    type InferDeps,
    type PrismInferArgs,
} from "../../src/tools/prismInferHandler.js";
import { _setCacheForTest, _resetEntitlementsForTest, type PrismEntitlements } from "../../src/utils/entitlements.js";
import { applyLocalRouteContract } from "../../src/utils/routeContract.js";
import { passesQualityGate } from "../../src/utils/qualityGate.js";

const GB = 1024 ** 3;
const PAID: PrismEntitlements = {
    plan: "enterprise",
    model_ceiling: "27b",
    daily_infer_limit: 100000,
    max_tokens: 4096,
    max_seats: 25,
    features: {
        cloud_fallback: true,
        grounding_verifier: true,
        route_guard: true,
        knowledge_search_unlimited: true,
        session_memory_unlimited: true,
        analytics_dashboard: true,
    },
    upgrade_url: "https://synalux.ai/pricing",
};
beforeEach(() => { _setCacheForTest(PAID, 60_000); });
afterAll(() => { _resetEntitlementsForTest(); });

const call = (name: string, args: Record<string, unknown> = {}) =>
    `<tool_call>\n${JSON.stringify({ name, arguments: args })}\n</tool_call>`;
const WEATHER = call("get_weather", { city: "Lisbon" });
const TIME = call("get_time", { zone: "Europe/Lisbon" });
const TWO = `${WEATHER}\n${TIME}`;
const ALLOWED = new Set(["get_weather", "get_time"]);

function makeDeps(text: string, overrides: Partial<InferDeps> = {}): InferDeps {
    return {
        freemem: () => 30 * GB,
        listTags: async () => new Set(["prism-coder:27b", "prism-coder:9b", "prism-coder:4b", "prism-coder:2b"]),
        listLoaded: async () => new Set<string>(),
        callLocal: async () => ({ ok: true as const, text }),
        callCloud: async () => ({ ok: false as const, reason: "cloud_not_expected" }),
        ollamaUrl: "http://localhost:11434",
        callLayer1: async () => "OBVIOUS_NOT_RESERVED",
        ...overrides,
    };
}
const routeArgs = (extra: Partial<PrismInferArgs> = {}): PrismInferArgs => ({
    prompt: "weather and time in Lisbon",
    mode: "route",
    model_ceiling: "9b",
    allowed_tools: [...ALLOWED],
    ...extra,
});

describe("route contract: several calls", () => {
    it("still fails closed by default", () => {
        expect(applyLocalRouteContract(TWO, ALLOWED)).toMatchObject({
            output: "NO_TOOL", action: "suppressed", reason: "malformed_tool_call",
        });
    });

    it("keeps every call when opted in and all are advertised", () => {
        expect(applyLocalRouteContract(TWO, ALLOWED, { allowParallel: true })).toEqual({
            output: TWO,
            action: "preserved",
            source: "local",
            original_tool: "get_weather",
            final_tool: "get_weather",
            calls: ["get_weather", "get_time"],
        });
    });

    it("keeps the mixed pipe/angle envelopes a model emits", () => {
        const mixed = `<|tool_call|>${JSON.stringify({ name: "get_weather", arguments: {} })}</tool_call>\n` +
            `<|tool_call|>${JSON.stringify({ name: "get_time", arguments: {} })}<|tool_call_end|>`;
        expect(applyLocalRouteContract(mixed, ALLOWED, { allowParallel: true }).action).toBe("preserved");
    });

    it("drops the whole reply when any call is not advertised", () => {
        const withInvented = `${WEATHER}\n${call("triangle_area", { base: 10 })}`;
        expect(applyLocalRouteContract(withInvented, ALLOWED, { allowParallel: true })).toMatchObject({
            output: "NO_TOOL", action: "suppressed", reason: "unadvertised_tool", original_tool: "triangle_area",
        });
    });

    it.each([
        { id: "prose-between", output: `${WEATHER}\nand then\n${TIME}` },
        { id: "prose-after", output: `${TWO}\nDone.` },
        { id: "bad-json-second", output: `${WEATHER}\n<tool_call>{not-json}</tool_call>` },
        { id: "unterminated-last", output: `${WEATHER}\n<tool_call>${JSON.stringify({ name: "get_time", arguments: {} })}` },
        { id: "no-tool-inside", output: `${WEATHER}\n${call("NO_TOOL")}` },
    ])("fails closed on $id even when opted in", ({ output }) => {
        expect(applyLocalRouteContract(output, ALLOWED, { allowParallel: true })).toMatchObject({
            output: "NO_TOOL", action: "suppressed",
        });
    });

    it("leaves single calls and plain text exactly as before", () => {
        expect(applyLocalRouteContract(WEATHER, ALLOWED, { allowParallel: true }))
            .toEqual(applyLocalRouteContract(WEATHER, ALLOWED));
        expect(applyLocalRouteContract("It is sunny.", ALLOWED, { allowParallel: true }))
            .toEqual(applyLocalRouteContract("It is sunny.", ALLOWED));
    });
});

describe("quality gate: several calls in route mode", () => {
    const pipe = (name: string) => `<|tool_call|>${JSON.stringify({ name, arguments: {} })}<|tool_call_end|>`;
    const four = ["Lisbon", "Porto", "Faro", "Braga"].map(city => call("get_weather", { city })).join("\n");

    it("fails them by default: pipe envelopes as malformed, three or more angle envelopes as a loop", () => {
        expect(passesQualityGate(`${pipe("get_weather")}\n${pipe("get_time")}`, false, "stop", "route"))
            .toEqual({ pass: false, reason: "route_tool_call_malformed" });
        expect(passesQualityGate(four, false, "stop", "route")).toEqual({ pass: false, reason: "loop_detected" });
    });

    it("passes them in either envelope when opted in", () => {
        expect(passesQualityGate(`${pipe("get_weather")}\n${pipe("get_time")}`, false, "stop", "route",
            { allowParallelCalls: true }).pass).toBe(true);
        expect(passesQualityGate(TWO, false, "stop", "route", { allowParallelCalls: true }).pass).toBe(true);
    });

    it("does not read four different calls as a loop when opted in", () => {
        expect(passesQualityGate(four, false, "stop", "route", { allowParallelCalls: true }).pass).toBe(true);
    });

    it("ignores the option outside route mode", () => {
        expect(passesQualityGate(four, false, "stop", "chat", { allowParallelCalls: true }))
            .toEqual(passesQualityGate(four, false, "stop", "chat"));
    });

    it("still fails the same call repeated, which is a loop", () => {
        const same = Array(5).fill(WEATHER).join("\n");
        expect(passesQualityGate(same, false, "stop", "route", { allowParallelCalls: true }))
            .toEqual({ pass: false, reason: "loop_detected" });
    });

    it("reads the same arguments in another key order as the same call", () => {
        const reordered = [
            call("get_weather", { city: "Lisbon", units: "c" }),
            call("get_weather", { units: "c", city: "Lisbon" }),
            call("get_weather", { city: "Lisbon", units: "c" }),
        ].join("\n");
        expect(passesQualityGate(reordered, false, "stop", "route", { allowParallelCalls: true }))
            .toEqual({ pass: false, reason: "loop_detected" });
        const nested = [
            call("get_weather", { where: { city: "Lisbon", country: "PT" } }),
            call("get_weather", { where: { country: "PT", city: "Lisbon" } }),
            call("get_weather", { where: { city: "Lisbon", country: "PT" } }),
        ].join("\n");
        expect(passesQualityGate(nested, false, "stop", "route", { allowParallelCalls: true }))
            .toEqual({ pass: false, reason: "loop_detected" });
        const different = [
            call("get_weather", { city: "Lisbon", units: "c" }),
            call("get_weather", { units: "f", city: "Lisbon" }),
            call("get_weather", { city: "Porto", units: "c" }),
        ].join("\n");
        expect(passesQualityGate(different, false, "stop", "route", { allowParallelCalls: true })).toEqual({ pass: true });
    });
});

describe("prism_infer: allow_parallel_calls", () => {
    it("is advertised as an optional boolean that defaults to off", () => {
        const p = PRISM_INFER_TOOL.inputSchema.properties as Record<string, Record<string, unknown>>;
        expect(p.allow_parallel_calls).toMatchObject({ type: "boolean", default: false });
        expect(isPrismInferArgs({ prompt: "x", allow_parallel_calls: true })).toBe(true);
        expect(isPrismInferArgs({ prompt: "x", allow_parallel_calls: "yes" })).toBe(false);
    });

    it("serves every advertised call when opted in, without the single-call portal guard", async () => {
        const routeGuard = vi.fn();
        const result = await runInfer(routeArgs({ allow_parallel_calls: true }),
            makeDeps(TWO, { callRouteGuard: routeGuard }));
        expect(result.output).toBe(TWO);
        expect(result.route_guard).toMatchObject({ source: "local", action: "preserved", calls: ["get_weather", "get_time"] });
        expect(routeGuard).not.toHaveBeenCalled();
    });

    it("serves nothing for the same reply when not opted in", async () => {
        const result = await runInfer(routeArgs(), makeDeps(TWO));
        expect(result.output).toBe("NO_TOOL");
    });

    it("serves nothing when one of the calls invents a tool", async () => {
        const result = await runInfer(routeArgs({ allow_parallel_calls: true }),
            makeDeps(`${WEATHER}\n${call("triangle_area", { base: 10 })}`));
        expect(result.output).toBe("NO_TOOL");
        expect(result.route_guard).toMatchObject({ action: "suppressed", reason: "unadvertised_tool", original_tool: "triangle_area" });
    });
});
