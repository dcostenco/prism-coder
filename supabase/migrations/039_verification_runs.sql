-- ─── v7.2.0: Verification Harness & Runs ─────────────────────────

CREATE TABLE IF NOT EXISTS public.verification_harnesses (
  rubric_hash TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  min_pass_rate REAL NOT NULL,
  tests TEXT NOT NULL,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS public.verification_runs (
  id TEXT PRIMARY KEY,
  rubric_hash TEXT NOT NULL REFERENCES public.verification_harnesses(rubric_hash),
  project TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  run_at TEXT NOT NULL,
  passed INTEGER NOT NULL,
  pass_rate REAL NOT NULL,
  critical_failures INTEGER NOT NULL,
  coverage_score REAL NOT NULL,
  result_json TEXT NOT NULL,
  gate_action TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_verification_runs_project 
ON public.verification_runs(project, run_at DESC);
