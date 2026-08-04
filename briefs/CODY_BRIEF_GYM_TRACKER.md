# Mission Control — Cody Build Brief: Gym Tracker (Prototype-First)
**Date:** 2026-06-30
**Project:** Mission Control / Physiq tab
**Author:** Thadius (for Ryan)
**Status:** Ready for Cody
**Branch:** `feature/gym-tracker-prototype`
**App path:** `/Users/ryanlarocca/.openclaw/workspace/PROJECTS/mission-control/`
**Deploy command:** `cd /Users/ryanlarocca/.openclaw/workspace/PROJECTS/mission-control && vercel --prod` (DO NOT deploy until the Deploy Gate at the bottom is satisfied)

---

## Context

The Physiq tab inside Mission Control (`/physiq`, rendered by `components/widgets/PhysiqWidget.tsx`) currently has macro tracking (real-ish food log state) plus a **fully hardcoded mock workout log** at the bottom. We're replacing that mock log with a **real, multi-user gym tracker** backed by Supabase, but only after Ryan signs off on the look.

**The deal: prototype-first.** Don't touch `PhysiqWidget.tsx` yet. Build the new gym tracker at a separate route — `/physiq/gym-tracker` — seeded with Ryan's real historical lift data. Ryan reviews the prototype on his phone. Once he says "ship it," we wire it into the Physiq tab proper and remove the mock workout section.

**Mobile-first.** Ryan logs lifts from his phone between sets at the gym. Everything must feel snappy at 375px. Big tap targets (≥44px). Cards, not tables.

**Multi-user from day one.** Every row has `user_id`. RLS enforced. Hardcode Ryan's user_id for the prototype (we'll wire real auth later) but the schema must be correct out of the gate so we don't migrate later.

**Aesthetic:** Match the rest of Mission Control — zinc-900/950 backgrounds, zinc-800 borders, zinc-100/200 text, amber accents for PRs (🏆), blue for strength category, rose/red for cardio category. Same Tailwind palette as `PhysiqWidget.tsx`.

---

## Infrastructure

### Supabase — Physiq project
- **Project ref:** `msmlqdrfsieixudgsced`
- **Region:** us-west-2
- **URL:** `https://msmlqdrfsieixudgsced.supabase.co`
- **Management PAT (for migrations via Management API):** in `.env.local` as `PHYSIQ_SUPABASE_PAT` (redacted 2026-08-04 — a live token was previously written here; never commit secrets to briefs)
- **anon key & service_role key:** fetch from the Supabase dashboard (Project Settings → API). Add to `.env.local` as `NEXT_PUBLIC_PHYSIQ_SUPABASE_URL`, `NEXT_PUBLIC_PHYSIQ_SUPABASE_ANON_KEY`, and `PHYSIQ_SUPABASE_SERVICE_ROLE_KEY`. **Do NOT commit `.env.local`.**

> Note: Mission Control's primary Supabase project is the LRG Homes one (`vcebykfbaakdtpspkaek`) used for CRMS. The gym tracker uses the **Physiq** project (`msmlqdrfsieixudgsced`) — separate client instance. Create `lib/physiqSupabase.ts` so the two clients don't get crossed.

### Local dev
```bash
cd /Users/ryanlarocca/.openclaw/workspace/PROJECTS/mission-control
pnpm install   # if needed
pnpm dev       # runs on port 3001
```

### Ryan's user_id for prototype seeding
Use a stable UUID constant — `RYAN_USER_ID = '00000000-0000-0000-0000-000000000001'` — for both seed rows and the prototype's reads/writes. When real auth lands later, we replace this with `auth.uid()`.

---

## Part 1 — Supabase schema + seed data

### 1.1 Schema migration

Create a migration file at `supabase/migrations/2026-06-30_gym_tracker.sql` and apply it via the Supabase Management API (Cody can use `curl` against `https://api.supabase.com/v1/projects/{ref}/database/query` with the PAT above, or just paste the SQL into the SQL editor — whichever is faster).

