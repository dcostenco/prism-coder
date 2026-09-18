import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
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

const workflowSteps = [...workflow.matchAll(/^\s*-\s*name:\s*(.+?)\s*$/gm)]
    .map((m) => m[1])
    .filter((v, i, a) => a.indexOf(v) === i);

describe("local-ci.sh runs what CI runs", () => {
    it("the workflow has steps to compare, so this suite is not vacuous", () => {
        expect(workflowSteps.length).toBeGreaterThan(8);
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
            .filter(([, local]) => !localCi.includes(`"${local}"`))
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
