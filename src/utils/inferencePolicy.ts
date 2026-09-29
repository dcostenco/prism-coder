/**
 * Policies on-device features run with, served by Synalux to plans with
 * multi-turn: the second read's exclusion policy (the conversations the 9b may
 * not re-read after a 4b hedge), the answer check's rules, and the screen's
 * classifier-input policy (layer1.ts classifierCopy). Each
 * release accepts exactly one artifact of each, pinned by its SHA-256, so the
 * policy a client runs is the one it was released and validated with.
 *
 * They are held in memory only, never in settings (session exports copy
 * settings), and dropped when the account changes (clearInferencePolicies,
 * called on dashboard sign-in and sign-out); a load the portal refuses is not
 * kept. Anything but the pinned, well-formed artifact is no policy: with
 * no second-read policy the second read does not run (the hedge stands); with
 * no answer-check policy a local answer to a conversation is unchecked (cloud,
 * else withheld); with no classifier-input policy the classifier reads the
 * request as written.
 */
import { createHash } from "node:crypto";
import { PRISM_SYNALUX_BASE_URL } from "../config.js";
import { getSynaluxJwt, invalidateSynaluxJwt } from "./synaluxJwt.js";
import type { ClassifierInputPolicy, SecondReadExclusionPolicy } from "./layer1.js";
import { arithmeticExpressions, type AnswerCheckPolicy } from "./answerGrounding.js";

/** The artifact this release runs. Changing it is a release, with its gates. */
export const SECOND_READ_POLICY_SHA256 = "1b04eb3153b14bb13bff40e142c76eda0d61d21eccfd86c9ff03dd004e107985";
/** The evaluator this client implements (layer1.ts secondReadExclusion). */
export const SECOND_READ_POLICY_EVALUATOR = "second-read-exclusion/1";
/** The answer-check artifact this release runs. */
export const ANSWER_CHECK_POLICY_SHA256 = "ba12ab1f6858b68ed36b7c0551aa3381ffb45b6123eb0aacd09c9316efd27993";
/** The mechanism this client implements (answerGrounding.ts, groundAnswer). */
export const ANSWER_CHECK_POLICY_EVALUATOR = "answer-check/1";
/** The classifier-input artifact this release runs. */
export const CLASSIFIER_INPUT_POLICY_SHA256 = "6b215f9af8cb94c9467852d6bd20f93c3a5c33dd35c649bee77e5f69e0abe4b1";
/** The mechanism this client implements (layer1.ts classifierCopy). */
export const CLASSIFIER_INPUT_POLICY_EVALUATOR = "classifier-input/1";

const MAX_ARTIFACT_BYTES = 64 * 1024;
const MAX_PATTERN_CHARS = 1_024;
const MIN_OPERATIONAL_TERMS = 8;
const MIN_DEPLOY_DECISION = 2;
const MIN_DROP_WORDS = 8;
const MAX_WORD_CHARS = 40;
const MAX_REQUIRED_GROUPS = 4;
/** A list longer than this is not a policy this client was released with. */
const MAX_LIST_ENTRIES = 1_000;
/** A group whose body repeats may be repeated at most this many times. */
const MAX_BOUNDED_GROUP_REPEAT = 3;
/** The whole load, JWT exchange included. */
const LOAD_DEADLINE_MS = 8_000;
/** After a failed load, conversations run without the second read this long before the next try. */
const RETRY_AFTER_MS = 30_000;

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * A syntactic guard against exponential backtracking. JavaScript cannot
 * interrupt a match once it starts (a 29-character input held the process for
 * ten seconds on `(a+)+$`), so a pattern from an artifact is refused BEFORE it
 * is compiled.
 *
 * Refused: a group repeated without bound (`+`, `*`, `{n,}`) or more than
 * MAX_BOUNDED_GROUP_REPEAT times whose body can match strings of different
 * lengths (it holds `*`, `+`, `?` or `{n,m}`) or offers alternatives:
 * `(a+)+`, `(?:a{1,4})+`, `(a|aa)+`, `(\w+\s?)*`, `(.*a){20}`. Allowed: a
 * repeated group of fixed-width pieces, `(?:,\d{3})+`; a short bounded repeat,
 * `(?:\S+\s+){0,3}`; alternation that is not repeated. Character classes
 * follow JavaScript's rules (`[]` and `[^]` close at once); an escaped
 * character is literal.
 *
 * It is a conservative check of these nested-repetition shapes, not a proof
 * that a pattern runs in linear time: polynomial cost from adjacent
 * quantifiers is not detected, nor is a shape it does not model. The control is
 * the pin: only an artifact this client was released with is ever compiled,
 * and its patterns are checked before release.
 */
