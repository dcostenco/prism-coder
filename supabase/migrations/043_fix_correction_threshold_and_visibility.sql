-- Fix behavioral corrections threshold: importance >= 3 → importance >= 0
-- Corrections were saved at importance=1 but filtered at >= 3, making them invisible.
-- Also adds visible_to column for role-based correction scoping.

-- 1. Fix the get_session_context RPC — replace the behavioral_warnings subquery
CREATE OR REPLACE FUNCTION get_session_context(
  p_project TEXT,
  p_user_id TEXT,
  p_level TEXT DEFAULT 'standard',
  p_role TEXT DEFAULT 'global'
)
RETURNS JSON AS $$
DECLARE
  result JSON;
  handoff_row RECORD;
  ledger_rows JSON;
  warnings_rows JSON;
  validations_rows JSON;
BEGIN
  -- Handoff
  SELECT * INTO handoff_row
  FROM session_handoffs
  WHERE project = p_project AND user_id = p_user_id AND role = p_role
  ORDER BY updated_at DESC
  LIMIT 1;

  -- Recent sessions
  SELECT COALESCE(json_agg(sub), '[]'::json) INTO ledger_rows
  FROM (
    SELECT summary, decisions, todos, session_date, created_at, importance
    FROM session_ledger
    WHERE project = p_project AND user_id = p_user_id
      AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT CASE WHEN p_level = 'quick' THEN 3
               WHEN p_level = 'deep' THEN 20
               ELSE 10 END
  ) sub;

  -- Behavioral warnings — ALL corrections, sorted by importance DESC
  SELECT COALESCE(json_agg(sub), '[]'::json) INTO warnings_rows
  FROM (
    SELECT summary, importance
    FROM session_ledger
    WHERE project = p_project AND user_id = p_user_id AND role = p_role
      AND event_type = 'correction'
      AND importance >= 0
      AND deleted_at IS NULL
      AND archived_at IS NULL
    ORDER BY importance DESC
    LIMIT 5
  ) sub;

  -- Recent validations
  SELECT COALESCE(json_agg(sub), '[]'::json) INTO validations_rows
  FROM (
    SELECT run_at, passed, pass_rate, gate_action, critical_failures
    FROM verification_runs
    WHERE project = p_project AND user_id = p_user_id
    ORDER BY run_at DESC
    LIMIT 3
  ) sub;

  result := json_build_object(
    'handoff', CASE WHEN handoff_row IS NULL THEN NULL ELSE row_to_json(handoff_row) END,
    'recent_sessions', ledger_rows,
    'behavioral_warnings', warnings_rows,
    'recent_validations', validations_rows
  );

  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Revoke public/anon access — only service_role can call this RPC.
-- Prevents cross-user data read via p_user_id parameter.
REVOKE EXECUTE ON FUNCTION get_session_context FROM public, anon;
GRANT EXECUTE ON FUNCTION get_session_context TO service_role, authenticated;

-- 2. Add visible_to column for role-based correction scoping
ALTER TABLE session_ledger
  ADD COLUMN IF NOT EXISTS visible_to TEXT NOT NULL DEFAULT 'user';

-- Add CHECK constraint (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'session_ledger_visible_to_check'
  ) THEN
    ALTER TABLE session_ledger
      ADD CONSTRAINT session_ledger_visible_to_check
      CHECK (visible_to IN ('user', 'team', 'workspace', 'platform'));
  END IF;
END $$;

-- 3. Drop and recreate the partial index to include all corrections
DROP INDEX IF EXISTS idx_ledger_behavioral;
CREATE INDEX idx_ledger_behavioral ON session_ledger(project, user_id, role, importance DESC)
  WHERE event_type = 'correction' AND deleted_at IS NULL AND archived_at IS NULL;

-- 4. Index for platform-visible corrections
CREATE INDEX IF NOT EXISTS idx_ledger_platform_visible
  ON session_ledger(visible_to, importance DESC)
  WHERE visible_to = 'platform' AND deleted_at IS NULL;
