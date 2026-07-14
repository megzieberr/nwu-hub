-- NWU Study Hub — v15: lecturer name + email on modules.
--
-- Publicly-listed staff contact info (NWU's own site), but Megan doesn't want it sitting in the
-- public repo regardless — so it lives ONLY in this row-level-secured Supabase column, never in
-- committed seed data beyond what each seed-*.mjs script sets at run time.

alter table public.modules
  add column if not exists lecturer_name  text,
  add column if not exists lecturer_email text;
