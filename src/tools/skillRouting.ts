/**
 * Skill routing thin client — all routing logic is portal-side.
 * POST SYNALUX_BASE/api/v1/prism/skills → { skillBlock, loaded, skipped, phantom, routing_version }
 * Cache: 5-min live, 30s failure backoff. Offline → empty skills + warning.
 */

// -- Type exports (backward compat) ------------------------------------------

export interface UserLocalPolicy { enabled: boolean; key_prefix: string }
export interface SkillEntry { name: string; priority: number; protected?: boolean }

export interface SkillRoutingTable {
  version: number;
  universal: (string | SkillEntry)[];
  projects: Record<string, (string | SkillEntry)[]>;
  prompt_keywords?: Record<string, string[]>;
  user_local: UserLocalPolicy;
}

export interface ResolvedSkill {
  name: string; priority: number; protected: boolean;
  category: 'universal' | 'project' | 'prompt';
}

export interface ResolvedSkills {
  names: string[];
  skills: ResolvedSkill[];
  user_local: UserLocalPolicy;
  isOffline: boolean;
  skillBlock?: string;
  routing_version?: number;
}

// -- Constants ----------------------------------------------------------------

const SYNALUX_BASE = process.env.SYNALUX_BASE_URL || 'https://synalux.ai';
const LIVE_TTL = 5 * 60 * 1000;
const FAIL_TTL = 30_000;
const DEFAULT_UL: UserLocalPolicy = { enabled: false, key_prefix: 'user_skill:' };

/** Backward-compat export for tests. Not used in live routing. */
export const OFFLINE_FALLBACK: SkillRoutingTable = {
  version: 1,
  universal: [
    { name: 'prime-directive', priority: 0, protected: true },
    { name: 'evidence-first-protocol', priority: 1, protected: true },
    { name: 'bcba_ai_assistant', priority: 20 },
  ],
  projects: {},
  user_local: DEFAULT_UL,
};

// -- Cache + API --------------------------------------------------------------

interface PortalResp {
  skillBlock: string; loaded: string[]; skipped: string[];
  phantom: string[]; routing_version: number;
}

let cached: { resp: PortalResp; at: number; live: boolean } | null = null;
let inflight: Promise<PortalResp | null> | null = null;

async function callPortal(project: string, prompt?: string, role?: string): Promise<PortalResp | null> {
  try {
    const body: Record<string, string> = { project };
    if (prompt) body.prompt = prompt;
    if (role) body.role = role;
    const res = await fetch(`${SYNALUX_BASE}/api/v1/prism/skills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2_500),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as PortalResp;
  } catch { return null; }
}

function offline(): ResolvedSkills {
  return { names: [], skills: [], user_local: DEFAULT_UL, isOffline: true,
    skillBlock: '[WARNING: OFFLINE] Portal unreachable — no skills loaded. Retry in 30s.' };
}

// -- Public API ---------------------------------------------------------------

/** Resolve skills via portal API. Caches 5 min (live) / 30s (failure). */
export async function resolveSkills(project: string, prompt?: string, role?: string): Promise<ResolvedSkills> {
  const now = Date.now();
  const ttl = (cached?.live ?? true) ? LIVE_TTL : FAIL_TTL;
  if (!cached || now - cached.at > ttl) {
    if (!inflight) {
      inflight = callPortal(project, prompt, role).then((r) => {
        if (r) cached = { resp: r, at: Date.now(), live: true };
        else if (cached) cached = { ...cached, at: Date.now(), live: false };
        return r;
      }).finally(() => { inflight = null; });
    }
    await inflight;
  }
  if (!cached) return offline();

  const { resp } = cached;
  return {
    names: resp.loaded,
    skills: resp.loaded.map((name, i) => ({ name, priority: i, protected: false, category: 'universal' as const })),
    user_local: DEFAULT_UL,
    isOffline: !cached.live,
    skillBlock: resp.skillBlock,
    routing_version: resp.routing_version,
  };
}

/** Thin wrapper — project-only resolution (no prompt/role). */
export async function resolveSkillsForProject(project: string): Promise<ResolvedSkills> {
  return resolveSkills(project);
}

/** No-op — prompt matching is portal-side now. */
export async function resolveSkillsForPrompt(_prompt: string, _baseSkills: string[] = []): Promise<string[]> {
  return [];
}

/** Force re-fetch on next call. For tests + admin tooling. */
export function _invalidateRoutingCache(): void { cached = null; inflight = null; }

/** Test/debug only. */
export const _OFFLINE_FALLBACK = OFFLINE_FALLBACK;
