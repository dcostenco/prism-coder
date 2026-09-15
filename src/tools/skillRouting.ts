/**
 * Skill routing thin client.
 *
 * Split of responsibility (changed 2026-08-02):
 *   - The PORTAL is the entitlement oracle. POST SYNALUX_BASE/api/v1/prism/resolve
 *     with bearer auth answers "is this caller paid, and which universal/project
 *     skills do they get". The request body carries NO prompt.
 *   - PROMPT keyword routing is matched ON-DEVICE against the public routing
 *     table (GET SYNALUX_BASE/_internal/skills-routing.json — no auth, no body).
 *     The user's message never leaves the machine.
 *
 * Why the prompt stopped being transmitted: routing needs only which of 28
 * regexes match, and the regexes are already public. Sending the raw first
 * message bought nothing a local match could not compute — and free-tier
 * callers paid that privacy cost for literally zero routing benefit, since
 * the portal gates them to an empty set (resolve/route.ts: `tier === 'paid' ?
 * resolved : []`). Paid skill CONTENT stays gated server-side at
 * /api/v1/prism/skill-manifest, which this change does not touch.
 *
 * Cache: portal keyed on (project,role) — no longer per-prompt, which never
 * hit because prompts are unique. Keyword table cached 1h + last-good.
 * Offline: last-good from local DB, or empty with warning.
 */

import { getSynaluxJwt, invalidateSynaluxJwt } from '../utils/synaluxJwt.js';
import { PRISM_SYNALUX_API_KEY, PRISM_SYNALUX_BASE_URL } from '../config.js';

// -- Type exports (backward compat) ------------------------------------------

export interface UserLocalPolicy { enabled: boolean; key_prefix: string }
export interface SkillEntry { name: string; priority: number; protected?: boolean }

export interface SkillRoutingTable {
  version: number;
  universal: (string | SkillEntry)[];
  projects: Record<string, (string | SkillEntry)[]>;
  prompt_keywords?: Record<string, string[]>;
  user_local: UserLocalPolicy;
}

export interface ResolvedSkill {
  name: string; priority: number; protected: boolean;
  category: 'universal' | 'project' | 'prompt';
}

export interface ResolvedSkills {
  names: string[];
  skills: ResolvedSkill[];
  user_local: UserLocalPolicy;
  isOffline: boolean;
  routing_version?: number;
}

// -- Constants ----------------------------------------------------------------

const LIVE_TTL = 5 * 60 * 1000;
const FAIL_TTL = 30_000;
const DEFAULT_UL: UserLocalPolicy = { enabled: false, key_prefix: 'user_skill:' };

export const REQUIRED_PROTECTED_SKILL_NAMES = [
  'prime-directive',
  'aba-precision-protocol',
  'evidence-first-protocol',
  'behavioral-verifier',
  'occam-razor-protocol',
  'absence-of-evidence-protocol',
  'never-fabricate-data',
  'session-drift-detection',
  'pre-commit-protocol',
  'pre-push-audit',
  'implementation-integrity-audit',
  'local-inference-first',
  // Added 2026-08-02. Both are universal diagnostic-discipline rules that
  // overflowed to name-only on small budgets; the portal marked them
  // protected but this list — the running server's own floor — was missed,
  // so the two sources disagreed. A portal test now asserts they match.
  'data-before-code',
  'critical-thinking-debug',
  // Added 2026-08-03. The floor had grown past every budget tranche, so an
  // unprotected universal skill could NEVER inline — including the destruction
  // gate, during the very audit of a demo-venue wipe it should have prevented.
  // If these two are absent, nothing tells the agent that announcing a wipe is
  // not the same as being allowed to run it.
  'ask-first',
  'feature-preservation',
] as const;

/**
 * Native skills that paid subscription tiers receive through `prism connect`.
 *
 * `prism-startup` is deliberately not part of OFFLINE_FALLBACK: it tells the
 * host to call session_load_context, so injecting it back into that tool's
 * response would be circular. It still belongs in every native manifest so a
 * newly connected host can discover the hook-free first-turn procedure.
 */
