import { describe, it, expect, vi, beforeEach } from "vitest";
import { markSessionStart, fetchPortalInferenceMetrics } from "../src/utils/inferenceMetrics.js";

// Mock the JWT helper and config
vi.mock("../src/utils/synaluxJwt.js", () => ({
    getSynaluxJwt: vi.fn(async () => "mock-jwt"),
}));

vi.mock("../src/config.js", async (importOriginal) => {
    const actual = await importOriginal() as Record<string, unknown>;
    return { ...actual, PRISM_SYNALUX_BASE_URL: "https://test.synalux.ai" };
});

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
    vi.clearAllMocks();
    markSessionStart();
});

describe("fetchPortalInferenceMetrics", () => {
    it("returns empty string when portal returns 0 calls", async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ total_calls: 0 }),
        });
        const result = await fetchPortalInferenceMetrics();
        expect(result).toBe("");
    });

    it("formats portal response with local/cloud split", async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                total_calls: 12,
                local_calls: 10,
                cloud_calls: 2,
                local_pct: 83,
                cloud_pct: 17,
                total_prompt_tokens: 8420,
                total_completion_tokens: 3150,
                total_tokens: 11570,
                avg_latency_ms: 1240,
                by_model: {
                    "prism-coder:27b": { calls: 6, prompt_tokens: 5100, completion_tokens: 2100, total_latency_ms: 10800 },
                    "prism-coder:9b": { calls: 4, prompt_tokens: 1820, completion_tokens: 1050, total_latency_ms: 2480 },
                    "synalux-27b": { calls: 2, prompt_tokens: 1500, completion_tokens: 0, total_latency_ms: 2200 },
                },
            }),
        });

        const result = await fetchPortalInferenceMetrics();
        expect(result).toContain("Total calls: 12");
        expect(result).toContain("Local: 10 (83%)");
        expect(result).toContain("Cloud: 2 (17%)");
        expect(result).toContain("11,570 total");
        expect(result).toContain("1240ms");
        expect(result).toContain("By model:");
        expect(result).toContain("prism-coder:27b");
    });

    it("hides model breakdown for single model", async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                total_calls: 3,
                local_calls: 3,
                cloud_calls: 0,
                local_pct: 100,
                cloud_pct: 0,
                total_prompt_tokens: 300,
                total_completion_tokens: 100,
                total_tokens: 400,
                avg_latency_ms: 80,
                by_model: { "prism-coder:9b": { calls: 3, prompt_tokens: 300, completion_tokens: 100, total_latency_ms: 240 } },
            }),
        });

        const result = await fetchPortalInferenceMetrics();
        expect(result).toContain("Total calls: 3");
        expect(result).not.toContain("By model:");
    });

    it("returns empty string on portal error", async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 500 });
        const result = await fetchPortalInferenceMetrics();
        expect(result).toBe("");
    });

    it("returns empty string on network failure", async () => {
        mockFetch.mockRejectedValue(new Error("network error"));
        const result = await fetchPortalInferenceMetrics();
        expect(result).toBe("");
    });

    it("sends since param from session start", async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ total_calls: 0 }),
        });
        await fetchPortalInferenceMetrics();

        expect(mockFetch).toHaveBeenCalledOnce();
        const url = mockFetch.mock.calls[0][0] as string;
        expect(url).toContain("/api/v1/telemetry/inference-metrics?since=");
        expect(url).toContain("test.synalux.ai");
    });

    it("sends JWT auth header", async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ total_calls: 0 }),
        });
        await fetchPortalInferenceMetrics();

        const opts = mockFetch.mock.calls[0][1] as RequestInit;
        expect(opts.headers).toHaveProperty("Authorization", "Bearer mock-jwt");
    });

    it("returns empty string when no portal URL configured", async () => {
        const configModule = await import("../src/config.js");
        const original = configModule.PRISM_SYNALUX_BASE_URL;
        (configModule as any).PRISM_SYNALUX_BASE_URL = "";
        const result = await fetchPortalInferenceMetrics();
        expect(result).toBe("");
        (configModule as any).PRISM_SYNALUX_BASE_URL = original;
    });
});

describe("markSessionStart", () => {
    it("updates the since timestamp used in fetch", async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ total_calls: 0 }),
        });

        await fetchPortalInferenceMetrics();
        const url1 = mockFetch.mock.calls[0][0] as string;

        markSessionStart();
        await fetchPortalInferenceMetrics();
        const url2 = mockFetch.mock.calls[1][0] as string;

        const since1 = new URL(url1).searchParams.get("since")!;
        const since2 = new URL(url2).searchParams.get("since")!;
        expect(new Date(since2).getTime()).toBeGreaterThanOrEqual(new Date(since1).getTime());
    });
});
