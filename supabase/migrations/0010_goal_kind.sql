-- NWU Study Hub — v10: goals.kind ('task' | 'class').
--
-- Classes are not one-off objectives. Lecturers reschedule them and send a fresh join link most
-- weeks (esp. sem 1), so a class is a recurring, volatile event — it doesn't want a "done" tick and
-- it shouldn't pile up in the Objectives list. `kind` lets the objectives agent tag a scheduled
-- class/lecture/tutorial/live session as 'class'; everything else stays 'task'.
--
-- The dashboard renders 'class' rows in their own "Classes · Upcoming" section (a rolling 3-week
-- window, like the Quest Log), so past classes fall off on their own and the home screen stays calm.
--
-- Applied via the Supabase MCP AND kept here for version control. Idempotent.

alter table public.goals add column if not exists kind text not null default 'task';

-- Constrain to known kinds; drop-then-add so re-running is safe.
alter table public.goals drop constraint if exists goals_kind_check;
alter table public.goals add constraint goals_kind_check check (kind in ('task', 'class'));
