/**
 * Pasted evidence must not activate skills.
 *
 * Incident 2026-08-31: the user asked "whats going on with skill loading:" and
 * pasted a Prism startup log as evidence. That log LISTS installed skill names,
 * and the literal token `acme-xyz-billing` in it satisfied that skill's own
 * trigger `\bacme\b.{0,20}\b(billing|invoice)\b`. Two unrelated private skills
 * were loaded and injected as binding rules for a debugging question.
 *
 * The rule this pins: a skill NAME appearing in a prompt is metadata about the
 * system, not a description of work. Symptom words the user actually types must
 * still route — that is the other half, and the regression risk of the fix.
 */
import { describe, it, expect } from 'vitest';
import {
  _applyPromptRouting,
  stripQuotedEvidenceForRouting,
  resolvePromptSkillNames,
} from '../src/tools/skillRouting.js';

/** The real triggers from the two skills that misfired. */
const TRIGGERS: Record<string, string[]> = {
  '\\bacme\\b.{0,20}\\b(billing|invoice)\\b': ['acme-xyz-billing'],
  '\\bxyz\\b.{0,20}\\bbilling\\b': ['acme-xyz-billing'],
  '\\b(training|corpus|bfcl)\\b.{0,24}\\b(score|gate|promote)\\b': ['training-results-gate'],
};

const route = (prompt: string): string[] =>
  _applyPromptRouting([], stripQuotedEvidenceForRouting(prompt, TRIGGERS), TRIGGERS).map((s) => s.name);

/** Verbatim shape of the pasted startup log from the incident. */
const PASTED_LOG = `whats going on with skill loading: here is the agent log

Prism System Ready
- Subscription tier: enterprise
- Provisioned skills: 118
- Skill sync: automatic from Synalux · current · committed manifest · 1 conflict
⚠️ SKILLS NOT UPDATING (local copy has no Prism ownership marker): acme-xyz-billing.
Other tier skills provisioned: execute-method-literally, prompt-fidelity,
training-results-gate, autonomous-training-protocol, verified-shipping`;

describe('pasted evidence does not activate skills', () => {
  it('the exact incident prompt routes NOTHING', () => {
    expect(route(PASTED_LOG)).toEqual([]);
  });

  it('a bare skill name never triggers its own skill', () => {
    expect(route('why is acme-xyz-billing frozen?')).toEqual([]);
    expect(route('what does training-results-gate do?')).toEqual([]);
  });

  it('fenced output is ignored even when it contains trigger words', () => {
    const prompt = 'why did this fail?\n```\nxyz billing invoice submitted\n```';
    expect(route(prompt)).toEqual([]);
  });

  it('review: stripping must not BRIDGE unrelated words into a proximity window', () => {
    // Raw prompt: 'acme <28-char name token> invoice' — 'acme' and 'invoice'
    // are >20 chars apart, so \bacme\b.{0,20}\b(billing|invoice)\b does NOT
    // match the raw text. Replacing the name with a SPACE brought them within
    // the window and CREATED a match (adversarial review, reproduced). The
    // newline replacement severs the window instead: still no match.
    const LONG = 'acme-xyz-billing-extra-longer';
    const triggers = { ...TRIGGERS, ['\\bacme\\b.{0,20}\\b(billing|invoice)\\b']: ['acme-xyz-billing'] };
    const prompt = `acme ${LONG} invoice`;
    const withLong = { ...triggers, x: ['x'] } as Record<string, string[]>;
    withLong['zz'] = [LONG]; // make the long token itself routable → stripped
    const names = _applyPromptRouting([], stripQuotedEvidenceForRouting(prompt, withLong), withLong).map(s => s.name);
    expect(names).not.toContain('acme-xyz-billing');
  });

  it('review: two INLINE backtick-triples must not eat user-typed symptom text', () => {
    // Only line-anchored fences are pasted blocks. Inline pairs in prose used
    // to bracket-and-delete everything between them (adversarial review).
    const prompt = 'my ``` markers ``` are decoration, but my acme billing invoice is broken';
    expect(route(prompt)).toContain('acme-xyz-billing');
  });

  it('review: hostile or overlong routable names degrade to not-stripped, never a throw', () => {
    const hostile: Record<string, string[]> = {
      ...TRIGGERS,
      aa: ['x'.repeat(500)],                 // overlong — skipped by bound
      bb: ['bad[skill-name'],                // unterminated class — raw RegExp() THROWS
    };
    expect(() => stripQuotedEvidenceForRouting('any prompt at all', hostile)).not.toThrow();
    // and routing still works for the legit triggers
    const names = _applyPromptRouting([], stripQuotedEvidenceForRouting('my acme billing invoice', hostile), hostile).map(s => s.name);
    expect(names).toContain('acme-xyz-billing');
  });
});

