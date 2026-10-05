-- NWU Study Hub, v23: my_marks + final_marks, the "Marks" tab (gradebook).
--
-- my_marks holds one mark per person per assessment: the percentage the pie draws, plus the text
-- that was typed (e.g. 22/25) so the hub can show it back the same way. The assessment rows
-- themselves stay shared (they are the owner's, read by the viewer through hub_read), but a mark
-- on them is now private to whoever wrote it. That is the whole point of the table: until now the
-- only mark column was assessments.mark, on the shared row, so the viewer account could read it.
-- That column is left in place here; emptying it is a later step, after the new tab reads this.
--
-- final_marks holds one final mark per person per module code: Semester 1 finals, the year module,
-- and Semester 2 finals at year end. Rows are free-standing (a module code, not a link to modules),
-- because Semester 1 modules have no row in modules and each person adds her own. kind =
-- 'year_figure' is ONE number the person types in from her own academic record; the hub never
-- computes it. semester 0 = year module or year figure. mark is nullable: a row can exist before
-- its result is out.
--
-- Both unique constraints are PLAIN table constraints, not partial indexes, so `on conflict` and
-- PostgREST's .upsert() can find them (a partial index fails with 42P10).
--
-- Per-person, never shared: the same four-policy shape as 0021. Each policy is gated on BOTH
-- hub_is_member() (only a provisioned account; a stranger who signed up through the login form has
-- no profiles row and gets nothing) AND owner = auth.uid() (never anyone else's row, not even
-- another member's). No viewer carve-out, in either direction. No policy recursion:
-- hub_is_member() reads profiles, never these tables. The foreign key from my_marks to assessments
-- is checked as the table owner, so the viewer can attach her own mark to a shared assessment row
-- she cannot write to.
--
-- updated_at is set by the app on every update. No trigger, for the reason given in 0021: a
-- trigger needs a new SQL function, and every new function in public is callable by anon unless it
-- is locked down. This migration adds no function and alters nothing that already exists.
--
-- This file holds no marks. Data goes in by a separate private step, never through the repo.
--
-- NOT APPLIED. Review the whole file before running it. Apply via the Supabase MCP or by pasting it
-- into the Supabase SQL editor. Idempotent: safe to re-run. Run /migration-check afterwards.

-- ==================================================================
-- my_marks
-- ==================================================================

create table if not exists public.my_marks (
  id             uuid primary key default gen_random_uuid(),
  owner          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  assessment_id  uuid not null references public.assessments(id) on delete cascade,
  mark           numeric not null check (mark >= 0 and mark <= 100), -- a percentage
  raw            text check (raw is null or char_length(raw) <= 40),   -- what was typed, e.g. 22/25
  updated_at     timestamptz not null default now(), -- set by the app, no trigger (see header)
  constraint my_marks_owner_assessment_uniq unique (owner, assessment_id)
    -- plain, not partial: .upsert() and on conflict need it; a partial index gives 42P10
);

-- The unique constraint already indexes (owner, assessment_id). This one serves the cascade when
-- an assessment row is deleted.
create index if not exists my_marks_assessment_idx on public.my_marks (assessment_id);

alter table public.my_marks enable row level security;

drop policy if exists my_marks_select on public.my_marks;
create policy my_marks_select on public.my_marks
  for select to authenticated
  using (public.hub_is_member() and owner = auth.uid());

drop policy if exists my_marks_insert on public.my_marks;
create policy my_marks_insert on public.my_marks
  for insert to authenticated
  with check (public.hub_is_member() and owner = auth.uid());

drop policy if exists my_marks_update on public.my_marks;
create policy my_marks_update on public.my_marks
  for update to authenticated
  using (public.hub_is_member() and owner = auth.uid())
  with check (public.hub_is_member() and owner = auth.uid());

drop policy if exists my_marks_delete on public.my_marks;
create policy my_marks_delete on public.my_marks
  for delete to authenticated
  using (public.hub_is_member() and owner = auth.uid());

-- ==================================================================
-- final_marks
-- ==================================================================

create table if not exists public.final_marks (
  id           uuid primary key default gen_random_uuid(),
  owner        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind         text not null default 'module'
                 check (kind in ('module','year_figure')), -- year_figure: typed in, never computed
  module_code  text not null check (char_length(module_code) between 1 and 20),
  title        text check (title is null or char_length(title) <= 120),
  credits      int check (credits is null or credits >= 0),
  semester     int check (semester in (0,1,2)),            -- 0 = year module / year figure
  mark         numeric check (mark is null or (mark >= 0 and mark <= 100)), -- null = no result yet
  updated_at   timestamptz not null default now(),       -- set by the app, no trigger (see header)
  constraint final_marks_owner_code_uniq unique (owner, module_code)
    -- plain, not partial: .upsert() and on conflict need it; a partial index gives 42P10
);

alter table public.final_marks enable row level security;

drop policy if exists final_marks_select on public.final_marks;
create policy final_marks_select on public.final_marks
  for select to authenticated
  using (public.hub_is_member() and owner = auth.uid());

drop policy if exists final_marks_insert on public.final_marks;
create policy final_marks_insert on public.final_marks
  for insert to authenticated
  with check (public.hub_is_member() and owner = auth.uid());

drop policy if exists final_marks_update on public.final_marks;
create policy final_marks_update on public.final_marks
  for update to authenticated
  using (public.hub_is_member() and owner = auth.uid())
  with check (public.hub_is_member() and owner = auth.uid());

drop policy if exists final_marks_delete on public.final_marks;
create policy final_marks_delete on public.final_marks
  for delete to authenticated
  using (public.hub_is_member() and owner = auth.uid());

-- ==================================================================
-- Grants
-- ==================================================================
-- Supabase's default privileges on this project hand anon AND authenticated every table privilege
-- on every new table, including TRUNCATE (ignores RLS) and, on Postgres 17, MAINTAIN. So: take
-- everything off anon and PUBLIC, take everything off authenticated too, then grant back only the
-- four the policies above need. This is one step tighter than 0021/0022, which left MAINTAIN on
-- authenticated. service_role is untouched (bypasses RLS; used by the sync worker and edge
-- functions, none of which read these tables today).

revoke all on public.my_marks    from anon, public;
revoke all on public.final_marks from anon, public;

revoke all on public.my_marks    from authenticated;
revoke all on public.final_marks from authenticated;
grant select, insert, update, delete on public.my_marks    to authenticated;
grant select, insert, update, delete on public.final_marks to authenticated;
-- `authenticated` above is the role grant only; the policies above decide which rows each account
-- actually reaches, and that is only its own.
