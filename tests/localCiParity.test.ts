import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { privateIdentifierTerms } from "../scripts/private-identifier-terms.mjs";

/**
 * scripts/local-ci.sh exists so a change can be checked without a remote
 * round-trip. It is only worth running if it runs what CI runs.
 *
 * On 2026-09-17 it did not. It skipped both steps of the first CI job,
 * including the guard that exists because training data reached this public
 * repository twice, and its copy of the private-identifier list had four
 * entries where the workflow had five. A local pass meant less than it looked.
 *
 * These tests fail when the two drift again.
 */
const root = resolve(__dirname, "..");
const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
const localCi = readFileSync(resolve(root, "scripts/local-ci.sh"), "utf8");

/**
 * Every `- name:` in the workflow, mapped to the step that covers it locally.
 * A null means it CANNOT run here, with the reason. Adding a CI step without
 * deciding which case it falls into turns this red, which is the point.
 */
const COVERAGE: Record<string, string | null> = {
    "Checkout Code": null,                          // the local tree IS the checkout
    "Setup Node": null,                             // the local node IS the runtime
    "Setup Python for Prism Browser contract": null, // ditto for python
    "Install Prism Browser Python runtime": null,    // installs into the runner
    "Check for private content": "Check for private content",
    "Check lock file drift": "Check lock file drift",
    "Install Dependencies": "npm ci parity (linux)", // via Docker, see the script
    "Audit Dependencies": "Audit Dependencies",
    "Private repo leak guard": "Private repo leak guard",
    "Build TypeScript": "Build TypeScript",
    "Raw-inference chokepoint guard": "Raw-inference chokepoint",
    "Run Unit Tests": "Run Unit Tests",
    "Process-Level CLI Tests": "Process-Level CLI Tests",
};

/**
 * Every step in the workflow, as blocks, NOT as `- name:` matches.
 *
 * A reviewer pointed out that matching names only means an UNNAMED step —
 * `- run: npm run extra-check` is valid YAML — is invisible here, and the
 * coverage check below passes while CI runs something nobody mapped. So the
 * file is split into step blocks first, and a step without a name is itself a
 * failure rather than a silent gap.
 *
 * Line-based on purpose: this repository has no YAML parser and a test is not
 * a reason to add a dependency. It is asserted to find a plausible number of
 * steps, so a parse that quietly matched nothing cannot pass.
 */
const workflowStepBlocks = (): Array<{ name: string | null; body: string }> => {
    const lines = workflow.split("\n");
    const blocks: Array<{ name: string | null; body: string }> = [];
    let inSteps = false;
    let indent = -1;
    let current: string[] | null = null;
    const flush = () => {
        if (!current) return;
        const body = current.join("\n");
        // The step's OWN name, at the step's key column. A second review found
        // that any `name:` in the block counted, so
        //     - uses: actions/upload-artifact@v4
        //       with:
        //         name: Build TypeScript
        // was read as a step called "Build TypeScript". That name is already in
        // COVERAGE, duplicates are dropped, and an unmapped step stayed
        // invisible — the exact hole the block parser was meant to close.
        const key = " ".repeat(indent + 4);
        const dash = `${" ".repeat(indent + 2)}- `;
        let name: string | null = null;
        for (const line of current) {
            const own = line.startsWith(dash)
                ? line.slice(dash.length)
                : line.startsWith(key) && line[indent + 4] !== " "
                    ? line.slice(key.length)
                    : null;
            if (own === null) continue;
            const m = own.match(/^name:\s*(.+?)\s*$/);
            if (m) { name = m[1]; break; }
        }
        blocks.push({ name, body });
        current = null;
    };
    for (const line of lines) {
        const steps = line.match(/^(\s*)steps:\s*$/);
        if (steps) { flush(); inSteps = true; indent = steps[1].length; continue; }
        if (!inSteps) continue;
        const item = line.match(/^(\s*)-\s/);
        // A non-blank line at or left of `steps:` ends the block list.
        if (line.trim() && !line.startsWith(" ".repeat(indent + 1))) { flush(); inSteps = false; continue; }
        if (item && item[1].length === indent + 2) { flush(); current = [line]; continue; }
        if (current) current.push(line);
    }
    flush();
    return blocks;
};

const stepBlocks = workflowStepBlocks();
const workflowSteps = stepBlocks
    .map((b) => b.name)
    .filter((n): n is string => n !== null)
    .filter((v, i, a) => a.indexOf(v) === i);

