-- ═══════════════════════════════════════════════════════════════════
-- Prism MCP v4.0: Active Behavioral Memory — Supabase Migration
-- ═══════════════════════════════════════════════════════════════════
--
-- This migration adds behavioral memory support:
--   1. Add event_type, confidence_score, importance columns to session_ledger
--   2. Add composite indexes for behavioral queries
--   3. Update get_session_context() to include behavioral warnings
--
-- IMPORTANT: Run this AFTER all previous migrations (015-025).
-- For local SQLite users, these changes are applied automatically
-- on server startup — this file is only needed for Supabase/Postgres.
-- ═══════════════════════════════════════════════════════════════════

-- ─── 1. session_ledger: Add behavioral columns ────────────────
-- event_type classifies experience events for pattern detection.
-- confidence_score records agent certainty (1-100).
-- importance drives insight graduation (+/- voting, auto-decay).

ALTER TABLE session_ledger
  ADD COLUMN IF NOT EXISTS event_type TEXT NOT NULL DEFAULT 'session';

ALTER TABLE session_ledger
  ADD COLUMN IF NOT EXISTS confidence_score INTEGER DEFAULT NULL;

ALTER TABLE session_ledger
  ADD COLUMN IF NOT EXISTS importance INTEGER NOT NULL DEFAULT 0;

-- ─── 1b. Ensure soft-delete columns exist ───────────────────────
-- These may already exist from the SQLite auto-migration, but
-- Supabase needs them explicitly for the behavioral warning index.
ALTER TABLE session_ledger
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

ALTER TABLE session_ledger
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ DEFAULT NULL;

ALTER TABLE session_ledger
  ADD COLUMN IF NOT EXISTS deleted_reason TEXT DEFAULT NULL;

-- ─── 2. Indexes for behavioral queries ──────────────────────────
-- Fast lookups by event type (corrections, successes, etc.)
CREATE INDEX IF NOT EXISTS idx_ledger_event_type
  ON session_ledger (event_type);

-- Fast importance-ordered queries for warnings + graduation
CREATE INDEX IF NOT EXISTS idx_ledger_importance
  ON session_ledger (importance DESC);

-- Composite index for behavioral warning queries
-- (used by get_session_context standard+deep levels)
CREATE INDEX IF NOT EXISTS idx_ledger_behavioral_warnings
  ON session_ledger (project, user_id, role, importance DESC)
  WHERE event_type = 'correction'
    AND importance >= 3
    AND deleted_at IS NULL
    AND archived_at IS NULL;

