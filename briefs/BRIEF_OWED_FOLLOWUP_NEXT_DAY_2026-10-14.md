# Brief — "I owe them a number" follow-ups come due the next day

**Date:** 2026-10-14 · **Owner project:** lead-pipeline (Leads tab) · **Decided by Ryan:** 2026-10-14

## The problem (real case)

Sunday Oct 12, Ryan called **Herb Bivens** (lead `caller_phone +15597791836`, 409 Center St, Santa Cruz)
and said: *"I'm going to take a look at the comps and in the next couple of days or so I can text you an
offer, ballpark wise."* The call analyzer wrote:

> reason: "Ryan committed to texting an offer 'in a couple of days or so' — follow up in 3-4 days to confirm the text was received"
> recommended_followup_date: 2026-10-16 (4 days out)

The task came due *after* the promise was supposed to be kept. The analyzer only knows one kind of
follow-up ("when should Ryan next reach out") and maps every timing cue through the seller-timeline
table ("this week" → 3–7 days, "next week" → 7–14 …), then pads it "to confirm receipt".

## The rule (Ryan, 2026-10-14)

> When I promise to give someone a number, the system should set the follow-up for the next day.

- **Ryan commits to deliver something** (a number / offer / price, comps, a text, an email, a document,
  "I'll get back to you", "let me look and I'll text you") → `recommended_followup_date = tomorrow`
  (next **calendar** day — weekends are fine, Ryan's call), and `followup_reason` is written as the
  deliverable, e.g. *"Text Herb a ballpark offer on 409 Center St — Ryan said 'in the next couple of days I can text you an offer'"*.
- A promise from Ryan **wins** over any seller timeline in the same conversation (it comes first).
- Seller gave a timeline and Ryan promised nothing → unchanged (existing table).
- No "confirm it was received" buffer, ever.

## Build

All in `mission-control`. Branch from `main` (≥ `bcba06e`). `tsc --noEmit` is the gate; `npm test` (vitest).

1. **Call analyzer prompt** — `analyzeCallTranscript` in `lib/leads.ts` (~line 2204; the follow-up rules
   start at the `recommended_followup_date:` bullet ~115 lines in). Add a rule **0** above the timeline
   table: *"If RYAN committed to send or do something (a number, offer, price, comps, a text, an email,
   info, 'I'll get back to you'), recommended_followup_date = TOMORROW (today + 1), regardless of any
   timing he or the seller mentioned. followup_reason names the deliverable first, then quotes Ryan.
   Never add days 'to confirm receipt'."* Add it to the `followup_reason` examples too.
2. **Email triage prompt** — `triageEmailLead` (same file, FOLLOW-UP DATE section). Same rule 0 for
   threads where Ryan wrote the promise ("I'll get you a number this week").
3. **Notes extractor** — `app/api/leads/[id]/extract-followup/route.ts`. Same rule for Ryan's own card
   notes ("told him I'd send a price").
4. **Hard guard in code** — next to `validateFollowupAgainstReason` (`lib/leads.ts` ~2515), add
   `clampOwedFollowup(date, reason, today)`: if the reason contains first-person commitment language
   (regex over e.g. `\bI(?:'ll| will| can| am going to| could)\b.{0,40}\b(send|text|email|get back|put together|look at|run|pull|give you|shoot you)\b`, plus "Ryan committed/promised/said he'd/will send|text|email"),
   and the date is > today+1, set the date to today+1 and prefix the reason with `Owed: `. Apply it on
   all three paths (call, email, notes) **after** the long-horizon guard. Export it for tests.
   Use the same `today` string the prompt was given so the test is deterministic.
5. **Unit tests** — new `tests/owed-followup.unit.test.ts` following
   `tests/email-triage-followup.unit.test.ts` (mock `completeText`). Fixtures: (a) Herb's exact reason
   + date 4 days out → clamped to tomorrow, reason prefixed; (b) seller-timeline reason ("said 'call me
   next week'") → untouched; (c) a Friday `today` → Saturday date (no weekend skip); (d) model already
   returned tomorrow → untouched, no double prefix; (e) long-horizon guard still clears
   "couple years" + near date before the clamp runs.
6. **Worklist label** — `components/widgets/FollowUpsTab.tsx` and the lead card in
   `components/widgets/LeadsTab.tsx`: when `followup_reason` starts with `Owed:` show a small **Owed**
   chip next to the date (amber, same palette as the existing badges) and strip the prefix from the
   displayed text. `app/api/follow-ups/route.ts` sort: owed rows sort first within the same day bucket.
   Keep it minimal — no new columns, no migration.

## Don'ts

- No DB migration, no new columns. No change to the seller-timeline table or the 180-day nurture rules.
- Do not re-analyze or write any lead rows from the cloud session (prod data) — the bridge session
  does the Herb re-run after deploy.
- Do not touch the drip engine or `moment` stamping.
- No commits to `main`; push the branch only.

## Done =

`tsc` clean, `npm test` green with the 5 new cases, branch pushed, a 10-line summary in the final
message: files touched, the regex, and anything you were unsure about.
