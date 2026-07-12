/**
 * Skill routing thin client — all routing logic is portal-side.
 * POST SYNALUX_BASE/api/v1/prism/resolve with bearer auth.
 * Cache: keyed on (project,prompt,role), 5-min live / 30s failure.
 * Offline: last-good from local DB, or empty with warning.
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
const SKILLS_TOKEN = process.env.PRISM_SKILLS_TOKEN || '';
const LIVE_TTL = 5 * 60 * 1000;
const FAIL_TTL = 30_000;
const DEFAULT_UL: UserLocalPolicy = { enabled: false, key_prefix: 'user_skill:' };

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

// -- Cache (keyed on project+prompt+role) -------------------------------------

interface PortalResp {
  skillBlock: string; loaded: string[]; skipped: string[];
  phantom: string[]; routing_version: number;
}

interface CacheEntry { resp: PortalResp; at: number; live: boolean }

const cache = new Map<string, CacheEntry>();
const inflightMap = new Map<string, Promise<PortalResp | null>>();

function cacheKey(project: string, prompt?: string): string {
  return `${project}|${prompt || ''}`;
}

// Persist last-good to local DB for offline fallback
let persistFn: ((key: string, value: string) => Promise<void>) | null = null;
let readFn: ((key: string) => Promise<string>) | null = null;

export function _setStorage(persist: typeof persistFn, read: typeof readFn): void {
  persistFn = persist;
  readFn = read;
}

async function callPortal(project: string, prompt?: string, role?: string): Promise<PortalResp | null> {
  try {
    const body: Record<string, string> = { project };
    if (prompt) body.prompt = prompt;
    if (role) body.role = role;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (SKILLS_TOKEN) headers['Authorization'] = `Bearer ${SKILLS_TOKEN}`;

    const res = await fetch(`${SYNALUX_BASE}/api/v1/prism/resolve`, {
      method: 'POST', headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as PortalResp;
  } catch { return null; }
}

function makeOffline(skillBlock?: string): ResolvedSkills {
  return {
    names: [], skills: [], user_local: DEFAULT_UL, isOffline: true,
    skillBlock: skillBlock || '',
  };
}

// -- Public API ---------------------------------------------------------------

export async function resolveSkills(project: string, prompt?: string, role?: string): Promise<ResolvedSkills> {
  const key = cacheKey(project, prompt);
  const now = Date.now();
  const entry = cache.get(key);
  const ttl = (entry?.live ?? true) ? LIVE_TTL : FAIL_TTL;

  if (!entry || now - entry.at > ttl) {
    if (!inflightMap.has(key)) {
      const p = callPortal(project, prompt, role).then(async (r) => {
        if (r) {
          cache.set(key, { resp: r, at: Date.now(), live: true });
          // Persist last-good for offline fallback
          if (persistFn) {
            try { await persistFn(`skill_cache:${project}`, JSON.stringify(r)); } catch {}
          }
        } else if (entry) {
          cache.set(key, { ...entry, at: Date.now(), live: false });
        }
        return r;
      }).finally(() => { inflightMap.delete(key); });
      inflightMap.set(key, p);
    }
    await inflightMap.get(key);
  }

  const cached = cache.get(key);
  if (cached) {
    return {
      names: cached.resp.loaded,
      skills: cached.resp.loaded.map((name, i) => ({
        name, priority: i, protected: false, category: 'universal' as const,
      })),
      user_local: DEFAULT_UL,
      isOffline: !cached.live,
      skillBlock: cached.resp.skillBlock,
      routing_version: cached.resp.routing_version,
    };
  }

  // No cached response — try last-good from local DB
  if (readFn) {
    try {
      const stored = await readFn(`skill_cache:${project}`);
      if (stored) {
        const resp = JSON.parse(stored) as PortalResp;
        return {
          names: resp.loaded, skills: [], user_local: DEFAULT_UL,
          isOffline: true, skillBlock: resp.skillBlock,
          routing_version: resp.routing_version,
        };
      }
    } catch {}
  }

  return makeOffline();
}

export async function resolveSkillsForProject(project: string): Promise<ResolvedSkills> {
  return resolveSkills(project);
}

export async function resolveSkillsForPrompt(_prompt: string, _baseSkills: string[] = []): Promise<string[]> {
  return [];
}

export function _invalidateRoutingCache(): void {
  cache.clear();
  inflightMap.clear();
}

export const _OFFLINE_FALLBACK = OFFLINE_FALLBACK;
