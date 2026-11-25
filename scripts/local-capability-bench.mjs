#!/usr/bin/env node
/**
 * Local capability bench — is a local tier good enough to REPLACE a cloud call?
 * ────────────────────────────────────────────────────────────────────────────
 * Every task here is verified DETERMINISTICALLY. There is no LLM judge, no
 * similarity score, and no human eyeballing. A task passes only when:
 *
 *   code    — the generated function is executed against real assertions
 *   parse   — the emitted JSON deep-equals the expected object
 *   vision  — the required tokens are present in the answer AND a decoy that
 *             is NOT in the image is absent (guards against confident guessing)
 *   classify— the label matches exactly
 *
 * The decoy check matters: a vision model that answers plausibly without
 * looking would pass a presence-only test. Requiring absence of a decoy that
 * is not in the image makes "guessed the answer" fail.
 *
 * Tiers are skipped — never silently downgraded — when free RAM cannot hold
 * them, so this same run is meaningful on a 16GB laptop and a 128GB desktop.
 *
 * Usage:
 *   node scripts/local-capability-bench.mjs
 *   node scripts/local-capability-bench.mjs --models prism-coder:9b,prism-coder:4b
 *   node scripts/local-capability-bench.mjs --classes code,parse
 *   node scripts/local-capability-bench.mjs --json out.json
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const OLLAMA = process.env.OLLAMA_URL ?? "http://localhost:11434";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "prism-bench-"));

// ── tier table: IMPORTED, never copied ──────────────────────────────────────
// An earlier revision of this file kept its own copy of the tier table. It
// drifted immediately: the copy said 9b ctxTokens 32_768 (what the tier really
// serves) while MODEL_TIERS says 4_096 (deliberately fail-safe until the
// Modelfile pins num_ctx). Two numbers describing one thing is how a bench ends
// up measuring a machine production never runs on, so the copy is gone.
//
// Everything gate-related now comes from the built artefact prism itself uses:
// MODEL_TIERS for minFreeGb / ctxTokens / prefersThinking, resolveOllamaName for
// the dcostenco/ prefix, and probeVision for the projector layer — a LIVE
// /api/show capability check rather than a hardcoded boolean, which is what
// production does. If the tier table changes, this bench changes with it and
// cannot silently disagree.
//
// Consequence worth seeing rather than hiding: with the real ctxTokens, the
// long-context task is GATED on 9b and 27b at 4_096. That is not a bench
// limitation, it is the §5.4 gate refusing prompts those tiers could in fact
// serve — visible here instead of masked by a divergent copy.
const { MODEL_TIERS, resolveOllamaName } = await import("../dist/utils/modelPicker.js");
const { probeVision } = await import("../dist/tools/prismInferHandler.js");
const { getAvailableMemoryBytes: freeBytes } = await import("../dist/utils/availableMemory.js");

/** Rough token estimate, matching the handler's chars/4 convention. */
const estTokens = (s) => Math.ceil(String(s ?? "").length / 4);
const IMAGE_TOKENS = 3_000; // flat per-image estimate, as in the ctx gate

// ── helpers ─────────────────────────────────────────────────────────────────
const gb = (b) => (b / 1024 ** 3).toFixed(1);

function stripFence(s) {
    const m = String(s ?? "").match(/```(?:\w+)?\s*\n([\s\S]*?)```/);
    return (m ? m[1] : String(s ?? "")).trim();
}

