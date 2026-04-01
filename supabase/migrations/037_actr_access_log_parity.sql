-- Migration 037: ACT-R Access Log parity for Supabase backend

BEGIN;

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
AS $$
  INSERT INTO public.memory_access_log(entry_id, accessed_at, context_hash)
  SELECT sl.id, COALESCE(p_accessed_at, now()), p_context_hash
  FROM public.session_ledger sl
  WHERE sl.id = p_entry_id
    AND sl.user_id = p_user_id
    AND sl.deleted_at IS NULL;
$$;

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
AS $$
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
$$;

-- Retention prune for scheduler Task 9.
CREATE OR REPLACE FUNCTION public.prism_prune_access_log(
  p_older_than_days INTEGER DEFAULT 90
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

-- Strict parity with SQLite: seed one access event at ledger creation time.
CREATE OR REPLACE FUNCTION public.prism_seed_access_log_on_ledger_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.memory_access_log(entry_id, accessed_at, context_hash)
  VALUES (NEW.id, now(), 'creation_seed');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prism_seed_access_log ON public.session_ledger;
CREATE TRIGGER trg_prism_seed_access_log
AFTER INSERT ON public.session_ledger
FOR EACH ROW
EXECUTE FUNCTION public.prism_seed_access_log_on_ledger_insert();

GRANT EXECUTE ON FUNCTION public.prism_log_access(TEXT, UUID, TIMESTAMPTZ, TEXT) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.prism_get_access_log(TEXT, UUID[], INTEGER) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.prism_prune_access_log(INTEGER) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.prism_seed_access_log_on_ledger_insert() TO service_role, authenticated;

COMMIT;
