-- Migration 035: tenant-safe MemoryLinks writes + strict table access policy
BEGIN;

-- -------------------------------------------------------------------
-- Patch: Ensure deleted_reason exists before creating dependent RPCs
-- -------------------------------------------------------------------
ALTER TABLE public.session_ledger
  ADD COLUMN IF NOT EXISTS deleted_reason TEXT DEFAULT NULL;

-- -------------------------------------------------------------------
-- Preconditions: memory_links uses composite PK (source_id,target_id,link_type)
-- -------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints tc
    WHERE tc.table_schema = 'public'
      AND tc.table_name = 'memory_links'
      AND tc.constraint_type = 'PRIMARY KEY'
  ) THEN
    RAISE EXCEPTION 'memory_links PK not found';
  END IF;
END $$;

-- -------------------------------------------------------------------
-- Helper: enforce tenant ownership + visible (not deleted) ledger entry
-- -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prism_assert_ledger_owner(
  p_user_id TEXT,
  p_entry_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_id IS NULL OR btrim(p_user_id) = '' THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;

  IF p_entry_id IS NULL THEN
    RAISE EXCEPTION 'p_entry_id is required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.session_ledger sl
    WHERE sl.id = p_entry_id
      AND sl.user_id = p_user_id
      AND sl.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Tenant ownership/visibility check failed for entry %', p_entry_id;
  END IF;
END;
$$;

-- -------------------------------------------------------------------
-- Tenant-safe create/upsert link
-- -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prism_create_link(
  p_user_id TEXT,
  p_source_id UUID,
  p_target_id UUID,
  p_link_type TEXT,
  p_strength REAL DEFAULT 1.0,
  p_metadata JSONB DEFAULT NULL
)
RETURNS TABLE (
  source_id UUID,
  target_id UUID,
  link_type TEXT,
  strength REAL,
  metadata JSONB,
  created_at TIMESTAMPTZ,
  last_traversed_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_strength REAL := GREATEST(0.0, LEAST(COALESCE(p_strength, 1.0), 1.0));
BEGIN
  IF p_link_type IS NULL OR btrim(p_link_type) = '' THEN
    RAISE EXCEPTION 'p_link_type is required';
  END IF;

  PERFORM public.prism_assert_ledger_owner(p_user_id, p_source_id);
  PERFORM public.prism_assert_ledger_owner(p_user_id, p_target_id);

  INSERT INTO public.memory_links (
    source_id, target_id, link_type, strength, metadata
  )
  VALUES (
    p_source_id, p_target_id, p_link_type, v_strength, p_metadata
  )
  ON CONFLICT (source_id, target_id, link_type)
  DO UPDATE SET
    strength = EXCLUDED.strength,
    metadata = EXCLUDED.metadata,
    last_traversed_at = now();

  RETURN QUERY
  SELECT m.source_id, m.target_id, m.link_type, m.strength, m.metadata, m.created_at, m.last_traversed_at
  FROM public.memory_links m
  WHERE m.source_id = p_source_id
    AND m.target_id = p_target_id
    AND m.link_type = p_link_type;
END;
$$;

-- -------------------------------------------------------------------
-- Tenant-safe delete by composite key
-- -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prism_delete_link(
  p_user_id TEXT,
  p_source_id UUID,
  p_target_id UUID,
  p_link_type TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER := 0;
BEGIN
  PERFORM public.prism_assert_ledger_owner(p_user_id, p_source_id);
  PERFORM public.prism_assert_ledger_owner(p_user_id, p_target_id);

  DELETE FROM public.memory_links ml
  WHERE ml.source_id = p_source_id
    AND ml.target_id = p_target_id
    AND ml.link_type = p_link_type;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END;
$$;

-- -------------------------------------------------------------------
-- Optional admin restore/trash helper (for restore-path gate)
-- -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_get_deleted_entries(
  p_user_id TEXT,
  p_project TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 100
)
RETURNS TABLE (
  id UUID,
  project TEXT,
  summary TEXT,
  deleted_at TIMESTAMPTZ,
  deleted_reason TEXT,
  created_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT sl.id, sl.project, sl.summary, sl.deleted_at, sl.deleted_reason, sl.created_at
  FROM public.session_ledger sl
  WHERE sl.user_id = p_user_id
    AND sl.deleted_at IS NOT NULL
    AND (p_project IS NULL OR sl.project = p_project)
  ORDER BY sl.deleted_at DESC
  LIMIT GREATEST(1, LEAST(p_limit, 1000));
$$;

-- -------------------------------------------------------------------
-- Tighten table access: deny direct memory_links table usage for clients
-- (service_role can still use SECURITY DEFINER RPCs)
-- -------------------------------------------------------------------
ALTER TABLE public.memory_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS memory_links_all ON public.memory_links;

CREATE POLICY memory_links_no_direct_select
ON public.memory_links
FOR SELECT
USING (false);

CREATE POLICY memory_links_no_direct_insert
ON public.memory_links
FOR INSERT
WITH CHECK (false);

CREATE POLICY memory_links_no_direct_update
ON public.memory_links
FOR UPDATE
USING (false)
WITH CHECK (false);

CREATE POLICY memory_links_no_direct_delete
ON public.memory_links
FOR DELETE
USING (false);

COMMENT ON TABLE public.memory_links IS
'Direct table access denied. Use prism_* SECURITY DEFINER RPCs.';

-- -------------------------------------------------------------------
-- GRANT EXECUTE: Allow service_role + authenticated to call RPCs
-- -------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.prism_assert_ledger_owner(TEXT, UUID) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.prism_create_link(TEXT, UUID, UUID, TEXT, REAL, JSONB) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.prism_delete_link(TEXT, UUID, UUID, TEXT) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_deleted_entries(TEXT, TEXT, INTEGER) TO service_role;  -- admin only

-- -------------------------------------------------------------------
-- Part D — Soft-delete filtering in read RPCs
-- -------------------------------------------------------------------
-- get_session_context: add `AND sl.deleted_at IS NULL` to ALL
-- session_ledger queries (hot_keywords, top_categories, deep entries,
-- cross-project). Currently only archived_at is checked in some paths.
-- search_knowledge: add `AND sl.deleted_at IS NULL` to ledger query.
-- -------------------------------------------------------------------

-- Drop old signatures to replace cleanly
DROP FUNCTION IF EXISTS get_session_context(TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS search_knowledge(TEXT, TEXT[], TEXT, TEXT, INT, TEXT);

-- Recreate get_session_context with full soft-delete filtering
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

        -- HARDENED: added deleted_at IS NULL (was missing pre-035)
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

        -- HARDENED: added deleted_at IS NULL
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

        -- HARDENED: added deleted_at IS NULL
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
    END IF;

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
              AND sl.deleted_at IS NULL
              AND sl.archived_at IS NULL
            ORDER BY sl.created_at DESC
            LIMIT 5
        ) sub;

        result := result || jsonb_build_object(
            'recent_sessions', ledger_entries
        );

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
    'behavioral warnings, and full GDPR soft-delete filtering (migration 035).';

-- Recreate search_knowledge with full soft-delete filtering
CREATE OR REPLACE FUNCTION search_knowledge(
    p_project TEXT DEFAULT NULL,
    p_keywords TEXT[] DEFAULT '{}',
    p_category TEXT DEFAULT NULL,
    p_query_text TEXT DEFAULT NULL,
    p_limit INT DEFAULT 10,
    p_user_id TEXT DEFAULT 'default'
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    results JSONB;
    search_keywords TEXT[];
BEGIN
    search_keywords := p_keywords;

    IF p_category IS NOT NULL AND p_category != '' THEN
        search_keywords := search_keywords || ARRAY['cat:' || p_category];
    END IF;

    SELECT COALESCE(jsonb_agg(entry ORDER BY entry->>'relevance_score' DESC), '[]'::jsonb)
    INTO results
    FROM (
        SELECT jsonb_build_object(
            'source', 'ledger',
            'project', sl.project,
            'summary', sl.summary,
            'keywords', to_jsonb(sl.keywords),
            'decisions', to_jsonb(sl.decisions),
            'files_changed', to_jsonb(sl.files_changed),
            'date', sl.session_date,
            'created_at', sl.created_at,
            'relevance_score', (
                CASE WHEN array_length(search_keywords, 1) > 0
                    THEN (SELECT COUNT(*) FROM unnest(sl.keywords) k WHERE k = ANY(search_keywords))
                    ELSE 0
                END
                +
                CASE WHEN p_query_text IS NOT NULL AND p_query_text != ''
                     AND to_tsvector('english', sl.summary) @@ plainto_tsquery('english', p_query_text)
                    THEN 5
                    ELSE 0
                END
            )
        ) AS entry
        FROM session_ledger sl
        WHERE
            sl.user_id = p_user_id
            AND (p_project IS NULL OR sl.project = p_project)
            AND sl.deleted_at IS NULL   -- HARDENED: was missing pre-035
            AND sl.archived_at IS NULL
            AND (
                (array_length(search_keywords, 1) > 0 AND sl.keywords && search_keywords)
                OR
                (p_query_text IS NOT NULL AND p_query_text != ''
                 AND to_tsvector('english', sl.summary) @@ plainto_tsquery('english', p_query_text))
            )

        UNION ALL

        SELECT jsonb_build_object(
            'source', 'handoff',
            'project', sh.project,
            'summary', COALESCE(sh.last_summary, ''),
            'keywords', to_jsonb(sh.keywords),
            'decisions', to_jsonb(sh.active_decisions),
            'updated_at', sh.updated_at,
            'relevance_score', (
                CASE WHEN array_length(search_keywords, 1) > 0
                    THEN (SELECT COUNT(*) FROM unnest(sh.keywords) k WHERE k = ANY(search_keywords))
                    ELSE 0
                END
                +
                CASE WHEN p_query_text IS NOT NULL AND p_query_text != ''
                     AND sh.last_summary IS NOT NULL
                     AND to_tsvector('english', sh.last_summary) @@ plainto_tsquery('english', p_query_text)
                    THEN 5
                    ELSE 0
                END
            )
        ) AS entry
        FROM session_handoffs sh
        WHERE
            sh.user_id = p_user_id
            AND (p_project IS NULL OR sh.project = p_project)
            AND (
                (array_length(search_keywords, 1) > 0 AND sh.keywords && search_keywords)
                OR
                (p_query_text IS NOT NULL AND p_query_text != ''
                 AND sh.last_summary IS NOT NULL
                 AND to_tsvector('english', sh.last_summary) @@ plainto_tsquery('english', p_query_text))
            )
    ) sub
    WHERE (sub.entry->>'relevance_score')::int > 0
    LIMIT p_limit;

    RETURN jsonb_build_object(
        'results', results,
        'count', jsonb_array_length(results),
        'search_keywords', to_jsonb(search_keywords),
        'query_text', p_query_text
    );
END;
$$;

COMMENT ON FUNCTION search_knowledge(TEXT, TEXT[], TEXT, TEXT, INT, TEXT) IS
    'Search accumulated session knowledge with multi-tenant isolation and '
    'full GDPR soft-delete filtering (migration 035).';

-- Recreate find_keyword_overlap_entries with soft-delete filtering
CREATE OR REPLACE FUNCTION public.find_keyword_overlap_entries(
    p_exclude_id UUID,
    p_project TEXT,
    p_keywords TEXT[],
    p_user_id TEXT,
    p_min_shared_keywords INTEGER DEFAULT 3,
    p_limit INTEGER DEFAULT 10
)
RETURNS TABLE (
    id UUID,
    shared_count BIGINT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT sl.id, COUNT(DISTINCT input_kw.kw) AS shared_count
    FROM public.session_ledger sl
    CROSS JOIN unnest(sl.keywords) AS stored_kw(value)
    INNER JOIN unnest(p_keywords) AS input_kw(kw) ON stored_kw.value = input_kw.kw
    WHERE sl.user_id = p_user_id
      AND sl.project = p_project
      AND sl.id != p_exclude_id
      AND sl.deleted_at IS NULL
      AND sl.archived_at IS NULL
    GROUP BY sl.id
    HAVING COUNT(DISTINCT input_kw.kw) >= p_min_shared_keywords
    ORDER BY shared_count DESC
    LIMIT p_limit;
$$;

-- Grant execute on hardened read RPCs
GRANT EXECUTE ON FUNCTION get_session_context(TEXT, TEXT, TEXT, TEXT) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION search_knowledge(TEXT, TEXT[], TEXT, TEXT, INT, TEXT) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION find_keyword_overlap_entries(UUID, TEXT, TEXT[], TEXT, INTEGER, INTEGER) TO service_role, authenticated;

COMMIT;
