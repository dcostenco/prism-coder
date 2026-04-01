/**
 * Supabase Auto-Migration Runner (v4.1)
 *
 * On server startup, this module checks the `prism_schema_versions` table
 * and applies any pending DDL migrations via the `prism_apply_ddl` RPC.
 *
 * ═══════════════════════════════════════════════════════════════════
 * HOW IT WORKS:
 *   1. For each migration in MIGRATIONS[], call prism_apply_ddl(version, name, sql)
 *   2. The Postgres function checks if the version is already applied (idempotent)
 *   3. If not applied, it EXECUTE's the SQL and records the version
 *
 * GRACEFUL DEGRADATION:
 *   If prism_apply_ddl doesn't exist (PGRST202), the runner logs a
 *   warning and skips — the server still starts, but v4+ tools may
 *   fail against an old schema.
 *
 * SECURITY NOTE:
 *   prism_apply_ddl is SECURITY DEFINER (runs as postgres owner).
 *   The prism_schema_versions table has RLS: only service_role can write.
 * ═══════════════════════════════════════════════════════════════════
 */

import { supabaseRpc } from "../utils/supabaseApi.js";

// ─── Migration Definitions ───────────────────────────────────────
// Add new migrations here. The version number must be unique and
// monotonically increasing. The SQL must be idempotent (use IF NOT EXISTS).

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * All Supabase DDL migrations.
 *
 * IMPORTANT: Only add migrations for schema changes that Supabase
 * users need. SQLite handles its own schema in sqlite.ts.
 *
 * Each `sql` string is passed to Postgres EXECUTE — it runs as a
 * single transaction. Use IF NOT EXISTS / IF EXISTS guards generously.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 26,
    name: "active_behavioral_memory",
    sql: `
      -- v4.0: Active Behavioral Memory columns
      ALTER TABLE session_ledger ADD COLUMN IF NOT EXISTS event_type TEXT NOT NULL DEFAULT 'session';
      ALTER TABLE session_ledger ADD COLUMN IF NOT EXISTS confidence_score INTEGER DEFAULT NULL;
      ALTER TABLE session_ledger ADD COLUMN IF NOT EXISTS importance INTEGER NOT NULL DEFAULT 0;

      -- Soft-delete / archival columns
      ALTER TABLE session_ledger ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
      ALTER TABLE session_ledger ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ DEFAULT NULL;
      ALTER TABLE session_ledger ADD COLUMN IF NOT EXISTS deleted_reason TEXT DEFAULT NULL;

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_ledger_event_type ON session_ledger(event_type);
      CREATE INDEX IF NOT EXISTS idx_ledger_importance ON session_ledger(importance DESC);

      -- Partial index for high-priority warnings
      CREATE INDEX IF NOT EXISTS idx_ledger_behavioral_warnings
        ON session_ledger(project, user_id, role, importance DESC)
        WHERE event_type = 'correction' AND importance >= 3
          AND deleted_at IS NULL AND archived_at IS NULL;
    `,
  },
  {
    version: 28,
    name: "importance_rpcs",
    sql: `
      -- Fix #4: Atomic importance adjustment — eliminates read-then-write race condition
      CREATE OR REPLACE FUNCTION prism_adjust_importance(
        p_id TEXT, p_user_id TEXT, p_delta INTEGER
      )
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      AS $$
      BEGIN
        UPDATE session_ledger
        SET importance = GREATEST(0, importance + p_delta)
        WHERE id = p_id AND user_id = p_user_id;
      END;
      $$;

      -- Fix #5: Importance decay — parity with SQLite backend
      CREATE OR REPLACE FUNCTION prism_decay_importance(
        p_project TEXT, p_user_id TEXT, p_days INTEGER
      )
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      AS $$
      BEGIN
        UPDATE session_ledger
        SET importance = GREATEST(0, importance - 1)
        WHERE project = p_project
          AND user_id = p_user_id
          AND importance > 0
          AND event_type <> 'session'
          AND created_at < now() - (p_days || ' days')::interval
          AND deleted_at IS NULL
          AND archived_at IS NULL;
      END;
      $$;
    `,
  },
  {
    version: 29,
    name: "turboquant_compressed_embeddings",
    sql: `
      -- v5.0: TurboQuant Compressed Embedding columns
      ALTER TABLE session_ledger ADD COLUMN IF NOT EXISTS embedding_compressed TEXT DEFAULT NULL;
      ALTER TABLE session_ledger ADD COLUMN IF NOT EXISTS embedding_format TEXT DEFAULT NULL;
      ALTER TABLE session_ledger ADD COLUMN IF NOT EXISTS embedding_turbo_radius REAL DEFAULT NULL;
    `,
  },
  {
    // ─── v5.1: Deep Storage Mode — Purge RPC ──────────────────────
    //
    // REVIEWER NOTE: This creates a Postgres function that NULLs out
    // the float32 `embedding` column for entries that already have
    // TurboQuant `embedding_compressed` blobs. This is the Supabase
    // counterpart to SqliteStorage.purgeHighPrecisionEmbeddings().
    //
    // The function enforces the same safety guards as the SQLite impl:
    //   - p_older_than_days >= 7 (recent entries keep full precision)
    //   - embedding_compressed IS NOT NULL (never destroys last copy)
    //   - deleted_at IS NULL (skip tombstoned entries)
    //   - user_id scoping (multi-tenant guard)
    //   - Optional project filter (NULL = all projects)
    //   - Dry-run mode (preview without modifying)
    //
    // After this migration, SupabaseStorage.purgeHighPrecisionEmbeddings()
    // calls this RPC instead of throwing "not supported".
    version: 30,
    name: "deep_storage_purge",
    sql: `
      CREATE OR REPLACE FUNCTION prism_purge_embeddings(
        p_project         TEXT    DEFAULT NULL,
        p_user_id         TEXT    DEFAULT 'default',
        p_older_than_days INTEGER DEFAULT 30,
        p_dry_run         BOOLEAN DEFAULT false
      )
      RETURNS TABLE(eligible INTEGER, purged INTEGER, reclaimed_bytes BIGINT)
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      AS $$
      DECLARE
        v_eligible INTEGER;
        v_bytes    BIGINT;
        v_cutoff   TIMESTAMPTZ;
      BEGIN
        IF p_older_than_days < 7 THEN
          RAISE EXCEPTION 'p_older_than_days must be at least 7 to prevent purging recent entries';
        END IF;

        v_cutoff := now() - (p_older_than_days || ' days')::interval;

        SELECT COUNT(*)::INTEGER,
               COALESCE(SUM(octet_length(embedding::text)), 0)::BIGINT
        INTO v_eligible, v_bytes
        FROM session_ledger
        WHERE embedding IS NOT NULL
          AND embedding_compressed IS NOT NULL
          AND deleted_at IS NULL
          AND created_at < v_cutoff
          AND user_id = p_user_id
          AND (p_project IS NULL OR project = p_project);

        IF p_dry_run THEN
          RETURN QUERY SELECT v_eligible, 0::INTEGER, v_bytes;
          RETURN;
        END IF;

        IF v_eligible > 0 THEN
          UPDATE session_ledger
          SET embedding = NULL
          WHERE embedding IS NOT NULL
            AND embedding_compressed IS NOT NULL
            AND deleted_at IS NULL
            AND created_at < v_cutoff
            AND user_id = p_user_id
            AND (p_project IS NULL OR project = p_project);
        END IF;

        RETURN QUERY SELECT v_eligible, v_eligible, v_bytes;
      END;
      $$;
    `,
  },
  {
    // ─── v5.2: Cognitive Memory — Last Accessed Tracking ──────────
    //
    // REVIEWER NOTE: This column enables the Ebbinghaus Importance Decay
    // feature (effective = base * 0.95^days_since_accessed) computed at
    // retrieval time in sessionMemoryHandlers.ts. No background workers
    // needed — decay is a pure function of time.
    //
    // The column is updated fire-and-forget via patchLedger() on every
    // search hit. NULLs are expected (entries never retrieved yet) and
    // the decay formula falls back to created_at when last_accessed_at
    // is NULL.
    version: 31,
    name: "cognitive_memory_last_accessed",
    sql: `
      ALTER TABLE session_ledger ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ DEFAULT NULL;
      
      -- Added B-Tree index for LRU high-performance sorting
      CREATE INDEX IF NOT EXISTS idx_session_ledger_last_accessed 
      ON session_ledger(last_accessed_at);
    `,
  },
  {
    // ─── v6.2: Distributed Scheduler Lock ─────────────────────────
    //
    // REVIEWER NOTE: This table enables Hivemind multi-node safety.
    //
    // Problem: In a distributed deployment (multiple Prism instances
    // sharing a single Supabase backend), each node has its own local
    // config file. This means each node independently acquires its local
    // "scheduler_lock" and triggers maintenance sweeps concurrently.
    // While the sweeps are idempotent, redundant compaction/LLM calls
    // waste compute and can cause Supabase rate-limit pressure.
    //
    // Solution: A shared `scheduler_locks` table in Supabase acts as a
    // distributed mutex. The `expires_at` column provides automatic
    // zombie-lock recovery: if a node crashes without releasing the lock,
    // the next node can acquire it after 1 minute.
    //
    // The `prism_acquire_lock` RPC handles the atomic ON CONFLICT 
    // DO UPDATE WHERE pattern that PostgREST cannot express natively.
    //
    // Heartbeat: UPDATE expires_at = NOW() + '1 minute' every 30s.
    // Release: DELETE WHERE key = 'scheduler_main' AND pid = <this_pid>.
    version: 32,
    name: "distributed_scheduler_lock",
    sql: `
      CREATE TABLE IF NOT EXISTS scheduler_locks (
        key        TEXT        PRIMARY KEY,
        pid        TEXT        NOT NULL,
        acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL
      );

      -- Only service_role can write to this table
      ALTER TABLE scheduler_locks ENABLE ROW LEVEL SECURITY;

      -- Allow all authenticated reads (for observability)
      DROP POLICY IF EXISTS "scheduler_locks_select" ON scheduler_locks;
      CREATE POLICY "scheduler_locks_select"
        ON scheduler_locks FOR SELECT
        USING (true);

      -- Atomic lock acquisition RPC
      CREATE OR REPLACE FUNCTION prism_acquire_lock(p_key TEXT, p_pid TEXT, p_ttl_ms INTEGER)
      RETURNS BOOLEAN
      LANGUAGE plpgsql
      SECURITY DEFINER
      AS $$
      DECLARE
          v_expires_at TIMESTAMPTZ := now() + (p_ttl_ms || ' milliseconds')::interval;
          v_success BOOLEAN;
      BEGIN
          INSERT INTO scheduler_locks (key, pid, acquired_at, expires_at)
          VALUES (p_key, p_pid, now(), v_expires_at)
          ON CONFLICT (key) DO UPDATE
          SET pid = EXCLUDED.pid,
              acquired_at = EXCLUDED.acquired_at,
              expires_at = EXCLUDED.expires_at
          WHERE scheduler_locks.expires_at < now(); -- Only steal if expired!

          -- Check if WE are the ones who hold it now
          SELECT EXISTS (
              SELECT 1 FROM scheduler_locks 
              WHERE key = p_key AND pid = p_pid AND expires_at = v_expires_at
          ) INTO v_success;

          RETURN v_success;
      END;
      $$;
    `,
  },
  {
    version: 33,
    name: "memory_links",
    sql: `
      -- Migration 033: Associative Memory Graph (Memory Links)
      -- Brings Supabase backend into full structural parity with SQLite (Phase 3)

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

      CREATE INDEX IF NOT EXISTS idx_mem_links_target ON public.memory_links(target_id);
      CREATE INDEX IF NOT EXISTS idx_mem_links_type ON public.memory_links(link_type);
      CREATE INDEX IF NOT EXISTS idx_mem_links_traversed ON public.memory_links(last_traversed_at);

      -- RLS: Follow established pattern from migration 020 — permissive policies
      -- with application-level user_id enforcement via RPC parameters.
      -- Prism does NOT use auth.uid() (see migration 020 comments).
      ALTER TABLE public.memory_links ENABLE ROW LEVEL SECURITY;

      DROP POLICY IF EXISTS memory_links_all ON public.memory_links;
      CREATE POLICY memory_links_all ON public.memory_links
          FOR ALL USING (true) WITH CHECK (true);

      -- NOTE: session_ledger.keywords is TEXT[] (native Postgres array), not JSONB.
      -- Use unnest() not jsonb_array_elements_text().
      CREATE OR REPLACE FUNCTION public.find_keyword_overlap_entries(
          p_exclude_id UUID, p_project TEXT, p_keywords TEXT[], p_user_id TEXT, p_min_shared_keywords INTEGER DEFAULT 3, p_limit INTEGER DEFAULT 10
      ) RETURNS TABLE (id UUID, shared_count BIGINT)
      LANGUAGE sql SECURITY DEFINER AS $inner$
          SELECT sl.id, COUNT(DISTINCT input_kw.kw) AS shared_count
          FROM public.session_ledger sl
          CROSS JOIN unnest(sl.keywords) AS stored_kw(value)
          INNER JOIN unnest(p_keywords) AS input_kw(kw) ON stored_kw.value = input_kw.kw
          WHERE sl.user_id = p_user_id AND sl.project = p_project AND sl.id != p_exclude_id AND sl.deleted_at IS NULL AND sl.archived_at IS NULL
          GROUP BY sl.id HAVING COUNT(DISTINCT input_kw.kw) >= p_min_shared_keywords ORDER BY shared_count DESC LIMIT p_limit;
      $inner$;

      -- Prune: composite PK table (no single id column) — use NOT EXISTS
      CREATE OR REPLACE FUNCTION public.prism_prune_excess_links(p_entry_id UUID, p_link_type TEXT, p_max_links INTEGER DEFAULT 25)
      RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $inner$
      BEGIN
          DELETE FROM public.memory_links ml
          WHERE ml.source_id = p_entry_id AND ml.link_type = p_link_type
            AND NOT EXISTS (
              SELECT 1 FROM (
                SELECT source_id, target_id, link_type FROM public.memory_links
                WHERE source_id = p_entry_id AND link_type = p_link_type
                ORDER BY strength DESC, last_traversed_at DESC LIMIT p_max_links
              ) keep WHERE keep.source_id = ml.source_id AND keep.target_id = ml.target_id AND keep.link_type = ml.link_type
            );
      END; $inner$;

      CREATE OR REPLACE FUNCTION public.prism_reinforce_link(p_source_id UUID, p_target_id UUID, p_link_type TEXT)
      RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $inner$
      BEGIN
          UPDATE public.memory_links SET strength = LEAST(strength + 0.1, 1.0), last_traversed_at = now()
          WHERE source_id = p_source_id AND target_id = p_target_id AND link_type = p_link_type;
      END; $inner$;

      CREATE OR REPLACE FUNCTION public.prism_decay_links(p_older_than_days INTEGER)
      RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $inner$
      DECLARE v_rows_affected INTEGER;
      BEGIN
          WITH updated AS (
              UPDATE public.memory_links SET strength = GREATEST(strength - 0.05, 0.0)
              WHERE last_traversed_at < now() - (p_older_than_days || ' days')::interval AND link_type IN ('related_to') RETURNING 1
          ) SELECT COUNT(*) INTO v_rows_affected FROM updated;
          RETURN v_rows_affected;
      END; $inner$;

      CREATE OR REPLACE FUNCTION public.prism_backfill_links(p_project TEXT)
      RETURNS TABLE (temporal INTEGER, keyword INTEGER, provenance INTEGER)
      LANGUAGE plpgsql SECURITY DEFINER AS $inner$
      DECLARE
          v_temporal INTEGER := 0; v_keyword INTEGER := 0; v_provenance INTEGER := 0; v_rev_count INTEGER := 0;
      BEGIN
          INSERT INTO public.memory_links (source_id, target_id, link_type, strength, metadata)
          SELECT id, next_id, 'temporal_next', 1.0, jsonb_build_object('backfill', 'temporal', 'conversation_id', conversation_id)
          FROM (SELECT id, conversation_id, LEAD(id) OVER (PARTITION BY conversation_id ORDER BY created_at ASC) AS next_id FROM public.session_ledger
          WHERE project = p_project AND deleted_at IS NULL AND conversation_id IS NOT NULL AND conversation_id != '') AS temp
          WHERE next_id IS NOT NULL ON CONFLICT (source_id, target_id, link_type) DO NOTHING;
          GET DIAGNOSTICS v_temporal = ROW_COUNT;

          INSERT INTO public.memory_links (source_id, target_id, link_type, strength, metadata)
          SELECT a_id, b_id, 'related_to', LEAST(0.3 + (shared_count * 0.1), 1.0), jsonb_build_object('backfill', 'keyword', 'shared_keywords', shared_count)
          FROM (SELECT a.id AS a_id, b.id AS b_id, COUNT(DISTINCT ja.value) AS shared_count
          FROM public.session_ledger a CROSS JOIN unnest(a.keywords) AS ja(value)
          JOIN public.session_ledger b ON b.project = p_project AND b.deleted_at IS NULL AND b.archived_at IS NULL
          CROSS JOIN unnest(b.keywords) AS jb(value)
          WHERE a.project = p_project AND a.deleted_at IS NULL AND a.archived_at IS NULL AND a.id < b.id AND a.keywords IS NOT NULL AND b.keywords IS NOT NULL AND ja.value = jb.value
          GROUP BY a.id, b.id HAVING COUNT(DISTINCT ja.value) >= 3) AS kw
          ON CONFLICT (source_id, target_id, link_type) DO NOTHING;
          GET DIAGNOSTICS v_keyword = ROW_COUNT;

          INSERT INTO public.memory_links (source_id, target_id, link_type, strength, metadata)
          SELECT b_id, a_id, 'related_to', LEAST(0.3 + (shared_count * 0.1), 1.0), jsonb_build_object('backfill', 'keyword_reverse', 'shared_keywords', shared_count)
          FROM (SELECT a.id AS a_id, b.id AS b_id, COUNT(DISTINCT ja.value) AS shared_count
          FROM public.session_ledger a CROSS JOIN unnest(a.keywords) AS ja(value)
          JOIN public.session_ledger b ON b.project = p_project AND b.deleted_at IS NULL AND b.archived_at IS NULL
          CROSS JOIN unnest(b.keywords) AS jb(value)
          WHERE a.project = p_project AND a.deleted_at IS NULL AND a.archived_at IS NULL AND a.id < b.id AND a.keywords IS NOT NULL AND b.keywords IS NOT NULL AND ja.value = jb.value
          GROUP BY a.id, b.id HAVING COUNT(DISTINCT ja.value) >= 3) AS kw_rev
          ON CONFLICT (source_id, target_id, link_type) DO NOTHING;
          GET DIAGNOSTICS v_rev_count = ROW_COUNT;
          v_keyword := v_keyword + v_rev_count;

          INSERT INTO public.memory_links (source_id, target_id, link_type, strength, metadata)
          SELECT rollup.id, archived.id, 'spawned_from', 0.8, jsonb_build_object('backfill', 'provenance')
          FROM public.session_ledger rollup JOIN public.session_ledger archived ON archived.project = rollup.project AND archived.archived_at IS NOT NULL AND archived.deleted_at IS NULL AND EXTRACT(EPOCH FROM ABS(archived.archived_at - rollup.created_at)) < 300
          WHERE rollup.project = p_project AND rollup.deleted_at IS NULL AND rollup.summary LIKE '%[ROLLUP]%'
          ON CONFLICT (source_id, target_id, link_type) DO NOTHING;
          GET DIAGNOSTICS v_provenance = ROW_COUNT;

          RETURN QUERY SELECT v_temporal, v_keyword, v_provenance;
      END; $inner$;
    `
  },
  {
    version: 34,
    name: "memory_links_secure_reads",
    sql: `
      -- Migration 034: Secure Read RPCs for Memory Links
      -- Closes a security and correctness gap where Supabase REST API reads on memory_links
      -- lacked GDPR tombstone, TTL archive filtering, and tenant isolation, unlike SQLite.

      -- RPC for securely reading outbound links (getLinksFrom)
      CREATE OR REPLACE FUNCTION public.prism_get_links_from(
          p_source_id UUID,
          p_user_id TEXT,
          p_min_strength REAL DEFAULT 0.0,
          p_limit INTEGER DEFAULT 25
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
      LANGUAGE sql
      SECURITY DEFINER
      AS $inner$
          SELECT m.source_id, m.target_id, m.link_type, m.strength, m.metadata, m.created_at, m.last_traversed_at
          FROM public.memory_links m
          JOIN public.session_ledger target ON m.target_id = target.id
          WHERE m.source_id = p_source_id
            AND m.strength >= p_min_strength
            AND target.user_id = p_user_id
            AND target.deleted_at IS NULL
            AND (target.archived_at IS NULL OR m.link_type IN ('spawned_from', 'supersedes'))
          ORDER BY m.strength DESC, m.last_traversed_at DESC
          LIMIT p_limit;
      $inner$;

      -- RPC for securely reading inbound links (getLinksTo)
      CREATE OR REPLACE FUNCTION public.prism_get_links_to(
          p_target_id UUID,
          p_user_id TEXT,
          p_min_strength REAL DEFAULT 0.0,
          p_limit INTEGER DEFAULT 25
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
      LANGUAGE sql
      SECURITY DEFINER
      AS $inner$
          SELECT m.source_id, m.target_id, m.link_type, m.strength, m.metadata, m.created_at, m.last_traversed_at
          FROM public.memory_links m
          JOIN public.session_ledger source ON m.source_id = source.id
          WHERE m.target_id = p_target_id
            AND m.strength >= p_min_strength
            AND source.user_id = p_user_id
            AND source.deleted_at IS NULL
            AND (source.archived_at IS NULL OR m.link_type IN ('spawned_from', 'supersedes'))
          ORDER BY m.strength DESC, m.last_traversed_at DESC
          LIMIT p_limit;
      $inner$;
    `
  },
  // ─── Migration 035: Tenant-safe writes + soft-delete hardening ───
  {
    version: 35,
    name: "rpc_soft_delete_and_write_security",
    sql: `
      -- Helper: enforce tenant ownership + visible (not deleted) ledger entry
      CREATE OR REPLACE FUNCTION public.prism_assert_ledger_owner(
        p_user_id TEXT,
        p_entry_id UUID
      )
      RETURNS VOID
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      AS $inner$
      BEGIN
        IF p_user_id IS NULL OR btrim(p_user_id) = '' THEN
          RAISE EXCEPTION 'p_user_id is required';
        END IF;
        IF p_entry_id IS NULL THEN
          RAISE EXCEPTION 'p_entry_id is required';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM public.session_ledger sl
          WHERE sl.id = p_entry_id AND sl.user_id = p_user_id AND sl.deleted_at IS NULL
        ) THEN
          RAISE EXCEPTION 'Tenant ownership/visibility check failed for entry %', p_entry_id;
        END IF;
      END;
      $inner$;

      -- Tenant-safe create/upsert link
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
      AS $inner$
      DECLARE
        v_strength REAL := GREATEST(0.0, LEAST(COALESCE(p_strength, 1.0), 1.0));
      BEGIN
        IF p_link_type IS NULL OR btrim(p_link_type) = '' THEN
          RAISE EXCEPTION 'p_link_type is required';
        END IF;
        PERFORM public.prism_assert_ledger_owner(p_user_id, p_source_id);
        PERFORM public.prism_assert_ledger_owner(p_user_id, p_target_id);
        INSERT INTO public.memory_links (source_id, target_id, link_type, strength, metadata)
        VALUES (p_source_id, p_target_id, p_link_type, v_strength, p_metadata)
        ON CONFLICT (source_id, target_id, link_type)
        DO UPDATE SET strength = EXCLUDED.strength, metadata = EXCLUDED.metadata, last_traversed_at = now();
        RETURN QUERY
        SELECT m.source_id, m.target_id, m.link_type, m.strength, m.metadata, m.created_at, m.last_traversed_at
        FROM public.memory_links m
        WHERE m.source_id = p_source_id AND m.target_id = p_target_id AND m.link_type = p_link_type;
      END;
      $inner$;

      -- Tenant-safe delete by composite key
      CREATE OR REPLACE FUNCTION public.prism_delete_link(
        p_user_id TEXT, p_source_id UUID, p_target_id UUID, p_link_type TEXT
      )
      RETURNS BOOLEAN
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      AS $inner$
      DECLARE v_deleted INTEGER := 0;
      BEGIN
        PERFORM public.prism_assert_ledger_owner(p_user_id, p_source_id);
        PERFORM public.prism_assert_ledger_owner(p_user_id, p_target_id);
        DELETE FROM public.memory_links ml
        WHERE ml.source_id = p_source_id AND ml.target_id = p_target_id AND ml.link_type = p_link_type;
        GET DIAGNOSTICS v_deleted = ROW_COUNT;
        RETURN v_deleted > 0;
      END;
      $inner$;

      -- Admin restore helper
      CREATE OR REPLACE FUNCTION public.admin_get_deleted_entries(
        p_user_id TEXT, p_project TEXT DEFAULT NULL, p_limit INTEGER DEFAULT 100
      )
      RETURNS TABLE (id UUID, project TEXT, summary TEXT, deleted_at TIMESTAMPTZ, deleted_reason TEXT, created_at TIMESTAMPTZ)
      LANGUAGE sql
      SECURITY DEFINER
      SET search_path = public
      AS $inner$
        SELECT sl.id, sl.project, sl.summary, sl.deleted_at, sl.deleted_reason, sl.created_at
        FROM public.session_ledger sl
        WHERE sl.user_id = p_user_id AND sl.deleted_at IS NOT NULL
          AND (p_project IS NULL OR sl.project = p_project)
        ORDER BY sl.deleted_at DESC
        LIMIT GREATEST(1, LEAST(p_limit, 1000));
      $inner$;

      -- Lock down direct memory_links table access
      ALTER TABLE public.memory_links ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS memory_links_all ON public.memory_links;
      DROP POLICY IF EXISTS memory_links_no_direct_select ON public.memory_links;
      DROP POLICY IF EXISTS memory_links_no_direct_insert ON public.memory_links;
      DROP POLICY IF EXISTS memory_links_no_direct_update ON public.memory_links;
      DROP POLICY IF EXISTS memory_links_no_direct_delete ON public.memory_links;
      CREATE POLICY memory_links_no_direct_select ON public.memory_links FOR SELECT USING (false);
      CREATE POLICY memory_links_no_direct_insert ON public.memory_links FOR INSERT WITH CHECK (false);
      CREATE POLICY memory_links_no_direct_update ON public.memory_links FOR UPDATE USING (false) WITH CHECK (false);
      CREATE POLICY memory_links_no_direct_delete ON public.memory_links FOR DELETE USING (false);

      -- Grant execute on all RPCs
      GRANT EXECUTE ON FUNCTION public.prism_assert_ledger_owner(TEXT, UUID) TO service_role, authenticated;
      GRANT EXECUTE ON FUNCTION public.prism_create_link(TEXT, UUID, UUID, TEXT, REAL, JSONB) TO service_role, authenticated;
      GRANT EXECUTE ON FUNCTION public.prism_delete_link(TEXT, UUID, UUID, TEXT) TO service_role, authenticated;
      GRANT EXECUTE ON FUNCTION public.admin_get_deleted_entries(TEXT, TEXT, INTEGER) TO service_role;
    `
  },
  {
    version: 37,
    name: "actr_access_log_parity",
    sql: `
      -- Migration 037: ACT-R Access Log parity for Supabase backend

      CREATE TABLE IF NOT EXISTS public.memory_access_log (
        id BIGSERIAL PRIMARY KEY,
        entry_id UUID NOT NULL REFERENCES public.session_ledger(id) ON DELETE CASCADE,
        accessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        context_hash TEXT DEFAULT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_access_log_entry_time
        ON public.memory_access_log(entry_id, accessed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_access_log_time
        ON public.memory_access_log(accessed_at);

      -- Fire-and-forget insert path used by SupabaseStorage.logAccess.
      -- Uses tenant + visibility gate; invalid entry/user pairs become no-op inserts.
      CREATE OR REPLACE FUNCTION public.prism_log_access(
        p_user_id TEXT,
        p_entry_id UUID,
        p_accessed_at TIMESTAMPTZ DEFAULT now(),
        p_context_hash TEXT DEFAULT NULL
      )
      RETURNS VOID
      LANGUAGE sql
      SECURITY DEFINER
      SET search_path = public
      AS $inner$
        INSERT INTO public.memory_access_log(entry_id, accessed_at, context_hash)
        SELECT sl.id, COALESCE(p_accessed_at, now()), p_context_hash
        FROM public.session_ledger sl
        WHERE sl.id = p_entry_id
          AND sl.user_id = p_user_id
          AND sl.deleted_at IS NULL;
      $inner$;

      -- Batch top-N access log read for ACT-R base-level activation.
      CREATE OR REPLACE FUNCTION public.prism_get_access_log(
        p_user_id TEXT,
        p_entry_ids UUID[],
        p_max_per_entry INTEGER DEFAULT 50
      )
      RETURNS TABLE (
        entry_id UUID,
        accessed_at TIMESTAMPTZ
      )
      LANGUAGE sql
      SECURITY DEFINER
      SET search_path = public
      AS $inner$
        WITH ranked AS (
          SELECT
            mal.entry_id,
            mal.accessed_at,
            ROW_NUMBER() OVER (
              PARTITION BY mal.entry_id
              ORDER BY mal.accessed_at DESC
            ) AS rn
          FROM public.memory_access_log mal
          JOIN public.session_ledger sl ON sl.id = mal.entry_id
          WHERE sl.user_id = p_user_id
            AND sl.deleted_at IS NULL
            AND mal.entry_id = ANY(p_entry_ids)
        )
        SELECT r.entry_id, r.accessed_at
        FROM ranked r
        WHERE r.rn <= GREATEST(COALESCE(p_max_per_entry, 50), 1)
        ORDER BY r.entry_id, r.accessed_at DESC;
      $inner$;

      -- Retention prune for scheduler Task 9.
      CREATE OR REPLACE FUNCTION public.prism_prune_access_log(
        p_older_than_days INTEGER DEFAULT 90
      )
      RETURNS INTEGER
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      AS $inner$
      DECLARE
        v_deleted INTEGER := 0;
      BEGIN
        IF p_older_than_days IS NULL OR p_older_than_days < 1 THEN
          RAISE EXCEPTION 'p_older_than_days must be >= 1';
        END IF;

        DELETE FROM public.memory_access_log
        WHERE accessed_at < now() - (p_older_than_days || ' days')::interval;

        GET DIAGNOSTICS v_deleted = ROW_COUNT;
        RETURN v_deleted;
      END;
      $inner$;

      -- Strict parity with SQLite: seed one access event at ledger creation time.
      CREATE OR REPLACE FUNCTION public.prism_seed_access_log_on_ledger_insert()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      AS $inner$
      BEGIN
        INSERT INTO public.memory_access_log(entry_id, accessed_at, context_hash)
        VALUES (NEW.id, now(), 'creation_seed');
        RETURN NEW;
      END;
      $inner$;

      DROP TRIGGER IF EXISTS trg_prism_seed_access_log ON public.session_ledger;
      CREATE TRIGGER trg_prism_seed_access_log
      AFTER INSERT ON public.session_ledger
      FOR EACH ROW
      EXECUTE FUNCTION public.prism_seed_access_log_on_ledger_insert();

      GRANT EXECUTE ON FUNCTION public.prism_log_access(TEXT, UUID, TIMESTAMPTZ, TEXT) TO service_role, authenticated;
      GRANT EXECUTE ON FUNCTION public.prism_get_access_log(TEXT, UUID[], INTEGER) TO service_role, authenticated;
      GRANT EXECUTE ON FUNCTION public.prism_prune_access_log(INTEGER) TO service_role, authenticated;
      GRANT EXECUTE ON FUNCTION public.prism_seed_access_log_on_ledger_insert() TO service_role, authenticated;
    `
  },

];