export function hasNestedRepetition(src: string): boolean {
    type Frame = { varies: boolean; alternates: boolean };
    const stack: Frame[] = [{ varies: false, alternates: false }];
    /** The quantifier at `at`: whether it is unbounded, its maximum, whether the
     *  width it matches varies (min ≠ max), and where it ends. */
    const quantifier = (at: number): { unbounded: boolean; max: number; varies: boolean; end: number } | null => {
        const lazy = (end: number) => end + (src[end] === "?" ? 1 : 0);
        const ch = src[at];
        if (ch === "*" || ch === "+") return { unbounded: true, max: Infinity, varies: true, end: lazy(at + 1) };
        if (ch === "?") return { unbounded: false, max: 1, varies: true, end: lazy(at + 1) };
        if (ch !== "{") return null;
        const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(at));
        if (!m) return null;
        const min = Number(m[1]);
        const max = m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
        return { unbounded: max === Infinity, max, varies: max !== min, end: lazy(at + m[0].length) };
    };
    /** After an atom: a quantifier of varying width makes the enclosing group's width vary. */
    const afterAtom = (at: number): number => {
        const q = quantifier(at);
        if (!q) return at;
        if (q.varies) stack[stack.length - 1].varies = true;
        return q.end;
    };
    let i = 0;
    while (i < src.length) {
        const ch = src[i];
        if (ch === "\\") { i = afterAtom(i + 2); continue; }
        if (ch === "[") {
            // JavaScript: the first unescaped "]" closes the class, even right
            // after "[" or "[^" ("[]" matches nothing, "[^]" any character).
            let j = i + 1;
            if (src[j] === "^") j++;
            while (j < src.length && src[j] !== "]") j += src[j] === "\\" ? 2 : 1;
            i = afterAtom(j + 1);
            continue;
        }
        if (ch === "(") {
            stack.push({ varies: false, alternates: false });
            i++;
            if (src[i] === "?") {
                // (?: (?= (?! (?<= (?<! or a named group (?<name>
                if (src[i + 1] === "<" && src[i + 2] !== "=" && src[i + 2] !== "!") {
                    const close = src.indexOf(">", i);
                    if (close < 0) return true;
                    i = close + 1;
                } else {
                    i += src[i + 1] === "<" ? 3 : 2;
                }
            }
            continue;
        }
        if (ch === ")") {
            if (stack.length === 1) return true;   // unbalanced
            const body = stack.pop()!;
            const parent = stack[stack.length - 1];
            i++;
            const q = quantifier(i);
            if (q) {
                if ((body.varies || body.alternates) && (q.unbounded || q.max > MAX_BOUNDED_GROUP_REPEAT)) return true;
                if (q.varies) parent.varies = true;
                i = q.end;
            }
            if (body.varies) parent.varies = true;
            if (body.alternates) parent.alternates = true;
            continue;
        }
        if (ch === "|") { stack[stack.length - 1].alternates = true; i++; continue; }
        i = afterAtom(i + 1);
    }
    return stack.length !== 1;
}

/** Whether `^(?:src)$` matches `text` (a fragment that does not compile matches nothing). */
const wholeMatch = (src: string, text: string): boolean => {
    try { return new RegExp(`^(?:${src})$`).test(text); } catch { return false; }
};

/** The compiled policy from the artifact's exact bytes, or null for anything
 *  but the expected artifact: another hash, another schema or evaluator, a
 *  list below its floor, an oversized field, a pattern that does not compile. */
