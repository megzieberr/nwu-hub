-- NWU Study Hub — v3: partner file sharing, past/practice papers & party quests.
--
-- Adds, on top of the 0002 owner|viewer read model:
--   • a PRIVATE `resources` Storage bucket + metadata table
--       (Megan's course PDFs + NotebookLM slideshow PDF exports — PDFs only, never audio)
--   • `past_papers`   — one row per exam/practice paper, with Paper + Memo download paths
--   • `project_parts` — per-assessment pair-project checklist; ticking `done` is the
--       partner/viewer's ONLY write anywhere in the app (locked to 3 columns by GRANT below)
--   • `profiles_member_read` so the UI can resolve a partner's name on part chips
--
-- Reuses the 0002 helpers verbatim: hub_is_member(), hub_is_owner(uid), hub_role().
-- Apply by pasting this whole file into the Supabase SQL editor.
-- (This project is NOT on the Supabase MCP — see project notes.) Idempotent: safe to re-run.

-- ============================================================
-- 1a · private `resources` storage bucket
-- ============================================================
insert into storage.buckets (id, name, public)
values ('resources', 'resources', false)
on conflict (id) do nothing;

-- Policies on storage.objects, all scoped to bucket_id = 'resources'.
-- READ: any hub member (owner OR viewer) — needed so a viewer can mint signed download URLs.
drop policy if exists resources_read on storage.objects;
create policy resources_read on storage.objects
  for select using (bucket_id = 'resources' and public.hub_is_member());

-- WRITE (insert/update/delete): owner only. Uploads run through the _hub scripts as Megan.
drop policy if exists resources_insert on storage.objects;
create policy resources_insert on storage.objects
  for insert with check (bucket_id = 'resources' and public.hub_role() = 'owner');

drop policy if exists resources_update on storage.objects;
create policy resources_update on storage.objects
  for update using      (bucket_id = 'resources' and public.hub_role() = 'owner')
             with check (bucket_id = 'resources' and public.hub_role() = 'owner');

drop policy if exists resources_delete on storage.objects;
create policy resources_delete on storage.objects
  for delete using (bucket_id = 'resources' and public.hub_role() = 'owner');

-- ============================================================
-- 1b · resources (file metadata)   ·   1c · past_papers
--       both reuse the exact 0002 hub_read / hub_write model
-- ============================================================
create table if not exists public.resources (
  id           uuid primary key default gen_random_uuid(),
  owner        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  module_id    uuid not null references public.modules(id) on delete cascade,
  unit_id      uuid references public.study_units(id) on delete set null,
  kind         text not null default 'course_pdf'
                 check (kind in ('course_pdf','notebooklm','other')),
  title        text not null,
  storage_path text not null unique,               -- path inside the `resources` bucket
  size_bytes   bigint,
  created_at   timestamptz not null default now()
);

create table if not exists public.past_papers (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  module_id   uuid not null references public.modules(id) on delete cascade,
  title       text not null,                        -- e.g. 'June 2024 Exam'
  year        int,
  session     text,                                 -- 'June' / 'Nov' (nullable)
  kind        text not null default 'past'
                check (kind in ('past','practice')),  -- practice = Claude-Code-authored
  paper_path  text not null,                        -- path inside the `resources` bucket
  memo_path   text,                                 -- nullable until a memo exists
  created_at  timestamptz not null default now()
);

-- READ = own rows OR (member reading an owner's rows); WRITE = own rows AND role <> viewer.
-- Copied verbatim from 0002_viewer_access.sql.
do $$
declare t text;
begin
  foreach t in array array['resources','past_papers']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format($p$
      drop policy if exists hub_read on public.%1$I;
      create policy hub_read on public.%1$I
        for select using (
          owner = auth.uid()
          or (public.hub_is_member() and public.hub_is_owner(owner))
        );
    $p$, t);
    execute format($p$
      drop policy if exists hub_write on public.%1$I;
      create policy hub_write on public.%1$I
        for all
        using      (owner = auth.uid() and coalesce(public.hub_role(),'owner') <> 'viewer')
        with check (owner = auth.uid() and coalesce(public.hub_role(),'owner') <> 'viewer');
    $p$, t);
  end loop;
end $$;

-- ============================================================
-- 1d · project_parts (the partner's single, column-limited write)
-- ============================================================
create table if not exists public.project_parts (
  id            uuid primary key default gen_random_uuid(),
  owner         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  assessment_id uuid not null references public.assessments(id) on delete cascade,
  title         text not null,
  assigned_to   uuid not null references public.profiles(id),
  done          boolean not null default false,
  done_at       timestamptz,
  note          text,
  position      int not null default 0,
  created_at    timestamptz not null default now()
);

alter table public.project_parts enable row level security;

-- SELECT: hub_read pattern (own rows, or a member reading the owner's rows).
drop policy if exists hub_read on public.project_parts;
create policy hub_read on public.project_parts
  for select using (
    owner = auth.uid()
    or (public.hub_is_member() and public.hub_is_owner(owner))
  );

-- INSERT: owner only. Seeding + structural edits (retitle/reassign/reorder) are owner inserts.
drop policy if exists parts_insert on public.project_parts;
create policy parts_insert on public.project_parts
  for insert with check (owner = auth.uid() and coalesce(public.hub_role(),'owner') <> 'viewer');

-- DELETE: owner only. Structural edits are done as delete + re-insert by the seeder.
drop policy if exists parts_delete on public.project_parts;
create policy parts_delete on public.project_parts
  for delete using (owner = auth.uid() and coalesce(public.hub_role(),'owner') <> 'viewer');

-- UPDATE: the owner may update her own parts; a member may update a part assigned to her.
-- WHICH columns anyone can touch is clamped by the GRANT below, not by RLS.
drop policy if exists parts_update on public.project_parts;
create policy parts_update on public.project_parts
  for update using (
    (owner = auth.uid() and coalesce(public.hub_role(),'owner') <> 'viewer')
    or (public.hub_is_member() and assigned_to = auth.uid())
  ) with check (
    (owner = auth.uid() and coalesce(public.hub_role(),'owner') <> 'viewer')
    or (public.hub_is_member() and assigned_to = auth.uid())
  );

-- Column-grant lockdown (the Supabase column-REVOKE trick — RLS can't restrict WHICH
-- columns an updater writes). Result: even Megan can only change done/done_at/note from
-- the client; structural edits are inserts (owner-only, unrestricted) via the seeder.
-- Do NOT widen this grant.
revoke update on public.project_parts from anon, authenticated;
grant  update (done, done_at, note) on public.project_parts to authenticated;

-- ============================================================
-- 1e · profiles readable by members (so part chips can show a name)
-- ============================================================
-- Keep the existing 0002 profiles_self_read policy; add a member-wide read alongside it.
drop policy if exists profiles_member_read on public.profiles;
create policy profiles_member_read on public.profiles
  for select using (public.hub_is_member());

-- ---------- optional: name the partner (TEMPLATE — run in the SQL editor if wanted) ----------
-- Gives the part chips a real name instead of the "Partner" fallback. Name-free by design;
-- fill in the partner's hub username before running just this block.
--
--   update public.profiles
--   set display_name = '<Partner First Name>'
--   where id = (select id from auth.users where email = '<username>@nwu-hub.local');
