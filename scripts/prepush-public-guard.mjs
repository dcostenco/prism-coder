#!/usr/bin/env node
/**
 * Pre-push guard for a PUBLIC repository.
 *
 * Gap this closes (2026-08-26): check-no-private-content.mjs runs at
 * prepublish and in CI — both AFTER a push is already public. Nothing ran at
 * push time, and nothing anywhere scanned outgoing COMMIT MESSAGES, which the
 * tracked-tree guard structurally cannot see. A leak caught in CI is a leak
 * that already shipped; this hook is the only link that can refuse before
 * bytes leave the machine.
 *
 * What it does, per outgoing ref (pre-push stdin protocol):
 *   1. Runs scripts/check-no-private-content.mjs (the tracked-tree guard) and
 *      scripts/private-identifier-scan.mjs (private names, written out or
 *      assembled from pieces).
 *   2. Scans the outgoing RANGE — every commit's diff AND message — for:
 *      a. generic secret shapes (private key blocks, JWTs, hex/base64 key
 *         assignments, cloud tokens), and context that should never appear in
 *         a public repo (home-directory paths, infrastructure project refs).
 *      b. OPTIONAL machine-local markers from ~/.prism-mcp/private-markers.txt
 *         (one substring per line, "#" comments). This file is deliberately
 *         OUTSIDE the repo: the most important markers are themselves private
 *         (a private repo's name, an internal hostname), so committing them
 *         to a public guard would be the leak the guard exists to prevent.
 *
 * Never weaken a refusal into a warning here: an operator who wants to push
 * anyway can re-run with PRISM_PUBLIC_GUARD=off, which at least makes the
 * override a deliberate, logged act.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.PRISM_PUBLIC_GUARD === "off") {
    console.error("[public-guard] PRISM_PUBLIC_GUARD=off — refusals disabled FOR THIS PUSH.");
    process.exit(0);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ZERO = "0000000000000000000000000000000000000000";

function git(...args) {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// ── Generic patterns: safe to publish, catch the classes that matter ─────────
const GENERIC = [
    { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: "private key block" },
    { re: /eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, why: "JWT-shaped token" },
    { re: /\b(sk|rk|pk)-[A-Za-z0-9]{20,}\b/, why: "API-key-shaped token" },
    { re: /\bsynalux_sk_[A-Za-z0-9]+/, why: "Synalux API token" },
    { re: /\b(api[_-]?key|secret|password|access[_-]?token)\b['"]?\s*[:=]\s*['"][^'"\n]{12,}['"]/i,
      why: "credential assignment with a literal value" },
    { re: /\/Users\/[a-z0-9_-]+\//i, why: "home-directory path (machine/context disclosure)" },
    { re: /\bsupabase\.co\/(project|dashboard)\/[a-z]{20}\b/, why: "infrastructure project reference" },
    { re: /https?:\/\/[a-z]{20}\.supabase\.co/, why: "infrastructure project URL" },
];

// ── Machine-local markers: the terms too sensitive to commit here ────────────
function localMarkers() {
    const path = process.env.PRISM_PRIVATE_MARKERS_FILE ?? join(homedir(), ".prism-mcp", "private-markers.txt");
    if (!existsSync(path)) return { path, markers: [] };
    const markers = readFileSync(path, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
    return { path, markers };
}

function scanText(text, label, findings) {
    for (const { re, why } of GENERIC) {
        const m = text.match(re);
        // Report the CLASS and location, never the matched value: this guard's
        // own output must not become the transcript-leak it prevents.
        if (m) findings.push(`${label}: ${why}`);
    }
    for (const marker of MARKERS.markers) {
        if (text.toLowerCase().includes(marker.toLowerCase())) {
            findings.push(`${label}: machine-local private marker #${MARKERS.markers.indexOf(marker) + 1} (see ${MARKERS.path})`);
        }
    }
}

const MARKERS = localMarkers();
if (MARKERS.markers.length === 0) {
    console.error(`[public-guard] note: no machine-local markers at ${MARKERS.path} — running generic patterns only.`);
}

// ── 1. Tracked-tree guard ────────────────────────────────────────────────────
try {
    execFileSync(process.execPath, [join(repoRoot, "scripts", "check-no-private-content.mjs")], {
        cwd: repoRoot, stdio: ["ignore", "inherit", "inherit"],
    });
} catch {
    console.error("[public-guard] BLOCKED: check-no-private-content failed on the tracked tree.");
    process.exit(1);
}

// ── 1b. Private identifiers, written out or assembled from pieces ────────────
// check-no-private-content covers paths and content rules, not identifiers.
// The literal identifier guard runs in CI, after a push is already public, and
// cannot see a name built at runtime. This scan runs before bytes leave.
try {
    execFileSync(process.execPath, [join(repoRoot, "scripts", "private-identifier-scan.mjs")], {
        cwd: repoRoot, stdio: ["ignore", "inherit", "inherit"],
    });
} catch {
    console.error("[public-guard] BLOCKED: private-identifier-scan failed on the tracked tree.");
    process.exit(1);
}

// ── 2. Outgoing-range scan (diffs + commit messages) ─────────────────────────
const stdin = readFileSync(0, "utf8").trim();
const findings = [];
let commitsScanned = 0;

for (const line of stdin ? stdin.split("\n") : []) {
    const [, localSha, , remoteSha] = line.split(" ");
    if (!localSha || localSha === ZERO) continue; // deleting a ref pushes nothing

    // New ref: scan what the remote does not have; known ref: scan the delta.
    const range = remoteSha && remoteSha !== ZERO
        ? `${remoteSha}..${localSha}`
        : `${localSha} --not --remotes`;

    let commits;
    try {
        commits = git("rev-list", ...range.split(" ")).split("\n").filter(Boolean);
    } catch {
        console.error(`[public-guard] BLOCKED: could not resolve outgoing range for ${line}`);
        process.exit(1);
    }

    for (const sha of commits) {
        commitsScanned++;
        scanText(git("log", "-1", "--format=%B", sha), `commit message ${sha.slice(0, 9)}`, findings);
        scanText(git("show", "--format=", sha), `commit diff ${sha.slice(0, 9)}`, findings);
    }
}

if (findings.length > 0) {
    console.error("[public-guard] PUSH BLOCKED — outgoing commits contain material that must not go public:");
    for (const f of [...new Set(findings)]) console.error(`  ✗ ${f}`);
    console.error("[public-guard] Fix the commits (rewrite before the content is ever public).");
    console.error("[public-guard] Deliberate override: PRISM_PUBLIC_GUARD=off git push …");
    process.exit(1);
}

console.error(`[public-guard] ✓ tracked tree clean; ${commitsScanned} outgoing commit(s) scanned (diffs + messages), ${MARKERS.markers.length} local marker(s) active.`);
