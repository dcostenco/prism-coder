/**
 * Skill routing thin-client tests
 *
 * Verify that prism-mcp's skill routing client:
 *   - calls portal API with correct shape
 *   - returns portal response as ResolvedSkills
 *   - falls back to offline mode when portal is unreachable
 *   - caches responses (5-min live, 30s failure)
 *   - resolveSkillsForPrompt is a no-op (portal-side now)
 *   - exports backward-compat types and OFFLINE_FALLBACK
 *
 * NOTE: Routing logic (budget tranching, pattern matching, project resolution)
 * is tested in the portal at src/__tests__/skills-routing.test.ts.
 * This file only tests the thin client behavior.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveSkillsForProject,
  resolveSkillsForPrompt,
  resolveSkills,
  _invalidateRoutingCache,
  OFFLINE_FALLBACK,
} from '../src/tools/skillRouting.js';

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  _invalidateRoutingCache();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  _invalidateRoutingCache();
});

function mockPortalResponse(resp: unknown, ok = true) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    json: async () => resp,
    status: ok ? 200 : 500,
  } as Response);
}

const PORTAL_RESP = {
  loaded: ['prime-directive', 'bcba_ai_assistant'],
  skipped: ['military-code-review'],
  routing_version: 16,
  tier: 'paid',
};

describe('skill routing — portal call', () => {
  it('calls portal API with project', async () => {
    mockPortalResponse(PORTAL_RESP);
    await resolveSkillsForProject('prism-mcp');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/prism/resolve'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('returns loaded skill names from portal response', async () => {
    mockPortalResponse(PORTAL_RESP);
    const result = await resolveSkillsForProject('prism-mcp');
    expect(result.names).toEqual(['prime-directive', 'bcba_ai_assistant']);
    expect(result.isOffline).toBe(false);
  });

  it('returns loaded names from portal response', async () => {
    mockPortalResponse(PORTAL_RESP);
    const result = await resolveSkills('prism-mcp');
    expect(result.names).toContain('prime-directive');
  });

  it('passes role to portal but NEVER the prompt', async () => {
    // Inverted 2026-08-02. This test previously pinned `body.prompt` as a
    // REQUIREMENT — it was the contract that the user's verbatim first message
    // is transmitted. Prompt matching moved on-device, so the same assertion
    // now runs the other way: the prompt must be absent from every request
    // body, on every endpoint. Rewritten rather than deleted so the flip is
    // explicit in history instead of looking like dropped coverage.
    mockPortalResponse(PORTAL_RESP);
    const secret = 'user Sam Doe cannot access their ledger, sam.doe@example.invalid';
    await resolveSkills('prism-coder', secret, 'dev');

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const first = JSON.parse(calls[0][1].body);
    expect(first.project).toBe('prism-coder');
    expect(first.role).toBe('dev');
    expect(first.prompt).toBeUndefined();

    for (const [url, init] of calls) {
      const serialized = `${String(url)} ${init?.body ?? ''}`;
      expect(serialized).not.toContain('Sam Doe');
      expect(serialized).not.toContain('sam.doe@example.invalid');
    }
  });
});

describe('skill routing — offline fallback', () => {
  it('returns offline result when portal is unreachable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await resolveSkillsForProject('prism-mcp');
    expect(result.isOffline).toBe(true);
    expect(result.names).toEqual([]);
  });

  it('returns offline result when portal returns 500', async () => {
    mockPortalResponse({}, false);
    const result = await resolveSkillsForProject('prism-mcp');
    expect(result.isOffline).toBe(true);
  });

  it('returns offline on consecutive failures', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('timeout'));
    const r1 = await resolveSkillsForProject('prism-mcp');
    expect(r1.isOffline).toBe(true);

    const r2 = await resolveSkillsForProject('prism-mcp');
    expect(r2.isOffline).toBe(true);
  });
});

describe('skill routing — caching', () => {
  it('caches live response for 5 minutes', async () => {
    mockPortalResponse(PORTAL_RESP);
    const r1 = await resolveSkillsForProject('prism-mcp');
    const r2 = await resolveSkillsForProject('prism-mcp');
    expect(r1.names).toEqual(r2.names);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('skill routing — backward compat', () => {
  it('resolveSkillsForPrompt is a no-op', async () => {
    const result = await resolveSkillsForPrompt('some prompt', ['skill1']);
    expect(result).toEqual([]);
  });

  it('exports OFFLINE_FALLBACK with expected shape', () => {
    expect(OFFLINE_FALLBACK.version).toBe(1);
    expect(Array.isArray(OFFLINE_FALLBACK.universal)).toBe(true);
    expect(typeof OFFLINE_FALLBACK.projects).toBe('object');
  });

  it('pins the paid protected routing floor without a release-only staging gate', () => {
    const protectedNames = OFFLINE_FALLBACK.universal
      .filter((entry) => typeof entry !== 'string' && entry.protected)
      .map((entry) => typeof entry === 'string' ? entry : entry.name);
    // 12 -> 14 on 2026-08-02: data-before-code and critical-thinking-debug
    // joined the floor. Both are universal diagnostic-discipline rules that
    // overflowed to name-only on small budgets, which is why GATE 2 and the
    // four-query pre-flight were both skipped during a live incident.
    // Offline inclusion is safe: session_load_context only inlines a fallback
    // entry when its content is actually cached locally.
    // 14 -> 16 on 2026-08-03: ask-first and feature-preservation joined after
    // the demo-wipe audit — the floor exceeded every budget tranche, so an
    // unprotected destruction gate was never delivered to any agent.
    expect(protectedNames).toHaveLength(16);
    expect(OFFLINE_FALLBACK.universal).toHaveLength(16);
    expect(protectedNames).toContain('ask-first');
    expect(protectedNames).toContain('feature-preservation');
    expect(OFFLINE_FALLBACK.universal.every((entry) => typeof entry !== 'string' && entry.protected)).toBe(true);
    expect(protectedNames).toContain('aba-precision-protocol');
    expect(protectedNames).not.toContain('current-staging-acceptance');
    expect(protectedNames).not.toContain('bcba_ai_assistant');
  });

  it('user_local defaults to disabled', async () => {
    mockPortalResponse(PORTAL_RESP);
    const result = await resolveSkillsForProject('any');
    expect(result.user_local.enabled).toBe(false);
    expect(result.user_local.key_prefix).toBe('user_skill:');
  });
});

// ── Prompt routing matched ON-DEVICE ─────────────────────────────────────────
// The prompt is never transmitted; the 28 keyword regexes are fetched from the
// PUBLIC routing table and matched locally. These tests pin the two things that
// can silently break: (1) the match still happens, (2) it produces exactly what
// the portal would have produced.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _applyPromptRouting, _setStorage, type ResolvedSkill } from '../src/tools/skillRouting.js';

const TEST_TABLE = {
  version: 26,
  prompt_keywords: {
    "can'?t (access|see)|no rows|is (empty|blank)": ['data-before-code'],
    'lora|corpus|fine-?tun': ['autonomous-training-protocol'],
    '[unterminated': ['never-reachable'], // invalid regex — portal swallows it
  },
};

/** Dispatches by URL: resolve endpoint vs the public routing table. */
function mockEndpoints(opts: { resolve?: unknown; resolveOk?: boolean; table?: unknown }) {
  globalThis.fetch = vi.fn().mockImplementation((url: unknown) => {
    if (String(url).includes('/_internal/skills-routing.json')) {
      return Promise.resolve({
        ok: opts.table !== undefined, status: opts.table !== undefined ? 200 : 404,
        json: async () => opts.table,
      } as Response);
    }
    const ok = opts.resolveOk ?? true;
    return Promise.resolve({
      ok, status: ok ? 200 : 500, json: async () => opts.resolve,
    } as Response);
  });
}

