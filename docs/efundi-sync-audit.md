# eFundi sync — architect audit (Fable)

**Date:** 2026-07-11 · **Scope:** `sync/`, `supabase/migrations/0005_efundi_sync.sql`,
`.github/workflows/efundi-sync.yml`, audited against `docs/efundi-sync-buildlog.md` and the
original `docs/efundi-sync-plan.md`.

## Verdict

**The build is sound and the deviations are all defensible.** Opus matched the plan where it
mattered (provenance-based dedupe, service-role isolation, per-site resilience, auth-fail-stops,
gentle twice-daily schedule) and made good judgement calls where reality differed (plain unique
index for upsert-safety, `site.json` as the auth signal, no gradebook sync, column-scoped assignment
updates). Secrets hygiene is clean — no keys or `.env` in the tree, `node_modules` gitignored.

I found **one real latent bug (now fixed)** and a short list of **verify-before-you-scale** items.
Nothing blocks mapping more modules, but do a dispatch run against a module that actually has
**announcements and assignments** before trusting those two streams — EDCC125 only proved *files*.

## What I verified (offline)

I couldn't hit eFundi live (no creds here + the domain is network-blocked from this environment),
so I exercised the **real** `fetch-efundi.js` normalizers and the **real** `write.js` dedupe/write
logic against realistic Sakai `/direct` payloads and a fake Supabase + fake HTTP client:

- **Idempotency confirmed:** identical re-run ⇒ `new=0, updated=0`, row counts unchanged.
- **Edit-detection confirmed:** a changed file ⇒ `updated=1`; a new file ⇒ `new=1`.
- **Folder filtering confirmed:** collection/folder entries are dropped, files kept.
- **Constraint check:** `type='assignment'` / `status='upcoming'` / `kind ∈ {course_pdf,other}` all
  satisfy the 0001/0003 CHECK constraints — assignment + resource inserts won't be rejected.

## Findings

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| 1 | **High** | `fetchSiteAnnouncements` threw `RangeError: Invalid time value` on any `createdOn` that wasn't a millisecond epoch (ISO string, formatted date). Because it runs inside `index.js`'s per-site try/catch, one odd date silently dropped that **entire site's** sync (announcements *and* assignments *and* files) and only marked the run `partial`. Worked for EDCC125 by luck of its date format. | **Fixed** |
| 2 | Med | Assignment due dates were read only from `dueTime.epochSecond`; a Sakai serving `dueTime.time` (ms) or `dueDate` (ISO) silently lost the due date. | **Fixed** |
| 3 | Med | Folder filtering keyed only on `type/resourceType === 'collection'`; folders marked via `container:true`, a `…folder` resourceType, or a trailing-slash URL could slip through and be mirrored as junk "files". | **Fixed** (hardened) |
| 4 | Low | Workflow used `npm install` (drift-prone) for an unattended job despite a committed lockfile. | **Fixed** → `npm ci` + npm cache |
| 5 | Med | **Verify, can't fix blind:** content dedupe hash is `{title,size,lastModified}`. If the `size`/`lastModified` field names are wrong (null), a same-named file replaced on eFundi won't be re-downloaded (idempotency still holds, but edits are missed). Confirm against a raw `content/site/{id}.json`. | Open |
| 6 | Med | **Verify:** the site-list `announcement/site/{id}.json` may return summaries without `body` on some Sakai versions. If so, the "grades via announcements" channel would sync titles but not the mark-lists. Body now also falls back to `a.text`, but confirm bodies actually arrive. | Open |
| 7 | Low | Storage orphan: when a file's **title** changes its storage key changes; the metadata row repoints but the old object is left in the bucket. (No orphan on size-only edits — verified.) Cosmetic; leave. | Accepted |
| 8 | Low | `efundi_sync_runs` row is inserted as `status='ok'` and only updated at the end — a hard kill (Actions timeout) leaves a stuck `ok` with null `finished_at`. Harmless; note if you build a health UI. | Accepted |

## Fixes applied this session (in `sync/fetch-efundi.js` + the workflow)

- Added a **non-throwing** `toDate/toIso/toDay` helper that tolerates ms-epoch, seconds-epoch,
  `{epochSecond|epochMilli|time}`, and ISO/date strings — used for announcement `postedAt` and
  assignment due dates. A malformed date now yields `null`, never a crash.
- Broadened assignment due-date sources (`dueTime` object/number, `dueDate`, `dueTimeString`).
- Broadened announcement body (`body ?? text`).
- Hardened `isCollection()` folder detection (type/resourceType/container/trailing-slash).
- Workflow now `npm ci` with npm caching.
- **Regression-checked:** the known-good ms-epoch / `epochSecond` / `dueTimeString` inputs produce
  byte-identical output to before; the write-path idempotency harness still passes.

## Before you scale (recommended order)

1. **Do one `workflow_dispatch` run on a module that has live announcements + assignments** (EDCC125
   only proved files). Then open a raw `…/content/site/{id}.json` and `…/announcement/site/{id}.json`
   and confirm findings #5/#6 field names. That's the last unknown; everything else is proven.
2. Then map the remaining modules into `efundi_site_map` (one insert each).
3. ~~**Phase 4 (announcements UI) security note:** sanitize `body_html`.~~ **DONE + verified.** Phase 4
   is built: a per-module **Announcements** section (collapsed → expandable), an **⇅ eFundi** synced
   badge on synced files/assignments/announcements, and a **last-sync indicator** on the dashboard
   (from `efundi_sync_runs`, owner-only). `body_html` is rendered inside a **locked-down sandboxed
   iframe** (`sandbox="allow-popups"` — no `allow-scripts`, no `allow-same-origin`), reusing the app's
   existing `SummaryViewer` pattern with a tighter sandbox. A headless-Chromium test confirmed a
   4-vector hostile body (`<script>`, `img onerror`, `svg onload`, `javascript:` URL) fires with no
   sandbox but is **fully neutralised** with it, while the real content still renders. No new deps.
4. **Policy:** the automated twice-daily login is unchanged — worth eyeballing NWU's IT
   acceptable-use policy before relying on the schedule; revert to `workflow_dispatch`-only in one
   line if needed.