export const REQUIRED_NATIVE_SKILL_NAMES = [
  ...REQUIRED_PROTECTED_SKILL_NAMES,
  'prism-startup',
] as const;

/** Public hook-free bootstrap package available without a paid entitlement. */
export const FREE_NATIVE_SKILL_NAMES = ['prism-startup'] as const;

export const OFFLINE_FALLBACK: SkillRoutingTable = {
  version: 1,
  universal: REQUIRED_PROTECTED_SKILL_NAMES.map((name, priority) => ({ name, priority, protected: true })),
  projects: {},
  user_local: DEFAULT_UL,
};

// -- Cache (keyed on project+prompt+role) -------------------------------------

interface PortalResp {
  loaded: string[]; skipped: string[];
  routing_version: number; tier: string;
  /** Per-skill metadata (portal ≥ routing v23). Older portals omit it. */
  skills?: Array<{ name: string; priority: number; protected: boolean; category: string }>;
}

/**
 * Map a portal response to ResolvedSkill[]. Uses the portal's per-skill
 * metadata when present; for older portals that send names only, falls back
 * to neutral defaults (protected:false) — the budgeting floor then relies on
 * the caller's own knowledge (e.g. OFFLINE_FALLBACK). NEVER fabricate
 * protected:true here: an over-broad floor would defeat budgeting entirely.
 */
function toResolvedSkills(resp: PortalResp): ResolvedSkill[] {
  if (resp.skills && resp.skills.length > 0) {
    return resp.skills.map((s) => ({
      name: s.name, priority: s.priority, protected: s.protected,
      category: (s.category as ResolvedSkill['category']) ?? 'universal',
    }));
  }
  return resp.loaded.map((name, i) => ({
    name, priority: i, protected: false, category: 'universal' as const,
  }));
}

interface CacheEntry { resp: PortalResp; at: number; live: boolean }

const cache = new Map<string, CacheEntry>();
const inflightMap = new Map<string, Promise<PortalResp | null>>();

/**
 * Deliberately excludes the prompt. Prompts are unique, so a per-prompt key
 * never hit and grew one dead entry per message; and the portal no longer
 * receives a prompt to key on.
 */
function cacheKey(project: string, role?: string): string {
  return `${project}|${role || ''}`;
}

// Persist last-good to local DB for offline fallback
let persistFn: ((key: string, value: string) => Promise<void>) | null = null;
let readFn: ((key: string) => Promise<string>) | null = null;

export function _setStorage(persist: typeof persistFn, read: typeof readFn): void {
  persistFn = persist;
  readFn = read;
}

/** Test-only handle, matching this file's underscore convention for
 *  internals exposed to tests (round-2 review). Production callers use the
 *  module-internal function directly. */
export const _toResolvedSkillsWithPrompt = (
  ...args: Parameters<typeof toResolvedSkillsWithPrompt>
) => toResolvedSkillsWithPrompt(...args);

function synaluxBase(): string {
  return (process.env.PRISM_SYNALUX_BASE_URL?.trim() ||
    process.env.SYNALUX_BASE_URL?.trim() || PRISM_SYNALUX_BASE_URL ||
    'https://synalux.ai').replace(/\/+$/, '');
}

/**
 * No `prompt` parameter, by design. The privacy guarantee is enforced by this
 * signature: the user's message is not in scope at the only site that builds a
 * network request body, so it cannot be transmitted by a later edit without
 * deleting this comment and changing the type.
 */