export function parseSecondReadPolicy(bytes: string, expectSha256: string = SECOND_READ_POLICY_SHA256): SecondReadExclusionPolicy | null {
    if (Buffer.byteLength(bytes, "utf8") > MAX_ARTIFACT_BYTES) return null;
    if (sha256(bytes) !== expectSha256) return null;
    let a: unknown;
    try { a = JSON.parse(bytes); } catch { return null; }
    const art = a as { schema?: unknown; evaluator?: unknown; second_read?: Record<string, unknown> };
    if (art?.schema !== 1 || art.evaluator !== SECOND_READ_POLICY_EVALUATOR || typeof art.second_read !== "object" || art.second_read === null) return null;
    const s = art.second_read;
    // No back-reference either: the evaluator never needs one, and it defeats the shape check.
    const pattern = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_PATTERN_CHARS && !/\\[1-9]|\\k</.test(v) && !hasNestedRepetition(v);
    const list = (v: unknown, min: number): v is string[] => Array.isArray(v) && v.length >= min && v.length <= MAX_LIST_ENTRIES && v.every(pattern);
    if (!list(s.operational_terms, MIN_OPERATIONAL_TERMS) || !list(s.deploy_decision, MIN_DEPLOY_DECISION)) return null;
    if (![s.classifier_labels, s.classifier_directed, s.deploy_term, s.deploy_script_noun].every(pattern)) return null;
    try {
        // The client sets every flag; the artifact supplies sources only.
        return {
            operational: new RegExp(s.operational_terms.join("|"), "i"),
            classifierLabels: new RegExp(s.classifier_labels as string),
            classifierDirected: new RegExp(s.classifier_directed as string, "i"),
            deployTerm: new RegExp(s.deploy_term as string, "i"),
            deployScriptNoun: new RegExp(s.deploy_script_noun as string, "gi"),
            deployDecision: new RegExp(s.deploy_decision.join("|"), "i"),
        };
    } catch {
        return null;
    }
}

/** Capturing groups in a pattern fragment (the reader numbers its own). */
const groups = (src: string) => new RegExp(`${src}|`).exec("")!.length - 1;

/** The compiled answer-check policy from the artifact's exact bytes, or null
 *  for anything but the expected artifact: another hash, schema or evaluator,
 *  a missing or oversized text, a correction line without its three slots, a
 *  pattern that does not compile or captures, a bad scale list. */
export function parseAnswerCheckPolicy(bytes: string, expectSha256: string = ANSWER_CHECK_POLICY_SHA256): AnswerCheckPolicy | null {
    if (Buffer.byteLength(bytes, "utf8") > MAX_ARTIFACT_BYTES) return null;
    if (sha256(bytes) !== expectSha256) return null;
    let a: unknown;
    try { a = JSON.parse(bytes); } catch { return null; }
    const art = a as { schema?: unknown; evaluator?: unknown; answer_check?: Record<string, unknown> };
    if (art?.schema !== 1 || art.evaluator !== ANSWER_CHECK_POLICY_EVALUATOR || typeof art.answer_check !== "object" || art.answer_check === null) return null;
    const s = art.answer_check;
    const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
    if (!text(s.system_prompt, 16_384) || !text(s.reminder, 1_024) || !text(s.verdict_only, 1_024)) return null;
    const c = s.correction as Record<string, unknown> | undefined;
    if (!c || !text(c.lead, 512) || !text(c.tail, 512) || typeof c.join !== "string" || c.join.length === 0 || c.join.length > 16 || !text(c.line, 256)) return null;
    if (!["{expression}", "{correct}", "{stated}"].every(slot => (c.line as string).includes(slot))) return null;
    const ar = s.arithmetic as Record<string, unknown> | undefined;
    if (!ar) return null;
    const fragments = [ar.number, ar.start, ar.minus_or_plus, ar.end, ar.quoted];
    if (!fragments.every(f => text(f, MAX_PATTERN_CHARS))) return null;
    const scale = ar.scale_powers;
    if (!Array.isArray(scale) || scale.length === 0 || scale.length > 16 || !scale.every(k => Number.isInteger(k) && k !== 0 && Math.abs(k) <= 12)) return null;
    // The reader numbers its own groups: a fragment may neither capture nor refer back to one.
    if (fragments.some(f => /\\[1-9]|\\k</.test(f as string))) return null;
    if (fragments.some(f => hasNestedRepetition(f as string))) return null;
    // The reader repeats (sign, number) pairs; that stays linear only while the
    // sign is a real separator: it must consume something and never a digit,
    // and a number must consume a digit.
    const sign = ar.minus_or_plus as string, number = ar.number as string;
    if (wholeMatch(sign, "") || [..."0123456789"].some(d => wholeMatch(sign, d))) return null;
    if (wholeMatch(number, "") || !wholeMatch(number, "7")) return null;
    try {
        if (fragments.some(f => groups(f as string) !== 0)) return null;
        const arithmetic = {
            number: ar.number as string, start: ar.start as string, minusOrPlus: ar.minus_or_plus as string, end: ar.end as string,
            quoted: new RegExp(ar.quoted as string), scalePowers: scale as number[],
        };
        arithmeticExpressions(arithmetic);   // the reader's expressions, exactly as it builds them
        return {
            systemPrompt: s.system_prompt,
            reminder: s.reminder,
            verdictOnly: s.verdict_only,
            correction: { lead: c.lead as string, line: c.line as string, join: c.join, tail: c.tail as string },
            arithmetic,
        };
    } catch {
        return null;
    }
}

