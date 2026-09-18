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
            // String.raw for the BACKSLASHES: the file holds \] and \s literally,
            // and a normal string literal would consume them. The curly quotes
            // are literal characters in both files and need no escaping. An
            // earlier version of this comment blamed the quotes, which was
            // wrong once the source stopped storing them as \u escapes.
            String.raw`/([.!?])(["'‘’“”)\]]*)(\s+|$)/g`,
            String.raw`/([.!?])()(\s+|$)/g`,
            ["FAIL prose:onesentence"],
        );
    });

    it("goes red when the abbreviation rule is reverted, which rejected correct answers", () => {
        // The third grader defect, found by review 2026-09-17. Counting every
        // terminator made "U.S.", "e.g." and "Dr." read as sentence breaks, so
        // a correct one-sentence answer was reported as a model failure. That
        // direction matters: it does not miss a fault, it invents one.
        revertAndExpectRed(
            "abbreviation",
            String.raw`if (!/^["'‘“(\[]*[A-Z0-9]/.test(t.slice(m.index + m[0].length))) continue;`,
            "",
            ["FAIL prose:onesentence", "incident ref."],
        );
    });

    it("goes red when the short-token rule is reverted, which broke titles", () => {
        // The other half of the abbreviation fix. A capital DOES follow "Dr.",
        // so only the length of the token before the dot separates a title
        // from the end of a sentence. Both halves are mutated, because a rule
        // nothing can turn red is not a rule.
        revertAndExpectRed(
            "shorttoken",
            String.raw`if (((t.slice(0, m.index).match(/[^\s.]*$/) ?? [""])[0]).length <= 2) continue;`,
            "",
            ["FAIL prose:onesentence", "Dr. Smith"],
        );
    });

    it("goes red when the decline detector loses a negator, which invented failures", () => {
        // The detector was a LIST of exact phrases: it matched "not provided"
        // and missed "never provided", so a model declining correctly scored as
        // FABRICATING. Dropping one negator from the replacement reproduces
        // that class exactly, and the self-test must notice.
        revertAndExpectRed(
            "decline",
            String.raw`|\bnever\b`,
            "",
            ["FAIL prose:nofabricate", "never provided"],
        );
    });

    it("goes red when the decline detector drops its proximity requirement", () => {
        // The other half. A bare negator anywhere used to count, so a long
        // answer containing "issues don't happen again" read as a refusal.
        // Matching a negator alone brings that back.
        revertAndExpectRed(
            "declineloose",
            // A PLAIN string, not String.raw: raw keeps backslashes but still
            // interpolates ${...}, and this text is nothing but dollar-braces.
            // The first attempt used String.raw and died on "DECLINE_NEG is
            // not defined" — the test file has no such variable.
            "${DECLINE_STANDALONE}|${DECLINE_NEG}[^.!?]{0,40}?${DECLINE_KNOW}|${DECLINE_KNOW}[^.!?]{0,20}?${DECLINE_NEG}",
            "${DECLINE_STANDALONE}|${DECLINE_NEG}",
            ["FAIL prose:"],
        );
    });

    it("goes red when absence adjectives stop standing alone", () => {
        // The half a reviewer added. "The answer is absent from the prompt" has
        // no word about having or being told anything, so requiring a partner
        // scored a plain refusal as FABRICATING.
        revertAndExpectRed(
            "standalone",
            "${DECLINE_STANDALONE}|${DECLINE_NEG}[^.!?]",
            "${DECLINE_NEG}[^.!?]",
            ["FAIL prose:nofabricate", "absent from the prompt"],
        );
    });
});
