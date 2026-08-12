/**
 * Prompt triggers declared by a skill, in its own frontmatter.
 *
 * WHY THIS EXISTS
 * Prompt-keyword routing matches against the PUBLIC, unauthenticated routing
 * table (`/_internal/skills-routing.json`). A private account or team skill can
 * never be listed there — the name and its trigger words would be world
 * readable — so scoped skills were delivered to disk and then never surfaced by
 * any prompt. They were installed and inert.
 *
 * The fix keeps the trigger exactly as private as the body that declares it:
 *
 *     ---
 *     name: my-skill
 *     description: …
 *     prompt_triggers:
 *       - "\\binvoice\\b.{0,20}\\bsubmit\\b"
 *       - "quarterly close"
 *     ---
 *
 * The body already reaches this machine through the AUTHENTICATED manifest and
 * is cached as `skill:<name>`, so the triggers ride along with it. Nothing new
 * is transmitted, no schema changes, and matching stays on-device — the user's
 * prompt still never leaves the machine.
 *
 * SAFETY: these patterns come from user-authored content and are compiled on the
 * startup path, where a pathological regex would hang every session for everyone
 * the skill is shared with. Limits below are deliberately strict, and anything
 * rejected is reported rather than silently dropped — a trigger that never fires
 * is indistinguishable from the bug this file fixes.
 */

/** Per skill. A skill needing more than this is describing too much. */
export const MAX_TRIGGERS_PER_SKILL = 5;
/** Per pattern. Long patterns are where catastrophic backtracking hides. */
export const MAX_TRIGGER_LENGTH = 200;

export interface TriggerExtraction {
  /** pattern -> skill names, shaped exactly like the public table. */
  triggers: Record<string, string[]>;
  /** Rejected triggers, surfaced so authors learn why nothing fires. */
  errors: Array<{ skill: string; pattern: string; reason: string }>;
}

/**
 * Reject patterns that can backtrack catastrophically.
 *
 * RULE: a group may not be quantified. Exponential backtracking needs the
 * engine to try many different ways to split the SAME substring, and in
 * practice that requires a repeated group — `(a+)+`, `(a|aa)+`, `(\w+\s?)*`,
 * `(.*a){20}`. Refusing `)` followed by `+`, `*` or `{n,m}` kills the whole
 * family with one check that is trivial to read and cannot be argued with.
 *
 * This replaced a shape-matching heuristic that only caught the textbook
 * `(a+)+`. Measured against it, `((a+))+` slipped through nested parens and
 * `(a|aa)+` — the canonical example — slipped through because it contains no
 * inner quantifier at all; the latter took 447ms on 36 characters and grows
 * exponentially, so a trigger inside the 200-char cap could hang startup for
 * every member of a team it is shared with. JavaScript has no regex timeout:
 * once a match begins there is no way to interrupt it, which is why this must
 * be refused BEFORE compilation rather than bounded at runtime.
 *
 * Cost: a legitimate quantified group must be rewritten. Every trigger shape
 * seen in practice — word boundaries, proximity via `.{0,n}`, alternation
 * without repetition — is unaffected.
 */
function isCatastrophic(pattern: string): boolean {
  return /\)\s*(?:[+*]|\{\d+(?:,\d*)?\})/.test(pattern);
}

function validateTrigger(pattern: string): string | null {
  if (!pattern.trim()) return "empty pattern";
  if (pattern.length > MAX_TRIGGER_LENGTH) return `pattern exceeds ${MAX_TRIGGER_LENGTH} chars`;
  if (isCatastrophic(pattern)) return "a quantified group can backtrack catastrophically — rewrite without repeating a group";
  try {
    new RegExp(pattern, "i");
  } catch (error) {
    return `invalid regex: ${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
}

/**
 * Strip surrounding quotes, applying YAML's double-quote escaping.
 *
 * This matters more than it looks. In a double-quoted YAML scalar `\\b` means
 * a single backslash followed by b — i.e. the regex `\b` — so an author writing
 * the natural `- "\\binvoice\\b"` must get a word-boundary matcher. Passing
 * the raw text through instead yields `\\binvoice\\b`, which matches a literal
 * backslash and therefore NEVER fires: a skill that looks correctly configured
 * and is silently inert, which is the exact defect this file exists to end.
 * Single-quoted and bare scalars are taken literally, as YAML specifies.
 */
function unquote(value: string): string {
  const doubleQuoted = value.match(/^"(.*)"$/);
  if (doubleQuoted) return doubleQuoted[1].replace(/\\\\/g, "\\");
  const singleQuoted = value.match(/^'(.*)'$/);
  if (singleQuoted) return singleQuoted[1];
  return value;
}

/**
 * Pull `prompt_triggers` out of one skill body.
 *
 * Supports both YAML shapes authors actually write — a block list and an inline
 * array — without adding a YAML dependency, matching the hand-rolled frontmatter
 * reader already used by skill_save so the two agree on what a skill file is.
 */
export function extractSkillTriggers(skillName: string, content: string): TriggerExtraction {
  const result: TriggerExtraction = { triggers: {}, errors: [] };
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) return result;

  const body = frontmatter[1];
  const raw: string[] = [];

  const inline = body.match(/^prompt_triggers:\s*\[(.*)\]\s*$/m);
  if (inline) {
    for (const item of inline[1].split(",")) {
      const value = unquote(item.trim());
      if (value) raw.push(value);
    }
  } else {
    const blockStart = body.match(/^prompt_triggers:\s*$/m);
    if (blockStart) {
      const after = body.slice(body.indexOf(blockStart[0]) + blockStart[0].length);
      for (const line of after.split("\n")) {
        // Stop at the next top-level key: an unterminated list must not swallow
        // the rest of the frontmatter and turn `description:` into a trigger.
        if (/^[A-Za-z_-]+:/.test(line)) break;
        const item = line.match(/^\s*-\s*(.+?)\s*$/);
        if (!item) continue;
        raw.push(unquote(item[1]));
      }
    }
  }

  if (raw.length === 0) return result;

  for (const pattern of raw.slice(0, MAX_TRIGGERS_PER_SKILL)) {
    const problem = validateTrigger(pattern);
    if (problem) {
      result.errors.push({ skill: skillName, pattern: pattern.slice(0, 80), reason: problem });
      continue;
    }
    (result.triggers[pattern] ||= []).push(skillName);
  }
  for (const pattern of raw.slice(MAX_TRIGGERS_PER_SKILL)) {
    result.errors.push({
      skill: skillName,
      pattern: pattern.slice(0, 80),
      reason: `exceeds ${MAX_TRIGGERS_PER_SKILL} triggers per skill`,
    });
  }
  return result;
}

/**
 * Merge the triggers declared by every cached skill body.
 *
 * `skills` is the `skill:<name> -> content` cache that already backs body
 * injection, so this covers exactly the entitled set: anything routable here is
 * something the caller is allowed to inline, and nothing else.
 */
export function collectScopedTriggers(skills: Iterable<[string, string]>): TriggerExtraction {
  const merged: TriggerExtraction = { triggers: {}, errors: [] };
  for (const [name, content] of skills) {
    if (!content || !content.includes("prompt_triggers")) continue;   // cheap pre-filter
    const extracted = extractSkillTriggers(name, content);
    for (const [pattern, names] of Object.entries(extracted.triggers)) {
      (merged.triggers[pattern] ||= []).push(...names);
    }
    merged.errors.push(...extracted.errors);
  }
  return merged;
}
