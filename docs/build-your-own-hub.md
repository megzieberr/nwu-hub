# Build your own NWU Study Hub

A plain-language guide to how this hub was built and, in particular, how it talks to eFundi.
It is written for another NWU student who wants their own version. You do not need to have
read anything else in this repo first.

> **Honesty up front.** eFundi has **no official public API** for students. This hub logs in
> *as you*, with *your* student number and password, exactly the way your browser does, and
> then reads the same JSON that eFundi's own web pages read. That works today, it is read-only,
> and it only ever sees content you can already see. But it is unofficial: if NWU changes the
> login page or switches on multi-factor auth for eFundi, the sync stops working until someone
> updates it. Use only your own account, and never share your credentials with anyone, including
> whoever helps you set this up.

---

## 1. The big picture

```
  eFundi (Sakai LMS)                GitHub Actions (free)                 Supabase (free tier)
  ─────────────────                 ─────────────────────                 ────────────────────
  announcements  ──┐                                                      Postgres tables
  assignments    ──┼──► sync worker (Node.js, runs a few times a day) ──► + private file bucket
  files (PDFs)   ──┘    1. log in via CAS                                 + Row-Level Security
                        2. pull /direct/*.json                                    │
                        3. dedupe + write                                         │
                        4. (optional) AI turns announcements into to-dos          ▼
                                                                          React web app
  GitHub Pages (free) ◄── built by GitHub Actions on every push ◄──────── (Vite + Tailwind)
```

Three moving parts, all on free tiers:

| Part | What it is | Where it lives |
|---|---|---|
| **Frontend** | A React single-page app (a PWA, so it installs on a phone). Almost all of it is in `src/App.jsx`. | Built by `.github/workflows/deploy.yml`, hosted on **GitHub Pages**. |
| **Backend** | Postgres database + file storage + login, all from **Supabase**. No server code of your own. | Supabase project. Schema is in `supabase/migrations/`. |
| **Sync worker** | A small Node script that logs into eFundi, pulls new content, and writes it into Supabase. | `sync/`, run by `.github/workflows/efundi-sync.yml` on a schedule. |

The frontend never talks to eFundi. It only talks to Supabase. The sync worker is the only thing
that ever touches eFundi, and it runs in GitHub's cloud, not in the browser.

### Why this shape

- **No server to run or pay for.** GitHub Pages serves static files. Supabase is the database and
  the login. GitHub Actions is the "cron job". All free at student scale.
- **The repo is public and holds no secrets.** The Supabase *publishable (anon) key* is safe to
  commit because **Row-Level Security (RLS)** on every table means the anon key can only read rows
  that belong to the logged-in user. Your eFundi password and the Supabase *service-role* key live
  **only** in GitHub Actions secrets.
- **eFundi is an inbox, not a mirror.** The hub does not re-display eFundi. Raw announcements and
  files are stored as context for AI tutors, and a small AI step turns the actionable
  announcements into tasks and class slots. That is a design choice; a simpler hub could just show
  the raw announcements.

---

## 2. What you need

- A GitHub account (free). Fork or copy this repo.
- A Supabase account (free). Create one project.
- Node.js 22 on your laptop for local testing. The hosted bits use Node 22 too.
- Your NWU student number and eFundi password. They go into GitHub secrets, nowhere else.
- Optional: an Anthropic API key if you want the "announcements to objectives" AI step. It uses
  the cheapest model and costs pennies a month. Without the key the sync still works and just
  skips that step.

Rough time: an afternoon if you follow this guide in order.

---

## 3. The backend (Supabase)

### 3.1 Create the project and apply the schema

1. In Supabase, create a project. Note the **Project URL** and the **publishable / anon key**
   (Project Settings → API). Also note the **service_role** key, but treat it like a password.
2. Open the SQL editor and paste in the migrations from `supabase/migrations/` **in numeric
   order** (`0001`, `0002`, ...). Each file is idempotent, so re-running one is harmless.
   For a minimal hub you need at least `0001_init.sql` (modules, assessments, goals, study log)
   and `0005_efundi_sync.sql` (the sync tables). The later ones add features you may not want.
3. Create a **private** storage bucket called `resources`. This is where synced PDFs land.

