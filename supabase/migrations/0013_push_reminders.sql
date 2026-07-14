-- NWU Study Hub — v13: push reminders for classes + written tests/exams (PLAN §Feature B).
--
-- Adds the storage the reminder sender needs, all ADDITIVE and idempotent (safe to re-run):
--   • push_subscriptions — one row per device Megan turns reminders on for.
--   • goals.target_time  — the class/test TIME as data (was only ever inside the text string), so
--                          the sender can fire "~45 min before". Null → a morning-of nudge instead.
--   • goals.is_test      — marks a written test/exam SITTING (not admin tasks like "register"), so the
--                          sender can remind for tests without nagging on ordinary to-dos.
--   • goals.reminded_at  — dedupe stamp so a fired reminder never repeats. For a recurring class it is
--                          compared per-day (reminded_at::date < today) so it re-arms each week.
--   • exam_access.reminded_at — same dedupe, for the code-bearing exam reminder (fires off THIS table,
--                          because it's the row that carries the access code + register window).
--
-- SECURITY: push_subscriptions reuses the 0001 `owner_all` RLS pattern — Megan's own authenticated
-- session inserts/reads/deletes only her rows (owner = auth.uid()). NO SECURITY DEFINER RPC is needed
-- here (unlike Circle Quest, which authenticates learners by name+password); real Supabase auth already
-- identifies her. The send-push Edge Function connects with the SERVICE ROLE and bypasses RLS.
--
-- Applied via the Supabase MCP AND kept here for version control.

-- ── push_subscriptions ────────────────────────────────────────────────────────────────────────
create table if not exists public.push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  owner        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint     text not null unique,          -- identifies one device's push channel (re-subscribe = same row)
  subscription jsonb not null,                -- the full web-push subscription (endpoint + keys)
  created_at   timestamptz not null default now()
);

create index if not exists push_subscriptions_owner_idx on public.push_subscriptions(owner);

alter table public.push_subscriptions enable row level security;
drop policy if exists owner_all on public.push_subscriptions;
create policy owner_all on public.push_subscriptions
  for all
  using (owner = auth.uid())
  with check (owner = auth.uid());

-- ── goals: reminder columns ───────────────────────────────────────────────────────────────────
alter table public.goals add column if not exists target_time time;
alter table public.goals add column if not exists is_test     boolean not null default false;
alter table public.goals add column if not exists reminded_at timestamptz;

-- ── exam_access: reminder dedupe ──────────────────────────────────────────────────────────────
alter table public.exam_access add column if not exists reminded_at timestamptz;
