# BRIEF — Mailer credit rule: "the last campaign they were part of"

**Status:** v2 FINAL (2026-11-09). Audited twice (code paths; scenarios
against prod data). D1–D3 answered. Nothing built — awaiting Ryan's go
(he will switch the session to Opus first).
**Owning project:** `../lead-pipeline/` (Leads tab → Campaign Performance).

## Why now

A "Got a letter from me?" video is going on lrghomes.com. It tells letter
readers to "call the number on the screen" — the **website number**
(650-670-3914), not the number on their letter. Those people must still
count as responses to the letter they got. Must ship before the video.

## The rule (Ryan, 2026-11-09)

- R1. Anyone who matches a **mailed** record is a **mailer lead**, not a
  website lead — website form, website number, or an old campaign's line.
- R2. Credit goes to **the last campaign they were part of**.
- R3. Credit can change over time. An old campaign **keeps its
  statistic**; the person's **tag switches** to the newer campaign.
- R4. No per-address arrival-date logic ("people call before the seed
  hits my mailbox").
- R5. Keep the **door** visible so the video's effect can be measured.
- R6. "Already in the database, calls back from an old campaign" (the
  Quito seller pattern) → the most recent campaign gets the credit.

## Today (verified against code + prod, 2026-11-09)

- One list in `mail_records`: NOO Q4 2026 — 28,205 rows; 16,276 assigned
  to a mail arm (pieces A 8,140 / B 8,136, batches 1–4); 11,925
  `arm='none'` (on the list, never mailed); 4 seeds.
  `mail_records.drop_date` is null everywhere; `arrived_at` only batch 1
  (2026-11-03); `campaigns.drop_date` for Q4 is 2026-10-08 = list-build
  day, not a mail date.
- Top line (`app/api/campaigns/performance/route.ts`) counts people by
  `leads.campaign_id`. Segments + Timing (`mail_segment_funnel`,
  `mail_response_timing*`) count by **record link** on any row, any date,
  any direction. Q4 today: top line 15 / segments 10 / 11 people linked.
- Credit by door:
  - Letter's own line or alias → credited by the dialed line
    (`SOURCE_OVERRIDE_NUMBERS`, `campaigns.source_label`).
  - Website **form** → linked across all lists; credited at form intake
    and manual link only (`creditWebsiteFormToMailCampaign`), with **no
    mailed-only guard** (an `arm='none'` match credits the parent).
  - Website **number** → linked once an address is known; **never
    credited** (unless the caller's latest inbound row already carries a
    Q4 label).
  - Callback number / Legacy DM rows with no campaign → search is
    unscoped, exact match only; linked, not credited.
  - Rows inheriting an MFM label → search scoped to MFM (no list) → never
    meet the Q4 list.
- City-mishearing correction, sound-alike matching and the "couldn't place
  this address" alert only run when the row has a campaign scope
  (`lib/mailMatch.ts:325, 335, 510`). Of 9 Q4 people linked from a call /
  text / email, 3 needed sound-alike and 1 a manual pick — on the website
  number those four would have silently stayed "Website".
- The address is usually learned on **Ryan's callback** or typed on the
  card: 5 of the 8 people who ever used the website number gave no address
  on any inbound contact.
- `source` drives live behaviour: sending mailbox + Gmail thread sync
  (`send-email/route.ts:114-119`, `sync-email/route.ts:53`,
  `lib/reply/context.ts:126`), Apply-Drip cadence
  (`lib/drip-campaigns.ts:111-123`), autopilot wording
  (`scripts/autopilot.js:90`), AI prompts. `source_type` is **inherited**
  for returning callers, so it is not the door.
- Card main chip = `campaign_label || source` of the most recent inbound
  row; 88 rows / 71 people carry a hand `campaign_label` that pins it.
- People: Maryam Norton (5122 Severance Ct) credited Q4-B via her form row
  only; her 6 inbound website-number rows are uncredited. Paul Bates (4231
  Santa Susana Way) is an MFM-A May 2026 lead on the Q4 list (batch 4,
  piece B), unlinked — the live R6 example. Nobody is in two campaign
  families. Closes: 2116 Quito (Feb 2026 SVR, hand-attached), 674 Kirkland
  (Feb 2025 MFM1, closed before its only credited row), 93 Ridgeview (no
  campaign).

## Design (settled by the audits)

1. **Credit = `campaign_id` + new `campaign_via`. `source` and
   `source_type` are never rewritten.** `campaign_via`: `line` (dialed the
   letter's number / emailed its alias), `inherited` (label carried from an
   earlier row), `match` (matched to the mailed list), `manual`.
2. **Credit is a per-person step, idempotent, run at every intake and
   after every link write** — not "the row the match happened on". It
   stamps the person's **inbound** rows dated on/after the mailing's start
   that have no credit in that campaign family. It never touches rows
   credited by that family's own line, rows from before the mailing
   started, or Ryan's outbound rows.
3. **A mailing starts counting on its first drop date** — one date per
   campaign (D1). Before it, a match is "on the list, not mailed yet":
   linked, no credit.
4. **"Mailed" = arm A/B/C, not a seed, mailing started.** `arm='none'`
   and seeds link but never earn credit.
5. **Door = `twilio_number` + `lead_type`** of the person's first inbound
   contact on/after the mailing start: website form / website number /
   letter's own number / other.
6. **One letter version per person per mailing:** the first credit in a
   campaign family sticks; later match credits follow that child. When
   they dial the letter's own number, the dialed number decides A vs B
   (today's rule; mismatch stays logged).
7. **Strong matches credit automatically; weak ones wait.** Auto-credit:
   exact property address (incl. secondary parcel addresses), or a manual
   link. Mailing-address-only, surname-only, sound-alike on a non-letter
   door, or an owner-name mismatch → stored as candidates as today, one
   Telegram line, credit when Ryan confirms on the card's existing
   "Link mailed record" picker. No card address/name rewrite from a
   non-letter door.
8. **Events are attributed by date.** Response counts under every
   campaign the person was credited to. Lead / appointment / offer /
   pending / close / deal value / removal count once, under the campaign of
   the person's newest credited inbound row on or before the event;
   fallback when none precedes it = the earliest credited campaign (keeps
   Kirkland). Segments + Timing use the same rule (D2).

## Phase 1 — build now (before the video)

1. **Migration** `leads.campaign_via` (text, nullable) + backfill for the
   342 credited rows (≈177 line, 57 inherited, 39 alias→line, 66 outbound,
   2 hand, 1 form match). `campaigns.first_drop_date` (date) — set Q4 from
   the ITI ship email for batch 1 (look it up in Gmail; do not ask Ryan).
   RLS in the migration.
2. **Server-only credit module** (`lib/mailCredit.ts`, not
   `lib/mailMatch.ts` — that file is in the browser bundle and is imported
   raw by two scripts). One wrapper `linkAndCredit` used by **every** link
   site: voice / sms (incl. the STOP branch, `sms/route.ts:160-189`) /
   three email branches / website-form / recording fallback
   (`voice/recording/route.ts:250`) / three triage sites in `lib/leads.ts`
   (called unconditionally, not behind the name/address guard) / card PATCH
   (`app/api/leads/route.ts:316`) / manual route / `lib/dnc.ts:267, 276,
   392` / `scripts/sync-iphone-calls.mjs`. Short-circuit when the person
   has no link (voice webhook latency). Retire
   `creditWebsiteFormToMailCampaign`.
3. **Known people meet the list (R6).** At intake, a row whose inherited
   campaign has no list (MFM, legacy) also searches lists whose mailing
   has started, exact match on the card's known address. Paul Bates is
   **not** pre-linked; he is linked + credited when he next contacts.
4. **Matching on non-letter doors:** exact across lists; secondary parcel
   addresses in `mail_records.parcels` (audit count: 1,567 mailed records
   carry 2+ parcels; 1,988 secondary addresses unfindable today);
   sound-alike / city-correction produce **candidates + one Telegram
   line**, never an auto-link. Letter-line behaviour unchanged.
5. **Manual unlink is remembered** (a "rejected record" mark) so the
   auto-link does not re-link and re-credit. Manual relink moves only
   `match` / `manual` credit, never `line`.
6. **Counting** — extract a pure, tested helper used by
   `performance/route.ts`: date-attributed events (Design 8), person
   de-dupe by the union of phone / thread / email (today 2 people are
   double counted in MFM), parent rollup de-duped by person, paginated
   queries (sibling query is at 605 of the 1,000-row cap), `created_at`
   selected, earliest-offer fix. Use `isAnonymousCaller` everywhere.
7. **Segments + Timing SQL**: a responder = a record with ≥1 inbound row
   credited to that campaign family on/after the mailing start; first
   contact = earliest such row; same date rule for milestones and
   removals. Keep "on the list, not mailed" counted by link (C3 would
   otherwise zero it). This merges the two counting systems; remaining
   expected gap = line-credited people with no record (5 today).
8. **By-door count** per campaign on Campaign Performance (website form /
   website number / letter's number / other) — the video's scoreboard.
9. **Card**: main chip = campaign of the newest credited inbound row
   (outranks `campaign_label`; old labels and earlier campaigns stay as
   faded chips); door shown beside it; "Matched" reads "On list — not
   mailed" for `arm='none'`. `GET /api/leads` already joins campaigns per
   row — add the label there.
10. **Telegram**: when a person is first credited by match on a
    non-letter door, one line — "📬 <name> is on NOO Q4 2026 (letter B) —
    came in on the website number." Once per person per campaign. Form
    alert stops saying "Mailed" for an unmailed match. Website rows with a
    house number and no match get "not on a mailing list — check the
    address".
11. **Returning old lead via a non-letter door, moved to a newer
    campaign** → same "new letter = New" reset the letter lines apply
    (`resolveIntakeStatus`), unless DNC (D3).
12. **Guard**: `scripts/import-mail-records.mjs` refuses a second
    campaign's list until Phase 2 ships (prints why).
13. **Backfill** (dry run → show Ryan → commit): Maryam Norton's 6 inbound
    website-number rows → Q4-B, `campaign_via='match'`. Nothing else
    qualifies today. Her `source` is untouched, so her mailbox stays info@.
14. **Tests**: new unit tests for the helper and the credit step (mailed
    / unmailed / seed / not-started; line vs match; outbound-row link then
    credit on the inbound row; mid-call text; two-campaign person with a
    close; Kirkland fallback; unlink remembered; A+B person). Update
    `tests/noo-ab.unit.test.ts:138-185`, `tests/mailMatch.unit.test.ts`
    (fake client needs `.in` / `.order`), `tests/recording-matchlink.unit
    .test.ts:11` (mock export). `tsc --noEmit`, `next build`, vitest.
    Replay one Twilio-shaped website-line webhook; detach the test row.

**Acceptance (prod numbers before = after except):** Q4 top line stays
15; Maryam shows door "website form"; Q4 segments 10; MFM double-counts
drop by 2; Quito and Kirkland closes stay where they are; no row's
`source` changed.

## Phase 2 — before the next list is imported (recorded, not built)

- Per-row `credit_record_id` written with the credit and never rewritten;
  `mail_record_id` stays person-wide ("which house"). SQL reads the
  per-row column so an old list keeps its responders (R3).
- Newest-list selection: at intake, find the person's house on the newer
  list by parcel number, then street + city; group by house before
  tie-breaking; prefer a mailed record over `arm='none'` on a newer list;
  state whether a manual link outranks a newer auto match.
- Stamp `mail_records.drop_date` per batch (`stamp-arrived.mjs --drop`).

## Not in this scope

- Jackie / missed-call text / drips on the website number (door
  comparisons are therefore not apples-to-apples — the letter lines get
  stronger follow-up).
- Loading older mailing lists. Phone-number matching for text-only
  responders. Making `SOURCE_OVERRIDE_NUMBERS` table-driven.
- Blocked caller ID (each call is its own person; 8 rows, all junk).

## Decisions — answered by Ryan 2026-11-09

- **D1. A mailing starts taking credit the day its first batch goes out**
  (one date per mailing; Maryam stays Q4).
- **D2. "The sale credit goes to the most recent mailing."** Built as: the
  most recent mailing the person was credited to when the event happened
  (Design 8). A deal that already closed does not move when the person
  later answers a newer letter (keeps Quito and Kirkland in place) —
  stated back to Ryan; change if he meant otherwise.
- **D3. An old Dead / Nurture lead who answers a new letter through the
  website comes back as New** (unless DNC), same as the letter lines.

Raised, not decided: (a) two different callers matching the same mailed
house → one response for that letter (not in scope unless Ryan says so);
(b) Jackie on the website number for missed calls (separate job — her
script assumes the caller got mail; `JACKIE_LINES`, `lib/leads.ts:96`).
The website line does send a "sorry I missed you" text after 15 minutes
(`website-ladder/sweep`), but has no Jackie and no automatic drip.

Defaults taken without asking (say so if wrong): a reply from someone Ryan
reached out to first still counts for the letter (the data cannot tell who
moved first; nobody is affected today); weak matches wait for his confirm
on the card; Paul Bates is not pre-linked.

## What the audits changed vs draft v1

Dropped the `source` rewrite (it switched sending mailboxes, drip cadence
and autopilot wording, with no undo). Credit moved from "the matched row"
to a per-person step (the address usually arrives on Ryan's callback).
Segments/Timing SQL brought into scope (linking alone was adding
"responders"). Door redefined (`source_type` is inherited). Mailing-start
date added. Weak matches gated. Multi-parcel addresses added. C5 (per-row
links for a second list) deferred to Phase 2 behind an import guard.
Manual-unlink memory, opt-out paths, pagination, split-key de-dupe added.
