/**
 * Skill-delivery budgeting tests (local-first plan v2 Phase 1).
 * Policy: protected always inline; prompt-matched next; tail by priority;
 * overflow listed by name, never silently dropped.
 */
import { describe, it, expect } from 'vitest';
import {
  assembleSkillBlock,
  resolveSkillBudgetChars,
  DEFAULT_SKILL_BUDGET_CHARS,
  type SkillEntryForBudget,
} from '../src/utils/skillBudget.js';

const K = (n: number) => 'x'.repeat(n);

function entry(over: Partial<SkillEntryForBudget> & { name: string }): SkillEntryForBudget {
  return { content: K(100), protected: false, category: 'universal', priority: 50, ...over };
}

describe('assembleSkillBlock', () => {
  it('inlines everything when unbudgeted (legacy behavior)', () => {
    const r = assembleSkillBlock(
      [entry({ name: 'a' }), entry({ name: 'b' })], Number.POSITIVE_INFINITY);
    expect(r.inlined).toEqual(['a', 'b']);
    expect(r.overflow).toEqual([]);
    expect(r.block).toContain('[📜 SKILL: a]');
  });

  it('protected skills inline even when the budget is already blown', () => {
    const r = assembleSkillBlock([
      entry({ name: 'prime', protected: true, priority: 0, content: K(500) }),
      entry({ name: 'evidence', protected: true, priority: 2, content: K(500) }),
      entry({ name: 'tail', priority: 30, content: K(500) }),
    ], 100); // budget smaller than one protected skill
    expect(r.inlined).toEqual(['prime', 'evidence']);
    expect(r.overflow).toEqual(['tail']);
  });

  it('prompt-category skills outrank unprotected universal tail', () => {
    const r = assembleSkillBlock([
      entry({ name: 'tail-early', priority: 10, content: K(400) }),
      entry({ name: 'matched-this-prompt', category: 'prompt', priority: 200, content: K(400) }),
    ], 500); // room for exactly one
    expect(r.inlined).toEqual(['matched-this-prompt']);
    expect(r.overflow).toEqual(['tail-early']);
  });

  it('fills the tail in priority order within budget', () => {
    const r = assembleSkillBlock([
      entry({ name: 'p30', priority: 30, content: K(300) }),
      entry({ name: 'p10', priority: 10, content: K(300) }),
      entry({ name: 'p20', priority: 20, content: K(300) }),
    ], 700); // room for two
    expect(r.inlined).toEqual(['p10', 'p20']);
    expect(r.overflow).toEqual(['p30']);
  });

  it('overflow manifest names every skipped skill with the load-on-demand hint', () => {
    const r = assembleSkillBlock([
      entry({ name: 'kept', protected: true }),
      entry({ name: 'skipped-one', content: K(1000) }),
      entry({ name: 'skipped-two', content: K(1000) }),
    ], 200);
    expect(r.block).toContain('SKILLS NOT INLINED');
    // The overflow manifest is an INSTRUCTION, not metadata. The 2026-08-11
    // incident: verified-shipping sat name-only in this list while an agent
    // claimed UI fixes it never rendered — the passive wording invited
    // skipping. The message must bind the agent to consult the governing
    // skill before completion claims, and must name the mechanism.
    expect(r.block).toContain('RULES YOU ARE BOUND BY');
    expect(r.block).toContain('before any completion claim');
    expect(r.block).toContain('Skill tool');
    expect(r.block).toContain('skipped-one, skipped-two');
    expect(r.block).toContain('re-call session_load_context with a higher max_tokens');
  });

  it('role skill renders with its own label and precedes the plain tail', () => {
    const r = assembleSkillBlock([
      entry({ name: 'tail', priority: 5, content: K(300) }),
      entry({ name: 'bcba', category: 'role', priority: -1, content: K(300) }),
    ], 450);
    expect(r.block).toContain('[📜 ROLE SKILL: bcba]');
    expect(r.inlined).toEqual(['bcba', 'tail'].slice(0, r.inlined.length));
    expect(r.inlined[0]).toBe('bcba');
  });

  it('realistic v26 shape: 13 protected (real size spread) + 19 tail under the standard budget', () => {
    // Real v26 protected sizes (repo-measured, chars): floor stays below 39k —
    // deliberately larger than the 8,400-char skill tranche (60% of 14k).
    const protSizes = [2513, 2173, 5000, 1619, 1462, 2092, 1896, 1683, 2186, 7066, 3913, 3354, 4035];
    const entries: SkillEntryForBudget[] = protSizes.map((n, i) =>
      entry({ name: `prot${i}`, protected: true, priority: i, content: K(n) }));
    for (let i = 0; i < 19; i++) entries.push(entry({ name: `tail${i}`, priority: 100 + i, content: K(4000) }));
    const r = assembleSkillBlock(entries, 8400);
    expect(r.inlined.filter(n => n.startsWith('prot')).length).toBe(13); // floor holds over budget
    // The tranche is ADDITIVE on top of the floor. This assertion previously
    // expected 0 — pinning the bug as intent: the floor debited the budget, so
    // with floor > tranche NOTHING unprotected ever inlined, at any level,
    // for anyone. 8,400 chars buys exactly two 4K tail skills.
    expect(r.inlined.filter(n => n.startsWith('tail')).length).toBe(2);
    expect(r.overflow.length).toBe(17);                                  // flood prevented, all named
    expect(r.block.length).toBeLessThan(52_000);                         // floor + tranche + manifest
  });

  it('INCIDENT 2026-08-11: a prompt-matched skill inlines even when the floor alone exceeds the budget', () => {
    // An agent shipped unverified UI claims while verified-shipping — prompt-
    // matched for its task — sat name-only in overflow. Routing gave it rank;
    // the accounting bug made rank irrelevant. This is the shape that must
    // never regress: floor 39K, budget 8,400, one prompt-matched 4.6K skill.
    const protSizes = [2513, 2173, 5000, 1619, 1462, 2092, 1896, 1683, 2186, 7066, 3913, 3354, 4035];
    const entries: SkillEntryForBudget[] = protSizes.map((n, i) =>
      entry({ name: `prot${i}`, protected: true, priority: i, content: K(n) }));
    entries.push(entry({ name: 'verified-shipping', category: 'prompt', priority: 200, content: K(4600) }));
    for (let i = 0; i < 19; i++) entries.push(entry({ name: `tail${i}`, priority: 100 + i, content: K(4000) }));
    const r = assembleSkillBlock(entries, 8400);
    expect(r.inlined).toContain('verified-shipping');       // the DoD checklist arrives
    expect(r.block).toContain('[📜 SKILL: verified-shipping]');
    expect(r.overflow).not.toContain('verified-shipping');
    // Prompt category outranks tail: the matched skill spends first.
    expect(r.inlined.filter(n => n.startsWith('tail')).length).toBeLessThanOrEqual(1);
  });
});

