#!/usr/bin/env node
/**
 * Private identifiers in tracked files, written out OR assembled from pieces.
 *
 * WHY THIS EXISTS
 *
 * The literal guard (ci.yml "Private repo leak guard" and
 * tests/publish-clean-guard.test.ts) greps tracked files for each term in
 * scripts/private-identifier-terms.mjs. A name built at runtime passes it.
 * Twice, a public file built a private repository's name that way on purpose,
 * to keep that guard green: a test that read a file from a sibling private
 * checkout, and a script that looked for one. Both still published the name to
 * everyone who reads the source, which is what the guard exists to stop.
 *
 * HOW
 *
 * Each file is "squashed": the glue that assembly idioms use is deleted
 * (quotes, backticks, +, $, braces, parentheses, brackets, commas,
 * backslashes, whitespace, and the words printf, echo and .concat), and each
 * term is looked for in what remains, case-insensitively. Before that, a join
 * made only of string literals is resolved: an array of literals joined with a
 * literal separator (JS and Python forms) and path.join of literals. That
 * catches concatenated literals, template interpolation of a literal, joined
 * arrays, path.join, .concat, adjacent literals, shell quote splicing and a
 * shell printf substitution. It does not evaluate code: a name built with a
 * separator or piece held in a variable still passes, so this is a tripwire
 * for the idioms that actually happened, not a proof that no name can be built.
 *
 * Only the term list may assemble terms: it has to, to exist without matching
 * itself.
 *
 * Findings name the file and the term's position in the list, never the term:
 * CI logs of a public repository are public too.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { privateIdentifierTerms } from "./private-identifier-terms.mjs";

/** The only tracked file allowed to assemble terms, relative to the repository root. */
export const ASSEMBLY_EXEMPT = new Set(["scripts/private-identifier-terms.mjs"]);

const GLUE_WORDS = /\bprintf\b|\becho\b|\.concat\b/gi;
const GLUE_CHARS = /['"`+${}()[\],\\\s]/g;

// One string literal with no escapes and no line break, in any quote style.
const LIT = "'[^'\\\\\\n]*'|\"[^\"\\\\\\n]*\"|`[^`$\\\\\\n]*`";
const LITS = `(?:${LIT})(?:\\s*,\\s*(?:${LIT}))*`;
const ARRAY_JOIN = new RegExp(`\\[\\s*(${LITS})\\s*,?\\s*\\]\\s*\\.join\\(\\s*(${LIT})?\\s*\\)`, "g");
const SEPARATOR_JOIN = new RegExp(`(${LIT})\\s*\\.join\\(\\s*[[(]\\s*(${LITS})\\s*,?\\s*[\\])]\\s*\\)`, "g");
const PATH_JOIN = new RegExp(`\\bjoin\\(\\s*((?:${LIT})(?:\\s*,\\s*(?:${LIT}))+)\\s*\\)`, "g");

const literalValues = (list) => [...list.matchAll(new RegExp(LIT, "g"))].map((m) => m[0].slice(1, -1));

/**
 * Replace each join built only from string literals with the string it makes:
 * ["a", "b"].join("-"), "-".join(["a", "b"]) and path.join("a", "b").
 */
export function resolveLiteralJoins(text) {
    return String(text)
        .replace(ARRAY_JOIN, (_m, list, sep) => literalValues(list).join(sep === undefined ? "," : sep.slice(1, -1)))
        .replace(SEPARATOR_JOIN, (_m, sep, list) => literalValues(list).join(sep.slice(1, -1)))
        .replace(PATH_JOIN, (_m, list) => literalValues(list).join("/"));
}

/** Text with literal joins resolved and the assembly glue removed, lower-cased. */
export function squash(text) {
    return resolveLiteralJoins(text).replace(GLUE_WORDS, "").replace(GLUE_CHARS, "").toLowerCase();
}

/**
 * 1-based positions, in `terms`, of every term that `text` writes out or
 * assembles.
 */
export function privateIdentifierHits(text, terms = privateIdentifierTerms()) {
    const flat = squash(text);
    const hits = [];
    terms.forEach((term, i) => {
        const needle = squash(term);
        if (needle && flat.includes(needle)) hits.push(i + 1);
    });
    return hits;
}

function git(args, cwd) {
    const proc = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    // A git that failed to run yields no output, which would otherwise read as
    // "nothing tracked, nothing found": the failure this guard must not have.
    if (proc.error) throw new Error(`git ${args[0]} failed to run: ${proc.error.message}`);
    if (proc.status !== 0) throw new Error(`git ${args.join(" ")} exited ${proc.status}: ${proc.stderr?.trim()}`);
    return proc.stdout;
}

/**
 * Scan every tracked file of the repository that contains `cwd`.
 * Returns the number of tracked paths and one finding per (file, term).
 */
export function scanTrackedFiles(cwd = process.cwd(), terms = privateIdentifierTerms()) {
    if (terms.length === 0) throw new Error("no private identifier terms loaded; refusing to report a clean result");
    const root = git(["rev-parse", "--show-toplevel"], cwd).trim();
    const paths = git(["ls-files", "-z"], root).split("\0").filter(Boolean);
    if (paths.length === 0) throw new Error("git ls-files returned nothing; refusing to report a clean result");

    const findings = [];
    for (const path of paths) {
        if (ASSEMBLY_EXEMPT.has(path)) continue;
        let bytes;
        try {
            bytes = readFileSync(join(root, path));
        } catch {
            continue; // tracked but deleted in this working tree: nothing here to publish
        }
        if (bytes.subarray(0, 8000).includes(0)) continue; // binary, as git decides it
        for (const index of privateIdentifierHits(bytes.toString("utf8"), terms)) {
            findings.push({ path, index });
        }
    }
    return { scanned: paths.length, findings };
}

// pathToFileURL, not a string-built file:// URL: see private-identifier-terms.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    let result;
    try {
        result = scanTrackedFiles();
    } catch (error) {
        console.error(`private-identifier-scan: FAILED to scan: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(2);
    }
    if (result.findings.length > 0) {
        console.error("BLOCKED: tracked files of this PUBLIC repository write out or assemble a private identifier:");
        for (const { path, index } of result.findings) {
            console.error(`  ${path}: term #${index} of scripts/private-identifier-terms.mjs`);
        }
        console.error("Remove it. A path to a private checkout comes from an environment variable; never build its name.");
        process.exit(1);
    }
    console.log(`private-identifier-scan: ${result.scanned} tracked files, no private identifier written out or assembled.`);
}