/**
 * Current schema version — derived from the MIGRATIONS array.
 * Automatically updates when new migrations are added.
 * Used for logging and diagnostics.
 */
export const CURRENT_SCHEMA_VERSION =
  MIGRATIONS.length > 0 ? MIGRATIONS[MIGRATIONS.length - 1].version : 27;

// ─── Runner ──────────────────────────────────────────────────────

/**
 * Run all pending auto-migrations on Supabase startup.
 *
 * Called from SupabaseStorage.initialize(). Non-fatal: if the
 * migration infrastructure (027) hasn't been applied, the runner
 * logs a warning and returns silently.
 */
export async function runAutoMigrations(): Promise<void> {
  if (MIGRATIONS.length === 0) {
    return; // Nothing to apply
  }

  console.error(
    `[Prism Auto-Migration] Schema v${CURRENT_SCHEMA_VERSION} — checking ${MIGRATIONS.length} migration(s)…`
  );

  for (const migration of MIGRATIONS) {
    try {
      const result = await supabaseRpc("prism_apply_ddl", {
        p_version: migration.version,
        p_name: migration.name,
        p_sql: migration.sql,
      });

      // Parse the JSON result from the RPC
      const data = (typeof result === "string" ? JSON.parse(result) : result) as {
        status: string;
        version: number;
      };

      if (data?.status === "applied") {
        console.error(
          `[Prism Auto-Migration] ✅ Applied migration ${migration.version}: ${migration.name}`
        );
      } else if (data?.status === "already_applied") {
        // Silent skip — expected for idempotent restarts
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);

      // PGRST202 = function not found → migration infra (027) not applied yet
      if (errMsg.includes("PGRST202") || errMsg.includes("Could not find the function")) {
        console.error(
          "[Prism Auto-Migration] ⚠️  prism_apply_ddl() not found. " +
            "Apply migration 027_auto_migration_infra.sql to enable auto-migrations.\n" +
            "  Run: supabase db push  (or apply the SQL in the Supabase Dashboard SQL Editor)"
        );
        return; // Stop — no point trying further migrations
      }

      // Any other error: log and throw to surface the problem
      console.error(
        `[Prism Auto-Migration] ❌ Migration ${migration.version} (${migration.name}) failed: ${errMsg}`
      );
      throw err;
    }
  }
}
