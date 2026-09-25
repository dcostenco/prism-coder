#!/usr/bin/env node
/**
 * check-no-private-content — refuse to let private material into a PUBLIC repo.
 * ─────────────────────────────────────────────────────────────────────────────
 * This repository is public. Training corpora, evaluation methodology, roadmap
 * documents, and training recipes do not go in it.
 *
 * WHY THIS EXISTS, SPECIFICALLY
 *
 * Two separate incidents, not one:
 *
 *   1. 2026-05-05 — 178 training scripts (Modal orchestration, phase plans,
 *      evaluation methodology) were committed across the full history and had
 *      to be purged with filter-repo, force-pushing every branch and tag.
 *
 *   2. 2026-05-25 — three weeks after that cleanup, training/data/ landed again:
 *      sft_dataset_v2.jsonl (25.6 MB), grounded_recall_corpus.jsonl, and its
 *      README. They sat in the public tree until 2026-07-05 and remain in
 *      history. The .gitignore rule added by that cleanup was the ONLY control,
 *      and a .gitignore does not apply to a path that is already tracked, nor to
 *      an explicit `git add -f`.
 *
 * WHY IT LOOKS OVER-BUILT
 *
 * The first version of this file reported "no private content found" on a repo
 * containing every pattern it claims to block. It handed JavaScript regex source
 * (`\b`, `\s`, `\w`) to `git grep -E`, which speaks POSIX ERE and matches none
 * of it — and a `git grep` that finds nothing exits 1, which is indistinguishable
 * from a clean scan. Four of five content rules were dead on arrival.
 *
 * It passed its own mutation test, because the single rule that happened to be a
 * plain literal was the one the test exercised.
 *
 * So: patterns run under -P (PCRE), and every content rule carries a `sample` it
 * MUST match. The self-test runs those samples through the real `git grep` on
 * this machine before any scanning happens, and throws if a rule cannot match
 * its own sample. A guard that cannot prove it works is not a guard.
 *
 * Purging history rewrites SHAs but does not undo exposure — anything cloned,
 * forked, or scraped during the window is gone for good. The only control that
 * works is the one that runs before the push.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tracked paths that must never appear in a public repo.
 *
 * Anchored with `(^|/)` rather than `^`. The first version anchored at the root,
 * so `research/training/dataset.jsonl` and `scripts/prism-training/build_v3.py`
 * both passed — a leak one directory deep was invisible.
 */