/** The classifier-input policy from the artifact's exact bytes, or null for
 *  anything but the expected artifact: another hash, schema or evaluator, a
 *  word list below its floor or with an entry that is not one lowercase word,
 *  no required group or a group or qualifier naming an unlisted word, no
 *  words a kept sentence must offer, a token
 *  pattern that is oversized, refers back, repeats a varying group or does not
 *  compile. */
export function parseClassifierInputPolicy(bytes: string, expectSha256: string = CLASSIFIER_INPUT_POLICY_SHA256): ClassifierInputPolicy | null {
    if (Buffer.byteLength(bytes, "utf8") > MAX_ARTIFACT_BYTES) return null;
    if (sha256(bytes) !== expectSha256) return null;
    let a: unknown;
    try { a = JSON.parse(bytes); } catch { return null; }
    const art = a as { schema?: unknown; evaluator?: unknown; classifier_input?: Record<string, unknown> };
    if (art?.schema !== 1 || art.evaluator !== CLASSIFIER_INPUT_POLICY_EVALUATOR || typeof art.classifier_input !== "object" || art.classifier_input === null) return null;
    const s = art.classifier_input;
    const words = s.drop_sentence_words;
    const word = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_WORD_CHARS && v === v.toLowerCase() && !/\s/.test(v);
    if (!Array.isArray(words) || words.length < MIN_DROP_WORDS || words.length > MAX_LIST_ENTRIES || !words.every(word)) return null;
    const listed = new Set(words);
    const subset = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.length <= MAX_LIST_ENTRIES && v.every(w => typeof w === "string" && listed.has(w));
    const groups = s.require_each;
    if (!Array.isArray(groups) || groups.length === 0 || groups.length > MAX_REQUIRED_GROUPS || !groups.every(subset)) return null;
    const after = s.only_after ?? {};
    if (typeof after !== "object" || after === null || Array.isArray(after)) return null;
    const afterEntries = Object.entries(after as Record<string, unknown>);
    if (!afterEntries.every(([w, prev]) => listed.has(w) && subset(prev))) return null;
    const needed = s.kept_needs_one_of;
    if (!Array.isArray(needed) || needed.length === 0 || needed.length > MAX_LIST_ENTRIES || !needed.every(word)) return null;
    const tokenPattern = (v: unknown) => v === undefined || (typeof v === "string" && v.length > 0 && v.length <= MAX_PATTERN_CHARS && !/\\[1-9]|\\k</.test(v) && !hasNestedRepetition(v));
    const also = s.also_match, afterPattern = s.only_after_pattern;
    if (!tokenPattern(also) || !tokenPattern(afterPattern)) return null;
    try {
        // The client sets the flags (none); the artifact supplies the source only.
        return {
            dropWords: listed,
            requireEach: groups.map(g => new Set(g)),
            onlyAfter: new Map(afterEntries.map(([w, prev]) => [w, new Set(prev as string[])])),
            onlyAfterPattern: typeof afterPattern === "string" ? new RegExp(afterPattern) : null,
            alsoMatch: typeof also === "string" ? new RegExp(also) : null,
            keptNeedsOneOf: new Set(needed),
        };
    } catch {
        return null;
    }
}

interface LoadOptions {
    fetchImpl?: typeof fetch;
    deadlineMs?: number;
    /** Tests only: the hash to fetch and accept instead of the pinned one. */
    expectSha256?: string;
}