async function callPortal(project: string, role?: string): Promise<PortalResp | null> {
  try {
    const body: Record<string, string> = { project };
    if (role) body.role = role;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    // Auth precedence: static PRISM_SKILLS_TOKEN (legacy/CI) → JWT exchanged
    // from the synalux API key. The JWT path uses the same per-user identity
    // as inference, so skills and inference resolve the SAME tier — without
    // it, machines with only PRISM_SYNALUX_API_KEY silently resolve tier=free
    // and never receive unprotected/prompt-routed skills.
    const staticToken = process.env.PRISM_SKILLS_TOKEN || '';
    const configuredApiKey = process.env.PRISM_SYNALUX_API_KEY?.trim() || PRISM_SYNALUX_API_KEY;
    let usedJwt = false;
    if (staticToken) {
      headers['Authorization'] = `Bearer ${staticToken}`;
    } else {
      // Bound the exchange so a hanging JWT endpoint cannot stall
      // session_load_context startup: after 4s proceed unauthenticated
      // (free-tier resolve) — the exchange keeps running and its cached
      // result authenticates the next call.
      const jwt = await Promise.race([
        getSynaluxJwt(),
        new Promise<null>((r) => setTimeout(r, 4_000, null)),
      ]);
      if (jwt) { headers['Authorization'] = `Bearer ${jwt}`; usedJwt = true; }
      else if (configuredApiKey) {
        // A configured paid identity that cannot authenticate must retain its
        // last-good result. Sending the request anonymously would silently
        // turn an auth outage into a free-tier downgrade.
        return null;
      }
    }

    const doFetch = () => fetch(`${synaluxBase()}/api/v1/prism/resolve`, {
      method: 'POST', headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
      redirect: 'error', // never follow a redirect with a credential attached
    });
    let res = await doFetch();
    if (res.status === 401 && usedJwt) {
      // Expired/rotated JWT — invalidate and retry once with a fresh one.
      invalidateSynaluxJwt();
      const fresh = await getSynaluxJwt();
      if (fresh) {
        headers['Authorization'] = `Bearer ${fresh}`;
        res = await doFetch();
      }
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as PortalResp;
  } catch { return null; }
}

function makeOffline(): ResolvedSkills {
  return { names: [], skills: [], user_local: DEFAULT_UL, isOffline: true };
}

// -- Prompt keyword routing, matched ON-DEVICE --------------------------------

const TABLE_TTL = 60 * 60 * 1000;
const TABLE_STORAGE_KEY = 'routing_keywords';
/** Public, unauthenticated, byte-identical to the table the portal compiles. */
const TABLE_PATH = '/_internal/skills-routing.json';

interface KeywordTable { version: number; prompt_keywords: Record<string, string[]> }

let kwCache: { table: KeywordTable; at: number } | null = null;
let kwInflight: Promise<KeywordTable | null> | null = null;
const warnedVersions = new Set<string>();

function isKeywordTable(v: unknown): v is KeywordTable {
  const t = v as KeywordTable | null;
  return !!t && typeof t.version === 'number' && !!t.prompt_keywords
    && typeof t.prompt_keywords === 'object';
}

/**
 * Enforce the table's value contract at INGEST, once, for every consumer.
 * isKeywordTable only proves prompt_keywords is an object — round-4 review
 * showed a string value ('notarray') sails through and the matcher's
 * `for (const skillName of skills)` iterates it CHARACTER BY CHARACTER,
 * synthesizing bogus one-letter "skill names". Non-array values are dropped,
 * non-string members filtered, matching the scoped-trigger merge's policy.
 * The result is NULL-PROTOTYPE so a hostile pattern key ('__proto__',
 * 'constructor') can neither read an inherited value nor mutate a prototype
 * downstream.
 */
function sanitizePromptKeywords(raw: Record<string, string[]>): Record<string, string[]> {
  const clean: Record<string, string[]> = Object.create(null);
  for (const [pattern, names] of Object.entries(raw)) {
    if (!Array.isArray(names)) continue;
    const strings = names.filter((n): n is string => typeof n === 'string');
    if (strings.length === 0) continue;
    clean[pattern] = strings;
  }
  return clean;
}

/**
 * @param expectVersion routing_version the portal just reported. A mismatch
 *   means our cached copy predates a routing deploy, so drop it and refetch
 *   once — bounded to one extra request per version change.
 */
async function fetchKeywordTable(expectVersion?: number): Promise<KeywordTable | null> {
  if (expectVersion !== undefined && kwCache && kwCache.table.version !== expectVersion) {
    kwCache = null;
  }
  if (kwCache && Date.now() - kwCache.at < TABLE_TTL) return kwCache.table;
  // Persisted-first when the version is KNOWN-GOOD. The in-memory cache is
  // per-process, and the route-prompt CLI is a fresh process on EVERY user
  // prompt — without this, each prompt made a network GET (measured: a
  // captive-portal network stalled every prompt 5.5s, and offline routed
  // nothing because a fresh process had no fallback wired). A persisted
  // table whose version equals what the manifest sync last reported is
  // exactly as fresh as a re-download; version bumps still refetch below.
  if (expectVersion !== undefined && readFn) {
    try {
      const stored = await readFn(TABLE_STORAGE_KEY);
      const parsed: unknown = stored ? JSON.parse(stored) : null;
      if (isKeywordTable(parsed) && parsed.version === expectVersion) {
        const table: KeywordTable = { version: parsed.version, prompt_keywords: sanitizePromptKeywords(parsed.prompt_keywords) };
        kwCache = { table, at: Date.now() };
        return table;
      }
    } catch { /* fall through to network */ }
  }
  if (!kwInflight) {
    kwInflight = (async (): Promise<KeywordTable | null> => {
      try {
        const res = await fetch(`${synaluxBase()}${TABLE_PATH}`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(5_000),
          redirect: 'error',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw: unknown = await res.json();
        if (!isKeywordTable(raw)) throw new Error('malformed routing table');
        const table: KeywordTable = { version: raw.version, prompt_keywords: sanitizePromptKeywords(raw.prompt_keywords) };
        kwCache = { table, at: Date.now() };
        if (persistFn) {
          try { await persistFn(TABLE_STORAGE_KEY, JSON.stringify(table)); } catch { /* cache-only */ }
        }
        return table;
      } catch {
        // Stale-but-usable beats no keyword routing: an unreachable portal is
        // exactly the incident case where symptom-triggered skills matter.
        if (kwCache) return kwCache.table;
        if (readFn) {
          try {
            const stored = await readFn(TABLE_STORAGE_KEY);
            const parsed: unknown = stored ? JSON.parse(stored) : null;
            if (isKeywordTable(parsed)) {
              const table: KeywordTable = { version: parsed.version, prompt_keywords: sanitizePromptKeywords(parsed.prompt_keywords) };
              kwCache = { table, at: 0 }; // at:0 → retry live on next call
              return table;
            }
          } catch { /* fall through to null */ }
        }
        return null;
      } finally {
        kwInflight = null;
      }
    })();
  }
  return kwInflight;
}

/**
 * Strip QUOTED EVIDENCE from a prompt before trigger matching.
 *
 * Triggers are meant to fire on a symptom the user is REPORTING, not on every
 * string that happens to appear in material they pasted as evidence. Observed
 * 2026-08-31: a user asked "what's going on with skill loading?" and pasted a
 * startup log; the log listed installed skill names, and the literal token
 * `acme-xyz-billing` inside it satisfied that skill's own trigger
 * `\bacme\b.{0,20}\b(billing|invoice)\b`. Two unrelated private skills loaded
 * and were injected as binding rules for a debugging question — pasting a log
 * that NAMES a skill should never activate it.
 *
 * Two removals, both conservative:
 *   1. Fenced code blocks — pasted output, by convention.
 *   2. Hyphenated skill-name tokens (`foo-bar-baz`). A bare skill name is
 *      metadata about the system, not a description of work. Removing only the
 *      NAME SPAN keeps its constituent words available: "acme billing invoice"
 *      typed by the user still matches, because that text is not a name token.
 *
 * Deliberately NOT length-capped: a long prompt is not evidence of pasting,
 * and truncating input would silently stop matching real symptoms stated late.
 */
export function stripQuotedEvidenceForRouting(
  prompt: string,
  promptKeywords: Record<string, string[]> = {},
): string {
  // Fences are LINE-ANCHORED: a pasted code block starts its ``` at the
  // beginning of a line by convention. The first version paired ANY two
  // occurrences of the marker anywhere in the string, so two incidental
  // inline backtick-triples bracketing real user-typed symptom text ate that
  // text (adversarial review, confirmed with a repro). Line-anchoring means
  // eating text now requires two line-start fences — which IS a fenced block.
  //
  // Replacement must sever BOTH proximity-window classes in the real table:
  //   - `.{0,N}` windows: `.` does not cross \n (no pattern uses the s-flag),
  //     so a newline severs them.
  //   - `\s*`/`\s+`-glued windows (34 of 58 live patterns, e.g.
  //     `\bui\s*test\b`): \n IS \s, so a bare newline does NOT sever them —
  //     round-2 review reproduced `ui <stripped-name> test` routing
  //     xcuitest-ios-watch through exactly that gap. The separator therefore
  //     includes \x1F (unit separator): non-space (blocks \s runs), non-word
  //     (leaves \b semantics as a space would), and severed from dot-windows
  //     by the flanking newlines.
  const SEVER = '\n\x1f\n';
  let out = prompt
    .replace(/^[ \t]*```[^\n]*\n[\s\S]*?\n[ \t]*```[ \t]*$/gm, SEVER)
    .replace(/^[ \t]*~~~[^\n]*\n[\s\S]*?\n[ \t]*~~~[ \t]*$/gm, SEVER);

  // Strip only the names of skills that this very table could route. A generic
  // "identifier-shaped token" heuristic was tried first and rejected by test:
  // it also ate ordinary hyphenated English ("end-to-end", "well-formed"),
  // which risks silently SUPPRESSING a real symptom — a worse failure than the
  // false positive being fixed. Using the actual routable names is exact.
  //
  // Deliberate consequence, not an oversight: a user who TYPES a skill's name
  // ("update acme-xyz-billing's invoice rate") no longer trigger-routes that
  // skill. That is acceptable because the agent reads the raw prompt and can
  // invoke a literally-named skill directly — trigger routing exists for
  // SYMPTOM text, where the name is absent. A pasted log naming skills must
  // not route them; a typed name doesn't need routing to be honored.
  const names = new Set<string>();
  // Non-string entries (a corrupted cache serializes undefined → null) must
  // never reach the sort comparator below — round-2 review reproduced an
  // uncaught TypeError from `.length` on null OUTSIDE the try/catch, killing
  // routing for the whole prompt. Filter at collection, the only choke point.
  for (const list of Object.values(promptKeywords)) {
    if (!Array.isArray(list)) continue;
    for (const n of list) if (typeof n === "string") names.add(n);
  }
  // Longest first, so a name that contains another is removed whole.
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    // Bounds mirror the routing table's own name policy (≤128 chars). An
    // overlong or hostile name from a poisoned table must degrade to
    // "not stripped", never to a thrown SyntaxError that kills routing for
    // the whole prompt — the sibling _applyPromptRouting swallows bad
    // patterns for the same reason (adversarial review, confirmed).
    // Only IDENTIFIER-SHAPED names are stripped: at least two segments joined
    // by - or _ (acme-xyz-billing, training-results-gate). Round-3 review
    // proved the unconditional version was self-defeating for skills whose
    // name is an ordinary word: stripping `sentry` from "check sentry for
    // recent errors" killed that skill's OWN trigger (\bsentry\b) — 100% of
    // its realistic phrasings routed nothing, same for linear/pdf/supabase.
    // A single ordinary word cannot be distinguished from prose, so it is
    // never stripped; the accepted residual is that a pasted skill LIST can
    // still route single-word-named skills.
    //
    // Anchoring is SEGMENT-aligned, not token-aligned (round-4 review): the
    // name must not butt directly against a letter/digit, but MAY butt
    // against segment glue (-/_). Round 3's stricter (?<![\w-]) anchors
    // refused to strip the name out of longer compounds — a pasted
    // `acme-xyz-billing-worker` container name survived intact, and because
    // \b fires at every internal hyphen, the skill's own trigger still
    // matched inside it: the exact incident class this function exists to
    // kill. Alignment on segment edges strips those compounds while still
    // refusing mid-token overlaps (the name `fix-ci` never fires inside the
    // unrelated word `prefix-ci`, whose own trigger must survive).
    if (name.length < 3 || name.length > 128 || !/[a-z0-9]/i.test(name)) continue;
    if (!/[-_]/.test(name)) continue;
    try {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'gi'), SEVER);
    } catch { /* skip unbuildable names — same policy as the matcher */ }
  }
  return out;
}

