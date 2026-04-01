-- Migration 036: Supabase aggregate weak-link summary RPC for WS4.1
-- Eliminates N+1 network calls in summarizeWeakLinks by aggregating server-side.

BEGIN;

CREATE OR REPLACE FUNCTION public.prism_summarize_weak_links(
  p_project TEXT,
  p_user_id TEXT,
  p_min_strength REAL,
  p_max_source_entries INTEGER DEFAULT 25,
  p_max_links_per_source INTEGER DEFAULT 25
)
RETURNS TABLE (
  sources_considered BIGINT,
  links_scanned BIGINT,
  links_soft_pruned BIGINT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH source_entries AS (
    SELECT sl.id
    FROM public.session_ledger sl
    WHERE sl.project = p_project
      AND sl.user_id = p_user_id
      AND sl.deleted_at IS NULL
      AND sl.archived_at IS NULL
    ORDER BY sl.created_at DESC
    LIMIT GREATEST(p_max_source_entries, 0)
  ),
  ranked_links AS (
    SELECT
      m.source_id,
      m.strength,
      ROW_NUMBER() OVER (
        PARTITION BY m.source_id
        ORDER BY m.strength DESC, m.last_traversed_at DESC
      ) AS rn
    FROM public.memory_links m
    JOIN source_entries se ON se.id = m.source_id
    JOIN public.session_ledger target ON target.id = m.target_id
    WHERE target.user_id = p_user_id
      AND target.deleted_at IS NULL
      AND (target.archived_at IS NULL OR m.link_type IN ('spawned_from', 'supersedes'))
  ),
  capped_links AS (
    SELECT source_id, strength
    FROM ranked_links
    WHERE rn <= GREATEST(p_max_links_per_source, 0)
  )
  SELECT
    (SELECT COUNT(*) FROM source_entries)::BIGINT AS sources_considered,
    COUNT(*)::BIGINT AS links_scanned,
    COUNT(*) FILTER (WHERE strength < p_min_strength)::BIGINT AS links_soft_pruned
  FROM capped_links;
$$;

COMMIT;
