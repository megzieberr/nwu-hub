-- NWU Study Hub — v18: the pen loses yellow, blue becomes the meaning-carrier.
--
-- Her colour docs already use yellow highlighting of their own, so a pen-yellow highlight is
-- indistinguishable from the doc's (her ruling 2026-08-29, spotted on the MALATI colour
-- edition). Blue takes over "important — use this" and the one-tap default; yellow is removed
-- from the palette entirely rather than demoted to a free colour — a free yellow would blend
-- into the docs just the same. Existing yellow rows are re-inked blue BEFORE the constraint
-- tightens, so their meaning survives.
--
-- Applied via MCP 2026-08-29. Idempotent: safe to re-run.

update public.summary_notes set color = 'blue' where color = 'yellow';

alter table public.summary_notes
  alter column color set default 'blue';

alter table public.summary_notes
  drop constraint if exists summary_notes_color_check;
alter table public.summary_notes
  add constraint summary_notes_color_check
  check (color in ('pink','green','blue','purple','orange'));
