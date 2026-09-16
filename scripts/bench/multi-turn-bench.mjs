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
console.log("\nper-task (no_history -> messages):");
for (const model of MODELS) {
  const a = out[`${model}|no_history`], b = out[`${model}|messages`];
  for (let i = 0; i < T.length; i++) console.log(`  ${model.padEnd(16)} ${T[i][0].padEnd(18)} ${a[i].verdict.padEnd(10)} -> ${b[i].verdict.padEnd(10)} | ${JSON.stringify(a[i].text)} -> ${JSON.stringify(b[i].text)}`);
}
