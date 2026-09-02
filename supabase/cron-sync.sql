-- eFundi sync trigger: pg_cron starts the GitHub workflow, because GitHub's own
-- scheduler decayed to dropping whole runs (late Aug 2026) while pg_cron has never
-- drifted here. Applied 2026-09-02 (PLAN-sync-trigger.md).
--
-- Safe to commit: the job reads the GitHub token out of Vault by name at run time,
-- so no secret ever appears in this file. The token itself was stored once via the
-- dashboard SQL editor:
--   select vault.create_secret('<token>', 'github_pat_sync', '...');
-- Token: fine-grained PAT 'nwu-hub-sync-trigger', repo megzieberr/nwu-hub only,
-- permission Actions read/write only, NO expiry (chosen deliberately — a silent
-- expiry was the plan's biggest risk). Revoke/regenerate on GitHub if ever needed;
-- after a regenerate, update Vault with:
--   select vault.update_secret((select id from vault.secrets where name='github_pat_sync'), '<new token>');
--
-- pg_cron runs in UTC; SAST is UTC+2 year-round, so 6,10,14,17 = 08:00, 12:00,
-- 16:00, 19:00 SAST. GitHub's workflow cron keeps ONE daily 05:00 UTC slot as a
-- backstop (see .github/workflows/efundi-sync.yml).

do $do$ begin perform cron.unschedule('nwu-hub-sync'); exception when others then null; end $do$;

select cron.schedule(
  'nwu-hub-sync',
  '0 6,10,14,17 * * *',          -- 08:00, 12:00, 16:00, 19:00 SAST
  $job$
  select net.http_post(
    url := 'https://api.github.com/repos/megzieberr/nwu-hub/actions/workflows/efundi-sync.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization',         'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'github_pat_sync'),
      'Accept',                'application/vnd.github+json',
      'X-GitHub-Api-Version',  '2022-11-28',
      'User-Agent',            'nwu-hub-cron',   -- GitHub 403s without a User-Agent, and the error does not say why
      'Content-Type',          'application/json'
    ),
    body := jsonb_build_object('ref', 'main')
  );
  $job$
);