describe('real symptoms still route — the regression risk of the fix', () => {
  it('user-typed symptom words match, because they are not name tokens', () => {
    expect(route('I need to submit the acme billing invoice')).toContain('acme-xyz-billing');
    expect(route('help me with a xyz billing question')).toContain('acme-xyz-billing');
    expect(route('did the training corpus score pass the gate?')).toContain('training-results-gate');
  });

  it('BY DESIGN: a typed bare name does not trigger-route — the agent reads the name directly', () => {
    // Adversarial review flagged this as a regression; it is a documented
    // trade-off instead: trigger routing exists for SYMPTOM text where no
    // name appears. When the user types the literal name, the agent sees it
    // in the raw prompt and can invoke the skill by name — no routing needed.
    // Pasted logs naming skills must not route them; that wins.
    expect(route('update acme-xyz-billing with the new invoice rate')).toEqual([]);
  });

  it('stripping removes only the NAME SPAN, leaving its words usable elsewhere', () => {
    // The name is stripped, but the same words typed separately still match.
    const prompt = 'the acme-xyz-billing skill is stale, but my acme billing invoice is due';
    expect(route(prompt)).toContain('acme-xyz-billing');
  });

  it('ordinary hyphenated English is not mistaken for a skill name', () => {
    for (const phrase of ['end-to-end', 're-test the flow', 'well-formed input', 'up-to-date']) {
      expect(stripQuotedEvidenceForRouting(phrase, TRIGGERS)).toContain(phrase.split(' ')[0]);
    }
  });

  it('does not truncate: a symptom stated late in a long prompt still matches', () => {
    const prompt = `${'context. '.repeat(400)}now: my acme billing invoice is wrong`;
    expect(route(prompt)).toContain('acme-xyz-billing');
  });
});

describe('round-2 review regressions', () => {
  it('\\s-glued windows are severed too — the real-table bridging repro', () => {
    // 34/58 live patterns glue words with \s* (e.g. \bui\s*test\b). \n IS \s,
    // so the round-1 newline replacement did NOT sever them: stripping a name
    // from 'ui <name> test' routed xcuitest-ios-watch. The \x1F in the
    // separator is non-space, so \s runs cannot span it.
    const t: Record<string, string[]> = {
      '\\bui\\s*test\\b': ['xcuitest-ios-watch'],
      zz: ['gh-fix-ci'],
    };
    const stripped = stripQuotedEvidenceForRouting('ui gh-fix-ci test', t);
    const names = _applyPromptRouting([], stripped, t).map((s) => s.name);
    expect(names).not.toContain('xcuitest-ios-watch');
    // and a REAL adjacent mention still matches
    const names2 = _applyPromptRouting([], stripQuotedEvidenceForRouting('run the ui test now', t), t).map((s) => s.name);
    expect(names2).toContain('xcuitest-ios-watch');
  });

  it('non-string entries in a corrupted table never throw (null lands in sort)', () => {
    const corrupt = { a: ['legit-name', null, undefined, 42, {}], b: 'not-an-array' } as never;
    expect(() => stripQuotedEvidenceForRouting('any prompt', corrupt)).not.toThrow();
  });

  it('a whitespace-only "name" does not rewrite prompt formatting', () => {
    const t = { a: ['   '] } as Record<string, string[]>;
    const input = 'line one\n   indented code line\nmore   spaced   text';
    expect(stripQuotedEvidenceForRouting(input, t)).toBe(input);
  });
});

