# Brief — Mission Control 2.0 shell (2026-11-10)

Owner project: `PROJECTS/mission-control-revamp` (memo + `mockups/`). Ryan said go on 2026-11-10.
The shell ships in parts, each on its own, each verified on prod before the next:

- **Part A — remove the dead pages** (this section is complete; build from it)
- Part B — Navy "Signal" skin (spec to follow in this file)
- Part C — new nav (desktop sidebar + phone bottom bar), Today landing page, Hopper placeholder (spec to follow)

Gate for every part: `npx tsc --noEmit`, `npm test`, `npx next build` all clean. Never `git add -A`. The lead session commits and ships — builders leave changes uncommitted.

---

## Part A — remove the dead pages

Fifteen pages were placeholders or OpenClaw-era screens Ryan never opens. An audit on 2026-11-10 traced every dependency; the lists below are the result. If you find a dependency the lists do not mention, STOP and report it rather than deleting further.

### Delete (pages)
`app/(dashboard)/` → `chat`, `terminal`, `agents`, `macmini`, `pipeline`, `redfin`, `social`, `ads`, `stocks`, `documents`, `calendar`, `memory`, `skills`, `bugs` (whole folders), and **only the file** `physiq/page.tsx`.

**Do NOT delete the `physiq/` folder.** `physiq/gym-tracker/` is a real, working page (GymTrackerWidget, `components/widgets/gym-tracker/*`, `/api/physiq/gym/*`, `lib/physiqSupabase.ts`, `lib/gymTracker.ts`) and all of that stays. Its back link (`physiq/gym-tracker/page.tsx`, `href="/physiq"`) must be repointed to `/`.

### Delete (widgets, only used by those pages)
`components/widgets/`: `ChatWidget`, `TerminalWidget`, `AgentsWidget`, `MacMiniWidget`, `RealEstateWidget`, `PipelineWidget`, `RedfinWidget`, `SocialWidget`, `GoogleAdsWidget`, `StocksWidget`, `DocumentsWidget`, `CalendarWidget`, `MemoryWidget`, `SkillsWidget`, `BugsWidget`, `PhysiqWidget`.
Note: `RealEstateWidget` imports `CRMSTab` — CRMSTab STAYS (the Relationships page imports it directly).

### Delete (support files that become orphaned)
- `hooks/useCalendar.ts`, `hooks/usePipeline.ts`, `hooks/useSocial.ts` (then the empty `hooks/` folder)
- `types/index.ts` — only if nothing left imports `@/types` (verify with grep after the deletions)
- `lib/mockData.ts`
- `components/ui/card.tsx`, `scroll-area.tsx`, `badge.tsx`, `button.tsx`, `separator.tsx` — each only if nothing left imports it (verify one by one)
- `public/data/projects.json`, `public/data/skills.json` — only if unreferenced
- API routes: `app/api/calendar`, `app/api/pipeline`, `app/api/social`, `app/api/memory`, `app/api/skills`, `app/api/bugs` (incl. `bugs/content`)
- `tests/no-haiku.unit.test.ts` has a SKIP entry for `lib/mockData.ts` — remove the stale entry (keep the test)
- If `@radix-ui/react-scroll-area` (or any other dependency) ends up with zero importers, list it in your report — do NOT edit package.json.

### Keep (looks related, is not)
- `lib/sidecar.ts`, `app/api/projects/*` and the Projects page (rebuilt later), `react-markdown`
- The real calendar code: `lib/calendarIntake.ts`, `lib/appointments.ts`, `lib/appointmentTime.ts`
- `app/api/mini/watch`, `lib/miniSpace.ts`, `scripts/mac-mini-reset.sh`, `lib/agentsLineInbound.ts`
- `components/widgets/board/*`, `app/(dashboard)/board`, `app/(dashboard)/deal-flow` — the routes stay reachable by URL
- Everything under `app/api/physiq`

### Navigation and the front door
- `components/Sidebar.tsx` (`navGroups`, used by both the desktop sidebar and the mobile drawer): remove every link to a deleted page, and remove **Board** (`/board`) and **Deal Flow** (`/deal-flow`) from the nav. Remove the Physiq / "Portal" entries too. Remove groups that end up empty and icon imports that end up unused. Do not redesign the nav — Part C replaces it.
- `app/page.tsx` currently does `redirect("/chat")`. Change it to `redirect("/leads")` in the same change (interim; Part C points it at `/today`).
- `app/login/page.tsx` falls back to `"/"` after login — leave it.

