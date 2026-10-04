/**
 * Shared detector for the context-recovery contract.
 *
 * A save refused with `context_not_loaded` names one remedy: call
 * session_load_context for that project with the same conversation_id, then
 * retry the save once. Every text an agent reads must agree with that, and none
 * may forbid or ration the call. The detector is heuristic and is used ONLY to
 * raise (a false positive is fixed by rewording the sentence); it is itself
 * under test in tests/startup-recovery-contract.test.ts.
 */

/** Collapse line wraps so a rule split across lines is matched as one sentence. */
export function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Split text into sentences. Blank lines end a paragraph first (so a markdown
 * heading never merges into the next paragraph); within a paragraph a clause
 * break on `;` also ends a sentence.
 */
export function sentencesOf(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .flatMap((paragraph) => flatten(paragraph).split(/(?<=[.;!?])\s+(?=[A-Z`"])/))
    .filter((sentence) => sentence.length > 0);
}

// Up to three words may sit between the negation and the verb ("never again
// call", "do not ever use") and up to two between the verb and the tool ("call
// the session_load_context tool"), so a reworded ban cannot slip past.
const BAN =
  /\b(?:do not|don't|never|must not)\b(?:\s+[\w'-]+){0,3}?\s+(?:call|use|run|invoke|issue)\s+(?:[\w'-]+\s+){0,2}?`?(?:mcp__prism-mcp__)?session_load_context`?(?!`?\s+in place of)/i;
const RATIONED =
  /\bonly\b[^.;]{0,60}(?:explicit project reload|older[- ]server|older Prism server)|session_load_context[^.;]{0,80}\bonly\b/i;
const NAMES_RECOVERY = /context_not_loaded|\brecover/i;

/**
 * Sentences that forbid session_load_context outright, or allow it "only" for
 * reloads and fallbacks, without naming the recovery a refusal asks for.
 * "Do not substitute session_load_context for the startup call" is allowed:
 * that is the rule the ban was written for.
 */
export function findRecoveryBlockers(text: string): string[] {
  return sentencesOf(text).filter((sentence) => {
    if (!/session_load_context/.test(sentence)) return false;
    if (NAMES_RECOVERY.test(sentence)) return false;
    return BAN.test(sentence) || RATIONED.test(sentence);
  });
}