/**
 * Verbatim port of portal resolve/route.ts prompt-matching block + the sort
 * that follows it. Parity is the whole point: any divergence silently changes
 * which skills load. Do not "improve" this — the reference implementation and
 * a scenario-level parity test both pin it.
 *
 * `priority: 200 + resolved.length` reads the length AT PUSH TIME, so it
 * depends on how many skills precede it. Preserved exactly.
 *
 * NOTE: callers pass a prompt already run through
 * `stripQuotedEvidenceForRouting`. The matching semantics here are untouched —
 * only the INPUT is normalized — so the parity contract with the portal's
 * reference implementation still holds for any given input string.
 */
export function _applyPromptRouting(
  base: ResolvedSkill[],
  prompt: string,
  promptKeywords: Record<string, string[]>,
): ResolvedSkill[] {
  const resolved: ResolvedSkill[] = base.map((s) => ({ ...s }));
  const seen = new Set(resolved.map((s) => s.name));
  for (const [pattern, skills] of Object.entries(promptKeywords)) {
    try {
      if (new RegExp(pattern, 'i').test(prompt)) {
        for (const skillName of skills) {
          const existing = resolved.find((s) => s.name === skillName);
          if (existing) existing.category = 'prompt';
          else if (!seen.has(skillName)) {
            seen.add(skillName);
            resolved.push({
              name: skillName, priority: 200 + resolved.length,
              protected: false, category: 'prompt',
            });
          }
        }
      }
    } catch { /* invalid pattern — portal swallows it too */ }
  }
  resolved.sort((a, b) => a.priority - b.priority);
  return resolved;
}