const PAID_RESP = {
  loaded: ['prime-directive'], skipped: [], routing_version: 26, tier: 'paid',
  skills: [{ name: 'prime-directive', priority: 0, protected: true, category: 'universal' }],
};

describe('skill routing — on-device prompt matching', () => {
  afterEach(() => { _setStorage(null, null); });

  it('loads a keyword-matched skill without transmitting the prompt', async () => {
    mockEndpoints({ resolve: PAID_RESP, table: TEST_TABLE });
    const result = await resolveSkills('synalux', "Sam Doe can't access their ledger");

    expect(result.names).toContain('data-before-code');
    const matched = result.skills.find((s) => s.name === 'data-before-code');
    expect(matched?.category).toBe('prompt');
    expect(matched?.protected).toBe(false); // never fabricate a floor entry

    const bodies = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
      .map(([, init]) => String(init?.body ?? '')).join(' ');
    expect(bodies).not.toContain('Sam Doe');
  });

  it('re-categorises a floor skill in place, KEEPING protected:true', async () => {
    // A cross-harness probe (2026-08-02) observed data-before-code returning as
    // category:'prompt' with protected:true retained. That is the portal's
    // `existing.category = 'prompt'` mutation: it re-labels in place and never
    // touches `protected` or `priority`. A reimplementation that pushed a fresh
    // entry instead would look correct — the skill still "loads" — while
    // silently dropping out of the always-inline floor and overflowing to
    // name-only on a small budget. That is precisely the 2026-08-01 incident.
    //
    // Nothing here asserted it: the new-skill path is covered above (pushed
    // entries must be protected:false), and parity covers it only implicitly.
    // It took a live harness probe to see. This is the cheap version.
    mockEndpoints({
      resolve: {
        loaded: ['data-before-code'], skipped: [], routing_version: 26, tier: 'paid',
        skills: [{ name: 'data-before-code', priority: 5, protected: true, category: 'universal' }],
      },
      table: TEST_TABLE,
    });
    const result = await resolveSkills('synalux', 'the list is empty for her');

    expect(result.skills).toEqual([
      { name: 'data-before-code', priority: 5, protected: true, category: 'prompt' },
    ]);
    // Length pinned: a duplicate would leave the protected copy intact and pass
    // a naive .find() check while doubling the skill in the budget.
    expect(result.skills).toHaveLength(1);
  });

  it('withholds prompt-matched skills from free tier, matching portal gating', async () => {
    // resolve/route.ts: `const gated = tier === 'paid' ? resolved : []`. Local
    // matching must not hand back an entitlement the portal just withheld.
    mockEndpoints({
      resolve: { loaded: [], skipped: [], routing_version: 26, tier: 'free' },
      table: TEST_TABLE,
    });
    const result = await resolveSkills('synalux', "Sam Doe can't access their ledger");
    expect(result.names).toEqual([]);
  });

  it('swallows an invalid pattern and still applies the remaining rules', async () => {
    mockEndpoints({ resolve: PAID_RESP, table: TEST_TABLE });
    const result = await resolveSkills('synalux', 'the list is empty for her');
    expect(result.names).toContain('data-before-code');
    expect(result.names).not.toContain('never-reachable');
  });

  it('serves distinct prompts from ONE portal call (the per-prompt cache never hit)', async () => {
    mockEndpoints({ resolve: PAID_RESP, table: TEST_TABLE });
    const a = await resolveSkills('synalux', "she can't access the ledger");
    const b = await resolveSkills('synalux', 'fine-tune the corpus');
    const c = await resolveSkills('synalux', 'update the README');

    const resolveCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter(([url]) => String(url).includes('/api/v1/prism/resolve'));
    expect(resolveCalls).toHaveLength(1);
    // ...and routing still differs per prompt despite the shared cache entry.
    expect(a.names).toContain('data-before-code');
    expect(b.names).toContain('autonomous-training-protocol');
    expect(c.names).toEqual(['prime-directive']);
  });

  it('still routes on keywords when the portal is unreachable', async () => {
    // The incident case: the portal being down is exactly when a symptom-
    // triggered diagnostic skill matters most. Old behaviour returned nothing.
    const store: Record<string, string> = {
      'skill_cache:synalux': JSON.stringify(PAID_RESP),
      routing_keywords: JSON.stringify(TEST_TABLE),
    };
    _setStorage(async () => {}, async (k: string) => store[k] ?? '');
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await resolveSkills('synalux', 'no rows returned for that user');
    expect(result.isOffline).toBe(true);
    expect(result.names).toContain('data-before-code');
  });
});

