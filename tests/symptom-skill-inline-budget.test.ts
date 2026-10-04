/**
 * A symptom-routed rule must arrive whole, or say plainly that it did not.
 *
 * Incident 2026-08-31 + adversarial review 2026-09-01. The review confirmed
 * the FIRST version of this file had the vacuous-test disease: SHARE was a
 * mirrored literal (production drift invisible), and the notice assertions
 * grepped SOURCE TEXT — a dead-code wrap around the branch passed every test.
 * This version reads every constant from source and executes the REAL
 * exported renderer, so both failures now red.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { formatSymptomSkillInline, capNativeStartupText, symptomChromeUpperBound, sliceCodepointSafe } from '../src/tools/ledgerHandlers.js';

const SOURCE = readFileSync(new URL('../src/tools/ledgerHandlers.ts', import.meta.url), 'utf8');

/** Every constant comes FROM SOURCE — a mirrored literal here would hide production drift. */
function num(name: string): number {
  const m = SOURCE.match(new RegExp(`const ${name} = ([0-9_.]+);`));
  if (!m) throw new Error(`${name} not found in ledgerHandlers.ts — constant renamed? update this test`);
  return Number(m[1]!.replace(/_/g, ''));
}
function depthBudget(depth: string): number {
  const m = SOURCE.match(new RegExp(`${depth}: ([0-9_]+),`));
  if (!m) throw new Error(`NATIVE_STARTUP_MAX_CHARS.${depth} not found`);
  return Number(m[1]!.replace(/_/g, ''));
}

const INLINE_MAX = num('SYMPTOM_SKILL_INLINE_MAX');
const SHARE = num('SYMPTOM_SKILL_BUDGET_SHARE');
const INLINE_MIN = num('SYMPTOM_SKILL_INLINE_MIN');


const capFor = (depth: string): number =>
  Math.min(INLINE_MAX, Math.floor(depthBudget(depth) * SHARE), Math.max(0, depthBudget(depth) - symptomChromeUpperBound('a-typical-skill-name')));

describe('budget arithmetic — every constant read from source', () => {
  it('the ceiling never binds below any depth share', () => {
    for (const depth of ['quick', 'standard', 'deep']) {
      const share = Math.floor(depthBudget(depth) * SHARE);
      expect(INLINE_MAX >= share, `${depth}: ceiling ${INLINE_MAX} clamps share ${share}`).toBe(true);
    }
  });

  it('deep depth carries a full dev-engineering-super-skill (8,863 chars)', () => {
    expect(capFor('deep')).toBeGreaterThanOrEqual(8_863);
  });

  it('the share itself is sane (drift guard: SHARE is read from source, not mirrored)', () => {
    expect(SHARE).toBeGreaterThan(0.1);
    expect(SHARE).toBeLessThanOrEqual(0.5);
    expect(INLINE_MIN).toBeGreaterThan(0);
  });

  it('the old 1,800 ceiling would fail the deep guarantee — the regression it replaces', () => {
    expect(Math.min(1_800, Math.floor(depthBudget('deep') * SHARE))).toBeLessThan(8_863);
  });
});

describe('formatSymptomSkillInline — the REAL renderer, executed', () => {
  const BODY = 'R'.repeat(5_000);

  it('delivers a fitting body whole, no notice', () => {
    const out = formatSymptomSkillInline('some-skill', BODY, 6_000);
    expect(out).toContain(BODY);
    expect(out).not.toContain('TRUNCATED');
  });

  it('states exactly how much is missing when it truncates', () => {
    const out = formatSymptomSkillInline('some-skill', BODY, 2_000);
    expect(out).toContain('showing 2000 of 5000 chars');
    expect(out).toContain('3000 chars of this rule are NOT shown above');
  });

  it('names the skill so a host without filesystem access can still load it', () => {
    const out = formatSymptomSkillInline('some-skill', BODY, 2_000);
    expect(out).toContain('Load the full skill by name (`some-skill`)');
    expect(out).toContain('do not treat the excerpt as the whole rule');
  });

  it('the offload path is an EXTRA route: present when given, absent when not', () => {
    expect(formatSymptomSkillInline('s', BODY, 100, '/tmp/x.md')).toContain('also saved at: /tmp/x.md');
    expect(formatSymptomSkillInline('s', BODY, 100)).not.toContain('saved at');
  });

  it('never emits the old uninformative marker', () => {
    const out = formatSymptomSkillInline('s', BODY, 100);
    expect(out).not.toContain('rule truncated to fit the startup budget');
  });
});

