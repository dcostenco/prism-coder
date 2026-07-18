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
