# eFundi sync — build log & audit brief

**For:** Fable (architect) — code audit before we extend this.
**Built by:** Opus, 2026-07-11, in one session with Megan (she ran all the live browser/DevTools recon).
**Status:** LIVE. Migration `0005` applied; worker committed to `main`; a manual `workflow_dispatch`
run **succeeded** and synced EDCC125 end-to-end (idempotent on re-run). Schedule is armed.

Read alongside [`efundi-sync-plan.md`](efundi-sync-plan.md) (your original spec) and
[`efundi-sync-recon.md`](efundi-sync-recon.md) (the recon worksheet). This doc records **what was
actually built, what deviated from the plan and why, the debugging that got it green, and the
things most worth your scrutiny.**

---

## 1. Phase 0 recon — confirmed results

- **No MFA.** eFundi login is plain **classic Apereo/Jasig CAS** (`casprd.nwu.ac.za`, `PRD_LNX1/2`),
  independent of M365. Headless form-replay is viable → Plan B not needed.
- **Login POST:** `https://casprd.nwu.ac.za/cas/login?service=https://efundi.nwu.ac.za/sakai-login-tool/container`.
  Fields observed live: `username`, `password`, `lt`, `execution`, `_eventId=submit`, `submit=LOGIN`,
  `reset`. `lt`/`execution` are **fresh one-time tokens** — scraped every run, never hardcoded.
  Success = 302 → `.../container?ticket=ST-...` → Sakai sets `JSESSIONID` (+ a `haproxy_backend`
  sticky cookie), both `path=/`.
- **`/direct/` API is ENABLED.** Endpoint matrix (probed live, logged in):

  | Endpoint | Result | Used for |
  |---|---|---|
  | `/direct/site.json` | JSON ✓ | site list (id, title) + **auth check** |
  | `/direct/membership.json` | JSON ✓ | (not currently consumed) |
  | `/direct/announcement/site/{id}.json` | JSON ✓ | announcements (+ lecturer mark-lists) |
  | `/direct/announcement/user.json` | JSON ✓ | (not consumed; per-site preferred) |
  | `/direct/assignment/site/{id}.json` | JSON ✓ | assignments (due dates) |
  | `/direct/assignment/my.json` | JSON ✓ | (not consumed; per-site preferred) |
  | `/direct/content/site/{id}.json` | JSON ✓ | files → storage bucket |
  | `/direct/content/user.json` | **400** | — (use per-site) |
  | `/direct/session.json` | JSON ✓ but `userId:null` even when authed | **NOT a reliable auth signal** |
  | `/direct/gradebook.json` | **400** | — |
  | `/direct/gradebook/site/{id}.json` | **501 Not Implemented** | gradebook API is OFF |

- **Grades:** NWU's Sakai gradebook is off **and** lecturers don't use it — they post marks as
  **announcements** (student-number lists) or **scanned files**. So grades flow through
  `announcement/*` and `content/*`; there is deliberately **no gradebook sync**.

## 2. What was built

- **`supabase/migrations/0005_efundi_sync.sql`** — provenance cols (`source`/`source_id`/`source_hash`/
  `source_synced_at`) on `resources` + `assessments`; new `announcements`, `efundi_site_map`,
  `efundi_sync_runs`. Owner-only RLS (0001 `owner_all` pattern). Applied manually (project not on MCP).
- **`sync/`** (Node ESM, deps: `got@14`, `tough-cookie@5`, `cheerio@1`, `@supabase/supabase-js@2`):
  - `auth.js` — CAS form-replay → authenticated `got` client (shared cookie jar).
  - `fetch-efundi.js` — pulls sites/announcements/assignments/files from `/direct/*.json`, normalizes.
  - `write.js` — service-role client; dedupe by `(source,source_id)`+hash; insert/update/upsert;
    downloads files → uploads to the private `resources` bucket. Resolves `owner` via `modules`.
  - `index.js` — orchestrates; one `efundi_sync_runs` row per run; AuthError ⇒ `auth_failed`, no retry.
- **`.github/workflows/efundi-sync.yml`** — cron `0 4,16 * * *` (06:00/18:00 SAST) + `workflow_dispatch`;
  Node 22; secrets injected only in the run step.
- **`sync/README.md`** — human setup (4 secrets, site-map seeding, test).

## 3. Deviations from the plan (please sanity-check these)