// ── Native-context path (session_bootstrap) ──────────────────────────────────
// Two defects shipped here and were caught by a cross-harness probe, not by
// this suite: session_bootstrap sets includeSkillContent:false, which returns
// from sessionLoadContextHandler BEFORE resolveSkills — so the first turn, the
// entire point of the change, never routed on the prompt AND never wired
// storage, killing offline routing at the next restart.

describe('skill routing — native path (bootstrap)', () => {
  it('resolves matched names with NO portal call', async () => {
    mockEndpoints({ table: TEST_TABLE });
    const { resolvePromptSkillNames } = await import('../src/tools/skillRouting.js');
    const names = await resolvePromptSkillNames("she can't access the ledger");

    expect(names).toContain('data-before-code');
    const portalCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter(([url]) => String(url).includes('/api/v1/prism/resolve'));
    expect(portalCalls, 'bootstrap must not block on a portal round-trip').toHaveLength(0);
  });

  it('returns [] rather than guessing when the table is unavailable', async () => {
    mockEndpoints({}); // table 404s
    const { resolvePromptSkillNames } = await import('../src/tools/skillRouting.js');
    expect(await resolvePromptSkillNames('the list is empty for her')).toEqual([]);
  });

  it('returns [] for an absent or blank prompt', async () => {
    mockEndpoints({ table: TEST_TABLE });
    const { resolvePromptSkillNames } = await import('../src/tools/skillRouting.js');
    expect(await resolvePromptSkillNames('')).toEqual([]);
  });

  it('wires _setStorage BEFORE the native-context early return', () => {
    // Structural, because the defect has no behavioural surface in this suite:
    // the handler returns a text block either way. _setStorage sat below the
    // early return, so the keyword table was never persisted on the bootstrap
    // path and offline routing died at the next restart. Ordering IS the fix.
    const src = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/tools/ledgerHandlers.ts'),
      'utf8',
    );
    const wired = src.indexOf('_setStorage(');
    const earlyReturn = src.indexOf('if (!includeSkillContent) {');
    expect(wired, '_setStorage( not found').toBeGreaterThan(-1);
    expect(earlyReturn, 'native early return not found').toBeGreaterThan(-1);
    expect(wired, '_setStorage must be wired before the native early return')
      .toBeLessThan(earlyReturn);
  });

  it('carries the hint in the display SUFFIX so the cap cannot truncate it', () => {
    // Adversarial review of the first fix: capNativeStartupText truncates from
    // the END (text.slice(0, keepChars)), and the hint was the LAST append
    // before the return — so on a tight budget it was the first thing dropped,
    // silently. Bootstrap divides the budget across projects, so tight is
    // normal. That is the 2026-08-01 failure mode: the diagnostic skill absent
    // exactly when context is scarce. The cap reserves suffix length, so
    // carrying it there makes it unconditional.
    const src = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/tools/ledgerHandlers.ts'),
      'utf8',
    );
    expect(src, 'hint must not be appended to the truncatable body')
      .not.toMatch(/nativeContext \+=.*Symptom-triggered/);
    expect(src, 'hint must be passed as part of the reserved suffix')
      .toMatch(/symptomSkillSuffix \+ MEMORY_BOUNDARY_SUFFIX/);
    expect(src, 'name list must be bounded — the suffix is subtracted from the body budget')
      .toMatch(/slice\(0, MAX_SYMPTOM_SKILLS\)/);
  });

  it('INLINES the top matched skill body rather than pointing at it', () => {
    // Naming a skill is not delivering it. Bodies reach agents only as files
    // under the canonical root; hosts outside that mirror (Gemini) have no
    // path to the content and no MCP tool serves it. A live probe obeyed
    // `knowledge_search("data-before-code")` and got "No knowledge found",
    // then fell back to grepping source — three instruction rewrites all
    // failed on that same missing path. Inlining removes the indirection.
    const src = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/tools/ledgerHandlers.ts'),
      'utf8',
    );
    expect(src, 'must read the body, not reference it').toMatch(/readNativeSkillBody/);
    expect(src, 'must bound the inlined body').toMatch(/SYMPTOM_SKILL_INLINE_MAX/);
    expect(src, 'bound must scale with the display budget').toMatch(/SYMPTOM_SKILL_BUDGET_SHARE/);
    // The dead retrieval instruction must be gone, not merely supplemented.
    expect(src, 'knowledge_search does not serve skill bodies').not.toMatch(/knowledge_search\("\$\{/);
  });

  it('sizes the inlined rule against the ACTUAL budget, not the level constant', () => {
    // Adversarial review of the inline: the suffix is truncation-exempt (that
    // was the fix for the earlier silent-drop bug), so sizing it from
    // NATIVE_STARTUP_MAX_CHARS[level] let it exceed the whole allowance.
    // Bootstrap divides the budget across rendered projects, so a per-project
    // slice of 512 against an 1,800-char suffix produced a 1,919-char display
    // — 275% over — with the session context entirely gone. Measured, then
    // fixed: 512 in, 512 out, context retained.
    const src = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/tools/ledgerHandlers.ts'),
      'utf8',
    );
    expect(src, 'budget formula must be one function, not duplicated')
      .toMatch(/function effectiveNativeBudget/);
    expect(src, 'the cap must consume the real per-call budget')
      .toMatch(/effectiveNativeBudget\(level, options\.nativeMaxChars\)/);
    expect(src, 'capNativeStartupText must use the same helper')
      .toMatch(/const maxChars = effectiveNativeBudget\(level, requestedMaxChars\)/);
    expect(src, 'a too-tight budget must drop the body, not the context')
      .toMatch(/cap >= SYMPTOM_SKILL_INLINE_MIN/);
  });

  it('strips YAML frontmatter before inlining', () => {
    // ~161 chars of name/description/metadata on data-before-code — provenance
    // the agent does not need, taken straight out of the rule's budget. It is
    // what pushed the Anti-Patterns list past the cap and truncated it
    // mid-word on a live host. With it stripped the full rule fits.
    const src = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/tools/ledgerHandlers.ts'),
      'utf8',
    );
    expect(src).toMatch(/stripSkillFrontmatter/);
    expect(src, 'must apply the strip at the inline site')
      .toMatch(/stripSkillFrontmatter\(await readNativeSkillBody/);
    // Unterminated frontmatter must degrade to inlining as-is, never to "".
    expect(src, 'unterminated frontmatter must not blank the rule')
      .toMatch(/if \(end === -1\) return text/);
  });

  it('reads the body via the canonical resolver, never a hardcoded path', () => {
    // The skills root is overridable per caller and per home, so a literal
    // copied into this module is wrong on any machine that overrides either,
    // and drifts from the writer. skillManifestSync owns the path.
    const src = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/tools/ledgerHandlers.ts'),
      'utf8',
    );
    expect(src, 'no duplicated skills-root literal').not.toMatch(/"\.agents"\s*,\s*"skills"/);
    const sync = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/skillManifestSync.ts'),
      'utf8',
    );
    expect(sync).toMatch(/export function resolveCanonicalSkillsDir/);
    expect(sync, 'the writer must use the same resolver it exports')
      .toMatch(/const canonical = resolveCanonicalSkillsDir\(options\)/);
  });

  it('states an action the host can actually perform', () => {
    // v1 emitted a bare list nothing consumed. v2 said "read them before
    // proposing changes" — un-actionable on hosts that do not auto-load skill
    // files. A live Gemini probe proved it: the body was NOT in context, and
    // the agent could only produce it after calling knowledge_search. Naming
    // the retrieval step is what makes the instruction executable everywhere;
    // Claude Code auto-loads from ~/.claude/skills, Gemini has no such path.
    const src = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/tools/ledgerHandlers.ts'),
      'utf8',
    );
    // Match within a single string literal: the sentence is split across a
    // concatenation, so a phrase spanning the boundary never appears in source.
    expect(src).toMatch(/proposing any change/);
    // No retrieval instruction any more — the body is inlined, so there is
    // nothing to fetch. Asserting the imperative alone.
  });

  it('gives the native path a version to detect table drift against', () => {
    // Without an expectVersion the native path has no portal response to
    // compare to, so a stale cached table would persist undetected.
    const src = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/tools/ledgerHandlers.ts'),
      'utf8',
    );
    expect(src).toMatch(/skill_manifest:routing_version/);
    const routing = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/tools/skillRouting.ts'),
      'utf8',
    );
    expect(routing).toMatch(/fetchKeywordTable\(expectVersion\)/);
  });

  it('logs rather than silently swallowing a routing failure', () => {
    const src = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/tools/ledgerHandlers.ts'),
      'utf8',
    );
    expect(src).toMatch(/prompt routing skipped/);
  });

  it('gates the hint on entitlement, not on the public table', () => {
    // The public routing table lists names for EVERY tier, so matching it
    // alone would advertise skills the caller has no entitlement to. The
    // native path must intersect with entitledSkillNames.
    const src = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/tools/ledgerHandlers.ts'),
      'utf8',
    );
    // Window must cover the whole block; it is mostly comment, so keep it wide.
    const block = src.split('Symptom-triggered skills (on-device prompt routing)')[1]?.slice(0, 3000) ?? '';
    expect(block).toMatch(/resolvePromptSkillNames/);
    expect(block, 'matched names must be filtered by entitlement').toMatch(/entitledSkillNames\.has/);
  });
});

