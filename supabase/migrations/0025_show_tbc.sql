-- NWU Study Hub, v25: assessments.show_tbc, an undated deadline she wants on My Week anyway.
--
-- My Week leaves every undated row out on purpose (the home screen is a glance, not the whole
-- semester). Megan, 2026-10-23: she wants SECL121 Ass 3 (quiz, date not out yet) to remind her
-- every time she opens the hub. Showing ALL undated rows would also pull in ALDE A5, ENGV A6,
-- MATH "Assignments" and the rest, so this is a per-row switch, off by default.
--
-- Once the row gets a real due_date, My Week treats it as an ordinary dated deadline and the
-- switch stops mattering.
--
-- Grants: authenticated holds table-level SELECT/INSERT/UPDATE on assessments (0022), so the new
-- column is covered with no extra grant; anon still holds nothing. RLS is row-level and unchanged.
-- The eFundi sync (sync/write.js) writes only its own fields and never touches this one.

alter table public.assessments
  add column if not exists show_tbc boolean not null default false;
