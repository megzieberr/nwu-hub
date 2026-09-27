-- NWU Study Hub — v21: plan_blocks, the "Week" planner tab.
--
-- One row per planned block of time on one real date: a study session, a class, prep for a test,
-- a break. The Week tab draws these on a 7-day grid, and the owner ticks a block off when it is
-- done. "Repeat weekly" writes real rows for each date (sharing one series_id) instead of storing
-- a rule, so moving or deleting one week never touches the others.
--
-- Rows copied in from the tutoring scheduler carry source = 'whenworks' plus a source_key such as
-- ww:<class_id>:<yyyy-mm-dd> (the same marker used on the calendar events). Rows typed by hand
-- leave both null, the same house rule as goals. The unique constraint on (owner, source,
-- source_key) is a PLAIN table constraint, not a partial index: nulls never collide, so hand-made
-- rows are unaffected, and a plain constraint is what lets `on conflict (owner, source,
-- source_key)` and PostgREST's .upsert() find it. A partial index would fail with 42P10.
--
-- Overlapping blocks are allowed on purpose (no exclusion constraint): spotting clashes is the
-- weekly review's job, not the database's.
--
-- Per-person, never shared: the same four-policy shape as 0017. Each policy is gated on BOTH
-- hub_is_member() (only a provisioned account; a stranger who signed up through the login form has
-- no profiles row and gets nothing) AND owner = auth.uid() (never anyone else's row, not even
-- another member's). No viewer carve-out. No policy recursion: hub_is_member() reads profiles,
-- never this table.
--
-- updated_at is set by the app on every update. There is deliberately no trigger, because a
-- trigger needs a new SQL function, and every new function in public is callable by anon unless
-- it is locked down. This migration adds no function and alters nothing that already exists.
--
-- NOT APPLIED. Review the whole file before running it. Apply via the Supabase MCP or by pasting it
-- into the Supabase SQL editor. Idempotent: safe to re-run. Run /migration-check afterwards.

create table if not exists public.plan_blocks (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  block_date  date not null,
  start_time  time not null,
  end_time    time not null check (end_time > start_time), -- '24:00' is a valid time: ends at midnight
  module_id   uuid references public.modules(id) on delete set null, -- null = not an NWU module
  kind        text not null default 'study'
                check (kind in ('study','class','prep','break','other')),
  label       text not null default '' check (char_length(label) <= 120), -- what she types
  done        boolean not null default false,
  done_at     timestamptz,              -- set by the app when the block is ticked
  note        text,                     -- optional, e.g. why a block was swapped
  series_id   uuid,                     -- shared by the rows one "repeat weekly" made
  source      text check (source in ('whenworks')), -- null = made by hand; extend in a later migration
  source_key  text,                     -- e.g. ww:<class_id>:<yyyy-mm-dd>
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(), -- set by the app, no trigger (see header)
  constraint plan_blocks_source_uniq unique (owner, source, source_key)
    -- plain, not partial: .upsert() and on conflict need it; a partial index gives 42P10
);

create index if not exists plan_blocks_owner_date_idx
  on public.plan_blocks (owner, block_date, start_time);

alter table public.plan_blocks enable row level security;

drop policy if exists plan_blocks_select on public.plan_blocks;
create policy plan_blocks_select on public.plan_blocks
  for select using (public.hub_is_member() and owner = auth.uid());

drop policy if exists plan_blocks_insert on public.plan_blocks;
create policy plan_blocks_insert on public.plan_blocks
  for insert with check (public.hub_is_member() and owner = auth.uid());

drop policy if exists plan_blocks_update on public.plan_blocks;
create policy plan_blocks_update on public.plan_blocks
  for update using (public.hub_is_member() and owner = auth.uid())
             with check (public.hub_is_member() and owner = auth.uid());

drop policy if exists plan_blocks_delete on public.plan_blocks;
create policy plan_blocks_delete on public.plan_blocks
  for delete using (public.hub_is_member() and owner = auth.uid());

revoke all on public.plan_blocks from anon, public;
-- Supabase's default privileges also hand `authenticated` truncate/references/trigger on every new
-- table. PostgREST cannot issue them, but TRUNCATE ignores RLS, so take them away here anyway.
revoke truncate, references, trigger on public.plan_blocks from authenticated;
grant select, insert, update, delete on public.plan_blocks to authenticated;
-- `authenticated` above is the role grant only; the policies above decide which rows each account
-- actually reaches, and that is only its own.