### Verify before reporting
1. `grep` the repo (excluding `briefs/`, `node_modules`, `.next`, `.claude`) for every deleted file/route name: `@/types`, `mockData`, `useCalendar|usePipeline|useSocial`, `/api/(calendar|pipeline|social|memory|skills|bugs)`, each widget name, and `href="/(chat|terminal|agents|macmini|pipeline|redfin|social|ads|stocks|documents|calendar|memory|skills|bugs|physiq)"`. No live references may remain (the gym-tracker route `/physiq/gym-tracker` is fine).
2. `npx tsc --noEmit`, `npm test`, `npx next build` — all clean. In the build's route table the 14 pages and `/physiq` must be gone and `/physiq/gym-tracker`, `/board`, `/deal-flow`, `/projects`, `/leads`, `/relationships`, `/campaigns`, `/email-campaign`, `/cycle`, `/leads-embed`, `/offer`, `/login` must still be there.
3. Report: files deleted (count + list), files edited, anything you chose not to delete and why, unused dependencies, and the three gate results.

---

## Ryan's standing display rules (apply to Parts B and C)

- He reads this on his **phone**. Every screen is designed phone-first and checked at iPhone width.
- **Every date shows the year** (`{ month: "short", day: "numeric", year: "numeric" }`); relative stamps ("3d ago") and weekday+time within the coming week are fine. All server-side date formatting passes `timeZone: "America/Los_Angeles"`.
- A **change** number is coloured by the number itself: above zero green, below zero red. Counts with no comparison stay neutral.
- In any header row: `shrink-0` on buttons/toggles, `min-w-0` + `truncate` on variable-length text — never the reverse (a crushed control reads as a missing feature).
- Plain words. No jargon labels, no source names in front of labels.
- No added manual steps; nothing that asks him to configure anything.

## Part B — Navy "Signal" skin

Approved look (2026-11-07): `PROJECTS/mission-control-revamp/mockups/` — `signal-phone.png`, `signal-desktop.png`, and the CSS that drew them in `themes.css` (`.signal` variables). Rejected looks (Paper, Studio, Graphite, Forest) are not to be offered again.

Tokens: background `#0a0f1e`, card `#101829`, raised card `#131d33`, border `#1d2840`, ink `#e6edf7`, muted `#7d8aa6`, accent teal `#2dd4bf`, good = teal, warn `#fab219`, bad `#f05252`. Numbers in a monospace face (`ui-monospace, "SF Mono", Menlo, monospace`, tabular). Small labels uppercase with wide tracking. Tiles and the active nav item carry a 2 px teal edge.

How:
1. The app's greys are hand-written `zinc-*` classes in ~65 remaining files (~2,500 uses); the shadcn CSS variables are barely used. **Do not hand-edit those files.** Remap the `zinc` scale in `tailwind.config.ts` (`theme.extend.colors.zinc`) to a navy scale so every existing class follows: 950 `#0a0f1e`, 900 `#101829`, 800 `#1d2840`, 700 `#2a3757`, 600 `#47557a`, 500 `#7d8aa6`, 400 `#9aa6c0`, 300 `#c3cce0`, 200 `#d9e0ef`, 100 `#e6edf7`, 50 `#f4f7fc`. (`800` is used for both borders and raised surfaces today; `#1d2840` reads correctly for both. If raised surfaces look too heavy, say so in the report rather than forking the scale.)
2. Update the `.dark` CSS variables in `app/globals.css` to the same palette so the few token-based components match; add `--accent`-style teal where the tokens are used.
3. Add Tailwind theme entries the new screens use: `colors.signal` = `{ bg, card, card2, border, ink, muted, accent, warn, bad }` and `fontFamily.num` (the monospace stack).
4. Inline hex that does not follow classes — fix by hand: `app/(dashboard)/cycle/page.tsx` (SVG chart greys `#e4e4e7 #71717a #27272a #18181b` → ink / muted / border / card; keep the data-series hues), the gym-tracker charts' grey axis/grid hex (keep series hues: amber-600 `#d97706`, sky-600 `#0284c7`, violet-600 `#7c3aed`), and `app/offer/page.tsx` `setHeaderColor` / `setBackgroundColor` (`#09090b` → `#0a0f1e`).
5. Do not change existing accent colours inside the working tabs (status chips, temperature colours, green/red change numbers). This part changes the surface, not the meaning of colours.

