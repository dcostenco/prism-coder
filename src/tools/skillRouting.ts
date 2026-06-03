/**
 * Skill routing client — fetches the canonical routing table from synalux.
 *
 * Single source of truth lives in synalux at /api/v1/skills/routing.
 * This module:
 *   1. Caches the response in-memory for 5 minutes (matches synalux's
 *      Cache-Control s-maxage).
 *   2. Falls back to a tiny offline default if synalux is unreachable, so
 *      free-tier / disconnected installations still get the BCBA universal
 *      skill loaded.
 *
 * To change the routing for production, edit
 *   synalux-private/portal/src/app/api/v1/skills/routing/route.ts
 * and deploy synalux. prism-mcp picks up the new config within 5 minutes.
 *
 * Do NOT add hardcoded skill names here outside the OFFLINE_FALLBACK block
 * — that defeats the single-source-of-truth design.
 */

export interface UserLocalPolicy {
  /** Whether user-local skills (user_skill: prefix in SQLite) load automatically. */
  enabled: boolean;
  /** SQLite key prefix for user-defined local skills. Default: "user_skill:". */
  key_prefix: string;
}

export interface SkillRoutingTable {
  version: number;
  universal: string[];
  /** project-name substring → list of skill names */
  projects: Record<string, string[]>;
  /** regex pattern → list of skill names. Matched against user prompt. */
  prompt_keywords?: Record<string, string[]>;
  /**
   * User-local skill policy. Disabled by default — user must explicitly
   * request local skill loading (user_local=true on session_load_context,
   * or admin sets user_local.enabled=true in routing table).
   * User-local skills are stored in local SQLite under user_skill:<name>.
   * They are NEVER sent to Supabase — platform skills only go through
   * /api/v1/admin/skills (platform admin auth required).
   */
  user_local: UserLocalPolicy;
}

// Minimal fallback when synalux is unreachable.
const OFFLINE_FALLBACK: SkillRoutingTable = {
  version: 1,
  universal: ['bcba_ai_assistant'],
  projects: {},
  user_local: { enabled: false, key_prefix: 'user_skill:' },
};

const SYNALUX_BASE = process.env.SYNALUX_BASE_URL || 'https://synalux.ai';
const CACHE_TTL_MS = 5 * 60 * 1000;

let cached: { table: SkillRoutingTable; fetchedAt: number } | null = null;
let inflight: Promise<SkillRoutingTable> | null = null;

async function fetchOnce(): Promise<SkillRoutingTable> {
  try {
    const res = await fetch(`${SYNALUX_BASE}/.well-known/prism/skills-routing.json`, {
      headers: { Accept: 'application/json' },
      // Routing is on every session_load_context, must not block long.
      signal: AbortSignal.timeout(2_500),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as SkillRoutingTable;
    if (
      typeof body !== 'object' ||
      body == null ||
      typeof body.version !== 'number' ||
      !Array.isArray(body.universal) ||
      typeof body.projects !== 'object'
    ) {
      throw new Error('malformed routing table');
    }
    return body;
  } catch {
    return OFFLINE_FALLBACK;
  }
}

export interface ResolvedSkills {
  names: string[];
  user_local: UserLocalPolicy;
}

/**
 * Resolve the skill list for a given project (case-insensitive substring
 * match against the routing table). Always returns at least the universal
 * skills. Also returns the user_local policy so callers know whether to
 * load user_skill:* entries from local SQLite.
 */
export async function resolveSkillsForProject(project: string): Promise<ResolvedSkills> {
  const now = Date.now();
  if (!cached || now - cached.fetchedAt > CACHE_TTL_MS) {
    if (!inflight) {
      inflight = fetchOnce().then((table) => {
        cached = { table, fetchedAt: Date.now() };
        return table;
      }).finally(() => { inflight = null; });
    }
    await inflight;
  }
  const table = cached!.table;
  const out = new Set<string>(table.universal);
  const projectLower = project.toLowerCase();
  for (const [pattern, skills] of Object.entries(table.projects)) {
    if (projectLower.includes(pattern)) {
      for (const s of skills) out.add(s);
    }
  }
  return {
    names: Array.from(out),
    user_local: table.user_local ?? OFFLINE_FALLBACK.user_local,
  };
}

/**
 * Resolve skills based on user prompt keywords. Matches prompt text
 * against the routing table's prompt_keywords regex patterns.
 * Returns deduplicated skill names (excluding any already in baseSkills).
 */
export async function resolveSkillsForPrompt(
  prompt: string,
  baseSkills: string[] = [],
): Promise<string[]> {
  const now = Date.now();
  if (!cached || now - cached.fetchedAt > CACHE_TTL_MS) {
    if (!inflight) {
      inflight = fetchOnce().then((table) => {
        cached = { table, fetchedAt: Date.now() };
        return table;
      }).finally(() => { inflight = null; });
    }
    await inflight;
  }
  const table = cached!.table;
  if (!table.prompt_keywords) return [];

  const existing = new Set(baseSkills);
  const matched: string[] = [];

  for (const [pattern, skills] of Object.entries(table.prompt_keywords)) {
    try {
      const re = new RegExp(pattern, 'i');
      if (re.test(prompt)) {
        for (const s of skills) {
          if (!existing.has(s)) {
            existing.add(s);
            matched.push(s);
          }
        }
      }
    } catch {
      // Invalid regex in routing table — skip silently
    }
  }
  return matched;
}

/** Force a re-fetch on the next call. Exposed for tests + admin tooling. */
export function _invalidateRoutingCache(): void {
  cached = null;
  inflight = null;
}

/** Test/debug only — read the OFFLINE_FALLBACK constant. */
export const _OFFLINE_FALLBACK = OFFLINE_FALLBACK;
