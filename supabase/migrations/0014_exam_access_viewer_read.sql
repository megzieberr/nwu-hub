-- NWU Study Hub — v14: let the read-only viewer (Lize) SEE exam access codes in the hub.
--
-- Megan + Lize share the exact same modules and the SALA exam access codes are class-wide (one code
-- per opportunity, posted by the lecturer for everyone). So Lize should see the Tests & Exams tab and
-- its codes, exactly like she already sees modules/summaries/assessments — she just can't WRITE
-- (no add/fix, no manual code entry).
--
-- This swaps exam_access from the owner-only `owner_all` policy to the SAME two-policy pattern every
-- other viewer-readable table uses:
--   • hub_read  (SELECT) — owner, OR a hub member viewing the owner's rows.
--   • hub_write (ALL)    — owner AND not a viewer. Viewers fail this → reads only.
-- The service-role sync worker bypasses RLS entirely, so its inserts are unaffected.
-- Idempotent; applied via MCP and kept here for version control.

alter table public.exam_access enable row level security;

drop policy if exists owner_all on public.exam_access;
drop policy if exists hub_read on public.exam_access;
drop policy if exists hub_write on public.exam_access;

create policy hub_read on public.exam_access
  for select
  using ((owner = auth.uid()) or (hub_is_member() and hub_is_owner(owner)));

create policy hub_write on public.exam_access
  for all
  using ((owner = auth.uid()) and (coalesce(hub_role(), 'owner') <> 'viewer'))
  with check ((owner = auth.uid()) and (coalesce(hub_role(), 'owner') <> 'viewer'));
