// Multi-turn benchmark: does carrying the conversation change what the local
// model answers on a follow-up? Conditions:
//   no_history : prompt only — what prism_infer sent before this change
//   messages   : role-structured prior turns — what it sends now
// Tasks are auto-graded (string/regex), temperature 0, num_predict small.
//
// WHAT THE SCORES MEAN, AND WHAT THEY DO NOT. Graders are LEXICAL: they look
// for the discriminating term, not for a correct answer. Every one of them can
// be passed by a wrong answer containing the right word — "He waved his hand
// angrily and shouted" scores correct on clinical:opdef.
//
// Do NOT defend that by saying the same grader runs on both arms and so
// inflates them equally. It does not. The discriminating term is present in
// the history, so only the MESSAGES arm is handed the vocabulary its grader
// rewards; the no_history arm has to invent it. False-positive rates are not
// equal and the delta is an OVER-estimate of carry-over, not a neutral one.
//
// Read a column as an upper bound, never as "the model answered correctly".
// Observed: with history, clinical:opdef returned "Raising a hand to call out"
// — it grades correct and is semantically confused. Two of three clinical
// answers were genuinely right on inspection; one was vocabulary.
//
// So read the score as KEYWORD CARRY-OVER, not as clinical correctness: it
// answers "did what the history said reach the answer", not "was the answer
// right". For factual recall those coincide ("Nightjar" is either recalled or
// not). For a task that asks the model to REASON over remembered content they
// do not. Never quote a clinical cell as accuracy.
//
// Do not tighten the graders into an arms race. For absolute correctness read
// the FULL per-task text, written to multi-turn-bench.full-<timestamp>.json — the
// stdout column is a 120-char preview and has been known to hide the part that
// decides the verdict.
// Fabrication = a confident WRONG specific answer (not a decline). Note the
// declined/fabricated SPLIT is soft: declineRe matches "don't" wherever it
// appears, so a long answer containing "issues don't happen again" reads as a
// decline. That makes `fabricated` an UNDER-count on long answers. The
// `correct` column is unaffected, and it is the one to quote.
// Run from the repo root after `npm run build`:  node scripts/bench/multi-turn-bench.mjs [model ...]
import { writeFileSync } from "node:fs";
const URL = "http://localhost:11434";
const MODELS = process.argv.slice(2).length ? process.argv.slice(2) : ["prism-coder:4b", "prism-coder:9b"];
const H = (u, a) => [{ role: "user", content: u }, { role: "assistant", content: a }];
// [id, history, follow-up prompt, grader(text) -> "correct"|"declined"|"fabricated"]
const declineRe = /(don't|do not|cannot|can't|no (prior|previous|earlier)|not (been )?(provided|specified|mentioned|given)|unknown|need more|no information|not have access)/i;
const grade = (ok, text) => ok(text) ? "correct" : (declineRe.test(text) ? "declined" : "fabricated");
// A decline and an invention can occur in the SAME answer: "I can't verify it,
// try 555-0100" matches declineRe and is exactly the failure prose:nofabricate
// exists to catch. Grading the hedge alone scores that correct.
// Counting DIGITS beats matching a shape, and defining a separator as "any
// character that is not a letter" beats listing them. Listing was the arms
// race: the first version needed 8 CHARACTERS and missed "5550100", the second
// listed punctuation and missed "555,0100", "555:0100" and "555_0100". Each
// round of enumeration produced the next hole. A run is now a digit followed by
// anything that is not a letter, and 7+ digits in one run is contact-sized.
// \p{Nd} and \p{L}, not \d and [A-Za-z]: the ASCII classes made the sentence
// above FALSE, and they were blind to "٥٥٥-٠١٠٠" and "５５５－０１００".
// This errs toward flagging (an ISO date carries 8 digits and counts), which is
// the safe direction for a guard whose purpose is catching a MISSED
// fabrication: a false alarm turns the control red and gets investigated, a
// miss is published as a passing score.
//
// WHERE IT STOPS, DELIBERATELY. Any non-letter separates, so every punctuation
// form is covered without listing one, in any script. It does NOT catch digits
// carried by LETTERS: spelled out ("five five five zero one zero zero") or
// vanity ("1-800-FLOWERS"). Catching those needs either a parser or a
// phone-shaped special case, and a phone-shaped special case is the thing this
// rule was rewritten to stop being. The adversary here is a local model
// answering a question, not someone crafting a bypass. All three limits — the
// two letter-carried misses and the ISO-date false alarm — are ASSERTED in
// --self-test, so they are visible rather than discovered.
const hasContactSizedNumber = t => {
  for (const m of String(t).matchAll(/\p{Nd}[^\p{L}]*/gu)) {
    if ((m[0].match(/\p{Nd}/gu) ?? []).length >= 7) return true;
  }
  return false;
};
const T = [];
// A. fact recall (5)
for (const [k, v] of [["codename","Nightjar"],["ticket","SYN-4471"],["region","eu-west-3"],["owner","Marisol"],["deadline","October 9"]]) {
  T.push([`recall:${k}`, H(`For this task the ${k} is ${v}. Acknowledge briefly without repeating it.`, "Acknowledged."),
    `What is the ${k}? Answer with the value only.`, t => grade(x => x.toLowerCase().includes(v.toLowerCase()), t)]);
}
// B. constraint carry-over (3): a format rule set in turn 1 must still hold
T.push(["constraint:json", H("From now on answer ONLY with a JSON object that has a single key \"answer\". Acknowledge.", "{\"answer\": \"ok\"}"),
  "What is 6 times 7?", t => grade(x => /"answer"\s*:/.test(x) && /42/.test(x), t)]);
