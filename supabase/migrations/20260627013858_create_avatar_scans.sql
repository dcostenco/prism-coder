-- =============================================================================
-- PrismCoach avatar_scans — schema, RLS, and storage buckets
--
-- Access model: ONLY the portal's service role touches this table and these
-- buckets. The device never gets a Supabase key. Ownership is enforced in the
-- route handler (row.user_id === verified JWT userId). RLS is set to deny-all
-- for anon/authenticated as defense in depth, so even a leaked anon key reads
-- nothing.
-- =============================================================================

create table if not exists public.avatar_scans (
    id          uuid primary key default gen_random_uuid(),
    user_id     text not null,                         -- from verified X-Prism-Key, never client input
    status      text not null default 'processing'
                check (status in ('processing','ready','failed')),
    usdz_path   text,                                  -- object path in PRIVATE 'avatars' bucket
    sex         text,
    height_cm   numeric,
    weight_kg   numeric,
    error       text,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create index if not exists avatar_scans_user_id_idx on public.avatar_scans (user_id);
create index if not exists avatar_scans_status_idx  on public.avatar_scans (status);

alter table public.avatar_scans enable row level security;
-- No policies for anon/authenticated => deny-all to them. The service role
-- bypasses RLS, which is exactly (and only) what the portal uses.
revoke all on public.avatar_scans from anon, authenticated;

-- keep updated_at honest
create or replace function public.touch_avatar_scans() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists trg_touch_avatar_scans on public.avatar_scans;
create trigger trg_touch_avatar_scans before update on public.avatar_scans
    for each row execute function public.touch_avatar_scans();

-- Optional hygiene: reap rows stuck 'processing' (Modal never reported back).
-- Schedule via pg_cron if available.
create or replace function public.reap_stale_avatar_scans() returns void as $$
begin
    update public.avatar_scans
       set status = 'failed', error = 'timed out'
     where status = 'processing' and created_at < now() - interval '15 minutes';
end;
$$ language plpgsql;

-- =============================================================================
-- Storage buckets — BOTH private (public = false). Never get_public_url();
-- the portal mints short-lived signed URLs on the GET endpoint.
-- =============================================================================
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', false)
on conflict (id) do update set public = false;

-- No storage RLS policies for anon/authenticated => only the service role can
-- read/write objects.
