/**
 * Skill routing client tests
 *
 * Verify that prism-mcp's `resolveSkillsForProject` correctly:
 *   - returns the universal skill set when no project pattern matches
 *   - unions multiple matching project patterns
 *   - falls back to OFFLINE_FALLBACK when synalux is unreachable
 *   - caches the routing table in-memory across calls
 *   - case-insensitively substring-matches the project name
 *
 * The canonical routing source is synalux at /api/v1/skills/routing.
 * If you change the routing schema, update both this test and the route.
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
      version: 1,
      universal: ['bcba_ai_assistant'],
      projects: { 'prism-aac': ['i18n-tts'] },
    });
    const skills = await resolveSkillsForProject('unknown-project');
    expect(skills).toContain('bcba_ai_assistant');
  });

  it('matches project pattern as substring', async () => {
    mockFetch({
      version: 1,
      universal: ['bcba_ai_assistant'],
      projects: { 'prism-aac': ['i18n-tts'] },
    });
    const skills = await resolveSkillsForProject('my-prism-aac-fork');
    expect(skills).toContain('i18n-tts');
    expect(skills).toContain('bcba_ai_assistant');
  });

  it('unions multiple matching patterns', async () => {
    mockFetch({
      version: 1,
      universal: ['bcba_ai_assistant'],
      projects: {
        'prism': ['session-memory'],
        'prism-mcp': ['ai-agent-super-skill'],
      },
    });
    const skills = await resolveSkillsForProject('prism-mcp');
    expect(skills).toContain('session-memory');
    expect(skills).toContain('ai-agent-super-skill');
    expect(skills).toContain('bcba_ai_assistant');
  });

  it('matches case-insensitively', async () => {
    mockFetch({
      version: 1,
      universal: [],
      projects: { 'prism-aac': ['i18n-tts'] },
    });
    expect(await resolveSkillsForProject('Prism-AAC')).toContain('i18n-tts');
    expect(await resolveSkillsForProject('PRISM-AAC')).toContain('i18n-tts');
  });

  it('returns no duplicates when universal + project skill match', async () => {
    mockFetch({
      version: 1,
      universal: ['shared-skill'],
      projects: { 'prism': ['shared-skill', 'unique-skill'] },
    });
    const skills = await resolveSkillsForProject('prism');
    expect(skills.filter((s) => s === 'shared-skill').length).toBe(1);
    expect(skills).toContain('unique-skill');
  });
});

describe('skill routing — offline fallback', () => {
  it('returns OFFLINE_FALLBACK when synalux unreachable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network'));
    const skills = await resolveSkillsForProject('prism-aac');
    expect(skills).toEqual(_OFFLINE_FALLBACK.universal);
  });

  it('returns OFFLINE_FALLBACK on 500 error', async () => {
    mockFetch({}, false);
    const skills = await resolveSkillsForProject('any');
    expect(skills).toEqual(_OFFLINE_FALLBACK.universal);
  });

  it('rejects malformed routing table', async () => {
    mockFetch({ version: 'wrong-type', universal: 'not-array' });
    const skills = await resolveSkillsForProject('any');
    expect(skills).toEqual(_OFFLINE_FALLBACK.universal);
  });
});

describe('skill routing — caching behavior', () => {
  it('uses cache on second call within TTL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        version: 1,
        universal: ['bcba_ai_assistant'],
        projects: { 'prism': ['session-memory'] },
      }),
      status: 200,
    } as Response);
    globalThis.fetch = fetchMock;

    await resolveSkillsForProject('prism');
    await resolveSkillsForProject('prism');
    await resolveSkillsForProject('prism');

    // 1 fetch, even though resolveSkillsForProject was called 3 times
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refetches after invalidation', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: 1, universal: [], projects: {} }),
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
  it('OFFLINE_FALLBACK includes the universal BCBA skill', () => {
    expect(_OFFLINE_FALLBACK.universal).toContain('bcba_ai_assistant');
  });

  it('OFFLINE_FALLBACK has no project-specific skills', () => {
    // Project skills require synalux to resolve correctly; offline mode
    // falls back to universal-only so we don't ship stale project mappings.
    expect(Object.keys(_OFFLINE_FALLBACK.projects).length).toBe(0);
  });
});
