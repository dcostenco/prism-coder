// Multi-turn benchmark: does carrying the conversation change what the local
// model answers on a follow-up? Conditions:
//   no_history : prompt only — what prism_infer sent before this change
//   messages   : role-structured prior turns — what it sends now
// Tasks are auto-graded (string/regex), temperature 0, num_predict small.
// Fabrication = a confident WRONG specific answer (not a decline).
// Run from the repo root after `npm run build`:  node scripts/bench/multi-turn-bench.mjs [model ...]
import { callOllamaGenerate } from "../../dist/tools/prismInferHandler.js";
const URL = "http://localhost:11434";
const MODELS = process.argv.slice(2).length ? process.argv.slice(2) : ["prism-coder:4b", "prism-coder:9b"];
const H = (u, a) => [{ role: "user", content: u }, { role: "assistant", content: a }];
// [id, history, follow-up prompt, grader(text) -> "correct"|"declined"|"fabricated"]
const declineRe = /(don't|do not|cannot|can't|no (prior|previous|earlier)|not (been )?(provided|specified|mentioned|given)|unknown|need more|no information|not have access)/i;
const grade = (ok, text) => ok(text) ? "correct" : (declineRe.test(text) ? "declined" : "fabricated");
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
  "Why do teams write postmortems?", t => grade(x => (x.trim().match(/[.!?](\s|$)/g) ?? []).length === 1, t)]);
T.push(["prose:figure", H("The team closed 18 tickets last sprint. Acknowledge.", "Noted."),
  "At the same rate, how many across two sprints? Number only.", t => grade(x => /\b36\b/.test(x), t)]);
// Carrying history must not make the model MORE willing to invent. Here the
// answer is genuinely absent from the conversation, so declining IS correct.
T.push(["prose:nofabricate", H("The release train runs on Tuesdays. Acknowledge.", "Noted."),
  "What is the on-call engineer's phone number?",
  t => declineRe.test(t) ? "correct" : "fabricated"]);

// G. clinical, ROUTINE band only (3). No crisis, restraint or injury
// vocabulary: those never reach a local model, so benching them would measure
// a refusal rather than recall.
T.push(["clinical:opdef", H("Target behaviour: calling out, defined as an audible vocalisation during independent work without first raising a hand. Acknowledge.", "Noted."),
  "Give one NON-example of that behaviour. Under 10 words.", t => grade(x => /hand|wait|quiet|silent/i.test(x), t)]);
T.push(["clinical:measure", H("We record this behaviour as a frequency count each session. Acknowledge.", "Noted."),
  "What gets written down each session? Under 8 words.", t => grade(x => /count|frequen|number|tally|how many|times/i.test(x), t)]);
T.push(["clinical:replacement", H("The replacement behaviour is raising a hand and waiting to be called on. Acknowledge.", "Noted."),
  "What should staff reinforce? Under 8 words.", t => grade(x => /hand|wait/i.test(x), t)]);


const out = {};
for (const model of MODELS) {
  for (const cond of ["no_history", "messages"]) {
    const rows = [];
    for (const [id, hist, prompt, grader] of T) {
      const t0 = Date.now();
      const r = await callOllamaGenerate(URL, model, prompt, undefined, 48, 0, 240_000, false, undefined, cond === "messages" ? hist : undefined);
      const ms = Date.now() - t0;
      const text = r.ok ? r.text : `ERROR ${r.reason}`;
      rows.push({ id, verdict: r.ok ? grader(text) : "error", ms, promptTokens: r.promptTokens ?? null, text: text.slice(0, 60).replace(/\n/g, " ") });
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
console.log("\nby domain (correct / total):");
console.log("model                 condition    mechanics  code  prose  clinical");
for (const [key, rows] of Object.entries(out)) {
  const [model, cond] = key.split("|");
  const cell = d => {
    const inD = rows.filter((r, i) => domainOf(T[i][0]) === d);
    return `${inD.filter(r => r.verdict === "correct").length}/${inD.length}`;
  };
  console.log(`${model.padEnd(21)} ${cond.padEnd(12)} ${cell("mechanics").padStart(9)}  ${cell("code").padStart(4)}  ${cell("prose").padStart(5)}  ${cell("clinical").padStart(8)}`);
}

console.log("\nper-task (no_history -> messages):");
for (const model of MODELS) {
  const a = out[`${model}|no_history`], b = out[`${model}|messages`];
  for (let i = 0; i < T.length; i++) console.log(`  ${model.padEnd(16)} ${T[i][0].padEnd(18)} ${a[i].verdict.padEnd(10)} -> ${b[i].verdict.padEnd(10)} | ${JSON.stringify(a[i].text)} -> ${JSON.stringify(b[i].text)}`);
}
