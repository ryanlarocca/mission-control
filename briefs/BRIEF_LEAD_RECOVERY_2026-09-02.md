# Lead Recovery — execution brief

> **Status: Phases 0 + 1 SHIPPED 2026-09-02 (see "What shipped" below).
> Phases 2-5 proposed, not started. Phase 4 still blocked on the four open
> decisions at the bottom.**
> Drafted 2026-09-02 from a live DB + Gmail audit. Owning project:
> `../../lead-pipeline/` (route ships there per `../MEMO_INDEX.md`).

## Why this exists

Three leads in one day exposed the same class of failure — the CRMS only
manufactures work from **phone calls**, so any lead whose intent arrives by
email is silently dropped:

- **Camelia Lim** — emailed 2026-08-13 about a San Jose fourplex. Ryan replied
  in 9 minutes and 3 more times after. The lead card said *"no follow-up
  conversation has occurred."* It was wrong; his replies were never recorded.
- **Virginia Slater** — emailed 2025-12-15 about 555 Nido Dr. Never ingested
  at all; capture didn't start until 2026-04-28. Found by hand.
- **Chris Shoemaker** — emailed 2026-09-02: *"We're under contract with another
  buyer. Give me a call if you'd like to discuss timing and pricing."* Produced
  **zero** follow-up task. This is the one that proves it's structural.

The through-line: Ryan is being told leads went cold when the system either
never recorded his outreach or never created the task in the first place.

## Root causes (all verified against prod, 2026-09-02)

### D1 — An inbound email cannot create a follow-up task. *(the Chris bug)*

- `EmailTriageResult` (`lib/leads.ts:2528-2539`) returns `temperature`,
  `is_dead`, `summary`, `suggestedReply`, `offer_amount`, `offer_verbalized`.
  There is **no `recommended_followup_date` / `followup_reason` field at all.**
- `app/api/leads/email/route.ts` has zero references to followup — the inbound
  email insert never writes one.
- The call path *does*: `analyzeCallTranscript` →
  `applyAnalyzeCallResult` (`lib/leads.ts:2304`) writes both columns.
- `/api/follow-ups` builds its candidate set from
  `drip_campaign_type.not.is.null,recommended_followup_date.not.is.null`
  (`app/api/follow-ups/route.ts:182`). A row with both null is invisible.
- The only follow-up extractor available to an email lead,
  `POST /api/leads/[id]/extract-followup`, parses **Ryan's hand-typed notes**
  (`body.notes`), not the seller's message. Called from exactly one place:
  `components/widgets/LeadsTab.tsx:901`.

**Evidence** — Chris's newest row `98dc6aa0` (2026-09-02T19:56Z) carries an
explicit "give me a call", and has `drip_campaign_type=null`,
`recommended_followup_date=null`, `followup_generated_at=null`. Nothing ran.

**Secondary, same cluster:** his oldest row `b827db72` is `status=dead` but
still stamped `direct_mail_email #1`, so the card renders *"Drip #2 email · due
now"* for a touch the engine will never send (`DRIP_STOP_STATUSES` excludes
dead, `scripts/drip-engine.js:159`). The UI promises a touch that cannot fire.

### D2 — Manual Gmail replies never become lead rows. *(the Camelia bug)*

- The summary prompt's transcript is built **only** from `leads` rows
  (`app/api/leads/[id]/summary/route.ts:91`); outbound is marked by
  `!twilio_number` (line 39). Replies sent from Gmail by hand are not rows, so
  the model correctly reasons over a half-empty table and reports no contact.
- Measured: **24 outbound emails to 13 real leads** exist in the campaign
  mailboxes' Sent folders with no CRMS record (Yanhui Liu, Chris Shoemaker,
  Terry Chandler, Mehran Beheshti, Susan Ha, Grace Chang and others). Floor, not
  ceiling — excludes `info@`.
- `app/api/leads/sync-email/route.ts` **already pulls the full thread in both
  directions** on card expand. The outbound half is rendered and discarded.

### D3 — Whole intake channels are unwired