/**
 * 2026-08-01 regression: resolveSkillBudgetChars previously returned
 * POSITIVE_INFINITY whenever max_tokens was absent — the documented default,
 * and therefore the common call shape. Routing v25 (76 -> 95 skills) then grew
 * the unbudgeted block to 91,578 chars, past the host tool-result cap, and the
 * host diverted the WHOLE response to a file: the agent got no context at all.
 */
describe('resolveSkillBudgetChars', () => {
  const LEVELS = ['quick', 'standard', 'deep'] as const;

  it.each(LEVELS)('is finite and budgeted for %s with no max_tokens', (level) => {
    const budget = resolveSkillBudgetChars(undefined, level);

    expect(Number.isFinite(budget)).toBe(true);
    expect(budget).toBeGreaterThan(0);
  });

  it.each(LEVELS)('never returns a value assembleSkillBlock treats as unbudgeted (%s)', (level) => {
    // The contract coupling that matters: assembleSkillBlock reads <= 0 and
    // non-finite as "inline everything", so either would silently restore the
    // incident while still looking like a configured number.
    const budget = resolveSkillBudgetChars(undefined, level);
    const oversized = { content: 'y'.repeat(budget + 5_000), protected: false } as const;

    const r = assembleSkillBlock([
      entry({ name: 'fits', content: 'x'.repeat(10) }),
      entry({ name: 'huge', ...oversized }),
    ], budget);

    expect(r.overflow).toContain('huge');
    expect(r.block).toContain('SKILLS NOT INLINED');
  });

  it('gives quick a materially smaller tranche than standard or deep', () => {
    // `quick` is chosen to minimize context; before the fix `level` gated only
    // the memory portion, so quick still inlined the full skill payload.
    const quick = resolveSkillBudgetChars(undefined, 'quick');

    expect(quick).toBeLessThan(resolveSkillBudgetChars(undefined, 'standard'));
    expect(resolveSkillBudgetChars(undefined, 'standard'))
      .toBeLessThan(resolveSkillBudgetChars(undefined, 'deep'));
  });

  it('keeps the default well under the ~25k-token host cap', () => {
    // 3.5 chars/token heuristic; the diverted response was 91,578 chars. The
    // skill tranche alone must leave room for briefing, handoff and history.
    for (const level of LEVELS) {
      expect(resolveSkillBudgetChars(undefined, level)).toBeLessThan(50_000);
    }
  });

  it('still honors an explicit max_tokens at 60% of the allowance', () => {
    // Explicit callers keep the old arithmetic; only the default changed.
    expect(resolveSkillBudgetChars(10_000, 'standard')).toBe(Math.floor(10_000 * 3.5 * 0.6));
  });

  it('falls back to the standard tranche for a non-positive or junk max_tokens', () => {
    expect(resolveSkillBudgetChars(0, 'standard')).toBe(DEFAULT_SKILL_BUDGET_CHARS.standard);
    expect(resolveSkillBudgetChars(-1, 'standard')).toBe(DEFAULT_SKILL_BUDGET_CHARS.standard);
    expect(resolveSkillBudgetChars(Number.NaN, 'standard')).toBe(DEFAULT_SKILL_BUDGET_CHARS.standard);
    expect(resolveSkillBudgetChars(Number.POSITIVE_INFINITY, 'standard'))
      .toBe(DEFAULT_SKILL_BUDGET_CHARS.standard);
  });
});
