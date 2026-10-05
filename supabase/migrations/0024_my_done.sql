-- NWU Study Hub, v24: my_done, each person's own done-ticks on assessments ("own ticks").
--
-- assessments.status ('upcoming' / 'submitted' / 'graded') sits on the SHARED row, so it is the
-- owner's state. The viewer reads that row through hub_read and, until now, saw the owner's ticks
-- as her own: a row the owner had handed in was greyed out and struck through on the viewer's
-- module page, and vanished from her dashboard. This table gives the viewer her own ticks.
--
-- A row present = this person has ticked this assessment off. Untick = delete the row. Nothing is
-- ever updated, so there is no update policy and no update grant.
--
-- The owner's side does not change: her done-state stays assessments.status. Only the viewer's
-- screens read this table. The table itself is per-person for everyone, though, so the same rules
-- hold whoever writes to it.
--
-- The unique constraint is a PLAIN table constraint, not a partial index, so `on conflict` and
-- PostgREST's .upsert() can find it (a partial index fails with 42P10).
--
-- Per-person, never shared: the same policy shape as 0021 and 0023. Each policy is gated on BOTH
-- hub_is_member() (only a provisioned account; a stranger who signed up through the login form has
-- no profiles row and gets nothing) AND owner = auth.uid() (never anyone else's row, not even
-- another member's). No viewer carve-out, in either direction. No policy recursion:
-- hub_is_member() reads profiles, never this table. The foreign key from my_done to assessments is
-- checked as the table owner, so the viewer can tick a shared assessment row she cannot write to.
--
-- No function and no trigger: every new function in public is callable by anon unless it is locked
-- down (see 0021). This migration alters nothing that already exists.
--
-- This file holds no data.
--
-- NOT APPLIED. Review the whole file before running it. Apply via the Supabase MCP or by pasting it
-- into the Supabase SQL editor. Idempotent: safe to re-run. Run /migration-check afterwards.
-- Apply it BEFORE deploying the hub-window edge function that reads it.

-- ==================================================================
-- my_done
-- ==================================================================

create table if not exists public.my_done (
  id             uuid primary key default gen_random_uuid(),
  owner          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  assessment_id  uuid not null references public.assessments(id) on delete cascade,
  done_at        timestamptz not null default now(),
  constraint my_done_owner_assessment_uniq unique (owner, assessment_id)
    -- plain, not partial: .upsert() and on conflict need it; a partial index gives 42P10
);

-- The unique constraint already indexes (owner, assessment_id). This one serves the cascade when
-- an assessment row is deleted.
create index if not exists my_done_assessment_idx on public.my_done (assessment_id);

alter table public.my_done enable row level security;

drop policy if exists my_done_select on public.my_done;
create policy my_done_select on public.my_done
  for select to authenticated
  using (public.hub_is_member() and owner = auth.uid());

drop policy if exists my_done_insert on public.my_done;
create policy my_done_insert on public.my_done
  for insert to authenticated
  with check (public.hub_is_member() and owner = auth.uid());

-- Kept for the four-policy shape, although nothing is granted UPDATE below: if a later grant ever
-- adds it, this policy already pins it to the person's own rows.
drop policy if exists my_done_update on public.my_done;
create policy my_done_update on public.my_done
  for update to authenticated
  using (public.hub_is_member() and owner = auth.uid())
  with check (public.hub_is_member() and owner = auth.uid());

drop policy if exists my_done_delete on public.my_done;
create policy my_done_delete on public.my_done
  for delete to authenticated
  using (public.hub_is_member() and owner = auth.uid());

-- ==================================================================
-- Grants
-- ==================================================================
-- Supabase's default privileges on this project hand anon AND authenticated every table privilege
-- on every new table, including TRUNCATE (ignores RLS) and, on Postgres 17, MAINTAIN. So: take
-- everything off anon and PUBLIC, take everything off authenticated too, then grant back only the
-- three the app needs (a tick is an insert, an untick is a delete, nothing is ever updated).
-- service_role is untouched (bypasses RLS; the hub-window edge function reads this table with it,
-- always filtered to the token holder's own user id).

revoke all on public.my_done from anon, public;
revoke all on public.my_done from authenticated;
grant select, insert, delete on public.my_done to authenticated;
-- `authenticated` above is the role grant only; the policies above decide which rows each account
-- actually reaches, and that is only its own.
