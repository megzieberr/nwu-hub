-- NWU Study Hub, v26: my_done.skipped, "we didn't write it" (s50, her ask 2026-10-23).
--
-- An extended or second opportunity is optional. Skipping one must take it off My Week (no red
-- OVERDUE line) without claiming it was handed in. The owner already has a value for that on the
-- shared row: assessments.status = 'missed' (in the 0001 check list). The viewer's done-state is
-- her own my_done rows (0024), so her skip is a my_done row with skipped = true. The row's
-- presence still means "off my list"; the flag only changes the label.
--
-- Additive only: one column with a default, so every existing row reads as a plain tick. No
-- policy changes (0024's four policies already pin every row to owner = auth.uid()), no new
-- grant (0024's table-level select / insert / delete on authenticated covers a new column; still
-- no UPDATE: skip and tick swap by delete + insert, as untick already does).
--
-- Idempotent: safe to re-run. Apply BEFORE deploying the app build that selects the column.

alter table public.my_done
  add column if not exists skipped boolean not null default false;