-- ─── 3. Update get_session_context — add behavioral warnings ───
-- Drop old 4-param signature to replace cleanly
DROP FUNCTION IF EXISTS get_session_context(TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION get_session_context(
    p_project TEXT DEFAULT 'default',
    p_level TEXT DEFAULT 'standard',
    p_user_id TEXT DEFAULT 'default',
    p_role TEXT DEFAULT 'global'
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    result JSONB := '{}'::jsonb;
    handoff RECORD;
    ledger_entries JSONB;
    knowledge_cache JSONB;
    behavioral_warnings JSONB;
    hot_keywords TEXT[];
    top_categories TEXT[];
    related_count INT;
BEGIN
    -- Get the handoff record for this user + project + role
    SELECT * INTO handoff
    FROM session_handoffs
    WHERE project = p_project
      AND user_id = p_user_id
      AND role = p_role;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'level', p_level,
            'project', p_project,
            'status', 'no_previous_session',
            'message', 'No previous session found for this project.'
        );
    END IF;

    -- quick: Keywords + TODO + VERSION
    result := jsonb_build_object(
        'level', p_level,
        'project', p_project,
        'last_agent', handoff.last_agent,
        'keywords', to_jsonb(handoff.keywords),
        'pending_todo', to_jsonb(handoff.pending_todo),
        'updated_at', handoff.updated_at,
        'version', handoff.version
    );

    -- standard: + Summary + Decisions + Knowledge Cache + Behavioral Warnings
    IF p_level IN ('standard', 'deep') THEN
        result := result || jsonb_build_object(
            'last_title', handoff.last_title,
            'last_summary', handoff.last_summary,
            'active_decisions', to_jsonb(handoff.active_decisions)
        );

        SELECT ARRAY(
            SELECT kw
            FROM session_ledger sl, unnest(sl.keywords) AS kw
            WHERE sl.project = p_project
              AND sl.user_id = p_user_id
              AND sl.created_at >= NOW() - INTERVAL '7 days'
              AND sl.archived_at IS NULL
              AND kw NOT LIKE 'cat:%'
            GROUP BY kw
            ORDER BY COUNT(*) DESC
            LIMIT 5
        ) INTO hot_keywords;

        SELECT ARRAY(
            SELECT REPLACE(kw, 'cat:', '')
            FROM session_ledger sl, unnest(sl.keywords) AS kw
            WHERE sl.project = p_project
              AND sl.user_id = p_user_id
              AND sl.created_at >= NOW() - INTERVAL '7 days'
              AND sl.archived_at IS NULL
              AND kw LIKE 'cat:%'
            GROUP BY kw
            ORDER BY COUNT(*) DESC
            LIMIT 3
        ) INTO top_categories;

        SELECT COUNT(*) INTO related_count
        FROM session_ledger
        WHERE project = p_project
          AND user_id = p_user_id
          AND archived_at IS NULL;

        knowledge_cache := jsonb_build_object(
            'hot_keywords', COALESCE(to_jsonb(hot_keywords), '[]'::jsonb),
            'top_categories', COALESCE(to_jsonb(top_categories), '[]'::jsonb),
            'total_sessions', COALESCE(related_count, 0)
        );

        result := result || jsonb_build_object('knowledge_cache', knowledge_cache);

        -- v4.0: Behavioral Warnings — surface high-importance corrections
        -- so the agent proactively avoids repeating past mistakes.
        SELECT COALESCE(jsonb_agg(
            jsonb_build_object(
                'summary', sub.summary,
                'importance', sub.importance
            )
        ), '[]'::jsonb) INTO behavioral_warnings
        FROM (
            SELECT sl.summary, sl.importance
            FROM session_ledger sl
            WHERE sl.project = p_project
              AND sl.user_id = p_user_id
              AND sl.role = p_role
              AND sl.event_type = 'correction'
              AND sl.importance >= 3
              AND sl.deleted_at IS NULL
              AND sl.archived_at IS NULL
            ORDER BY sl.importance DESC
            LIMIT 5
        ) sub;

        -- Only include if there are actual warnings
        IF behavioral_warnings != '[]'::jsonb THEN
            result := result || jsonb_build_object(
                'behavioral_warnings', behavioral_warnings
            );
        END IF;
    END IF;

    -- deep: + Last 5 ledger entries + cross-project knowledge
    IF p_level = 'deep' THEN
        SELECT COALESCE(jsonb_agg(
            jsonb_build_object(
                'date', sub.session_date,
                'agent', sub.agent_name,
                'title', sub.title,
                'summary', sub.summary,
                'keywords', to_jsonb(sub.keywords),
                'files_changed', to_jsonb(sub.files_changed),
                'decisions', to_jsonb(sub.decisions),
                'todo_next', to_jsonb(sub.todo_next)
            )
        ), '[]'::jsonb) INTO ledger_entries
        FROM (
            SELECT sl.session_date, sl.agent_name, sl.title, sl.summary,
                   sl.keywords, sl.files_changed, sl.decisions, sl.todo_next, sl.created_at
            FROM session_ledger sl
            WHERE sl.project = p_project
              AND sl.user_id = p_user_id
              AND sl.archived_at IS NULL
            ORDER BY sl.created_at DESC
            LIMIT 5
        ) sub;

        result := result || jsonb_build_object(
            'recent_sessions', ledger_entries
        );

        -- Cross-project knowledge: SCOPED to same user_id
        IF array_length(handoff.keywords, 1) > 0 THEN
            result := result || jsonb_build_object(
                'cross_project_knowledge', (
                    SELECT COALESCE(jsonb_agg(
                        jsonb_build_object(
                            'project', sl2.project,
                            'summary', sl2.summary,
                            'keywords', to_jsonb(sl2.keywords),
                            'date', sl2.session_date,
                            'overlap_count', (
                                SELECT COUNT(*)
                                FROM unnest(sl2.keywords) k
                                WHERE k = ANY(handoff.keywords)
                            )
                        )
                    ), '[]'::jsonb)
                    FROM (
                        SELECT sl3.project, sl3.summary, sl3.keywords, sl3.session_date
                        FROM session_ledger sl3
                        WHERE sl3.project != p_project
                          AND sl3.user_id = p_user_id
                          AND sl3.keywords && handoff.keywords
                          AND sl3.archived_at IS NULL
                        ORDER BY (
                            SELECT COUNT(*)
                            FROM unnest(sl3.keywords) k
                            WHERE k = ANY(handoff.keywords)
                        ) DESC
                        LIMIT 3
                    ) sl2
                )
            );
        END IF;
    END IF;

    RETURN result;
END;
$$;

COMMENT ON FUNCTION get_session_context(TEXT, TEXT, TEXT, TEXT) IS
    'Progressive context loading with OCC, knowledge cache, multi-tenant + role isolation, '
    'and v4.0 behavioral warnings. '
    'quick=keywords+todo+version, standard=+summary+decisions+cache+warnings, '
    'deep=+recent sessions+cross-project knowledge (same user only).';
