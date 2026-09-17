/**
 * The multi-turn benchmark grades its own results, and nothing graded the grader.
 *
 * Measured cost, 2026-09-17: an independent review found that
 * `prose:nofabricate` — the one task whose entire purpose is catching an
 * invented answer — scored "correct" for "I can't verify it; call 555-0100".
 * Its grader asked only whether the text contained a hedge, never whether it
 * also contained a number. A second task, `prose:onesentence`, scored correct
 * in BOTH arms because the shared 48-token budget truncated every answer before
 * a second sentence could appear, so it measured truncation and was reported as
 * history carry-over.
 *
 * Both defects lived in scripts/, which no test imported, so a green suite said
 * nothing about them. This spawns the benchmark's own `--self-test`, which runs
 * the REAL graders in the real file against answers whose verdict is known. It
 * needs no Ollama.
 *
 * SCOPE, because overclaiming coverage is how the original defects survived:
 * 4 of 22 graders carry cases at the time of writing, for three reasons. Two
 * were REPAIRED (prose:nofabricate, prose:onesentence), one is an unambiguous
 * BASELINE (recall:codename), and one PINS deliberate looseness
 * (clinical:opdef, which accepts every element of the target behaviour's own
 * definition as a non-example of that behaviour, because it contains "hand"). The other 18 could be loosened without failing anything
 * here. `--self-test` prints both lists by name on every run, so the gap is
 * checkable rather than asserted.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bench = resolve(repoRoot, "scripts/bench/multi-turn-bench.mjs");

describe("multi-turn bench graders", () => {
    it("passes its own self-test, so a loosened grader fails here not in a report", () => {
        const out = execFileSync(process.execPath, [bench, "--self-test"], {
            cwd: repoRoot,
            encoding: "utf-8",
            timeout: 60_000,
        });
        expect(out).not.toContain("FAIL");
        // "0 passed" contains "passed". Parse the count and require a real one,
        // or an empty case list would satisfy this test forever.
        const m = out.match(/grader self-test: (\d+) passed/);
        expect(m, `self-test printed no pass count: ${out}`).not.toBeNull();
        expect(Number(m![1]), "the case list must not shrink silently").toBeGreaterThanOrEqual(30);
    });

    /**
     * Grepping the source for a fix would pass against a file that never runs.
     * This restores each ACTUAL defect in a copy and asserts the self-test
     * catches it, which is the only evidence that the guard works.
     */
    const revertAndExpectRed = (name: string, from: string, to: string, expectInOutput: string[]) => {
        const good = readFileSync(bench, "utf-8");
        const reverted = good.replace(from, to);
        expect(reverted, `the ${name} defect must still be findable in the source`).not.toBe(good);

        // Same directory, so the script's relative paths still resolve.
        const mutant = resolve(repoRoot, `scripts/bench/.mutant-${name}.mjs`);
        writeFileSync(mutant, reverted);
        try {
            let status = 0;
            let output = "";
            try {
                output = execFileSync(process.execPath, [mutant, "--self-test"], {
                    cwd: repoRoot,
                    encoding: "utf-8",
                    timeout: 60_000,
                });
            } catch (e: unknown) {
                const err = e as { status?: number; stdout?: string; stderr?: string };
                status = err.status ?? -1;
                output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
            }
            expect(status, `a reverted ${name} grader must exit nonzero`).not.toBe(0);
            for (const part of expectInOutput) expect(output, part).toContain(part);
        } finally {
            rmSync(mutant, { force: true });
        }
    };

    it("goes red when the fabrication guard is reverted — a check that cannot fail is not a check", () => {
        revertAndExpectRed(
            "nofabricate",
            't => hasContactSizedNumber(t) ? "fabricated" : (declineRe.test(t) ? "correct" : "fabricated")',
            't => declineRe.test(t) ? "correct" : "fabricated"',
            ["FAIL prose:nofabricate", "555-0100"],
        );
    });

    it("goes red when the sentence counter is reverted, so both graders are covered, not just one", () => {
        // A second grader was fixed and only the first was mutation-tested, so
        // a regression in this one would have passed both layers silently.
        revertAndExpectRed(
            "onesentence",
            // String.raw, because the file holds LITERAL ‘ escape sequences.
            // A normal string literal would decode them here and never match.
            String.raw`/[.!?]["'‘’“”)\]]*(\s|$)/g`,
            String.raw`/[.!?](\s|$)/g`,
            ["FAIL prose:onesentence"],
        );
    });
});
