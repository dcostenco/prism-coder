/**
 * Skill routing client tests (v8 format with priority + protected)
 *
 * Verify that prism-mcp's `resolveSkillsForProject` correctly:
 *   - returns the universal skill set when no project pattern matches
 *   - unions multiple matching project patterns
 *   - falls back to OFFLINE_FALLBACK when synalux is unreachable
 *   - caches the routing table in-memory across calls
 *   - case-insensitively substring-matches the project name
 *   - sorts skills by priority
 *   - preserves protected flag on entries
 *   - handles both string and SkillEntry formats (v7 compat)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveSkillsForProject, _invalidateRoutingCache, _OFFLINE_FALLBACK } from '../src/tools/skillRouting.js';

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  _invalidateRoutingCache();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  _invalidateRoutingCache();
});

function mockFetch(table: unknown, ok = true) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    json: async () => table,
    status: ok ? 200 : 500,
  } as Response);
}

describe('skill routing — happy path', () => {
  it('returns universal skill for any project', async () => {
    mockFetch({
      version: 8,
      universal: [{ name: 'bcba_ai_assistant', priority: 0 }],
      projects: { 'prism-aac': ['i18n-tts'] },
      user_local: { enabled: false, key_prefix: 'user_skill:' },
    });
    const result = await resolveSkillsForProject('unknown-project');
    expect(result.names).toContain('bcba_ai_assistant');
    expect(result.user_local.enabled).toBe(false);
  });

  it('matches project pattern as substring', async () => {
    mockFetch({
      version: 8,
      universal: [{ name: 'bcba_ai_assistant', priority: 0 }],
      projects: { 'prism-aac': ['i18n-tts'] },
      user_local: { enabled: false, key_prefix: 'user_skill:' },
    });
    const result = await resolveSkillsForProject('my-prism-aac-fork');
    expect(result.names).toContain('i18n-tts');
    expect(result.names).toContain('bcba_ai_assistant');
  });

  it('unions multiple matching patterns', async () => {
    mockFetch({
      version: 8,
      universal: [{ name: 'bcba_ai_assistant', priority: 0 }],
      projects: {
        'prism': ['session-memory'],
        'prism-mcp': ['ai-agent-super-skill'],
      },
      user_local: { enabled: false, key_prefix: 'user_skill:' },
    });
    const result = await resolveSkillsForProject('prism-mcp');
    expect(result.names).toContain('session-memory');
    expect(result.names).toContain('ai-agent-super-skill');
    expect(result.names).toContain('bcba_ai_assistant');
  });

  it('matches case-insensitively', async () => {
    mockFetch({
      version: 8,
      universal: [],
      projects: { 'prism-aac': ['i18n-tts'] },
      user_local: { enabled: false, key_prefix: 'user_skill:' },
    });
    expect((await resolveSkillsForProject('Prism-AAC')).names).toContain('i18n-tts');
    expect((await resolveSkillsForProject('PRISM-AAC')).names).toContain('i18n-tts');
  });

  it('returns no duplicates when universal + project skill match', async () => {
    mockFetch({
      version: 8,
      universal: [{ name: 'shared-skill', priority: 0 }],
      projects: { 'prism': ['shared-skill', 'unique-skill'] },
      user_local: { enabled: false, key_prefix: 'user_skill:' },
    });
    const result = await resolveSkillsForProject('prism');
    expect(result.names.filter((s) => s === 'shared-skill').length).toBe(1);
    expect(result.names).toContain('unique-skill');
  });

  it('user_local.enabled=true is returned when routing table sets it', async () => {
    mockFetch({
      version: 8,
      universal: [{ name: 'bcba_ai_assistant', priority: 0 }],
      projects: {},
      user_local: { enabled: true, key_prefix: 'user_skill:' },
    });
    const result = await resolveSkillsForProject('any');
    expect(result.user_local.enabled).toBe(true);
    expect(result.user_local.key_prefix).toBe('user_skill:');
  });
});

describe('skill routing — priority and protected', () => {
  it('sorts skills by priority', async () => {
    mockFetch({
      version: 8,
      universal: [
        { name: 'low-priority', priority: 10 },
        { name: 'high-priority', priority: 1 },
        { name: 'mid-priority', priority: 5 },
      ],
      projects: {},
      user_local: { enabled: false, key_prefix: 'user_skill:' },
    });
    const result = await resolveSkillsForProject('any');
    expect(result.names).toEqual(['high-priority', 'mid-priority', 'low-priority']);
  });

  it('preserves protected flag', async () => {
    mockFetch({
      version: 8,
      universal: [
        { name: 'prime-directive', priority: 0, protected: true },
        { name: 'regular-skill', priority: 5 },
      ],
      projects: {},
      user_local: { enabled: false, key_prefix: 'user_skill:' },
    });
    const result = await resolveSkillsForProject('any');
    expect(result.skills[0].name).toBe('prime-directive');
    expect(result.skills[0].protected).toBe(true);
    expect(result.skills[1].name).toBe('regular-skill');
    expect(result.skills[1].protected).toBe(false);
  });

  it('project skills sort after universal', async () => {
    mockFetch({
      version: 8,
      universal: [{ name: 'universal-skill', priority: 0 }],
      projects: { 'prism': ['project-skill'] },
      user_local: { enabled: false, key_prefix: 'user_skill:' },
    });
    const result = await resolveSkillsForProject('prism');
    expect(result.names[0]).toBe('universal-skill');
    expect(result.names[1]).toBe('project-skill');
  });

  it('handles v7 string format (backward compat)', async () => {
    mockFetch({
      version: 7,
      universal: ['skill-a', 'skill-b'],
      projects: {},
      user_local: { enabled: false, key_prefix: 'user_skill:' },
    });
    const result = await resolveSkillsForProject('any');
    expect(result.names).toContain('skill-a');
    expect(result.names).toContain('skill-b');
    expect(result.skills[0].priority).toBe(0);
    expect(result.skills[1].priority).toBe(1);
    expect(result.skills[0].protected).toBe(false);
  });
});

describe('skill routing — offline fallback', () => {
  it('returns OFFLINE_FALLBACK names when synalux unreachable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network'));
    const result = await resolveSkillsForProject('prism-aac');
    const fallbackNames = _OFFLINE_FALLBACK.universal.map(
      (e) => typeof e === 'string' ? e : e.name
    );
    expect(result.names).toEqual(fallbackNames);
    expect(result.user_local.enabled).toBe(false);
  });

  it('returns OFFLINE_FALLBACK on 500 error', async () => {
    mockFetch({}, false);
    const result = await resolveSkillsForProject('any');
    const fallbackNames = _OFFLINE_FALLBACK.universal.map(
      (e) => typeof e === 'string' ? e : e.name
    );
    expect(result.names).toEqual(fallbackNames);
  });

  it('rejects malformed routing table', async () => {
    mockFetch({ version: 'wrong-type', universal: 'not-array' });
    const result = await resolveSkillsForProject('any');
    const fallbackNames = _OFFLINE_FALLBACK.universal.map(
      (e) => typeof e === 'string' ? e : e.name
    );
    expect(result.names).toEqual(fallbackNames);
  });
});

describe('skill routing — caching behavior', () => {
  it('uses cache on second call within TTL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        version: 8,
        universal: [{ name: 'bcba_ai_assistant', priority: 0 }],
        projects: { 'prism': ['session-memory'] },
        user_local: { enabled: false, key_prefix: 'user_skill:' },
      }),
      status: 200,
    } as Response);
    globalThis.fetch = fetchMock;

    await resolveSkillsForProject('prism');
    await resolveSkillsForProject('prism');
    await resolveSkillsForProject('prism');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refetches after invalidation', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        version: 8, universal: [], projects: {},
        user_local: { enabled: false, key_prefix: 'user_skill:' },
      }),
      status: 200,
    } as Response);
    globalThis.fetch = fetchMock;

    await resolveSkillsForProject('prism');
    _invalidateRoutingCache();
    await resolveSkillsForProject('prism');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('skill routing — fail-safe defaults', () => {
  it('OFFLINE_FALLBACK includes prime-directive and evidence-first-protocol', () => {
    const names = _OFFLINE_FALLBACK.universal.map(
      (e) => typeof e === 'string' ? e : e.name
    );
    expect(names).toContain('prime-directive');
    expect(names).toContain('evidence-first-protocol');
  });

  it('OFFLINE_FALLBACK has no project-specific skills', () => {
    expect(Object.keys(_OFFLINE_FALLBACK.projects).length).toBe(0);
  });
});
