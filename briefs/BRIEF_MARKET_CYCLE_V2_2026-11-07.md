# Market-cycle tracker v2 — scope of work + audit (DRAFT, Nov 7, 2026)

**Status:** APPROVED by Ryan Nov 7, 2026 (answers in §7). Building in order: Phase 1 → 4. Source of the
decisions: `PROJECTS/market-cycle-tracker/REVIEW_NOTES_2026-11-07.md`
(33 numbered items) and the mockups in `PROJECTS/market-cycle-tracker/mockups/`.
Build target for the page: `mockups/full-page-v2.png`.

Where the project is: live since Nov 1, 2026 (brief v1.1:
`briefs/BRIEF_MARKET_CYCLE_TRACKER_2026-11-01.md`). Three launchd jobs on the
mini (weekly Mon 06:00, macro daily 06:30, review daily 07:30 `--check`).
Housing odds today Bear 40 / Base 45 / Bull 15 (moved Nov 2 on an inventory
tripwire). Next scheduled card: shakedown Mon Dec 14, 2026.

---

## 1. What triggered this (Nov 7, 2026)

- 06:30 macro run: FRED didn't answer for ~3.5 h → 32 of 48 dials failed, the
  run retried each one 5× sequentially (finished 10:09) and sent a 32-line
  Telegram alert. Readings self-heal on the next run; the alert was the
  problem, not the data.
- Walking the page with Ryan surfaced: two tripwires fired early (one on a
  one-day gap counted as "two weeks", one on backfilled 2025 data), the
  Telegram card and the page are written in internal jargon, the Dials list is
  unreadable on a phone, and the "when does it turn" question — the one Ryan
  actually asks — was buried in scenario markers.

## 2. Decisions already made with Ryan (don't re-open)

| # | Decision |
|---|---|
| D1 | Outage handling: 3 strikes per host per run, retry hourly all day, one plain alert only if still down at the next 06:30. Real breakage still alerts same day. |
| D2 | Both bets lead with **when** (low window + rebound window on a timeline), then depth. Rebound = housing: prices rising YoY again; stocks: new all-time high. |
| D3 | Stock bet: S&P 500 max drawdown from the Oct 6, 2026 high (7,819) + timing, through Dec 2028. Bear ≥25% & low 2028+ / Base 10–25% & low by late 2027 / Bull <10% & low before mid-2027. Start Bear 40 / Base 40 / Bull 20. Own drivers only. Watch-only. Housing thesis unchanged. |
| D4 | Every chart = last 12 months with month letters. Latest value: ▲▼▬ for direction, green/red/gray for what it means for SCC house prices. |
| D5 | Dials: 9 key numbers on top (drop from peak, homes for sale, price cuts, buyer pace, mortgage rate, oil, S&P 500, NASDAQ, San Jose job growth), price-band table, everything else in a scroll box. No source names in dial names. One row per idea (MLS weekly as headline, Realtor.com "vs normal" as sub-line). |
| D6 | "My zip codes" (95118 / 95123 / 95130) + "Nearby markets" (SCC, San Mateo, SF, Santa Cruz, Fremont), Zillow only, each with "vs last year" and "vs peak (month year)". Zip big, address small, "Typical home here". Claims off the page. |
| D7 | "Last review" + "Odds history" merge into one bottom card, newest open, older one-liners, "alarm fired" tag. Details button off the page; Disagree on the page too. |
| D8 | Cadence: monthly = first Monday on/after the 15th once both CPI and Zillow's prior-month print are in; fallback last Monday; slide a week if FOMC is within 3 days after. Quarterly Feb/May/Aug/Nov. Dec 14, 2026 shakedown unchanged. S&P −10%-from-high tripwire. |
| D9 | WARN: show "last 30 days" vs 12-month average and the alarm line; month-so-far as a sub-line only; monthly totals must be rewritten as late notices post. |

## 3. Scope of work v1 (pre-audit draft)

