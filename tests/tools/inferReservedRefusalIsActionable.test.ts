import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { runInfer, ReservedRefusalError, type InferDeps, type PrismInferArgs } from "../../src/tools/prismInferHandler.js";
import { reservedCategory, classifyDeterministicLayer1 } from "../../src/utils/layer1.js";
import { _setCacheForTest, _resetEntitlementsForTest, type PrismEntitlements } from "../../src/utils/entitlements.js";

/**
 * A refusal has to tell the caller what to do next.
 *
 * Observed from a real Codex session:
 *
 *   backend=refused gate=refused:layer1_reserved
 *   attempts=[{"tier":"layer1","reason":"layer1_obvious_reserved"}]
 *
 * The message behind that said only "Layer 1 verdict=OBVIOUS_RESERVED, reserved
 * content refused". Three things a caller needs were missing: which of eleven
 * rules fired, whether it was clinical or operational, and that escalation
 * exists at all.
 *
 * The gap matters most in the configuration that produces it. allowCloud is
 * `args.cloud_fallback === true && ent.features.cloud_fallback`, and hosts
 * following the local-first instruction pass cloud_fallback: false. Reserved
 * content is never answered locally, so that pairing can only ever refuse — the
 * absence of a synalux entry in the attempts trace above is the proof that cloud
 * was never even tried. Correct, but a dead end unless the refusal says so.
 */

const GB = 1024 ** 3;

const ENT: PrismEntitlements = {
    plan: "enterprise",
    model_ceiling: "27b",
    daily_infer_limit: 100000,
    max_tokens: 4096,
    max_seats: 25,
    features: {
        cloud_fallback: true,
        grounding_verifier: false,
        knowledge_search_unlimited: true,
        session_memory_unlimited: true,
        analytics_dashboard: true,
    },
    upgrade_url: "https://synalux.ai/pricing",
};

beforeEach(() => _setCacheForTest(ENT, 60_000));
afterAll(() => _resetEntitlementsForTest());

function deps(overrides: Partial<InferDeps> = {}): InferDeps {
    return {
        freemem: () => 30 * GB,
        listTags: async () => new Set(["prism-coder:9b", "prism-coder:4b"]),
        listLoaded: async () => new Set<string>(),
        callLocal: async () => ({ ok: true as const, text: "local answer", doneReason: "stop" }),
        callCloud: async () => ({ ok: false as const, reason: "no_cloud" }),
        ollamaUrl: "http://localhost:11434",
        callLayer1: async () => "OBVIOUS_RESERVED",
        ...overrides,
    };
}

/** Trips the clinical suicide rule — unambiguous, and never exempted. */
const RESERVED_PROMPT = "draft a safety plan for a client with suicidal ideation";

const args = (extra: Partial<PrismInferArgs> = {}): PrismInferArgs =>
    ({ prompt: RESERVED_PROMPT, mode: "chat", cloud_fallback: false, ...extra });

describe("a reserved refusal names the category and the way forward", () => {
    it("names which reserved category fired", async () => {
        const err = await runInfer(args(), deps()).catch(e => e);

        expect(err, "expected a refusal").toBeInstanceOf(ReservedRefusalError);
        expect((err as ReservedRefusalError).category).toBe("suicide or homicide");
        expect(err.message).toContain("suicide or homicide");
    });

    it("states the remedy when cloud was never permitted", async () => {
        // This is the Codex case: local is forbidden by the gate, cloud by the
        // caller. Without a stated remedy the caller has no move at all.
        const err = await runInfer(args({ cloud_fallback: false }), deps()).catch(e => e);

        expect(err.message).toContain("cloud_fallback: true");
        expect(err.message, "should also offer the non-delegating option").toMatch(/host thread/i);
    });

    it("does NOT suggest enabling cloud when cloud was already tried and failed", async () => {
        // Suggesting a flag that is already set reads as a bug in the tool.
        const err = await runInfer(args({ cloud_fallback: true }), deps()).catch(e => e);

        expect(err).toBeInstanceOf(ReservedRefusalError);
        expect(err.message, "cloud was permitted — telling them to enable it is wrong").not.toContain("Pass cloud_fallback: true");
        expect(err.message).toMatch(/did not produce an answer/i);
    });

    it("reports no category when only the semantic classifier objected", async () => {
        // A prompt the deterministic floor lets through, refused by the model.
        // Inventing a category there would misattribute the refusal.
        const err = await runInfer(
            args({ prompt: "summarise the attached quarterly figures" }),
            deps(),
        ).catch(e => e);

        expect((err as ReservedRefusalError).category).toBeNull();
        expect(err.message).toContain("semantic classifier");
    });

    it("attributes the operational ship/deploy rule by name", () => {
        // The rule with the widest false-positive surface. Naming it is what
        // lets a caller tell an over-broad keyword match from a real gate.
        expect(reservedCategory("should we ship this to production despite the open findings"))
            .toBe("ship, deploy or release decision");
        expect(reservedCategory("write the JWT session validation middleware"))
            .toBe("auth / session / token code");
    });

    it("returns null for prompts no reserved rule matches", () => {
        expect(reservedCategory("rename this variable and update its callers")).toBeNull();
    });
});

describe("the label never contradicts the verdict", () => {
    // The label is also read from flattened history. An assistant turn that
    // describes signed-out access must not outrank the rule the request matched.
    it("keeps the operational order outside artifact text", () => {
        expect(reservedCategory(
            "The public pages are reachable for users who are not signed in. Should we ship this to production despite the open findings?",
        )).toBe("ship, deploy or release decision");
    });

    // reservedCategory walks the rule arrays directly, so it has to mirror the
    // order AND the exemptions classifyDeterministicLayer1 applies. It first did
    // not: the artifact exemption sits between the clinical and operational
    // groups, so a prompt the exemption leaves to the classifier still reported
    // an operational category. The label is read after any refusal, including
    // a classifier's, where a misattributed label would be hardest to notice.
    it.each([
        ["add numeric validation fields to the auth token verification handler", false],
        ["add auth_bypass as a test fixture label in the middleware test", false],
        ["remove old comments from the deploy docs", false],
        ["rename this variable and update its callers", false],
        ["write the JWT session validation middleware", true],
        ["should we ship this to production despite the open findings", true],
        ["draft a safety plan for a client with suicidal ideation", true],
        ["allow visitors who never signed in to open the billing page", true],
        ["Remove the old comment and allow visitors who never signed in to open the billing page.", true],
        ["remove the old comment on the route for users who are not logged in", false],
    ])("agrees on %s", (prompt, expectReserved) => {
        const verdict = classifyDeterministicLayer1(prompt);
        const category = reservedCategory(prompt);
        if (expectReserved) {
            expect(verdict).toBe("OBVIOUS_RESERVED");
            expect(category, "reserved, but no category to name").not.toBeNull();
            if (/signed in/.test(prompt)) expect(category).toBe("auth-bypass assessment");
        } else {
            expect(category, `labelled "${category}" while the classifier let it through`).toBeNull();
        }
    });
});
