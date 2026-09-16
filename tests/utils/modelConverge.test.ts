/**
 * Tests — model convergence (the missing half of self-update).
 *
 * The failure modes these pin were all OBSERVED on 2026-08-18:
 * - a laptop kept vision-less models for four days after the registry was
 *   fixed (no convergence existed at all)
 * - prism-coder:2b on the authoring machine was a stale `ollama cp`
 *   snapshot pointing at different bytes than its source
 * - registry digest comparison is not implementable client-side (no
 *   docker-content-digest header; manifest body hash ≠ ollama's digest),
 *   which is why freshness is delegated to `ollama pull`.
 */

import { describe, it, expect, vi } from "vitest";
import { convergeModels, type TagInfo } from "../../src/utils/modelConverge.js";

function harness(tagsSequence: TagInfo[][], opts: { pullFails?: string[] } = {}) {
    let call = 0;
    const pulls: string[] = [];
    const copies: Array<[string, string]> = [];
    const logs: string[] = [];
    const deps = {
        listTags: vi.fn(async () => tagsSequence[Math.min(call++, tagsSequence.length - 1)]),
        pull: vi.fn(async (ref: string) => {
            pulls.push(ref);
            if (opts.pullFails?.includes(ref)) throw new Error(`pull failed: ${ref}`);
        }),
        copy: vi.fn(async (from: string, to: string) => { copies.push([from, to]); }),
        log: (l: string) => logs.push(l),
    };
    return { deps, pulls, copies, logs };
}

const T = (name: string, digest: string): TagInfo => ({ name, digest });

describe("convergeModels", () => {
    it("repairs a stale alias — the ollama cp snapshot trap, observed live", async () => {
        // 2b alias points at OLD bytes; source is current. Post-pull state
        // unchanged (pull was a no-op) — the alias must still be re-cp'd.
        const state = [
            T("dcostenco/prism-coder:2b", "new222"),
            T("prism-coder:2b", "old111"),
        ];
        const { deps, copies } = harness([state, state]);
        const out = await convergeModels(deps);

        expect(copies).toContainEqual(["dcostenco/prism-coder:2b", "prism-coder:2b"]);
        expect(out.find(o => o.tier === "2b")?.action).toBe("aliased_only");
    });

    it("pull that changes bytes re-aliases and reports pulled_and_aliased", async () => {
        const before = [T("dcostenco/prism-coder:4b", "aaa"), T("prism-coder:4b", "aaa")];
        const after = [T("dcostenco/prism-coder:4b", "bbb"), T("prism-coder:4b", "aaa")];
        const { deps, copies } = harness([before, after]);
        const out = await convergeModels(deps);

        expect(copies).toContainEqual(["dcostenco/prism-coder:4b", "prism-coder:4b"]);
        expect(out.find(o => o.tier === "4b")?.action).toBe("pulled_and_aliased");
    });

    it("up-to-date tier does nothing but a pull check", async () => {
        const state = [T("dcostenco/prism-coder:9b", "same"), T("prism-coder:9b", "same")];
        const { deps, pulls, copies } = harness([state, state]);
        const out = await convergeModels(deps);

        expect(pulls).toContain("dcostenco/prism-coder:9b");
        expect(copies).toHaveLength(0);
        expect(out.find(o => o.tier === "9b")?.action).toBe("up_to_date");
    });

    it("never pulls tiers the machine did not install", async () => {
        const state = [T("dcostenco/prism-coder:4b", "x"), T("prism-coder:4b", "x")];
        const { deps, pulls } = harness([state, state]);
        const out = await convergeModels(deps);

        expect(pulls).toEqual(["dcostenco/prism-coder:4b"]);
        expect(out.find(o => o.tier === "27b")?.action).toBe("skipped_not_installed");
        expect(out.find(o => o.tier === "2b")?.action).toBe("skipped_not_installed");
    });

    it("an alias with no source still converges — pull creates the source, then aliases", async () => {
        // A machine that only ever had the local alias (pre-namespace installs).
        const before = [T("prism-coder:4b", "old")];
        const after = [T("prism-coder:4b", "old"), T("dcostenco/prism-coder:4b", "fresh")];
        const { deps, copies } = harness([before, after]);
        const out = await convergeModels(deps);

        expect(copies).toContainEqual(["dcostenco/prism-coder:4b", "prism-coder:4b"]);
        expect(out.find(o => o.tier === "4b")?.action).toBe("pulled_and_aliased");
    });

    it("one tier failing does not stop the others", async () => {
        const state = [
            T("dcostenco/prism-coder:2b", "a"), T("prism-coder:2b", "a"),
            T("dcostenco/prism-coder:4b", "b"), T("prism-coder:4b", "b"),
        ];
        const { deps, pulls } = harness([state, state, state], { pullFails: ["dcostenco/prism-coder:2b"] });
        const out = await convergeModels(deps);

        expect(out.find(o => o.tier === "2b")?.action).toBe("failed");
        expect(pulls).toContain("dcostenco/prism-coder:4b");
        expect(out.find(o => o.tier === "4b")?.action).toBe("up_to_date");
    });

    it("Ollama unreachable skips convergence without throwing — models never break connect", async () => {
        const deps = {
            listTags: vi.fn(async () => { throw new Error("ECONNREFUSED"); }),
            pull: vi.fn(), copy: vi.fn(), log: vi.fn(),
        };
        const out = await convergeModels(deps);
        expect(out.every(o => o.action === "failed")).toBe(true);
        expect(deps.pull).not.toHaveBeenCalled();
    });

    it("dry run reports intent and executes nothing", async () => {
        const state = [T("dcostenco/prism-coder:4b", "x"), T("prism-coder:4b", "STALE")];
        const { deps, pulls, copies, logs } = harness([state]);
        (deps as any).dryRun = true;
        await convergeModels({ ...deps, dryRun: true });

        expect(pulls).toHaveLength(0);
        expect(copies).toHaveLength(0);
        expect(logs.some(l => l.includes("would pull"))).toBe(true);
    });
});

