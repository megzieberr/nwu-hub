-- NWU Study Hub — v12: exam_access (Tests & Exams links tab).
--
-- At exam time the one thing Megan must not lose is the SALA "Exam opportunity" ACCESS CODE:
-- an 8-char code she types into the Invigilator Web Browser Agent inside a short register window
-- (e.g. "opens 08:30, closes 08:59") BEFORE the assessment opens on eFundi at 09:00. Sem 1 she
-- missed that window more than once because the code was buried under a mountain of announcements.
-- This table is the always-reachable home for that code + its window + the eFundi link + the
-- official QR, surfaced by a floating "Tests & Exams" tab on every view (see src/App.jsx).
--
-- NOT reusing `goals`: these aren't "done"-able objectives — they carry a code, a time window and
-- a QR, and belong in their own tab. Two data sources (see docs / PLAN):
--   • AUTO — sync/objectives.js regex-extracts the code/window/time/link from the SALA template and
--            upserts here (source='efundi-exam', source_id=<announcement id>).
--   • MANUAL — an owner-only add/fix form in the overlay (the safety net when the agent misses one).
--
-- Reuses the 0001 `owner_all` RLS pattern and the 0005 plain-unique dedupe idiom (NULLS DISTINCT →
-- manual rows with (null,null) never collide; every ('efundi-exam',<id>) pair stays unique; and
-- PostgREST .upsert(onConflict:'source,source_id') works, which a partial index breaks — 42P10).
--
-- SERVICE-ROLE NOTE: the sync worker connects with the service role (bypasses RLS, no auth.uid()),
-- so it MUST set `owner` explicitly on every insert. RLS below governs only the anon-key frontend.
-- Applied via the Supabase MCP AND kept here for version control. Idempotent: safe to re-run.

create table if not exists public.exam_access (
  id                uuid primary key default gen_random_uuid(),
  owner             uuid not null default auth.uid() references auth.users(id) on delete cascade,
  module_id         uuid references public.modules(id) on delete cascade,   -- nullable: manual add may skip it
  kind              text not null default 'exam' check (kind in ('test','exam')),
  title             text not null,                -- "MATH111 Exam opportunity 2"
  access_code       text,                         -- "06f1d051"  ← the hero (typed into Invigilator)
  code_open         time,                         -- 08:30  register-window opens
  code_close        time,                         -- 08:59  register-window closes
  start_time        time,                         -- 09:00  assessment opens on eFundi
  event_date        date,                         -- write date (sort key + auto-hide past)
  efundi_url        text,                         -- assessment link (also encoded as our QR)
  qr_attachment_url text,                         -- original qr-*.pdf if we ever fetch/attach it
  detail            text,                         -- any extra instructions
  source            text,                         -- 'efundi-exam' if agent-added, NULL if manual
  source_id         text,                         -- announcement source_id (dedupe key)
  created_at        timestamptz not null default now()
);

create index if not exists exam_access_module_id_idx  on public.exam_access(module_id);
create index if not exists exam_access_event_date_idx  on public.exam_access(event_date desc);

-- Plain unique (upsert-safe; see header). Manual (null,null) rows never collide.
create unique index if not exists exam_access_source_uidx
  on public.exam_access(source, source_id);

-- RLS — owner-only (0001 owner_all pattern). Service-role worker bypasses this.
alter table public.exam_access enable row level security;
drop policy if exists owner_all on public.exam_access;
create policy owner_all on public.exam_access
  for all
  using (owner = auth.uid())
  with check (owner = auth.uid());
