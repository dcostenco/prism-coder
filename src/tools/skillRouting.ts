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

export interface SkillRoutingTable {
  version: number;
  universal: string[];
  /** project-name substring → list of skill names */
  projects: Record<string, string[]>;
}

// Minimal fallback when synalux is unreachable. Only the universal BCBA
// skill — project-specific mappings need synalux to resolve.
const OFFLINE_FALLBACK: SkillRoutingTable = {
  version: 1,
  universal: ['bcba_ai_assistant'],
  projects: {},
};

const SYNALUX_BASE = process.env.SYNALUX_BASE_URL || 'https://synalux.ai';
const CACHE_TTL_MS = 5 * 60 * 1000;

let cached: { table: SkillRoutingTable; fetchedAt: number } | null = null;
let inflight: Promise<SkillRoutingTable> | null = null;

async function fetchOnce(): Promise<SkillRoutingTable> {
  try {
    const res = await fetch(`${SYNALUX_BASE}/api/v1/skills/routing`, {
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

/**
 * Resolve the skill list for a given project (case-insensitive substring
 * match against the routing table). Always returns at least the universal
 * skills.
 */
export async function resolveSkillsForProject(project: string): Promise<string[]> {
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
  return Array.from(out);
}

/** Force a re-fetch on the next call. Exposed for tests + admin tooling. */
export function _invalidateRoutingCache(): void {
  cached = null;
  inflight = null;
}

/** Test/debug only — read the OFFLINE_FALLBACK constant. */
export const _OFFLINE_FALLBACK = OFFLINE_FALLBACK;
