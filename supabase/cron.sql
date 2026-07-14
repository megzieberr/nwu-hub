-- ============================================================
--  NWU Study Hub — the reminder schedule
--
--  A "schedule" = a job the database runs by itself on a timer. This one calls the send-push Edge
--  Function every 15 minutes; the function decides what (if anything) is due right now and sends it.
--  Every-15-min cadence is what lets "~45 min before class" and "07:00 on a test morning" land on
--  time — unlike the GitHub sync cron, pg_cron does NOT drift.
--
--  RUN THIS ONLY AFTER you have:
--    1. run migration 0013_push_reminders.sql (already applied for you via MCP),
--    2. deployed the send-push Edge Function, and
--    3. set its secrets (including CRON_SECRET).
--
--  BEFORE running, replace the ONE placeholder below:
--    <CRON_SECRET>  -> the EXACT same value you set as the CRON_SECRET Edge secret.
--  (The project ref aefjicdxeflqnquiebvc is already filled in — it's public, it's in your URL.)
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Remove an old copy first so this file is safe to re-run.
do $$ begin perform cron.unschedule('nwu-hub-reminders'); exception when others then null; end $$;

select cron.schedule(
  'nwu-hub-reminders',
  '*/15 * * * *',
  $job$
  select net.http_post(
    url     := 'https://aefjicdxeflqnquiebvc.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<CRON_SECRET>'),
    body    := jsonb_build_object('type', 'reminders')
  );
  $job$
);

-- To check the job exists:   select jobname, schedule from cron.job;
-- To stop reminders later:   select cron.unschedule('nwu-hub-reminders');