// ── Parity with the portal's resolver ────────────────────────────────────────

/**
 * Verbatim reference port of portal resolve/route.ts lines 143-184. If the
 * portal changes its resolution order, priority arithmetic, or dedup rules,
 * this reference drifts from production and the test below stops proving
 * anything — so portal/src/__tests__ pins the portal side against this file.
 */
function portalReference(
  table: { universal?: unknown[]; projects?: Record<string, unknown[]>; prompt_keywords?: Record<string, string[]> },
  project: string,
  prompt?: string,
): ResolvedSkill[] {
  const seen = new Set<string>();
  const resolved: ResolvedSkill[] = [];
  const universal = table.universal || [];
  for (let i = 0; i < universal.length; i++) {
    const e = universal[i] as { name: string; priority?: number; protected?: boolean } | string;
    const name = typeof e === 'string' ? e : e.name;
    const prio = typeof e === 'object' ? (e.priority ?? i) : i;
    const prot = typeof e === 'object' ? !!e.protected : false;
    if (!seen.has(name)) { seen.add(name); resolved.push({ name, priority: prio, protected: prot, category: 'universal' }); }
  }
  let pp = 100;
  for (const [pattern, skills] of Object.entries(table.projects || {})) {
    if (project.toLowerCase().includes(pattern)) {
      for (const s of skills as ({ name: string; priority?: number } | string)[]) {
        const name = typeof s === 'string' ? s : s.name;
        const prio = typeof s === 'object' ? (s.priority ?? pp) : pp;
        pp++;
        if (!seen.has(name)) { seen.add(name); resolved.push({ name, priority: prio, protected: false, category: 'project' }); }
      }
    }
  }
  if (prompt && table.prompt_keywords) {
    for (const [pattern, skills] of Object.entries(table.prompt_keywords)) {
      try {
        if (new RegExp(pattern, 'i').test(prompt)) {
          for (const skillName of skills) {
            const existing = resolved.find((s) => s.name === skillName);
            if (existing) existing.category = 'prompt';
            else if (!seen.has(skillName)) {
              seen.add(skillName);
              resolved.push({ name: skillName, priority: 200 + resolved.length, protected: false, category: 'prompt' });
            }
          }
        }
      } catch { /* portal swallows invalid patterns */ }
    }
  }
  resolved.sort((a, b) => a.priority - b.priority);
  return resolved;
}

