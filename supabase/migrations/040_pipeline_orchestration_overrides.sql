-- 040_pipeline_orchestration_overrides.sql

ALTER TABLE verification_runs ADD COLUMN gate_override INTEGER DEFAULT 0;
ALTER TABLE verification_runs ADD COLUMN override_reason TEXT;
