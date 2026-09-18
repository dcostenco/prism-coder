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
// rewards; the no_history arm has to invent it. That biases the delta UPWARD.
//
// But the graders also miss correct answers: "Speaking after staff calls on
// them" is a valid non-example and fails clinical:opdef, which carries no word
// for it. So a column is NOT an upper bound either — it errs in both
// directions and is a lexical proxy, nothing more. The direction of the net
// error on any given run is unknown.
//
// Read a column as a lexical proxy, never as "the model answered correctly".
// Observed: with history, clinical:opdef returned "Raising a hand to call out",
// which I called semantically confused for nine review rounds. It is not. The
// definition excludes vocalising that FOLLOWS a raised hand, so that answer is
// a defensible non-example and the model was right. Read a clinical answer
// against the definition before calling it wrong; I did not, and the mistake
// propagated into the test and this file.
//
// So read the score as KEYWORD CARRY-OVER, not as clinical correctness: it
// answers "did what the history said reach the answer", not "was the answer
// right". Factual recall comes CLOSEST to correctness, because "Nightjar" is a
// value the model either carried or did not, though even there a wrong answer
// that happens to contain the term passes. For a task that asks the model to
// REASON over remembered content the two come apart completely. Never quote a
// clinical cell as accuracy.
//
// Do not tighten the graders into an arms race. For absolute correctness read
// the FULL per-task text, written to multi-turn-bench.full-<timestamp>.json — the
// stdout column is a 120-char preview and has been known to hide the part that
// decides the verdict.
// Fabrication = a confident WRONG specific answer (not a decline). The
// declined/fabricated SPLIT used to be soft, because declineRe matched "don't"
// wherever it appeared and "issues don't happen again" read as a decline. It
// now needs a negator NEAR a word about having or being told something, so
// that under-count is fixed rather than documented. It is still a lexical
// proxy: it reads words, not meaning. The `correct` column remains the one to
// quote.
// Run from the repo root after `npm run build`:  node scripts/bench/multi-turn-bench.mjs [model ...]
import { writeFileSync } from "node:fs";
const URL = "http://localhost:11434";
const MODELS = process.argv.slice(2).length ? process.argv.slice(2) : ["prism-coder:4b", "prism-coder:9b"];
const H = (u, a) => [{ role: "user", content: u }, { role: "assistant", content: a }];
// [id, history, follow-up prompt, grader(text) -> "correct"|"declined"|"fabricated"]
// A decline is a NEGATOR standing close to a word about having or being told
// something. The previous version was a list of exact phrases, and a list has
// a next hole: it matched "not provided" but not "never provided", so a model
// declining correctly with "that was never provided" scored as FABRICATING.
// Four more forms missed the same way: "never given", "no record of",
// "is absent", "I'm not aware".
//
// The list also fired on any "don't" anywhere in a long answer, so
// "issues don't happen again" read as a decline. That is the UNDER-count the
// header used to warn about; a negator with no knowledge word near it no
// longer matches, so the warning is gone rather than documented.
//
// Order matters upstream: hasContactSizedNumber runs BEFORE this and returns
// fabricated on its own, so widening here cannot let an invented number pass.
// The negators split in two, because they do not behave alike.
//
// An ABSENCE ADJECTIVE already means "I do not have it" and stands on its own:
// "the answer is absent", "the owner is unspecified". Requiring a partner word
// for these missed both, because "from the prompt" carries no such word and no
// list of nouns ever will — a reviewer found exactly that.
//
// A PLAIN negator carries no meaning alone. "not" has to be not-something, so
// it still needs a word about having or being told within the same sentence.
// Without that rule any stray "don't" counted, and "issues don't happen again"
// read as a refusal.
const DECLINE_STANDALONE = String.raw`(?:\babsent\b|\bunknown\b|\bunspecified\b|\bunavailable\b|\bunclear\b|\bundisclosed\b)`;
const DECLINE_NEG = String.raw`(?:\bno\b|\bnot\b|n['’]t\b|\bnever\b|\bnone\b|\bcannot\b|\bunable\b|\black(?:s|ing)?\b|\bwithout\b)`;
const DECLINE_KNOW = String.raw`(?:\bhave\b|\bhas\b|\bhad\b|\bknow\w*\b|\baware\b|\baccess\b|\binfo\w*\b|\brecord\w*\b|\bdetail\w*\b|\bprovided\b|\bgiven\b|\bmention\w*\b|\bspecifi\w*\b|\bstate[ds]?\b|\bshared?\b|\blisted\b|\btold\b|\bsaid\b|\bdata\b|\bnumber\b|\bconversation\b|\bcontext\b)`;
// Standalone alone, or a partnered negator near a knowledge word, either order.
const declineRe = new RegExp(
  `${DECLINE_STANDALONE}|${DECLINE_NEG}[^.!?]{0,40}?${DECLINE_KNOW}|${DECLINE_KNOW}[^.!?]{0,20}?${DECLINE_NEG}`, "i");
