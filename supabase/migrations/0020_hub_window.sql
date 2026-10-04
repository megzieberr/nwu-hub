-- NWU Study Hub — v20: the hub window for the second learner's tutors (the private hub-window spec,
-- a PLAN-*.md on Megan's disk — gitignored, because it names a person; this file never does).
--
-- Two new tables. Nothing existing is altered: the viewer already reads the shared material through
-- 0002's hub_read, already cannot write it (hub_write excludes 'viewer'), and already owns her own
-- rows in goals and study_log through owner_all. This migration adds no privilege to any account.
--
-- 1. hub_tutor_tokens — one scoped token per tutor pack, the same shape as the proven tutor-progress
--    function in the Re:Lefela project. Only the SHA-256 of a token is ever stored, so a database
--    leak cannot reveal a live token, and revoking is one UPDATE. RLS is ON with ZERO POLICIES on
--    purpose: that denies every anon and authenticated request outright and leaves the service role
--    (which the hub-window edge function uses, and only the server holds) as the one reader. The
--    explicit REVOKE below is belt and braces on top of that.
--
-- 2. tutor_docs — universal course documents (lecturer briefs, class transcripts, handouts) stored
--    as extracted plain TEXT for the tutor window only. The hub app never names this table, so
--    nothing here can drift back onto anyone's screen: `grep -rn "tutor_docs" src/` must stay at
--    zero hits. Deliberately NO viewer read policy — a viewer's signed-in hub account sees nothing
--    here at all. The edge function reads it with the service role, which bypasses RLS.
--
--    The write policy is OWNER-ROLE-ONLY, not merely owner-scoped. A bare `owner = auth.uid()`
--    would let ANY signed-in account insert rows it owns — the viewer, or a stranger who
--    auto-signed-up through the login form — and tutor-only course text is not theirs to add.
--    public.hub_role() returns NULL when the caller has no profiles row, and `NULL = 'owner'` is
--    NULL, so a stranger fails the check the same way a viewer does. Matches the house idiom in
--    0002/0017: bare auth.uid(), hub_* helpers called by name, drop-then-create so a re-run is safe.
--
-- No new SQL function here. If one is ever added it must be `security definer ... set search_path
-- = ''`, matching hub_is_member, hub_is_owner and hub_role, which are all pinned that way already.
--
-- NOT APPLIED. Review the whole file before running it. Apply by pasting it into the Supabase SQL
-- editor, or via the Supabase MCP. Idempotent: safe to re-run. Run /migration-check afterwards.

-- ------------------------------------------------------------------
-- 1. Scoped tutor tokens. Only the service role ever reads this.
-- ------------------------------------------------------------------

create table if not exists public.hub_tutor_tokens (
  token_sha256    text primary key,          -- SHA-256 hex of the token; the token itself is never stored
  user_id         uuid not null references auth.users(id) on delete cascade,
  label           text not null unique,      -- which pack this token belongs to, for the revoke line
  can_write_goals boolean not null default false,  -- starts OFF; the own-to-do capability is a separate yes
  created_at      timestamptz not null default now(),
  revoked_at      timestamptz                -- non-null = dead; the function refuses it, no delete needed
);

alter table public.hub_tutor_tokens enable row level security;

-- No policies at all, on purpose. RLS with zero policies denies every request that is not the
-- service role. The revoke is the second wall.
revoke all on public.hub_tutor_tokens from anon, authenticated, public;

-- ------------------------------------------------------------------
-- 2. Tutor-only documents. The hub app never names this table.
-- ------------------------------------------------------------------

create table if not exists public.tutor_docs (
  id           uuid primary key default gen_random_uuid(),
  owner        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  module_id    uuid not null references public.modules(id) on delete cascade,
  unit_id      uuid references public.study_units(id) on delete set null,
  title        text not null,
  doc_kind     text not null default 'transcript'
                 check (doc_kind in ('transcript','brief','instructions','handout','other')),
  source_path  text not null unique,      -- plain unique constraint, not partial: the script does
                                          -- find-then-write anyway (the standing PostgREST note:
                                          -- .upsert() cannot infer a partial index)
  body_text    text,
  chars        integer,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists tutor_docs_module_idx
  on public.tutor_docs (module_id, created_at desc);

alter table public.tutor_docs enable row level security;

-- The owner's _hub script signs in as her, so she needs owner-scoped write. Nobody else does.
drop policy if exists tutor_docs_owner_all on public.tutor_docs;
create policy tutor_docs_owner_all on public.tutor_docs
  for all using (owner = auth.uid() and public.hub_role() = 'owner')
      with check (owner = auth.uid() and public.hub_role() = 'owner');

revoke all on public.tutor_docs from anon, public;
-- Supabase's default privileges also hand `authenticated` truncate/references/trigger on every new
-- table. PostgREST cannot issue them, but TRUNCATE ignores RLS, so take them away here anyway.
revoke truncate, references, trigger on public.tutor_docs from authenticated;
grant select, insert, update, delete on public.tutor_docs to authenticated;
-- `authenticated` above is the role grant only; the policy above is what actually decides, and it
-- lets exactly one account through. A viewer holding this grant still reads and writes nothing.


-- ==================================================================
-- TEMPLATES — do NOT run these as part of the migration.
-- Both are separate one-liners, run by hand once the token exists.
-- The token is generated off-database (at least 32 random characters, generated by the machine,
-- never invented by a person) and NEVER typed into SQL. Only its SHA-256 hex goes in.
-- Keep the filled-in revoke line in the private status file, not in this repo.
-- ==================================================================
--
-- Seed one token (replace both placeholders; add can_write_goals only when that capability is
-- turned on, it defaults to false):
--
--   insert into public.hub_tutor_tokens (token_sha256, user_id, label)
--   values ('<sha256 hex of the generated token>',
--           '<the uuid of the learner this token belongs to>',
--           '<a short label for this pack>');
--
-- Turn the own-to-do capability on later, once the read-only half has run for a week:
--
--   update public.hub_tutor_tokens set can_write_goals = true where label = '<that label>';
--
-- Revoke (one line, instant, reversible by setting revoked_at back to null):
--
--   update public.hub_tutor_tokens set revoked_at = now() where label = '<that label>';
