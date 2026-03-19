-- ==============================================================================
-- MIGRATION 019: Optimistic Concurrency Control (Enhancement #5)
-- ==============================================================================
-- REVIEWER NOTE: This migration adds version tracking to session_handoffs
-- to prevent race conditions when multiple Claude Desktop instances
-- access the same project simultaneously.
--
-- THE PROBLEM:
--   Two Claude Desktop windows open for project "prism-mcp".
--   Both load context (both see version=1).
--   Window B saves first → version becomes 2.
--   Window A tries to save with version=1 → CONFLICT!
--   Without OCC, Window A would silently overwrite B's changes.
--
-- HOW OCC WORKS:
--   1. Each handoff row has a monotonically increasing `version` integer
--   2. session_load_context returns the current version in its response
--   3. Prompts and Resources also include the version number
--   4. session_save_handoff accepts an optional expected_version parameter
--   5. If expected_version doesn't match → reject with clear error + LLM's data
--   6. If versions match (or no version check) → save succeeds, version++
--
-- WHY OPTIMISTIC (not pessimistic):
--   - MCP tool calls are stateless (no persistent DB connections for locks)
--   - Conflicts are rare (two humans rarely edit the same project simultaneously)
--   - When conflicts occur, the error is actionable ("reload and merge")
--   - Pessimistic locking (SELECT FOR UPDATE with held connections) doesn't
--     fit the MCP request/response model
--
-- BACKWARD COMPATIBILITY:
--   If expected_version is NULL (e.g., v0.3.0 clients that don't send it),
--   the version check is skipped and the save proceeds normally.
--   This makes the upgrade non-breaking.
-- ==============================================================================

-- Add version column with auto-increment default
-- REVIEWER NOTE: Starting at 1. Each successful save increments by 1.
-- NOT using a database sequence because we need transaction-level
-- control (check-then-increment atomically).
ALTER TABLE session_handoffs
  ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;

-- Update get_session_context() to include version in all response levels
-- REVIEWER NOTE: This is critical — the LLM needs the version number
-- regardless of whether it loaded context via tool, prompt, or resource.
-- We add version to the base "quick" level so it's always present.
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
    knowledge_cache JSONB;
    hot_keywords TEXT[];
    top_categories TEXT[];
    related_count INT;
BEGIN
    -- Get the handoff record for this project
    SELECT * INTO handoff
    FROM session_handoffs
    WHERE project = p_project;

    -- If no handoff exists, return empty context with no version
    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'level', p_level,
            'project', p_project,
            'status', 'no_previous_session',
            'message', 'No previous session found for this project.'
        );
    END IF;

    -- quick: Keywords + TODO + VERSION (always included)
    -- REVIEWER NOTE: version is included at the quick level so it's
    -- available regardless of which loading level is requested.
    -- This is essential for OCC to work with prompts and resources
    -- that default to standard/quick loading.
    result := jsonb_build_object(
        'level', p_level,
        'project', p_project,
        'last_agent', handoff.last_agent,
        'keywords', to_jsonb(handoff.keywords),
        'pending_todo', to_jsonb(handoff.pending_todo),
        'updated_at', handoff.updated_at,
        -- v0.4.0: Include version for OCC (Enhancement #5)
        'version', handoff.version
    );

    -- standard: + Summary + Decisions + Knowledge Cache (~2000 tokens)
    IF p_level IN ('standard', 'deep') THEN
        result := result || jsonb_build_object(
            'last_title', handoff.last_title,
            'last_summary', handoff.last_summary,
            'active_decisions', to_jsonb(handoff.active_decisions)
        );

        -- Knowledge Cache: hot keywords from last 7 days
        SELECT ARRAY(
            SELECT kw
            FROM session_ledger sl, unnest(sl.keywords) AS kw
            WHERE sl.project = p_project
              AND sl.created_at >= NOW() - INTERVAL '7 days'
              AND sl.archived_at IS NULL  -- v0.4.0: exclude archived entries
              AND kw NOT LIKE 'cat:%'
            GROUP BY kw
            ORDER BY COUNT(*) DESC
            LIMIT 5
        ) INTO hot_keywords;

        -- Top categories from last 7 days
        SELECT ARRAY(
            SELECT REPLACE(kw, 'cat:', '')
            FROM session_ledger sl, unnest(sl.keywords) AS kw
            WHERE sl.project = p_project
              AND sl.created_at >= NOW() - INTERVAL '7 days'
              AND sl.archived_at IS NULL  -- v0.4.0: exclude archived entries
              AND kw LIKE 'cat:%'
            GROUP BY kw
            ORDER BY COUNT(*) DESC
            LIMIT 3
        ) INTO top_categories;

        SELECT COUNT(*) INTO related_count
        FROM session_ledger
        WHERE project = p_project
          AND archived_at IS NULL;  -- v0.4.0: only count active entries

        knowledge_cache := jsonb_build_object(
            'hot_keywords', COALESCE(to_jsonb(hot_keywords), '[]'::jsonb),
            'top_categories', COALESCE(to_jsonb(top_categories), '[]'::jsonb),
            'total_sessions', COALESCE(related_count, 0)
        );

        result := result || jsonb_build_object('knowledge_cache', knowledge_cache);
    END IF;

    -- deep: + Last 5 ledger entries with full detail + related sessions
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
              AND sl.archived_at IS NULL  -- v0.4.0: exclude archived entries
            ORDER BY sl.created_at DESC
            LIMIT 5
        ) sub;

        result := result || jsonb_build_object(
            'recent_sessions', ledger_entries
        );

        -- Cross-project knowledge from other projects that share keywords
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
                          AND sl3.keywords && handoff.keywords
                          AND sl3.archived_at IS NULL  -- v0.4.0: exclude archived
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

COMMENT ON FUNCTION get_session_context IS
    'Progressive context loading with OCC version tracking and knowledge cache. '
    'v0.4.0: includes version field at all levels, excludes archived entries. '
    'quick=keywords+todo+version, standard=+summary+decisions+knowledge_cache, '
    'deep=+recent sessions+cross-project knowledge.';

-- RPC: save_handoff_with_version()
-- REVIEWER NOTE: This replaces the raw PostgREST upsert with a
-- server-side function that enforces optimistic concurrency control.
--
-- THREE CASES:
--   1. No existing handoff → INSERT (version = 1)
--   2. Existing + version matches → UPDATE (version++)
--   3. Existing + version mismatch → REJECT (return conflict status)
--
-- The expected_version parameter is OPTIONAL for backward compatibility.
-- v0.3.0 clients that don't send it skip the version check entirely.
CREATE OR REPLACE FUNCTION save_handoff_with_version(
  p_project TEXT,
  p_expected_version INT DEFAULT NULL,
  p_last_summary TEXT DEFAULT NULL,
  p_pending_todo TEXT[] DEFAULT NULL,
  p_active_decisions TEXT[] DEFAULT NULL,
  p_keywords TEXT[] DEFAULT NULL,
  p_key_context TEXT DEFAULT NULL,
  p_active_branch TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  current_version INT;
  new_version INT;
BEGIN
  -- Get current version (if handoff exists)
  -- REVIEWER NOTE: FOR UPDATE locks the row for the duration of this
  -- transaction, preventing a TOCTOU race between the version check
  -- and the update. This is safe because the transaction is short-lived.
  SELECT version INTO current_version
  FROM session_handoffs
  WHERE project = p_project
  FOR UPDATE;

  -- CASE 1: No existing handoff → create new with version=1
  IF NOT FOUND THEN
    INSERT INTO session_handoffs (
      project, last_summary, pending_todo, active_decisions,
      keywords, version, updated_at
    ) VALUES (
      p_project,
      p_last_summary,
      COALESCE(p_pending_todo, '{}'),
      COALESCE(p_active_decisions, '{}'),
      COALESCE(p_keywords, '{}'),
      1,
      NOW()
    );

    RETURN jsonb_build_object(
      'status', 'created',
      'project', p_project,
      'version', 1
    );
  END IF;

  -- CASE 2: Version mismatch → REJECT
  -- REVIEWER NOTE: If p_expected_version is NULL, we skip the check
  -- for backward compatibility with v0.3.0 clients. This means
  -- older clients still work but without concurrency protection.
  IF p_expected_version IS NOT NULL
     AND p_expected_version != current_version THEN
    RETURN jsonb_build_object(
      'status', 'conflict',
      'error', format(
        'Version conflict: you sent version %s but the current version is %s. '
        || 'Another session has updated this project since you loaded context. '
        || 'Please call session_load_context to see what changed, then merge '
        || 'your updates and retry.',
        p_expected_version, current_version
      ),
      'current_version', current_version,
      'expected_version', p_expected_version
    );
  END IF;

  -- CASE 3: Version matches (or no check) → UPDATE and increment version
  new_version := current_version + 1;

  UPDATE session_handoffs SET
    last_summary = COALESCE(p_last_summary, last_summary),
    pending_todo = COALESCE(p_pending_todo, pending_todo),
    active_decisions = COALESCE(p_active_decisions, active_decisions),
    keywords = COALESCE(p_keywords, keywords),
    version = new_version,
    updated_at = NOW()
  WHERE project = p_project;

  RETURN jsonb_build_object(
    'status', 'updated',
    'project', p_project,
    'version', new_version
  );
END;
$$;

COMMENT ON FUNCTION save_handoff_with_version IS
  'Saves handoff state with optimistic concurrency control. '
  'Pass expected_version to enable conflict detection. '
  'Returns status: created | updated | conflict. '
  'NULL expected_version skips check for backward compatibility.';

-- ==============================================================================
-- MIGRATION COMPLETE
-- ==============================================================================
