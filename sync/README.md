# eFundi → Study Hub sync worker

Logs into eFundi (NWU's Sakai LMS) twice a day, pulls anything **new**, and writes it into
the Study Hub Supabase backend — deduplicated. Runs in GitHub Actions
(`.github/workflows/efundi-sync.yml`); never part of the Vite/frontend build.

Full design: [`docs/efundi-sync-plan.md`](../docs/efundi-sync-plan.md).
Recon (auth flow + live endpoint results): [`docs/efundi-sync-recon.md`](../docs/efundi-sync-recon.md).

## What it does each run

1. `auth.js` — replay NWU's classic CAS login form → authenticated cookie jar.
2. `fetch-efundi.js` — pull sites, announcements, assignments, files from `/direct/*.json`.
3. `write.js` — dedupe by `(source='efundi', source_id)` + content hash, then insert/update
   into `announcements`, `assessments`, `resources` (files uploaded to the private bucket).
   Runs as the **service role**, so it sets `owner` explicitly and only touches your rows.
4. `index.js` — orchestrates and logs one row to `efundi_sync_runs` (health log).

Grades are **not** read from the Sakai gradebook (NWU has it switched off, and lecturers
don't use it) — mark-lists arrive as **announcements** instead.

## One-time setup (the human bits)

### 1. Add 4 repository secrets
GitHub → your `nwu-hub` repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|--------|-------|
| `EFUNDI_USERNAME` | your student number (34199675) |
| `EFUNDI_PASSWORD` | your eFundi password |
| `SUPABASE_URL` | `https://aefjicdxeflqnquiebvc.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → **API** → `service_role` **secret** key |

⚠️ The `service_role` key bypasses all security — it lives **only** here in Actions Secrets,
never in the app, the repo, or `.env` committed anywhere.

### 2. Map at least one course
The worker refuses to sync a site it hasn't been told maps to a module. Get a course's
Sakai site id from its URL (open the course in eFundi → the address bar shows
`.../portal/site/`**`<uuid>`**), then in the Supabase SQL editor:

```sql
insert into public.efundi_site_map (owner, efundi_site_id, module_id, title_snapshot)
select m.owner, '<sakai-site-uuid>', m.id, 'EDCC125'
from public.modules m
where m.code = 'EDCC125'
on conflict (owner, efundi_site_id) do update
  set module_id = excluded.module_id, title_snapshot = excluded.title_snapshot;
```

Repeat per module (or leave a site out to skip it).

### 3. Test it
GitHub → **Actions → eFundi sync → Run workflow** (the `workflow_dispatch` button).
Then check:
- the Actions log (each mapped site prints `→ syncing: …`, plus `New:` / `Updated:` counts),
- the `efundi_sync_runs` table (a row with `status='ok'`),
- the hub — new announcements/assignments/files should appear.

If a run shows `status='auth_failed'`, the login didn't work — fix the username/password
secret; the worker deliberately does not retry (lockout safety).

## Local run (optional, for debugging)
```bash
cd sync
npm install
EFUNDI_USERNAME=... EFUNDI_PASSWORD=... \
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node index.js
```
Never commit those values.
