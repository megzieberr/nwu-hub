-- NWU Study Hub — v7: module_context view (the "brief my tutor in one query" helper).
--
-- A Claude Code tutor starting a session for a module should NOT have to crawl many files or
-- tables. This view returns ONE row per module with everything it needs to be briefed instantly:
-- lecturer announcements (context), objectives, assessments/deadlines, the file list, and the
-- existing summaries — each as a compact JSON array of titles/metadata (not full file contents).
--
-- Usage (from a tutor with DB access):
--   select * from module_context where code = 'ALDE122';
-- Then download only the specific file it needs via the storage_path in the `files` array.
--
-- security_invoker = on -> the view respects the caller's RLS (owner-only), so it can't leak.
-- Applied via the Supabase MCP AND kept here for version control. Idempotent.

create or replace view public.module_context
with (security_invoker = on) as
select
  m.id    as module_id,
  m.owner,
  m.code,
  m.title,
  m.outcomes,
  -- Lecturer communications = the tutor's context. HTML lightly stripped to readable text.
  (select jsonb_agg(jsonb_build_object(
            'title', a.title,
            'text',  btrim(regexp_replace(coalesce(a.body_html, ''), '<[^>]*>', ' ', 'g')),
            'posted_at', a.posted_at)
          order by a.posted_at desc nulls last)
     from public.announcements a where a.module_id = m.id) as announcements,
  (select jsonb_agg(jsonb_build_object('objective', g.text, 'due', g.target_date, 'done', g.done)
          order by g.done, g.target_date nulls last)
     from public.goals g where g.module_id = m.id) as objectives,
  (select jsonb_agg(jsonb_build_object('title', x.title, 'type', x.type, 'due', x.due_date, 'status', x.status)
          order by x.due_date nulls last)
     from public.assessments x where x.module_id = m.id) as assessments,
  -- File list: titles + storage_path so the tutor can fetch ONE specific file, not search.
  -- `awaiting_summary` flags the tutor queue (a synced file with no summary yet).
  (select jsonb_agg(jsonb_build_object(
            'title', r.title, 'kind', r.kind, 'path', r.storage_path,
            'from_efundi', r.source = 'efundi',
            'awaiting_summary', r.summarized_at is null)
          order by r.title)
     from public.resources r where r.module_id = m.id) as files,
  (select jsonb_agg(jsonb_build_object('title', s.title, 'kind', s.kind)
          order by s.created_at)
     from public.summaries s where s.module_id = m.id) as summaries
from public.modules m;