- Capture began 2026-04-28. **58 genuine mailer responses** predate or bypass
  it (`scripts/.missed-lead-candidates.json`). All 58 are contactable: 33 with a
  phone recoverable from the Google Voice envelope, 32 with a usable email,
  zero with neither.
- Google Voice text-forwards landing on `ryan@` / `info@` are never ingested —
  only the `ryansv*` mailboxes are wired in `config/email-campaigns.json`.
- **Textedly** (an SMS platform forwarding inbound texts to `info@`) is a
  completely unknown intake pipe. Claire Zhou, Sahib Mann, John Pinto, Elisa
  Armenta, Ross Meiklejohn all arrived this way and none exist in the CRMS.
- Only 5 lrghomes.com mailboxes are real; `ryansva@`/`ryansvd@` are aliases and
  401 on impersonation despite owning lead rows.

### D4 — Never-connected leads decay like reached ones

`scripts/tag-call-block.mjs` already computes `NO_VM` / `PHONE_TAG` /
never-connected, and **nothing downstream consumes it.** 12 distinct numbers sit
behind call-screening services; 16 calls have been burned on them. Camelia: 2
calls, 0 voicemails landed, then demoted to cold — for silence she never heard.

## Plan

**Phase 0 — stop the bleeding. No migrations, no schema change.**
1. Suppress the 6 explicit opt-outs found in the scan (`is_dnc = true` +
   `dnc_list` insert). Compliance, and it stops postage to people who already
   said stop in capitals.
2. Guard the summary prompt: it must describe only what it can see and is
   forbidden from asserting that no contact occurred. Null
   `ai_summary_generated_at` on affected clusters to force regeneration.

**Phase 1 — make an email create work.** *(fixes D1)*
- Add `recommended_followup_date` + `followup_reason` to `EmailTriageResult`
  and its prompt, with the same "null unless justified by the text" rule the
  call analyzer uses, and run it through
  `validateFollowupAgainstReason()` so email dates get the existing sanity check.
- Write both columns in the `app/api/leads/email/route.ts` insert.
- Backfill: re-triage existing email leads whose body contains a call-me signal.
  Chris is the acceptance test — "give me a call" must produce a dated task.
- Fix the phantom next-touch: don't render a due drip for a row whose status is
  in `DRIP_STOP_STATUSES`.

**Phase 2 — record outbound email.** *(fixes D2)*
- Persist `sync-email`'s outbound messages as lead rows with
  `twilio_number = null` (the existing outbound convention). No new table.
- Backfill the 24 known unrecorded sends, then regenerate those summaries.
- `sync-email` derives its mailbox from `source` via `EMAIL_CAMPAIGN_MAP`;
  `Legacy DM` isn't in that map, so thread sync silently fails for Virginia and
  the whole backfill cohort. Needs a fallback.

**Phase 3 — close the intake holes.** *(fixes D3)*
- Ingest Google Voice forwards arriving at `ryan@` / `info@`.
- Add a Textedly parser (phone + name are in the notification body).
- Both feed the existing insert path; no new pipeline.

**Phase 4 — backfill the 58.** Script, dry-run first, reviewed before it writes.
- Dedupe against existing leads by phone **and** email.
- Tier by intent, not date. ~12 are Tier A (named a property and engaged):
  1226 Flora, 298 Church, 10-12 Church duplex, 911 Tamarack, Millbrae,
  745 N. Daniel, 1127 Ayala, 469 N 2nd, 1248 Elvira, 16680 Kennedy,
  342 Beaumont (trustee), 10353 Miller, Hollister/Juniper. Tier B gets a letter
  before a call — most are 12-24 months cold.
- Stagger `recommended_followup_date` ~5/day over three weeks, hottest first,
  with `followup_reason` quoting the seller's own words.
- Every row: `drip_campaign_type = null` (nothing auto-texts a 2-year-old lead)
  and `campaign_label = "BACKFILL-2026-09-02"` so the cohort is filterable and
  measurable. `created_at = now` with the true inbound date in `notes`, so they
  are visible without polluting MFM campaign attribution.