const REAL_TABLE_PATH = process.env.PRISM_ROUTING_TABLE_PATH || path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  // Sibling checkout name assembled at runtime so the private repo name is
  // never a literal in this PUBLIC repo (same trick as scripts/sync-skills.sh).
  `../../${'synalux'}-private/portal/src/config/prism/skills-routing.json`,
);

const PARITY_PROMPTS = [
  "A serious regression: Sam Doe can't access their prism ledger. Their account is sam.doe@example.invalid.",
  'A customer says their invoice list is empty but they insist they have invoices.',
  'Users in workspace B cannot see any patients, workspace A is fine.',
  'no rows returned for that user',
  'her ledger is blank',
  'wrong rows showing up',
  'Refactor the billing reconciliation job and add unit tests.',
  'Update the README to document the new PRISM_STORAGE options.',
  'fix the TypeScript compile error',
  'deploy to production',
  'train a LoRA on the v2 corpus',
  'take a screenshot and verify the layout',
  '', // empty prompt must be a no-op
];

describe('skill routing — parity with portal resolver', () => {
  const available = existsSync(REAL_TABLE_PATH);
  if (!available) {
    it.skip(`REAL routing table not found at ${REAL_TABLE_PATH} — parity unproven`, () => {});
    console.warn(`[skill-routing] parity test SKIPPED: no table at ${REAL_TABLE_PATH}`);
  }

  it.runIf(available)('produces byte-identical output to the portal for every prompt', () => {
    const table = JSON.parse(readFileSync(REAL_TABLE_PATH, 'utf8'));
    expect(Object.keys(table.prompt_keywords || {}).length).toBeGreaterThan(0);

    for (const project of ['synalux', 'prism-coder', 'prism-aac', 'unrelated-repo']) {
      for (const prompt of PARITY_PROMPTS) {
        // Production composition: the portal resolves universal+project with
        // NO prompt, then we apply the keyword rules on-device.
        const base = portalReference(table, project, undefined);
        const local = _applyPromptRouting(base, prompt, table.prompt_keywords);
        const portal = portalReference(table, project, prompt);
        expect(local, `project=${project} prompt=${JSON.stringify(prompt)}`).toEqual(portal);
      }
    }
  });

  it.runIf(available)('parity holds for a prompt that matches nothing', () => {
    const table = JSON.parse(readFileSync(REAL_TABLE_PATH, 'utf8'));
    const base = portalReference(table, 'synalux', undefined);
    const local = _applyPromptRouting(base, 'zzz qqq', table.prompt_keywords);
    expect(local).toEqual(portalReference(table, 'synalux', 'zzz qqq'));
  });

  it('detects a divergent matcher (the parity test can actually fail)', () => {
    // Negative control: a matcher that gets the priority arithmetic wrong must
    // be caught. Without this, the parity assertions above could be vacuous.
    const table = { universal: [{ name: 'a', priority: 0, protected: true }], prompt_keywords: { widget: ['b'] } };
    const base = portalReference(table, 'p', undefined);
    const wrong = _applyPromptRouting(base, 'widget', { widget: ['b'] })
      .map((s) => ({ ...s, priority: s.priority + 1 }));
    expect(wrong).not.toEqual(portalReference(table, 'p', 'widget'));
  });
});

