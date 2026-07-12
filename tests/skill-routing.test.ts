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

  it('passes prompt and role to portal', async () => {
    mockPortalResponse(PORTAL_RESP);
    await resolveSkills('prism-coder', 'train with LoRA', 'dev');
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.project).toBe('prism-coder');
    expect(body.prompt).toBe('train with LoRA');
    expect(body.role).toBe('dev');
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

  it('user_local defaults to disabled', async () => {
    mockPortalResponse(PORTAL_RESP);
    const result = await resolveSkillsForProject('any');
    expect(result.user_local.enabled).toBe(false);
    expect(result.user_local.key_prefix).toBe('user_skill:');
  });
});