The core tables the sync writes to:

| Table | Holds | Filled by |
|---|---|---|
| `modules` | Your modules: code (e.g. `MATV121`), title, colour. | You, once, by hand. |
| `efundi_site_map` | eFundi site UUID → `modules.id`. The worker refuses to sync unmapped sites. | Worker auto-maps by title; you can also insert rows by hand. |
| `announcements` | Raw announcements (title, HTML body, posted date). | Worker. |
| `assessments` | Assignments and their due dates. | Worker (and you). |
| `resources` | Files: title, MIME type, storage path in the bucket. | Worker (and you). |
| `goals` | To-dos and class slots shown on the dashboard. | The optional AI step. |
| `efundi_sync_runs` | One row per sync run: status, counts, error. Your health log. | Worker. |

Every table has an `owner uuid` column that defaults to `auth.uid()`, and an RLS policy of the form
"owner = auth.uid()". That single pattern is the whole security model.

### 3.2 Login

The app uses Supabase Auth with email + password, but you never see an inbox: a username is turned
into a synthetic email like `yourname@nwu-hub.local` (`src/lib/auth.js`). For that to work, turn
**off** "Confirm email" in Supabase → Authentication → Providers → Email. The first login creates
the account; after that, the same username and password log you in.

Once you have logged in once, find your user id under Authentication → Users. The sync worker
needs it (see 5.3).

---

## 4. The frontend (React on GitHub Pages)

1. `npm install`, then `npm run dev` for a local server.
2. The app reads two build-time variables: `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
   (`src/lib/supabase.js`). Locally, put them in a `.env.local` file (git-ignored). In the deploy
   workflow they are written directly into `.github/workflows/deploy.yml`, which is fine because
   the anon key is public by design.
3. Set `base` in `vite.config.js` to your repo name (GitHub Pages serves at
   `https://<you>.github.io/<repo>/`).
4. In the repo settings, enable GitHub Pages with source "GitHub Actions". Every push to `main`
   then builds and deploys.

