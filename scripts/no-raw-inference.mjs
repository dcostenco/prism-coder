#!/usr/bin/env node
// scripts/no-raw-inference.mjs
//
// THE invariant that makes host-agnostic enforcement real:
//
// Raw Ollama and portal inference functions (callOllamaGenerate,
// callSynaluxInference) and direct fetch calls to Ollama/portal must only
// appear in files that ARE the chokepoint OR in explicitly-named background
// operations that have been audited and accepted as low-risk (see ALLOWLIST).
//
// Every other src/ file that calls these is a bypass path that lets a
// non-Claude host obtain model output without Layer 1 + safety gates.
//
// ALLOWLIST DISCIPLINE
// --------------------
// Do NOT use module-level allowlisting (e.g. "allow localLlm.ts") because
// that hides all callers of the allowlisted module — a bypass can accumulate
// silently without ever appearing in this scan. Instead, EVERY file that
// legitimately touches raw inference must be named here individually with
// an explicit reason. When adding a new entry, answer:
//   a. Is this a user-facing inference path? → must route through runInfer.
//   b. Is it background/internal, with structured I/O and no clinical output?
//      → Acceptable bypass; add with reason.
//
// Scan scope: src/ only (examples/, scripts/, benchmark files are outside
// the MCP server — verified non-reachable from tool handlers 2026-07-06).
//
// Usage: node scripts/no-raw-inference.mjs
// CI:    exits 1 on any violation.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Symbols that constitute raw inference access in the real codebase.
// These are the ACTUAL function names — not the zip's assumed client/ layout.
// ---------------------------------------------------------------------------
const SYMBOL_PATTERNS = [
    { needle: "callOllamaGenerate", desc: "raw Ollama generate (private to localLlm.ts)" },
    { needle: "callSynaluxInference", desc: "raw portal inference (private to localLlm.ts)" },
    { needle: "callLocalLlm", desc: "raw local LLM client (from localLlm.ts)" },
];

// URL patterns that indicate a DIRECT fetch to the model backend.
// Only match inside an actual fetch/axios call — not in comments.
const URL_BYPASS_PATTERNS = [
    { needle: /fetch\([^)]*\/api\/generate/, desc: "direct fetch to Ollama /api/generate" },
    { needle: /fetch\([^)]*\/api\/v1\/prism-aac\/inference/, desc: "direct fetch to portal inference" },
    { needle: /axios\.[a-z]+\([^)]*\/api\/generate/, desc: "direct axios to Ollama" },
    { needle: /axios\.[a-z]+\([^)]*\/api\/v1\/prism-aac\/inference/, desc: "direct axios to portal" },
];

// ---------------------------------------------------------------------------
// Allowlist — every entry requires an explicit reason.
// NEVER allowlist at the module level (e.g. "localLlm.ts") — that hides
// all callers. Name each file individually.
// ---------------------------------------------------------------------------
const ALLOWLIST = new Set([
    // ── Chokepoint: user-facing inference. Layer 1 + safety gates run here.
    "src/tools/prismInferHandler.ts",

    // ── Raw client definitions. These define callOllamaGenerate /
    //    callSynaluxInference / callLocalLlm — they ARE the symbols.
    "src/utils/localLlm.ts",

    // ── Background ops. Audited 2026-07-06: structured I/O, constrained
    //    outputs (JSON summary / binary route / entity array), not clinical
    //    generation. Layer 1 is not required because the model cannot produce
    //    user-facing harmful output from these prompts. If any of these
    //    handlers begin producing clinical recommendations or user-visible
    //    text, remove from this list and route through prismInferHandler.
    "src/tools/compactionHandler.ts",   // compact_ledger: summarise session entries → JSON
    "src/tools/taskRouterHandler.ts",   // session_task_route: classify task → "claw"|"host"
    "src/utils/nerExtractor.ts",        // extract_entities: conversation text → entity array

]);

// ---------------------------------------------------------------------------
function srcFiles() {
    const tracked = execSync("git ls-files src/", { encoding: "utf8" })
        .split("\n")
        .filter(f => /\.(ts|tsx|js|mjs)$/.test(f) && f.trim())
        .filter(f => !f.includes("node_modules") && !f.includes("dist/"));

    // Also warn on untracked src/ files — a new bypass file not yet committed
    // would be invisible to `git ls-files` alone.
    let untracked = [];
    try {
        untracked = execSync("git ls-files --others --exclude-standard src/", { encoding: "utf8" })
            .split("\n")
            .filter(f => /\.(ts|tsx|js|mjs)$/.test(f) && f.trim());
    } catch { /* non-fatal */ }

    if (untracked.length > 0) {
        // Untracked files are not scanned — a new bypass file that hasn't been
        // committed yet would pass CI silently. Fail hard so the developer is
        // forced to either commit the file (where it WILL be scanned) or add it
        // to .gitignore (explicitly acknowledging it's not production code).
        console.error(
            `ERROR: ${untracked.length} untracked src/ file(s) detected. ` +
            `Untracked files are not scanned — commit them or add to .gitignore:`
        );
        for (const f of untracked) console.error(`  ? ${f}`);
        process.exit(1);
    }

    return tracked;
}

const files = srcFiles();
const violations = /** @type {{ file: string; needle: string; desc: string }[]} */ ([]);

for (const file of files) {
    if (ALLOWLIST.has(file)) continue;
    let text;
    try { text = readFileSync(file, "utf8"); } catch { continue; }

    // Strip comments before checking — avoids false positives from doc
    // comments that mention the function names.
    // Use a negative lookbehind for ":" so that URL schemes (http://, https://)
    // are not treated as line-comment starts. Without this, fetch("http://...")
    // would be mangled before the URL bypass patterns run, making them blind to
    // direct-fetch bypasses in string literals.
    const stripped = text.replace(/(?<!:)\/\/.*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

    // Symbol-level bypass: import/require/call of the raw client functions.
    for (const { needle, desc } of SYMBOL_PATTERNS) {
        const importRe = new RegExp(
            `(?:import[^;'"]*["'][^"']*${needle}[^"']*["'])` + // import "...symbol..."
            `|(?:require\\(["'][^"']*${needle}[^"']*["']\\))` + // require("...symbol...")
            `|(?:\\b${needle}\\s*\\()`,                          // bare call: symbol(
            "m",
        );
        if (importRe.test(stripped)) {
            violations.push({ file, needle, desc });
        }
    }

    // URL-level bypass: direct fetch/axios to the model backend.
    for (const { needle, desc } of URL_BYPASS_PATTERNS) {
        if (needle.test(stripped)) {
            violations.push({ file, needle: needle.source, desc });
        }
    }
}

if (violations.length > 0) {
    console.error("ERROR: raw inference access outside the guarded allowlist.\n");
    console.error("Every user-facing model call must route through:");
    console.error("  src/tools/prismInferHandler.ts → runInfer → Layer 1 → safety gates → model");
    console.error("\nBackground-op callers must be individually allowlisted with a reason.\n");
    console.error("Bypass sites:\n");
    for (const v of violations) {
        console.error(`  ${v.file}\n    → ${v.desc}`);
    }
    console.error(`\n${violations.length} bypass site(s). Fix or explicitly allowlist before shipping.`);
    process.exit(1);
}

console.log(`OK: all inference access accounted for (${files.length} src/ files scanned).`);
console.log(`Chokepoint: src/tools/prismInferHandler.ts`);
console.log(`Background ops (allowlisted): compactionHandler, taskRouterHandler, nerExtractor`);