/**
 * Skill names matched by the on-device keyword rules, and nothing else.
 *
 * For the NATIVE-context path (session_bootstrap): native hosts receive skill
 * files on disk from the tier-gated manifest sync, so there is no portal call
 * to make and no entitlement to re-derive here — the caller already holds
 * `entitledSkillNames` and MUST filter with it. Returns [] when the table is
 * unavailable rather than guessing.
 *
 * Deliberately does not call the portal: bootstrap is the first-turn startup
 * display, and blocking it on a network round-trip per project is the cost
 * this whole change exists to avoid.
 *
 * @param expectVersion routing version the caller already knows (the native
 *   path has no portal response, so without this it could serve a stale table
 *   indefinitely and never detect drift). The skill manifest carries one.
 */
export async function resolvePromptSkillNames(
  prompt: string,
  expectVersion?: number,
  scopedTriggers?: Record<string, string[]>,
): Promise<string[]> {
  if (!prompt) return [];
  const kw = await fetchKeywordTable(expectVersion);
  // Scoped triggers must still route when the PUBLIC table is unavailable:
  // they are declared in skill bodies already on this machine and owe nothing
  // to a network fetch. Returning [] here would make a private skill's routing
  // depend on a public file it can never appear in.
  const publicKeywords = kw?.prompt_keywords ?? {};
  if (!kw && !scopedTriggers) return [];

  // NULL-PROTOTYPE, not a literal (round-4 review): with a plain object, a
  // scoped pattern whose TEXT is an inherited property name made both sides
  // of the merge below misbehave — `combined['constructor'] ?? []` read the
  // inherited constructor (truthy, not iterable → throw, blanking ALL
  // routing for the turn), and `combined['__proto__'] = …` invoked the
  // prototype setter instead of storing a pattern. A null prototype has
  // nothing to inherit, so both operations are plain data-property access.
  const combined: Record<string, string[]> = Object.assign(
    Object.create(null) as Record<string, string[]>, publicKeywords,
  );
  for (const [pattern, names] of Object.entries(scopedTriggers ?? {})) {
    // A malformed skill body can hand this merge null/42/{} for a pattern —
    // spreading that threw "names is not iterable" here, silently blanking
    // ALL routing for the turn at both callers (round-3 review). Degrade to
    // skip, matching the never-throw policy everywhere else in this path.
    if (!Array.isArray(names)) continue;
    const clean = names.filter((n): n is string => typeof n === "string");
    if (clean.length === 0) continue;
    combined[pattern] = [...(combined[pattern] ?? []), ...clean];
  }
  return _applyPromptRouting([], stripQuotedEvidenceForRouting(prompt, combined), combined).map((s) => s.name);
}