// ── Auth: PRISM_SKILLS_TOKEN precedence + synalux JWT fallback ───────────────
// The JWT path puts skill delivery on the same per-user identity as inference
// (fixes the enterprise-for-inference / free-for-skills split).
import { getSynaluxJwt, invalidateSynaluxJwt } from '../src/utils/synaluxJwt.js';

vi.mock('../src/utils/synaluxJwt.js', () => ({
  getSynaluxJwt: vi.fn(),
  invalidateSynaluxJwt: vi.fn(),
}));

function authHeaderOfCall(n = 0): string | undefined {
  const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[n];
  return (call[1]?.headers as Record<string, string>)?.['Authorization'];
}

describe('skill routing — auth', () => {
  const ORIGINAL_TOKEN = process.env.PRISM_SKILLS_TOKEN;

  beforeEach(() => {
    delete process.env.PRISM_SKILLS_TOKEN;
    vi.mocked(getSynaluxJwt).mockReset();
    vi.mocked(invalidateSynaluxJwt).mockReset();
  });

  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.PRISM_SKILLS_TOKEN;
    else process.env.PRISM_SKILLS_TOKEN = ORIGINAL_TOKEN;
  });

  it('uses static PRISM_SKILLS_TOKEN when set (JWT not consulted)', async () => {
    process.env.PRISM_SKILLS_TOKEN = 'static-token-abc';
    mockPortalResponse(PORTAL_RESP);
    await resolveSkillsForProject('prism-mcp');
    expect(authHeaderOfCall()).toBe('Bearer static-token-abc');
    expect(getSynaluxJwt).not.toHaveBeenCalled();
  });

  it('falls back to synalux JWT when no static token', async () => {
    vi.mocked(getSynaluxJwt).mockResolvedValue('jwt-xyz');
    mockPortalResponse(PORTAL_RESP);
    await resolveSkillsForProject('prism-mcp');
    expect(authHeaderOfCall()).toBe('Bearer jwt-xyz');
  });

  it('sends no Authorization when neither token nor key resolves (free tier preserved)', async () => {
    vi.mocked(getSynaluxJwt).mockResolvedValue(null);
    mockPortalResponse(PORTAL_RESP);
    await resolveSkillsForProject('prism-mcp');
    expect(authHeaderOfCall()).toBeUndefined();
  });

  it('does not treat configured credential failure as an anonymous free request', async () => {
    process.env.PRISM_SYNALUX_API_KEY = 'synalux_sk_configured';
    globalThis.fetch = vi.fn();
    vi.mocked(getSynaluxJwt).mockResolvedValue(null);
    const result = await resolveSkillsForProject('configured-auth-failure');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.isOffline).toBe(true);
    delete process.env.PRISM_SYNALUX_API_KEY;
  });

  it('on 401 with JWT: invalidates, re-exchanges, retries once', async () => {
    vi.mocked(getSynaluxJwt)
      .mockResolvedValueOnce('stale-jwt')
      .mockResolvedValueOnce('fresh-jwt');
    const unauthorized = { ok: false, status: 401, json: async () => ({}) } as Response;
    const success = { ok: true, status: 200, json: async () => PORTAL_RESP } as Response;
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(unauthorized)
      .mockResolvedValueOnce(success);

    const result = await resolveSkillsForProject('prism-mcp');
    expect(invalidateSynaluxJwt).toHaveBeenCalledOnce();
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    expect(authHeaderOfCall(1)).toBe('Bearer fresh-jwt');
    expect(result.isOffline).toBe(false);
  });

  it('on 401 with STATIC token: no retry loop (fails to offline path)', async () => {
    process.env.PRISM_SKILLS_TOKEN = 'revoked-token';
    const unauthorized = { ok: false, status: 401, json: async () => ({}) } as Response;
    globalThis.fetch = vi.fn().mockResolvedValue(unauthorized);
    const result = await resolveSkillsForProject('prism-mcp');
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect(invalidateSynaluxJwt).not.toHaveBeenCalled();
    expect(result.isOffline).toBe(true);
  });
});

