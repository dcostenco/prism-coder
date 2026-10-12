-- ==============================================================================
-- CONSOLIDATED MIGRATION: 016 → 020
-- ==============================================================================
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- This brings the DB from migration 015 (base session memory) to 020 (multi-tenant).
--
-- PREREQUISITES:
--   ✅ Migration 015 already applied (session_ledger + session_handoffs exist)
--   ✅ pgvector extension available (Supabase Dashboard → Database → Extensions → "vector")
--
-- IDEMPOTENT: Safe to run multiple times (uses IF NOT EXISTS, CREATE OR REPLACE)
-- ==============================================================================


-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- MIGRATION 016: Knowledge Accumulation
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

-- GIN indexes for fast keyword array-overlap queries
CREATE INDEX IF NOT EXISTS idx_ledger_keywords
    ON session_ledger USING GIN (keywords);

CREATE INDEX IF NOT EXISTS idx_handoffs_keywords
    ON session_handoffs USING GIN (keywords);

-- Full-text search on summaries
CREATE INDEX IF NOT EXISTS idx_ledger_summary_fts
    ON session_ledger USING GIN (to_tsvector('english', summary));

-- search_knowledge() RPC
CREATE OR REPLACE FUNCTION search_knowledge(
    p_project TEXT DEFAULT NULL,
    p_keywords TEXT[] DEFAULT '{}',
    p_category TEXT DEFAULT NULL,
    p_query_text TEXT DEFAULT NULL,
    p_limit INT DEFAULT 10
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    search_keywords TEXT[];
    results JSONB;
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
            (p_project IS NULL OR sl.project = p_project)
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
            (p_project IS NULL OR sh.project = p_project)
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

COMMENT ON FUNCTION search_knowledge IS
    'Search accumulated session knowledge by keywords, category, or free text. '
    'Uses GIN indexes for fast array-overlap and full-text search queries.';


-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- MIGRATION 017: Ledger Auto-Compaction
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ALTER TABLE session_ledger
  ADD COLUMN IF NOT EXISTS is_rollup BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS rollup_count INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_ledger_active
  ON session_ledger(project, created_at DESC)
  WHERE archived_at IS NULL;


-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- MIGRATION 018: Semantic Search via pgvector
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

-- Enable pgvector extension (safe if already enabled)
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE session_ledger
  ADD COLUMN IF NOT EXISTS embedding vector(768);

CREATE INDEX IF NOT EXISTS idx_ledger_embedding
  ON session_ledger
  USING hnsw (embedding vector_cosine_ops);


-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- MIGRATION 019: Optimistic Concurrency Control
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ALTER TABLE session_handoffs
  ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;


-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- MIGRATION 020: Multi-Tenant Row Level Security
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

-- Add user_id columns
ALTER TABLE session_ledger
  ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT 'default';

ALTER TABLE session_handoffs
  ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT 'default';

-- Composite indexes
CREATE INDEX IF NOT EXISTS idx_ledger_user_project
  ON session_ledger(user_id, project, created_at DESC)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_handoffs_user_project
  ON session_handoffs(user_id, project);

-- Update unique constraint on session_handoffs
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'session_handoffs'::regclass
      AND contype = 'u'
      AND array_length(conkey, 1) = 1
  ) THEN
    EXECUTE (
      SELECT 'ALTER TABLE session_handoffs DROP CONSTRAINT ' || conname
      FROM pg_constraint
      WHERE conrelid = 'session_handoffs'::regclass
        AND contype = 'u'
        AND array_length(conkey, 1) = 1
      LIMIT 1
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

ALTER TABLE session_handoffs
  ADD CONSTRAINT uq_handoffs_user_project UNIQUE (user_id, project);


-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- FINAL: Replace ALL RPC functions with v1.5.0 multi-tenant versions
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

-- Drop old function signatures first to avoid overload conflicts
DROP FUNCTION IF EXISTS get_session_context(TEXT, TEXT);
DROP FUNCTION IF EXISTS save_handoff_with_version(TEXT, INT, TEXT, TEXT[], TEXT[], TEXT[], TEXT, TEXT);
DROP FUNCTION IF EXISTS get_compaction_candidates(INT, INT);
DROP FUNCTION IF EXISTS semantic_search_ledger(vector, TEXT, INT, FLOAT);

-- get_session_context (3-param: p_project, p_level, p_user_id)
CREATE OR REPLACE FUNCTION get_session_context(
    p_project TEXT DEFAULT 'default',
    p_level TEXT DEFAULT 'standard',
    p_user_id TEXT DEFAULT 'default'
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
    SELECT * INTO handoff
    FROM session_handoffs
    WHERE project = p_project
      AND user_id = p_user_id;

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

COMMENT ON FUNCTION get_session_context IS
    'Progressive context loading with OCC, knowledge cache, and multi-tenant isolation. '
    'v1.5.0: user_id scopes all queries to a single tenant. '
    'quick=keywords+todo+version, standard=+summary+decisions+cache, '
    'deep=+recent sessions+cross-project knowledge (same user only).';

-- save_handoff_with_version (9-param with p_user_id)
CREATE OR REPLACE FUNCTION save_handoff_with_version(
  p_project TEXT,
  p_expected_version INT DEFAULT NULL,
  p_last_summary TEXT DEFAULT NULL,
  p_pending_todo TEXT[] DEFAULT NULL,
  p_active_decisions TEXT[] DEFAULT NULL,
  p_keywords TEXT[] DEFAULT NULL,
  p_key_context TEXT DEFAULT NULL,
  p_active_branch TEXT DEFAULT NULL,
  p_user_id TEXT DEFAULT 'default'
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  current_version INT;
  new_version INT;
BEGIN
  SELECT version INTO current_version
  FROM session_handoffs
  WHERE project = p_project
    AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO session_handoffs (
      project, user_id, last_summary, pending_todo, active_decisions,
      keywords, version, updated_at
    ) VALUES (
      p_project,
      p_user_id,
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

  IF p_expected_version IS NOT NULL
     AND p_expected_version != current_version THEN
    RETURN jsonb_build_object(
      'status', 'conflict',
      'error', format(
        'Version conflict: you sent version %s but the current version is %s.',
        p_expected_version, current_version
      ),
      'current_version', current_version,
      'expected_version', p_expected_version
    );
  END IF;

  new_version := current_version + 1;

  UPDATE session_handoffs SET
    last_summary = COALESCE(p_last_summary, last_summary),
    pending_todo = COALESCE(p_pending_todo, pending_todo),
    active_decisions = COALESCE(p_active_decisions, active_decisions),
    keywords = COALESCE(p_keywords, keywords),
    version = new_version,
    updated_at = NOW()
  WHERE project = p_project
    AND user_id = p_user_id;

  RETURN jsonb_build_object(
    'status', 'updated',
    'project', p_project,
    'version', new_version
  );
END;
$$;

COMMENT ON FUNCTION save_handoff_with_version IS
  'OCC handoff save with multi-tenant isolation. '
  'Scoped by user_id + project. '
  'Returns: created | updated | conflict.';

-- get_compaction_candidates (3-param with p_user_id)
CREATE OR REPLACE FUNCTION get_compaction_candidates(
  p_threshold INT DEFAULT 50,
  p_keep_recent INT DEFAULT 10,
  p_user_id TEXT DEFAULT 'default'
) RETURNS TABLE(project TEXT, total_entries BIGINT, to_compact BIGINT)
LANGUAGE sql
AS $$
  SELECT
    sl.project,
    COUNT(*) AS total_entries,
    COUNT(*) - p_keep_recent AS to_compact
  FROM session_ledger sl
  WHERE sl.archived_at IS NULL
    AND sl.is_rollup = FALSE
    AND sl.user_id = p_user_id
  GROUP BY sl.project
  HAVING COUNT(*) > p_threshold;
$$;

COMMENT ON FUNCTION get_compaction_candidates IS
  'Finds projects needing compaction, scoped to a single user_id.';

-- semantic_search_ledger (5-param with p_user_id)
CREATE OR REPLACE FUNCTION semantic_search_ledger(
  p_query_embedding vector(768),
  p_project TEXT DEFAULT NULL,
  p_limit INT DEFAULT 5,
  p_similarity_threshold FLOAT DEFAULT 0.7,
  p_user_id TEXT DEFAULT 'default'
) RETURNS TABLE(
  id UUID,
  project TEXT,
  summary TEXT,
  decisions TEXT[],
  files_changed TEXT[],
  session_date DATE,
  created_at TIMESTAMPTZ,
  similarity FLOAT
)
LANGUAGE sql
AS $$
  SELECT
    sl.id,
    sl.project,
    sl.summary,
    sl.decisions,
    sl.files_changed,
    sl.session_date,
    sl.created_at,
    1 - (sl.embedding <=> p_query_embedding) AS similarity
  FROM session_ledger sl
  WHERE sl.embedding IS NOT NULL
    AND sl.user_id = p_user_id
    AND (p_project IS NULL OR sl.project = p_project)
    AND sl.archived_at IS NULL
    AND 1 - (sl.embedding <=> p_query_embedding) >= p_similarity_threshold
  ORDER BY sl.embedding <=> p_query_embedding
  LIMIT p_limit;
$$;

COMMENT ON FUNCTION semantic_search_ledger IS
  'Semantic search with multi-tenant isolation. '
  'Results scoped to p_user_id.';

-- Enable RLS
ALTER TABLE session_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_handoffs ENABLE ROW LEVEL SECURITY;

-- RLS policies (permissive — enforcement is at app level via p_user_id)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'ledger_user_isolation' AND tablename = 'session_ledger') THEN
    CREATE POLICY "ledger_user_isolation" ON session_ledger FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'handoffs_user_isolation' AND tablename = 'session_handoffs') THEN
    CREATE POLICY "handoffs_user_isolation" ON session_handoffs FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ==============================================================================
-- AUTO-MIGRATION INFRASTRUCTURE (enables automatic schema updates)
-- ==============================================================================

-- Migration version tracking
CREATE TABLE IF NOT EXISTS prism_schema_versions (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE prism_schema_versions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Service role full access' AND tablename = 'prism_schema_versions') THEN
    CREATE POLICY "Service role full access" ON prism_schema_versions FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Authenticated read access' AND tablename = 'prism_schema_versions') THEN
    CREATE POLICY "Authenticated read access" ON prism_schema_versions FOR SELECT TO authenticated, anon USING (true);
  END IF;
END $$;

-- DDL execution function (SECURITY DEFINER)
-- The automatic upgrader must never execute caller-supplied SQL for tenant clients.
CREATE OR REPLACE FUNCTION public.prism_apply_ddl(p_version integer, p_name text, p_sql text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE existing_name text;
BEGIN
    IF p_version IS NULL OR p_version < 1 OR p_name IS NULL OR length(btrim(p_name)) = 0
       OR p_sql IS NULL OR length(btrim(p_sql)) = 0 THEN
        RAISE EXCEPTION 'Invalid migration identity or SQL' USING ERRCODE = '22023';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('prism_apply_ddl'));
    SELECT name INTO existing_name FROM public.prism_schema_versions WHERE version = p_version;
    IF FOUND THEN
        IF existing_name IS DISTINCT FROM p_name THEN
            RAISE EXCEPTION 'Migration version/name conflict' USING ERRCODE = '22023';
        END IF;
        RETURN json_build_object('status','already_applied','version',p_version,'name',p_name);
    END IF;
    EXECUTE p_sql;
    INSERT INTO public.prism_schema_versions(version,name) VALUES (p_version,p_name);
    RETURN json_build_object('status','applied','version',p_version,'name',p_name);
END;
$$;
REVOKE ALL ON FUNCTION public.prism_apply_ddl(integer,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prism_apply_ddl(integer,text,text) TO service_role;

-- ==============================================================================
-- ALL MIGRATIONS (016–020) + AUTO-MIGRATION INFRA COMPLETE ✅
-- ==============================================================================
