-- NWU Study Hub — v1 schema
-- Single user (Megan). Anon key ships in a PUBLIC repo, so RLS is mandatory:
-- every row is owned by auth.uid() and only the owner can touch it.

-- ---------- modules ----------
create table if not exists public.modules (
  id                uuid primary key default gen_random_uuid(),
  owner             uuid not null default auth.uid() references auth.users(id) on delete cascade,
  code              text not null,                 -- e.g. 'EDCC125'
  title             text not null,
  semester          int  not null default 2,
  credits           int,
  nqf_level         int,
  colour            text,                          -- hub accent per module
  participation_pct int,                           -- e.g. 40
  exam_pct          int,                           -- e.g. 60
  exam_min          int,                           -- min exam % to pass, e.g. 40
  pass_min          int,                           -- min module % to pass, e.g. 50
  outcomes          jsonb not null default '[]',   -- array of outcome strings
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (owner, code)
);

-- ---------- study_units ----------
create table if not exists public.study_units (
  id           uuid primary key default gen_random_uuid(),
  owner        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  module_id    uuid not null references public.modules(id) on delete cascade,
  number       int  not null,
  title        text not null,
  source_file  text,                               -- 'Study Unit 1.pdf'
  status       text not null default 'not_started'
                 check (status in ('not_started','in_progress','done')),
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (module_id, number)
);

-- ---------- assessments (deadlines) ----------
create table if not exists public.assessments (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  module_id   uuid not null references public.modules(id) on delete cascade,
  title       text not null,
  type        text not null default 'assignment'
                check (type in ('assignment','test','exam','quiz','participation','other')),
  due_date    date,
  weight_pct  numeric,
  status      text not null default 'upcoming'
                check (status in ('upcoming','submitted','graded','missed')),
  mark        numeric,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------- goals (weekly study goals) ----------
create table if not exists public.goals (
  id           uuid primary key default gen_random_uuid(),
  owner        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  module_id    uuid references public.modules(id) on delete cascade,   -- nullable = general
  text         text not null,
  target_date  date,
  done         boolean not null default false,
  created_at   timestamptz not null default now()
);

-- ---------- study_log ----------
create table if not exists public.study_log (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  module_id   uuid references public.modules(id) on delete cascade,
  unit_id     uuid references public.study_units(id) on delete set null,
  studied_at  timestamptz not null default now(),
  minutes     int,
  note        text,
  created_at  timestamptz not null default now()
);

-- ---------- summaries (interactive study tools) ----------
create table if not exists public.summaries (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  module_id   uuid not null references public.modules(id) on delete cascade,
  unit_id     uuid references public.study_units(id) on delete set null,
  title       text not null,
  kind        text not null default 'notes'
                check (kind in ('flashcards','quiz','timeline','diagram','notes','mindmap','other')),
  html        text,                                 -- self-contained interactive HTML
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------- RLS: owner-only on every table ----------
do $$
declare t text;
begin
  foreach t in array array['modules','study_units','assessments','goals','study_log','summaries']
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
