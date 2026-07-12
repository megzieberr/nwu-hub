-- NWU Study Hub — v8: modules.hidden flag.
--
-- Some enrolled eFundi sites are worth SYNCING (so their announcements feed the objectives
-- agent) but not worth a tile on the dashboard — e.g. TPED178 (Teaching Practice), where the
-- only thing Megan wants from the hub is the announcement stream, not a study surface.
--
-- `hidden` lets a module stay fully mapped + synced while the dashboard grid skips its tile.
-- It changes nothing about RLS or the sync — the existing owner-only policies still apply, and
-- the sync maps/pulls by efundi_site_map regardless of this flag.
--
-- Applied via the Supabase MCP AND kept here for version control. Idempotent.

alter table public.modules
  add column if not exists hidden boolean not null default false;
