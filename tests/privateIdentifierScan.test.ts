/**
 * Private identifiers assembled from pieces.
 *
 * The literal guard (ci.yml and tests/publish-clean-guard.test.ts) greps
 * tracked files for each private term. Twice, a public file built a private
 * repository's name from pieces so that guard would stay green, and published
 * the name anyway. scripts/private-identifier-scan.mjs closes that gap at
 * `npm test`, at push time (scripts/prepush-public-guard.mjs) and at publish
 * time (prepublishOnly). These tests pin it.
 *
 * Every sample here is built at runtime from the canonical term list, so this
 * file holds no term, written out or assembled. Titles name a term by its
 * position only: the CI logs of a public repository are public.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { privateIdentifierTerms } from "../scripts/private-identifier-terms.mjs";
import { privateIdentifierHits, scanTrackedFiles, squash } from "../scripts/private-identifier-scan.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN = join(ROOT, "scripts", "private-identifier-scan.mjs");
const TERMS = privateIdentifierTerms();
const NUMBERED = TERMS.map((term, i) => [i + 1, term] as const);

/** Split a term so that neither piece is the term. */
function pieces(term: string): [string, string] {
    const cut = Math.max(1, Math.floor(term.length / 2));
    return [term.slice(0, cut), term.slice(cut)];
}

/** The assembly idioms the scan must see through, each built from two pieces. */
const IDIOMS: Array<[string, (a: string, b: string) => string]> = [
    ["concatenated literals", (a, b) => `const dir = '${a}' + '${b}';`],
    ["concatenation across lines", (a, b) => `const dir =\n    "${a}" +\n    "${b}";`],
    ["template interpolation of a literal", (a, b) => "const dir = `../../${'" + a + "'}" + b + "/skills`;"],
    ["joined array of literals", (a, b) => `const dir = ["${a}", "${b}"].join("");`],
    [".concat", (a, b) => `const dir = "${a}".concat("${b}");`],
    ["adjacent literals", (a, b) => `DIR = '${a}' '${b}'`],
    ["shell quote splicing", (a, b) => `dir="$HOME/${a}""${b}/skills"`],
    ["shell printf substitution", (a, b) => `dir="$HOME/${a}$(printf '${b.slice(0, 2)}')${b.slice(2)}/skills"`],
    ["backslash-escaped characters", (a, b) => `const re = /${(a + b).replace(/[-/]/g, (c) => "\\" + c)}/;`],
];

/**
 * Split a term around its last separator (a hyphen or a slash after the first
 * character), so a join with that separator rebuilds it.
 */
function aroundSeparator(term: string): [string, string, string] | null {
    for (const sep of ["-", "/"]) {
        const i = term.lastIndexOf(sep);
        if (i > 0) return [term.slice(0, i), sep, term.slice(i + 1)];
    }
    return null;
}

/** Joins whose separator is itself a literal, so the scan can resolve them. */
const SEPARATOR_IDIOMS: Array<[string, (a: string, sep: string, b: string) => string | null]> = [
    ["array joined with a literal separator", (a, sep, b) => `const dir = ["${a}", "${b}"].join("${sep}");`],
    ["literal separator joining a list (Python)", (a, sep, b) => `dir = "${sep}".join(["${a}", "${b}"])`],
    ["path.join of literals", (a, sep, b) => (sep === "/" ? `const p = path.join("${a}", "${b}");` : null)],
];
const SEPARATED = NUMBERED.filter(([, term]) => aroundSeparator(term) !== null);

const temps: string[] = [];
afterEach(() => {
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A scratch git repository with these files staged (ls-files reads the index). */
function repoWith(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "prism-idscan-"));
    temps.push(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
    }
    execFileSync("git", ["add", "-A"], { cwd: dir });
    return dir;
}

const runScan = (cwd: string) => spawnSync(process.execPath, [SCAN], { cwd, encoding: "utf8", timeout: 30_000 });
const mentionsAnyTerm = (text: string) => TERMS.some((term) => text.toLowerCase().includes(term.toLowerCase()));

describe("the scan sees through assembly idioms", () => {
    it("has terms to look for", () => {
        expect(TERMS.length).toBeGreaterThanOrEqual(5);
        // A term holding glue would be squashed into something else and never found.
        for (const term of TERMS) expect(squash(term)).toBe(term.toLowerCase());
    });

    for (const [idiom, build] of IDIOMS) {
        it.each(NUMBERED)(`${idiom}: term #%i`, (index, term) => {
            const sample = build(...pieces(term));
            // The sample really is assembled: the term is not written out in it.
            expect(sample.toLowerCase().includes(term.toLowerCase())).toBe(false);
            expect(privateIdentifierHits(sample)).toContain(index);
        });
    }

    for (const [idiom, build] of SEPARATOR_IDIOMS) {
        it.each(SEPARATED)(`${idiom}: term #%i`, (index, term) => {
            const [a, sep, b] = aroundSeparator(term)!;
            const sample = build(a, sep, b);
            if (sample === null) return; // this idiom cannot build a term with that separator
            expect(sample.toLowerCase().includes(term.toLowerCase())).toBe(false);
            expect(privateIdentifierHits(sample)).toContain(index);
        });
    }

    it("has a term that path.join can build, so that idiom is exercised", () => {
        expect(SEPARATED.some(([, term]) => aroundSeparator(term)![1] === "/")).toBe(true);
    });

    it.each(NUMBERED)("a written-out term #%i is found too", (index, term) => {
        expect(privateIdentifierHits(`see ${term} here`)).toContain(index);
    });
});