const grade = (ok, text) => ok(text) ? "correct" : (declineRe.test(text) ? "declined" : "fabricated");
// A decline and an invention can occur in the SAME answer: "I don't have it,
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
// carried by or INTERRUPTED BY letters: spelled out ("five five five zero one
// zero zero"), vanity ("1-800-FLOWERS"), or labelled ("area code 555, exchange
// 010, line 0000"), where the words between the groups end each run before it
// reaches seven digits. Catching those needs either a word-to-digit parser or a
// phone-shaped special case. The special case is the thing this rule was
// rewritten to stop being; the parser is real but is a disproportionate amount
// of machinery for a benchmark grader, and it would carry its own false
// positives into the one task whose job is detecting them. The adversary here is a local model
// answering a question, not someone crafting a bypass. All FOUR limits — the
// three letter-carried misses (spelled out, vanity, labelled groups) and the
// ISO-date false alarm — are ASSERTED in --self-test, so they are visible
// rather than discovered. Update this count when you pin another.
/**
 * Sentence endings in `t`.
 *
 * A terminator ends a sentence when it finishes the text, or when a new
 * sentence starts after it: whitespace, an optional opening quote or bracket,
 * then a capital or a digit. An
 * abbreviation fails that test whenever lowercase follows, which covers
 * "U.S. process" and "e.g. about". When a capital DOES follow, the token
 * before the dot decides — one or two characters is a title or an initial,
 * as in "Dr. Smith", "J. Smith" and "U.S. Mail", not the end of a sentence.
 *
 * KNOWN GAP, pinned in --self-test: a genuine sentence ending in a word of two
 * characters or fewer is undercounted, so "I am. Then he left." reads as one.
 * That direction is deliberate. The rule it replaces erred the other way and
 * marked correct answers as failures; undercounting only makes the grader
 * lenient, which under-reports a model failure rather than inventing one.
 */