// ── Local pins survive convergence (found 2026-09-15, before it bit) ──────
//
// scripts/prism-coder-9b.Modelfile rebuilds prism-coder:9b FROM the same weights
// with `PARAMETER num_ctx 32768`. That changes the manifest digest and nothing
// else. The digest rule above would have called the alias stale and cp'd the
// unpinned upstream over it on the next converge — silently undoing the pin.

describe("convergeModels — local num_ctx pins", () => {
    const facts = (table: Record<string, { weightsBlob: string; pinnedNumCtx: number | null }>) =>
        vi.fn(async (name: string) => table[name] ?? null);

    it("a pinned alias on the SAME weights is left alone, not re-aliased", async () => {
        const state = [T("dcostenco/prism-coder:9b", "e8b71"), T("prism-coder:9b", "d48df")];
        const { deps, copies, logs } = harness([state, state]);
        const out = await convergeModels({ ...deps, tagFacts: facts({
            "prism-coder:9b": { weightsBlob: "sha256-1c72", pinnedNumCtx: 32768 },
            "dcostenco/prism-coder:9b": { weightsBlob: "sha256-1c72", pinnedNumCtx: null },
        }) });
        expect(copies, "the pinned alias was overwritten").toEqual([]);
        expect(out.find(o => o.tier === "9b")).toEqual({ tier: "9b", action: "up_to_date", detail: "locally_pinned" });
        expect(logs.some(l => l.includes("local pin"))).toBe(true);
    });

    it("a pinned alias on OLD weights is rebuilt, and the lost pin is announced with the re-adopt command", async () => {
        const state = [T("dcostenco/prism-coder:9b", "new99"), T("prism-coder:9b", "d48df")];
        const { deps, copies, logs } = harness([state, state]);
        const out = await convergeModels({ ...deps, tagFacts: facts({
            "prism-coder:9b": { weightsBlob: "sha256-OLD", pinnedNumCtx: 32768 },
            "dcostenco/prism-coder:9b": { weightsBlob: "sha256-NEW", pinnedNumCtx: null },
        }) });
        expect(copies).toContainEqual(["dcostenco/prism-coder:9b", "prism-coder:9b"]);
        expect(out.find(o => o.tier === "9b")?.detail).toBe("pin_dropped_readopt");
        expect(logs.some(l => l.includes("ollama create prism-coder:9b -f scripts/prism-coder-9b.Modelfile"))).toBe(true);
    });

    it("with tagFacts present but /api/show unavailable, a digest-mismatched alias is LEFT ALONE and reported", async () => {
        const state = [T("dcostenco/prism-coder:9b", "e8b71"), T("prism-coder:9b", "d48df")];
        const { deps, copies, logs } = harness([state, state]);
        const out = await convergeModels({ ...deps, tagFacts: async () => null });
        expect(copies).not.toContainEqual(["dcostenco/prism-coder:9b", "prism-coder:9b"]);
        expect(out.find(o => o.tier === "9b")?.detail).toBe("tag_facts_unavailable_pin_unknown");
        expect(logs.some(l => l.includes("left alone"))).toBe(true);
    });

    it("convergeFailed: one failed tier on a one-tier host is a failure, even beside three skipped_not_installed", async () => {
        const { convergeFailed } = await import("../../src/utils/modelConverge.js");
        expect(convergeFailed([
            { action: "failed" }, { action: "skipped_not_installed" }, { action: "skipped_not_installed" }, { action: "skipped_not_installed" },
        ])).toBe(true);
        expect(convergeFailed([{ action: "up_to_date" }, { action: "skipped_not_installed" }])).toBe(false);
    });

    it("without tagFacts the digest rule still applies (unchanged behaviour for older hosts)", async () => {
        const state = [T("dcostenco/prism-coder:9b", "e8b71"), T("prism-coder:9b", "d48df")];
        const { deps, copies } = harness([state, state]);
        await convergeModels(deps);
        expect(copies).toContainEqual(["dcostenco/prism-coder:9b", "prism-coder:9b"]);
    });

    it("an unpinned alias with a different digest and different weights is still repaired", async () => {
        const state = [T("dcostenco/prism-coder:2b", "new222"), T("prism-coder:2b", "old111")];
        const { deps, copies } = harness([state, state]);
        await convergeModels({ ...deps, tagFacts: facts({
            "prism-coder:2b": { weightsBlob: "sha256-OLD", pinnedNumCtx: null },
            "dcostenco/prism-coder:2b": { weightsBlob: "sha256-NEW", pinnedNumCtx: null },
        }) });
        expect(copies).toContainEqual(["dcostenco/prism-coder:2b", "prism-coder:2b"]);
    });
});