### A. Plumbing (Python collectors on the mini)
- A1 Per-host circuit breaker (3 consecutive transport failures → skip host for the run). Grouped, one-line failure summary in the log.
- A2 Hourly retry of this morning's failed dials until the next 06:30; alert only then, one line per host, plain English. Non-transient failures (403/404/parse) alert same day.
- A3 Tripwire "two consecutive weekly readings" requires ≥6 days between them.
- A4 Tripwires fire only on readings newer than the last run (never on backfill).
- A5 WARN monthly totals re-aggregated and upserted every run (late notices). Add a `warn_30d` rolling variant.
- A6 Weekly job: make sure stdout lands in `/tmp/lrg-market-cycle-weekly.log`.
- A7 New dials: NASDAQ (FRED NASDAQCOM, daily, votes in the stock bet); Zillow ZHVI SFR for San Mateo, San Francisco, Santa Cruz counties + Fremont city (monthly, display only); S&P −10%-from-high tripwire.
- A8 Realtor.com Nov overlap → replace the guessed k=0.586 calibration automatically when available.

### B. Cadence (lib/marketCycle/schedule.ts)
- B1 Data-ready monthly rule (D8) with CPI dates from the calendar, Zillow readiness from the latest `zhvi_scc` reading, FOMC slide rule, last-Monday fallback.
- B2 Keep Dec 14 shakedown and quarterly months as-is. Tests for every branch (late Zillow, FOMC collision, month with 5 Mondays).

### C. Stock bet (config + DB + review)
- C1 Thesis config: per-bet scenarios (housing, stocks) each with depth bands, low window, rebound window, weights, own dial set, own tripwires.
- C2 DB: weights/moves/checkpoints keyed by bet (migration; housing rows backfilled as `bet='housing'`).
- C3 Review runs both bets in one checkpoint, one Opus call per bet or one combined — decide in audit; one Telegram card covering both.
- C4 New dated claims: S&P low before Jul 2027; S&P new ATH by Dec 2028; SCC positive YoY by Q4 2027 (housing rebound). Scored like the rest.
- C5 Weight-move log and "reverses if" per bet.

### D. Telegram card
- D1 Plain-English renderer: per-dial "about X% above a normal October (usual range …)" from the band stats; no z-scores, ISO dates, claim ids.
- D2 Card covers both bets; Details + Disagree buttons stay.

### E. /cycle page (app/(dashboard)/cycle)
- E1 Card 1 SCC houses + Card 2 US stocks: question, Now line, timeline (Oct 2026→Dec 2028, solid low bar / outlined rebound bar per scenario), depth bars, footer.
- E2 Card 3 Dials: key numbers (plain names, value colour + arrow, sub-line, 12-month sparkline with month letters), price-band table (empty columns hidden until a prior week exists), scroll box with grouped remaining dials.
- E3 Card 4 My zip codes + Card 5 Nearby markets (Zillow, vs last year + vs peak).
- E4 Card 6 Reviews & odds moves (merged, newest open, Disagree on web).
- E5 Dial display metadata: plain name, group, key-number order, "good direction" — one place (audit decides where).
- E6 12-month series for sparklines regardless of cadence (monthly rollup for daily/weekly dials).
- E7 Claims removed from the page (still in DB and reviews).

### F. Web Disagree
- F1 API route (session-cookie auth) → `cycle_checkpoints.ryan_note`; same prompt wording as Telegram; shows the stored note on the card.