/**
 * Free tier resolves to an empty set portal-side, so adding prompt-matched
 * skills locally would hand out an entitlement the portal just withheld.
 * Older portals omit `tier`; fall back to "did we get anything at all".
 */
function isPaid(resp: PortalResp): boolean {
  return resp.tier ? resp.tier === 'paid' : resp.loaded.length > 0;
}

async function toResolvedSkillsWithPrompt(
  resp: PortalResp, prompt: string | undefined, isOffline: boolean,
): Promise<ResolvedSkills> {
  let skills = toResolvedSkills(resp);
  if (prompt && isPaid(resp)) {
    const kw = await fetchKeywordTable(resp.routing_version);
    if (kw) {
      if (typeof resp.routing_version === 'number' && kw.version !== resp.routing_version) {
        const pair = `${kw.version}/${resp.routing_version}`;
        if (!warnedVersions.has(pair)) {
          warnedVersions.add(pair);
          console.error(
            `[skill-routing] keyword table v${kw.version} vs portal v${resp.routing_version} — ` +
            `prompt-matched skills may lag a routing deploy`,
          );
        }
      }
      skills = _applyPromptRouting(skills, stripQuotedEvidenceForRouting(prompt, kw.prompt_keywords), kw.prompt_keywords);
    }
  }
  return {
    names: skills.map((s) => s.name),
    skills,
    user_local: DEFAULT_UL,
    isOffline,
    routing_version: resp.routing_version,
  };
}

