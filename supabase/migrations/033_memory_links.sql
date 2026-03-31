-- Migration 033: Associative Memory Graph (Memory Links)
-- Brings Supabase backend into full structural parity with SQLite (Phase 3)

BEGIN;

CREATE TABLE IF NOT EXISTS public.memory_links (
    source_id UUID NOT NULL REFERENCES public.session_ledger(id) ON DELETE CASCADE,
    target_id UUID NOT NULL REFERENCES public.session_ledger(id) ON DELETE CASCADE,
    link_type TEXT NOT NULL,
    strength REAL DEFAULT 1.0 CHECK (strength >= 0.0 AND strength <= 1.0),
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT now(),
    last_traversed_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (source_id, target_id, link_type)
);

-- Reverse lookup index
CREATE INDEX IF NOT EXISTS idx_mem_links_target ON public.memory_links(target_id);
-- Filter by link type index
CREATE INDEX IF NOT EXISTS idx_mem_links_type ON public.memory_links(link_type);
-- Decay queries index
CREATE INDEX IF NOT EXISTS idx_mem_links_traversed ON public.memory_links(last_traversed_at);

-- RLS: Follow established pattern from migration 020 — permissive policies
-- with application-level user_id enforcement via RPC parameters.
-- Prism does NOT use auth.uid() (see migration 020 comments).
ALTER TABLE public.memory_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "memory_links_all" ON public.memory_links;
CREATE POLICY "memory_links_all" ON public.memory_links
    FOR ALL
    USING (true)
    WITH CHECK (true);

-- RPC for keyword overlap calculation
-- NOTE: session_ledger.keywords is TEXT[] (native Postgres array), not JSONB.
-- Use unnest() not jsonb_array_elements_text().
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

