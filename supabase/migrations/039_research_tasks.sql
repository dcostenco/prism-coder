-- ═══════════════════════════════════════════════════════════════════
-- Migration 039: Research Task Bridge
--
-- Enables Synalux (Web) to trigger deep scientific research in Prism (Local).
-- Synalux posts to this table; Prism watches it and executes the Google/Scholar pipeline.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.research_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project TEXT NOT NULL,
    user_id TEXT NOT NULL DEFAULT 'default',
    topic TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')),
    result_summary TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.research_tasks ENABLE ROW LEVEL SECURITY;

-- Permissive policy for authenticated/service_role (Prism handles user_id isolation in logic)
DROP POLICY IF EXISTS research_tasks_all ON public.research_tasks;
CREATE POLICY research_tasks_all ON public.research_tasks
    FOR ALL USING (true) WITH CHECK (true);

-- Index for the Prism background watcher
CREATE INDEX IF NOT EXISTS idx_research_tasks_status ON public.research_tasks(status, created_at ASC);