Check (the lead renders screenshots for Ryan before this ships): `/login`, `/leads` (list + one open card), Follow Ups, `/relationships`, `/campaigns`, `/email-campaign`, `/cycle`, `/offer`, `/leads-embed?embed=1`, `/physiq/gym-tracker` at phone width and 1440 px. Report anything that reads badly on navy (low-contrast text, a border that vanished, a chip that now clashes).

## Part C — navigation, Today, The Hopper

### Navigation (replaces `components/Sidebar.tsx`'s nav; mounted in `app/(dashboard)/layout.tsx`)
- **Desktop (md and up): left sidebar**, 220 px, brand "Mission Control" with a small teal dot, three groups:
  - *Daily*: Today (`/today`)
  - *Real estate*: Leads (`/leads`), Relationships (`/relationships`), Campaigns (`/campaigns`), Email Drip (`/email-campaign`), Market Cycle (`/cycle`)
  - *Ops*: Projects (`/projects`), The Hopper (`/hopper`)  — Health is added to this group when its page ships (step 5); do not link a page that does not exist.
  - Active item: card background + 2 px teal left edge + teal icon. Foot of the sidebar: today's date (Pacific, with the year).
- **Phone (below md): bottom tab bar**, five slots, fixed, safe-area aware (`env(safe-area-inset-bottom)`), replacing the current top bar + drawer: **Today · Leads · People** (`/relationships`) **· Campaigns · More**. "More" opens a sheet with: Email Drip, Market Cycle, Projects, The Hopper, Gym tracker (`/physiq/gym-tracker`). The active tab is teal. Page content gets bottom padding so nothing hides behind the bar.
- Retired and NOT in any menu: Board (`/board`), Deal Flow (`/deal-flow`) — both stay reachable by URL.
- `/leads-embed`, `/offer`, `/login` render no nav (they are outside the dashboard group — keep it that way).
- `app/page.tsx` → `redirect("/today")`.

### Today (`/today`) — the landing page on every device
Layout = the approved mockup (`mockups/build.mjs` has the exact structure; `signal-phone.png` / `signal-desktop.png` the look). Greeting line by Pacific time of day ("Morning, Ryan." / "Afternoon, Ryan." / "Evening, Ryan.") under a date line (`Tuesday · Nov 10, 2026`).

Sections, phone order top to bottom; desktop = 4 tiles across, then three columns (Due today | Appointments + Jackie | AI spend):
1. **Health pills** — Mini, Bridge, Judge, Autopilot. ok = teal ✓, problem = amber !.
2. **Four tiles** — Follow-ups due · Touches due · Appointments · Jackie overnight. Each tile links to its page (Follow Ups view of `/leads`, `/relationships`, the appointments list below, the Jackie list below).
3. **Due today** — up to 3 rows on phone / 6 on desktop from the Follow Ups worklist (name, one line of why, "today" / "overdue 2d"), then "N more in Follow Ups →". Each row opens that lead (`/leads?phone=…`, the deep link Follow Ups already uses).
4. **Appointments** — today's and upcoming (next 7 days), time + who/what.
5. **Jackie overnight** — her calls since 5:00 PM Pacific the previous day: caller (phone formatted; name when the lead has one), what happened in one line, time.
6. **AI spend** — yesterday's total, month-to-date vs the $100 target with a bar, 7 daily bars (last one highlighted), first and last date labelled with the year.

