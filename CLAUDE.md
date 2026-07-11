# NWU Study Hub — project memory

Single-user study hub for Megan (NWU B.Ed student). React + Vite PWA on GitHub Pages, Supabase
backend. This file is the catch-up for a new session — **trust it over any older notes.**

_Last updated: 2026-07-11._

## What this project is

- **Frontend:** `src/App.jsx` (nearly all UI is in this one file). React 18 + Vite + Tailwind,
  deployed as a static site to **GitHub Pages** (`.github/workflows/deploy.yml`, on push to `main`).
- **The repo is public and static → it holds NO secrets.** Row-Level Security (RLS) is the security
  boundary; the Supabase anon key is intentionally public. Never put a service-role key, eFundi
  password, or API key in the frontend/repo.
- **Backend:** Supabase project `aefjicdxeflqnquiebvc` (org `mathwithmegan`... note: the hub project
  lives under Megan's personal Supabase account — reachable via the Supabase MCP when that account is
  connected). Migrations in `supabase/migrations/` (`0001`–`0007`), applied by pasting into the SQL
  editor **or** via the Supabase MCP. Idempotent; RLS is owner-scoped on every table.

## The "focused eFundi" model (important — this is the core design)

eFundi (NWU's Sakai LMS) is a **raw inbox that FEEDS the tutors, NOT a mirror.** The hub shows only
**focused, tutor-authored work** — summaries, objectives/goals, deadlines. Raw eFundi content is
stored but **hidden**:

- **Announcements** → an agent turns the actionable ones into **objectives/goals** (shown). The raw
  announcement is stored (table `announcements`) as **tutor context**, not displayed.
- **Files** → stored in the private `resources` bucket as **tutor fuel** (not displayed in the hub).
  `resources.summarized_at IS NULL` = "new, awaiting a tutor summary."
- **Videos are never synced** (Megan transcribes the relevant ones herself).
- `src/App.jsx` deliberately does **not** render eFundi announcements or eFundi files
  (`r.source === 'efundi'` filtered out). Only owner-curated files show.

## The eFundi sync worker (`sync/`)

Node ESM, runs in **GitHub Actions twice daily** (`.github/workflows/efundi-sync.yml`, cron
`0 4,16 * * *` UTC = 06:00/18:00 SAST) + manual `workflow_dispatch`. Node 22, `npm ci`.

- `auth.js` — logs into NWU's classic Apereo **CAS** (`casprd.nwu.ac.za`), form-replay, no MFA on
  this path. Returns an authenticated `got` client. AuthError ⇒ stop, never retry (lockout risk).
- `fetch-efundi.js` — pulls from Sakai's `/direct/*.json` API: sites, announcements, assignments,
  content (Resources tool) **and Lessons tool** (`fetchSiteLessons` — some modules e.g. ALDE122
  deliver materials via Lessons, not Resources). Skips videos. Content fetch: 150s + 1 retry
  (eFundi's content endpoint is flaky/slow).
- `write.js` — service-role client (bypasses RLS, so sets `owner` explicitly). Dedupe by
  `(source, source_id)` + content hash. `purgeVideos` removes any eFundi video (storage + row).
- `objectives.js` — **the objectives agent.** Reads new announcements (`processed_at IS NULL`) and
  writes goals via **Claude Haiku** (`claude-haiku-4-5`, structured output, ~pennies/month). Strict:
  only real tasks + dated classes/tests become goals; reminders/FYI stay as context. Skips silently
  if `ANTHROPIC_API_KEY` is unset; never fails the sync.
- `index.js` — orchestrator: one `efundi_sync_runs` row per run.

**Secrets (GitHub Actions repo secrets only):** `EFUNDI_USERNAME`, `EFUNDI_PASSWORD`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY` (optional — enables the objectives agent).

## Tutors

Two kinds, both **configured outside this repo** (not in any CLAUDE.md here):
- **claude.ai project tutors** — "here's the material, teach me."
- **Claude Code tutors** — assignments, building, visualizing. They have live Supabase access.

A Claude Code tutor briefs itself on a module with **one query** instead of crawling files:
`select * from module_context where code = 'ALDE122';` → announcements (lecturer context),
objectives, deadlines, file list (titles+paths), summaries. See `docs/tutor-context.md`.

## Current status (2026-07-11)

**Done / live:**
- eFundi sync live on `main`, running twice daily. Objectives agent active (API key set).
- Focused-hub frontend deployed (raw content hidden).
- Objectives UI: ticking one makes it vanish into a collapsible "Objectives Done" tab (no pile-up).
- Mapped & syncing: **EDCC125, ENGV121, ALDE122**.

**Pending / next:**
- Map **MATH121, MATV121, SECL121** once they appear as eFundi sites. (Currently eFundi only exposes
  the sem-1 `…111` codes, which don't match these sem-2 modules — so nothing to map yet.) To map a
  module: one upsert into `efundi_site_map (owner, efundi_site_id, module_id, title_snapshot, active)`
  using the Sakai site UUID from `/direct/site.json` or a `/portal/site/<uuid>` URL.
- Optional, not built: an in-app "Sync now" button (needs an Edge Function + GitHub token); a
  "teach me this module" tutor instruction snippet that loads `module_context`.

## Conventions / gotchas

- Migrations: idempotent; apply via SQL editor or Supabase MCP `apply_migration`. Files are the
  source of truth; keep them in sync with what's applied.
- Dedupe index is a **plain** `unique (source, source_id)` (not partial) — PostgREST `.upsert()`
  can't infer a partial index. NULLs are DISTINCT so manual rows don't collide.
- eFundi site codes are sem-1 (`111`); hub `modules.code` are sem-2 (`121`/`122`). Only exact code
  matches are mapped — never guess.
- Docs: `docs/efundi-sync-plan.md` (design), `-audit.md` (review + findings), `-buildlog.md`,
  `-recon.md`, `tutor-context.md`.