```sql
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

-- RLS
alter table public.gym_exercises enable row level security;
alter table public.gym_sets enable row level security;
alter table public.gym_cardio enable row level security;

create policy "users read own exercises" on public.gym_exercises
  for select using (auth.uid() = user_id);
create policy "users write own exercises" on public.gym_exercises
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "users read own sets" on public.gym_sets
  for select using (auth.uid() = user_id);
create policy "users write own sets" on public.gym_sets
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "users read own cardio" on public.gym_cardio
  for select using (auth.uid() = user_id);
create policy "users write own cardio" on public.gym_cardio
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

### 1.2 PR detection

Implement PR detection in app code (not a DB trigger — easier to iterate on). Rule: a set is a PR if its **estimated 1RM** beats every previous set of the same `(user_id, exercise_id)`. Use the Epley formula:

```
e1RM = weight * (1 + reps / 30)
```

This gracefully handles "225x6 beats 225x5" and "335x3 vs 325x6" comparisons. When inserting a new set, fetch all prior sets for that exercise → compute max prior e1RM → set `is_pr = true` if the new set's e1RM exceeds it. Also re-flag historical sets correctly during the seed.

### 1.3 Seed Ryan's real data

Create a one-shot seed script at `scripts/seed-gym-tracker.mjs` that uses the service_role key to insert Ryan's exercises + sets. Run it once locally — DO NOT add it to any cron. Source data (all rows have `user_id = RYAN_USER_ID`, dates parsed as MM-DD-YY → YYYY-MM-DD; "fatigued" → notes, "PR" markers in raw data are informational since we recompute is_pr from e1RM):

**Strength exercises to create:** Weighted Pull-ups, Bench Press, Incline DB Press, Barbell Squat, Deadlift, DB Rows, Lat Pulldown, Corner Barbell Rows, Wire Rows, Shoulder Barbell Press

**Sets (exercise — date — weight × reps — notes):**

```
Weighted Pull-ups:
  2025-12-09  45 × 5
  2025-12-09  10 × 11    (fatigued)
  2025-12-22  45 × 7
  2025-12-28  45 × 6
  2026-01-03  45 × 8
  2026-01-13  45 × 8.25
  2026-03-01  45 × 6.75
  2026-03-08  45 × 8
  2026-03-31  45 × 6
  2026-04-29  45 × 6
  2026-05-30  45 × 4

Bench Press:
  2025-12-03  225 × 5
  2025-12-08  225 × 5
  2025-12-16  225 × 6
  2025-12-21  225 × 5
  2025-12-26  225 × 6
  2026-01-07  225 × 5
  2026-01-15  225 × 5
  2026-01-20  225 × 5
  2026-02-27  225 × 5
  2026-03-13  225 × 4
  2026-03-19  225 × 5
  2026-04-01  225 × 6
  2026-04-26  225 × 4
  2026-05-13  225 × 5
  2026-05-23  225 × 5
  2026-05-28  225 × 3
  2026-06-15  225 × 4
  2026-06-22  225 × 5

Incline DB Press:
  2025-12-11  100 × 5
  2025-12-30  100 × 6
  2026-02-01  100 × 7
  2026-02-24   90 × 7
  2026-03-03  100 × 7
  2026-03-24  100 × 3
  2026-04-09  100 × 5
  2026-04-17  100 × 6
  2026-04-30  100 × 8
  2026-05-16  100 × 7
  2026-06-01  100 × 5

Barbell Squat:
  2025-12-04  325 × 6
  2025-12-15  325 × 5
  2026-01-02  325 × 4
  2026-02-17  335 × 3
  2026-02-26  335 × 3
  2026-03-06  325 × 4
  2026-03-26  345 × 5    (PR noted)
  2026-04-08  335 × 4
  2026-05-01  325 × 8
  2026-05-13  325 × 5
  2026-05-16  325 × 5
  2026-06-08  315 × 7