1. **Dedupe index is PLAIN, not partial.** Plan §4.1 asked for `unique (source, source_id) where
   source is not null`. Changed to a plain `unique (source, source_id)` because PostgREST `.upsert()`
   throws `42P10` on a *partial* index (it can't infer it as the conflict target — a known gotcha on
   this project). Postgres unique indexes are NULLS DISTINCT by default, so the many manual rows with
   `(null, null)` never collide — **same guarantee, upsert-safe.** ← _confirm you're happy with this._
2. **Auth is verified via `site.json`, not `session.json`.** Plan implied session.json; but this Sakai
   returns `userId:null` from session.json even when fully authenticated (verified live: `/portal`
   showed a Logout control and `site.json` returned 10 sites at the same moment). Auth success =
   `site_collection.length > 0`.
3. **No gradebook sync** (endpoint is 501 + unused by lecturers — see §1).
4. **Assignments: update path is column-scoped.** On a changed assignment the worker updates only
   `title`/`due_date`/hash — it never overwrites `status`/`mark` Megan may have set by hand. New
   assignments insert with `status='upcoming'`. (Announcements/resources use plain upsert — no user-
   owned fields to protect.)
5. **`weight_pct` left null** for synced assignments (Sakai `gradeScaleMaxPoints` is points, not a
   course weighting — mapping it would be wrong).
6. **File size cap 45MB** (skip + log) — Supabase Storage rejects larger; not in the plan but necessary.

## 4. Debug history (5 issues, all fixed — so you know what the CI churn was)

1. `supabase-js` v2 needs **Node 22+** (global WebSocket). Workflow was Node 20 → bumped to 22.
2. `got` default **re-POSTs on 302**; CAS expects a browser-style GET of the `?ticket=` URL →
   added `methodRewriting: true`.
3. **`session.json` false negative** (see deviation #2) → switched auth check to `site.json`.
4. **One slow endpoint (30s timeout) aborted the whole run** → `getJson` now catches errors → null
   (60s allowance), file downloads 120s, and each site syncs in its own try/catch (one failure ⇒
   run status `partial`, not dead).
5. **70MB `.mp4` exceeded Storage limit and aborted the site** → 45MB skip guard + per-file try/catch.

## 5. Verified behaviour

Final `workflow_dispatch` run: authenticated; skipped 9 unmapped sites; synced EDCC125 (only mapped
site); **New: 7 / Updated: 0** on top of a prior **New: 33** (total ~40 items) — the second run added
only the previously-missed files and **duplicated nothing**, confirming idempotency. 70MB video skipped
cleanly. Run status `success`, `efundi_sync_runs` row written.

## 6. Audit focus / known risks / open questions

- **`fetch-efundi.js` content field names** (`resourceId`/`type`/`size`/`lastModified`/`url`) are
  defensive guesses — the recon site had no files. EDCC125's files *did* come through, so they're close,
  but worth confirming against a raw `content/site/{id}.json` payload. Same for whether the returned
  set includes folder/collection entries we should filter more strictly.
- **`resolveOwner()` = `select owner from modules limit 1`.** Works because it's a single-user hub; note
  the assumption. Worker sets `owner` explicitly on every insert (service role has no `auth.uid()`).
- **Service-role scope:** worker bypasses RLS. Confirm it only ever writes owner-scoped rows (it does:
  every insert carries `owner`; updates are keyed on `source='efundi'`+`source_id`).
- **Storage orphans:** if a file's title changes, its storage key changes; the metadata row updates to
  the new path but the old object is left in the bucket. Minor; not cleaned up.
- **Announcement dedupe hash** includes `body_html`; if eFundi re-serializes identical HTML differently
  between runs it could false-"update". Not observed, but a candidate for a normalized hash.
- **No Phase 4 UI yet:** `announcements` rows have no frontend. Assignments + resources render in the
  existing UI; announcements (incl. mark-lists) are invisible until built.
- **Secrets:** `EFUNDI_*`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` in GitHub Actions Secrets only;
  nothing sensitive committed (verified: `node_modules`/`.env` gitignored; no keys in tree).
- **Policy:** automated twice-daily login — Megan to eyeball NWU's IT acceptable-use policy before
  relying on the schedule; can revert to `workflow_dispatch`-only in one line.

## 7. Remaining work

1. Map the other modules into `efundi_site_map` (one insert each; UUID from `/portal/site/<uuid>`).
2. **Phase 4** — surface `announcements` in `src/App.jsx` + a "synced from eFundi" badge + a last-sync
   indicator from `efundi_sync_runs`.
3. (Optional) normalize announcement hashing; storage-orphan cleanup; consume `membership.json` if a
   stricter enrollment signal is ever needed.