Things in this repo that are specific to Megan and that you must change: the Supabase URL and anon
key in `deploy.yml`, the hard-coded feed host in `src/CalendarCard.jsx`, the hub URL in
`src/lib/classcal.js`, and the module codes on the dashboard. A grep for `aefjicdxeflqnquiebvc`
(Megan's project ref) and `megzieberr` finds them all.

---

## 5. The eFundi connection (the part people ask about)

This is the heart of it. There is no API key and no OAuth. The worker reproduces what a browser
does when you log in, keeps the session cookie, and then asks Sakai's built-in JSON endpoints for
data. Everything below is in `sync/auth.js` and `sync/fetch-efundi.js`.

### 5.1 Step one: log in through CAS

NWU uses classic Apereo **CAS** single sign-on at `casprd.nwu.ac.za`. eFundi hands you to CAS,
CAS checks your password, and sends you back with a ticket. The worker does the same four steps:

1. `GET https://casprd.nwu.ac.za/cas/login?service=https://efundi.nwu.ac.za/sakai-login-tool/container`
   and parse the HTML. The login form contains hidden fields (`execution`, `lt`, `_eventId`) that
   change on every page load. The worker scrapes **every** input in the form rather than
   hard-coding names, so a small change to the form does not break it.
2. `POST` the form back to its `action` URL with `username`, `password`, and those hidden fields,
   as ordinary `application/x-www-form-urlencoded`.
3. Follow the redirects. CAS answers with a 302 to the service URL plus `?ticket=ST-...`; Sakai
   validates the ticket and sets a `JSESSIONID` cookie (plus a load-balancer sticky cookie). The
   HTTP client must **follow the 302 with a GET, not re-POST**, or the ticket fails. In `got`
   that is `methodRewriting: true`. A cookie jar (`tough-cookie`) keeps the cookies.
4. Confirm it worked by calling `GET /direct/site.json` and checking that at least one site comes
   back. On this Sakai version `/direct/session.json` reports `userId: null` even when logged in,
   so it is **not** a reliable check.

Two safety rules that matter:

- **Never retry a failed login.** Wrong-password retries can lock your NWU account. The worker
  throws an `AuthError`, records `auth_failed` in `efundi_sync_runs`, and exits. It does not try
  again until the next scheduled run.
- **Detect a Microsoft redirect and stop.** If the POST ends up on `login.microsoftonline.com`,
  NWU has moved that path to Microsoft 365 / MFA and headless login is no longer viable. The
  worker treats this as an auth failure rather than trying to be clever.

### 5.2 Step two: read Sakai's `/direct` JSON API

Sakai (the software behind eFundi) ships a JSON API called EntityBroker under `/direct/`. NWU has
left the read endpoints enabled. With the session cookie from step one, these return JSON:

| Endpoint | Returns | Notes |
|---|---|---|
| `/direct/site.json?_limit=50&_start=0` | Your enrolled sites (`site_collection`: `id`, `title`). | **Paginated, default 10 per page.** Walk `_start` until a page adds nothing new, or you silently miss modules. |
| `/direct/announcement/site/{siteId}.json` | `announcement_collection`: `id`, `title`, `body` (HTML), `createdOn`. | This is also where lecturers post mark lists, since NWU's gradebook is off. |
| `/direct/assignment/site/{siteId}.json` | `assignment_collection`: `id`, `title`, `dueTime`. | Due date arrives in several shapes (epoch ms, `{epochSecond}`, ISO string). Parse defensively. |
| `/direct/content/site/{siteId}.json` | `content_collection`: files and folders in the Resources tool, with `url`, `type`, `size`. | Heaviest call and the first to time out. Use a long timeout (150 s) and one retry. Skip folders. |
| `/direct/lessons/site/{siteId}.json` then `/direct/lessons/lesson/{lessonId}.json` | Lessons-tool pages. Files are items whose `sakaiId` starts with `/group/`, `/private/` or `/attachment/`. | Some modules publish everything through Lessons, not Resources. Subpages are inlined as nested `contentsList` arrays, so walk recursively. |

To download a file, `GET` its `url` (or `https://efundi.nwu.ac.za/access/content<sakaiId>`) with
the same cookie jar and upload the bytes to the Supabase bucket.

Things that returned nothing useful during recon and are therefore not used: `/direct/gradebook`
(switched off at NWU), `/direct/membership.json`, the `user.json` / `my.json` variants.

You can verify all of this yourself in five minutes: log into eFundi in a browser, then open
`https://efundi.nwu.ac.za/direct/site.json` in a new tab. If you see JSON, you are looking at
exactly what the worker sees. `docs/efundi-sync-recon.md` is the worksheet that was used to map
this out originally.

### 5.3 Step three: write to Supabase without creating duplicates

The worker connects with the **service-role key**, which bypasses RLS. Two consequences:

- It must set `owner` explicitly on every row, to **your** user id from 3.2. The worker looks this
  up once per run (`resolveOwner` in `sync/write.js`).
- That key must never leave GitHub Actions secrets.

Deduplication is simple and worth copying:

- Every synced row stores `source = 'efundi'`, `source_id` (the Sakai id), and `source_hash`
  (a SHA-256 of the fields that matter).
- At the start of a run the worker loads the existing `source_id → source_hash` map per table.
  New id → insert. Known id with a different hash → update. Same hash → skip.
- The unique index is a **plain** `unique (source, source_id)`, not a partial one, because
  PostgREST's `upsert()` cannot target a partial index. Nulls are distinct in Postgres, so rows
  you create by hand (with null source) never collide.

Videos are never synced (too big, and you will watch them on eFundi anyway). The worker skips
them by MIME type and extension, and also deletes any that slipped through.

### 5.4 Step four (optional): the AI "objectives" step

`sync/objectives.js` reads announcements not yet processed, sends each one to Claude Haiku with a
strict prompt, and writes back zero or more `goals` rows: a task ("Submit Assignment 1") or a class
slot with a weekday, time and join link. Most announcements produce nothing, which is the point.
It also reconciles against classes already on the dashboard, because lecturers often post a class
time first and the Teams link days later.

You can skip this entirely. Without `ANTHROPIC_API_KEY` the worker logs "skipped" and moves on.
A simpler alternative is to show the raw announcements in your frontend and not have an AI step
at all.

### 5.5 Scheduling

`.github/workflows/efundi-sync.yml` runs the worker. Set your own GitHub Actions secrets:

| Secret | Value |
|---|---|
| `EFUNDI_USERNAME` | Your student number |
| `EFUNDI_PASSWORD` | Your eFundi password |
| `SUPABASE_URL` | Your project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Your project's service_role key |
| `ANTHROPIC_API_KEY` | Optional |

A `schedule: cron` entry in the workflow is enough to start with. Be aware that GitHub's scheduler
is best-effort and does drop or delay runs. This repo therefore moved to Supabase `pg_cron` calling
GitHub's `workflow_dispatch` API four times a day (`supabase/cron-sync.sql`), keeping a single
GitHub cron as a backstop. That needs a fine-grained GitHub token stored in Supabase Vault. Start
with plain GitHub cron and add that later only if you notice missed runs.

The `concurrency` block in the workflow stops two runs overlapping. Keep it.

### 5.6 Test the whole thing locally first

```bash
cd sync
npm install
EFUNDI_USERNAME=... EFUNDI_PASSWORD=... \
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node index.js
```

Expect a line like `[auth] authenticated; N sites visible.`, then one `→ syncing:` line per mapped
site, then `✓ Done. New: X, Updated: Y.`. Check `efundi_sync_runs` in Supabase for a row with
`status = 'ok'`. Then trigger the GitHub workflow by hand (Actions → eFundi sync → Run workflow).

### 5.7 Mapping eFundi sites to your modules

The worker only syncs sites in `efundi_site_map`. On each run it auto-maps any enrolled site whose
title contains one of your module codes, as long as exactly one site matches. If two match (for
example a tutorial site and the main site) it prints both and waits for you to pick:

```sql
insert into public.efundi_site_map (owner, efundi_site_id, module_id, title_snapshot)
select m.owner, '<sakai-site-uuid>', m.id, '<site title>'
from public.modules m where m.code = 'MATH121'
on conflict (owner, efundi_site_id) do update
  set module_id = excluded.module_id, title_snapshot = excluded.title_snapshot;
```

The site UUID is in the eFundi address bar: `.../portal/site/<uuid>`. One gotcha: eFundi often
labels a second-semester module with its first-semester code (`MATH111` for `MATH121`). Only exact
code matches are mapped, so you may need the manual insert for those.

---

## 6. Things that bit us, so you can skip them

- **`/direct/site.json` pagination.** The default page is 10 sites. A whole module silently never
  synced until the worker walked the pages.
- **Content endpoint timeouts.** eFundi is slow under load. 60 s was not enough; 150 s plus one
  retry is. Fetch content on its own, not concurrently with other calls to the same site.
- **Same file linked twice.** Lecturers upload `MATV 121 Task 7.pdf` and `MATV+121+Task+7.pdf`
  as separate files. The worker normalises titles (collapse `+` and whitespace, lowercase) and
  keeps the cleaner one.
- **Date arithmetic in the AI step.** "Wednesday" must resolve to the *next* Wednesday, never a
  past one. The worker passes today's date into the prompt and checks the result.
- **The partial unique index.** See 5.3. Use a plain unique index.
- **Supabase JS v2 needs Node 22+** in Actions (it wants a global `WebSocket`).

---

## 7. Where to read more in this repo

- `sync/README.md`: operational notes for the worker.
- `docs/efundi-sync-plan.md`: the original design, including the fallbacks considered.
- `docs/efundi-sync-recon.md`: the DevTools worksheet used to discover the CAS form and the
  working endpoints. Do this yourself before building; it takes ten minutes.
- `docs/efundi-sync-audit.md`: review findings and fixes.
- `docs/tutor-context.md`: how an AI tutor briefs itself on a module with one SQL query.
- `CLAUDE.md`: the project memory file. It is the fastest overview of the current state.

---

## 8. A note on good behaviour

The worker identifies itself with a clear User-Agent, runs a handful of times a day, never retries
a login, reads only, and only reads content you are enrolled to see. Keep it that way. Do not point
it at other people's accounts, do not hammer the endpoints, and do not store or share anyone's
credentials. If NWU asks you to stop, stop.
