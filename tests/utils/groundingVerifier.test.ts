/**
 * groundingVerifier tests
 * ========================
 * Pins the contract for the prism_infer L3 grounding layer.
 */
import { describe, it, expect, vi } from "vitest";
import { verifyGrounding, draftHasAssertiveClaims, type EvidenceSnippet } from "../../src/utils/groundingVerifier.js";

function mockOllama(json: unknown, ok = true) {
    return vi.fn(async () => ({
        ok,
        status: ok ? 200 : 500,
        json: async () => ({
            choices: [{ message: { content: JSON.stringify(json) } }],
        }),
    }) as Response);
}

describe("draftHasAssertiveClaims — pre-check", () => {
    it("flags drafts with numbers", () => {
        expect(draftHasAssertiveClaims("You have 8 items.")).toBe(true);
    });
    it("flags drafts with ICD codes", () => {
        expect(draftHasAssertiveClaims("Diagnosis: F84.0")).toBe(true);
    });
    it("flags drafts with two-word capitalized names", () => {
        expect(draftHasAssertiveClaims("Patient: John Smith")).toBe(true);
    });
    it("flags drafts with dates", () => {
        expect(draftHasAssertiveClaims("Last seen on 2026-05-25")).toBe(true);
    });
    it("flags drafts with dollar amounts", () => {
        expect(draftHasAssertiveClaims("Balance: $1,400")).toBe(true);
    });
    it("does NOT flag conversational text", () => {
        expect(draftHasAssertiveClaims("Hello! How can I help?")).toBe(false);
        expect(draftHasAssertiveClaims("I can draft notes for you.")).toBe(false);
        expect(draftHasAssertiveClaims("")).toBe(false);
    });
});