describe('round-3 review regressions', () => {
  it('a skill named by an ORDINARY WORD keeps its own natural-language trigger', () => {
    // Round-3 review: unconditional stripping killed sentry/linear/pdf/supabase
    // routing 100% — the strip ate the very word their triggers need. Only
    // identifier-shaped (multi-segment) names are evidence-strippable.
    const t: Record<string, string[]> = {
      '\\bsentry\\b': ['sentry'],
      '\\blinear\\b.*\\b(issue|ticket|board)\\b': ['linear'],
    };
    expect(_applyPromptRouting([], stripQuotedEvidenceForRouting('check sentry for recent errors', t), t).map(x=>x.name))
      .toContain('sentry');
    expect(_applyPromptRouting([], stripQuotedEvidenceForRouting('create a linear ticket for this bug', t), t).map(x=>x.name))
      .toContain('linear');
  });

  it('anchoring is SEGMENT-aligned: mid-token overlaps survive, standalone names are stripped', () => {
    const t: Record<string, string[]> = { zz: ['fix-ci'] };
    // Round-4 UPDATE: this test originally asserted 'prefix-fix-ci-suffix'
    // survives whole — round-4 review proved that behavior recreated the
    // incident (\b fires at internal hyphens, so an unstripped compound
    // still satisfies the skill's trigger). Segment-aligned occurrences in
    // compounds are now stripped; what must survive is a MID-TOKEN overlap:
    // 'prefix-ci' contains the characters 'fix-ci' but not on a segment edge.
    expect(stripQuotedEvidenceForRouting('the prefix-ci pipeline here', t)).toContain('prefix-ci');
    expect(stripQuotedEvidenceForRouting('see prefix-fix-ci-suffix here', t)).not.toContain('fix-ci-suffix');
    // standalone occurrence IS stripped
    expect(stripQuotedEvidenceForRouting('see fix-ci here', t)).not.toContain('fix-ci');
  });

  it('resolvePromptSkillNames never throws on corrupted scopedTriggers', async () => {
    for (const bad of [{ a: null }, { a: undefined }, { a: 42 }, { a: {} }, { a: 'x' }, { a: [[]] }] as never[]) {
      const names = await resolvePromptSkillNames('any prompt at all', undefined, bad);
      expect(Array.isArray(names)).toBe(true);
      for (const n of names) expect(typeof n).toBe('string');
    }
  });
});

describe('round-4 review regressions', () => {
  it('a name inside a longer COMPOUND identifier still cannot route its skill', () => {
    // Round-4 HIGH: round 3's (?<![\w-]) anchors refused to strip the name
    // out of container/pod/schema compounds, and \b fires at every internal
    // hyphen, so the trigger matched INSIDE the unstripped compound — the
    // exact incident class this suite exists to prevent. All three repros
    // from the review, end-to-end through the matcher:
    expect(route('deploy failed for acme-xyz-billing-worker container, see logs')).toEqual([]);
    expect(route('legacy-acme-xyz-billing schema still referenced in prod')).toEqual([]);
    expect(route('CrashLoopBackOff: pod acme-xyz-billing-7d8f9c-abcde restarting')).toEqual([]);
  });

  it('a mid-token overlap never kills an UNRELATED skill trigger', () => {
    // The reason anchors exist at all: name 'fix-ci' appears as a character
    // substring of the unrelated word 'prefix-ci' (pre+fix-ci) but not on a
    // segment edge. Stripping it would sever 'prefix-ci' and kill that
    // skill's own trigger — the round-3 bare-name failure in new clothes.
    const t: Record<string, string[]> = {
      zz: ['fix-ci'],
      '\\bprefix-ci\\b': ['prefix-ci-skill'],
    };
    expect(_applyPromptRouting([], stripQuotedEvidenceForRouting('the prefix-ci build is broken', t), t).map(x => x.name))
      .toContain('prefix-ci-skill');
  });

  it('prototype-named scoped patterns neither throw nor pollute', async () => {
    // Round-4 HIGH: with a plain-object merge, a pattern key of
    // '__proto__'/'constructor'/'toString' read the INHERITED value (truthy,
    // not iterable → uncaught throw → silent loss of ALL routing) or invoked
    // the prototype setter. Null-prototype merge makes both plain data ops.
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const scoped: Record<string, string[]> = {};
      Object.defineProperty(scoped, key, {
        value: ['evil-skill'], enumerable: true, writable: true, configurable: true,
      });
      const names = await resolvePromptSkillNames('check sentry for errors', undefined, scoped);
      expect(Array.isArray(names)).toBe(true);
      for (const n of names) expect(typeof n).toBe('string');
    }
    // No Object.prototype pollution escaped the call.
    expect(({} as Record<string, unknown>)['evil-skill']).toBeUndefined();
    expect(Object.prototype.constructor).toBe(Object);
  });

  it('a corrupt PUBLIC table value is dropped at ingest, never char-iterated', async () => {
    // Round-4 LOW: isKeywordTable only proves prompt_keywords is an object;
    // a string value reached the matcher, whose for..of iterated it CHARACTER
    // BY CHARACTER — resolvePromptSkillNames returned six bogus one-letter
    // "skills" for {'\\bbaz\\b': 'notarray'}. Sanitized at ingest now: the
    // corrupt pattern is dropped, well-formed siblings keep routing.
    const { _setStorage, _invalidateRoutingCache } = await import('../src/tools/skillRouting.js');
    const stored = new Map<string, string>();
    stored.set('routing_keywords', JSON.stringify({
      version: 999_001,
      prompt_keywords: {
        '\\bbaz\\b': 'notarray',
        '\\bqux\\b': ['real-skill'],
        '\\bmixed\\b': ['ok-skill', 42, null],
      },
    }));
    _invalidateRoutingCache();
    _setStorage(async () => {}, async (k: string) => stored.get(k) ?? '');
    try {
      const names = await resolvePromptSkillNames('baz qux mixed', 999_001);
      expect(names).toContain('real-skill');
      expect(names).toContain('ok-skill');
      for (const n of names) expect(n.length).toBeGreaterThan(1);
    } finally {
      _setStorage(null, null);
      _invalidateRoutingCache();
    }
  });
});

