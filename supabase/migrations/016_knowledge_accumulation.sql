-- ==============================================================================
-- MIGRATION 016: Knowledge Accumulation
-- ==============================================================================
-- Brain-inspired knowledge features for the BCBA MCP server.
-- No new tables — leverages existing keywords TEXT[] columns in
-- session_ledger and session_handoffs (from migration 015).
--
-- This migration adds:
--   1. GIN indexes for fast keyword array-overlap queries
--   2. Full-text search index on summaries
--   3. search_knowledge() RPC — query accumulated knowledge
--   4. Enhanced get_session_context() — knowledge cache preload at boot
-- ==============================================================================

-- =============================================================================
-- PART 1: INDEXES
-- =============================================================================

-- GIN indexes on keywords for fast array-overlap (&&) queries
-- Zero write overhead, sub-millisecond reads
CREATE INDEX IF NOT EXISTS idx_ledger_keywords
    ON session_ledger USING GIN (keywords);

CREATE INDEX IF NOT EXISTS idx_handoffs_keywords
    ON session_handoffs USING GIN (keywords);

-- Full-text search on summaries for keyword-based text retrieval
CREATE INDEX IF NOT EXISTS idx_ledger_summary_fts
    ON session_ledger USING GIN (to_tsvector('english', summary));

-- =============================================================================
-- PART 2: search_knowledge() RPC
-- =============================================================================
-- Searches accumulated session knowledge using multiple strategies:
--   1. Keyword array overlap (fast, uses GIN index)
--   2. Full-text search on summaries (for free-text queries)
--   3. Category filtering via "cat:" prefixed keywords
-- Returns matched entries ranked by relevance (keyword overlap count).

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
        -- Search session_ledger
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

        -- Search session_handoffs
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

COMMENT ON FUNCTION search_knowledge(TEXT, TEXT[], TEXT, TEXT, INT) IS
    'Search accumulated session knowledge by keywords, category, or free text. '
    'Uses GIN indexes for fast array-overlap and full-text search queries.';

-- =============================================================================
-- PART 3: Enhanced get_session_context() — Knowledge Cache Preload
-- =============================================================================
-- Extends the existing progressive context loader with a "knowledge_cache"
-- section that preloads the brain's hottest pathways at session boot:
--   - standard level: adds hot_keywords (top-5 keywords from last 7 days)
--                     and top_categories
--   - deep level:     also adds top-3 most relevant past sessions by keyword overlap

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

    -- standard: + Summary + Decisions + Knowledge Cache (~2000 tokens)
    IF p_level IN ('standard', 'deep') THEN
        result := result || jsonb_build_object(
            'last_title', handoff.last_title,
            'last_summary', handoff.last_summary,
            'active_decisions', to_jsonb(handoff.active_decisions)
        );

        -- Knowledge Cache: hot keywords from last 7 days
        -- Unnest all keywords from recent sessions, count frequency, take top 5
        SELECT ARRAY(
            SELECT kw
            FROM session_ledger sl, unnest(sl.keywords) AS kw
            WHERE sl.project = p_project
              AND sl.created_at >= NOW() - INTERVAL '7 days'
              AND kw NOT LIKE 'cat:%'  -- exclude category tags
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
              AND kw LIKE 'cat:%'
            GROUP BY kw
            ORDER BY COUNT(*) DESC
            LIMIT 3
        ) INTO top_categories;

        -- Count of related sessions (total knowledge entries for this project)
        SELECT COUNT(*) INTO related_count
        FROM session_ledger
        WHERE project = p_project;

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
            ORDER BY sl.created_at DESC
            LIMIT 5
        ) sub;

        result := result || jsonb_build_object(
            'recent_sessions', ledger_entries
        );

        -- Deep knowledge cache: add top-3 most relevant past sessions
        -- from OTHER projects that share keywords with current project
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

COMMENT ON FUNCTION get_session_context(TEXT, TEXT) IS
    'Progressive context loading with knowledge cache. '
    'quick=keywords+todo, standard=+summary+decisions+knowledge_cache, '
    'deep=+recent sessions+cross-project knowledge.';

-- ==============================================================================
-- MIGRATION COMPLETE
-- ==============================================================================
