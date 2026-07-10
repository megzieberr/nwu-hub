-- NWU Study Hub — v4: let a summary attach to an assessment, not just a study unit.
--
-- Motivation: ENGV121 "brief-decoder" summaries belong on the A1–A6 assessment rows
-- (Assessments tab), NOT under Study Units. A summary already carries an optional
-- `unit_id`; this adds an optional `assessment_id` alongside it. A brief sets
-- assessment_id (and leaves unit_id null); a normal unit summary is unchanged.
--
-- RLS: summaries already has the 0001 `owner_all` policy covering every column, so no
-- new policy is needed. Apply by pasting this whole file into the Supabase SQL editor.
-- Idempotent: safe to re-run.

alter table public.summaries
  add column if not exists assessment_id uuid
    references public.assessments(id) on delete set null;

create index if not exists summaries_assessment_id_idx
  on public.summaries(assessment_id);
