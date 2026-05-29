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
        expect(outcome.refusalClaim).toMatch(/8|patients/i);
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
            model: "prism-coder:4b",
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
        expect(outcome.finalText).toMatch(/can't ground "8 patients"/);
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
    it("defaults to prism-coder:4b", async () => {
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
        expect(body.model).toBe("prism-coder:4b");
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