describe("local-ci.sh runs what CI runs", () => {
    it("the workflow has steps to compare, so this suite is not vacuous", () => {
        expect(workflowSteps.length).toBeGreaterThan(8);
    });

    it("finds step blocks, not just names, so an unnamed step is visible", () => {
        expect(stepBlocks.length).toBeGreaterThanOrEqual(workflowSteps.length);
        expect(stepBlocks.length).toBeGreaterThan(8);
    });

    it("every workflow step has a name, or COVERAGE cannot see it", () => {
        const unnamed = stepBlocks
            .filter((b) => b.name === null)
            .map((b) => b.body.trim().split("\n")[0]);
        expect(unnamed, "an unnamed step runs in CI with nothing mapping it").toEqual([]);
    });

    it("every CI step is either covered locally or declared impossible", () => {
        const undeclared = workflowSteps.filter((s) => !(s in COVERAGE));
        expect(undeclared,
            "a new CI step must be added to COVERAGE, mapped or explained",
        ).toEqual([]);
    });

    it("every step declared covered actually appears in local-ci.sh", () => {
        const missing = Object.entries(COVERAGE)
            .filter(([, local]) => local !== null)
            // An INVOCATION at the start of a line, not the label anywhere in
            // the file. `# temporarily disabled: "Build TypeScript"` satisfied
            // a plain includes() while the step was gone.
            .filter(([, local]) => !new RegExp(`^\\s*step\\s+"${local.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "m").test(localCi))
            .map(([ci, local]) => `${ci} -> ${local}`);
        expect(missing, "declared covered but no such step in local-ci.sh").toEqual([]);
    });
});

describe("the private-identifier list has one source", () => {
    it("lists terms, and enough of them", () => {
        const terms = privateIdentifierTerms();
        expect(terms.length).toBeGreaterThanOrEqual(5);
        expect(terms.every((t) => t.length > 4)).toBe(true);
    });

    /**
     * RUN IT, the way CI does. Importing the module proves the array is there;
     * it says nothing about whether the script PRINTS when executed. Those came
     * apart: `import.meta.url === `file://${process.argv[1]}`` is true on macOS
     * and false on Windows, where argv[1] is a backslash path. The script
     * printed nothing, both Windows legs loaded an empty list, and only the
     * callers' empty-list check stopped the guard from passing every file.
     * Mutation-checked, and the result is only half of what it looks like.
     * Making the script print nothing turns this red HERE. Putting the
     * Windows-fragile form back leaves it GREEN here, because on macOS that
     * form is correct. So this test would not have caught the defect on my
     * machine; it catches it on the Windows legs, which is where the defect
     * lives. Do not read a local pass as coverage of the platform it is for.
     */
    it("prints its terms when executed, not only when imported", () => {
        const r = spawnSync(process.execPath,
            [resolve(root, "scripts/private-identifier-terms.mjs")],
            { encoding: "utf8", timeout: 30_000 });
        expect(r.status, r.stderr).toBe(0);
        const printed = (r.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
        expect(printed, "executed output must not be empty").not.toEqual([]);
        expect(printed).toEqual(privateIdentifierTerms());
    });

    it("both the workflow and local-ci.sh read it rather than copying it", () => {
        for (const [what, text] of [["ci.yml", workflow], ["local-ci.sh", localCi]] as const) {
            expect(text, `${what} should invoke the shared list`)
                .toContain("private-identifier-terms.mjs");
        }
    });

    it("neither file hardcodes a term the other could miss", () => {
        // The halves are joined at runtime, so a file holding a whole term is a
        // file holding a copy of the list. This is how they drifted before.
        for (const [what, text] of [["ci.yml", workflow], ["local-ci.sh", localCi]] as const) {
            const copied = privateIdentifierTerms().filter((t) => text.includes(t));
            expect(copied, `${what} still hardcodes a term`).toEqual([]);
        }
    });

    it("the source file does not contain the terms it prints", () => {
        // Otherwise the guard matches its own list and the fix is an exclusion,
        // which is a hole in a leak guard.
        const src = readFileSync(resolve(root, "scripts/private-identifier-terms.mjs"), "utf8");
        const selfMatching = privateIdentifierTerms().filter((t) => src.includes(t));
        expect(selfMatching, "the list would match itself").toEqual([]);
    });
});
