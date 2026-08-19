# Brief — Deal Outcome Analysis (pitched properties → what actually happened)

**Created:** 2026-08-19
**Status:** Scope locked, data source TBD
**Owner:** lead-pipeline (adjacent) — analysis artifact, not a Mission Control feature

---

## Objective

For every property an agent or wholesaler pitched to Ryan in 2024–2025,
determine what actually happened to it, and whether passing on it was the
right call.

---

## Universe

- **396 properties** — 2024–2025, from the `Deal Flow` set
  (`inbound_pitch` + `negotiated` only).
- Excludes: Ryan's own outbound prospecting, CRMS `NEW LEAD` alerts,
  his own projects (93 Ridgeview), logistics mentions.
- Source: `~/Projects/PROJECTS/deal-analysis/property_addresses.xlsx`,
  built from `iphone_sms.db` (2017-12 → 2026-04) + live `chat.db`.

### Address quality (measured 2026-08-19)

| | count |
|---|---|
| Total 2024–2025 deal flow | 396 |
| Junk rows to purge | 9 |
| Has city or zip (lookup-ready) | 328 |
| Has neither (city recoverable from message text) | 68 |
| Has a stated ask | 127 |

---

## Data model — three prices

| Field | Source | Meaning |
|---|---|---|
| `ask` | iMessage | What the agent pitched it at |
| `sale1_price` / `sale1_date` | Public record | What it negotiated to |
| `sale2_price` / `sale2_date` | Public record | The resale, if any |

### Derived

- `negotiation_delta` = `ask − sale1_price` — how inflated asks run
- `gross_spread` = `sale2_price − sale1_price` — flip margin
- `days_held` = `sale2_date − sale1_date` — reported, not a classifier

---

## Categories

| # | Category | Rule |
|---|---|---|
| 1 | `NEVER_SOLD` | no sale after pitch date, **OR** last recorded sale >5 years ago |
| 2 | `SOLD_HELD` | `sale1` exists, no `sale2` — end user bought it |
| 3 | `DEVELOPMENT` | `gross_spread` **> $500,000** — teardown/rebuild |
| 4 | `FLIP` | `gross_spread` **≤ $500,000** |

Per Ryan 2026-08-19: price delta alone splits 3 from 4. Square footage
comparison explicitly out of scope — too much complexity for now.

---

## Definitions & edge cases

0. **Unsearchable addresses are dropped, not researched.** Missing street
   number or missing street name = disregard. Ryan 2026-08-19.
1. **`sale1` = the FIRST arms-length sale with a date AFTER `pitch_date`.**
   A sale predating the pitch is prior history, not an outcome.
1a. **The >5-year rule.** If the most recent recorded sale is more than 5
   years before the pitch date, treat the property as `NEVER_SOLD`. Ryan
   2026-08-19. This resolves the "absence of evidence" problem by decision
   rather than by data: a 1993 or 2002 last-sale means it never traded.
2. **`sale2` = the NEXT arms-length sale after `sale1`.** If a third sale
   exists, record it in a notes column and flag; do not silently drop.
3. **Arms-length filter is mandatory.** County deed data includes $0 and
   nominal-value transfers — trust transfers, family transfers, quitclaims,
   refinance-related records. These are NOT sales and will produce fake
   $0 spreads. Filter on consideration > $10,000 and deed type.
4. **`NEVER_SOLD` still carries a confidence flag.** The >5-year rule
   decides the classification, but rows resolved from a source with no
   off-market coverage get flagged so the headline number is readable.
5. **Fast large-delta resales are not teardowns.** A `sale2` under ~6 months
   with a >$500K jump is an assignment or double-close being recorded, not
   a rebuild. The `days_held` column makes these visible; flag, don't
   reclassify.

---

## Outputs

1. **Per-property sheet** — address, city, zip, pitch_date, source phone,
   ask, sale1, sale2, both deltas, days_held, category, confidence.
2. **Summary stats** — % that sold, mean/median negotiation delta,
   category distribution, gross-spread distribution.
3. **Source scorecard** — outcomes rolled up per pitching agent. Answers
   "which of my agent relationships actually brings deals worth doing."
4. **Biggest misses** — largest `gross_spread` where Ryan passed.

---

## Prerequisites

- [ ] Purge the 9 junk rows.
- [ ] Expand the city gazetteer (Atherton, Scott's Valley apostrophe form,
      San Jose neighborhood names like Almaden) to recover the 68 rows
      lacking city/zip.
- [ ] Fix multi-property ask extraction — messages listing several
      addresses assign one price by proximity, which is wrong. Measured at
      ~18% of asks in the pilot sample. Affects `negotiation_delta` only;
      no longer blocks the run.
- [ ] **Choose data source — must be free/cheap.** Ryan 2026-08-19: paid
      APIs are out; he has existing channels.

### Source testing results (2026-08-19, empirical)

| Source | Works? | Notes |
|---|---|---|
| WebSearch | Partial | ~36% hit. Surfaces STALE last-sale (1993/2002) over recent |
| MLSListings.com property page | **YES** | Accurate sold price. Needs MLS# → 2-stage: search then fetch |
| MLSListings browse-by-zip | No | Only last ~1 day of sales. Not a bulk path |
| Redfin direct fetch | No | HTTP 403 |
| Brokerage sites (Sotheby's/Compass) | No | JS-rendered, WebFetch returns empty |

### County distribution of the 396

| County | count | share |
|---|---|---|
| Santa Clara | 206 | 52% |
| (no city — recoverable) | 92 | 23% |
| San Mateo | 35 | 9% |
| Alameda | 30 | 8% |
| Santa Cruz | 16 | 4% |
| San Francisco | 12 | 3% |
| Contra Costa | 4 | 1% |

Santa Clara + San Mateo = 241 (61%) — exactly MLSListings.com's coverage.

---

## Pilot results (2026-08-19, n=11, search-based)

| Property | Ask | Sold | Δ |
|---|---|---|---|
| 4466 Crocus Dr, San Jose | $1,699,888 | $1,925,045 (2024-10-21) | +$225,157 |
| 358 El Camino Del Mar, SF | $5,450,000 | $5,565,000 (2025-03-21) | +$115,000 |
| 1475 Shafter Ave, SF | $650,000 | $600,000 (2025-08-25) | −$50,000 |
| 2472 Karen Dr, Santa Clara | $5,100,000 | $4,980,000 (package) | −$120,000 |

7 of 11 returned no usable sale. Failure mode: search surfaces the stale
last-recorded sale (1993, 2002) rather than the recent transaction.
