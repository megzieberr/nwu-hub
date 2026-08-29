-- NWU Study Hub — v17: summary_notes, the summary pen (PLAN-summary-pen.md).
--
-- Highlight + typed note on any prose summary (kind notes/timeline/other), anchored by the WORDS
-- (quote + prefix/suffix context) rather than coordinates — see src/lib/pen.js, which rebuilds a
-- text index of the summary and finds the quote fresh every time it opens, so a highlight still
-- finds its place after a re-seed unless the passage itself is gone (then it goes `orphaned`,
-- never auto-deleted).
--
-- Per-person, never shared: unlike modules/summaries (0002's hub_read — a viewer reads the
-- owner's material read-only), nobody reads anyone else's notes at all, not even read-only. Four
-- policies, each gated on BOTH hub_is_member() (only a provisioned account, same gate as
-- everywhere else) AND owner = auth.uid() (never anyone else's row, not even another member's).
-- A viewer (Lize) writes her own notes on the material she can already read; Megan never sees
-- them and vice versa. The tutor toolkit signs in AS Megan (hub.mjs), so it reads hers via the
-- same policy — no extra grant needed.
--
-- Apply by pasting this whole file into the Supabase SQL editor. Idempotent: safe to re-run.
-- Run /migration-check after applying.

create table if not exists public.summary_notes (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  summary_id  uuid not null references public.summaries(id) on delete cascade,
  quote       text not null,            -- the exact highlighted words (whitespace-normalised)
  prefix      text not null default '', -- ~32 chars of context before, disambiguates repeats
  suffix      text not null default '', -- ~32 chars after
  color       text not null default 'yellow'
                check (color in ('yellow','pink','green','blue','purple','orange')),
  note        text,                     -- her typed note; null = plain highlight
  position    integer not null default 0, -- char offset of quote start at save time → reading order
  orphaned    boolean not null default false, -- quote no longer found (summary re-seeded)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.summary_notes enable row level security;

drop policy if exists summary_notes_select on public.summary_notes;
create policy summary_notes_select on public.summary_notes
  for select using (public.hub_is_member() and owner = auth.uid());

drop policy if exists summary_notes_insert on public.summary_notes;
create policy summary_notes_insert on public.summary_notes
  for insert with check (public.hub_is_member() and owner = auth.uid());

drop policy if exists summary_notes_update on public.summary_notes;
create policy summary_notes_update on public.summary_notes
  for update using (public.hub_is_member() and owner = auth.uid())
             with check (public.hub_is_member() and owner = auth.uid());

drop policy if exists summary_notes_delete on public.summary_notes;
create policy summary_notes_delete on public.summary_notes
  for delete using (public.hub_is_member() and owner = auth.uid());