describe('stripQuotedEvidenceForRouting mechanics', () => {
  it('removes fenced blocks and identifier-shaped tokens only', () => {
    // Updated after review: INLINE pairs are prose decoration and must NOT be
    // eaten (that deleted real symptom text); only LINE-ANCHORED fences are
    // pasted blocks.
    expect(stripQuotedEvidenceForRouting('a ```x``` b', TRIGGERS)).toContain('x');
    expect(stripQuotedEvidenceForRouting('before\n```\nBLOCK-CONTENT\n```\nafter', TRIGGERS)).not.toContain('BLOCK-CONTENT');
    expect(stripQuotedEvidenceForRouting('see acme-xyz-billing here', TRIGGERS)).not.toContain('acme-xyz-billing');
    expect(stripQuotedEvidenceForRouting('plain words stay', TRIGGERS)).toBe('plain words stay');
    // A skill name NOT in the table is left alone — we only strip what we route.
    expect(stripQuotedEvidenceForRouting('about some-other-skill', TRIGGERS)).toContain('some-other-skill');
  });
});

describe('WIRING — second production call site (toResolvedSkillsWithPrompt)', () => {
  // The review confirmed the first wiring test covered only ONE of the two
  // call sites; reverting the other went undetected. This drives the portal-
  // response path with a paid tier so _applyPromptRouting runs there too.
  it('the incident prompt adds no prompt-category skills on the portal path', async () => {
    const { _toResolvedSkillsWithPrompt: toResolvedSkillsWithPrompt, _setStorage } = await import('../src/tools/skillRouting.js');
    _setStorage(
      async () => {},
      async (key: string) => key.includes('keyword')
        ? JSON.stringify({ version: 1, prompt_keywords: TRIGGERS, universal: [], projects: {}, user_local: { enabled: false, key_prefix: 'u:' } })
        : '',
    );
    const resp = { loaded: ['prime-directive'], skipped: [], routing_version: 1, tier: 'paid' } as never;
    const resolved = await toResolvedSkillsWithPrompt(resp, PASTED_LOG, true);
    expect(resolved.names).not.toContain('acme-xyz-billing');
    expect(resolved.names).not.toContain('training-results-gate');
    const typed = await toResolvedSkillsWithPrompt(resp, 'my acme billing invoice is broken', true);
    expect(typed.names).toContain('acme-xyz-billing');
  });
});

describe('WIRING — the real routing entry point, not just the helper', () => {
  // The helper tests above pass even if nobody CALLS the helper. This block is
  // the one that fails when the call sites regress: it goes through the public
  // resolvePromptSkillNames() path, which is what session_bootstrap uses.
  // (Mutation-verified: reverting either call site reds these.)
  it('the incident prompt resolves to NO skills through the real entry point', async () => {
    const names = await resolvePromptSkillNames(PASTED_LOG, undefined, TRIGGERS);
    expect(names).not.toContain('acme-xyz-billing');
    expect(names).not.toContain('training-results-gate');
  });

  it('a genuinely typed symptom still resolves through the real entry point', async () => {
    const names = await resolvePromptSkillNames(
      'I need to submit the acme billing invoice', undefined, TRIGGERS);
    expect(names).toContain('acme-xyz-billing');
  });
});