T.push(["constraint:prefix", H("Every reply must start with the word CHECKED. Acknowledge.", "CHECKED. Understood."),
  "Name one primary colour.", t => grade(x => /^\s*CHECKED/.test(x), t)]);
T.push(["constraint:lang", H("Reply in Spanish only from now on. Acknowledge.", "Entendido."),
  "How many days are in a week? One short sentence.", t => grade(x => /siete|semana|d[ií]as/i.test(x), t)]);
// C. reference resolution (3)
T.push(["ref:second", H("Options: 1) Postgres 2) SQLite 3) DuckDB. Acknowledge.", "Noted the three options."),
  "Which one is the second option? Name only.", t => grade(x => /sqlite/i.test(x), t)]);
T.push(["ref:last", H("Steps: clone, install, build, deploy. Acknowledge.", "Noted the four steps."),
  "What is the last step? One word.", t => grade(x => /deploy/i.test(x), t)]);
T.push(["ref:pronoun", H("The function parseRows returns an array of Row objects. Acknowledge.", "Noted."),
  "What does it return? One short phrase.", t => grade(x => /array|row/i.test(x), t)]);
// D. arithmetic state (2)
T.push(["state:x", H("Let x = 7. Acknowledge.", "x is set."), "What is x times 6? Number only.", t => grade(x => /\b42\b/.test(x), t)]);
T.push(["state:list", H("My list is [3, 9, 4]. Acknowledge.", "Noted."), "What is the sum of my list? Number only.", t => grade(x => /\b16\b/.test(x), t)]);
// E. code continuation (2)
T.push(["code:call", H("We have a helper named countActiveUsers(rows). Acknowledge.", "Noted."),
  "Write one line of JavaScript that calls the helper on `data` and stores the result in `n`.", t => grade(x => /countActiveUsers\s*\(\s*data\s*\)/.test(x), t)]);
