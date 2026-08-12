import { describe, expect, it, vi } from "vitest";
import {
    runInfer,
    type InferDeps,
    type PrismInferArgs,
} from "../../src/tools/prismInferHandler.js";
import type { PrismEntitlements } from "../../src/utils/entitlements.js";

import { spawnSync } from "node:child_process";

/**
 * The coding gate detects Python syntax errors by shelling out to python3/python
 * with a 2s budget; when no interpreter starts in time it reports "no syntax
 * failure" and the repair loop takes a different path with an extra model call.
 * Tests that assert the interpreter-backed path must therefore state that
 * dependency instead of inheriting it silently — on Windows CI a cold spawn
 * exceeded the budget and the two-response mock returned undefined, surfacing
 * as "Cannot read properties of undefined (reading 'ok')" (4 rerun cycles,
 * 2026-08-11) rather than as the missing-interpreter fact it was.
 */
const PYTHON_AVAILABLE = ["python3", "python"].some((command) => {
    const probe = spawnSync(command, ["-c", "print(1)"], { encoding: "utf8", timeout: 5_000, windowsHide: true });
    return !probe.error && probe.status === 0;
});

const GB = 1024 ** 3;
const INSTALLED = new Set(["prism-coder:9b"]);
const ENTITLEMENTS: PrismEntitlements = {
    plan: "enterprise",
    model_ceiling: "27b",
    daily_infer_limit: 100_000,
    max_tokens: 4_096,
    max_seats: 25,
    features: {
        cloud_fallback: true,
        grounding_verifier: true,
        knowledge_search_unlimited: true,
        session_memory_unlimited: true,
        analytics_dashboard: true,
    },
    upgrade_url: "https://synalux.ai/pricing",
};

const PROMPT =
    "Implement class TrieNode with a valid Python constructor. " +
    "Return only the implementation source code.";
const BAD_DRAFT =
    "class TrieNode:\n" +
    "    def __init__():\n" +
    "        self.children = {}";
const GOOD_DRAFT =
    "class TrieNode:\n" +
    "    def __init__(self):\n" +
    "        self.children = {}";
const SYNTAX_BAD_DRAFT =
    "```python\n" +
    "class TrieNode:\n" +
    "    def __init__:\n" +
    "        self.children = {}\n" +
    "```";
const STATIC_BAD_DRAFT =
    "class TrieNode:\n" +
    "    def __init__(self):\n" +
    "        self.children = {}\n" +
    "        active = False\n\n" +
    "    def is_active(self):\n" +
    "        return self.active";

function args(extra: Partial<PrismInferArgs> = {}): PrismInferArgs {
    return {
        prompt: PROMPT,
        mode: "code",
        model_ceiling: "9b",
        escalation: "report",
        ...extra,
    };
}

function deps(overrides: Partial<InferDeps> = {}): InferDeps {
    return {
        freemem: () => 16 * GB,
        listTags: async () => INSTALLED,
        listLoaded: async () => new Set<string>(),
        callLocal: vi.fn(async () => ({ ok: true as const, text: GOOD_DRAFT })),
        callCloud: vi.fn(async () => ({
            ok: true,
            output: GOOD_DRAFT,
            backend: "gemini-3.6-flash",
        })),
        ollamaUrl: "http://127.0.0.1:11434",
        entitlements: ENTITLEMENTS,
        callLayer1: vi.fn(async () => "OBVIOUS_NOT_RESERVED" as const),
        ...overrides,
    };
}

describe("prism_infer coding quality gate", () => {
    it("repairs a structurally broken local implementation on the same tier", async () => {
        const callLocal = vi
            .fn()
            .mockResolvedValueOnce({ ok: true as const, text: BAD_DRAFT })
            .mockResolvedValueOnce({ ok: true as const, text: GOOD_DRAFT });
        const result = await runInfer(args(), deps({ callLocal }));

        expect(callLocal).toHaveBeenCalledTimes(2);
        expect(callLocal.mock.calls[0][1]).toBe("prism-coder:9b");
        expect(callLocal.mock.calls[1][1]).toBe("prism-coder:9b");
        expect(callLocal.mock.calls[1][2]).toContain("<failed_gate>python_method_missing_receiver</failed_gate>");
        expect(result.output).toBe(GOOD_DRAFT);
        expect(result.used_cloud).toBe(false);
        expect(result.gate_outcome).toEqual({ status: "success", served_anyway: false });
        expect(result.attempts).toContainEqual({
            tier: "prism-coder:9b",
            reason: "code_repair:python_method_missing_receiver",
        });
    });

    it.skipIf(!PYTHON_AVAILABLE)("can repair a syntax defect and then a newly exposed structural defect", async () => {
        const callLocal = vi
            .fn()
            .mockResolvedValueOnce({ ok: true as const, text: SYNTAX_BAD_DRAFT })
            .mockResolvedValueOnce({ ok: true as const, text: STATIC_BAD_DRAFT })
            // A third call means the gate took a path this test does not model.
            // Without this the mock returns undefined and the failure surfaces
            // as an unreadable property deref instead of naming what happened.
            .mockImplementation(async () => {
                throw new Error("callLocal invoked a 3rd time: the repair loop took an unmodelled path (interpreter-backed syntax gate likely inactive)");
            });
        const result = await runInfer(args(), deps({ callLocal }));

        expect(callLocal).toHaveBeenCalledTimes(2);
        expect(callLocal.mock.calls[1][2]).toContain(
            "<failed_gate>python_syntax_error</failed_gate>",
        );
        expect(result.output).toContain("self.active = False");
        expect(result.attempts).toContainEqual({
            tier: "prism-coder:9b",
            reason: "code_repair_deterministic:constructor_attribute_missing_receiver",
        });
        expect(result.gate_outcome).toEqual({ status: "success", served_anyway: false });
    });

    it("escalates to the configured cloud backend after a failed local repair", async () => {
        const callLocal = vi.fn(async () => ({ ok: true as const, text: BAD_DRAFT }));
        const callCloud = vi.fn(async () => ({
            ok: true,
            output: GOOD_DRAFT,
            backend: "gemini-3.6-flash",
        }));
        const result = await runInfer(
            args({ cloud_fallback: true }),
            deps({ callLocal, callCloud }),
        );

        expect(callLocal).toHaveBeenCalledTimes(3);
        expect(callCloud).toHaveBeenCalledOnce();
        expect(result.backend).toBe("gemini-3.6-flash");
        expect(result.used_cloud).toBe(true);
        expect(result.attempts).toContainEqual({
            tier: "prism-coder:9b",
            reason: "code_repair_failed:python_method_missing_receiver",
        });
    });

    it("reports a degraded local result when repair fails and cloud fallback is disabled", async () => {
        const callLocal = vi.fn(async () => ({ ok: true as const, text: BAD_DRAFT }));
        const result = await runInfer(
            args({ cloud_fallback: false }),
            deps({ callLocal }),
        );

        expect(callLocal).toHaveBeenCalledTimes(3);
        expect(result.used_cloud).toBe(false);
        expect(result.quality_gate_failed).toBe(true);
        expect(result.gate_outcome).toEqual({
            status: "degraded",
            reason: "python_method_missing_receiver",
            served_anyway: true,
        });
    });

    it("does not apply implementation checks to route mode", async () => {
        const callLocal = vi.fn(async () => ({ ok: true as const, text: BAD_DRAFT }));
        const result = await runInfer(
            args({ mode: "route", max_tokens: 32 }),
            deps({ callLocal }),
        );

        expect(callLocal).toHaveBeenCalledOnce();
        expect(result.quality_gate_failed).toBeUndefined();
    });
});
