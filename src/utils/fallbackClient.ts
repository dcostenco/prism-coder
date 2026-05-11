/**
 * Supabase Direct Fallback Client
 *
 * When prism-mcp Railway/Fly endpoints are unreachable, this module
 * allows critical tools (load_context, save_ledger, save_handoff) to
 * call Supabase REST API directly — bypassing the prism-mcp server.
 *
 * Used by smithery-bridge.mjs health monitor: if /healthz fails 3× in
 * a row, responses include a Retry-After + x-fallback-mode: supabase
 * header so Claude Code can switch to direct-Supabase mode.
 *
 * Architecture:
 *   Normal:   Agent → Railway prism-mcp → Supabase
 *   Fallback: Agent → Supabase REST API directly (read-only for safety)
 */

const SUPABASE_URL     = process.env.SUPABASE_URL     || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

export interface FallbackContext {
  project: string;
  lastSummary?: string;
  openTodos?: string[];
  keyContext?: string;
}

/**
 * Direct Supabase read — returns last handoff for a project.
 * Called when prism-mcp is unreachable.
 */
export async function directLoadContext(project: string): Promise<FallbackContext | null> {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
    try {
        const res = await fetch(
            `${SUPABASE_URL}/rest/v1/session_handoffs?project=eq.${encodeURIComponent(project)}&order=updated_at.desc&limit=1`,
            { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
        );
        if (!res.ok) return null;
        const [row] = await res.json() as Array<Record<string, unknown>>;
        if (!row) return null;
        return {
            project,
            lastSummary:  (row.last_summary  as string) ?? '',
            openTodos:    (row.open_todos    as string[]) ?? [],
            keyContext:   (row.key_context   as string) ?? '',
        };
    } catch {
        return null;
    }
}

/** Returns true if Railway prism-mcp primary is reachable. */
export async function isPrimaryHealthy(primaryUrl: string): Promise<boolean> {
    try {
        const res = await fetch(`${primaryUrl}/healthz`, { signal: AbortSignal.timeout(3000) });
        return res.ok;
    } catch {
        return false;
    }
}
