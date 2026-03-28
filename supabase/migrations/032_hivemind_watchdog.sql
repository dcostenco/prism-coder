-- ════════════════════════════════════════════════════════════
-- v5.3: Hivemind Watchdog — Agent Health Monitoring
-- ════════════════════════════════════════════════════════════
--
-- Adds watchdog columns to agent_registry for:
--   • OVERDUE detection (task_start_time + expected_duration_minutes)
--   • LOOPING detection (task_hash + loop_count)
--   • State machine: ACTIVE → STALE → FROZEN → OFFLINE
--
-- Safe to run on existing databases — IF NOT EXISTS guards.
-- ════════════════════════════════════════════════════════════

ALTER TABLE agent_registry ADD COLUMN IF NOT EXISTS task_start_time TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE agent_registry ADD COLUMN IF NOT EXISTS expected_duration_minutes INTEGER DEFAULT NULL;
ALTER TABLE agent_registry ADD COLUMN IF NOT EXISTS task_hash TEXT DEFAULT NULL;
ALTER TABLE agent_registry ADD COLUMN IF NOT EXISTS loop_count INTEGER DEFAULT 0;

-- Index for watchdog sweep: query all agents for a user efficiently
CREATE INDEX IF NOT EXISTS idx_registry_user_id ON agent_registry(user_id);
