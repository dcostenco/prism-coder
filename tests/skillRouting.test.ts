import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  resolveSkillsForProject,
  resolveSkillsForPrompt,
  _invalidateRoutingCache,
  _OFFLINE_FALLBACK,
  type SkillRoutingTable,
} from '../src/tools/skillRouting';

// Mock fetch to return a test routing table
const TEST_TABLE: SkillRoutingTable = {
  version: 4,
  universal: ['bcba_ai_assistant', 'verified-shipping'],
  projects: {
    'prism-aac': ['i18n-tts', 'playwright-watchdog'],
    'prismcoach': ['xcode-simulator-cycle', 'xcuitest-ios-watch', 'ios-rejection-fix'],
    'synalux': ['synalux-customers'],
  },
  prompt_keywords: {
    'xcode|build|compile|typecheck|swift|simulator': ['xcode-simulator-cycle'],
    'test|e2e|xcuitest|xctest|run tests': ['xcuitest-ios-watch'],
    'reject|app.review|guideline|1\\.4\\.1|2\\.1\\.0': ['ios-rejection-fix'],
    'submit|app.store|asc|testflight': ['asc-ios-submission'],
    'train|fine.tune|bfcl|lora|corpus': ['autonomous-training-protocol'],
    'translat|i18n|tts|voice|speech': ['auto-i18n'],
    'bcba|aba|fba|bip|behavior.plan': ['bcba_ai_assistant'],
    'supabase|rls|migration': ['supabase'],
  },
  user_local: { enabled: false, key_prefix: 'user_skill:' },
};

beforeEach(() => {
  _invalidateRoutingCache();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(TEST_TABLE),
  }));
});

// ── Project-based routing ───────────────────────────────────────────

describe('resolveSkillsForProject', () => {
  it('returns universal skills for unknown project', async () => {
    const result = await resolveSkillsForProject('unknown-project');
    expect(result.names).toContain('bcba_ai_assistant');
    expect(result.names).toContain('verified-shipping');
  });

  it('returns universal + project skills for prismcoach', async () => {
    const result = await resolveSkillsForProject('prismcoach');
    expect(result.names).toContain('bcba_ai_assistant');
    expect(result.names).toContain('xcode-simulator-cycle');
    expect(result.names).toContain('xcuitest-ios-watch');
    expect(result.names).toContain('ios-rejection-fix');
  });

  it('matches project by substring (case-insensitive)', async () => {
    const result = await resolveSkillsForProject('my-prism-aac-fork');
    expect(result.names).toContain('i18n-tts');
    expect(result.names).toContain('playwright-watchdog');
  });

  it('deduplicates skills across universal + project', async () => {
    const result = await resolveSkillsForProject('prismcoach');
    const counts = result.names.reduce((acc, n) => {
      acc[n] = (acc[n] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    for (const [name, count] of Object.entries(counts)) {
      expect(count, `${name} appears ${count} times`).toBe(1);
    }
  });

  it('falls back to offline default when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    _invalidateRoutingCache();
    const result = await resolveSkillsForProject('anything');
    expect(result.names).toEqual(_OFFLINE_FALLBACK.universal);
  });
});

// ── Prompt-based keyword routing ────────────────────────────────────

describe('resolveSkillsForPrompt', () => {
  it('returns empty for unmatched prompt', async () => {
    const result = await resolveSkillsForPrompt('hello world');
    expect(result).toEqual([]);
  });

  it('matches xcode/build keywords', async () => {
    const result = await resolveSkillsForPrompt('build the app for simulator');
    expect(result).toContain('xcode-simulator-cycle');
  });

  it('matches test keywords', async () => {
    const result = await resolveSkillsForPrompt('run tests on the emulator');
    expect(result).toContain('xcuitest-ios-watch');
  });

  it('matches rejection keywords', async () => {
    const result = await resolveSkillsForPrompt('app was rejected for guideline 2.1.0');
    expect(result).toContain('ios-rejection-fix');
  });

  it('matches submit/ASC keywords', async () => {
    const result = await resolveSkillsForPrompt('submit to app store');
    expect(result).toContain('asc-ios-submission');
  });

  it('matches training keywords', async () => {
    const result = await resolveSkillsForPrompt('fine tune the model with BFCL');
    expect(result).toContain('autonomous-training-protocol');
  });

  it('matches i18n/voice keywords', async () => {
    const result = await resolveSkillsForPrompt('fix the TTS voice for Polish');
    expect(result).toContain('auto-i18n');
  });

  it('matches multiple skills from one prompt', async () => {
    const result = await resolveSkillsForPrompt('build and run tests on simulator');
    expect(result).toContain('xcode-simulator-cycle');
    expect(result).toContain('xcuitest-ios-watch');
  });

  it('excludes skills already in baseSkills', async () => {
    const result = await resolveSkillsForPrompt('run tests', ['xcuitest-ios-watch']);
    expect(result).not.toContain('xcuitest-ios-watch');
  });

  it('is case-insensitive', async () => {
    const result = await resolveSkillsForPrompt('XCODE BUILD FAILED');
    expect(result).toContain('xcode-simulator-cycle');
  });

  it('handles invalid regex in routing table gracefully', async () => {
    const badTable = { ...TEST_TABLE, prompt_keywords: { '[invalid': ['some-skill'] } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(badTable),
    }));
    _invalidateRoutingCache();
    const result = await resolveSkillsForPrompt('test something');
    // Should not throw, just skip the bad pattern
    expect(Array.isArray(result)).toBe(true);
  });

  it('returns empty when routing table has no prompt_keywords', async () => {
    const noKeywords = { ...TEST_TABLE, prompt_keywords: undefined };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(noKeywords),
    }));
    _invalidateRoutingCache();
    const result = await resolveSkillsForPrompt('build something');
    expect(result).toEqual([]);
  });
});

// ── Routing table validation tests ──────────────────────────────────

describe('skills-routing.json validation', () => {
  it('production routing table is valid JSON with required fields', async () => {
    // This test validates the actual file, not the mock
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.resolve(__dirname, '../../../../synalux-private/portal/public/.well-known/prism/skills-routing.json');

    // Skip if file doesn't exist (CI without synalux-private)
    if (!fs.existsSync(filePath)) return;

    const raw = fs.readFileSync(filePath, 'utf-8');
    const table = JSON.parse(raw) as SkillRoutingTable;

    expect(table.version).toBeGreaterThanOrEqual(4);
    expect(Array.isArray(table.universal)).toBe(true);
    expect(typeof table.projects).toBe('object');
    expect(typeof table.prompt_keywords).toBe('object');

    // All prompt_keywords patterns must be valid regex
    for (const pattern of Object.keys(table.prompt_keywords!)) {
      expect(() => new RegExp(pattern, 'i')).not.toThrow();
    }

    // prismcoach must be in projects
    expect(table.projects).toHaveProperty('prismcoach');
  });
});
