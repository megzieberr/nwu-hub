# Plan: kill the MATV duplicate-churn loop + storage-key collisions

_Written 2026-07-14 (Fable audit session). For an Opus 4.8 plan-first implementation session,
per PLAN-semester-2.md §7 (sync changes = plan-first). No migration and no RLS change is
needed — this is worker-only (`sync/index.js`, `sync/write.js`)._

> **✅ DONE 2026-07-14 (commit `db9ea30`).** Primary fix + DiD #2 (benign `23505`) shipped;
> DiD #1 (storageKey sourceId-hash) deliberately skipped per the plan's own guidance (risk of
> stranding storage objects on update; primary fix removes the only known collision class).
> Verified live over two dispatch runs (29313986982 one-time cleanup + all variants skipped, no
> constraint failures; 29314298657 steady `New: 0, Updated: 0`, zero purges — idempotent). SQL:
> MATV121 has exactly 9 tutorial-task rows, all clean titles, no duplicates.

## Status of the wider audit this came from

- PR #6 (Classes section + class-link reconciliation) audited **sound** and verified live
  2026-07-14: the late-posted ENGV orientation link was reconciled onto the existing class
  goal (update, not duplicate) on a manual dispatch run.
- Cron cadence already fixed 2026-07-14 (4×/day: 06,10,14,17 UTC) — **not part of this plan**.
- What remains is the pre-existing dedupe defect below.

## Problem (two symptoms, one cause)

Every sync run since ~2026-07-13 does this (see runs 29310440096, 29312381673):

1. **Churn:** `purgeDuplicateResources()` deletes the five `MATV+121+Tutorial+Task+{2..6}.pdf`
   rows at run start; the MATV site pass re-inserts them minutes later. Every run reports
   "New: 5" (or 6) that is really this loop. Real new content is masked, and the storage
   objects for those five files are re-uploaded twice a day.
2. **Hard failures:** `MATV+121+Tutorial+Task+{7,8,9}.pdf` fail INSERT every run with
   `duplicate key value violates unique constraint "resources_storage_path_key"` — after
   their storage object has already been uploaded (`upsert: true`), overwriting the clean
   variant's object each run.

### Root cause

The MATV lecturer restructured the site: the Resources tool now returns **0 files** (the old
`/group/<site>/Files/...` paths are gone), and the Lessons tool serves `+`-artifact name
variants (`MATV+121+…`) with **different sourceIds** in `S.S. N.n` subfolders.

- The fetch-side name-dedupe (`byName` in `index.js`) only sees **this run's fetch**. The clean
  twins ("MATV 121 Tutorial Task N.pdf") live only in the **DB** now, so the `+` variants are
  never recognised as duplicates at fetch time → inserted as "new".
- `purgeDuplicateResources()` compares **DB rows** and prefers the cleanest title → deletes the
  `+` rows again next run. The two dedupers see different worlds; the pair oscillates. (The
  s7 fix `7141809` "keep the variant already in the hub" doesn't help: the `+` rows are purged
  *before* `existingHashes()` is loaded, so they are never "already in the hub" at sort time.)