-- RPC for prune excess links (composite PK — no single `id` column)
CREATE OR REPLACE FUNCTION public.prism_prune_excess_links(
    p_entry_id UUID,
    p_link_type TEXT,
    p_max_links INTEGER DEFAULT 25
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    DELETE FROM public.memory_links ml
    WHERE ml.source_id = p_entry_id AND ml.link_type = p_link_type
      AND NOT EXISTS (
        SELECT 1 FROM (
          SELECT source_id, target_id, link_type
          FROM public.memory_links
          WHERE source_id = p_entry_id AND link_type = p_link_type
          ORDER BY strength DESC, last_traversed_at DESC
          LIMIT p_max_links
        ) keep
        WHERE keep.source_id = ml.source_id
          AND keep.target_id = ml.target_id
          AND keep.link_type = ml.link_type
      );
END;
$$;

-- RPC for reinforce link
CREATE OR REPLACE FUNCTION public.prism_reinforce_link(
    p_source_id UUID,
    p_target_id UUID,
    p_link_type TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE public.memory_links
    SET strength = LEAST(strength + 0.1, 1.0),
        last_traversed_at = now()
    WHERE source_id = p_source_id AND target_id = p_target_id AND link_type = p_link_type;
END;
$$;

-- RPC for decay links
CREATE OR REPLACE FUNCTION public.prism_decay_links(
    p_older_than_days INTEGER
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_rows_affected INTEGER;
BEGIN
    WITH updated AS (
        UPDATE public.memory_links
        SET strength = GREATEST(strength - 0.05, 0.0)
        WHERE last_traversed_at < now() - (p_older_than_days || ' days')::interval
          AND link_type IN ('related_to')
        RETURNING 1
    )
    SELECT COUNT(*) INTO v_rows_affected FROM updated;
    
    RETURN v_rows_affected;
END;
$$;

-- RPC for backfill links
CREATE OR REPLACE FUNCTION public.prism_backfill_links(
    p_project TEXT
)
RETURNS TABLE (temporal INTEGER, keyword INTEGER, provenance INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_temporal INTEGER := 0;
    v_keyword INTEGER := 0;
    v_provenance INTEGER := 0;
    v_rev_count INTEGER := 0;
BEGIN
    -- Strategy 1: Temporal
    INSERT INTO public.memory_links (source_id, target_id, link_type, strength, metadata)
    SELECT
        id AS source_id,
        next_id AS target_id,
        'temporal_next' AS link_type,
        1.0 AS strength,
        jsonb_build_object('backfill', 'temporal', 'conversation_id', conversation_id) AS metadata
    FROM (
        SELECT
            id,
            conversation_id,
            LEAD(id) OVER (
            PARTITION BY conversation_id
            ORDER BY created_at ASC
            ) AS next_id
        FROM public.session_ledger
        WHERE project = p_project
            AND deleted_at IS NULL
            AND conversation_id IS NOT NULL
            AND conversation_id != ''
    ) AS temp
    WHERE next_id IS NOT NULL
    ON CONFLICT (source_id, target_id, link_type) DO NOTHING;
    
    GET DIAGNOSTICS v_temporal = ROW_COUNT;

    -- Strategy 2: Keyword overlap (uses unnest for TEXT[] columns)
    INSERT INTO public.memory_links (source_id, target_id, link_type, strength, metadata)
    SELECT
        a_id AS source_id,
        b_id AS target_id,
        'related_to' AS link_type,
        LEAST(0.3 + (shared_count * 0.1), 1.0) AS strength,
        jsonb_build_object('backfill', 'keyword', 'shared_keywords', shared_count) AS metadata
    FROM (
        SELECT
            a.id AS a_id,
            b.id AS b_id,
            COUNT(DISTINCT ja.value) AS shared_count
        FROM public.session_ledger a
        CROSS JOIN unnest(a.keywords) AS ja(value)
        JOIN public.session_ledger b ON b.project = p_project AND b.deleted_at IS NULL AND b.archived_at IS NULL
        CROSS JOIN unnest(b.keywords) AS jb(value)
        WHERE a.project = p_project
            AND a.deleted_at IS NULL
            AND a.archived_at IS NULL
            AND a.id < b.id
            AND a.keywords IS NOT NULL
            AND b.keywords IS NOT NULL
            AND ja.value = jb.value
        GROUP BY a.id, b.id
        HAVING COUNT(DISTINCT ja.value) >= 3
    ) AS kw
    ON CONFLICT (source_id, target_id, link_type) DO NOTHING;
    
    GET DIAGNOSTICS v_keyword = ROW_COUNT;

    -- Reverse edges for bidirectional related_to
    INSERT INTO public.memory_links (source_id, target_id, link_type, strength, metadata)
    SELECT
        b_id AS source_id,
        a_id AS target_id,
        'related_to' AS link_type,
        LEAST(0.3 + (shared_count * 0.1), 1.0) AS strength,
        jsonb_build_object('backfill', 'keyword_reverse', 'shared_keywords', shared_count) AS metadata
    FROM (
        SELECT
            a.id AS a_id,
            b.id AS b_id,
            COUNT(DISTINCT ja.value) AS shared_count
        FROM public.session_ledger a
        CROSS JOIN unnest(a.keywords) AS ja(value)
        JOIN public.session_ledger b ON b.project = p_project AND b.deleted_at IS NULL AND b.archived_at IS NULL
        CROSS JOIN unnest(b.keywords) AS jb(value)
        WHERE a.project = p_project
            AND a.deleted_at IS NULL
            AND a.archived_at IS NULL
            AND a.id < b.id
            AND a.keywords IS NOT NULL
            AND b.keywords IS NOT NULL
            AND ja.value = jb.value
        GROUP BY a.id, b.id
        HAVING COUNT(DISTINCT ja.value) >= 3
    ) AS kw_rev
    ON CONFLICT (source_id, target_id, link_type) DO NOTHING;
    
    GET DIAGNOSTICS v_rev_count = ROW_COUNT;
    v_keyword := v_keyword + v_rev_count;

    -- Strategy 3: Provenance
    INSERT INTO public.memory_links (source_id, target_id, link_type, strength, metadata)
    SELECT
        rollup.id AS source_id,
        archived.id AS target_id,
        'spawned_from' AS link_type,
        0.8 AS strength,
        jsonb_build_object('backfill', 'provenance') AS metadata
    FROM public.session_ledger rollup
    JOIN public.session_ledger archived
        ON archived.project = rollup.project
        AND archived.archived_at IS NOT NULL
        AND archived.deleted_at IS NULL
        AND EXTRACT(EPOCH FROM ABS(archived.archived_at - rollup.created_at)) < 300
    WHERE rollup.project = p_project
        AND rollup.deleted_at IS NULL
        AND rollup.summary LIKE '%[ROLLUP]%'
    ON CONFLICT (source_id, target_id, link_type) DO NOTHING;
    
    GET DIAGNOSTICS v_provenance = ROW_COUNT;

    RETURN QUERY SELECT v_temporal, v_keyword, v_provenance;
END;
$$;

COMMIT;
