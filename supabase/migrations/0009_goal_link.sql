-- NWU Study Hub — v9: goals.link.
--
-- Class/session objectives usually carry a join link (Teams/Zoom/meeting URL). Those URLs are
-- long (a Teams deep link is ~330 chars) and don't belong inside the short `text` field, which
-- the objectives agent caps at 300 chars. A dedicated column keeps the objective text clean
-- ("MATV121 online class — Wed 17 Jul, 19:00") while the frontend renders a tappable "Join →".
--
-- NULL = no link (most objectives). Set by the objectives agent when an announcement includes a
-- meeting URL, or backfilled by hand. Changes nothing about RLS — existing owner-only policies
-- on `goals` still apply.
--
-- Applied via the Supabase MCP AND kept here for version control. Idempotent.

alter table public.goals add column if not exists link text;
