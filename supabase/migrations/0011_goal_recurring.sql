-- NWU Study Hub — v11: goals.recurring.
--
-- Most classes are one-off (a specific date, often a fresh link each week). But sometimes a lecturer
-- says the class runs *every week* on a standing link — those shouldn't drop off the dashboard after
-- their first date. `recurring = true` marks such a class so the "Classes · Upcoming" section keeps
-- showing it every week, placed on its weekday for the current week.
--
-- One-off classes (recurring = false, the default) show only in the week their date falls in.
-- Set by the objectives agent when the announcement says the class repeats; the weekday is derived
-- from target_date (the next occurrence the agent resolved), so no separate weekday column is needed.
--
-- Applied via the Supabase MCP AND kept here for version control. Idempotent.

alter table public.goals add column if not exists recurring boolean not null default false;