const FORBIDDEN_PATHS = [
    { re: /(^|\/)training\//i, why: "training corpora and scripts belong in the private repo" },
    { re: /(^|\/)prism-training\//i, why: "private training monorepo path" },
    { re: /(^|\/)portal\//i, why: "private portal source" },
    { re: /(^|\/)prism-aac\//i, why: "private application source" },
    { re: /(^|\/)bfcl\//i, why: "benchmark corpus and evaluation methodology" },
    // Benchmark and evaluation directories, with their fixtures and results.
    // A benchmark directory passed every rule above on 2026-09-24.
    { re: /(^|\/)(bench|benchmarks?|evals?|evaluations?|harness(es)?|scaffolds?)\//i, why: "benchmarks and evaluation harnesses belong in the private repo" },
    { re: /(^|\/)(sft|grounded_recall|corpus|train)[^/]*\.jsonl$/i, why: "training corpus" },
    { re: /(^|\/)(PHASE_[^/]*|PLAN_[^/]*|IMPLEMENTATION_PLAN[^/]*)\.md$/i, why: "roadmap / phase plan" },
    { re: /(^|\/)modal_[^/]*\.py$/i, why: "cloud GPU orchestration" },
    // .env.example and .env.sample are templates and legitimately public;
    // .env.production.local is where real secrets actually live on this machine.
    { re: /(^|\/)\.env(\.|$)(?!example|sample)/i, why: "environment file (only .env.example may be tracked)" },
    { re: /(^|\/)[^/]*\.(pem|p12|keystore)$/i, why: "private key material" },
    { re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i, why: "private SSH key" },
];

/**
 * Content that must not appear even in an otherwise allowed path.
 *
 * Private IDENTIFIERS (repo names, team slugs, home paths) are deliberately NOT
 * here — ci.yml's "Private repo leak guard" step and
 * tests/publish-clean-guard.test.ts already cover them, and a second copy would
 * drift from the first. Add a new identifier to those, not to this list.
 *
 * `sample` is mandatory and is what the self-test below proves each pattern can
 * still match. `exemptPaths` is per-RULE, never per-file: exempting a whole file
 * from every rule would mean the one document most likely to acquire
 * architecture detail is also the one nothing checks.
 */
const FORBIDDEN_CONTENT = [
    {
        re: /\br\s*=\s*128\b/i,
        why: "LoRA rank — training recipe",
        sample: "fine-tuned with LoRA (r=128) over the stack",
    },
    {
        re: /\bDeltaNet\b/i,
        why: "model architecture detail — training recipe",
        sample: "the 27B uses a Qwen3.5 DeltaNet backbone",
    },
    {
        re: /\ball 64 layers\b/i,
        why: "LoRA target layers — training recipe",
        sample: "adapters applied to all 64 layers",
    },
    {
        re: /\b(?:learning_rate|num_epochs|gradient_accum\w*)\b/i,
        why: "training hyperparameter",
        sample: "learning_rate 3e-5, num_epochs 4, gradient_accumulation_steps 8",
    },
    {
        re: /\bBFCL Accuracy\b/i,
        why: "labels self-run results as a BFCL leaderboard submission",
        sample: "| Tag | Base | BFCL Accuracy | Tier |",
        // The ARCHITECTURE footnote quotes the old column label to record that it
        // was renamed and why. Scoped to THIS rule only — every other rule still
        // applies to that file.
        exemptPaths: [/^docs\/ARCHITECTURE\.md$/],
    },
];

/** This file necessarily contains every pattern and sample it scans for. */
const SELF = /^scripts\/check-no-private-content\.mjs$/;

function git(args) {
    const proc = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    // ENOENT or a signal kill yields no stdout, which would otherwise read as
    // "nothing forbidden found" — the failure mode this check exists to prevent.
    if (proc.error) throw new Error(`git ${args[0]} failed to run: ${proc.error.message}`);
    if (proc.status !== 0) throw new Error(`git ${args.join(" ")} exited ${proc.status}: ${proc.stderr?.trim()}`);
    return proc.stdout;
}

/** Run one content pattern over tracked files. Returns matching paths. */
function grepTracked(pattern, extraArgs = []) {
    const proc = spawnSync("git", ["grep", "-lIiP", ...extraArgs, "-e", pattern], { encoding: "utf8" });
    if (proc.error) throw new Error(`git grep failed to run: ${proc.error.message}`);
    // 0 = matches, 1 = none. Anything else (2 = bad pattern, unsupported -P on a
    // git built without PCRE) must NOT be read as "clean".
    if (proc.status !== 0 && proc.status !== 1) {
        throw new Error(
            `git grep exited ${proc.status} for /${pattern}/ — treating this as a FAILED scan, `
            + `not a clean one. stderr: ${proc.stderr?.trim()}`,
        );
    }
    return (proc.stdout ?? "").split("\n").map(s => s.trim()).filter(Boolean);
}

/**
 * Prove every content pattern can match its own sample, using the real git on
 * this machine. Without this the whole content scan can silently do nothing.
 */
function selfTest() {
    const dir = mkdtempSync(join(tmpdir(), "prism-leakguard-"));
    try {
        const broken = [];
        for (const rule of FORBIDDEN_CONTENT) {
            writeFileSync(join(dir, "sample.txt"), `${rule.sample}\n`);
            // cwd is the temp dir, and the path is RELATIVE. `git grep --no-index`
            // refuses an absolute path that sits outside the repository it was
            // invoked from, so running this from the project root failed with
            // status 128 for every rule — which the self-test then reported as
            // "pattern is broken". Correct conclusion, wrong reason, and it made
            // the guard exit non-zero everywhere.
            const proc = spawnSync(
                "git",
                ["grep", "-lIiP", "--no-index", "-e", rule.re.source, "--", "sample.txt"],
                { encoding: "utf8", cwd: dir },
            );
            if (proc.error) throw new Error(`git grep failed to run: ${proc.error.message}`);
            if (proc.status !== 0) {
                broken.push(`/${rule.re.source}/ (${rule.why}) — status ${proc.status} ${proc.stderr?.trim() ?? ""}`);
            }
        }
        if (broken.length > 0) {
            throw new Error(
                "check-no-private-content SELF-TEST FAILED — these patterns cannot match their own "
                + "samples, so the scan would report a clean repo without checking anything:\n  "
                + broken.join("\n  "),
            );
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

selfTest();

const tracked = git(["ls-files"]).split("\n").map(s => s.trim()).filter(Boolean);
if (tracked.length === 0) throw new Error("git ls-files returned nothing — refusing to report a clean result");

const violations = [];

for (const path of tracked) {
    // One report per path: the first rule that names it.
    const hit = FORBIDDEN_PATHS.find(({ re }) => re.test(path));
    if (hit) violations.push({ path, why: hit.why, kind: "path" });
}

for (const rule of FORBIDDEN_CONTENT) {
    for (const path of grepTracked(rule.re.source)) {
        if (SELF.test(path)) continue;
        if (rule.exemptPaths?.some(ex => ex.test(path))) continue;
        violations.push({ path, why: rule.why, kind: "content" });
    }
}

if (violations.length > 0) {
    console.error("BLOCKED: private content is tracked in a PUBLIC repository.\n");
    for (const v of violations) {
        console.error(`  ${v.kind === "path" ? "path   " : "content"}  ${v.path}\n           -> ${v.why}`);
    }
    console.error(
        "\nMove these to the private repository. Note that removing a file in a later" +
        "\ncommit does NOT remove it from history — if it has already been pushed," +
        "\ntreat it as exposed and purge the history deliberately.",
    );
    process.exit(1);
}

console.log(
    `check-no-private-content: ${tracked.length} tracked paths, `
    + `${FORBIDDEN_CONTENT.length} content patterns self-tested, no private content found.`,
);
