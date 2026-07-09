-- NWU Study Hub — v2: shared read-only viewer access (e.g. giving a friend a login).
--
-- Adds a `profiles` role table (owner | viewer). Owners author everything; a viewer gets
-- READ-ONLY access to the study material (modules, study_units, assessments, summaries) and
-- NOTHING else — no goals, no study log, no writes, no NotebookLM (that's hidden in the UI).
-- The login form auto-creates an account for any username, so a random public signup gets
-- NO profile row and still sees an empty hub. Only rows seeded here grant real access.
--
-- Apply by pasting this whole file into the Supabase SQL editor.
-- (This project is NOT on the Supabase MCP — see project notes.) Idempotent: safe to re-run.

-- ---------- profiles (hub membership + role) ----------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  role         text not null default 'viewer' check (role in ('owner','viewer')),
  display_name text,
  created_at   timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- A user may read ONLY their own profile row (so the app can learn its own role).
drop policy if exists profiles_self_read on public.profiles;
create policy profiles_self_read on public.profiles
  for select using (id = auth.uid());
-- No insert/update/delete policies exist: membership is managed only from the SQL editor
-- (the service role bypasses RLS), so nobody can self-promote to owner/viewer from the app.

-- ---------- helper functions (security definer: read profiles past RLS) ----------
create or replace function public.hub_is_member()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid());
$$;

create or replace function public.hub_is_owner(uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = uid and role = 'owner');
$$;

create or replace function public.hub_role()
returns text language sql stable security definer set search_path = '' as $$
  select role from public.profiles where id = auth.uid();
$$;

grant execute on function public.hub_is_member()    to authenticated, anon;
grant execute on function public.hub_is_owner(uuid) to authenticated, anon;
grant execute on function public.hub_role()         to authenticated, anon;

-- ---------- shared tables: viewers get read-only, owners keep full control ----------
-- modules · study_units · assessments · summaries
do $$
declare t text;
begin
  foreach t in array array['modules','study_units','assessments','summaries']
  loop
    execute format('alter table public.%I enable row level security;', t);
    -- retire the old owner-only "for all" policy
    execute format('drop policy if exists owner_all on public.%I;', t);
    -- READ: your own rows, OR (you are a hub member AND the row was authored by an owner).
    -- => a viewer sees exactly the owner's material; a stray viewer-authored row stays invisible.
    execute format($p$
      drop policy if exists hub_read on public.%1$I;
      create policy hub_read on public.%1$I
        for select using (
          owner = auth.uid()
          or (public.hub_is_member() and public.hub_is_owner(owner))
        );
    $p$, t);
    -- WRITE (insert/update/delete): only your own rows, and never a viewer.
    -- coalesce keeps un-profiled accounts (incl. the owner if her profile is ever missing)
    -- working, while hard-blocking anyone flagged 'viewer'.
    execute format($p$
      drop policy if exists hub_write on public.%1$I;
      create policy hub_write on public.%1$I
        for all
        using      (owner = auth.uid() and coalesce(public.hub_role(),'owner') <> 'viewer')
        with check (owner = auth.uid() and coalesce(public.hub_role(),'owner') <> 'viewer');
    $p$, t);
  end loop;
end $$;

-- goals + study_log are intentionally left owner-only (0001's owner_all policy):
-- viewers can neither read nor write them, so the owner's personal goals/log stay private.

-- ---------- seed the owner ----------
-- The owner authors everything. Resolves the owner account by its login email
-- (hub username 'megzieberr' -> the synthetic address below). Idempotent.
insert into public.profiles (id, role)
select id, 'owner'
from auth.users
where email = 'megzieberr@nwu-hub.local'
on conflict (id) do update set role = excluded.role;

-- ---------- grant a friend read-only access (TEMPLATE) ----------
-- Run this AFTER the friend has an account — either she logs in once at the hub, or you add
-- her in Supabase → Authentication → Users → Add user (email `<username>@nwu-hub.local`,
-- auto-confirm). Fill in her hub username below, then run just this block. If her account
-- doesn't exist yet it selects zero rows (harmless no-op) — re-run once she's signed up.
-- Kept as a template so no personal names live in this public repo.
--
--   insert into public.profiles (id, role)
--   select id, 'viewer'
--   from auth.users
--   where email = '<username>@nwu-hub.local'
--   on conflict (id) do update set role = excluded.role;