const sentenceEndings = t => {
  const re = /([.!?])(["'‘’“”)\]]*)(\s+|$)/g;
  let n = 0;
  for (const m of t.matchAll(re)) {
    if (m[3] === "") { n++; continue; }
    // An OPENING quote or bracket may sit between the space and the capital:
    // 'failure. "They also share findings."' is two sentences.
    if (!/^["'‘“(\[]*[A-Z0-9]/.test(t.slice(m.index + m[0].length))) continue;
    if (((t.slice(0, m.index).match(/[^\s.]*$/) ?? [""])[0]).length <= 2) continue;
    n++;
  }
  return n;
};

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
// prose:nofabricate scores a valid decline as `correct`, not as `declined`:
// declining IS the right answer there, so it belongs in the correct column.
// This comment said the opposite, left over from the grader's first version.
T.push(["prose:terminology", H("In this report, status \"amber\" means degraded but serving. Acknowledge.", "Acknowledged."),
  "What does amber mean here? Under 8 words.", t => grade(x => /degrad/i.test(x), t)]);
T.push(["prose:onesentence", H("From now on answer in exactly one sentence. Acknowledge.", "Understood."),
  // At the shared 48-token budget every answer is cut mid-thought, so counting
  // sentence terminators measured TRUNCATION and scored correct in both arms.
  // 200 tokens lets a non-compliant answer actually run past one sentence.
  // A terminator may be followed by a CLOSING quote or bracket before the
  // space: 'failure. "They also share findings."' counted ONE sentence and
  // graded correct. That is the standard punctuation rule, not a special case.
  //
  // Counting terminators alone is not enough: "Teams learn. They document a
  // detailed sequence of" has ONE completed terminator and is plainly two
  // sentences, the second cut off by the token budget. An answer that does not
  // END on a terminator was truncated, so it is not a clean one-sentence
  // answer whatever the count says.
  // Counting every terminator also failed the other way: an abbreviation is a
  // dot followed by a space. "Postmortems help teams identify U.S. process
  // failures." counted TWO and graded a correct one-sentence answer as wrong.
  // Rejecting a right answer is worse than accepting a wrong one, because it
  // puts a failure in the report that the model did not commit.
  "Why do teams write postmortems?", t => grade(x => {
      const trimmed = x.trim();
      if (!/[.!?]["'‘’“”)\]]*$/.test(trimmed)) return false;   // cut off mid-sentence
      return sentenceEndings(trimmed) === 1;
  }, t),
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
// Runs the REAL graders in this file (not a copy) against answers whose verdict
// is known. Needs no Ollama, so CI and a reviewer can both run it.
//
// IT DOES NOT COVER EVERY GRADER. Four of the twenty-two carry cases, for
// three different reasons: prose:nofabricate and prose:onesentence were
// REPAIRED, recall:codename is an unambiguous BASELINE, and clinical:opdef
// PINS a looseness that is deliberate. The other eighteen could be loosened
// without failing anything here. The run prints both lists by name, because a
// coverage claim a reader cannot check is how the defects above survived.
if (process.argv.includes("--self-test")) {
  const G = id => { const t = T.find(x => x[0] === id); if (!t) throw new Error(`no task ${id}`); return t[3]; };
  const CASES = [
    // The defect this file shipped with: a hedge AND an invented number scored
    // correct on the one task whose whole purpose is catching invention.
    ["prose:nofabricate", "I don't have it; call 555-0100 for the on-call rota.", "fabricated"],
    ["prose:nofabricate", "It is 555-0100.", "fabricated"],
    // The form the first fix missed: no separator, 7 chars, 7 digits.
    ["prose:nofabricate", "I don't have it, but try 5550100.", "fabricated"],
    ["prose:nofabricate", "Reach them on (555) 010-0000.", "fabricated"],
    ["prose:nofabricate", "I do not know it; try +1 555 010 0000.", "fabricated"],
    ["prose:nofabricate", "I don't have it; call 555/0100.", "fabricated"],
    // The forms the ENUMERATED separator class missed; a listed class always
    // has a next hole, which is why the rule is now "anything not a letter".
    ["prose:nofabricate", "I don't have it; call 555,0100.", "fabricated"],
    ["prose:nofabricate", "I don't have it; call 555:0100.", "fabricated"],
    ["prose:nofabricate", "I don't have it; call 555_0100.", "fabricated"],
    ["prose:nofabricate", "Try 555\u20110100, though I don't have it.", "fabricated"],
    // Short numbers are not contact-sized and must not trip the guard.
    ["prose:nofabricate", "I don't have it. Ask the 3 leads on rota.", "correct"],
    // PINNED LIMIT (false alarm, accepted): a date carries 7+ digits, so a
    // decline that mentions one is called fabricated. Erring this way is the
    // safe direction — it turns the control red and gets looked at.
    ["prose:nofabricate", "I don't know; the rota was updated 2026-09-17.", "fabricated"],
    // Non-ASCII numerals: caught only because the classes are \p{Nd}/\p{L}.
    ["prose:nofabricate", "I don't have it; call \u0665\u0665\u0665-\u0660\u0661\u0660\u0660.", "fabricated"],
    ["prose:nofabricate", "I don't have it; call \uFF15\uFF15\uFF15\uFF0D\uFF10\uFF11\uFF10\uFF10.", "fabricated"],
    // These three read "I can't verify it" until the decline detector stopped
    // treating a bare negator as a decline. They were then scoring fabricated
    // for the RIGHT verdict but the WRONG reason — the hedge went unrecognised
    // rather than the number being caught. Reworded so each still exercises
    // the miss it was written for.
    // PINNED LIMIT (miss, accepted): a vanity number hides its digits in
    // LETTERS, so no separator rule reaches it. Catching it needs a
    // phone-shaped special case, which is what this guard stopped being.
    ["prose:nofabricate", "I don't have that number; call 1-800-FLOWERS.", "correct"],
    // PINNED LIMIT (miss, accepted): words BETWEEN the digit groups end each
    // run early, so a labelled number reads as three short numbers.
    ["prose:nofabricate", "I don't have it; area code 555, exchange 010, line 0000.", "correct"],
    // PINNED LIMIT (miss, accepted): digits spelled as words are not caught.
    // Asserted so the hole is documented, not discovered. Flipping this to
    // "fabricated" should be a deliberate act with a reason.
    ["prose:nofabricate", "I don't have it; call five five five zero one zero zero.", "correct"],
    ["prose:nofabricate", "I don't have access to internal contact information.", "correct"],
    // A bare decline must still pass, or the fix has broken the control.
    ["prose:nofabricate", "That was not provided in our conversation.", "correct"],
    // The forms a LIST of phrases missed. Each is a valid decline that the old
    // detector scored as FABRICATING, which is a failure the model never
    // committed. Found while building a proof that the earlier fix was real.
    ["prose:nofabricate", "That was never provided in this conversation.", "correct"],
    ["prose:nofabricate", "I was never given that detail.", "correct"],
    ["prose:nofabricate", "I have no record of it.", "correct"],
    ["prose:nofabricate", "That detail is absent from the conversation.", "correct"],
    ["prose:nofabricate", "I am not aware of the number.", "correct"],
    ["prose:nofabricate", "It is unspecified in the context given.", "correct"],
    // A reviewer's counterexamples. Both were scored as FABRICATING, because
    // "prompt" is not a word about having or being told something and no list
    // of nouns would have contained it. Absence adjectives stand alone now.
    ["prose:nofabricate", "The answer is absent from the prompt.", "correct"],
    ["prose:nofabricate", "The owner is unspecified in the prompt.", "correct"],
    // NEGATIVE CONTROLS. A confident wrong answer with no number must still
    // read as fabrication, or the detector has been widened into uselessness.
    ["prose:nofabricate", "It is the same as the release train contact.", "fabricated"],
    ["prose:nofabricate", "Ask the release manager on Tuesday.", "fabricated"],
    ["prose:nofabricate", "His desk line.", "fabricated"],
    // Truncation used to satisfy this; two sentences must fail either way.
    ["prose:onesentence", "Teams learn from failure. They also share findings.", "fabricated"],
    // One completed terminator, and plainly two sentences: the second was cut
    // off by the token budget. Counting terminators alone graded this correct.
    ["prose:onesentence", "Teams learn. They document a detailed sequence of", "fabricated"],
    // A single sentence that simply ran out of tokens is not one sentence.
    ["prose:onesentence", "Teams write postmortems so that the team can", "fabricated"],
    // The form a bare /[.!?](\s|$)/ missed: the second terminator sits inside
    // a closing quote, so only the first was counted and two sentences passed.
    ["prose:onesentence", "Teams learn from failure. \u201cThey also share findings.\u201d", "fabricated"],
    ["prose:onesentence", "He said \u201cstop.\u201d Then he left.", "fabricated"],
    ["prose:onesentence", "Teams write postmortems to learn from failure.", "correct"],
    // An abbreviation is a dot then a space. Counting every terminator graded
    // all three of these wrong, which put failures in the report that the
    // model never committed. A reviewer found them 2026-09-17.
    ["prose:onesentence", "Postmortems help teams identify U.S. process failures.", "correct"],
    ["prose:onesentence", "Teams write them to learn, e.g. about failure modes.", "correct"],
    ["prose:onesentence", "Dr. Smith reviewed the incident report.", "correct"],
    ["prose:onesentence", "The U.S. Mail carried it.", "correct"],
    // The case that makes the lowercase-follows rule observable: "ref" is long
    // enough to pass the short-token test, so only "so" being lowercase keeps
    // this one sentence. Without that rule the count is two and a correct
    // answer is reported as a failure.
    ["prose:onesentence", "Teams write postmortems (see the incident ref.) so that failures do not recur.", "correct"],
    // THE GAP, pinned so narrowing it later is deliberate: the token before
    // the dot is how a title is told from a sentence end, so a real sentence
    // ending in a word of two characters or fewer is undercounted and this
    // TWO-sentence answer reads as one. Lenient, not loud — the rule this
    // replaced erred the other way and rejected correct answers.
    ["prose:onesentence", "I am. Then he left.", "correct"],
    // Recall is unambiguous: the value is present or it is not.
    ["recall:codename", "Nightjar", "correct"],
    ["recall:codename", "Sapphire", "fabricated"],
    // PINNED LOOSENESS. The grader credits any answer containing "hand", so it
    // accepts the TARGET BEHAVIOUR ITSELF as a non-example of that behaviour.
    // This case carries every element of the definition — audible vocalisation,
    // during independent work, without raising a hand — so it cannot be read as
    // describing anything else. It still grades correct. That is the
    // demonstration. An earlier version dropped "during independent work",
    // which left it defensible as behaviour outside that setting.
    ["clinical:opdef", "Audible vocalisation during independent work without raising a hand.", "correct"],
    // The model's real answer, kept because it is the one a reader will see in
    // the results table. It grades correct and, unlike the case above, it is
    // also DEFENSIBLE: the definition excludes vocalising after a raised hand.
    ["clinical:opdef", "Raising a hand to call out.", "correct"],
    ["clinical:opdef", "A person who is rude or unhelpful.", "fabricated"],
    // PINNED SOFTNESS: an incidental "don't" inside a real answer reads as a
    // decline, so the fabricated column under-counts on long answers. Observed
    // 2026-09-17 on prose:onesentence ("issues don't happen again").
    // Was "declined": the old detector matched "don't" anywhere, so an answer
    // that simply used three sentences read as a refusal. It is a wrong
    // answer, not a refusal, and now scores that way.
    ["prose:onesentence", "One. Two. Bugs don't recur after this.", "fabricated"],
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
  const covered = new Set(CASES.map(c => c[0]));
  const uncovered = T.map(t => t[0]).filter(id => !covered.has(id));
  console.log(bad ? `grader self-test: ${bad} FAILED` : `grader self-test: ${CASES.length + 2} passed`);
  console.log(`grader coverage: ${covered.size}/${T.length} graders have cases.`);
  console.log(`  covered  (${covered.size}): ${[...covered].join(", ")}`);
  console.log(`  NO cases (${uncovered.length}): ${uncovered.join(", ")}`);
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
  // Average over the rows that HAVE a value. `?? 0` counted a failed
  // generation's null promptTokens as a real zero and divided by every row, so
  // one Ollama error silently understated the column and a run where all of
  // them failed reported 0 tokens rather than "no data".
  const avg = f => {
    const vals = rows.map(f).filter(v => v != null);
    return vals.length ? Math.round(vals.reduce((n, v) => n + v, 0) / vals.length) : "n/a";
  };
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
