/**
 * Skill routing thin client — all routing logic is portal-side.
 * POST SYNALUX_BASE/api/v1/prism/resolve with bearer auth.
 * Cache: keyed on (project,prompt,role), 5-min live / 30s failure.
 * Offline: last-good from local DB, or empty with warning.
 */

import { getSynaluxJwt, invalidateSynaluxJwt } from '../utils/synaluxJwt.js';
import { PRISM_SYNALUX_API_KEY, PRISM_SYNALUX_BASE_URL } from '../config.js';

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
  routing_version?: number;
}

// -- Constants ----------------------------------------------------------------

const LIVE_TTL = 5 * 60 * 1000;
const FAIL_TTL = 30_000;
const DEFAULT_UL: UserLocalPolicy = { enabled: false, key_prefix: 'user_skill:' };

export const REQUIRED_PROTECTED_SKILL_NAMES = [
  'prime-directive',
  'aba-precision-protocol',
  'evidence-first-protocol',
  'behavioral-verifier',
  'occam-razor-protocol',
  'absence-of-evidence-protocol',
  'never-fabricate-data',
  'session-drift-detection',
  'pre-commit-protocol',
  'pre-push-audit',
  'implementation-integrity-audit',
  'local-inference-first',
] as const;

/**
 * Native skills that every subscription tier receives through `prism connect`.
 *
 * `prism-startup` is deliberately not part of OFFLINE_FALLBACK: it tells the
 * host to call session_load_context, so injecting it back into that tool's
 * response would be circular. It still belongs in every native manifest so a
 * newly connected host can discover the hook-free first-turn procedure.
 */
export const REQUIRED_NATIVE_SKILL_NAMES = [
  ...REQUIRED_PROTECTED_SKILL_NAMES,
  'prism-startup',
] as const;

export const OFFLINE_FALLBACK: SkillRoutingTable = {
  version: 1,
  universal: REQUIRED_PROTECTED_SKILL_NAMES.map((name, priority) => ({ name, priority, protected: true })),
  projects: {},
  user_local: DEFAULT_UL,
};

// -- Cache (keyed on project+prompt+role) -------------------------------------

interface PortalResp {
  loaded: string[]; skipped: string[];
  routing_version: number; tier: string;
  /** Per-skill metadata (portal ≥ routing v23). Older portals omit it. */
  skills?: Array<{ name: string; priority: number; protected: boolean; category: string }>;
}

/**
 * Map a portal response to ResolvedSkill[]. Uses the portal's per-skill
 * metadata when present; for older portals that send names only, falls back
 * to neutral defaults (protected:false) — the budgeting floor then relies on
 * the caller's own knowledge (e.g. OFFLINE_FALLBACK). NEVER fabricate
 * protected:true here: an over-broad floor would defeat budgeting entirely.
 */
function toResolvedSkills(resp: PortalResp): ResolvedSkill[] {
  if (resp.skills && resp.skills.length > 0) {
    return resp.skills.map((s) => ({
      name: s.name, priority: s.priority, protected: s.protected,
      category: (s.category as ResolvedSkill['category']) ?? 'universal',
    }));
  }
  return resp.loaded.map((name, i) => ({
    name, priority: i, protected: false, category: 'universal' as const,
  }));
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
    const synaluxBase = (process.env.PRISM_SYNALUX_BASE_URL?.trim() ||
      process.env.SYNALUX_BASE_URL?.trim() || PRISM_SYNALUX_BASE_URL ||
      'https://synalux.ai').replace(/\/+$/, '');
    const body: Record<string, string> = { project };
    if (prompt) body.prompt = prompt;
    if (role) body.role = role;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    // Auth precedence: static PRISM_SKILLS_TOKEN (legacy/CI) → JWT exchanged
    // from the synalux API key. The JWT path uses the same per-user identity
    // as inference, so skills and inference resolve the SAME tier — without
    // it, machines with only PRISM_SYNALUX_API_KEY silently resolve tier=free
    // and never receive unprotected/prompt-routed skills.
    const staticToken = process.env.PRISM_SKILLS_TOKEN || '';
    const configuredApiKey = process.env.PRISM_SYNALUX_API_KEY?.trim() || PRISM_SYNALUX_API_KEY;
    let usedJwt = false;
    if (staticToken) {
      headers['Authorization'] = `Bearer ${staticToken}`;
    } else {
      // Bound the exchange so a hanging JWT endpoint cannot stall
      // session_load_context startup: after 4s proceed unauthenticated
      // (free-tier resolve) — the exchange keeps running and its cached
      // result authenticates the next call.
      const jwt = await Promise.race([
        getSynaluxJwt(),
        new Promise<null>((r) => setTimeout(r, 4_000, null)),
      ]);
      if (jwt) { headers['Authorization'] = `Bearer ${jwt}`; usedJwt = true; }
      else if (configuredApiKey) {
        // A configured paid identity that cannot authenticate must retain its
        // last-good result. Sending the request anonymously would silently
        // turn an auth outage into a free-tier downgrade.
        return null;
      }
    }

    const doFetch = () => fetch(`${synaluxBase}/api/v1/prism/resolve`, {
      method: 'POST', headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
      redirect: 'error', // never follow a redirect with a credential attached
    });
    let res = await doFetch();
    if (res.status === 401 && usedJwt) {
      // Expired/rotated JWT — invalidate and retry once with a fresh one.
      invalidateSynaluxJwt();
      const fresh = await getSynaluxJwt();
      if (fresh) {
        headers['Authorization'] = `Bearer ${fresh}`;
        res = await doFetch();
      }
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as PortalResp;
  } catch { return null; }
}

function makeOffline(): ResolvedSkills {
  return { names: [], skills: [], user_local: DEFAULT_UL, isOffline: true };
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
      skills: toResolvedSkills(cached.resp),
      user_local: DEFAULT_UL,
      isOffline: !cached.live,
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
          names: resp.loaded, skills: toResolvedSkills(resp), user_local: DEFAULT_UL,
          isOffline: true,
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
