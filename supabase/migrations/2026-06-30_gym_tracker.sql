-- Gym Tracker schema (Physiq project: msmlqdrfsieixudgsced)
-- Multi-user from day one: every row carries user_id, RLS enforced.
-- PR detection lives in app code (Epley e1RM), not a DB trigger, so it's
-- easy to iterate on. Created 2026-06-30 for the gym-tracker prototype.

-- gym_exercises: user's saved exercise list
create table if not exists public.gym_exercises (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  category text not null check (category in ('strength', 'cardio')),
  created_at timestamptz not null default now(),
  unique (user_id, name)
);
create index if not exists gym_exercises_user_idx on public.gym_exercises (user_id);

-- gym_sets: individual logged sets (strength)
create table if not exists public.gym_sets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  exercise_id uuid not null references public.gym_exercises(id) on delete cascade,
  date date not null,
  weight_lbs numeric(6,2) not null,
  reps numeric(5,2) not null,           -- numeric to allow Ryan's "8.25" reps notation
  notes text,
  is_pr boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists gym_sets_user_exercise_date_idx
  on public.gym_sets (user_id, exercise_id, date desc);

-- gym_cardio: cardio sessions
create table if not exists public.gym_cardio (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  date date not null,
  exercise_name text not null,
  duration_minutes numeric(5,1),
  speed_mph numeric(4,1),
  incline_pct numeric(4,1),
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists gym_cardio_user_date_idx
  on public.gym_cardio (user_id, date desc);

-- RLS — service-role (used by the API routes) bypasses these; they exist so
-- that when real per-user auth lands, anon/auth'd clients are already locked
-- to their own rows with zero schema changes.
alter table public.gym_exercises enable row level security;
alter table public.gym_sets enable row level security;
alter table public.gym_cardio enable row level security;

drop policy if exists "users read own exercises" on public.gym_exercises;
drop policy if exists "users write own exercises" on public.gym_exercises;
create policy "users read own exercises" on public.gym_exercises
  for select using (auth.uid() = user_id);
create policy "users write own exercises" on public.gym_exercises
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "users read own sets" on public.gym_sets;
drop policy if exists "users write own sets" on public.gym_sets;
create policy "users read own sets" on public.gym_sets
  for select using (auth.uid() = user_id);
create policy "users write own sets" on public.gym_sets
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "users read own cardio" on public.gym_cardio;
drop policy if exists "users write own cardio" on public.gym_cardio;
create policy "users read own cardio" on public.gym_cardio
  for select using (auth.uid() = user_id);
create policy "users write own cardio" on public.gym_cardio
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Tables created via the Management API query endpoint don't inherit Supabase's
-- default table privileges, so the PostgREST roles get "permission denied"
-- without explicit grants. service_role still bypasses RLS; authenticated is
-- granted ahead of the real-auth wire-in.
grant all on table public.gym_exercises to service_role, authenticated;
grant all on table public.gym_sets to service_role, authenticated;
grant all on table public.gym_cardio to service_role, authenticated;

-- The stats route (relative strength / DOTS / bodyweight overlay) joins gym
-- data with the physiq-app's existing bodyweight + nutrition logs. Those tables
-- were created by physiq-app for the anon/authenticated roles only, so the
-- server-side service_role read needs an explicit SELECT grant. Read-only.
grant select on table public.weight_entries to service_role;
grant select on table public.macro_entries to service_role;
