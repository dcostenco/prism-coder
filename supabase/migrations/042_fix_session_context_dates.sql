-- Migration 042: Fix get_session_context date handling
--
-- Bugs fixed:
--   1. "standard" level returns no recent_sessions (only "deep" did)
--   2. "deep" level used key 'date' instead of 'session_date',
--      causing [undefined] in the formatter
--   3. Missing created_at/importance/last_accessed_at in deep results

DROP FUNCTION IF EXISTS get_session_context(TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION get_session_context(
    p_project TEXT DEFAULT 'default',
    p_level TEXT DEFAULT 'standard',
    p_user_id TEXT DEFAULT 'default',
    p_role TEXT DEFAULT 'global'
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

    result := jsonb_build_object(
        'level', p_level,
        'project', p_project,
        'last_agent', handoff.last_agent,
        'keywords', to_jsonb(handoff.keywords),
        'pending_todo', to_jsonb(handoff.pending_todo),
        'updated_at', handoff.updated_at,
        'version', handoff.version
    );

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
              AND sl.deleted_at IS NULL
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
              AND sl.deleted_at IS NULL
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
          AND deleted_at IS NULL
          AND archived_at IS NULL;

        knowledge_cache := jsonb_build_object(
            'hot_keywords', COALESCE(to_jsonb(hot_keywords), '[]'::jsonb),
            'top_categories', COALESCE(to_jsonb(top_categories), '[]'::jsonb),
            'total_sessions', COALESCE(related_count, 0)
        );

        result := result || jsonb_build_object('knowledge_cache', knowledge_cache);

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

        IF behavioral_warnings != '[]'::jsonb THEN
            result := result || jsonb_build_object(
                'behavioral_warnings', behavioral_warnings
            );
        END IF;

        -- FIX (042): recent_sessions now returned at standard level too
        SELECT COALESCE(jsonb_agg(
            jsonb_build_object(
                'id', sub.id,
                'summary', sub.summary,
                'session_date', COALESCE(sub.session_date, sub.created_at),
                'created_at', sub.created_at,
                'importance', sub.importance,
                'last_accessed_at', sub.last_accessed_at,
                'decisions', to_jsonb(sub.decisions)
            )
        ), '[]'::jsonb) INTO ledger_entries
        FROM (
            SELECT sl.id, sl.session_date, sl.created_at, sl.summary,
                   sl.decisions, sl.importance, sl.last_accessed_at
            FROM session_ledger sl
            WHERE sl.project = p_project
              AND sl.user_id = p_user_id
              AND sl.role = p_role
              AND sl.deleted_at IS NULL
              AND sl.archived_at IS NULL
            ORDER BY sl.created_at DESC
            LIMIT 5
        ) sub;

        result := result || jsonb_build_object(
            'recent_sessions', ledger_entries
        );
    END IF;

    IF p_level = 'deep' THEN
        -- For deep level, also add full session_history with file/keyword detail
        result := result || jsonb_build_object(
            'session_history', (
                SELECT COALESCE(jsonb_agg(
                    jsonb_build_object(
                        'session_date', COALESCE(sub2.session_date, sub2.created_at),
                        'created_at', sub2.created_at,
                        'agent', sub2.agent_name,
                        'title', sub2.title,
                        'summary', sub2.summary,
                        'keywords', to_jsonb(sub2.keywords),
                        'files_changed', to_jsonb(sub2.files_changed),
                        'decisions', to_jsonb(sub2.decisions),
                        'todo_next', to_jsonb(sub2.todo_next)
                    )
                ), '[]'::jsonb)
                FROM (
                    SELECT sl.session_date, sl.created_at, sl.agent_name, sl.title,
                           sl.summary, sl.keywords, sl.files_changed, sl.decisions,
                           sl.todo_next
                    FROM session_ledger sl
                    WHERE sl.project = p_project
                      AND sl.user_id = p_user_id
                      AND sl.deleted_at IS NULL
                      AND sl.archived_at IS NULL
                    ORDER BY sl.created_at DESC
                    LIMIT 50
                ) sub2
            )
        );

        IF array_length(handoff.keywords, 1) > 0 THEN
            result := result || jsonb_build_object(
                'cross_project_knowledge', (
                    SELECT COALESCE(jsonb_agg(
                        jsonb_build_object(
                            'project', sl2.project,
                            'summary', sl2.summary,
                            'keywords', to_jsonb(sl2.keywords),
                            'session_date', COALESCE(sl2.session_date, sl2.created_at),
                            'overlap_count', (
                                SELECT COUNT(*)
                                FROM unnest(sl2.keywords) k
                                WHERE k = ANY(handoff.keywords)
                            )
                        )
                    ), '[]'::jsonb)
                    FROM (
                        SELECT sl3.project, sl3.summary, sl3.keywords,
                               sl3.session_date, sl3.created_at
                        FROM session_ledger sl3
                        WHERE sl3.project != p_project
                          AND sl3.user_id = p_user_id
                          AND sl3.keywords && handoff.keywords
                          AND sl3.deleted_at IS NULL
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
    'behavioral warnings, recent_sessions at all levels, and GDPR soft-delete filtering (migration 042).';

GRANT EXECUTE ON FUNCTION get_session_context(TEXT, TEXT, TEXT, TEXT) TO service_role, authenticated;