describe("verifyGrounding — Tier 0 short-circuit", () => {
    it("serves draft when there are no assertive claims (no verifier call)", async () => {
        const fetchImpl = vi.fn();
        const outcome = await verifyGrounding({
            draft: "Hello! How can I help?",
            evidence: [],
            fetchImpl: fetchImpl as any,
        });
        expect(outcome.action).toBe("served");
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe("verifyGrounding — fail-closed when evidence missing", () => {
    it("refuses an assertive draft with NO evidence (no verifier call)", async () => {
        const fetchImpl = vi.fn();
        const outcome = await verifyGrounding({
            draft: "You have 8 patients in your caseload.",
            evidence: [],
            fetchImpl: fetchImpl as any,
        });
        expect(outcome.action).toBe("refused_no_evidence");
        expect(outcome.refusalClaim).toBe("[unverifiable claim]");
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe("verifyGrounding — NLI verifier path", () => {
    const evidence: EvidenceSnippet[] = [
        { source: "tool:count_records#0", content: '{"table":"patients","count":0}' },
    ];

    it("serves draft when verifier returns ENTAILED for all claims", async () => {
        const fetchImpl = mockOllama({
            claims: [{ text: "0 patients", verdict: "ENTAILED", evidence_span: "count: 0" }],
        });
        const outcome = await verifyGrounding({
            draft: "You have 0 patients.",
            evidence,
            fetchImpl: fetchImpl as any,
        });
        expect(outcome.action).toBe("served");
        expect(outcome.verifierChain[0]).toMatchObject({
            model: "qwen3.5:4b",
            verdict: "ENTAILED",
        });
    });

    it("refuses on CONTRADICTED and names the failed claim", async () => {
        const fetchImpl = mockOllama({
            claims: [{ text: "8 patients", verdict: "CONTRADICTED", evidence_span: null }],
        });
        const outcome = await verifyGrounding({
            draft: "You have 8 patients in your caseload.",
            evidence,
            fetchImpl: fetchImpl as any,
        });
        expect(outcome.action).toBe("refused_fabricated");
        expect(outcome.refusalClaim).toBe("8 patients");
        expect(outcome.finalText).toMatch(/couldn't verify|evidence/i);
    });

    it("refuses on NEUTRAL (claim not in evidence)", async () => {
        const fetchImpl = mockOllama({
            claims: [{ text: "John Smith", verdict: "NEUTRAL", evidence_span: null }],
        });
        const outcome = await verifyGrounding({
            draft: "John Smith is your next appointment.",
            evidence,
            fetchImpl: fetchImpl as any,
        });
        expect(outcome.action).toBe("refused_fabricated");
        expect(outcome.refusalClaim).toBe("John Smith");
    });

    it("refuses if any one of several claims fails", async () => {
        const fetchImpl = mockOllama({
            claims: [
                { text: "0 patients", verdict: "ENTAILED", evidence_span: "count: 0" },
                { text: "8 sessions", verdict: "CONTRADICTED", evidence_span: null },
            ],
        });
        const outcome = await verifyGrounding({
            draft: "You have 0 patients but 8 sessions.",
            evidence,
            fetchImpl: fetchImpl as any,
        });
        expect(outcome.action).toBe("refused_fabricated");
        expect(outcome.refusalClaim).toBe("8 sessions");
    });
});

describe("verifyGrounding — failure modes (fail-closed)", () => {
    const evidence: EvidenceSnippet[] = [{ source: "x", content: "y" }];

    it("refuses on verifier HTTP error", async () => {
        const fetchImpl = mockOllama({}, false);
        const outcome = await verifyGrounding({
            draft: "You have 8 patients.",
            evidence,
            fetchImpl: fetchImpl as any,
        });
        expect(outcome.action).toBe("refused_timeout");
    });

    it("refuses on malformed verifier JSON (no `claims` key)", async () => {
        const fetchImpl = mockOllama({ /* missing claims */ });
        const outcome = await verifyGrounding({
            draft: "You have 8 patients.",
            evidence,
            fetchImpl: fetchImpl as any,
        });
        expect(outcome.action).toBe("refused_timeout");
    });

    it("refuses on verifier network failure", async () => {
        const fetchImpl = vi.fn(async () => { throw new Error("connection refused"); });
        const outcome = await verifyGrounding({
            draft: "You have 8 patients.",
            evidence,
            fetchImpl: fetchImpl as any,
        });
        expect(outcome.action).toBe("refused_timeout");
    });
});

describe("verifyGrounding — verifier model defaults", () => {
    it("defaults to qwen3.5:4b", async () => {
        const fetchImpl = mockOllama({
            claims: [{ text: "0 items", verdict: "ENTAILED", evidence_span: "0" }],
        });
        await verifyGrounding({
            draft: "There are 0 items.",
            evidence: [{ source: "x", content: "0 items" }],
            fetchImpl: fetchImpl as any,
        });
        const call = (fetchImpl as any).mock.calls[0];
        const body = JSON.parse(call[1].body);
        expect(body.model).toBe("qwen3.5:4b");
    });

    it("honours an explicit verifier model override", async () => {
        const fetchImpl = mockOllama({
            claims: [{ text: "0 items", verdict: "ENTAILED", evidence_span: "0" }],
        });
        await verifyGrounding({
            draft: "There are 0 items.",
            evidence: [{ source: "x", content: "0 items" }],
            verifierModel: "prism-coder:8b",
            fetchImpl: fetchImpl as any,
        });
        const call = (fetchImpl as any).mock.calls[0];
        const body = JSON.parse(call[1].body);
        expect(body.model).toBe("prism-coder:8b");
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Incident regression — error visibility (2026-06-14)
//
// The verifier logged failures via debugLog() which is silent unless
// DEBUG=true. Operators couldn't see why every turn was being refused.
// Fix: console.error() so failures are always visible.
// ─────────────────────────────────────────────────────────────────────────

describe("verifyGrounding — error visibility (2026-06-14 incident)", () => {
    it("logs to console.error when verifier model fails (HTTP error)", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const fetchImpl = mockOllama({}, false);
        await verifyGrounding({
            draft: "You have 8 patients.",
            evidence: [{ source: "x", content: "y" }],
            fetchImpl: fetchImpl as any,
        });
        expect(errorSpy).toHaveBeenCalledOnce();
        expect(errorSpy.mock.calls[0][0]).toMatch(/groundingVerifier.*failed/i);
        errorSpy.mockRestore();
    });

    it("logs to console.error when verifier throws network error", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
        await verifyGrounding({
            draft: "You have 8 patients.",
            evidence: [{ source: "x", content: "y" }],
            fetchImpl: fetchImpl as any,
        });
        expect(errorSpy).toHaveBeenCalledOnce();
        expect(errorSpy.mock.calls[0][0]).toMatch(/ECONNREFUSED/);
        errorSpy.mockRestore();
    });

    it("includes the model name in the error log", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const fetchImpl = vi.fn(async () => { throw new Error("model not found"); });
        await verifyGrounding({
            draft: "Patient: John Smith",
            evidence: [{ source: "x", content: "y" }],
            verifierModel: "prism-coder:1b7",
            fetchImpl: fetchImpl as any,
        });
        expect(errorSpy.mock.calls[0][0]).toMatch(/prism-coder:1b7/);
        errorSpy.mockRestore();
    });

    it("does NOT log to console.error on successful verification", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const fetchImpl = mockOllama({
            claims: [{ text: "0 items", verdict: "ENTAILED", evidence_span: "0" }],
        });
        await verifyGrounding({
            draft: "There are 0 items.",
            evidence: [{ source: "x", content: "0 items" }],
            fetchImpl: fetchImpl as any,
        });
        expect(errorSpy).not.toHaveBeenCalled();
        errorSpy.mockRestore();
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Adversarial — edge cases that could break the verifier chain
// ─────────────────────────────────────────────────────────────────────────

describe("verifyGrounding — adversarial edge cases", () => {
    it("refuses when verifier returns invalid verdict string", async () => {
        const fetchImpl = mockOllama({
            claims: [{ text: "8 patients", verdict: "PROBABLY_TRUE", evidence_span: null }],
        });
        const outcome = await verifyGrounding({
            draft: "You have 8 patients.",
            evidence: [{ source: "x", content: '{"count":8}' }],
            fetchImpl: fetchImpl as any,
        });
        expect(outcome.action).toBe("refused_fabricated");
    });

    it("refuses when verifier returns empty claims array (C3: fail-closed)", async () => {
        const fetchImpl = mockOllama({ claims: [] });
        const outcome = await verifyGrounding({
            draft: "You have 8 patients.",
            evidence: [{ source: "x", content: '{"count":8}' }],
            fetchImpl: fetchImpl as any,
        });
        expect(outcome.action).toBe("refused_timeout");
        expect(outcome.verifierChain[0].verdict).toBe("NEUTRAL");
    });

    it("records the model in verifierChain even on failure", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const fetchImpl = vi.fn(async () => { throw new Error("connection refused"); });
        const outcome = await verifyGrounding({
            draft: "Patient: Jane Doe",
            evidence: [{ source: "x", content: "y" }],
            verifierModel: "prism-coder:99b",
            fetchImpl: fetchImpl as any,
        });
        expect(outcome.verifierChain[0].model).toBe("prism-coder:99b");
        expect(outcome.verifierChain[0].latencyMs).toBeGreaterThanOrEqual(0);
        errorSpy.mockRestore();
    });

    it("never serves an unverified draft after model failure", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
        const dangerousDraft = "Jane Doe (DOB 1985-03-12) has F84.0 and 8 active sessions.";
        const outcome = await verifyGrounding({
            draft: dangerousDraft,
            evidence: [{ source: "x", content: "y" }],
            fetchImpl: fetchImpl as any,
        });
        expect(outcome.action).not.toBe("served");
        expect(outcome.finalText).not.toBe(dangerousDraft);
        errorSpy.mockRestore();
    });

    it("refuses mixed ENTAILED + CONTRADICTED claims (one bad = all refused)", async () => {
        const fetchImpl = mockOllama({
            claims: [
                { text: "0 patients", verdict: "ENTAILED", evidence_span: "count: 0" },
                { text: "8 sessions", verdict: "CONTRADICTED", evidence_span: null },
            ],
        });
        const outcome = await verifyGrounding({
            draft: "You have 0 patients but 8 sessions.",
            evidence: [{ source: "x", content: '{"patients":0,"sessions":3}' }],
            fetchImpl: fetchImpl as any,
        });
        expect(outcome.action).toBe("refused_fabricated");
        expect(outcome.refusalClaim).toBe("8 sessions");
    });
});
