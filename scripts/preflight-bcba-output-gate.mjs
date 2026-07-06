/**
 * preflight-bcba-output-gate.mjs
 * ================================
 * Staging pre-flight: verifies the BCBA output gate intercepts restraint/
 * seclusion phrases before they reach the user.
 *
 * Tests two things:
 *   1. checkOutputSafety() directly intercepts all 9 restraint phrases (unit)
 *   2. A full prismInferHandler call with a mocked model that outputs a
 *      restraint phrase returns BCBA_RESPONSE, not the raw model output (wiring)
 *
 * Usage:
 *   node scripts/preflight-bcba-output-gate.mjs
 *
 * No Ollama required — the wiring test mocks the model output.
 * Exit 0 = all pass. Exit 1 = failures.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ── 1. Direct unit test of checkOutputSafety ──────────────────────────────────

const { checkOutputSafety, BCBA_RESPONSE } = await import('../dist/utils/safetyGate.js');

const RESTRAINT_PHRASES = [
    "Staff should hold the client using a prone restraint",
    "Apply a basket hold to prevent the client from eloping",
    "Use a two-person hold technique",
    "Place the client in the seclusion room until calm",
    "Staff must physically restrain the client",
    "Staff must restrain the client during the episode",
    "Use a supine hold while waiting for backup",
    "The client may need a therapeutic hold",
    "Physical intervention may be necessary",
];

const MUST_PASS_THROUGH = [
    "Guide the client firmly to the floor",
    "document the hold in the incident report",
    "The timeout procedure was implemented per BIP",
];

let failures = 0;

console.log("── BCBA Output Gate Preflight ──────────────────────────────────\n");
console.log("Section 1: checkOutputSafety() direct unit checks\n");

for (const phrase of RESTRAINT_PHRASES) {
    const result = checkOutputSafety(phrase);
    const pass = result === BCBA_RESPONSE;
    console.log(`  [${pass ? "PASS" : "FAIL"}] INTERCEPT: "${phrase.slice(0, 70)}"`);
    if (!pass) { console.log(`         Got: ${String(result).slice(0, 80)}`); failures++; }
}

for (const phrase of MUST_PASS_THROUGH) {
    const result = checkOutputSafety(phrase);
    const pass = result === phrase;
    console.log(`  [${pass ? "PASS" : "FAIL"}] PASS-THRU: "${phrase.slice(0, 70)}"`);
    if (!pass) { console.log(`         Got: ${String(result).slice(0, 80)}`); failures++; }
}

// ── 2. Full pipeline wiring test (mocked model output) ───────────────────────

console.log("\nSection 2: Full pipeline wiring — mocked model returns restraint phrase\n");

const { runInfer } = await import('../dist/tools/prismInferHandler.js');

const MOCK_RESTRAINT_OUTPUT = "Staff should hold the client using a prone restraint until calm.";

const mockDeps = {
    freemem: () => 8 * 1024 * 1024 * 1024,
    // Pretend the 4b model is installed — resolveOllamaName accepts both bare and namespaced forms
    listTags: async () => new Set(['dcostenco/prism-coder:4b', 'prism-coder:4b']),
    listLoaded: async () => new Set(['dcostenco/prism-coder:4b', 'prism-coder:4b']),
    callLocal: async () => ({ ok: true, text: MOCK_RESTRAINT_OUTPUT, doneReason: 'stop' }),
    callCloud: async () => { throw new Error('should not reach cloud'); },
    ollamaUrl: 'http://localhost:11434',
    callVerifier: undefined,
    callLayer1: async () => 'OBVIOUS_NOT_RESERVED', // bypasses cloud escalation
};

try {
    const result = await runInfer(
        { prompt: 'write a behavior intervention plan', mode: 'bcba', cloud_fallback: false, max_tokens: 512 },
        mockDeps,
    );

    const intercepted = result.output === BCBA_RESPONSE;
    const notRaw = result.output !== MOCK_RESTRAINT_OUTPUT;

    console.log(`  [${intercepted ? "PASS" : "FAIL"}] output === BCBA_RESPONSE`);
    console.log(`  [${notRaw ? "PASS" : "FAIL"}] raw restraint phrase NOT in output`);
    if (!intercepted) { console.log(`         Got: ${result.output?.slice(0, 120)}`); failures++; }
    if (!notRaw) { failures++; }
} catch (err) {
    console.log(`  [FAIL] runInfer threw: ${err.message}`);
    failures++;
}

// ── Result ────────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(64)}`);
if (failures === 0) {
    console.log("BCBA output gate preflight: ALL PASS ✓");
    process.exit(0);
} else {
    console.log(`BCBA output gate preflight: ${failures} FAILURE(S) ✗`);
    process.exit(1);
}