- Tasks 7–9 differ only in that clean + `+` variants share the **same Lessons folder**, and
  `storageKey()` sanitises both space and `+` to `_` → **identical storage path** → the
  unique constraint fires instead of a row insert. (For 2–6 the variants sit in different
  folders, so paths differ and the row insert succeeds — that's why those churn instead of fail.)

Verified mechanism: the DB rows' `source_id`/`storage_path` pairs show e.g. clean task 7 =
`/group/…/S.S. 2.1: Prism_ and Polyhedra/MATV 121 Tutorial Task 7.pdf`, whose sanitised key is
byte-identical to the `+` variant's key from the same folder.

## Fix (recommended): teach the fetch-side dedupe about DB rows

**One change in `index.js`, inside the per-site loop, before the candidate loop:**

Build the set of nameKeys already in the hub for THIS module whose source no longer appears
in this fetch:

```
dbOnlyNameKeys = nameKey(title) of resources rows
                 where source='efundi' and module_id = <this module>
                 and source_id NOT IN (this fetch's candidate sourceIds)
```

Seed `byName` with `dbOnlyNameKeys` before iterating candidates. Effects:

- `+` variants 2–6: skipped as "same document" (clean twins are DB-only) → never re-inserted →
  purge finds nothing → **churn ends**.
- `+` variants 7–9: skipped the same way → **no storage upload, no constraint violation**.
- A file that IS still served under its existing sourceId is untouched: its own sourceId is in
  the fetch, so its nameKey is not in `dbOnlyNameKeys`, and hash-change updates still work.

Notes for the implementer:

- The rows are already fetched once per run by `purgeDuplicateResources()` (select over all
  efundi resources). Either pass that data through, or do one extra module-scoped select in
  the loop — single-user scale, either is fine; don't add a second full-table scan per site.
- `nameKey` normalisation MUST stay in lockstep with `purgeDuplicateResources()` (collapse
  `[+\s]+` runs → single space, trim, lowercase). It's now used in three places — extract a
  shared helper in `write.js` and import it in `index.js` so they can't drift again.
- Keep the existing candidate sort (prev-row preference, then fewest `+`) — it still matters
  when both variants ARE in one fetch.

### Known limitation (accept + log, don't solve now)

If a lecturer ever deletes the clean variant from eFundi and keeps ONLY the `+` variant, the
stale clean DB row wins forever and content updates to the `+` file are ignored. Acceptable:
the row's storage object still holds the same document, and Lessons files carry no
size/lastModified anyway (see "adjacent gap" below), so update detection there is already
title-only. Log a distinct line when a candidate is skipped against a DB-only row (e.g.
`· duplicate of a synced document, skipped: <title>`) so the situation is visible in run logs.

**Considered and rejected — "adoption"** (re-pointing the DB row's `source_id` to the fetched
variant when its own source disappears): fixes the limitation above but adds a mutating code
path with its own failure modes (which variant adopts when several match; flapping if the old
source returns). Not worth it for a cosmetic-duplicate problem at single-user scale.

## Defense-in-depth (optional, same PR)

1. **Collision-proof `storageKey()`**: append a short hash of sourceId, e.g.
   `…-${sha256(sourceId).slice(0,8)}`. ⚠ Only apply to NEW rows — recomputing the key for an
   existing row on a hash-change update would strand its old storage object. Simplest safe
   rule: on update (`before !== undefined`), reuse the row's existing `storage_path` instead
   of recomputing. If that's fiddly, skip this item — the primary fix already prevents the
   only known collision class.
2. **Treat `23505` on the resources upsert as a benign skip** (warn, don't count as failure):
   the unique constraint acting as last-resort dedupe shouldn't read as an error in logs.

## Test plan (all via `gh workflow run efundi-sync.yml` + run logs + MCP SQL)

1. Before merging: run once on the branch? Not possible (schedule/dispatch runs main) —
   instead run `node index.js` locally with a `.env` (creds available locally? NO — creds live
   only in Actions Secrets; do NOT ask for them). So: merge to main, then dispatch.
2. After merge, dispatch a run and assert, in the log:
   - zero `purged duplicate resource:` lines,
   - zero `resources_storage_path_key` failures,
   - `· duplicate of a synced document, skipped:` lines for the MATV `+` variants,
   - steady-state `New: 0, Updated: 0` (assuming no real new content).
3. Dispatch a SECOND run immediately: identical clean output (idempotence).
4. SQL: MATV121 has exactly one resources row per tutorial task 1–9 (9 rows), all clean titles;
   the two known-benign `fin-MATV121*.pdf` HTTP 403 warnings are still expected and unrelated.
5. Confirm the ENGV/EDCC/ALDE file counts are unchanged from before the fix.

## Guardrails

- Worker-only change; NO migration, NO RLS, NO schema. Never re-run old migration SQL.
- Don't touch `objectives.js` (just audited sound) or the auto-mapper.
- Service-role invariants stand: every insert sets `owner`; scope every query `source='efundi'`.
- Commit message style: `sync: dedupe against hub rows, not just the current fetch` (or similar).
