/**
 * scripts/check-no-private-content.mjs, run for real: each case builds a
 * throwaway git repository and runs the guard inside it, exactly as CI does.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const guard = resolve(__dirname, "../scripts/check-no-private-content.mjs");
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function runGuardOn(files: string[]) {
    const repo = mkdtempSync(join(tmpdir(), "public-guard-"));
    dirs.push(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo, env });
    for (const file of ["README.md", ...files]) {
        mkdirSync(dirname(join(repo, file)), { recursive: true });
        writeFileSync(join(repo, file), "placeholder\n");
    }
    execFileSync("git", ["add", "-A"], { cwd: repo, env });
    const r = spawnSync(process.execPath, [guard], { cwd: repo, env, encoding: "utf8" });
    return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

describe("check-no-private-content: benchmarks and evaluation harnesses stay private", () => {
    it.each([
        "scripts/bench/run.mjs",
        "scripts/bench/fixtures/cases.json",
        "benchmarks/results.txt",
        "evals/cases.json",
        "tests/eval/run.mjs",
        "tools/scaffolds/runner.mjs",
        "Bench/README.md",
        "tests/evaluation/cases.json",
        "harness/run.mjs",
    ])("blocks %s", (path) => {
        const r = runGuardOn([path]);
        expect(r.status).toBe(1);
        expect(r.output).toContain(path);
    });

    it.each([
        "src/tools/prismInferHandler.ts",
        "tests/darkfactory/adversarial-eval.test.ts",
        "examples/adversarial-eval-demo/README.md",
        "src/utils/benchmarkless.ts",
    ])("allows %s", (path) => {
        const r = runGuardOn([path]);
        expect(r.output).not.toContain("BLOCKED");
        expect(r.status).toBe(0);
    });
});