### G. Verification + deploy
- G1 Unit tests for A3/A4/B1/C1/E6; fixtures with variant rows; page rendered against production data before "live".
- G2 `tsc --noEmit` + `next build`; Vercel deploy; launchd reload on the mini (Ryan's tap if a restart is needed).
- G3 Dry-run a review with `--dry-run --llm` on both bets before Dec 14.

### H. Docs
- H1 Thesis brief v1.2 (stock bet, cadence, timing claims), PROJECT_MEMO + CHANGELOG, memory.

## 4. Audit findings (Nov 7, 2026 — three read-only audits: collectors, review engine, page/data)

Raw reports: `PROJECTS/market-cycle-tracker/audit-2026-11-07/`. Ranked by what it does to the bet.

### 4.1 Wrong answers today (fix before anything else)
| # | Finding | Evidence |
|---|---|---|
| F1 | **The number the housing bet is scored on never votes.** `zhvi_scc_drawdown` has `corridor: null` in config; bootstrap stores its bands nested under `scenario_bounds_pct`, but `corridorEdges` reads top-level keys → "corridor not set" every review. | thesis:1656ff; bootstrap-history.py:139-143; votes.ts:70-79, :192 |
| F2 | **Stored monthly readings are never revised.** `collect_one` keeps only readings strictly newer than the latest stored date, so a revised month is dropped before the upsert. WARN Oct 2026 is stored as 463 while EDD's file now says 569; **November is frozen at 108 (the Nov 1 value) for the whole month** — the layoff dial and its tripwire are effectively "first-day-of-month" counts. Same freeze for FRED/C.A.R. revisions. | collect-macro.py:147; sources.py:964-968; migration comment 2026-11-01:79 says the opposite |
| F3 | **Tripwires fire on the wrong things.** No minimum gap between "consecutive weekly" readings (Nov 1 + Nov 2 = two weeks); no recency check, so a backfilled 2025-10 reading fired `scc_warn_spike`; manual baselines are included; weekly `as_of` = run date, not the ISO week (`week_of()` exists, unused); the k recalibration can move an episode's date past the dedupe. | tripwires.py:59, :80-103, :137-164, :206, :265; collect-weekly.py:657 |
| F4 | **A missed review run silently skips the month.** `checkpointDue` is `scheduled date === today`; nothing re-runs the next day; nothing prevents two checkpoints on one date; the tripwire path re-runs daily until `reviewed_at`. | schedule.ts:75-86; review.ts:246 |
| F5 | **The 07:30 review does not wait for the 06:30 collector.** On Nov 7 it ran at 07:30 while the macro job was still retrying FRED (it finished 10:09). Harmless that day (nothing due); on a review day it reviews stale data. | plists; macro log |
| F6 | **Claim scoring is the model's opinion.** Opus is told to resolve due claims; `rules.ts` checks only id/status/type/date/reason, never the outcome against readings. `claim_early` never fires. The "scorecard" promise is only as honest as one prompt. | prompt.ts:57, :97; rules.ts:70-90; tripwires.py:22, :210 |
| F7 | **Release calendar ends Jan 2027.** From Feb 2027 the scheduler is already on its "Monday on/after the 15th" fallback with no CPI/FOMC awareness. | thesis.v1.1.json:3060; schedule.ts:31-34 |
| F8 | **Logs and snapshots in `/tmp` get deleted nightly** by macOS `tmp_cleaner`. The weekly log and `/tmp/market-cycle-snapshot-*.json` are already gone; the macro/review logs survive only because they're rewritten daily. | com.apple.tmp_cleaner; `/private/tmp` oldest entry Nov 3 |

### 4.2 Collectors
| # | Finding |
|---|---|
| F9 | No per-host breaker; everything sequential; a FRED outage costs 29 series × 5 tries × 45 s × 2 passes ≈ 3.9 h. Alert lists one entry per dial, sent at the end. |
| F10 | Partial MLS failures (one city fetch failing) only go to notes, never alert → SCC actives silently undercounted → could trip the "below 0% YoY" tripwire. |
| F11 | `scc_months_supply` still fetches `realtor_active_scc` from FRED even in SFR-only mode → fails whenever FRED is down. |
| F12 | WARN xlsx + FY PDFs are joined without de-dup (double count risk at the Jul 1 fiscal boundary). EDD processes notices 1-6 days late. |
| F13 | Weekly plist chains `collect; tripwires` with `;` → tripwires run even if the collector failed; job exit code = tripwires'. Macro plist lacks `PYTHONUNBUFFERED`. |
| F14 | Zip dials store YoY % only; the `zhvi_zip_*_level` series `lib/cycleContext.ts:209` expects is never written. No Zillow dials for San Mateo / SF / Santa Cruz / Fremont. `zillow_county` would download the County file once per region. |
| F15 | Duplicated env/Supabase/Telegram helpers in three Python files; collect-weekly has its own no-retry `http_get`; bootstrap re-implements the two-pass loop with a different conflict rule; Stooq probe runs every basket fetch though Stooq is dead. |

### 4.3 Review engine / card
| # | Finding |
|---|---|
| F16 | Everything is single-bet: `Scenario`/`Weights` types, one `scenarios` array, `cycle_checkpoints.weights_*` and `cycle_weight_moves` without a `bet_id`, `cycle_claims.scenario_tag` check constraint, system prompt says "Santa Clara County housing". Vote math, clamp, claim Brier scoring and the `drawdown_from_<date>_high` transform are already generic. |
| F17 | S&P dial: corridor bear vote at −20 (decided bands use −25 / −10); no `read_as: 10d_avg` though vote_rules say market dials read as 10-day averages; the transform needs a reading dated exactly 2026-10-06 (present today, brittle). |
| F18 | Card jargon comes from `voteLine` (`z=`, `@ as_of`) copied by the model into `argument`, bullets printing `m.reading` verbatim, and `re-probbed C18`. 12-line soft budget; Why/Opposite clipped at 240 chars; no 4096-char guard. |
| F19 | Opus: up to 4 calls per review (re-ask on a rule break resends everything; 3× token retry on truncation). Prompt 5-8k tokens normally, but notes are uncapped in count (200 rows × 300 chars) so it can balloon to 15-20k. |
| F20 | Schedule logic duplicated in `schedule.ts`, `lib/cycleContext.ts:250`, `cycle-context.py:325-343`. Hard-coded: shakedown/first-formal in config, `CATEGORY_LABEL`, fallback base URL. |
| F21 | Disagree: Telegram-only; `storeRyanNote` is keyed by Telegram message id; move #0 has no checkpoint to attach a note to. `/api/cycle/*` is already behind the `mc_session` cookie. |

### 4.4 Page / data
| # | Finding |
|---|---|
| F22 | Page is a read-only server component; sparklines are "last 12 readings" of any cadence; names are `dial.name` with the source prefix; dials ordered by object order. Auto-registered dials (`mls_zip_*`, `scc_nod_filings_monthly`, `listed_*`) are invisible (`startsWith("mls_zip_")` can never match config dials). 95118 hard-coded in 3 places. |
| F23 | No display metadata anywhere (plain name, group, key-number rank, good-direction). `sync-registry --write` overwrites every `cycle_dials` column → a DB column would be clobbered; a `display` block in the thesis JSON is never copied to the DB (safe). |
| F24 | ~15 Supabase requests per render in 3 serial waves (dials → two paginated readings chains → 7 parallel). The 400-day base-variant window already loaded covers a 12-month rollup, so no new query is needed for sparklines. |
| F25 | Tests: nothing tests the page; fixture readings have no `variant` rows and ≤2 per dial; `stateFromFixture` doesn't filter `variant=''` (Supabase path does). |

## 5. Recommendations

1. **Fix the wrong answers first, as their own small phase, before the Dec 14 shakedown and before any redesign.** F1-F8 are correctness bugs in a live system that is about to produce its first scored card. None needs design input. They are small, testable, and each one would otherwise be inherited by the rebuild.
2. **Build the stock bet as a real "bets" generalisation, not a bolt-on.** Config `bets[]` (housing, spx), `bet_id` on moves/claims/tripwire events, checkpoints one row per bet sharing a `review_id`. One Opus call per bet (isolated validation and failure), one Telegram card for both. Thesis bumps to **v1.2** anyway (new bet, new claims, display metadata, cadence), with housing scenarios/weights carried over unchanged.
3. **Make claim scoring mechanical where the data can decide.** Threshold/level/drawdown claims (C1-C3, C15-C17, C32 and the new timing claims) resolve by code from readings on their due date, with the early-falsifier check running daily. Opus judges only event claims (IPO pricing, capex guidance, Hormuz). Otherwise the scorecard is not a scorecard.
4. **Hourly retry = a second launchd job, not a loop.** `--retry-pending` reads a JSON state file under `~/Library/Application Support/lrg-market-cycle/`, runs only the pending dials, stays silent. The 06:30 run reads the same state and alerts once, grouped by host. DEFERRED (transport) vs FAILED (403/404/parse) split so real breakage still alerts same day. Logs move to `~/Library/Logs/`.
5. **Review runs after the collector, not on a clock.** Chain the review check at the end of the macro job (`collect; review --check`) so it never sees half-collected data; drop the separate 07:30 job. Make "due" idempotent: today is a Monday ≥ planned date, data is in, no checkpoint of that kind this month.
6. **Display metadata lives in the thesis JSON** (`display: {label, group, key_rank, sub, good_when}`) plus a small TS pattern map for auto-registered dials. Never in the DB.
7. **Zip and area values need collecting, not just displaying.** Add `zhvi_zip_*_level` (and store each area's peak date/value in `corridor.computed`), and one-pass Zillow County/City readers for San Mateo / SF / Santa Cruz / Fremont.
8. **Cut from scope (already done or not worth it now):** A8 k auto-calibration (already in `tripwires.py:137-164`); page perf work beyond parallelising the two readings chains; the Python helper de-dup beyond files actually touched; WARN processing-lag refinement (note it on the row instead).
9. **Phase it, one PR each, Vercel deploy + launchd reload per phase, verified against production data before "live".** Build runs on the cloud credit (`claude-code-default`), reviewed here.

## 6. Updated scope of work (v2)

### Phase 1 — Correct what's live (before Dec 14, 2026; no design dependencies)
- P1.1 Scored dial votes: write `zhvi_scc_drawdown` corridor at top level (bootstrap + a one-off fix of the stored row); test that it votes. (F1)
- P1.2 Revisions: monthly dials re-send the last 3 months + the current part-month every run; merge-upsert updates them. Backfill WARN Oct/Nov now. Test with a revised fixture month. (F2)
- P1.3 Tripwires: one point per ISO week (latest), min gap weekly ≥5 d / monthly ≥20 d; fire only if the onset reading is <8 days old, else record HISTORICAL without posting; exclude every `manual:` source; `as_of = week_of(today)` in collect-weekly. Re-evaluate the Nov 2 `scc_actives_yoy` event on Nov 9 with the fixed rule and log the outcome. (F3)
- P1.4 Review idempotence + ordering: review check runs at the tail of the macro job; `due` = Monday ≥ planned & no checkpoint of that kind this month; a missed day runs the next day. Remove the 07:30 job. (F4, F5)
- P1.5 Calendar through Dec 2028 (CPI, FOMC, jobs, Case-Shiller, PCE, GDP) loaded into `cycle_calendar` and config. (F7)
- P1.6 Logs → `~/Library/Logs/lrg-market-cycle-*.log`; snapshots → Application Support; plists: `&&` not `;`, `PYTHONUNBUFFERED` on all. (F8, F13)
- P1.7 MLS partial failures alert; `scc_months_supply` uses the SCCAOR series only. (F10, F11)
- P1.8 WARN de-dup across xlsx/PDF on (notice date, employer, count). (F12)

### Phase 2 — Collectors, cadence, two bets, card
- P2.1 Per-host circuit breaker (3 strikes) + DEFERRED/FAILED split + pending-state file + `--retry-pending` + new hourly launchd job + next-06:30 grouped alert. (D1, F9)
- P2.2 Cadence rule D8 in `schedule.ts` (Zillow readiness from latest `zhvi_scc`, FOMC slide, last-Monday fallback); same rule in `lib/cycleContext.ts` and `cycle-context.py`, or those two delegate to one source; tests for late Zillow / FOMC collision / 5-Monday month. Shakedown handling per Q1 below.
- P2.3 Thesis v1.2: `bets[]` with per-scenario `depth`, `low_window`, `rebound_window`, weights, dial set, tripwires; `display` block per dial; S&P bands 25/10 (Q2); timing claims (housing positive YoY by Dec 2027 print; S&P low before Jul 2027 on a closed window; S&P new ATH by Dec 2028; S&P ≥10% drawdown); tech basket moved to the stock bet's dial set (Q3).
- P2.4 Migration: `bet_id` on `cycle_weight_moves`, `cycle_claims`, `cycle_tripwire_events`; `cycle_checkpoints` gains `bet_id` + `review_id`; drop the bear/base/bull check constraint or extend it; backfill existing rows as `housing`. `enable row level security` on anything new.
- P2.5 Review engine: `ReviewState.bets`, `checkProposal(bet)`, one Opus call per bet, shared Why/Next; mechanical claim resolution + daily early-falsifier check; cap notes in the prompt (count and chars); `read_as: 10d_avg` on sp500; `tripwire_at_or_below` for the −10% S&P tripwire.
- P2.6 Card: plain-English bullets derived from dial ids + band stats ("about 50% above a normal October (usual 1,100-1,530)"), reprobs spelled out, prompt forbids ids/z/ISO dates in `argument`/`opposite_case`; two weight lines; 4096-char guard.
- P2.7 New dials: NASDAQ (daily, stock bet); Zillow SFR levels for San Mateo / SF / Santa Cruz counties + Fremont city (one pass per file, display-only, peak stored); `zhvi_zip_*_level` for the owned zips; `scc_warn_workers_30d` (daily, display-only; note the 1-6 day lag on the row).

### Phase 3 — The page (target `mockups/full-page-v2.png`)
- P3.1 View-model layer in `lib/marketCycle/view.ts` (pure, tested): 12-month rollup per dial from the loaded window (last reading per month, nulls for gaps), arrow + colour from `good_when`, key-number ordering, group assignment, price-band table with "from <date>" placeholders until a prior week exists, zip/area "vs last year" + "vs peak".
- P3.2 Cards 1-2 (houses, stocks): question, Now line, timeline SVG (Oct 2026 → Dec 2028, solid low bar / outlined rebound bar from `low_window`/`rebound_window`), depth bars, footer.
- P3.3 Card 3 Dials: key numbers, price-band table, scroll box (`max-h-[60vh] overflow-y-auto overscroll-contain`, sticky group headers, no JS). Sparkline SVG with month letters.
- P3.4 Cards 4-5: My zip codes (from `cycle_owned_properties`, not the seed list) + Nearby markets.
- P3.5 Card 6 Reviews & odds moves: merged list across bets, newest expanded, "alarm fired" tag, web Disagree (`POST /api/cycle/note`, by-id `storeRyanNote`, small client form, `router.refresh()`); Details button removed from the page.
- P3.6 Claims, tripwires-pending and notes sections removed from the page; data loader parallelises the two readings chains.
- P3.7 Fixtures: 12+ months daily/weekly/monthly/quarterly rows, variant rows, two weeks of tiers, checkpoints with/without `checkpoint_id`, an auto-registered dial; `stateFromFixture` filters `variant=''`.

### Phase 4 — Verify, ship, document
- P4.1 `tsc --noEmit`, `next build`, vitest; Python tests for breaker/revisions/tripwire recency; `review.ts --dry-run --llm` on both bets; page rendered against production data on a preview deploy before merge.
- P4.2 Vercel deploy from `main`; launchd: load the hourly retry job, remove the 07:30 job, reload the two edited plists (no restart needed).
- P4.3 Thesis brief v1.2; PROJECT_MEMO + CHANGELOG; memory; this brief marked done.

## 7. Ryan's answers (Nov 7, 2026)

- **Q1 → Dec 21, 2026.** The shakedown follows the FOMC rule like every other review ("that's a pretty big piece of information"). No exemption.
- **Q2-Q5 → yes** to all recommendations.
- After the build: run the review on both bets and send Ryan the card as a **preview** (nothing written), then continue on the normal cadence.

### Original questions

| # | Question | My recommendation |
|---|---|---|
| Q1 | The new FOMC rule would slide the **Dec 14, 2026 shakedown to Dec 21** (Fed decision Dec 16). Keep Dec 14 as an exempt shakedown, or move it? | **Keep Dec 14.** It's a plumbing test, not a judgment call; the Fed outcome gets picked up by Jan 18. |
| Q2 | The S&P dial's existing bear line is −20%; the panel we agreed uses 25% / 10%. Align the dial's vote to 25%, or let it "lean bear" at −20 while the scenario band stays 25? | **Align everything to 25 / 10.** One number, fewer explanations. |
| Q3 | The Bay Area tech-stock basket currently votes in the **housing** bet. Move it to the stock bet's dial set and out of housing votes? | **Yes, move it.** It's a stock-market signal; the housing bet keeps rents, jobs and local tech employment. |
| Q4 | Let code resolve data-decidable claims (thresholds, drawdowns, dates) instead of Opus, with Opus judging only event claims? | **Yes.** Otherwise the scorecard isn't one. |
| Q5 | Run Phase 1 first, on its own, before the Dec 14 shakedown? It changes nothing you'd see except a WARN number correcting (Oct 463 → 569). | **Yes** — a wrong scorecard on Dec 14 would be worse than a late redesign. |
