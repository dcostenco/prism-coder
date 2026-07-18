/**
 * Skill-delivery budgeting tests (local-first plan v2 Phase 1).
 * Policy: protected always inline; prompt-matched next; tail by priority;
 * overflow listed by name, never silently dropped.
 */
import { describe, it, expect } from 'vitest';
import { assembleSkillBlock, type SkillEntryForBudget } from '../src/utils/skillBudget.js';

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

  it('realistic v23 shape: 12 protected (real size spread) + 19 tail under the standard budget', () => {
    // Real v23 protected sizes (repo-measured, chars): floor totals ~36k —
    // deliberately larger than the 8,400-char skill tranche (60% of 14k).
    const protSizes = [2512, 2219, 5067, 1547, 1938, 2260, 1699, 2216, 7150, 3975, 4069, 1476];
    const entries: SkillEntryForBudget[] = protSizes.map((n, i) =>
      entry({ name: `prot${i}`, protected: true, priority: i, content: K(n) }));
    for (let i = 0; i < 19; i++) entries.push(entry({ name: `tail${i}`, priority: 100 + i, content: K(4000) }));
    const r = assembleSkillBlock(entries, 8400);
    expect(r.inlined.filter(n => n.startsWith('prot')).length).toBe(12); // floor holds over budget
    expect(r.inlined.filter(n => n.startsWith('tail')).length).toBe(0);  // tail waits for budget
    expect(r.overflow.length).toBe(19);                                  // flood prevented, all named
    expect(r.block.length).toBeLessThan(45_000);                         // vs 114KB unbudgeted
  });
});