describe("the scan does not invent findings", () => {
    it.each(NUMBERED)("term #%i split by a word that is not glue", (index, term) => {
        const [a, b] = pieces(term);
        expect(privateIdentifierHits(`${a} and ${b}`)).not.toContain(index);
    });

    it("a join that uses a variable is left alone", () => {
        for (const text of ['const p = parts.join("-");', 'const p = join(home, "skills");', "const d = `a${SEP}b`;"]) {
            expect(privateIdentifierHits(text), text).toEqual([]);
        }
    });

    it("ordinary prose and code are clean", () => {
        for (const text of [
            "Synalux is the platform; its private beta opens soon.",
            "const dir = process.env.SYNALUX_SKILLS_DIR ?? join(home, '.synalux', 'skills');",
            "echo \"Legacy local skill sync skipped\"",
        ]) {
            expect(privateIdentifierHits(text), text).toEqual([]);
        }
    });
});

describe("this repository", () => {
    it("tracks no file that writes out or assembles a private identifier", () => {
        const { scanned, findings } = scanTrackedFiles(ROOT);
        expect(scanned).toBeGreaterThan(100);
        expect(findings, findings.map((f) => `${f.path}: term #${f.index}`).join("\n")).toEqual([]);
    });
});

describe("the CLI", () => {
    const [a, b] = pieces(TERMS[0]);
    const assembled = `const dir = '${a}' + '${b}';\n`;

    it("blocks an assembled term and names the file and position, never the term", () => {
        const out = runScan(repoWith({ "src/paths.ts": assembled, "README.md": "clean\n" }));
        expect(out.status, out.stderr).toBe(1);
        expect(out.stderr).toContain("src/paths.ts: term #1 of scripts/private-identifier-terms.mjs");
        expect(mentionsAnyTerm(out.stdout + out.stderr)).toBe(false);
    });

    it("passes a clean repository", () => {
        const out = runScan(repoWith({ "README.md": "clean\n", "src/a.ts": "export const a = 1;\n" }));
        expect(out.status, out.stderr).toBe(0);
        expect(out.stdout).toContain("2 tracked files");
    });

    it("exempts only the term list itself, at its exact path", () => {
        expect(runScan(repoWith({ "scripts/private-identifier-terms.mjs": assembled, "README.md": "clean\n" })).status).toBe(0);
        expect(runScan(repoWith({ "scripts/private-identifier-terms.mjs.bak": assembled })).status).toBe(1);
        expect(runScan(repoWith({ "vendor/scripts/private-identifier-terms.mjs": assembled })).status).toBe(1);
    });

    it("refuses to call a repository with no tracked files clean", () => {
        const out = runScan(repoWith({}));
        expect(out.status).toBe(2);
        expect(out.stderr).toContain("FAILED to scan");
    });
});

describe("the pre-push guard runs the scan", () => {
    const GUARD_SCRIPTS = [
        "prepush-public-guard.mjs",
        "check-no-private-content.mjs",
        "private-identifier-scan.mjs",
        "private-identifier-terms.mjs",
    ];
    const [a, b] = pieces(TERMS[0]);

    function guardRepo(extra: Record<string, string>): string {
        const repo = repoWith({ "README.md": "clean\n", ...extra });
        for (const name of GUARD_SCRIPTS) cpSync(join(ROOT, "scripts", name), join(repo, "scripts", name));
        execFileSync("git", ["add", "-A"], { cwd: repo });
        return repo;
    }

    const runGuard = (repo: string) => spawnSync(process.execPath, [join(repo, "scripts", "prepush-public-guard.mjs")], {
        cwd: repo,
        input: "", // no refs: only the tracked-tree checks run
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, PRISM_PUBLIC_GUARD: "", PRISM_PRIVATE_MARKERS_FILE: join(repo, "no-markers.txt") },
    });

    it("blocks a push from a tree that assembles a private identifier", () => {
        const out = runGuard(guardRepo({ "src/paths.ts": `const dir = ["${a}", "${b}"].join("");\n` }));
        expect(out.status, out.stderr).toBe(1);
        expect(out.stderr).toContain("src/paths.ts: term #1");
        expect(out.stderr).toContain("private-identifier-scan failed");
    });

    it("lets a clean tree through", () => {
        const out = runGuard(guardRepo({}));
        expect(out.status, out.stderr).toBe(0);
    });
});