Deadlift:
  2026-01-14  345 × 1
  2026-01-19  355 × 1
  2026-02-26  325 × 1
  2026-03-18  345 × 2
  2026-04-03  360 × 1
  2026-05-01  375 × 1    (PR noted — didn't fully lock, close)
  2026-05-16  325 × 3

DB Rows:
  2025-12-05  100 × 10
  2026-01-30  100 × 12   (PR noted)
  2026-02-25  100 × 8

Lat Pulldown:
  2025-12-05  220 × 4
  2026-03-27  334 × 3
  2026-04-22  220 × 4
  2026-05-15  220 × 4

Corner Barbell Rows:
  2025-12-18  170 × 4
  2026-06-08  190 × 4

Wire Rows:
  2026-01-17  110 × 4
  2026-04-23  110 × 4
  2026-06-03  110 × 5

Shoulder Barbell Press:
  2026-06-09  135 × 6
```

After inserting all sets, walk each exercise in date-ascending order and set `is_pr = true` on the row whose e1RM is a new high-water mark. Idempotency: the script should `truncate` only the `gym_sets`/`gym_exercises` rows for `RYAN_USER_ID` before re-seeding, so re-runs are safe.

---

## Part 2 — UI Prototype at `/physiq/gym-tracker`

### 2.1 Route & layout

- New route: `app/(dashboard)/physiq/gym-tracker/page.tsx`
- New widget: `components/widgets/GymTrackerWidget.tsx`
- New Supabase client: `lib/physiqSupabase.ts`
- New data helpers: `lib/gymTracker.ts` (queries, e1RM calc, PR detection, set insert)

The page should be self-contained (no Mission Control nav changes yet — just navigate to `/physiq/gym-tracker` directly). Add a small "← Back to Physiq" link at the top.

### 2.2 Top of page
- Title: **Gym Tracker** (zinc-100, text-xl, font-semibold)
- Sub-tabs: **Strength** | **Cardio** (Strength selected by default). Use the same pill-tab styling as Mission Control's other multi-tab widgets — zinc-800 inactive, zinc-700 + zinc-100 active.

### 2.3 Strength tab — exercise grid

Render Ryan's saved strength exercises as **cards** in a responsive grid:
- Mobile (375px): 1 column
- ≥640px: 2 columns
- ≥1024px: 3 columns

**Per card:**
- Exercise name (zinc-100, font-semibold)
- 🏆 amber pill badge if the card's all-time best e1RM has been hit (always true if the exercise has ≥1 set, but the badge shows the actual PR — see below)
- "Last session" row: most recent set as `225 × 5 · Jun 22` (zinc-300 / zinc-500 muted date)
- "PR" row: best-ever set, formatted same way, with the 🏆 emoji prefix — e.g. `🏆 345 × 5 · Mar 26` (Barbell Squat)
- **Sparkline:** last 10 sessions' e1RM, rendered as a tiny inline SVG (~120×28px). One point per session (latest set of that day). Amber stroke (`#f59e0b`). No axes. Just the curve. If <2 points, show a flat dotted placeholder.
- Tap the card → opens the **Log Set** modal/sheet for that exercise (see 2.4).

**Card styling:** `bg-zinc-900 border border-zinc-800 rounded-lg p-4` to match `PhysiqWidget.tsx`. Hover: `border-zinc-700`. Tap target = the full card.

Sort: most-recently-trained exercise first.

Below the grid: small `[+ Add Exercise]` button (zinc-500 → zinc-200 on hover) that opens a tiny modal with name + category (strength/cardio).

### 2.4 Log Set modal/sheet

Bottom sheet on mobile (slides up), centered modal on desktop. Use a shadcn `Sheet` (mobile) / `Dialog` (desktop) or hand-roll if shadcn isn't already wired.

Content:
- Header: exercise name + the 🏆 PR badge for context (`PR: 345 × 5`)
- Two big inputs side by side: **Weight (lbs)** and **Reps**. Numeric keyboard on mobile (`inputMode="decimal"`).
- Date picker — defaults to today.
- Optional **Notes** textarea (one line, e.g. "fatigued", "didn't fully lock").
- **Mic button** (see Part 3) sitting between the inputs.
- `[Save]` (amber-500 bg) and `[Cancel]` (zinc-700) buttons.
- On save: insert the set, recompute is_pr, close the sheet, refresh the card. If the new set sets a PR, briefly flash a "🏆 New PR!" toast (amber bg, zinc-950 text, auto-dismiss 2.5s).

### 2.5 Cardio tab

Simpler. List view (not card grid):
- `[+ Log Cardio]` button at top
- Below: reverse-chronological list of cardio sessions
- Per row: date · exercise name · `30 min · 6.0 mph · 2.0% incline` · notes
- Log modal: exercise name (free text or dropdown), duration, speed, incline, notes

No seed data needed for cardio — Ryan has none yet. Leave empty state: "No cardio logged yet. Tap + to add."

### 2.6 Empty/loading states
- Loading: skeleton cards (animate-pulse zinc-800 blocks). No spinners.
- Empty Strength (shouldn't happen post-seed but handle it): "No exercises yet. Tap + to add your first one."

---

## Part 3 — Voice input

In the Log Set modal, a **mic button** (Lucide `Mic` icon, 44×44px, zinc-800 bg) sits between the weight and reps inputs.

### Implementation
Use the **Web Speech API** (`window.SpeechRecognition || window.webkitSpeechRecognition`). It's free, no API key needed, works in Safari iOS 14.5+ and Chrome.

Behavior:
1. Tap mic → button pulses red, browser asks for mic permission first time
2. Listen for up to 5 seconds OR until silence
3. Transcribe to text, then run a parser against the transcript

### Parser rules
Match these patterns (case-insensitive, ignore filler words):

| Phrase | Action |
|---|---|
| `"225 for 5"` / `"225 by 5"` / `"225 times 5"` | weight=225, reps=5 |
| `"two twenty-five for five"` | weight=225, reps=5 (handle spelled-out numbers via a small word→number map for 0–999) |
| `"225 for 5, fatigued"` / `"225 for 5 felt heavy"` | weight=225, reps=5, notes="fatigued" / "felt heavy" |
| `"100 for 8 reps"` | weight=100, reps=8 |
| `"45 for 8 and a quarter"` / `"45 for eight point two five"` | weight=45, reps=8.25 |

If parsing fails, show the raw transcript in a small zinc-500 text below the inputs (`Heard: "..."`) so Ryan can manually correct. **Don't auto-submit** — always populate the fields and let Ryan tap Save.

### Fallback
If `SpeechRecognition` isn't available (e.g. desktop Firefox), grey out the mic button with a tooltip: "Voice input not supported in this browser."

---

## Checkpoint Protocol

After **each Part**, stop and post a short status update via:
```bash
openclaw system event --text "Cody checkpoint: <Part N> complete — <one-line summary + what to verify>" --mode now
```

Then wait for Ryan to confirm before starting the next Part. Specifically:
- **After Part 1:** confirm schema + seed by running `select count(*) from gym_sets where user_id = '<RYAN_USER_ID>';` and report row counts per exercise. Don't move to UI until Ryan eyeballs the numbers.
- **After Part 2:** post the local URL (`http://localhost:3001/physiq/gym-tracker`) for Ryan to review on his phone via the existing tunnel. Don't add voice yet.
- **After Part 3:** record a short Loom or describe the voice flow so Ryan can verify before deploying.

---

## Deploy Gate

**Do not deploy to production** (`vercel --prod`) until:
1. All three Parts are complete
2. Ryan has explicitly said "ship it" or "deploy"
3. `pnpm tsc --noEmit` passes clean (the real build gate — see `CLAUDE.md`)
4. `pnpm next build` succeeds locally

When you do deploy: don't touch `PhysiqWidget.tsx` yet. The gym tracker route stays standalone for this build. Wiring it into the Physiq tab (and removing the mock workout log) is a follow-up brief.

---

## Files allowed to create / modify

**New files:**
- `app/(dashboard)/physiq/gym-tracker/page.tsx`
- `components/widgets/GymTrackerWidget.tsx`
- `components/widgets/gym-tracker/ExerciseCard.tsx`
- `components/widgets/gym-tracker/LogSetSheet.tsx`
- `components/widgets/gym-tracker/Sparkline.tsx`
- `components/widgets/gym-tracker/AddExerciseModal.tsx`
- `components/widgets/gym-tracker/CardioTab.tsx`
- `lib/physiqSupabase.ts`
- `lib/gymTracker.ts` (queries + e1RM + PR helpers + voice parser)
- `supabase/migrations/2026-06-30_gym_tracker.sql`
- `scripts/seed-gym-tracker.mjs`
- Add to `.env.local` (not committed): `NEXT_PUBLIC_PHYSIQ_SUPABASE_URL`, `NEXT_PUBLIC_PHYSIQ_SUPABASE_ANON_KEY`, `PHYSIQ_SUPABASE_SERVICE_ROLE_KEY`

**Modify:**
- `package.json` only if a new dep is genuinely needed (avoid if possible — Web Speech API is built in, sparkline can be hand-rolled SVG)
- `.env.example` (commit) to document the new env var names (values blank)

---

## DO NOT TOUCH

- `components/widgets/PhysiqWidget.tsx` — leave it exactly as-is for this build. The Phase-2 wire-in is a separate brief.
- Anything under `app/(dashboard)/pipeline/`, `app/(dashboard)/chat/`, `app/(dashboard)/relationships/`, or any other tab
- The LRG Homes Supabase client (`lib/crms.ts`, `lib/leads.ts`, etc.) — the two Supabase projects are separate, keep them that way
- Any existing API routes
- `.env.local.save` / production env vars in Vercel (Ryan will add the Physiq env vars manually before deploy)

---

## Notify when each Part is done

```bash
openclaw system event --text "Cody: Gym Tracker Part <N> complete — <what to review>" --mode now
```

And one final notification when everything is locally working and ready for Ryan's prototype review:

```bash
openclaw system event --text "Cody: Gym Tracker prototype ready at /physiq/gym-tracker — awaiting Ryan approval before deploy" --mode now
```
