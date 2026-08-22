-- NWU Study Hub — v16: ics_token on profiles, for the Google Calendar feed (PLAN-calendar-feed.md).
--
-- The ics-feed Edge Function identifies the caller by this token alone (via the SERVICE ROLE,
-- bypassing RLS) instead of a Supabase session — Google Calendar's own fetcher carries no auth
-- headers, so the URL itself IS the credential. That means the token must never be readable by
-- anyone but its own owner:
--   • anon already can't reach any profiles row (profiles_self_read / profiles_member_read from
--     0002/0003 both key off auth.uid(), which is null for anon) — the column lockdown below
--     covers it explicitly anyway, belt and braces.
--   • 0003's `profiles_member_read` policy lets ANY hub member (e.g. a read-only viewer/friend
--     added via 0002's template) SELECT every row of `profiles`, every column — so a plain
--     `add column` would hand the owner's calendar-feed URL to a viewer. Column privileges can't
--     be scoped per-policy in Postgres (a GRANT applies regardless of which RLS policy let a row
--     through), so ics_token is pulled OUT of the normal table grant entirely and re-exposed only
--     through the owner-checked SECURITY DEFINER function below (same pattern as 0002's
--     hub_role()). The hub UI (session 2) must call `my_ics_token()`, not
--     `.from('profiles').select('ics_token')` — that select will now return nothing for anyone.
--
-- Idempotent: safe to re-run.

create extension if not exists pgcrypto;

-- ---------- add column, backfill existing rows, THEN clamp not null + default + unique ----------
alter table public.profiles add column if not exists ics_token text;

update public.profiles
set ics_token = encode(gen_random_bytes(24), 'hex')
where ics_token is null;

alter table public.profiles alter column ics_token set default encode(gen_random_bytes(24), 'hex');
alter table public.profiles alter column ics_token set not null;

create unique index if not exists profiles_ics_token_key on public.profiles (ics_token);

-- ---------- column-grant lockdown ----------------------------------------------------------------
-- Full revoke + re-grant the SAFE columns only (the 0003 `project_parts` column-REVOKE idiom,
-- applied to SELECT instead of UPDATE). ics_token is deliberately absent from both grants below —
-- nobody selects it through a normal table read, from any role, on any row.
revoke select on public.profiles from anon, authenticated;
grant select (id, role, display_name, created_at) on public.profiles to anon, authenticated;

-- ---------- owner-only read-back, for the hub UI to show her own feed URL -----------------------
create or replace function public.my_ics_token()
returns text language sql stable security definer set search_path = '' as $$
  select ics_token from public.profiles where id = auth.uid();
$$;

grant execute on function public.my_ics_token() to authenticated;
