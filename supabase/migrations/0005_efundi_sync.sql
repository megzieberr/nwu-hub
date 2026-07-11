-- NWU Study Hub — v5: eFundi auto-sync data model.
--
-- Phase 1 of docs/efundi-sync-plan.md. Adds the schema the twice-daily sync worker
-- (Phase 2, sync/) writes into. Nothing here is user-facing yet; Phase 4 surfaces it.
--
-- What it adds:
--   • provenance columns (source / source_id / source_hash / source_synced_at) on
--       `resources` + `assessments`, and inline on the new `announcements` table, so a
--       synced row is marked, de-duplicated, and edit-detectable.
--   • `efundi_site_map` — maps an eFundi (Sakai) site id → one of Megan's modules. The
--       worker refuses to ingest content for an unmapped site.
--   • `announcements` — course notices (no home in the schema today). This is where the
--       lecturers' mark-lists and notice posts land (they don't use the Sakai gradebook —
--       see docs/efundi-sync-recon.md), so it doubles as the grades channel.
--   • `efundi_sync_runs` — one row per worker run: a visible health log.
--
-- DEDUPE INDEX — deliberate deviation from the plan's "partial" index. The plan asked for
-- `unique (source, source_id) where source is not null`, but PostgREST `.upsert()` cannot
-- infer a partial index as its conflict target and errors 42P10 (proven gotcha, project
-- notes). A PLAIN `unique (source, source_id)` is equivalent here: Postgres unique indexes
-- are NULLS DISTINCT by default, so the many manual rows with (null, null) never collide,
-- while every synced ('efundi', <id>) pair stays unique. This also lets Phase 2's write.js
-- use `upsert(onConflict: 'source,source_id')` directly. Net: same guarantee, upsert-safe.
--
-- SERVICE-ROLE NOTE for Phase 2: the sync worker connects with the SERVICE ROLE, which
-- BYPASSES RLS and has NO auth.uid(). The `owner` default `auth.uid()` therefore resolves
-- to NULL for the worker, so the worker MUST set `owner` explicitly to Megan's user id on
-- every insert (the app's _hub scripts don't need to — they run as her). RLS below only
-- governs the public anon-key frontend.
--
-- Reuses the 0001 `owner_all` pattern for the new owner-only tables.
-- Apply by pasting this whole file into the Supabase SQL editor.
-- (This project is NOT on the Supabase MCP — see project notes.) Idempotent: safe to re-run.

-- ============================================================
-- 5a · provenance columns on existing tables
-- ============================================================
-- `source` = 'efundi' for synced rows, NULL for manually-created rows.
-- `source_id` = the stable Sakai entity id/reference.
-- `source_hash` = hash of the meaningful content, so an edited item can be detected.
-- `source_synced_at` = when the worker last touched this row.
do $$
declare t text;
begin
  foreach t in array array['resources','assessments']
  loop
    execute format('alter table public.%I add column if not exists source           text;',        t);
    execute format('alter table public.%I add column if not exists source_id        text;',        t);
    execute format('alter table public.%I add column if not exists source_hash       text;',        t);
    execute format('alter table public.%I add column if not exists source_synced_at  timestamptz;', t);
  end loop;
end $$;

-- ============================================================
-- 5b · announcements (new — course notices + lecturer mark-lists)
-- ============================================================
create table if not exists public.announcements (
  id               uuid primary key default gen_random_uuid(),
  owner            uuid not null default auth.uid() references auth.users(id) on delete cascade,
  module_id        uuid not null references public.modules(id) on delete cascade,
  title            text not null,
  body_html        text,
  posted_at        timestamptz,
  -- provenance (inline; same shape as 5a)
  source           text,
  source_id        text,
  source_hash      text,
  source_synced_at timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists announcements_module_id_idx
  on public.announcements(module_id);
create index if not exists announcements_posted_at_idx
  on public.announcements(posted_at desc);

-- ============================================================
-- 5c · efundi_site_map (Sakai site id -> module)
-- ============================================================
-- module_id is NULLABLE: a site can be recorded as "known but not yet mapped" (module_id
-- null). The worker only ingests content for rows where module_id is set + active is true.
create table if not exists public.efundi_site_map (
  id             uuid primary key default gen_random_uuid(),
  owner          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  efundi_site_id text not null,
  module_id      uuid references public.modules(id) on delete cascade,
  title_snapshot text,                                   -- Sakai site title at last sight
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (owner, efundi_site_id)
);

-- ============================================================
-- 5d · efundi_sync_runs (health log — one row per worker run)
-- ============================================================
create table if not exists public.efundi_sync_runs (
  id            uuid primary key default gen_random_uuid(),
  owner         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'ok'
                  check (status in ('ok','auth_failed','partial','error')),
  items_new     int  not null default 0,
  items_updated int  not null default 0,
  error         text
);

create index if not exists efundi_sync_runs_started_at_idx
  on public.efundi_sync_runs(started_at desc);

-- ============================================================
-- 5e · dedupe indexes  (plain unique — upsert-safe; see header)
-- ============================================================
create unique index if not exists resources_source_uidx
  on public.resources(source, source_id);
create unique index if not exists assessments_source_uidx
  on public.assessments(source, source_id);
create unique index if not exists announcements_source_uidx
  on public.announcements(source, source_id);

-- ============================================================
-- 5f · RLS — owner-only on the three new tables (0001 owner_all pattern)
-- ============================================================
-- The service-role worker bypasses these; they gate only the public anon-key frontend.
do $$
declare t text;
begin
  foreach t in array array['announcements','efundi_site_map','efundi_sync_runs']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format($p$
      drop policy if exists owner_all on public.%1$I;
      create policy owner_all on public.%1$I
        for all
        using (owner = auth.uid())
        with check (owner = auth.uid());
    $p$, t);
  end loop;
end $$;

-- ---------- seed efundi_site_map (TEMPLATE — run in the SQL editor once site->module is known) ----------
-- The worker refuses unmapped sites, so this is how a module starts syncing. Fill in the
-- Sakai site UUID (from /direct/site.json or a course's /portal/site/<uuid> URL) per module.
--
--   insert into public.efundi_site_map (owner, efundi_site_id, module_id, title_snapshot)
--   select m.owner, '<sakai-site-uuid>', m.id, '<site title>'
--   from public.modules m
--   where m.code = 'EDCC125'
--   on conflict (owner, efundi_site_id) do update
--     set module_id = excluded.module_id, title_snapshot = excluded.title_snapshot;
