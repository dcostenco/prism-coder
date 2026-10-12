-- Bind legacy self-hosted access history to signed identity. Preserve legitimate own-user access.
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
CREATE OR REPLACE FUNCTION public.prism_log_access(
    p_user_id text, p_entry_id uuid, p_accessed_at timestamptz DEFAULT now(), p_context_hash text DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_context_hash IS NOT NULL AND p_context_hash !~ '^[a-f0-9]{1,64}$' THEN
        RAISE EXCEPTION 'Access context must be a hash' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.memory_access_log(entry_id,accessed_at,context_hash)
    SELECT ledger.id, clock_timestamp(), p_context_hash FROM public.session_ledger AS ledger
    WHERE ledger.id = p_entry_id AND ledger.user_id = p_user_id
      AND ledger.deleted_at IS NULL AND (to_jsonb(ledger)->>'archived_at') IS NULL
      AND (auth.role() = 'service_role' OR (p_user_id = auth.uid()::text
        AND ((to_jsonb(ledger)->>'workspace_id') IS NULL
          OR to_jsonb(ledger)->>'workspace_id' = auth.jwt()->>'workspace_id')));
END;
$$;
CREATE OR REPLACE FUNCTION public.prism_get_access_log(
    p_user_id text, p_entry_ids uuid[], p_max_per_entry integer DEFAULT 50
)
RETURNS TABLE (entry_id uuid, accessed_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_entry_ids IS NULL OR cardinality(p_entry_ids) NOT BETWEEN 1 AND 50
       OR p_max_per_entry IS NULL OR p_max_per_entry NOT BETWEEN 1 AND 50 THEN
        RAISE EXCEPTION 'Invalid access history bounds' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY
        SELECT ledger.id, history.accessed_at FROM public.session_ledger AS ledger
        CROSS JOIN LATERAL (
            SELECT access.accessed_at FROM public.memory_access_log AS access
            WHERE access.entry_id = ledger.id ORDER BY access.accessed_at DESC LIMIT p_max_per_entry
        ) AS history
        WHERE ledger.id = ANY(p_entry_ids) AND ledger.user_id = p_user_id
          AND ledger.deleted_at IS NULL AND (to_jsonb(ledger)->>'archived_at') IS NULL
          AND (auth.role() = 'service_role' OR (p_user_id = auth.uid()::text
            AND ((to_jsonb(ledger)->>'workspace_id') IS NULL
              OR to_jsonb(ledger)->>'workspace_id' = auth.jwt()->>'workspace_id')));
END;
$$;
REVOKE ALL ON FUNCTION public.prism_log_access(text,uuid,timestamptz,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.prism_get_access_log(text,uuid[],integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prism_log_access(text,uuid,timestamptz,text) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.prism_get_access_log(text,uuid[],integer) TO service_role, authenticated;
-- Global retention cannot be a permission held by ordinary tenant clients.
REVOKE ALL ON FUNCTION public.prism_prune_access_log(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prism_prune_access_log(integer) TO service_role;
NOTIFY pgrst, 'reload schema';
