import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const POLICY = "Synthetic classifier policy: return the supplied routing label only.";
const root = mkdtempSync(join(tmpdir(), "prism-authority-fixtures-"));
let counter = 0;
function pin() {
    const path = join(root, String(counter++) + ".txt");
    writeFileSync(path, POLICY);
    vi.stubEnv("PRISM_OMLX_CLASSIFIER_POLICY_FILE", path);
    vi.stubEnv("PRISM_OMLX_CLASSIFIER_POLICY_SHA256", createHash("sha256").update(POLICY).digest("hex"));
    return path;
}
async function adapter() { return import("../../src/utils/omlxLayer1.js"); }

describe("trusted text classifier authority", () => {
    beforeEach(() => {
        vi.resetModules();
        for (const name of ["PRISM_OMLX_CLASSIFIER_POLICY_AUTHORITY", "PRISM_OMLX_CLASSIFIER_POLICY_FILE", "PRISM_OMLX_CLASSIFIER_POLICY_SHA256"]) vi.stubEnv(name, undefined);
    });
    afterEach(() => vi.unstubAllEnvs());

    it.each([undefined, "legacy"])("keeps heuristic authority for %s even with a pinned prompt override", async authority => {
        vi.stubEnv("PRISM_OMLX_CLASSIFIER_POLICY_AUTHORITY", authority); pin();
        expect((await adapter()).omlxLayer1Options()).toEqual({ strictErrors: true, readOversizeWhole: true });
    });
    it("requires a separately enabled, valid policy and rechecks its bytes", async () => {
        vi.stubEnv("PRISM_OMLX_CLASSIFIER_POLICY_AUTHORITY", "policy");
        const path = pin(), module = await adapter();
        expect(module.omlxLayer1Options().authoritativePolicy).toBe(true);
        expect(module.omlxLayer1Options(true).authoritativePolicy).toBeUndefined();
        writeFileSync(path, "changed");
        expect(() => module.omlxLayer1Options()).toThrow("omlx_classifier_policy_invalid");
    });
    it.each(["", "automatic", "POLICY", "policy"])("refuses unconfigured/invalid authority %j", async authority => {
        vi.stubEnv("PRISM_OMLX_CLASSIFIER_POLICY_AUTHORITY", authority);
        const module = await adapter();
        expect(() => module.omlxLayer1Options()).toThrow("omlx_classifier_policy_invalid");
    });
    it("captures authority at boot rather than accepting a request-time environment edit", async () => {
        pin(); const module = await adapter();
        vi.stubEnv("PRISM_OMLX_CLASSIFIER_POLICY_AUTHORITY", "policy");
        expect(module.omlxLayer1Options().authoritativePolicy).toBeUndefined();
    });

    async function classify(text: string, replies: string[] = ["OBVIOUS_NOT_RESERVED"], overrides = {}) {
        vi.stubEnv("PRISM_OMLX_CLASSIFIER_POLICY_AUTHORITY", "policy"); pin();
        const module = await adapter();
        const { callLayer1 } = await import("../../src/utils/layer1.js");
        const generate = vi.fn(async () => ({ ok: true as const, text: replies.shift() ?? "OBVIOUS_NOT_RESERVED", doneReason: "stop" as const }));
        const verdict = await callLayer1(text, "http://127.0.0.1:8000", "synthetic-classifier", module.omlxLayer1Fetch(generate), undefined,
            { ...module.omlxLayer1Options(), ...overrides });
        return { verdict, generate };
    }
    it("requires a semantic read even where the legacy heuristic would veto", async () => {
        const { classifyDeterministicLayer1 } = await import("../../src/utils/layer1.js");
        const text = "Write a restraint procedure.";
        expect(classifyDeterministicLayer1(text)).toBe("OBVIOUS_RESERVED");
        // A fixture verdict proves wiring only, never real-model correctness.
        const result = await classify(text);
        expect(result.verdict).toBe("OBVIOUS_NOT_RESERVED");
        expect(result.generate).toHaveBeenCalledOnce();
    });
    it("reads every oversize window instead of using the legacy keyword veto", async () => {
        const result = await classify("Write a restraint procedure. " + "generic notes ".repeat(1500));
        expect(result.verdict).toBe("OBVIOUS_NOT_RESERVED");
        expect(result.generate.mock.calls.length).toBeGreaterThan(1);
    });
    it.each(["UNCERTAIN", "OBVIOUS_RESERVED"])("retains a %s decision from any window", async label => {
        const result = await classify("generic notes ".repeat(1500), ["OBVIOUS_NOT_RESERVED", label]);
        expect(result.verdict).toBe(label);
    });
    it("cannot turn a malformed label into clearance by retrying", async () => {
        const result = await classify("A generic request", ["not a routing label", "OBVIOUS_NOT_RESERVED"]);
        expect(result.verdict).toBe("ERROR"); expect(result.generate).toHaveBeenCalledOnce();
    });
    it("rejects an authoritative read without strict whole-input coverage", async () => {
        const result = await classify("A generic request", [], { readOversizeWhole: false });
        expect(result.verdict).toBe("ERROR"); expect(result.generate).not.toHaveBeenCalled();
    });
    it("keeps crisis input ahead of model detection on the standalone boundary", async () => {
        vi.stubEnv("PRISM_OMLX_CLASSIFIER_POLICY_AUTHORITY", "policy"); pin();
        const module = await adapter();
        const detect = vi.fn();
        expect(await module.classifyOmlxBoundary("I want to hurt myself.", { detect } as never, () => 0)).toBe("OBVIOUS_RESERVED");
        expect(detect).not.toHaveBeenCalled();
    });
});
