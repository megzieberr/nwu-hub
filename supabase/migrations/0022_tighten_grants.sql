-- 0022 · Tighten old grants: take anon off every older table, and TRUNCATE/REFERENCES/TRIGGER
-- off authenticated. REVOKE and GRANT only: no new tables, functions, policies or triggers.
--
-- WHY
--   Supabase's default privileges on this project hand `anon` (logged-out visitors, and anyone
--   holding the public anon key from the deployed bundle) every table privilege, including
--   TRUNCATE, on every table created before 0020. RLS already hides every row from anon (every
--   policy needs auth.uid() or hub_is_member()), and PostgREST cannot issue TRUNCATE, so nothing
--   is reachable today. This removes the grants anyway, so the only wall is no longer RLS alone.
--   It copies the idiom already used for tutor_docs (0020) and plan_blocks (0021).
--
-- WHAT EACH ROLE NEEDS (traced from the code, 2026-09-27)
--   anon          : nothing on any table. The app shows only the login form before a session
--                   exists; the sync worker and all edge functions use the service-role key; the
--                   tutor toolkit signs in first. The one anon caller is the keepalive pinger,
--                   which calls rpc/keepalive (left alone below).
--   authenticated : SELECT/INSERT/UPDATE/DELETE as today (app + tutor toolkit, both signed in).
--                   Never TRUNCATE (ignores RLS), REFERENCES or TRIGGER (DDL only; foreign-key
--                   checks run as the table owner, not the caller).
--   service_role  : untouched (bypasses RLS; sync worker, send-push, ics-feed, hub-window).
--
-- LEFT ALONE ON PURPOSE
--   plan_blocks, tutor_docs, hub_tutor_tokens (already tight); keepalive() (the pinger calls it
--   as anon); sync_health() (already authenticated-only); default privileges; column grants that
--   limit authenticated on profiles (0016) and project_parts (0003), which REVOKE of TRUNCATE,
--   REFERENCES and TRIGGER does not widen or narrow.
--
-- Idempotent: REVOKE of a privilege that is not held is a no-op, and the GRANTs in part B only
-- restate what authenticated and service_role already hold. Safe to re-run.
-- Proof: run the private proof file (not in this repo) before and after applying.

-- ==================================================================
-- A. Tables and the one view
-- ==================================================================
-- A table-level REVOKE ALL also removes column-level grants for the same role, so anon's
-- column grants on profiles (0016) and project_parts go too.

revoke all on public.announcements      from anon, public;
revoke all on public.assessments        from anon, public;
revoke all on public.efundi_site_map    from anon, public;
revoke all on public.efundi_sync_runs   from anon, public;
revoke all on public.exam_access        from anon, public;
revoke all on public.goals              from anon, public;
revoke all on public.modules            from anon, public;
revoke all on public.past_papers        from anon, public;
revoke all on public.profiles           from anon, public;
revoke all on public.project_parts      from anon, public;
revoke all on public.push_subscriptions from anon, public;
revoke all on public.resources          from anon, public;
revoke all on public.study_log          from anon, public;
revoke all on public.study_units        from anon, public;
revoke all on public.summaries          from anon, public;
revoke all on public.summary_notes      from anon, public;
revoke all on public.module_context     from anon, public;   -- view, security_invoker = on

-- Belt and braces for the two tables that carry column-level grants: name every column, so the
-- result does not depend on the table-level REVOKE above cascading to them.
revoke all (id, role, display_name, created_at, ics_token) on public.profiles from anon, public;
revoke all (id, owner, assessment_id, title, assigned_to, done, done_at, note, position, created_at)
  on public.project_parts from anon, public;

-- TRUNCATE ignores RLS; REFERENCES and TRIGGER are only for creating foreign keys and triggers.
-- PostgREST can issue none of them. SELECT/INSERT/UPDATE/DELETE for authenticated stay as they are.
revoke truncate, references, trigger on public.announcements      from authenticated;
revoke truncate, references, trigger on public.assessments        from authenticated;
revoke truncate, references, trigger on public.efundi_site_map    from authenticated;
revoke truncate, references, trigger on public.efundi_sync_runs   from authenticated;
revoke truncate, references, trigger on public.exam_access        from authenticated;
revoke truncate, references, trigger on public.goals              from authenticated;
revoke truncate, references, trigger on public.modules            from authenticated;
revoke truncate, references, trigger on public.past_papers        from authenticated;
revoke truncate, references, trigger on public.profiles           from authenticated;
revoke truncate, references, trigger on public.project_parts      from authenticated;
revoke truncate, references, trigger on public.push_subscriptions from authenticated;
revoke truncate, references, trigger on public.resources          from authenticated;
revoke truncate, references, trigger on public.study_log          from authenticated;
revoke truncate, references, trigger on public.study_units        from authenticated;
revoke truncate, references, trigger on public.summaries          from authenticated;
revoke truncate, references, trigger on public.summary_notes      from authenticated;
revoke truncate, references, trigger on public.module_context     from authenticated;

-- ==================================================================
-- B. The four SECURITY DEFINER helpers: anon and PUBLIC lose EXECUTE
-- ==================================================================
-- These functions are called INSIDE RLS policies (public tables and storage.objects). A role that
-- can reach a table but not the function gets an ERROR instead of zero rows. After part A, anon
-- reaches no public table at all (the table grant check fails first), so the only place anon could
-- still meet these functions is a logged-out storage request, which the app never makes (the
-- hub-window signed URLs are created with the service-role key and served without anon RLS).
-- authenticated keeps EXECUTE (explicit grant below), so signed-in users, including an account
-- with no profiles row, still get rows or zero rows, never an error.
-- PUBLIC must be revoked too: these functions carry EXECUTE for PUBLIC, and anon inherits it.
-- If this part is ever unwanted, drop it; part A stands on its own.

revoke execute on function public.hub_is_member()    from public, anon;
revoke execute on function public.hub_is_owner(uuid) from public, anon;
revoke execute on function public.hub_role()         from public, anon;
revoke execute on function public.my_ics_token()     from public, anon;

grant execute on function public.hub_is_member()    to authenticated, service_role;
grant execute on function public.hub_is_owner(uuid) to authenticated, service_role;
grant execute on function public.hub_role()         to authenticated, service_role;
grant execute on function public.my_ics_token()     to authenticated, service_role;
