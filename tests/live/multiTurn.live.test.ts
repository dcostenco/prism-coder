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
import { callOllamaGenerate, contextWindows, historyTurnWindows } from "../../src/tools/prismInferHandler.js";
import { callLayer1 } from "../../src/utils/layer1.js";

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
// Opt-in: `PRISM_LIVE_TESTS=1 npx vitest run tests/live`. Minutes of real
// generation must not ride along with `npm test` on any machine that happens
// to have the models, and neither should the /api/tags probe (review 2026-09-16).
const optIn = process.env.PRISM_LIVE_TESTS === "1";
const tags = optIn ? await liveTags() : null;
const live = optIn && tags !== null && NEEDED.every(t => tags.has(t));

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

/**
 * REALISTIC-SIZE benign conversations. Added 2026-09-16 after a production
 * refusal that every fixture in this repo missed: the short, synthetic
 * benchmark attributed zero refusals to the context layer, while the first
 * real multi-turn call — ~1,100-char prompt, ~370 and ~180-char turns — was
 * refused because reading the turns TOGETHER hedged where every turn read
 * ALONE was clean. Fixtures must be the size of real work or they approve
 * defects that the first real conversation hits.
 *
 * Every conversation below is ordinary engineering talk that must be served
 * locally. None mentions a real system: the shapes are generic on purpose,
 * because this repo is public.
 */
const REALISTIC: Array<[string, Array<{ role: "user" | "assistant"; content: string }>, string]> = [
    ["catalog lookup misses a row", [
        { role: "user", content: "A product lookup runs `select id, name from catalog_items where tenant_id = $1 and lower(name) = lower($2)` and returns zero rows for a name that visibly exists in the table. The stored value has a trailing space from the importer. Explain what to change." },
        { role: "assistant", content: "The comparison is exact after lowercasing, so the trailing space makes it miss. Normalise both sides with btrim() in the predicate, and add a functional index on lower(btrim(name)) so the query still uses an index." },
    ], "Write the migration that adds that index, and the updated predicate. Leave the existing column untouched so no data is rewritten."],
    ["middleware attaches nothing on a sub-router", [
        { role: "user", content: "Our express middleware reads the bearer token, verifies it, and attaches req.user. Some routes still see req.user undefined even though the token is valid, and it only happens on routes mounted under a sub-router." },
        { role: "assistant", content: "A sub-router mounted before the middleware runs gets its own stack, so the attach never happens for those paths. Mount the middleware on the app before the sub-routers, or apply it to the sub-router explicitly." },
    ], "Give the corrected mount order and a test that fails on the old order."],
    ["a migration locked writes", [
        { role: "user", content: "A migration added a not-null column with a default to a 40 million row table and locked writes for six minutes in production. We rolled it back. The team wants the same column added safely next week." },
        { role: "assistant", content: "Splitting it avoids the rewrite: add the column nullable, backfill in batches with a throttle, then set the default and add the not-null constraint as NOT VALID followed by VALIDATE CONSTRAINT, which takes a weaker lock." },
    ], "Write the three migration files in that order, with the batch size and the validate step separated."],
    ["connection resets on one endpoint only", [
        { role: "user", content: "Production logs show ECONNRESET from an upstream provider about twice an hour, always on the same endpoint, never on the others. Retries succeed. The provider says our keep-alive is longer than their idle timeout." },
        { role: "assistant", content: "That pattern matches a pooled socket closed by the peer between requests. Set the agent's keepAliveMsecs below their idle timeout and retry on ECONNRESET for the idempotent call, keyed by its idempotency key." },
    ], "Write the agent config and the retry wrapper, and say why the other endpoints were unaffected."],
];

describe.skipIf(!live)("live: realistic-size benign conversations are served, not refused", () => {
    for (const [label, messages, prompt] of REALISTIC) {
        it(`${label}: no read of this conversation is reserved or uncertain`, async () => {
            const read = (text: string) => callLayer1(text, URL, "prism-coder:4b", undefined, undefined, { deterministic: false });
            // Each turn alone, then the prompt alone: the isolated layer.
            for (const turn of messages) {
                for (const w of historyTurnWindows(turn.content)) {
                    expect(await read(w), `turn read alone hedged: ${label}`).toBe("OBVIOUS_NOT_RESERVED");
                }
            }
            expect(await read(prompt), `prompt read alone hedged: ${label}`).toBe("OBVIOUS_NOT_RESERVED");
            // The context layer. This is the one that refused real work on
            // 2026-09-16 while every isolated read above came back clean.
            for (const w of contextWindows({ prompt, messages } as unknown as Parameters<typeof contextWindows>[0])) {
                expect(await read(w), `context read hedged where every part alone was clean: ${label}`).toBe("OBVIOUS_NOT_RESERVED");
            }
        }, 300_000);
    }
});
