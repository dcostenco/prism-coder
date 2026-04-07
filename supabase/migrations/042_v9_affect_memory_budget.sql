-- ═══════════════════════════════════════════════════════════════════
-- Migration 042: v9.0 Affect-Tagged Memory + Token-Economic Budget
-- ═══════════════════════════════════════════════════════════════════
--
-- This migration adds two columns needed for Prism v9.0.0:
--
--   1. session_ledger.valence
--      REAL [-1.0, +1.0], nullable. Stores the affective "gut feeling"
--      score derived from event_type. Legacy entries remain NULL (neutral).
--
--   2. session_handoffs.cognitive_budget
--      REAL, nullable. Persists the agent's token-economic budget
--      balance across sessions. NULL before first use.
--
-- Both use IF NOT EXISTS for idempotency — safe to re-run.
--
-- NOTE: If you have the auto-migration infrastructure (migration 027),
-- this migration is applied AUTOMATICALLY on server startup.
-- You do NOT need to run it manually.
-- ═══════════════════════════════════════════════════════════════════

-- v9.0: Affect-Tagged Memory — valence column
ALTER TABLE session_ledger ADD COLUMN IF NOT EXISTS valence REAL DEFAULT NULL;

-- Partial index for valence-aware retrieval (skip NULLs)
CREATE INDEX IF NOT EXISTS idx_ledger_valence
  ON session_ledger(valence)
  WHERE valence IS NOT NULL;

-- v9.0: Token-Economic Cognitive Budget — budget persistence
ALTER TABLE session_handoffs ADD COLUMN IF NOT EXISTS cognitive_budget REAL DEFAULT NULL;

-- v9.0: Atomic delta-based budget update RPC
-- Used by SupabaseStorage.patchHandoffBudgetDelta() for concurrency-safe
-- budget adjustments. Supabase REST PATCH can't do arithmetic, so this
-- RPC performs the COALESCE + delta in a single SQL statement.
-- Falls back to read-modify-write if this RPC is missing.
CREATE OR REPLACE FUNCTION patch_budget_delta(
  p_project TEXT,
  p_user_id TEXT,
  p_delta FLOAT8
) RETURNS VOID AS $$
BEGIN
  UPDATE session_handoffs
  SET cognitive_budget = GREATEST(0, COALESCE(cognitive_budget, 2000) + p_delta)
  WHERE project = p_project AND user_id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