describe('routeOffload writer', () => {
  it('writes the full text and returns a readable path', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    // A scratch home, as in the tests below: without it every run left a
    // test-*.md file in the real ~/.prism-mcp/route-context.
    const home = mkdtempSync(join(tmpdir(), 'offload-write-'));
    const prev = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const { writeRouteOffload } = await import('../src/utils/routeOffload.js');
      const body = 'RULE-BODY-'.repeat(500);
      const p = writeRouteOffload(`# test-skill\n\n${body}`, 'test');
      expect(p).toBeTruthy();
      expect(p!.startsWith(join(home, '.prism-mcp', 'route-context'))).toBe(true);
      expect(existsSync(p!)).toBe(true);
      expect(readFileSync(p!, 'utf8')).toContain(body);
    } finally {
      if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
      if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
    }
  });

  it('never throws when the directory cannot be created', async () => {
    const { writeRouteOffload } = await import('../src/utils/routeOffload.js');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    // The unwritable "home" is a regular FILE, so mkdir under it fails with
    // ENOTDIR at once on every OS. The previous fixture, `/proc/nonexistent-
    // unwritable`, never returned on Linux: Node's recursive mkdirSync loops
    // forever when a path under /proc keeps answering ENOENT (reproduced in
    // node:20-alpine, killed by a 20s timeout), which hung "Run Unit Tests"
    // on both ubuntu CI legs for the full 6h job limit on every main run
    // from 523aac8d2 on. macOS and Windows have no /proc and failed fast.
    const home = join(mkdtempSync(join(tmpdir(), 'offload-unwritable-')), 'not-a-dir');
    writeFileSync(home, '');
    const prev = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      expect(writeRouteOffload('x', 'test')).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
      if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
    }
  });
});

describe('capNativeStartupText — the FINAL budget guarantee, executed', () => {
  // Review-confirmed: the old code returned marker+suffix UNCHECKED when the
  // suffix alone exceeded the budget, blowing past per-project caps at
  // divided multi-project bootstraps and recreating host-side truncation.
  it('never returns more than the requested budget, even for an oversized suffix', () => {
    const suffix = 'S'.repeat(13_000);
    for (const req of [700, 1_024, 4_000, 8_000]) {
      const out = capNativeStartupText('C'.repeat(5_000), 'deep', req, suffix);
      expect(out.length, `budget ${req} → got ${out.length}`).toBeLessThanOrEqual(req);
    }
  });

  it('a trimmed suffix says it was shortened and how to recover', () => {
    const out = capNativeStartupText('CTX'.repeat(200), 'deep', 1_024, 'S'.repeat(13_000));
    expect(out).toContain('shortened to fit');
    expect(out).toContain('load the skill by name');
  });

  it('fitting input is returned untouched', () => {
    const out = capNativeStartupText('short context', 'deep', 8_000, '\n--- x ---\nrule');
    expect(out).toBe('short context\n--- x ---\nrule');
  });
});

describe('round-2 review regressions', () => {
  it('chrome estimate is honest for EVERY allowed name length and a long offload path (property)', () => {
    const LONG_PATH = '/srv/example-home/.prism-mcp/route-context/' + 'x'.repeat(120) + '.md';
    for (const n of [3, 10, 40, 64, 100, 128]) {
      const name = 'n'.repeat(n);
      const body = 'B'.repeat(5_000);
      const cap = 1_000;
      const out = formatSymptomSkillInline(name, body, cap, LONG_PATH);
      const chrome = out.length - cap; // everything beyond the body excerpt
      expect(chrome, `name len ${n}: chrome ${chrome} vs bound ${symptomChromeUpperBound(name)}`)
        .toBeLessThanOrEqual(symptomChromeUpperBound(name));
    }
  });

  it('slicing never emits a lone surrogate', () => {
    const emoji = '💥'.repeat(50); // each is a surrogate pair
    for (let end = 0; end < 20; end++) {
      const cut = sliceCodepointSafe(emoji, end);
      const last = cut.charCodeAt(cut.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff, `end=${end} left a lone high surrogate`).toBe(false);
    }
    // and via the real cap path
    const out = capNativeStartupText(emoji, 'deep', 600, 'S'.repeat(1_000));
    expect(/[\ud800-\udbff]$/.test(out)).toBe(false);
  });
});

describe('routeOffload prune — round-2 coverage', () => {
  it('prunes stale files oldest-first across bounded calls', async () => {
    const { mkdtempSync, writeFileSync, utimesSync, readdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = mkdtempSync(join(tmpdir(), 'offload-'));
    // os.homedir() reads USERPROFILE on Windows and HOME elsewhere — setting
    // only HOME left the module writing under the real profile while the
    // test wrote its stale files under the temp dir, so every Windows CI leg
    // failed here with ENOENT on the first stale file.
    const prev = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const dir = join(home, '.prism-mcp', 'route-context');
      const { writeRouteOffload } = await import('../src/utils/routeOffload.js');
      writeRouteOffload('seed', 'test'); // creates dir
      const old = new Date(Date.now() - 30 * 86_400_000);
      for (let i = 0; i < 300; i++) {
        const f = join(dir, `route-0stale-${String(i).padStart(3, '0')}.md`);
        writeFileSync(f, 'x'); utimesSync(f, old, old);
      }
      writeRouteOffload('call-1', 'test');   // prunes ≤256 oldest
      writeRouteOffload('call-2', 'test');   // prunes the rest
      const left = readdirSync(dir).filter((f) => f.includes('0stale'));
      expect(left.length, `stale left after 2 bounded calls: ${left.length}`).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
      if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
    }
  });
});