/** One pinned artifact: loaded once, shared by concurrent callers, retried
 *  after RETRY_AFTER_MS when a load fails, and dropped by reset() when the
 *  account changes (a sign-in can switch the account and the portal). A load
 *  that was in flight when reset() ran is not kept. Never throws. */
function pinned<T>(pinnedSha: string, parse: (bytes: string, sha: string) => T | null) {
    let cached: T | null = null;
    let inflight: Promise<T | null> | null = null;
    let retryAt = 0;
    let generation = 0;
    const get = async (o: LoadOptions = {}): Promise<T | null> => {
        if (!PRISM_SYNALUX_BASE_URL) return null;
        if (cached) return cached;
        if (inflight) return inflight;
        if (Date.now() < retryAt) return null;
        const started = generation;
        const promise: Promise<T | null> = load(o, o.expectSha256 ?? pinnedSha, parse).then(policy => {
            if (started !== generation) return policy;   // the account changed meanwhile: not kept
            if (policy) cached = policy;
            else retryAt = Date.now() + RETRY_AFTER_MS;
            return policy;
        }).catch(() => { if (started === generation) retryAt = Date.now() + RETRY_AFTER_MS; return null; })
            .finally(() => { if (inflight === promise) inflight = null; });
        inflight = promise;
        return promise;
    };
    const reset = () => { generation++; cached = null; inflight = null; retryAt = 0; };
    return { get, reset };
}

async function load<T>(o: LoadOptions, sha: string, parse: (bytes: string, sha: string) => T | null): Promise<T | null> {
    const f = o.fetchImpl ?? fetch;
    const deadline = Date.now() + (o.deadlineMs ?? LOAD_DEADLINE_MS);
    const left = () => deadline - Date.now();
    const jwtWithin = async (): Promise<string | null> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, left())); });
        try { return await Promise.race([getSynaluxJwt().catch(() => null), expired]); }
        finally { clearTimeout(timer); }
    };
    const get = (jwt: string) => f(`${PRISM_SYNALUX_BASE_URL}/api/v1/prism/inference-policy/${sha}`, {
        method: "GET",
        headers: { "Authorization": `Bearer ${jwt}`, "Accept": "application/json" },
        signal: AbortSignal.timeout(Math.max(1, left())),
        redirect: "error",
    });
    let jwt = await jwtWithin();
    if (!jwt) return null;
    let res = await get(jwt);
    if (res.status === 401) {
        invalidateSynaluxJwt();
        jwt = await jwtWithin();
        if (!jwt || left() <= 0) return null;
        res = await get(jwt);
    }
    if (!res.ok) return null;
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_ARTIFACT_BYTES) return null;
    // The pin covers the bytes as received: hash them before any decoding,
    // which would drop a byte-order mark or repair invalid UTF-8 first.
    const raw = Buffer.from(await res.arrayBuffer());
    if (raw.byteLength > MAX_ARTIFACT_BYTES) return null;
    if (createHash("sha256").update(raw).digest("hex") !== sha) return null;
    return parse(raw.toString("utf8"), sha);
}

const secondRead = pinned(SECOND_READ_POLICY_SHA256, parseSecondReadPolicy);
const answerCheck = pinned(ANSWER_CHECK_POLICY_SHA256, parseAnswerCheckPolicy);
const classifierInput = pinned(CLASSIFIER_INPUT_POLICY_SHA256, parseClassifierInputPolicy);
/** The pinned second-read policy, or null. */
export const getSecondReadPolicy = (o: LoadOptions = {}) => secondRead.get(o);
/** The pinned answer-check policy, or null. */
export const getAnswerCheckPolicy = (o: LoadOptions = {}) => answerCheck.get(o);
/** The pinned classifier-input policy, or null. */
export const getClassifierInputPolicy = (o: LoadOptions = {}) => classifierInput.get(o);

/** Drops every cached policy; the next request loads them again. Called
 *  when the account changes (dashboard sign-in and sign-out). */
export function clearInferencePolicies(): void {
    secondRead.reset();
    answerCheck.reset();
    classifierInput.reset();
}

/** Tests only. */
export function _resetSecondReadPolicyForTest(): void {
    clearInferencePolicies();
}
