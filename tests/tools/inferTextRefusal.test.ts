import { describe, it, expect } from "vitest";
import { ReservedRefusalError } from "../../src/tools/prismInferHandler.js";
import { fileURLToPath } from "node:url";

/**
 * A Layer 1 refusal must never be reported as "no local answer".
 *
 * Callers of the old `callLocalLlm` helper treated null as unavailability and
 * responded by trying the cloud for ledger content when cloud fallback
 * was allowed. When inferText caught
 * every throw into null, a reserved-content refusal became indistinguishable
 * from "Ollama is down", so the classifier's refusal was the trigger for the
 * cloud disclosure it exists to prevent.
 *
 * That is a fail-open in a reserved category, and it was introduced by routing
 * these callers through the ladder — before, there was no Layer 1 at all, so
 * there was no refusal to lose. Adding screening whose "no" is discarded is
 * worse than no screening, because it reads as protection.
 */
describe("inferText fails CLOSED on a reserved-content refusal", () => {
    it("ReservedRefusalError is exported and identifiable by type", () => {
        // The check must not be a regex over the message — a reworded error
        // would silently reopen the hole.
        const err = new ReservedRefusalError("RESERVED", [{ tier: "layer1", reason: "layer1_reserved" }]);
        expect(err).toBeInstanceOf(ReservedRefusalError);
        expect(err).toBeInstanceOf(Error);
        expect(err.refusal_reason).toBe("layer1_reserved");
    });

    it("the handler source rethrows the refusal instead of returning null", async () => {
        // Asserted against the source because inferText builds its own
        // production deps (live Ollama, real entitlements) and cannot be driven
        // from a unit test without a network. The invariant being pinned is
        // structural: the catch block must not swallow this error type.
        const { readFileSync } = await import("node:fs");
        const src = readFileSync(
            fileURLToPath(new URL("../../src/tools/prismInferHandler.ts", import.meta.url)),
            "utf8",
        );
        const catchBlock = src.slice(src.indexOf("export async function inferText"));
        const body = catchBlock.slice(0, catchBlock.indexOf("\n}"));

        expect(body, "inferText no longer rethrows reserved refusals")
            .toMatch(/err instanceof ReservedRefusalError[\s\S]*?throw err/);
        // And the null return must still exist for genuine unavailability.
        expect(body).toMatch(/return null/);
    });

    it("compaction routes local summaries through inferText", async () => {
        const { readFileSync } = await import("node:fs");
        const src = readFileSync(
            fileURLToPath(new URL("../../src/tools/compactionHandler.ts", import.meta.url)),
            "utf8",
        );
        expect(src).toMatch(/const localResponse = await inferText/);
        expect(src, "compaction reintroduced a direct local-LLM call")
            .not.toMatch(/callLocalLlm/);
    });
});
