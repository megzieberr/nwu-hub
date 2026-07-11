# Implementation plan: eFundi → NWU Study Hub auto-sync

**Audience:** the implementation model (Opus). This is a build spec, not a finished design to rubber-stamp. Follow the phase gates in order. **Do not start Phase 1 until the Phase 0 pre-flight passes** — the whole project can be blocked by MFA, and building anything before that is confirmed is wasted work.

**Author:** Fable (architect). **Owner:** Megan (single user, owner role `megzieberr@nwu-hub.local`).

---

## 1. Goal (restated)

Automatically log into eFundi (NWU's Sakai LMS) twice a day, pull anything **new** (resources/files, announcements, assignments, grades), and write it into the existing Study Hub Supabase backend — deduplicated, so only genuinely new items appear. The user never opens eFundi's UI manually again. This replaces a manual "check eFundi → download → feed into hub" loop.

## 2. What already exists (do not rebuild)

- **Frontend:** React 18 + Vite 5 + Tailwind, single-user PWA, **static site on GitHub Pages** (public repo). Almost all UI is in `src/App.jsx`. `base: '/nwu-hub/'` in `vite.config.js`.
- **Backend:** Supabase project `https://aefjicdxeflqnquiebvc.supabase.co`. Security boundary is **RLS**, not key secrecy (anon key is intentionally public).
- **Data model** (all `public`, owner-scoped RLS; helpers `hub_is_member()`, `hub_is_owner(uuid)`, `hub_role()` from `0002`):
  - `modules`, `study_units`, `assessments` (title/type/due_date/weight_pct/status/mark), `summaries` (HTML payloads), `resources` (metadata + `storage_path` into private `resources` bucket), `past_papers`, `project_parts`, `goals`, `study_log`, `profiles`.
- **Storage:** one private bucket `resources`. Owner-only writes, member reads via signed URLs. Canonical policy pattern is in `supabase/migrations/0003_partner_sharing.sql`.
- **Migrations:** `supabase/migrations/0001..0004`. **Applied manually by pasting into the Supabase SQL editor** — project is NOT on the Supabase CLI/MCP. New migrations must be **idempotent** and carry the same header convention. Next file = `0005_efundi_sync.sql`.
- **Server-side automation today:** none. No edge functions, no cron, no pg_cron/pg_net, no committed service-role key. **This feature introduces the first server-side worker.** That is expected.

### Hard constraints (violating these is a defect)
- The frontend/repo is **public and static** → it must **never** contain the eFundi password or a Supabase **service-role** key. All privileged secrets live in **GitHub Actions Secrets** only.
- The worker writes as a privileged actor (service role) — it bypasses RLS, so it must be conservative and only ever touch the owner's own rows.
- Twice-daily, gentle, self-only. **On any auth failure, stop immediately** — never retry-loop a bad password (account-lockout risk).

---

## 3. Phase 0 — Pre-flight recon (GATE — nothing else proceeds until this passes)

These are findings to confirm empirically (the architect could not, from outside — eFundi is network-blocked and needs real credentials). Record results in `docs/efundi-sync-recon.md`.

### 3.1 MFA gate (the dealbreaker) — ✅ **PASSED (2026-07-11, confirmed by owner)**
Human test result: incognito login at `efundi.nwu.ac.za` needs **only student number + password**. **No `login.microsoftonline.com` redirect, no authenticator/OTP.** Headless fresh-login is viable. Plan B (§8) is NOT needed.

Confirmed from the login screen: this is **classic self-hosted Apereo/Jasig CAS** (`NWU V1.0.8 PRD_LNX1`, bilingual page, a "Warn me before logging me into other sites" `warn` checkbox), served as a plain HTML form and **completely independent of Microsoft 365** — so NWU tightening M365 MFA later does not affect this path. Implication: **use plain form-replay + cookie jar; a headless browser (Playwright) is NOT required.**

### 3.2 Login mechanics — classic CAS form-replay (confirmed classic Apereo/Jasig CAS)
Because 3.1 confirmed classic self-hosted CAS, the worker replays the standard CAS form flow (no JS/browser). Using the real browser session (DevTools → Network), capture exact field names before coding:
- **GET the login page** (with a `?service=<eFundi return URL>` param): scrape the hidden fields. Classic CAS uses an **`execution`** token and **`_eventId=submit`**, and older versions also a login ticket **`lt`**. There is a `warn` checkbox (leave unchecked). These tokens are per-request → scrape fresh every run, never hardcode.
- **POST** `username` (student number) + `password` + the scraped `execution`/`lt` + `_eventId=submit` back to the form `action`.
- **Follow the redirect chain:** CAS issues a ticket-granting cookie and redirects to the `service` URL with `?ticket=ST-...`; Sakai validates the ST and sets the authenticated **`JSESSIONID`**. Keep that cookie for all subsequent `/direct/` calls. Replicate exactly what the browser does end to end.

### 3.3 Sakai `/direct/` API probe (determines robustness)
While logged in, hit these in the browser and record which return JSON (vs 403/404/HTML):
- `/direct/site.json` and `/direct/membership.json` — enrolled sites (→ modules).
- `/direct/announcement/site/{siteId}.json` (or `/direct/announcement/user.json`).
- `/direct/assignment/site/{siteId}.json`.
- `/direct/content/site/{siteId}.json` or `/direct/content/resources/...` — files, with per-item IDs, mime, size, last-modified.
- Gradebook: `/direct/gradebook/...` (endpoint availability varies by Sakai version — record what exists).
- Also probe `/direct/session.json` (POST `_username`/`_password`) — if NWU left legacy Sakai web-login enabled, this is a simpler auth path than CAS replay. Likely disabled under CAS; confirm.

**Output of Phase 0:** a documented, working auth sequence + the concrete list of `/direct/` endpoints that return usable JSON. If `/direct/` is largely disabled, note it — Phase 2 then leans on HTML parsing (more fragile) and the user should be told robustness drops.

---

## 4. Phase 1 — Data model (migration `0005_efundi_sync.sql`)

Follow existing conventions: idempotent (`create table if not exists`, `alter table ... add column if not exists`), RLS enabled, owner-scoped policies copied from `0003`. Applied by pasting into the SQL editor.

### 4.1 Provenance columns on existing tables (so dedupe works and synced items are marked)
Add to `resources`, `assessments`, and (see 4.3) the new `announcements` table:
- `source text` (nullable; `'efundi'` for synced rows, null for manual).
- `source_id text` (the stable Sakai entity id/reference).
- `source_hash text` (hash of the meaningful content, for detecting edits).
- `source_synced_at timestamptz`.
- Unique partial index per table on `(source, source_id)` where `source is not null` → the DB-level dedupe guarantee.

### 4.2 Course mapping
`efundi_site_map`: `id`, `efundi_site_id text unique`, `module_id uuid references modules(id)`, `title_snapshot text`, `active bool default true`. The worker refuses to ingest content for an unmapped site (logs it as "needs mapping") rather than guessing. Seed initially from Phase 0's site list.

### 4.3 Announcements (new — no home today)
`announcements`: `id`, `module_id`, `source`, `source_id`, `source_hash`, `title`, `body_html`, `posted_at`, `source_synced_at`, standard owner RLS. Surface in frontend in Phase 4.

### 4.4 Sync bookkeeping
`efundi_sync_runs`: `id`, `started_at`, `finished_at`, `status` (`ok`/`auth_failed`/`partial`/`error`), `items_new int`, `items_updated int`, `error text`. One row per worker run — gives the user a visible health log and the worker a place to record failures without crashing silently.

---

## 5. Phase 2 — The sync worker (`/sync`, Node)

Location: new top-level `sync/` dir (kept out of the Vite build). Plain Node (ESM), minimal deps: a fetch with cookie-jar handling (`undici`/`node-fetch` + manual cookie store, or `got` with `cookieJar`), an HTML parser for fallback (`cheerio`), `@supabase/supabase-js`. No headless browser unless Phase 0 proves the login is impossible without executing JS (avoid Playwright if a plain form-replay works — it's heavier and slower in CI).

Module breakdown:
1. **`auth.js`** — replay the CAS flow from §3.2: GET login page → extract `execution`/tokens → POST creds → follow redirects → return an authenticated cookie jar. Detect failure explicitly (still on a login page, or a Microsoft redirect appears) and **throw a typed `AuthError` that stops the run** — no retries.
2. **`fetch-efundi.js`** — using the cookie jar, pull each content type from the `/direct/` endpoints confirmed in Phase 0. Normalize into internal shapes: `{type, efundiSiteId, sourceId, title, ..., raw}`. HTML-parse fallback isolated here so the rest of the worker is source-agnostic.
3. **`dedupe.js`** — for each item: resolve `efundiSiteId → module_id` via `efundi_site_map` (skip+log if unmapped); compute `source_hash`; query existing `(source='efundi', source_id)`; classify as **new** / **changed** (hash differs) / **unchanged**.
4. **`write.js`** — service-role Supabase client. New/changed items:
   - **Files/resources:** download the file from eFundi (authenticated), upload to the `resources` bucket under a deterministic path (e.g. `efundi/{module}/{sourceId}-{filename}`), then upsert the `resources` metadata row. Skip re-download if unchanged.
   - **Assignments → `assessments`** (upsert on `(source, source_id)`; map due date/title/weight; set `type='assignment'`).
   - **Grades →** update `assessments.mark` where a matching assessment exists.
   - **Announcements → `announcements`** upsert.
   - All upserts keyed on the `(source, source_id)` unique index → idempotent, safe to re-run.
5. **`index.js`** — orchestrate: open a `efundi_sync_runs` row → auth → fetch → dedupe → write → close the run row with counts/status. Any `AuthError` → record `auth_failed`, exit non-zero (so the user sees a failed Actions run), do NOT retry.

Design rules: idempotent end-to-end (a crashed run half-way is safe to re-run); every external call has a timeout; total run is gentle (sequential or low concurrency, not a burst).

---

## 6. Phase 3 — Scheduling + secrets

- **`.github/workflows/efundi-sync.yml`:** `on: schedule` with two cron entries for morning + evening **SAST (UTC+2)** — remember GitHub cron is **UTC**, so 06:00/18:00 SAST = `0 4,16 * * *`. Add `workflow_dispatch` for manual test runs. Job: checkout → setup Node → `npm ci` in `sync/` → `node sync/index.js`.
- **Secrets (GitHub Actions Secrets, repo settings — never committed):** `EFUNDI_USERNAME`, `EFUNDI_PASSWORD`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Injected as `env:` in the workflow step only.
- Public-repo note: scheduled workflows on the default branch have access to secrets; PRs from forks do not. Keep the sync workflow triggered only by `schedule`/`workflow_dispatch`, never by `pull_request`.
- GitHub cron is best-effort (can be delayed under load) — acceptable for twice-daily. If strict timing ever matters, note Supabase `pg_cron` + Edge Function as the alternative (see §7).

---

## 7. Architecture decision record

**Chosen: GitHub Actions scheduled Node worker.** Rationale: repo already uses Actions; no execution-time limit (matters when downloading PDFs); secrets handling is a solved, first-class feature; zero new platform to stand up. **Rejected alternative: Supabase Edge Function + pg_cron** — would introduce edge functions and CLI setup from scratch (none exist today), Deno cookie/CAS handling is fiddlier, and function timeouts risk large file batches. Revisit only if GitHub cron timing becomes a real problem or if the user wants everything inside Supabase.

## 8. Plan B (only if Phase 0 MFA gate FAILS)

Do not build the fresh-login worker. Options, in order of preference — **confirm with the user before building either**:
1. **Session-cookie refresh:** user logs in + passes MFA once in a browser, exports the authenticated session cookie into an Actions Secret; the worker reuses it and refreshes it each run to extend its life. Fragile — dies whenever the session hard-expires or MFA re-challenges; needs periodic manual re-auth. Add a clear "session expired, please re-auth" signal (a failed `efundi_sync_runs` row + optional notification).
2. **Abandon full automation:** a one-tap manual assist instead of true auto-sync. Set expectations honestly.

## 9. Phase 4 — Surface in the frontend (after sync works)

- Add an **Announcements** view (reads new `announcements` table) in `src/App.jsx` near the existing `Promise.all` data-load block (~lines 236–267).
- Show a small **"synced from eFundi"** badge on rows where `source='efundi'`, and a last-sync indicator sourced from `efundi_sync_runs`.
- No privileged code here — frontend stays read-only via anon key + RLS, exactly as today.

## 10. Risk register

| Risk | Likelihood | Handling |
|---|---|---|
| eFundi CAS enforces MFA on the LMS path | Unknown — **gates project** | Phase 0 test; Plan B if it fails |
| CAS form / `/direct/` API changes | Low–med | `/direct` JSON is stable; scrape tokens fresh each run; fail loudly via `efundi_sync_runs` |
| `/direct/` endpoints disabled at NWU | Med | HTML-parse fallback in `fetch-efundi.js`; warn user robustness drops |
| Account lockout from bad logins | Low | **Stop on first auth failure, never retry** |
| NWU AUP disallows automated access | Policy, not technical | User reads NWU "responsible use of IT" policy before building; worst case = access blocked |
| Secret leakage | Low | Secrets only in Actions Secrets; never in static frontend/public repo |
| Duplicate/edited-item handling | Med | `(source, source_id)` unique index + `source_hash` for edits |

## 11. Guardrails / non-goals
- Self-only, twice-daily, gentle. No multi-account, no aggressive polling.
- Never write anything but the owner's own data.
- Never commit credentials or a service-role key.
- Do not build past a failed phase gate; when Phase 0 fails, stop and report, don't improvise around MFA.
