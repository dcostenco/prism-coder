-- ==============================================================================
-- MIGRATION 018: Semantic Search via pgvector (Enhancement #4)
-- ==============================================================================
-- REVIEWER NOTE: This adds vector embedding support to session_ledger
-- for meaning-based (semantic) search.
--
-- WHAT THIS SOLVES:
--   v0.3.0's knowledge_search uses keyword overlap + full-text search.
--   Great for exact matches, but fails when the user's phrasing doesn't
--   match stored keywords. Example:
--     User asks: "that weird API key error we fixed last week"
--     Stored summary: "Resolved authentication failure by rotating credentials"
--     → Keyword search: MISS (no shared keywords)
--     → Semantic search: HIT (meaning overlap is high)
--
-- PREREQUISITES:
--   pgvector extension must be enabled in Supabase Dashboard:
--   Database → Extensions → toggle on "vector"
--   (one-click, no downtime required)
--
-- DESIGN DECISIONS:
--   1. 768 dimensions — matches Gemini's text-embedding-004 model output
--   2. HNSW index instead of IVFFlat — critical for small/growing tables.
--      IVFFlat computes centroids at index creation time; if created on
--      an empty table, those centroids are permanently inaccurate.
--      HNSW builds dynamically as rows are added — no cold start problem.
--   3. Cosine distance (<=> operator) — scale-invariant, best for text embeddings
--   4. NULL default on embedding column — existing entries work fine without
--      embeddings; the search function gracefully excludes them
-- ==============================================================================

-- Enable pgvector extension (idempotent — safe if already enabled)
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column to session_ledger
-- REVIEWER NOTE: 768 dimensions matches Gemini text-embedding-004 output.
-- NULL by default — existing (pre-v0.4.0) entries won't have embeddings
-- until manually backfilled. The semantic search function handles this
-- gracefully by filtering WHERE embedding IS NOT NULL.
ALTER TABLE session_ledger
  ADD COLUMN IF NOT EXISTS embedding vector(768);

-- Create HNSW index for fast approximate nearest neighbor search
-- REVIEWER NOTE: HNSW chosen over IVFFlat because:
--   1. No cold-start problem (IVFFlat needs representative data at creation)
--   2. Better recall accuracy for small datasets (<100K entries)
--   3. Dynamic — adapts as rows are added without manual reindexing
--   4. Supabase has full HNSW support since pgvector 0.5.0
CREATE INDEX IF NOT EXISTS idx_ledger_embedding
  ON session_ledger
  USING hnsw (embedding vector_cosine_ops);

-- RPC: semantic_search_ledger()
-- REVIEWER NOTE: This function takes a pre-computed query embedding
-- (generated server-side via Gemini's text-embedding-004 model) and
-- returns the top-N most semantically similar ledger entries.
--
-- The similarity score uses: 1 - cosine_distance, giving a 0-1 scale
-- where 1 = identical meaning, 0 = completely unrelated.
--
-- The threshold parameter (default 0.7) filters out low-quality matches.
-- In practice, scores above 0.75 are usually relevant results.
CREATE OR REPLACE FUNCTION semantic_search_ledger(
  p_query_embedding vector(768),
  p_project TEXT DEFAULT NULL,
  p_limit INT DEFAULT 5,
  p_similarity_threshold FLOAT DEFAULT 0.7
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
    -- Cosine similarity: 1 = identical meaning, 0 = unrelated
    -- REVIEWER NOTE: The <=> operator is pgvector's cosine distance.
    -- We subtract from 1 to convert distance → similarity.
    1 - (sl.embedding <=> p_query_embedding) AS similarity
  FROM session_ledger sl
  WHERE sl.embedding IS NOT NULL
    AND (p_project IS NULL OR sl.project = p_project)
    -- Exclude archived (rolled-up) entries from compaction
    AND sl.archived_at IS NULL
    -- Only return results above the similarity threshold
    AND 1 - (sl.embedding <=> p_query_embedding) >= p_similarity_threshold
  ORDER BY sl.embedding <=> p_query_embedding
  LIMIT p_limit;
$$;

COMMENT ON FUNCTION semantic_search_ledger(vector, TEXT, INT, FLOAT) IS
  'Semantic (meaning-based) search of session ledger using pgvector embeddings. '
  'Takes a pre-computed 768-dim query embedding and returns top-N similar entries. '
  'Uses HNSW index for fast approximate nearest neighbor search with cosine distance.';

-- ==============================================================================
-- MIGRATION COMPLETE
-- ==============================================================================
