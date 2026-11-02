# Market-cycle tracker — thesis v1.1 + scope of work

**Status:** v1.1 (audited). Awaiting Ryan's approval of the scope of work in Part 4. Nothing built.
**Written:** 2026-11-01 from chat Claude's Nov 1 thesis + fresh web checks; revised the same day after Ryan's review and a two-reader audit (26 findings, all resolved below).
**Purpose:** hold a written thesis about where the market cycle is, check it against new data on a schedule, and say clearly when reality drifts from it in either direction. Not a trading tool. Does not change flip underwriting.

Decisions from Ryan (2026-11-01): start from v1.1 weights · tripwire cards yes · free sources only · card stays about the cycle, no holdings line · geography = Santa Clara County core + Peninsula / SF / Santa Cruz / Fremont panels · owned-property registry, not hard-coded zips · 95118 (home) tracked for value · **quiet by default: no weekly card** · monthly review = Monday after CPI · shakedown Dec 14, 2026 · first formal review Jan 18, 2027 · quarterly rewrite Feb/May/Aug/Nov.

---

## Part 1 — Cross-examination of the Nov 1 thesis

### 1.1 What the web checks confirmed (as of Oct 30–Nov 1, 2026)

| Thesis data point | Check | Verdict |
|---|---|---|
| Fed funds 3.75–4.00 after a Sep hike; Oct 28 hold, two hawkish dissents; ~85% Dec hike priced | CNBC / Yahoo Oct 28 (Warsh chair) | Confirmed |
| 10-yr 5.36% on Oct 7 | CNBC: "just below 5%" late Oct; ~5.02–5.05% Oct 28 | Peak print unconfirmed; level ~5.0% confirmed |
| 30-yr mortgage 7.1–7.4% | MND 7.33%; peaked >7.6% early Oct | Confirmed |
| Brent ~$114, Hormuz shut, Qatari draft | Brent $117.64 Oct 30; strait shut since Feb 28; Qatar 7-day plan, Iran calls it unacceptable | Confirmed, slightly worse |
| CCC loan spreads widest since May 2009; private credit defaults 6.3% Fitch / 5.8% Moody's | PitchBook 2,449 bp (paywalled series); Fitch Q3 record 6.3%; Moody's 5.8% with PIK | Confirmed |
| Big-4 capex >$740B 2026; Alphabet negative FCF | April guidance $725B; Alphabet >$200B, FCF negative since Q2 | Approximately confirmed |
| SCC SFR median $1.92M, −4% YoY; inventory +21% YoY; price cuts +49% | C.A.R. Sep: $1.92M, −4.0% YoY, active listings +26.4% YoY. SCCAOR: $1.88M, −4%, **sales +3.7% YoY**, DOM 27 | Confirmed; sales volume is UP, which the thesis omits. "+49%" is a count change, not a share |
| SF median +17.4% YoY, 131% of list | Not re-checked; SF rents hit a record in late Oct (coverage ties it to AI hiring and IPO anticipation) | Unverified; a city median, mix-shift prone |
| Bay Area tech layoffs ~14,500 in 2026 | Q3 WARN: Bay Area 7,570 (+15% YoY) but **Santa Clara County 2,273 (−27% YoY)**; SF +141%, San Mateo +78% | Layoffs are shifting to SF, not rising in SCC |

**Taken from the thesis without independent check** (log as unverified until the first data pull): Q3 GDP 3.4%, Sep payrolls +29k, CPI 3.7%, forward P/E 18.7, CAPE 40.7. **My own approximations to verify when history loads:** SCC 2000–02 median decline (−10% to −15%), SCC 2022–23 decline (~$1.95M → ~$1.6M, about −18% in eight months), pre-2008 SCC NOD norm (150–300/month), months of supply ~1.5 (from 45 days of inventory; Phase 1 measured 1.69 SFR-only for Sep 2026), FAIR Plan +29.1% effective Oct 15.

### 1.2 What's weakest