// ── Host-rendered text must survive markdown/HTML display ───────────────────
// Shipped `knowledge_search("<skill name>")`; a real host rendered it as
// `knowledge_search("")` because the angle brackets were parsed as a tag. The
// instruction survived every unit test and every packaged-dist assertion —
// they all read source, and the defect only exists after rendering.
describe('emitted startup text carries no strippable placeholders', () => {
  it('the symptom-triggered block contains no <angle-bracket> placeholder', () => {
    const src = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/tools/ledgerHandlers.ts'),
      'utf8',
    );
    const block = src.split('Symptom-triggered skills (on-device prompt routing)')[1]?.slice(0, 3000) ?? '';
    // Comments legitimately quote the broken placeholder to explain it; only
    // real emitted code matters here.
    const code = block.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    // Do NOT try to parse the template literals: the emitted line nests them
    // (`...${x.map(n => `...`)}...`), and a naive /`([^`]*)`/ pairs the outer
    // opener with the inner opener, so the payload is never captured. That
    // exact bug made the first version of this guard pass while the broken
    // placeholder was present. Match the placeholder shape directly instead:
    // a quote immediately followed by `<` only happens in "<something>", never
    // in a TS generic.
    const placeholders = [...code.matchAll(/"<[^"]*>"/g)].map((m) => m[0]);
    expect(placeholders, `host renderers strip these: ${placeholders.join(", ")}`).toEqual([]);
    // (retrieval-call assertion removed: the body is inlined, not fetched)
  });
});

describe("keyword table — persisted-first (the route-prompt CLI is a fresh process per prompt)", () => {
  // Found in review round 4: the in-memory table cache is per-process, so the
  // hook CLI fetched the PUBLIC routing table over the network on EVERY user
  // prompt — measured 5.5s per prompt on a black-holed network, and zero
  // routing offline because no storage was wired. A persisted table whose
  // version equals the manifest-synced expectation must satisfy the resolver
  // with no network at all.
  it("routes offline from the persisted table when versions match", async () => {
    const { _setStorage, resolvePromptSkillNames } = await import("../src/tools/skillRouting.js");
    const table = JSON.stringify({ version: 99, prompt_keywords: { "\\bnot sticky\\b": ["visual-screenshot-verification"] } });
    _setStorage(async () => {}, async (key) => (key === "routing_keywords" ? table : ""));
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error("network must not be touched"); }) as never;
    try {
      const names = await resolvePromptSkillNames("the totals are not sticky", 99);
      expect(names).toContain("visual-screenshot-verification");
    } finally {
      globalThis.fetch = realFetch;
      _setStorage(null as never, null as never);
    }
  });
});
