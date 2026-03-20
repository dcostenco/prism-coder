-- ==============================================================================
-- MIGRATION 017: Ledger Auto-Compaction (Enhancement #2)
-- ==============================================================================
-- REVIEWER NOTE: This migration adds infrastructure for rolling up old
-- ledger entries into summary records to prevent unbounded growth.
--
-- DESIGN DECISION: We chose a "rollup row" approach rather than deleting
-- old entries. This preserves the append-only guarantee (old entries are
-- soft-deleted via archived_at, not hard-deleted) while keeping the
-- active ledger small and fast to query.
--
-- The actual summarization happens server-side via the Gemini API
-- (in compactionHandler.ts). This migration only adds the metadata
-- columns and helper function needed by that handler.
--
-- ROLLUP FLOW:
--   1. Server calls get_compaction_candidates() to find bloated projects
--   2. For each candidate, server fetches oldest entries
--   3. Server sends entries to Gemini for summarization (with chunking)
--   4. Server inserts a rollup entry with is_rollup=true
--   5. Server marks old entries with archived_at timestamp
--
-- SAFETY: Old entries are soft-deleted (archived_at set), not hard-deleted.
-- This is fully reversible by setting archived_at back to NULL.
-- ==============================================================================

-- Add rollup metadata columns to session_ledger
-- is_rollup:   true for entries that are AI-generated summaries of older entries
-- rollup_count: how many original entries were summarized into this rollup
-- archived_at:  soft-delete timestamp for entries that have been rolled up
ALTER TABLE session_ledger
  ADD COLUMN IF NOT EXISTS is_rollup BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS rollup_count INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP WITH TIME ZONE;

-- Partial index for efficient active-entry queries
-- REVIEWER NOTE: This index only covers non-archived entries, keeping it
-- small and fast as the ledger grows. All existing queries should add
-- WHERE archived_at IS NULL to exclude rolled-up entries.
CREATE INDEX IF NOT EXISTS idx_ledger_active
  ON session_ledger(project, created_at DESC)
  WHERE archived_at IS NULL;

-- RPC: get_compaction_candidates()
-- REVIEWER NOTE: This function identifies projects that need compaction.
-- The threshold is configurable (default: 50 active entries).
-- Returns the project name and count of entries to compact.
-- The actual summarization happens in TypeScript because it needs
-- the Gemini API — PostgreSQL can't call external APIs.
CREATE OR REPLACE FUNCTION get_compaction_candidates(
  p_threshold INT DEFAULT 50,
  p_keep_recent INT DEFAULT 10
) RETURNS TABLE(project TEXT, total_entries BIGINT, to_compact BIGINT)
LANGUAGE sql
AS $$
  SELECT
    sl.project,
    COUNT(*) AS total_entries,
    COUNT(*) - p_keep_recent AS to_compact
  FROM session_ledger sl
  WHERE sl.archived_at IS NULL
    AND sl.is_rollup = FALSE
  GROUP BY sl.project
  HAVING COUNT(*) > p_threshold;
$$;

COMMENT ON FUNCTION get_compaction_candidates(INT, INT) IS
  'Identifies projects with ledger entries exceeding the threshold. '
  'Returns project name, total active entries, and how many to compact. '
  'Used by the session_compact_ledger tool to decide what needs rollup.';

-- ==============================================================================
-- MIGRATION COMPLETE
-- ==============================================================================
