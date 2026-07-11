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
 * To change the routing for production, edit the portal routing endpoint
 * and deploy. prism-mcp picks up the new config within 5 minutes.
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

export interface SkillEntry {
  name: string;
  priority: number;
  protected?: boolean;
}

export interface SkillRoutingTable {
  version: number;
  universal: (string | SkillEntry)[];
  /** project-name substring → list of skill names or {name,priority} objects */
  projects: Record<string, (string | SkillEntry)[]>;
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
  universal: [
    { name: 'prime-directive', priority: 0, protected: true },
    { name: 'evidence-first-protocol', priority: 1, protected: true },
    { name: 'bcba_ai_assistant', priority: 20 },
  ],
  projects: {},
  user_local: { enabled: false, key_prefix: 'user_skill:' },
};

const SYNALUX_BASE = process.env.SYNALUX_BASE_URL || 'https://synalux.ai';
const LIVE_CACHE_TTL_MS = 5 * 60 * 1000;   // 5min for successful fetches
const FAILURE_BACKOFF_MS = 30_000;           // F5 fix: 30s retry after failure (not 5min)

// F5 fix: track live vs fallback separately so a transient failure doesn't
// negative-cache the full routing table for 5 minutes, dropping 19 skills.
let cached: { table: SkillRoutingTable; fetchedAt: number; isLive: boolean } | null = null;
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
    // On failure: return the last live table (stale-while-revalidate) or OFFLINE_FALLBACK.
    // The caller marks this as isLive=false so it retries after FAILURE_BACKOFF_MS, not 5min.
    return cached?.table ?? OFFLINE_FALLBACK;
  }
}

export interface ResolvedSkill {
  name: string;
  priority: number;
  protected: boolean;
  category: 'universal' | 'project' | 'prompt';
}

export interface ResolvedSkills {
  names: string[];
  skills: ResolvedSkill[];
  user_local: UserLocalPolicy;
  /** True when routing table was fetched live; false when using stale cache or OFFLINE_FALLBACK. */
  isOffline: boolean;
}

/**
 * Resolve the skill list for a given project (case-insensitive substring
 * match against the routing table). Always returns at least the universal
 * skills. Also returns the user_local policy so callers know whether to
 * load user_skill:* entries from local SQLite.
 */
function normalizeEntry(entry: string | SkillEntry, defaultPriority: number, category: 'universal' | 'project' | 'prompt' = 'universal'): ResolvedSkill {
  if (typeof entry === 'string') {
    return { name: entry, priority: defaultPriority, protected: false, category };
  }
  return { name: entry.name, priority: entry.priority ?? defaultPriority, protected: entry.protected ?? false, category };
}

export async function resolveSkillsForProject(project: string): Promise<ResolvedSkills> {
  const now = Date.now();
  // F5 fix: use shorter backoff TTL after failures so a 30s synalux hiccup doesn't
  // lock the session into OFFLINE_FALLBACK for 5 minutes.
  const ttl = (cached?.isLive ?? true) ? LIVE_CACHE_TTL_MS : FAILURE_BACKOFF_MS;
  if (!cached || now - cached.fetchedAt > ttl) {
    if (!inflight) {
      inflight = fetchOnce().then((table) => {
        // isLive = true only when we got a live response (not stale cache / OFFLINE_FALLBACK)
        const isLive = table !== OFFLINE_FALLBACK && table !== cached?.table;
        cached = { table, fetchedAt: Date.now(), isLive };
        return table;
      }).finally(() => { inflight = null; });
    }
    await inflight;
  }
  const isOffline = !(cached?.isLive ?? false);
  const table = cached!.table;
  const seen = new Set<string>();
  const skills: ResolvedSkill[] = [];

  for (let i = 0; i < table.universal.length; i++) {
    const entry = normalizeEntry(table.universal[i], i, 'universal');
    if (!seen.has(entry.name)) {
      seen.add(entry.name);
      skills.push(entry);
    }
  }

  const projectLower = project.toLowerCase();
  let projectPriority = 100;
  for (const [pattern, projectSkills] of Object.entries(table.projects)) {
    if (projectLower.includes(pattern)) {
      for (const s of projectSkills) {
        const entry = normalizeEntry(s, projectPriority++, 'project');
        if (!seen.has(entry.name)) {
          seen.add(entry.name);
          skills.push(entry);
        }
      }
    }
  }

  skills.sort((a, b) => a.priority - b.priority);

  return {
    names: skills.map(s => s.name),
    skills,
    user_local: table.user_local ?? OFFLINE_FALLBACK.user_local,
    isOffline,
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
  const ttl = (cached?.isLive ?? true) ? LIVE_CACHE_TTL_MS : FAILURE_BACKOFF_MS;
  if (!cached || now - cached.fetchedAt > ttl) {
    if (!inflight) {
      inflight = fetchOnce().then((table) => {
        const isLive = table !== OFFLINE_FALLBACK && table !== cached?.table;
        cached = { table, fetchedAt: Date.now(), isLive };
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
