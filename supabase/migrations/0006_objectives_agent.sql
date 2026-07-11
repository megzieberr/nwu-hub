-- NWU Study Hub — v6: processing layer for the "focused eFundi" model.
--
-- The hub no longer displays raw eFundi content (announcements, synced files). Instead:
--   • an objectives agent reads NEW announcements and writes goals/objectives (goals table);
--   • new synced files are flagged for the AI tutor to turn into summaries.
-- This migration adds the bookkeeping those two flows need. See docs/efundi-sync-plan.md.
--
-- Applied via the Supabase MCP (project now reachable) AND kept here for version control.
-- Idempotent: safe to re-run.

-- 6a · announcements: mark when the objectives agent has processed a row (so it never
--      re-reads or double-charges). NULL = awaiting the agent.
alter table public.announcements add column if not exists processed_at timestamptz;

-- 6b · goals: provenance so agent-generated objectives are distinguishable from hand-set ones,
--      and traceable back to the announcement they came from (source_id = announcement source_id).
--      NOT unique — one announcement can yield several goals.
alter table public.goals add column if not exists source     text;
alter table public.goals add column if not exists source_id  text;

-- 6c · resources: tutor queue. NULL on a synced file = "new, awaiting a summary"; the tutor
--      sets it once a summary exists. Manual files are left NULL and simply ignored by the queue.
alter table public.resources add column if not exists summarized_at timestamptz;

-- Helpful partial index for the agent's "what's new" scan.
create index if not exists announcements_unprocessed_idx
  on public.announcements(processed_at) where processed_at is null;
