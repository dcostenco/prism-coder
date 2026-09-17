/**
 * The bare-generic repair, through runInfer rather than through the policy
 * functions alone.
 *
 * The unit tests prove the detector and the repair. They do NOT prove the
 * handler reaches them: the repair loop gates on the gate reason's prefix, and
 * a `ts_` reason had to be added to a list that previously held only `code_`
 * and `python_`. A live check could not settle it either — the model writes
 * correct types often enough that a passing run says nothing.
 *
 * So the model is mocked to emit exactly what prism-coder:9b emits, and the
 * assertion is that a caller receives repaired, compiling code.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { runInfer, type InferDeps } from "../../src/tools/prismInferHandler.js";
import { _setCacheForTest, _resetEntitlementsForTest, type PrismEntitlements } from "../../src/utils/entitlements.js";

const GB = 1024 ** 3;

const DEFECTIVE = [
    "```typescript",
    "export class EventEmitter {",
    "  private listeners: Map<string, Array> = new Map();",
    "  on(event: string, listener: Function) {",
    "    this.listeners.set(event, []);",
    "  }",
    "}",
    "```",
].join("\n");

const ent: PrismEntitlements = {
    plan: "enterprise",
    model_ceiling: "27b",
    daily_infer_limit: 100_000,
    max_tokens: 4096,
    max_seats: 25,
    multi_turn: { enabled: true, max_turns: 12, max_chars: 32_000 },
    features: {
        cloud_fallback: false,
        grounding_verifier: false,
        knowledge_search_unlimited: true,
        session_memory_unlimited: true,
        analytics_dashboard: true,
    },
    upgrade_url: "https://synalux.ai/pricing",
};

beforeEach(() => _setCacheForTest(ent, 60_000));
afterAll(() => _resetEntitlementsForTest());

function deps(text: string, overrides: Partial<InferDeps> = {}): InferDeps {
    return {
        freemem: () => 30 * GB,
        listTags: async () => new Set(["prism-coder:9b", "prism-coder:4b", "prism-coder:2b"]),
        listLoaded: async () => new Set<string>(),
        callLocal: vi.fn(async () => ({ ok: true as const, text, doneReason: "stop" })),
        callCloud: vi.fn(async () => ({ ok: false as const, reason: "no_cloud" })),
        ollamaUrl: "http://localhost:11434",
        callLayer1: vi.fn(async () => "OBVIOUS_NOT_RESERVED" as const),
        probeNumCtx: async () => null,
        ...overrides,
    } as InferDeps;
}

const ASK = { prompt: "Write a typed EventEmitter class in TypeScript with on and emit.", mode: "code" as const };

describe("a bare generic is repaired before the caller sees it", () => {
    it("returns parameterised code, not the model's TS2314", async () => {
        const r = await runInfer({ ...ASK, cloud_fallback: false }, deps(DEFECTIVE));
        expect(r.output).toContain("Map<string, Array<any>>");
        expect(r.output).not.toMatch(/Array\s*>/);
    });

    it("records the deterministic repair in attempts, so it is auditable", async () => {
        const r = await runInfer({ ...ASK, cloud_fallback: false }, deps(DEFECTIVE));
        expect(JSON.stringify(r.attempts)).toContain("bare_generic");
    });

    it("serves the repaired output as a pass, not as a degraded result", async () => {
        const r = await runInfer({ ...ASK, escalation: "report", cloud_fallback: false }, deps(DEFECTIVE));
        expect(r.quality_gate_failed).toBeUndefined();
    });

    it("leaves already-correct code untouched and records no repair", async () => {
        const good = DEFECTIVE.replace("Array>", "Array<Function>>");
        const r = await runInfer({ ...ASK, cloud_fallback: false }, deps(good));
        expect(r.output).toContain("Array<Function>");
        expect(JSON.stringify(r.attempts)).not.toContain("bare_generic");
    });

    it("does not re-prompt the model when the deterministic repair suffices", async () => {
        const d = deps(DEFECTIVE);
        await runInfer({ ...ASK, cloud_fallback: false }, d);
        // One generation only: a string substitution must not cost a second call.
        expect((d.callLocal as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    });
});