/** Pull the first balanced JSON object/array out of a noisy response. */
function extractJson(s) {
    const t = stripFence(s);
    const start = t.search(/[[{]/);
    if (start < 0) return null;
    const open = t[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
        const c = t[i];
        if (esc) { esc = false; continue; }
        if (c === "\\") { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === open) depth++;
        else if (c === close && --depth === 0) {
            try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; }
        }
    }
    return null;
}

const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * `think` mirrors prism's mode matrix (prism-infer-boundaries §D):
 *   route  (classify / parse / extract / vision) -> thinking OFF
 *   code   (generation / analysis)               -> thinking ON
 *
 * This is not a cosmetic knob. These models emit reasoning into a separate
 * `thinking` channel that still draws from `num_predict`. Leaving thinking on
 * for an extractive task with a small budget burns the entire allowance inside
 * <think> and returns an EMPTY response with done_reason="length" — measured:
 * 4b/2b at num_predict 600 produced 2503/2641 chars of thinking and zero
 * answer, while the same prompt with think:false answered correctly in 23
 * tokens. A bench that leaves this unset measures the budget, not the model.
 */
async function generate({ model, prompt, images, maxTokens = 512, think = false, timeoutMs = 120_000 }) {
    // /api/chat, NOT /api/generate. prism calls /api/chat everywhere that
    // matters (prismInferHandler.ts:698, localLlm.ts:159, layer1.ts:370/450);
    // /api/generate is only the eviction path. A raw prompt to /api/generate
    // bypasses the model's chat template — commit fcf72ade1 calls that "a path
    // no caller exercises" and re-measured the tier table after an earlier
    // harness made exactly this mistake. Measured here on 12 solid-colour
    // blanks: prism-coder:9b scored 8/12 via /api/generate and 12/12 via
    // /api/chat, so benching the wrong endpoint reads as a model defect.
    const msg = { role: "user", content: prompt };
    if (images?.length) msg.images = images;
    const t0 = Date.now();
    try {
        const res = await fetch(`${OLLAMA}/api/chat`, {
            method: "POST",
            body: JSON.stringify({
                model, messages: [msg], stream: false, think,
                options: { num_predict: maxTokens, temperature: 0 },
            }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return { ok: false, err: `HTTP ${res.status}`, ms: Date.now() - t0 };
        const j = await res.json();
        return {
            ok: true,
            text: j.message?.content ?? "",
            promptTokens: j.prompt_eval_count ?? 0,
            outTokens: j.eval_count ?? 0,
            doneReason: j.done_reason,
            ms: Date.now() - t0,
        };
    } catch (e) {
        return { ok: false, err: e.name === "TimeoutError" ? "timeout" : String(e.message), ms: Date.now() - t0 };
    }
}

/** Write the generated function to disk and execute real assertions against it. */
function runCode(source, exportName, checks) {
    const file = path.join(TMP, `c${Math.abs(hash(source))}.mjs`);
    const harness = `${source}\n\nexport { ${exportName} };\n`;
    fs.writeFileSync(file, harness);
    const driver = path.join(TMP, `d${Math.abs(hash(source))}.mjs`);
    fs.writeFileSync(driver, `
import { ${exportName} as fn } from ${JSON.stringify(file)};
const checks = ${JSON.stringify(checks)};
let pass = 0;
for (const c of checks) {
  try {
    if (c.throws) {
      let threw = false;
      try { fn(...c.args); } catch (e) { threw = e.constructor.name === c.throws; }
      if (threw) pass++; else { console.error('FAIL expected throw', JSON.stringify(c)); }
    } else {
      const got = fn(...c.args);
      if (JSON.stringify(got) === JSON.stringify(c.expect)) pass++;
      else console.error('FAIL', JSON.stringify(c), 'got', JSON.stringify(got));
    }
  } catch (e) { console.error('THREW', JSON.stringify(c), e.message); }
}
console.log('PASSED', pass, 'of', checks.length);
process.exit(pass === checks.length ? 0 : 1);
`);
    try {
        execFileSync(process.execPath, [driver], { timeout: 15_000, stdio: "pipe" });
        return { pass: true };
    } catch (e) {
        const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim().split("\n").slice(-2).join(" | ");
        return { pass: false, detail: out.slice(0, 160) };
    }
}

function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

// ── vision fixture: generated, so ground truth is exact ─────────────────────
// A real screenshot's "correct answer" is a judgement call. A fixture we render
// ourselves has a known-exact answer AND a known-absent decoy.
function makeVisionFixture() {
    const png = path.join(TMP, "invoice.png");
    const svg = path.join(TMP, "invoice.svg");
    fs.writeFileSync(svg, `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">
<rect width="640" height="360" fill="#ffffff"/>
<text x="40" y="70"  font-family="Helvetica" font-size="30" fill="#111">INVOICE  INV-4417</text>
<text x="40" y="140" font-family="Helvetica" font-size="24" fill="#111">Vendor: Northwind Supply</text>
<text x="40" y="190" font-family="Helvetica" font-size="24" fill="#111">Due date: 2026-09-14</text>
<text x="40" y="250" font-family="Helvetica" font-size="34" fill="#b00020">TOTAL DUE: $2,431.60</text>
<text x="40" y="310" font-family="Helvetica" font-size="20" fill="#555">Status: UNPAID</text>
</svg>`);
    try {
        // rsvg-convert / qlmanage / sips — take whichever exists.
        try { execFileSync("rsvg-convert", ["-o", png, svg], { stdio: "pipe" }); }
        catch {
            execFileSync("qlmanage", ["-t", "-s", "640", "-o", TMP, svg], { stdio: "pipe" });
            const made = path.join(TMP, "invoice.svg.png");
            if (fs.existsSync(made)) fs.renameSync(made, png);
        }
    } catch { return null; }
    return fs.existsSync(png) ? png : null;
}

// ── task set ────────────────────────────────────────────────────────────────
const NO_TOOLCALL = "Output plain text only. Do not output <|tool_call|>, <|tool_call_end|>, <tool_call>, or any JSON tool-call objects. Generate the requested content directly.";

function buildTasks(visionPng) {
    const tasks = [];

    // ---- CODE: executed, not eyeballed --------------------------------------
    tasks.push({
        cls: "code", name: "chunk-array", maxTokens: 1600, think: true,
        prompt: `${NO_TOOLCALL}\n\nWrite a JavaScript function named chunkBy(items, size) that splits an array into consecutive chunks of length size. If size is less than 1, throw a RangeError. Return ONLY a fenced javascript code block containing the function declaration. No explanation, no example usage.`,
        verify: (t) => runCode(stripFence(t), "chunkBy", [
            { args: [[1, 2, 3, 4, 5], 2], expect: [[1, 2], [3, 4], [5]] },
            { args: [[], 3], expect: [] },
            { args: [[1], 5], expect: [[1]] },
            { args: [[1, 2], 0], throws: "RangeError" },
        ]),
    });
    tasks.push({
        cls: "code", name: "semver-compare", maxTokens: 1600, think: true,
        prompt: `${NO_TOOLCALL}\n\nWrite a JavaScript function named cmpSemver(a, b) comparing two semantic version strings like "1.4.10". Return -1 if a<b, 1 if a>b, 0 if equal. Compare major, minor, patch numerically. Return ONLY a fenced javascript code block with the function declaration. No explanation.`,
        verify: (t) => runCode(stripFence(t), "cmpSemver", [
            { args: ["1.4.10", "1.4.9"], expect: 1 },
            { args: ["1.4.9", "1.4.10"], expect: -1 },
            { args: ["2.0.0", "2.0.0"], expect: 0 },
            { args: ["1.10.0", "1.9.99"], expect: 1 },
        ]),
    });

    // ---- PARSE: exact structural match --------------------------------------
    tasks.push({
        cls: "parse", name: "logline-extract", maxTokens: 300,
        prompt: `${NO_TOOLCALL}\n\nExtract fields from this log line into JSON.\n\nLINE:\n2026-08-14T09:12:44Z ERROR [billing.worker] tenant=acme-42 attempt=3 msg="charge declined" code=card_declined\n\nReturn ONLY a JSON object with exactly these keys: level, component, tenant, attempt, code. attempt must be a number. No prose, no code fence commentary.`,
        verify: (t) => {
            const got = extractJson(t);
            const want = { level: "ERROR", component: "billing.worker", tenant: "acme-42", attempt: 3, code: "card_declined" };
            return deepEq(got, want) ? { pass: true } : { pass: false, detail: `got ${JSON.stringify(got)}`.slice(0, 160) };
        },
    });
    tasks.push({
        cls: "parse", name: "csv-to-json", maxTokens: 400,
        prompt: `${NO_TOOLCALL}\n\nConvert this CSV to a JSON array of objects. Numeric columns must be numbers, not strings.\n\nsku,qty,price\nA-1,3,4.50\nB-2,10,1.25\n\nReturn ONLY the JSON array. No prose.`,
        verify: (t) => {
            const got = extractJson(t);
            const want = [{ sku: "A-1", qty: 3, price: 4.5 }, { sku: "B-2", qty: 10, price: 1.25 }];
            return deepEq(got, want) ? { pass: true } : { pass: false, detail: `got ${JSON.stringify(got)}`.slice(0, 160) };
        },
    });
    tasks.push({
        cls: "parse", name: "json-repair", maxTokens: 300,
        prompt: `${NO_TOOLCALL}\n\nThis JSON is malformed (trailing comma, single quotes, unquoted key). Repair it.\n\n{'name': 'widget', qty: 4, tags: ['a','b',],}\n\nReturn ONLY the corrected, valid JSON object. No prose.`,
        verify: (t) => {
            const got = extractJson(t);
            const want = { name: "widget", qty: 4, tags: ["a", "b"] };
            return deepEq(got, want) ? { pass: true } : { pass: false, detail: `got ${JSON.stringify(got)}`.slice(0, 160) };
        },
    });

    // ---- PARSE (long context): the num_ctx regression test -------------------
    // A ~6k-token log with one unique needle placed ~85% of the way in. A tier
    // whose num_ctx is 4096 physically cannot see the needle — Ollama truncates
    // the prompt silently and the model answers from the fragment. This is the
    // test that must FAIL on stock prism-coder:9b (num_ctx 4096, and no
    // PARAMETER line at all after the 2026-08-14 push) and PASS on the rebuilt
    // tag at num_ctx 32768.
    {
        const lines = [];
        for (let i = 0; i < 420; i++) {
            lines.push(`2026-08-${String(10 + (i % 6)).padStart(2, "0")}T09:${String(i % 60).padStart(2, "0")}:11Z INFO [svc.worker] tenant=t-${1000 + i} attempt=1 msg="request ok" code=ok`);
        }
        lines.splice(Math.floor(lines.length * 0.85), 0,
            `2026-08-15T04:02:59Z FATAL [ledger.reconcile] tenant=zephyr-77 attempt=9 msg="ledger drift detected" code=drift_9931`);
        const log = lines.join("\n");
        tasks.push({
            cls: "longctx", name: "needle-6k-log", maxTokens: 200,
            prompt: `${NO_TOOLCALL}\n\nHere is a log file. Exactly one line has level FATAL.\n\n${log}\n\nReturn ONLY a JSON object with keys: tenant, code, attempt (number), taken from the FATAL line. No prose.`,
            verify: (t) => {
                const got = extractJson(t);
                const want = { tenant: "zephyr-77", code: "drift_9931", attempt: 9 };
                return deepEq(got, want) ? { pass: true } : { pass: false, detail: `got ${JSON.stringify(got)}`.slice(0, 150) };
            },
        });
    }

    // ---- CLASSIFY: exact label ----------------------------------------------
    for (const [name, text, want] of [
        ["cls-bug", "The checkout button does nothing on Safari 17, works on Chrome.", "BUG"],
        ["cls-feature", "Could you add a dark mode toggle to the settings page?", "FEATURE"],
        ["cls-question", "Where do I find my API key in the dashboard?", "QUESTION"],
    ]) {
        tasks.push({
            cls: "classify", name, maxTokens: 8,
            prompt: `${NO_TOOLCALL}\n\nClassify the support ticket as exactly one word: BUG, FEATURE, or QUESTION.\n\nTicket: "${text}"\n\nAnswer (one word):`,
            verify: (t) => {
                const got = stripFence(t).toUpperCase().match(/\b(BUG|FEATURE|QUESTION)\b/)?.[1];
                return got === want ? { pass: true } : { pass: false, detail: `got ${JSON.stringify(stripFence(t).slice(0, 40))}` };
            },
        });
    }

    // ---- VISION: presence AND decoy-absence ---------------------------------
    if (visionPng) {
        const b64 = fs.readFileSync(visionPng).toString("base64");
        tasks.push({
            cls: "vision", name: "invoice-total", maxTokens: 120, images: [b64],
            prompt: `${NO_TOOLCALL}\n\nRead this invoice image. Reply with ONLY the invoice number and the total due amount, separated by a space. Nothing else.`,
            verify: (t) => {
                const s = stripFence(t).replace(/\s+/g, " ");
                const hasId = /INV-?4417/i.test(s);
                const hasTotal = /2[,.]?431[.,]60/.test(s);
                // 4418 / 1234.00 never appear in the image — a guesser trips these.
                const decoy = /INV-?4418|1234\.00/i.test(s);
                return hasId && hasTotal && !decoy
                    ? { pass: true }
                    : { pass: false, detail: `id=${hasId} total=${hasTotal} decoy=${decoy} :: ${s.slice(0, 80)}` };
            },
        });
        tasks.push({
            cls: "vision", name: "invoice-status", maxTokens: 60, images: [b64],
            prompt: `${NO_TOOLCALL}\n\nRead this invoice image. Is the status PAID or UNPAID? Answer with exactly one word.`,
            verify: (t) => {
                const s = stripFence(t).toUpperCase();
                const unpaid = /\bUNPAID\b/.test(s);
                return unpaid ? { pass: true } : { pass: false, detail: s.slice(0, 60) };
            },
        });
    }

    return tasks;
}

// ── runner ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

const onlyModels = argOf("--models")?.split(",").map((s) => s.trim());
const onlyClasses = argOf("--classes")?.split(",").map((s) => s.trim());
const jsonOut = argOf("--json");

const installed = new Set(
    (await (await fetch(`${OLLAMA}/api/tags`)).json()).models.map((m) => m.name.replace(/:latest$/, ""))
);
const resolve = (tag) => { const n = resolveOllamaName(tag, installed); return installed.has(n) ? n : null; };

const visionPng = makeVisionFixture();
const allTasks = buildTasks(visionPng);
const tasks = onlyClasses ? allTasks.filter((t) => onlyClasses.includes(t.cls)) : allTasks;

console.log(`Local capability bench — ${tasks.length} deterministic tasks`);
console.log(`host RAM ${gb(os.totalmem())}GB, free ${gb(freeBytes())}GB`);
console.log(`vision fixture: ${visionPng ?? "UNAVAILABLE (svg render failed — vision tasks skipped)"}`);
console.log("");

const results = [];
for (const tier of MODEL_TIERS) {
    const tag = resolve(tier.tag);
    if (onlyModels && !onlyModels.includes(tier.tag)) continue;
    if (!tag) { console.log(`── ${tier.tag}: SKIPPED (not installed)`); continue; }
    const free = freeBytes();
    if (free < tier.minFreeGb * 1024 ** 3) {
        console.log(`── ${tier.tag}: SKIPPED (needs ${tier.minFreeGb}GB free, have ${gb(free)}GB)`);
        results.push({ model: tier.tag, skipped: `ram<${tier.minFreeGb}GB` });
        continue;
    }
    // Live capability probe, exactly as the handler does — not a hardcoded flag.
    let hasVision = false;
    try { hasVision = await probeVision(OLLAMA, tag); } catch { hasVision = false; }
    console.log(`── ${tier.tag} (resolved ${tag}${hasVision ? "" : ", text-only"})`);
    const rows = [];
    for (const t of tasks) {
        // Gate BEFORE calling, exactly as prism does — a tier that cannot serve
        // the task is skipped, never scored against it.
        if (t.images?.length && !hasVision) {
            rows.push({ cls: t.cls, name: t.name, skipped: "no_vision" });
            console.log(`   SKIP  ${t.cls.padEnd(9)}${t.name.padEnd(18)}${"".padStart(7)}   no_vision`);
            continue;
        }
        const promptTok = estTokens(t.prompt) + (t.images?.length ?? 0) * IMAGE_TOKENS + 64;
        if (tier.ctxTokens && promptTok > tier.ctxTokens) {
            rows.push({ cls: t.cls, name: t.name, skipped: "ctx_insufficient" });
            console.log(`   SKIP  ${t.cls.padEnd(9)}${t.name.padEnd(18)}${"".padStart(7)}   ctx_insufficient (${promptTok} tok > ${tier.ctxTokens})`);
            continue;
        }
        const think = t.think === true && tier.prefersThinking === true;
        const r = await generate({ model: tag, prompt: t.prompt, images: t.images, maxTokens: t.maxTokens, think });
        let v = { pass: false, detail: r.ok ? "" : r.err };
        if (r.ok) { try { v = t.verify(r.text); } catch (e) { v = { pass: false, detail: `verifier threw: ${e.message}` }; } }
        rows.push({ cls: t.cls, name: t.name, pass: v.pass, ms: r.ms, out: r.outTokens ?? 0, detail: v.detail ?? "" });
        console.log(`   ${v.pass ? "PASS" : "FAIL"}  ${t.cls.padEnd(9)}${t.name.padEnd(18)}${String(r.ms).padStart(7)}ms  ${v.pass ? "" : (v.detail ?? "").slice(0, 90)}`);
    }
    const scored = rows.filter((r) => !r.skipped);
    const p = scored.filter((r) => r.pass).length;
    const nSkip = rows.length - scored.length;
    console.log(`   → ${p}/${scored.length} passed${nSkip ? ` (${nSkip} skipped by tier gate)` : ""}, median ${median(scored.map((r) => r.ms))}ms\n`);
    results.push({ model: tier.tag, passed: p, total: scored.length, rows });
    // Release the tier before loading the next one, so the RAM gate above is honest.
    await fetch(`${OLLAMA}/api/generate`, { method: "POST", body: JSON.stringify({ model: tag, keep_alive: 0 }) }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1200));
}

function median(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

// ── summary matrix ──────────────────────────────────────────────────────────
const classes = [...new Set(tasks.map((t) => t.cls))];
console.log("SUMMARY (pass/total by class)");
console.log("model".padEnd(20) + classes.map((c) => c.padEnd(11)).join("") + "TOTAL");
console.log("-".repeat(20 + classes.length * 11 + 8));
for (const r of results) {
    if (r.skipped) { console.log(`${r.model.padEnd(20)}SKIPPED — ${r.skipped}`); continue; }
    const cells = classes.map((c) => {
        const sub = r.rows.filter((x) => x.cls === c && !x.skipped);
        const skipped = r.rows.filter((x) => x.cls === c && x.skipped).length;
        if (!sub.length && skipped) return "gated".padEnd(11);
        return `${sub.filter((x) => x.pass).length}/${sub.length}`.padEnd(11);
    });
    console.log(`${r.model.padEnd(20)}${cells.join("")}${r.passed}/${r.total}`);
}

if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify({ host: { totalGb: +gb(os.totalmem()) }, results }, null, 2));
    console.log(`\njson → ${jsonOut}`);
}
const anyRun = results.some((r) => !r.skipped);
process.exit(anyRun ? 0 : 2);