Data — reuse what exists; **do not refactor the Follow Ups route**:
- Follow-ups due + Due today list: the page calls the existing `GET /api/follow-ups` (`rows` = the worklist; read `components/widgets/FollowUpsTab.tsx` for how a row's name / primary line / due state are derived and reuse those helpers rather than re-deriving).
- Touches due: existing `GET /api/crms/contacts` (`total`).
- Everything else: one new route `GET /api/today` (session-gated like every other route — it is NOT public), reading Supabase through `getLeadsClient()`, all queries in parallel:
  - **Mini / Bridge**: table `mini_heartbeat`, row `id='mini'` — `beat_at` (mini ok when < 4 min old), `watchdog_at` (bridge watchdog ok when < 20 min old), `free_kb`. Same thresholds as `app/api/mini/watch/route.ts`.
  - **Judge**: newest `judged_at` in `lead_verdicts` — ok when it ran today (Pacific); show the time.
  - **Autopilot**: count of leads with `drip_campaign_type = 'autopilot'` that are active (see `supabase/migrations/2026-11-05_autopilot.sql` and how FollowUpsTab / the drip engine decide "on autopilot"); amber when the Follow Ups response has `failed` rows (the page already has that response — combine client-side).
  - **Appointments**: leads with `appointment_at` from the start of today (Pacific) through +7 days, one per person (cluster by phone, newest row wins — see `lib/appointments.ts` `getClusterAppointment` and `appointment_details`), excluding dead/DNC clusters.
  - **Jackie overnight**: lead rows where `jackie_call` is not null and `created_at` ≥ 5:00 PM Pacific yesterday (read `supabase/migrations/2026-10-27_jackie_call_arm.sql` and `lib/jackieScoreboard.ts` for what the `jackie_call` json holds). Also return yesterday's same-window count so the tile can show ▲/▼ vs yesterday.
  - **AI spend**: table `llm_usage` (`cost_usd`, `created_at`). Use the existing SQL function `llm_usage_rollup(p_from, p_to)` (sum its `cost_usd`) once per Pacific day for the last 7 days and once for the month to date, in parallel — never page raw rows (PostgREST caps a select at 1,000 rows). Target is $100/month.
  - Use `lib/pacificDate.ts` for day boundaries. Any `.range()` needs an `.order()` in the same chain (`tests/ordered-paging.unit.test.ts` enforces it).
- Refresh: fetch on load, again when the tab becomes visible, and every 60 s while visible (copy the visibility pattern in `FollowUpsTab.tsx`). Each section shows its own small "couldn't load" line on failure — one failed source must not blank the page.
- A tile with nothing to compare shows a plain sub-label ("Relationships", "next 10:30 AM"), not a fake delta.
- Unit-test the pure parts (greeting by hour, Pacific overnight window, spend roll-up shaping, appointment clustering) in `tests/today.unit.test.ts`.

### The Hopper (`/hopper`) — placeholder ideas list
Ryan's name for the list of tools and ideas not on day one. Day-one scope is deliberately small: a plain list he can read and add to from his phone.
- Table (new migration `supabase/migrations/2026-11-10_hopper.sql`; **RLS enabled, no policies** — service-role only, like every table here): `hopper_items` — `id uuid pk default gen_random_uuid()`, `title text not null`, `note text`, `kind text not null default 'idea'` (`tool` | `idea`), `status text not null default 'open'` (`open` | `picked_up` | `dropped`), `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`. The migration seeds the list below with `on conflict do nothing` semantics (unique index on `lower(title)`). The lead applies the migration — do not run it.
- `GET /api/hopper` (list, open first, newest first), `POST` (title, optional note/kind), `PATCH` (status, title, note). Session-gated.
- Page: two groups (Tools, Ideas), each item = title + one-line note; an "Add an idea" box at the top (title, optional note) that works with the phone keyboard; a small menu per item to mark it picked up or dropped (dropped items hide; picked-up items show under a collapsed "Picked up" heading).
- Seed — Tools: Property Lookup (one address box: owner of record, sales chain, skip trace, mail history, comps, existing lead/relationship record) · Underwrite (deal + loan calculator: purchase, rehab, ARV, loan terms → profit vs the $200k gate) · Sign (a screen for the e-sign service) · Offers (a screen for the offer bot) · Video Editor (footage, drafts, covers, post results). Ideas: Deal Flow revamp (every property ever pitched and what happened to it) · Past Deals folder (underwriting vs actual, each becomes a comp) · Health v2 (per-job last success, plain-English error log, helper freeze watchdog) · Texts search with an AI layer · Jackie controls screen · Loans ledger / money dates on Today · Desktop calendar page · Business card generator · DNC scrub as a paste-a-list tool · Adobe replacement · Death-of-a-joint-tenant mail package · Networking bot: search Meetup / Eventbrite · Jackie as full-time receptionist · "My Cell" flag on leads · Auto-clear video scratch files at wrap · The Board (retired 2026-11-10; revive if wanted) · Referral business outreach (24-source scraper concept) · Contact detail page for Relationships · Database farming ideas · Leads list: slim download + load the full record when a card opens · "New version — tap to reload" banner.
