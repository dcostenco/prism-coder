#!/usr/bin/env node
/**
 * The private identifiers that must never appear in this PUBLIC repository.
 * Prints one per line. Both the CI workflow and scripts/local-ci.sh read it,
 * so the list lives in exactly one place.
 *
 * WHY IT IS A SCRIPT AND NOT A TEXT FILE
 *
 * The guard greps every tracked file for each term. A plain list would contain
 * the terms verbatim and match itself, so every run would fail and the fix
 * would be to exclude the list from the scan — which is a hole in a leak guard.
 * Each term is assembled from halves here, so this file does not contain any
 * of them and needs no exclusion.
 *
 * WHY THE LIST GREW
 *
 * 2026-08-02: the guard checked ONE term and stayed green while a private
 * Vercel team slug and a private client project name shipped in the published
 * npm package. One term is a tripwire, not a guard. Every class of private
 * identifier needs its own entry.
 *
 * 2026-09-17: the workflow had five terms and local-ci.sh had four. A local run
 * passed while CI failed, which is the drift this file removes. Asserted by
 * tests/localCiParity.test.ts.
 */
import { pathToFileURL } from "node:url";

const TERMS = [
    ["synalux", "-private"],        // private repo name
    ["dcostencos", "-projects"],    // private Vercel team slug
    ["bcba", "-private"],           // private client project name
    ["prism-aac", "-internal"],     // private application repo name
    ["/Users/", "admin"],           // maintainer-local absolute paths
];

export const privateIdentifierTerms = () => TERMS.map(parts => parts.join(""));

// pathToFileURL, NOT `file://${process.argv[1]}`. On Windows argv[1] is
// D:\a\repo\scripts\x.mjs while import.meta.url is file:///D:/a/repo/...,
// so the string form never matches, the script prints nothing, and the caller
// loads an empty term list. That is exactly what happened: both Windows legs
// went red on the first push, caught by the empty-list check in the callers
// rather than by silently passing every file. Asserted in
// tests/localCiParity.test.ts by running this script the way CI does.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    console.log(privateIdentifierTerms().join("\n"));
}