**Phase 5 — never-connected exemption.** *(fixes D4)*
Consume the callblock signal: a cluster with no landed message is exempt from
cold/nurture demotion, and two failed calls route to email/text rather than a
six-month timer. Channel-switch before you time-decay.

## Sequencing

Phases 0-2 before Phase 4. Loading 58 leads into a system that doesn't record
outreach reproduces the original bug at 58x scale.

## Already shipped 2026-09-02 (pre-brief)

- Virginia Slater backfilled by hand as lead `8174dda9` — source `Legacy DM`
  (**not** MFM-B; she predates that drop by 4.5 months and would have corrupted
  a 5,007-piece campaign's attribution), drips disabled.
- `scripts/scan-missed-email-leads.mjs` — read-only Gmail sweep across all 5
  live mailboxes. Note: domain-wide delegation grants `gmail.modify`, **not**
  `gmail.readonly` — requesting readonly 401s.
- Artifacts: `scripts/.missed-lead-scan.json` (raw),
  `scripts/.missed-lead-candidates.json` (58 filtered).

## What shipped 2026-09-02

**Phase 0.**
- `scripts/suppress-email-optouts.mjs` — 14 written opt-out requests suppressed
  (9 property owners, 5 agents), none of which had ever been recorded. Three
  (Fogelstrom, Ernst, Carter) were still `status=active` in `campaign_contacts`
  and queued to be mailed again; flipped to `unsubscribed`. Deliberately
  excluded as false positives: Ryan's own print vendor, a wholesaler, an intake
  test, and two sellers who declined without asking to be removed (one of whom
  invited a call).
- Summary prompt guard (`app/api/leads/[id]/summary/route.ts`) — the model is
  now told its view is incomplete and forbidden from asserting that Ryan didn't
  respond or that a lead is "uncontacted".
- Invalidated exactly **2** cached summaries (Camelia Lim, Cinepol Subramanian)
  that claimed "remains warm but uncontacted". A first pass matched 11, but 9 of
  those said the *seller* hadn't replied — verifiable, accurate, and left alone.

**Phase 1.**
- `EmailTriageResult` gains `recommended_followup_date` + `followup_reason`
  (`lib/leads.ts`), extracted from the sender's own words, resolved against
  today, run through the existing `validateFollowupAgainstReason` guard, and
  paired (a date without a reason is discarded). `max_tokens` 200 → 700; the old
  cap would have truncated the JSON and silently returned null.
- All three inserts in `app/api/leads/email/route.ts` now write them.
- `dripStatus` added to `NextTouchInput` (`lib/next-touch.ts`) + passed from
  `LeadsTab.tsx` — the drip forecast now gates on the *stamped* row's status,
  matching the engine, so a dead intake row no longer renders "due now".
- `scripts/backfill-email-followups.mjs` — one-time catch-up. 16 candidates →
  **11 given a follow-up**, 5 correctly left null, 0 failures.
- Tests: `tests/email-triage-followup.unit.test.ts` (7 new, offline) +
  4 new `dripStatus` cases in `tests/next-touch.unit.test.ts`. 52 pass,
  `tsc --noEmit` clean.

**Verified:** Chris Shoemaker now sits in the Follow Ups candidate set —
2026-09-03, reason *"Give me a call if you'd like to discuss timing and
pricing"*. Camelia and Virginia surfaced too.

**Surfaced, not addressed:** 7 follow-ups have been overdue since May/June
(Michael Carson, Al Meir ×2, Jennifer, Gigi Williams ×2, Mark Hoffman). They
came from the call path and were never worked.

## Open decisions for Ryan

1. **Phase 4 timing** — backfill after Phase 2 (recommended), or load the leads
   now and accept a few days of unrecorded outreach?
2. **Tier B treatment** — letter-first, or call everything?
3. **Call volume** — is 5 follow-ups/day the right pacing for the staggering?
4. **Textedly** — still in use, or dead? Determines whether Phase 3 builds a
   parser or just backfills its history.