// -- Public API ---------------------------------------------------------------

export async function resolveSkills(project: string, prompt?: string, role?: string): Promise<ResolvedSkills> {
  const key = cacheKey(project, role);
  const now = Date.now();
  const entry = cache.get(key);
  const ttl = (entry?.live ?? true) ? LIVE_TTL : FAIL_TTL;

  if (!entry || now - entry.at > ttl) {
    if (!inflightMap.has(key)) {
      const p = callPortal(project, role).then(async (r) => {
        if (r) {
          cache.set(key, { resp: r, at: Date.now(), live: true });
          // Persist last-good for offline fallback
          if (persistFn) {
            try { await persistFn(`skill_cache:${project}`, JSON.stringify(r)); } catch {}
          }
        } else if (entry) {
          cache.set(key, { ...entry, at: Date.now(), live: false });
        }
        return r;
      }).finally(() => { inflightMap.delete(key); });
      inflightMap.set(key, p);
    }
    await inflightMap.get(key);
  }

  const cached = cache.get(key);
  if (cached) {
    return toResolvedSkillsWithPrompt(cached.resp, prompt, !cached.live);
  }

  // No cached response — try last-good from local DB
  if (readFn) {
    try {
      const stored = await readFn(`skill_cache:${project}`);
      if (stored) {
        const resp = JSON.parse(stored) as PortalResp;
        return toResolvedSkillsWithPrompt(resp, prompt, true);
      }
    } catch {}
  }

  return makeOffline();
}

export async function resolveSkillsForProject(project: string): Promise<ResolvedSkills> {
  return resolveSkills(project);
}

export async function resolveSkillsForPrompt(_prompt: string, _baseSkills: string[] = []): Promise<string[]> {
  return [];
}

export function _invalidateRoutingCache(): void {
  cache.clear();
  inflightMap.clear();
  kwCache = null;
  kwInflight = null;
  warnedVersions.clear();
}

export const _OFFLINE_FALLBACK = OFFLINE_FALLBACK;