1. **It is a conjunction sold as a base case.** Top is in (60%) → recession (50–55%) → credit breaks mid-2027 → Fed cuts late 2027 → SCC trough Q4 2027–Q2 2028. Each link is a coin flip and the housing call sits at the end of the chain. Multiplied through, the full bear path is nearer 25–35% than the ~60% the narrative implies. There is no "base" scenario at all. (v1.1 fixes this by defining the scenarios as a partition of one measurable outcome, §2.1, so they are exhaustive and the macro story is a description, not a requirement.)
2. **The SCC peak-to-trough is measured on a seasonal series.** SCC monthly medians fall 3–6% every year from May to December. "Peak $2.1M May → $1.92M Sep" is −8.6%, but roughly half of that is normal seasonality. The clean signal is −4% YoY. **A January review looking at December medians will see scary prints that are mostly seasonal.** v1.1 scores price on Zillow's seasonally adjusted county index (ZHVI) and uses the median only YoY.
3. **Wrong analog for South Bay housing.** 1973–74 says nothing about SCC houses. The two local precedents are **2000–02** (tech jobs −20%, county median down roughly 10–15% over two years) and **2022–23** (rate shock only, median down about 18% in eight months, new highs by 2024). The trough size in the thesis fits both; the *timing* does not. A 2022-style path puts the trough around Q1 2027, which is nearly now; a 2000-style path puts it in 2028. Which analog is running is the most important fork and is a scored claim (C17).
4. **"No forced selling" is true for 3%-mortgage owner-occupants and false for the marginal seller in SCC.** Bridge-loan flippers at 9–10% carry (that's us), RSU-dependent buyers who stretched in 2024–25, H-1B holders who lose a job and must leave or sell within the 60-day grace period, and trust/estate sales from an aging owner base. Small in count, but they set the marginal price in a thin market.
5. **The AI liquidity counter-current is under-weighted.** Anthropic filed its S-1 publicly Oct 26 (ticker ANT; coverage points to a mid/late-Nov listing and to a non-standard lockup with staged insider releases around days 27/48/62/76 — verify against the S-1). SpaceX's final lockup is reported for Dec 8–9 (unverified). OpenAI's confidential S-1 is in; its CFO points to 2027. The thesis treats SF +17% as the most fragile number, but the IPO calendar can *extend* it into H1 2027 and bid the Peninsula/South Bay top tier while the county median falls. And the 2000 analog requires the IPO window to slam shut: **if ANT prices and trades above issue, the 2000 analog is not yet running; if it is pulled or breaks issue, that is the strongest single bear confirmation available.**
6. **Local labor is not softening yet.** SCC unemployment 4.3% in Aug 2026 vs 4.7% a year earlier. SCC WARN workers −27% YoY in Q3. San Jose rents +8–10% YoY (Zumper, Apartment List). Rising rents with falling prices means price-to-rent is compressing, a floor-building signal. The thesis cites national payrolls and never looks at the county.
7. **Yield curve is positively sloped, not inverted** (2s10s about +38 bp at Oct 30; the 2-year at 4.6% prices more hikes). Not steep, as I first wrote, but not the inverted curve that preceded 2000 and 2007 either. 2000 and 2007 recessions were preceded by inversions. Hiking into a steep curve with GDP at 3.4% looks more like 1994 or 2022 than 2000. This belongs in the opposite case every month.
8. **Mortgage rate path ignores the spread.** 30-yr minus 10-yr is ~230 bp, against a ~170 bp norm. Spread compression alone is worth 30–60 bp with no move in Treasuries. v1.1 splits the claim (C9, C10, C11).
9. **"Inventory depleted by 2028" has no mechanism.** If prices fall and rates stay high, inventory does not deplete. Lock-in deepens only if rates fall. It is really the bull mechanism and is dated and scored as such (C32).
10. **SF +17% uses the wrong instrument.** It's a city median. Case-Shiller "San Francisco" is flat YoY through May 2026 (condos about −3%) and **excludes Santa Clara County** (it covers Alameda, Contra Costa, Marin, San Francisco, San Mateo). The SCC equivalents are ZHVI (monthly) and FHFA HPI for the San Jose MSA (quarterly).
11. **Structural demand headwind the thesis never names: immigration.** SCC's population is flat only because international inflow (~+18.7k/yr) offsets domestic outflow (~−13k to −20k/yr). The $100k H-1B fee (Sep 2025) has already cut petitions at Amazon, Google and Meta; DOF's 2026 estimate headline is "federal policy constricting legal international migration." Slow, but it is the one headwind that doesn't reverse with a rate cut.
12. **SCC's bear channel is the capex cut itself, not the Fed.** The county's employment is concentrated in the names that pay for or sell the AI build-out (Nvidia, AMD, Broadcom, Applied, Lam, KLA, Google, Apple, Meta next door). A 2027 capex cut hits SCC employers directly, which makes a local-employer equity basket and SCC WARN filings more informative than the S&P. That basket is split today: Alphabet about −30% from high, Meta about −21%, Nvidia −11 to −13%, Apple at a record. Mixed, not broken.
13. **Timing is stated with false precision.** "Bottom Q3–Q4 2027" and "Q4 2027–Q2 2028" are point calls on the end of a five-link chain. v1.1 states them as dated claims with probabilities and lets the monthly review move the probabilities.

### 1.3 What's missing (SCC-specific dials added in v1.1)

County unemployment and San Jose MSA tech vs healthcare payrolls; Indeed software postings for the SF Bay metro; WARN workers per month from EDD's workbook (2025 baseline available by fiscal year); San Jose rents and rent-to-price; Notices of Default (free count, baseline must be built); migration (DOF annual, USPS quarterly, H-1B petitions annual); the IPO/lockup calendar; a local employer equity basket; a price-tier split (Zillow publishes top- and bottom-tier ZHVI by county, which gives tier history for free); new listings and withdrawn share; months of supply; condo vs SFR; the mortgage spread; initial claims and the Sahm rule; FAIR Plan insurance (hills only); SB 79 transit upzoning (structural, quarterly only).

---

## Part 2 — Thesis v1.1

Edit marks: **[kept]** · **[reworded]** · **[prob]** · **[new]** · **[dropped]**. Audit fixes are marked **[audit]**.

### 2.1 Scenarios — a partition on one measurable outcome

The scored object is **Santa Clara County ZHVI, single-family only (seasonally adjusted), maximum drawdown from the reference peak (the series' all-time high as of the shakedown), measured on monthly prints through Dec 2028.** Condos and townhomes are never blended into a scored number; they get their own display-only view (Ryan 2026-11-01). On the single-family series the all-time high is **Jan 2025 at $1,776,795**; Sep 2026 is −3.4% from it, deepest so far −4.6% (Aug 2025). Same series history: 2022–23 −12.6%, 2018–19 −9.2%, 2007–11 −29.9%, which is why Base is −8 to −15 (a rate-shock magnitude) and Bear needs a jobs shock. (Realtor.com's county series exist only for all property types; they stay as a labelled cross-check. Condo ZHVI was −3.9% YoY in Sep 2026 against +0.9% for single-family.)

| Scenario | Defined by (SCC ZHVI max drawdown through Dec 2028) | Typical markers | Chat Claude implied | v1.1 weight |
|---|---|---|---|---|
| **Bear** — "2000 plus oil" | **−15% or worse** | S&P −25% or worse from the Oct 6 high; US recession starts in 2027; credit stays broken; mortgages ≥6.75% through mid-2027; IPO window closes (ANT pulled or below issue); trough in 2028 | ~60% | **35%** |
| **Base** — "2022 rate shock, slower exit" | **−8% to −15%** | S&P −10% to −24.9%, chops; no recession or a shallow one; Fed peaks 4.25–4.50 and holds; 10-yr 4.4–5.0; mortgages 6.5–7.0; trough H1–mid 2027, flat into 2028 | not defined | **45%** |
| **Bull** — "Iran deal + AI liquidity" | **shallower than −8%** | Hormuz reopens; Brent <$90 by Q2 2027; CPI ≤2.8% by mid-2027; Fed stops ≤4.25; 10-yr ≤4.3; mortgages ≤6.5 by Q3 2027; ANT and SpaceX money lands; trough Q4 2026–Q1 2027, positive YoY by Q4 2027 | 35–40% | **20%** |

**Weight move #0 (2026-11-01, chat Claude → v1.1): Bear 60 → 35, Base (new) 45, Bull 38 → 20.** *Bootstrap exception: no stored readings exist yet, so this row cites the §1.1 table instead of reading rows.* **[audit]**
Reason: (a) the bear path is a five-link conjunction; (b) local labor, rents, sales volume and months-of-supply are all inconsistent with a crash regime today; (c) a steep yield curve and ~18.7× forward P/E argue against the 2000 analog; (d) the IPO calendar is a live counter-current. Bull is cut because it needs a Hormuz deal Iran currently calls unacceptable *and* a Fed that stops hiking with CPI at 3.7%.
Opposite case: credit spreads at 2009 levels have never been noise; private-credit defaults at a record with a 2027–28 maturity wall; Alphabet −30% says the market has already begun punishing the build-out; the Fed is hiking into +29k payrolls, which is how soft landings end. If this move is wrong, it's because local data lags the credit cycle by two to three quarters.
What reverses it: any one tripwire among {two consecutive months of SCC WARN workers >50% YoY, ANT pulled or below issue, CCC OAS beyond its 2010–2025 maximum} moves Bear back above 50. (Tripwire checkpoints are exempt from the three-dial rule, §3.4.) **[audit]**

### 2.2 Claims (discrete, dated, scoreable)

Probabilities: chat Claude's → v1.1. "Resolves" is the first date the data can exist. Falsifier is the condition that scores it false. All housing-price claims use ZHVI unless stated. **[audit: dates and units fixed throughout]**

| # | Claim | Prob | Resolves | Falsifier / scoring rule | Mark |
|---|---|---|---|---|---|
| C1 | The S&P 500 closing high of Oct 6, 2026 (~7,800) stands as the cycle top through Jun 30, 2027 | 60 → 55 | 2027-06-30 | Any close above the Oct 6 high before the date | [kept, dated] |
| C2 | S&P 500 drawdown from the Oct 6 high reaches −25% or worse at some close before Dec 31, 2027 | ~60 → **40** | 2027-12-31 | Max drawdown stays shallower than −25% | [prob; audit: must exceed Bear weight] |
| C3 | S&P 500 drawdown reaches −45% before Dec 31, 2028 (the "2000–02" tail) | tail → 10 | 2028-12-31 | Never trades there | [reworded] |
| C4 | A US recession begins in calendar 2027 (NBER dating, or two consecutive negative real-GDP quarters starting in 2027) | 50–55 → 40 | **2028-09-30** | No recession start in 2027 | [prob; audit: date] |
| C5 | Fed raises the funds target at the Dec 16, 2026 meeting | ~85 (market) → 75 | 2026-12-16 | Hold or cut | [new, split out] |
| C6 | Fed funds peak for this cycle has an upper bound ≤4.50% | — → 70 | 2027-12-31 | Any hike above 4.50 | [new] |
| C7 | Fed's first cut comes between Sep 2027 and Mar 2028 | implied → 45 | 2028-03-31 | Earlier than Sep 2027 (bull) or later than Mar 2028 | [reworded, prob] |
| C8 | A named credit event before Jun 30, 2027: a private-credit fund or BDC with ≥$5B AUM gates redemptions or defaults, **or** Fitch's TTM leveraged-loan default rate ≥6%, **or** FRED's HY CCC-and-below OAS exceeds its 2010–2025 maximum | "something breaks" → 45 | 2027-06-30 | None of the three | [reworded; audit: defined] |
| C9 | Freddie Mac 30-yr average is ≥6.75% every week through Jun 30, 2027 | "7%+" → 45 | 2027-06-30 | Any weekly print <6.75 | [reworded, prob] |
| C10 | 10-yr Treasury closes below 4.30% before Jun 30, 2027 | — → 30 | 2027-06-30 | Never closes below 4.30 | [new; the bull pivot] |
| C11 | Mortgage spread (Freddie 30-yr minus 10-yr, weekly) prints below 180 bp before Dec 31, 2027 | — → 50 | 2027-12-31 | Stays ≥180 | [new] |
| C12 | Brent closes below $90 before **Jun 30, 2027** | implied bull → **40** | 2027-06-30 | Never closes <$90 | [new; audit: aligned to Bull's Q2] |
| C13 | US CPI YoY prints ≤2.8% for any month Jan–Jun 2027 | bull → 30 | 2027-07-15 | No print ≤2.8 | [new] |
| C14 | Case-Shiller US national (NSA) nominal peak-to-trough is −3% or worse by the Dec 2028 print | implied → 55 | 2029-02-28 | Shallower than −3% | [reworded] |
| C15 | SCC ZHVI drawdown from the 2026 peak reaches **−10% or worse at any monthly print through Dec 2027** | implied ~60 → **55** | 2028-02-15 | Never −10 | [reworded; audit: unit + prob] |
| C16 | SCC ZHVI drawdown reaches **−15% or worse at any print through Dec 2028** (the thesis's "trough $1.65–1.80M") | implied ~60 → **35** | 2029-02-15 | Never −15 | [prob; audit: = Bear weight by construction] |
| C17 | The lowest SCC ZHVI print through Dec 2027 occurs in Nov 2026–Jun 2027 **and** the Dec 2027 print is above it (the 2022 analog) | — → **40** | 2028-02-15 | Low after Jun 2027, or Dec 2027 not above it | [new; audit: defined on a closed window] |
| C18 | Realtor.com active listing count for SCC (FRED, monthly) for Mar 2027 is ≥25% above Mar 2026 | — → 55 | 2027-04-30 | <25% YoY | [new; audit: source with history] |
| C19 | SCC single-family months of supply (SCCAOR SFR inventory ÷ SCCAOR SFR closed sales) exceeds 3.0 in any month of 2027 | — → 30 | 2028-01-31 | Never >3.0 | [new] |
| C20 | SCC price-reduced share (Realtor.com price-reduced count ÷ active count, monthly) exceeds its 2016–2025 maximum in any month Feb–May 2027 | — → 40 | 2027-06-30 | Never exceeds | [new; audit: threshold defined by history, not a guessed 40%] |
| C21 | C.A.R. SCC SFR closed sales for Mar–May 2027 total below Mar–May 2026 | — → 50 | 2027-06-30 | Spring 2027 ≥ spring 2026 | [new; volume leads price] |
| C22 | SCC Notices of Default in any calendar month of 2027 are ≥2× the average of the first three months we count (Dec 2026–Feb 2027) | — → 25 | 2028-01-31 | Never 2× | [new; **provisional** until a 2025 baseline is sourced] |
| C23 | SCC WARN-affected workers for any quarter of 2027 are ≥1.5× the same quarter of 2026 (EDD workbook) | — → 40 | 2028-01-31 | Never 1.5× | [new] |
| C24 | SCC unemployment rate (LAUS, NSA) prints ≥5.5% for any month of 2027 | — → 30 | 2028-01-31 | Never ≥5.5 | [new] |
| C25 | San Jose asking-rent YoY (Apartment List) is ≤0% for any month of 2027 | — → 35 | 2028-01-31 | Stays positive | [new] |
| C26 | C.A.R. San Francisco County SFR median YoY is ≤0% for any month Nov 2026–Nov 2027 | "negative within 12 months" → 45 | 2027-12-20 | Never ≤0 | [reworded; audit: series named] |
| C27 | Anthropic prices its IPO before Dec 31, 2026 **and** closes above the issue price on day 1 | — → 60 | 2026-12-31 | Pulled/postponed, or closes below issue | [new; the 2000-analog tripwire] |
| C28 | At least one of Microsoft, Alphabet, Amazon, Meta guides 2027 capex below 2026 actual by Feb 28, 2027. For a firm without a numeric annual guide, use the first-reported 2027 consensus after its Q4 call | "punishing capex" → 25 | 2027-02-28 | All four flat or up | [reworded; audit: no-guide rule] |
| C29 | Combined 2027 capex (guidance or consensus as above) for the four is ≥10% above 2026 actual | — → 55 | 2027-02-28 | <10% growth | [new; not a complement of C28] |
| C30 | Equal-weight local employer index (NVDA, AAPL, GOOGL, META, AVGO, AMD, AMAT, LRCX, KLAC, INTC, CSCO; rebalanced monthly) closes ≥30% below its 52-week high before Dec 31, 2027 | — → 35 | 2027-12-31 | Never −30 | [new; audit: index drawdown, not mean of names] |
| C31 | Zillow **top-tier** ZHVI for SCC is positive YoY in Jun 2027 while **bottom-tier** ZHVI is negative YoY (IPO money bids the top) | — → 35 | 2027-08-15 | Both same sign | [new; audit: tier source with history] |
| C32 | SCC ZHVI YoY ≥ +5% for any month of 2028 ("next boom 2028–29") | implied → 35 | 2029-02-15 | Never ≥+5 | [reworded, dated] |
| — | "Analog: 2000 plus 1973–74" | | | | [dropped as a claim; label only] |
| — | "Mid-5s mortgages by 2029" | | | | [dropped; outside horizon; revisit at a 2027 rewrite] |
| — | "Midterms ~94% Dem House" | | | | [dropped; no housing mechanism; log result as context] |

**Scoring.** Brier score per claim, computed twice: on the probability held at the last monthly checkpoint before resolution (the "live" score) and on the v1.1 initial probability (did updating help?). Running mean by category (macro / rates / SCC housing / AI-liquidity). Claim **text** changes only at quarterly rewrites; claim **probabilities** may be updated at any monthly checkpoint, each update logged like a weight move. **[audit]**

### 2.3 Narrative (short, for humans — the claims are the thesis)

Late cycle, yes. But the honest base case for Santa Clara County is a rate-shock grind (the 2022 pattern with a slower exit), not a 2000-style unwind: local jobs, rents, sales volume and supply are still in a seller's-market regime, the yield curve is steep, and a wave of AI-IPO liquidity is about to land in the region. The bear case is real and is driven by credit (spreads at 2009 levels, private-credit defaults at a record, a 2027–28 maturity wall) and by the possibility that the hyperscalers cut 2027 capex, which hits SCC employers directly. The bull case needs an Iran deal Tehran is currently rejecting. The three cleanest early tells, in order: ANT's pricing and first weeks of trading (Nov–Dec), the Jan–Feb capex guidance, and whether SCC spring 2027 sales volume beats spring 2026.

---

## Part 3 — Tracker design (abstract; nothing built)

### 3.1 What it stores

Claims and scenario definitions are a versioned config file in the repo (git history is the version log; each quarterly rewrite is a new version). Readings, checkpoints and the weight-move log live in the LRG Supabase like every other Mission Control artifact.

1. **Thesis versions** — scenarios + claims with version, date, author. Each claim: text, initial probability, current probability, resolve-by date, falsifier, category, scenario tag, resolution (true/false/void), resolved date, both Brier scores.
2. **Dial registry + readings** — one row per dial (name, cadence, source, fetch method, units, which scenario an up-move and a down-move favor, its band rule). One append-only row per reading (dial, as-of date, value, source URL, raw snippet).
3. **Checkpoints** — one row per review (date, type monthly/quarterly/tripwire/shakedown, weights before/after, dials that voted, argument, opposite case, claims resolved or re-probabilised, next dates, Telegram message id, Ryan's "Disagree" note if any).
4. **Weight-move log** — the artifact. Every change to the three weights: date, from → to, the readings cited, the argument, the opposite case, "what would reverse this." No weight moves without a row; a row cites at least two readings (move #0 excepted as bootstrap).
5. **Owned-property registry** — address, zip, flag (for sale / held / home), bought, listed, sold. Maintained by the inbox agent's settlement-statement filing (buyer statement adds, seller statement retires; listing agreement or MLS hit marks on-market) with a one-line Telegram fallback. Adds and retires are shown on the next card for correction, no tap required.
6. **Data calendar** — scheduled releases, each tagged with the dial it feeds. Known now: Nov 6 jobs · Nov 10 CPI · Nov 24 Case-Shiller (Sep) · Nov 25 PCE · Dec 4 jobs · Dec 10 CPI · Dec 16 FOMC · SpaceX lockup ~Dec 8–9 (TBC) · ANT pricing (TBD) · Jan 8 jobs · ~Jan 13 CPI · FOMC Jan 26–27 (tentative) · late Jan–early Feb hyperscaler Q4 calls. The Fed's and BLS's full 2027 calendars are loaded at build.

### 3.2 What it watches

**Weekly, local (Monday 06:00, deterministic script, no LLM).** Source for MLS dials is the MLSListings public search we already fetch over plain HTTP. For **Santa Clara County (scored)** and the **panels (San Mateo County, San Francisco split houses/condos, Santa Cruz County, Fremont)**: active SFR count, pending + active-under-contract count (→ pending ratio), new listings last 7 days, median days on site of actives, price-cut share (we store every active listing's price weekly and detect cuts ourselves), withdrawn/relist share, list-to-sale ratio on the week's recently-sold cards. SCC additionally by price tier (<$1.3M / $1.3–2M / $2–3M / $3M+). **Owned-property zips** (from the registry; 95118 permanently): actives, days on site, cut share, 90-day sold $/sf, plus a rough value for the home from its square footage against similar-size solds. SF/Fremont coverage through the MLSListings data share is verified at build; fall back to C.A.R.'s monthly county tables if thin. NODs: a free county count weekly to build a baseline. Listed properties: showings, offers, feedback from the Pile (Amanda's texts) and showing emails.

**Monthly macro (FRED keyless CSV endpoint for nearly all of it).** CPI and core, PCE, payrolls and unemployment, initial claims 4-week average and the Sahm gap, Fed funds target, 10-yr, Freddie 30-yr, the mortgage spread, 2s10s slope, Brent, **HY CCC-and-below OAS (BAMLH0A3HYC — the one credit-spread series used for thresholds; PitchBook's loan spread is paywalled and only quoted as context)**, Case-Shiller national and SF-metro (labelled "not SCC"), Realtor.com SCC series (active count, new listings, median DOM, pending ratio, price-reduced count — history to 2016, used for bands and for C18–C20), Zillow ZHVI for SCC all-homes plus top- and bottom-tier (free CSV, history to 2000), Zillow ZHVI by zip for owned zips and 95118, SCC unemployment (LAUS), SCC WARN workers (EDD workbook, 2025 baseline from the FY files), Indeed software postings for the SF Bay metro, San Jose rents (Apartment List CSV). Fitch's private-credit and leveraged-loan default rates and Moody's PIK-adjusted figure are quarterly web fetches of the press releases. The local employer basket is a daily free quote pull, summarised monthly.

**Quarterly, structural (LLM-assisted research at the rewrite).** Big-4 2027 capex guidance, CAPE and forward P/E, S&P EPS revisions, FHFA HPI for the San Jose MSA, DOF population/migration and USPS net flows, H-1B petition counts, IPO/lockup calendar refresh, FAIR Plan / insurance, SB 79 or other land-value policy.

**Event dials (binary, resolve claims directly).** FOMC decisions, ANT pricing / day-1 close / staged releases, SpaceX lockup, Hormuz status, named credit events, midterm result (context only).

### 3.3 Cadence and where each job runs

| Job | When | Where | LLM? | Ryan sees |
|---|---|---|---|---|
| Weekly collector (local + owned zips + listed-property status) | Mon 06:00 | Mac mini launchd script → Supabase | No | Nothing, unless a tripwire fires |
| Macro collector | Daily pull; evaluated at checkpoints | Same script | No | Nothing |
| Scheduled-release notes | On each calendar date | Script | No | Nothing; stored and surfaced in the monthly card |
| **Shakedown** | **Mon Dec 14, 2026** | Scheduled cloud session (same mechanism as the nightly memory routine) via lib/llm | Yes | A real card, labelled shakedown; format fixes before Jan |
| **Monthly checkpoint** | **Monday after the CPI release (12th–21st); first formal: Mon Jan 18, 2027** | Same | Yes (Opus-class) | The one-screen card |
| **Quarterly rewrite** | The **Feb / May / Aug / Nov** checkpoint (after earnings season; first: mid-Feb 2027, after 2027 capex guidance) | Same, longer | Yes | Card + calibration scorecard + new thesis version in briefs/ |
| Tripwire checkpoint | When a big tripwire fires | Same, out of cycle | Yes | 3-line tripwire card, then an out-of-cycle card |

What is in hand at a mid-month checkpoint: the prior month's jobs, CPI, C.A.R./SCCAOR sales reports and our own weekly series; the most recent Case-Shiller (two-month lag) and the most recent FOMC. **[audit: earlier text overstated this]**

### 3.4 Drift vs noise

Three tests before a dial may vote:

1. **Outside its band.** Dials with history (Realtor.com SCC series, ZHVI, LAUS, WARN, rents, FRED macro) use a seasonal norm: same month over the prior 4–5 years, band = norm ± 1σ. **Self-collected dials (weekly MLS counts, tiers, panels, owned zips, NODs) have no history until late 2027; until then they use scenario corridors only and are cross-checked against the Realtor.com monthly series.** **[audit]** Market dials (10-yr, mortgage, Brent, CCC OAS, basket) use corridors written in the registry and read as 10-day averages, never one print. Corridor numbers are set at the shakedown from each series' own history (e.g. Bear corridor for CCC OAS = beyond its 2010–2025 maximum).
2. **Persistent.** Two consecutive readings outside the band, or one beyond 2σ. A single week never moves anything.
3. **Directional and scenario-consistent.** The registry says which scenario an out-of-band move favors. A move no scenario predicts is logged "unexplained" and becomes an opposite-case item, not a vote.

**Votes to weights.** At a monthly checkpoint, votes are tallied by category (local housing, local labor, rates, credit, equities/AI, oil/inflation, events). Weights move only when ≥3 dials from ≥2 categories vote the same way, **or** a claim resolves, **or** a tripwire has fired (a fired tripwire counts as a qualifying vote on its own). Cap: 15 points per monthly checkpoint; 25 when a claim resolves or a tripwire fired. A move whose log row cites fewer than two readings or has an empty opposite case is rejected by rule. The opposite case is written against the *new* weights with the *same* month's data and must name the strongest reading that disagrees.

**Tripwires.** Pure thresholds, no judgment.

*Big (fire an out-of-cycle review):*
- ANT pulled, postponed past Dec 31, or closes below issue on day 1.
- FRED HY CCC OAS beyond its 2010–2025 maximum on a two-day close.
- Hormuz reopens or a US–Iran deal is signed.
- Inter-meeting Fed action.
- SCC active SFR count (our weekly series) above +40% YoY **or** below 0% YoY for two consecutive weeks — YoY computed against the Realtor.com monthly series until our own history exists. (±30% was dropped: the current reading is already +26%.)
- SCC price-reduced share above its Realtor.com 2016–2025 maximum for two consecutive weeks (placeholder "40%" dropped; the real number is set from history at the shakedown).
- SCC WARN workers in a month above 2× the 2025 monthly average.
- Any claim's falsifier (or truth condition) fires early.

*Posted to Ryan, no review, no vote:* one of his listed properties gets an offer or a price cut, or crosses a day-on-market checkpoint.

*Silent (stored, surfaced in the monthly card):* a scheduled release landing far from consensus; a panel geography crossing a line SCC hasn't. **[Ryan: "quieter the better."]**

**Listed properties and the home.** Not dials. Logged as ground truth with low weight; the review may cite them in the opposite case, never as a vote. 95118 value shows on the details page only.

**Calibration.** Both Brier scores per claim; at each quarterly rewrite a short table: mean by category, the five biggest surprises, and whether weights were leaning the right way *before* the data confirmed (early and right, or late and right).

### 3.5 Output (phone-first, one screen)

One Telegram message from the Marketing bot (same channel as the lead-status digest), HTML, about 12 lines. Example for the first formal review (illustrative numbers):

```
📊 Market cycle — Jan 18, 2027 checkpoint
Bear 35 → 40 · Base 45 → 45 · Bull 20 → 15

Moved
• CCC OAS past its 2010–25 high, 2nd week (credit → bear)
• SCC actives +42% YoY, 2 weeks (local housing → bear)
• SCC WARN Dec 2.1× 2025 avg (local labor → bear)
• ANT −18% vs issue after day-48 release (AI → bear)
Why: three categories agree and a tripwire fired; the IPO
window is wobbling, which puts the 2000 analog back in play.
Opposite case: rents +7%, curve still steep, Dec sales +2% YoY.
If the Jan 27 Fed holds and ANT recovers issue, this reverses.
Resolved: C5 Fed hiked Dec 16 ✅ (we said 75). C27 ANT ✅ (60).
Next: Jan 27 FOMC · Jan 28–Feb 5 capex calls · Feb 10 CPI
[Details]  [Disagree]
```

Four same-direction votes from four categories plus a tripwire; Bull cut because the bull-tagged dial (ANT) voted bear. **[audit: the earlier example broke the rules]**

"Details" opens `/cycle` in Mission Control: current weights, the weight-move log newest first, the claims table with status and scores, dial sparklines, panels and owned zips, the 95118 line. "Disagree" is a force-reply stored on the checkpoint and shown at the next review. The quarterly card adds a link to the new thesis version and the calibration table. Tripwire card: three lines (what crossed, the reading, "out-of-cycle review within 24h").

### 3.6 How it plugs into the stack

- Supabase: new tables (claims/versions, dials, readings, checkpoints, weight_moves, owned_properties, calendar), RLS enabled in the migration. Migration + first writes from a bridge session need Ryan's mode flip.
- Weekly collector: script in `scripts/`, launchd on the mini like the campaign and drip engines, Supabase direct; reuses the MLSListings fetch (bare street rule, pagination).
- Review sessions: scheduled tasks in the claude-code-remote environment (like the nightly memory pickup); read Supabase, research, call Opus via `lib/llm.ts` with a claims-aware prompt that forces the opposite-case field, write rows, post the card through the Marketing-bot sender.
- Phone page: `/cycle` route, same auth, dark palette rules.
- Thesis file: `config/market-cycle/thesis.v1.1.json` generated from Part 2; this brief stays the human copy.
- Project tracking: new memo folder `../market-cycle-tracker/` (new project per MEMO_INDEX).

### 3.7 Comps context for agents

When an agent pulls comps for a flip (`scripts/comps.py`, pocket comps, Redfin/Zillow in Chrome), it may add a short, clearly labelled macro block for the property's zip and price. **Context, never a substitute for comps:** it never adjusts a comp, sets a price or changes an underwriting number, and a deal write-up quotes it under its own heading.

- **Command (Mac mini or any checkout with `.env.local`):** `python3 scripts/market-cycle/cycle-context.py --zip 95123 --price 1150000 [--exit-month 2027-04]`. Reads Supabase over PostgREST (GET only). `--fixture <json>` renders from a file instead; `--json` prints `{lines, text}`.
- **Route (cloud agents):** `GET /api/cycle/context?zip=95123&price=1150000[&exit_month=2027-04]` → `{ok, label, zip, price, exit_month, as_of, lines, text}`. Same session-cookie auth as every non-webhook route; reads only. Same block as the script (`lib/cycleContext.ts` is a line-for-line port; a unit test renders one fixture through both).
- **What it prints (≤10 lines), headed "MACRO CONTEXT (market-cycle tracker) — context, not comps":** current weights and where SCC ZHVI's max drawdown sits in the partition; county ZHVI YoY, actives YoY, median days on site, price-cut share, list-to-sale; the price tier (thesis tiers) and the zip: actives, days on site, cut share, 90-day sold $/sf when stored; stale-comp drift (zip ZHVI change over the last 60 and 90 days — "a comp sold 90 days ago: index moved X% since"; falls back to the county index, labelled, until zip ZHVI levels are stored); with an exit month, each scenario's implied move by then; the last checkpoint's one-line read and the next checkpoint date.
- **Exit framing is an approximation, said so in the line:** straight line from today's county drawdown to the midpoint of each scenario's band by its typical trough (Bull 2027-01, Base 2027-05, Bear 2028-06; Bear's band floor = the series' 2007–11 −29.9% (single-family), Bull's ceiling = the deepest drawdown so far), flat after; the tier is assumed to follow the county.
- **Missing data says "n/a (no reading yet)"**, never a number. Before the Phase 1 collectors run, most MLS lines are n/a; that is expected.

---

## Part 4 — Scope of work (for approval)

**Phase 0 — Foundations.** Thesis config file from Part 2 (scenarios, 32 claims, dial registry with corridors and band rules, data calendar). Supabase migration for the seven tables. Owned-property registry seeded with Halleck (for sale), Quito (for sale), 95118 home (home). History bootstrap: Realtor.com SCC series 2016→, ZHVI SCC all/top/bottom tiers and the owned zips, LAUS, EDD WARN FY2024–25 and FY2025–26 (2025 baseline), Apartment List, FRED macro, basket prices 12 months; corridor numbers computed from that history and written into the registry. *Needs from Ryan: one mode-flip tap for the migration.*

**Phase 1 — Collectors + tripwires.** Weekly MLSListings collector for SCC (+tiers), the four panels, owned zips; price-cut detection by stored list prices; NOD weekly count; listed-property status from the Pile. Daily macro and basket pull. Tripwire engine (thresholds only) posting the 3-line card and scheduling the out-of-cycle review. Inbox-agent hook for the registry + Telegram fallback. Verification: first two weekly pulls cross-checked against C.A.R./SCCAOR/Realtor.com for the same period; mismatches explained before anything is trusted. *Needs from Ryan: nothing.*

**Phase 2 — Review + card + page.** Monthly/quarterly/tripwire review routine (scheduled task), Opus prompt with structured output (votes, proposed move, opposite case, claim resolutions and re-probabilisations), hard rules enforced in code (3-dial rule, caps, two-readings rule, non-empty opposite case), card sender, `/cycle` page, Disagree handler. Verification: a dry run against stored readings produces a card that obeys every rule, reviewed by me before it posts. *Needs from Ryan: nothing.*

**Phase 3 — Shakedown, Mon Dec 14, 2026.** First real card to Ryan's Telegram. Format and content fixes. Memo folder created, wrap. *Needs from Ryan: read it, hit Disagree if anything is off.*

**Phase 4 — First formal review, Mon Jan 18, 2027.** Then monthly on the Monday after CPI. **Phase 5 — First quarterly rewrite, mid-Feb 2027**, with the first calibration table (C5, C27 and any early resolutions).

**Out of scope:** anything about Ryan's stock holdings; underwriting or price recommendations for live flips; paid data (PropertyRadar, ATTOM, PitchBook); a dashboard beyond the one `/cycle` page; weekly cards.

**Phase 0 findings (2026-11-01).** 43 of 46 history dials load from free sources. C.A.R.'s spreadsheets are behind a login, so C19/C21/C26 read the public C.A.R. monthly news-release pages and the SCCAOR stats page instead. FRED serves the CCC OAS only from Oct 2023, so the credit tripwire is a manual seed at 20% (the 2016/2020 closes per published charts, unverified) with the bear corridor at 15%; latest 13.25%. Price-reduced share 2016–25 max = 58.5% (Nov 2018), latest 31.2%. WARN 2025 monthly average 794 → tripwire 1,588. Local employer basket already −20.5% from its Jun 30 high. Realtor.com SCC actives, pending ratio and price-reduced count are all outside their seasonal bands on the bear side as of Sep. Macro level/YoY dials use authored corridors, not seasonal bands (a 2021–25 seasonal band on CPI is contaminated by the inflation spike).

**Open risks.** SF/Fremont coverage via MLSListings unverified; NOD baseline weak (C22 provisional); Fitch/Moody's figures depend on press-release availability; the auto-mode classifier may refuse prod writes from scheduled sessions (route writes through a Vercel endpoint if so).
