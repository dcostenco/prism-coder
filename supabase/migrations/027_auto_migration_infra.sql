-- ═══════════════════════════════════════════════════════════════════
-- Migration 027: Auto-Migration Infrastructure
--
-- Creates the scaffolding for automatic schema migrations on server
-- startup. After this migration, future DDL changes are applied via
-- the prism_apply_ddl() RPC — no manual SQL execution needed.
--
-- Components:
--   1. prism_schema_versions  — tracks which migrations are applied
--   2. prism_apply_ddl()      — SECURITY DEFINER function that
--                                executes DDL and records versions
-- ═══════════════════════════════════════════════════════════════════

-- ─── 1. Migration Tracking Table ─────────────────────────────────

CREATE TABLE IF NOT EXISTS prism_schema_versions (
  version   INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE prism_schema_versions ENABLE ROW LEVEL SECURITY;

-- Only service_role can write; anon/authenticated can read
CREATE POLICY "Service role full access"
  ON prism_schema_versions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated read access"
  ON prism_schema_versions
  FOR SELECT
  TO authenticated, anon
  USING (true);


-- ─── 2. DDL Execution Function ───────────────────────────────────

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


REVOKE ALL ON FUNCTION public.prism_apply_ddl(integer,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prism_apply_ddl(integer,text,text) TO service_role;

-- ─── 3. Seed Previously Applied Migrations ──────────────────────
-- Mark all historical migrations as already applied so the
-- auto-migration runner doesn't try to re-apply them.

INSERT INTO prism_schema_versions (version, name) VALUES
  (15, 'initial_schema'),
  (16, 'session_improvements'),
  (17, 'search_and_analytics'),
  (18, 'semantic_search'),
  (19, 'compaction'),
  (20, 'time_travel'),
  (21, 'dashboard_settings'),
  (22, 'legacy_cleanup'),
  (23, 'handoff_history'),
  (24, 'agent_hivemind'),
  (25, 'fix_handoff_constraint'),
  (26, 'active_behavioral_memory'),
  (27, 'auto_migration_infra')
ON CONFLICT (version) DO NOTHING;
