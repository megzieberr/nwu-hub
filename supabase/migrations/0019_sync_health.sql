-- 0019 — sync health keyhole (2026-09-02, phase 2 of PLAN-sync-trigger.md, reshaped:
-- push alerts dropped by Megan's ruling — her phone refuses notifications — so the hub
-- itself shows a warning when the sync has gone quiet).
--
-- efundi_sync_runs has RLS on and no client policies (the worker writes it with the
-- service role). Rather than opening the table, expose ONE security-definer function
-- returning only what the header line needs: when the last successful sync ran, when
-- the last run of any kind ran, and its status. No row access, no error text.

create or replace function public.sync_health()
returns table (last_ok timestamptz, last_run timestamptz, last_status text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    (select max(started_at) from efundi_sync_runs where status = 'ok'),
    (select max(started_at) from efundi_sync_runs),
    (select status from efundi_sync_runs order by started_at desc limit 1);
$$;

-- Functions default EXECUTE to PUBLIC — take it away, then grant to signed-in users only.
revoke all on function public.sync_health() from public, anon;
grant execute on function public.sync_health() to authenticated;