T.push(["code:rename", H("The class is called InvoiceLedger. Acknowledge.", "Noted."),
  "Write the TypeScript line that instantiates it into a const named ledger.", t => grade(x => /new\s+InvoiceLedger\s*\(/.test(x), t)]);

// F. prose / general-request continuation (4) — the goal is not code-only.
// `declined` is the CORRECT verdict for prose:nofabricate; see the grader.
T.push(["prose:terminology", H("In this report, status \"amber\" means degraded but serving. Acknowledge.", "Acknowledged."),
  "What does amber mean here? Under 8 words.", t => grade(x => /degrad/i.test(x), t)]);
T.push(["prose:onesentence", H("From now on answer in exactly one sentence. Acknowledge.", "Understood."),
  // At the shared 48-token budget every answer is cut mid-thought, so counting
  // sentence terminators measured TRUNCATION and scored correct in both arms.
  // 200 tokens lets a non-compliant answer actually run past one sentence.
  "Why do teams write postmortems?", t => grade(x => (x.trim().match(/[.!?](\s|$)/g) ?? []).length === 1, t),
  { maxTokens: 200 }]);
T.push(["prose:figure", H("The team closed 18 tickets last sprint. Acknowledge.", "Noted."),
  "At the same rate, how many across two sprints? Number only.", t => grade(x => /\b36\b/.test(x), t)]);
// Carrying history must not make the model MORE willing to invent. Here the
// answer is genuinely absent from the conversation, so declining IS correct.
T.push(["prose:nofabricate", H("The release train runs on Tuesdays. Acknowledge.", "Noted."),
  "What is the on-call engineer's phone number?",
  t => hasContactSizedNumber(t) ? "fabricated" : (declineRe.test(t) ? "correct" : "fabricated"),
  { kind: "control" }]);

// G. clinical, ROUTINE band only (3). No crisis, restraint or injury
// vocabulary: those never reach a local model, so benching them would measure
// a refusal rather than recall.
T.push(["clinical:opdef", H("Target behaviour: calling out, defined as an audible vocalisation during independent work without first raising a hand. Acknowledge.", "Noted."),
  "Give one NON-example of that behaviour. Under 10 words.", t => grade(x => /hand|wait|quiet|silent/i.test(x), t)]);
T.push(["clinical:measure", H("We record this behaviour as a frequency count each session. Acknowledge.", "Noted."),
  "What gets written down each session? Under 8 words.", t => grade(x => /count|frequen|number|tally|how many|times/i.test(x), t)]);
T.push(["clinical:replacement", H("The replacement behaviour is raising a hand and waiting to be called on. Acknowledge.", "Noted."),
  "What should staff reinforce? Under 8 words.", t => grade(x => /hand|wait/i.test(x), t)]);


// --- grader self-test: `node scripts/bench/multi-turn-bench.mjs --self-test`
// Runs the REAL graders in this file (not a copy) against answers whose
// verdict is known, so a loosened grader fails here instead of in a report.
// Needs no Ollama, so CI and a reviewer can both run it.
if (process.argv.includes("--self-test")) {
  const G = id => { const t = T.find(x => x[0] === id); if (!t) throw new Error(`no task ${id}`); return t[3]; };
  const CASES = [
    // The defect this file shipped with: a hedge AND an invented number scored
    // correct on the one task whose whole purpose is catching invention.
    ["prose:nofabricate", "I can't verify it; call 555-0100 for the on-call rota.", "fabricated"],
    ["prose:nofabricate", "It is 555-0100.", "fabricated"],
    // The form the first fix missed: no separator, 7 chars, 7 digits.
    ["prose:nofabricate", "I can't confirm, but try 5550100.", "fabricated"],
    ["prose:nofabricate", "Reach them on (555) 010-0000.", "fabricated"],
    ["prose:nofabricate", "I do not know it; try +1 555 010 0000.", "fabricated"],
    ["prose:nofabricate", "I can't verify it; call 555/0100.", "fabricated"],
    // The forms the ENUMERATED separator class missed; a listed class always
    // has a next hole, which is why the rule is now "anything not a letter".
    ["prose:nofabricate", "I can't verify it; call 555,0100.", "fabricated"],
    ["prose:nofabricate", "I can't verify it; call 555:0100.", "fabricated"],
    ["prose:nofabricate", "I can't verify it; call 555_0100.", "fabricated"],
    ["prose:nofabricate", "Try 555\u20110100, though I can't confirm.", "fabricated"],
    // Short numbers are not contact-sized and must not trip the guard.
    ["prose:nofabricate", "I don't have it. Ask the 3 leads on rota.", "correct"],
    // PINNED LIMIT (false alarm, accepted): a date carries 7+ digits, so a
    // decline that mentions one is called fabricated. Erring this way is the
    // safe direction — it turns the control red and gets looked at.
    ["prose:nofabricate", "I don't know; the rota was updated 2026-09-17.", "fabricated"],
    // Non-ASCII numerals: caught only because the classes are \p{Nd}/\p{L}.
    ["prose:nofabricate", "I can't verify it; call \u0665\u0665\u0665-\u0660\u0661\u0660\u0660.", "fabricated"],
    ["prose:nofabricate", "I can't verify it; call \uFF15\uFF15\uFF15\uFF0D\uFF10\uFF11\uFF10\uFF10.", "fabricated"],
    // PINNED LIMIT (miss, accepted): a vanity number hides its digits in
    // LETTERS, so no separator rule reaches it. Catching it needs a
    // phone-shaped special case, which is what this guard stopped being.
    ["prose:nofabricate", "I can't verify it; call 1-800-FLOWERS.", "correct"],
    // PINNED LIMIT (miss, accepted): digits spelled as words are not caught.
    // Asserted so the hole is documented, not discovered. Flipping this to
    // "fabricated" should be a deliberate act with a reason.
    ["prose:nofabricate", "I can't verify it; call five five five zero one zero zero.", "correct"],
    ["prose:nofabricate", "I don't have access to internal contact information.", "correct"],
    // A bare decline must still pass, or the fix has broken the control.
    ["prose:nofabricate", "That was not provided in our conversation.", "correct"],
    // Truncation used to satisfy this; two sentences must fail either way.
    ["prose:onesentence", "Teams learn from failure. They also share findings.", "fabricated"],
    ["prose:onesentence", "Teams write postmortems to learn from failure.", "correct"],
    // Recall is unambiguous: the value is present or it is not.
    ["recall:codename", "Nightjar", "correct"],
    ["recall:codename", "Sapphire", "fabricated"],
    // PINNED LOOSENESS, not an aspiration: clinical:opdef credits the keyword
    // even when the answer is semantically wrong. "Raising a hand to call out"
    // describes the TARGET behaviour, not a non-example, and still grades
    // correct. Asserting it keeps the summary's carry-over caveat honest — if
    // someone tightens this grader, this line tells them what changes.
    ["clinical:opdef", "Raising a hand to call out.", "correct"],
    ["clinical:opdef", "A person who is rude or unhelpful.", "fabricated"],
    // PINNED SOFTNESS: an incidental "don't" inside a real answer reads as a
    // decline, so the fabricated column under-counts on long answers. Observed
    // 2026-09-17 on prose:onesentence ("issues don't happen again").
    ["prose:onesentence", "One. Two. Bugs don't recur after this.", "declined"],
  ];
  // -v lists every case. "13 passed" tells a reader nothing about WHAT is
  // guarded, and an unreadable guard is one nobody maintains.
  const verbose = process.argv.includes("-v") || process.argv.includes("--verbose");
  let bad = 0;
  for (const [id, text, want] of CASES) {
    const got = G(id)(text);
    const ok = got === want;
    if (!ok) { bad++; console.error(`FAIL ${id}: expected ${want}, got ${got} for ${JSON.stringify(text)}`); }
    else if (verbose) console.log(`  ok  ${id.padEnd(19)} ${want.padEnd(10)} <- ${JSON.stringify(text)}`);
  }
  // Wiring, not just regexes: an option that never reaches the runner is inert.
  const nofab = T.find(x => x[0] === "prose:nofabricate");
  const onesent = T.find(x => x[0] === "prose:onesentence");
  if (nofab[4]?.kind !== "control") { bad++; console.error("FAIL prose:nofabricate is not marked a control"); }
  if (onesent[4]?.maxTokens !== 200) { bad++; console.error("FAIL prose:onesentence lost its token budget"); }
  console.log(bad ? `grader self-test: ${bad} FAILED` : `grader self-test: ${CASES.length + 2} passed`);
  process.exit(bad ? 1 : 0);
}

// Imported here, not at the top: --self-test returns above this line and must
// run on a fresh clone with no dist/.
const { callOllamaGenerate } = await import("../../dist/tools/prismInferHandler.js");

const out = {};
for (const model of MODELS) {
  for (const cond of ["no_history", "messages"]) {
    const rows = [];
    for (const [id, hist, prompt, grader, opts = {}] of T) {
      const t0 = Date.now();
      const r = await callOllamaGenerate(URL, model, prompt, undefined, opts.maxTokens ?? 48, 0, 240_000, false, undefined, cond === "messages" ? hist : undefined);
      const ms = Date.now() - t0;
      const text = r.ok ? r.text : `ERROR ${r.reason}`;
      // full keeps what the preview drops; the preview alone cannot support a
      // correctness judgement and the header comment promises the full text.
      rows.push({ id, verdict: r.ok ? grader(text) : "error", ms, promptTokens: r.promptTokens ?? null, full: text, text: text.slice(0, 120).replace(/\n/g, " ") });
    }
    out[`${model}|${cond}`] = rows;
  }
}
// summary
console.log("model                 condition    correct  declined  fabricated  avg_ms  avg_prompt_tok");
for (const [key, rows] of Object.entries(out)) {
  const c = v => rows.filter(r => r.verdict === v).length;
  const avg = f => Math.round(rows.reduce((n, r) => n + (f(r) ?? 0), 0) / rows.length);
  const [model, cond] = key.split("|");
  console.log(`${model.padEnd(21)} ${cond.padEnd(12)} ${String(c("correct")).padStart(7)}  ${String(c("declined")).padStart(8)}  ${String(c("fabricated")).padStart(10)}  ${String(avg(r => r.ms)).padStart(6)}  ${String(avg(r => r.promptTokens)).padStart(14)}`);
}
// Per-domain, because a regression in one domain is invisible in a total.
const domainOf = id => { const p = id.split(":")[0];
  return p === "code" ? "code" : p === "clinical" ? "clinical" : p === "prose" ? "prose" : "mechanics"; };
// A control is expected to pass WITHOUT history too — it guards against
// history making the model worse. Counting one in the carry-over denominator
// advertises a measurement of history that the task never makes.
const isControl = i => (T[i][4]?.kind) === "control";
console.log("\nby domain (correct / total), carry-over tasks only:");
console.log("model                 condition    mechanics  code  prose  clinical");
for (const [key, rows] of Object.entries(out)) {
  const [model, cond] = key.split("|");
  const cell = d => {
    const inD = rows.filter((r, i) => !isControl(i) && domainOf(T[i][0]) === d);
    return `${inD.filter(r => r.verdict === "correct").length}/${inD.length}`;
  };
  console.log(`${model.padEnd(21)} ${cond.padEnd(12)} ${cell("mechanics").padStart(9)}  ${cell("code").padStart(4)}  ${cell("prose").padStart(5)}  ${cell("clinical").padStart(8)}`);
}
const controls = T.map((t, i) => [t[0], i]).filter(([, i]) => isControl(i));
if (controls.length) {
  console.log("\ncontrols (must hold in BOTH arms; a fail here is a regression, not a miss):");
  for (const [model] of MODELS.map(m => [m])) {
    for (const [id, i] of controls) {
      const a = out[`${model}|no_history`][i], b = out[`${model}|messages`][i];
      console.log(`  ${model.padEnd(16)} ${id.padEnd(18)} ${a.verdict} / ${b.verdict}`);
    }
  }
}
console.log("\nprose and clinical cells score KEYWORD CARRY-OVER, not correctness:");
console.log("an answer can contain the remembered word and still be wrong. Read the");
console.log("full text before quoting either as accuracy.");

console.log("\nper-task (no_history -> messages):");
for (const model of MODELS) {
  const a = out[`${model}|no_history`], b = out[`${model}|messages`];
  for (let i = 0; i < T.length; i++) console.log(`  ${model.padEnd(16)} ${T[i][0].padEnd(18)} ${a[i].verdict.padEnd(10)} -> ${b[i].verdict.padEnd(10)} | ${JSON.stringify(a[i].text)} -> ${JSON.stringify(b[i].text)}`);
}

// The verdicts above are lexical. This file is the evidence a human needs to
// overturn one, so it carries the untruncated answers.
const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z").replace(/[:]/g, "");
const full = `scripts/bench/multi-turn-bench.full-${stamp}.json`;
writeFileSync(full, JSON.stringify(out, null, 1));
console.log(`\nfull untruncated answers: ${full}`);
