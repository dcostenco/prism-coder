-- ==============================================================================
-- MIGRATION 015: Session Memory (Ledger + Handoffs + Progressive Loading)
-- ==============================================================================
-- Adapted for Supabase cloud architecture.
-- Adds: session_ledger (immutable), session_handoffs (upsertable), 
--        get_session_context() RPC for quick/standard/deep progressive loading.
-- ==============================================================================

-- -----------------------------------------------------------------------------
-- TABLE: session_ledger
-- Immutable, append-only log of every agent work session.
-- Each row = one completed work session.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS session_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_date DATE NOT NULL DEFAULT CURRENT_DATE,
    project TEXT NOT NULL DEFAULT 'default',
    agent_name TEXT NOT NULL DEFAULT 'assistant',
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    todo_next TEXT[] DEFAULT '{}',
    files_changed TEXT[] DEFAULT '{}',
    decisions TEXT[] DEFAULT '{}',
    keywords TEXT[] DEFAULT '{}',
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_date ON session_ledger(session_date DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_project ON session_ledger(project);
CREATE INDEX IF NOT EXISTS idx_ledger_agent ON session_ledger(agent_name);

COMMENT ON TABLE session_ledger IS 'Immutable append-only log of agent work sessions. Never update, only insert.';

-- -----------------------------------------------------------------------------
-- TABLE: session_handoffs
-- Latest handoff state per project. Upserted at session end.
-- Acts as the "live" context for the next session boot.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS session_handoffs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project TEXT NOT NULL UNIQUE,
    last_agent TEXT NOT NULL DEFAULT 'assistant',
    last_title TEXT,
    last_summary TEXT,
    pending_todo TEXT[] DEFAULT '{}',
    active_decisions TEXT[] DEFAULT '{}',
    keywords TEXT[] DEFAULT '{}',
    context_level TEXT NOT NULL DEFAULT 'standard',
    metadata JSONB DEFAULT '{}'::jsonb,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_handoffs_project ON session_handoffs(project);

COMMENT ON TABLE session_handoffs IS 'Latest handoff state per project. Upserted at session end for next session boot.';

-- -----------------------------------------------------------------------------
-- RPC: get_session_context(project, level)
-- Progressive context loading:
--   quick    (~500 tokens):  keywords + pending_todo only
--   standard (~2000 tokens): + last_summary + active_decisions
--   deep     (full):         + last 5 ledger entries with files_changed
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_session_context(
    p_project TEXT DEFAULT 'default',
    p_level TEXT DEFAULT 'standard'
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    result JSONB := '{}'::jsonb;
    handoff RECORD;
    ledger_entries JSONB;
BEGIN
    -- Get the handoff record for this project
    SELECT * INTO handoff
    FROM session_handoffs
    WHERE project = p_project;

    -- If no handoff exists, return empty context
    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'level', p_level,
            'project', p_project,
            'status', 'no_previous_session',
            'message', 'No previous session found for this project.'
        );
    END IF;

    -- quick: Keywords + TODO only (~500 tokens)
    result := jsonb_build_object(
        'level', p_level,
        'project', p_project,
        'last_agent', handoff.last_agent,
        'keywords', to_jsonb(handoff.keywords),
        'pending_todo', to_jsonb(handoff.pending_todo),
        'updated_at', handoff.updated_at
    );

    -- standard: + Summary + Decisions (~2000 tokens)
    IF p_level IN ('standard', 'deep') THEN
        result := result || jsonb_build_object(
            'last_title', handoff.last_title,
            'last_summary', handoff.last_summary,
            'active_decisions', to_jsonb(handoff.active_decisions)
        );
    END IF;

    -- deep: + Last 5 ledger entries with full detail
    IF p_level = 'deep' THEN
        SELECT COALESCE(jsonb_agg(
            jsonb_build_object(
                'date', sub.session_date,
                'agent', sub.agent_name,
                'title', sub.title,
                'summary', sub.summary,
                'files_changed', to_jsonb(sub.files_changed),
                'decisions', to_jsonb(sub.decisions),
                'todo_next', to_jsonb(sub.todo_next)
            )
        ), '[]'::jsonb) INTO ledger_entries
        FROM (
            SELECT sl.session_date, sl.agent_name, sl.title, sl.summary,
                   sl.files_changed, sl.decisions, sl.todo_next, sl.created_at
            FROM session_ledger sl
            WHERE sl.project = p_project
            ORDER BY sl.created_at DESC
            LIMIT 5
        ) sub;

        result := result || jsonb_build_object(
            'recent_sessions', ledger_entries
        );
    END IF;

    RETURN result;
END;
$$;

COMMENT ON FUNCTION get_session_context(TEXT, TEXT) IS 'Progressive context loading: quick=keywords+todo, standard=+summary+decisions, deep=+recent ledger entries';

-- ==============================================================================
-- MIGRATION COMPLETE
-- ==============================================================================
