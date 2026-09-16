/**
 * LIVE regression — runs only when a local Ollama serves the prism-coder tiers.
 * Skipped (not failed) everywhere else, including CI runners.
 *
 * Pins three things that were verified by hand on 2026-09-15 and would
 * otherwise drift silently:
 *   1. prism-coder:9b carries a num_ctx pin ≥ 32768 (adopted from
 *      scripts/prism-coder-9b.Modelfile; the converge guard keeps it).
 *   2. The REAL local call (callOllamaGenerate) delivers role-structured
 *      history that every tier reads — a no-history control fails.
 *   3. On the 9b, a history well past the old 4,096-token window still
 *      recalls its first turn — the pin, exercised end to end.
 */
import { describe, it, expect } from "vitest";
import { callOllamaGenerate } from "../../src/tools/prismInferHandler.js";

const URL = process.env.PRISM_LOCAL_LLM_URL ?? "http://localhost:11434";
const NEEDED = ["prism-coder:2b", "prism-coder:4b", "prism-coder:9b"];

async function liveTags(): Promise<Set<string> | null> {
    try {
        const res = await fetch(`${URL}/api/tags`, { signal: AbortSignal.timeout(2_000) });
        if (!res.ok) return null;
        const data = (await res.json()) as { models?: Array<{ name: string }> };
        return new Set((data.models ?? []).map(m => m.name));
    } catch { return null; }
}
const tags = await liveTags();
// Opt-in: `PRISM_LIVE_TESTS=1 npx vitest run tests/live`. Minutes of real
// generation must not ride along with `npm test` on any machine that happens
// to have the models (review 2026-09-16).
const live = process.env.PRISM_LIVE_TESTS === "1" && tags !== null && NEEDED.every(t => tags.has(t));

const T1 = "My project codename is Nightjar. Acknowledge in one short sentence without repeating the name.";
const T2 = "What is my project codename? Answer with one word only.";
const history = [{ role: "user" as const, content: T1 }, { role: "assistant" as const, content: "Acknowledged." }];

describe.skipIf(!live)("live: multi-turn on the installed tiers", () => {
    it("1. the 9b is pinned at ≥ 32768 context", async () => {
        const res = await fetch(`${URL}/api/show`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "prism-coder:9b" }) });
        const data = (await res.json()) as { parameters?: string };
        const m = /^\s*num_ctx\s+(\d+)\s*$/m.exec(data.parameters ?? "");
        expect(m, "prism-coder:9b has no num_ctx pin — re-adopt scripts/prism-coder-9b.Modelfile").not.toBeNull();
        expect(Number(m![1])).toBeGreaterThanOrEqual(32_768);
    }, 30_000);

    for (const model of NEEDED) {
        it(`2. ${model} reads role-structured history through the real local call, and not without it`, async () => {
            const withH = await callOllamaGenerate(URL, model, T2, undefined, 16, 0, 240_000, false, undefined, history);
            expect(withH.ok).toBe(true);
            expect((withH as { text: string }).text.toLowerCase()).toContain("nightjar");
            const control = await callOllamaGenerate(URL, model, T2, undefined, 16, 0, 240_000, false);
            expect(control.ok).toBe(true);
            expect((control as { text: string }).text.toLowerCase()).not.toContain("nightjar");
        }, 300_000);
    }

    it("3. the 9b recalls the first turn across a history far beyond the old 4,096-token window", async () => {
        const filler = "The quarterly report covers logistics, staffing and vendor renewals. ".repeat(700); // ≈ 8k+ tokens
        const long = [
            ...history,
            { role: "user" as const, content: `${filler}\nSummarise the above in five words.` },
            { role: "assistant" as const, content: "Quarterly logistics, staffing, vendor renewals." },
        ];
        const r = await callOllamaGenerate(URL, "prism-coder:9b", T2, undefined, 12, 0, 300_000, false, undefined, long);
        expect(r.ok).toBe(true);
        expect((r as { promptTokens?: number }).promptTokens ?? 0, "history did not exceed the old window; test proves nothing").toBeGreaterThan(4_096);
        expect((r as { text: string }).text.toLowerCase()).toContain("nightjar");
    }, 400_000);
});
