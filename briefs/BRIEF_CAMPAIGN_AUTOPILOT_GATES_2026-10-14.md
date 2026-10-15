# Brief: campaign autopilot — touch one unattended, guardrails, list verification (2026-10-14)

## Why

Ryan is the gate on every agent-campaign send today (`CAMPAIGN_AUTO_SEND_TOUCHES`
is empty). On 2026-10-14 the 11 AM mint produced 14 drafts, Ryan approved them
at 6:18 PM, the send window had closed at 5 PM, and zero went out. Only the
previous day's batch sent (8), so the ramp caps (10 + 5) half-filled and the
"healthy day" counter did not advance. Meanwhile two agents replied "remove"
and that alone held the buys sender's rung.

Ryan (2026-10-14, verbatim intent):

- "I'm starting to feel pretty comfortable with just having these get
  auto-approved until there's an issue that we should have guardrails for."
- Removes must not hold the ramp: "I don't think it's hurting our reputation
  when they say remove and we take them off the list … hold more weight to a
  bounce than to somebody saying remove."
- An abnormal remove day *is* a copy problem and needs its own rule.
- Bounces from agents who left their brokerage are the real worry. Verify
  the list with a third-party service before each touch.
- Touches are event-based: finish touch one for the whole list before anyone
  gets touch two. "Just to be simple."
- Touch two stays gated (Ryan reviews) until a second canary clears it. The
  second canary is NOT built now — alert him when it's time to prepare it.
- Nothing fancy on the verifier: cheapest tool that answers "does this
  mailbox exist." Kickbox, pay-as-you-go. Catch-all domains SEND (never
  filtered) — catch-all is a property of the domain, not the agent.

## Context you need

- Engine: `scripts/campaign-engine.mjs`. Passes run in order at the bottom of
  the file: ramp → draft → send → digest → canary → judge → health →
  scorecard, each isolated by `runPass()`. launchd runs it every 20 min
  (`~/Library/LaunchAgents/com.lrghomes.campaign-engine.plist`,
  `StartInterval 1200`). Health evaluates once per weekday after 5:15 PM PT.
  Send window `WINDOW = { 7, 17 }` PT Mon–Fri. `telegram(text, buttons)` is
  the engine's Telegram helper. `ptToday()` gives the PT day string. `dryRun`
  is `--dry-run`. `log()` writes `/tmp/lrg-campaign-engine.log`.
- Auto-approve today: `AUTO_SEND_TOUCHES` (engine, ~line 101) is parsed from
  env `CAMPAIGN_AUTO_SEND_TOUCHES`. `draftPass()` sets
  `status: auto ? "approved" : "draft"` (~line 519). Gated touches mint once
  daily after `CAMPAIGN_MINT_HOUR` (11 on the mini) via
  `gatedMintAllowedToday()`; auto touches top up every pass. The draft pass
  also stamps `prompt_version` on every `campaign_sends` row (`PROMPT_VERSION`
  constant) — T1 bodies are unique Claude compositions from the live T1
  template, so "copy" for T1 = the prompt version, not a fixed body.
- Draft ordering: `draftPass()` builds `dueList` (status active, email not
  null, `next_touch_at <= now`), sorts by `priorityOf()` (repliers →
  Relationships matches → everyone else) then `next_touch_at` ascending, then
  walks it with per-sender `budgets`. `touch = c.touch_number + 1`.
- Send pass: `sendPass()` fetches `status = approved` rows ordered by
  `approved_at`, where `scheduled_for` is null or past. Each auto-approved
  row gets a random minute in the 7a–5p window at draft time. Rows approved
  by hand after the window keep that day's (now past) `scheduled_for` — see
  Task 8.
- Sender ramp state: Supabase `campaign_settings` key `sender:<email>`,
  helpers in `scripts/campaign-senders.mjs` (`DEFAULT_GATES`,
  `evaluateSenderDay(...)`, `loadSenderStates`, `saveSenderState`) and the
  Next.js twin `lib/campaignSenders.ts` (Telegram writes through this).
  `config/campaign-senders.json` holds `gates` overrides and the two senders:
  `ryan@lrghomesbuys.com` workhorse ramp 5→10→20→35→50→75→100,
  `ryan@lrghomesoffers.com` understudy ramp 3→5→10→20→30→40.
- Day quality in `evaluateSenderDay` (campaign-senders.mjs ~line 233):
  bounce red = `sent >= 10 ? rate >= 2% : bounces >= 2`; yellow = any bounce
  at ≥1%; `m.unsubs >= 2` → yellow "N removes in one day". ANY yellow blocks
  a healthy day; three healthy days per rung. Red → drop a rung + 48 h
  auto-pause (`pauseSender`). A green day only counts when
  `sent >= ceil(cap * healthyDayMinFraction)` (0.6).
- Daily metrics: `dayMetrics(day)` in the engine counts `campaign_events`
  rows: `kind=bounce`, `kind=email_reply triage=null` (genuine replies),
  `kind=email_reply triage=unsubscribe` (removes). `senderMetricsRange` is
  the per-sender version.
- Bounces: `lib/campaignInbox.ts` parses DSNs; hard (5.x.x) sets
  `campaign_contacts.status = "bounced"` and inserts a `campaign_events`
  `kind: "bounce"` row with `raw.mailbox` = the sender mailbox. Two soft
  bounces escalate to hard. The inbox pass runs inside the same 20-min
  engine cycle, so a bounce is visible within ~20–40 min of arrival.
- Removes: `campaignInbox.ts` triages "remove" replies → `addSuppression`
  (`lib/suppression.ts`, table `suppression`, `source: email_unsubscribe`),
  contact `status = unsubscribed`, event `triage: "unsubscribe"`, then
  `sendRemoveConfirmation` (one bare in-thread reply, once per contact).
  Keep all of that; this brief only changes how removes feed the ramp.
- Telegram commands: `app/api/campaign/telegram/route.ts` — regexes near
  line 538 (`pause campaign`, `resume campaign`, `campaign status`, and the
  per-sender `pause|resume|canary <label> …` block ~line 566). Add new
  commands in the same style.
- Touch copy: `campaign_templates` (fixed bodies per `touch_number`; T2 =
  "Why agents send me deals", subject "the buyer who actually closes", body
  opens "quick follow-up on my note last month"). `campaign_variants` holds
  the T1 variants. `touch_number` offsets via `nextOffsetDays()` (T1→T2 is
  30 days).
- List state 2026-10-14: 2,255 active contacts awaiting T1, 64 at T1 on the
  new senders (first T2 due 2026-11-01), 152 already bounced (July wave,
  old mailbox), 25 unsubscribed. Three bounces on the new senders so far
  were all live brokerage domains (redfin.com, kw.com ×2) — departed agents,
  which a DNS check cannot catch.
- Secrets live in `.env.local` on the Mac mini (not in the repo, not in the
  cloud). Add new keys to `.env.local` AND the launchd plist
  `EnvironmentVariables` if the engine needs them; document which in the PR.
  `KICKBOX_API_KEY` will be supplied by Ryan separately — build against
  Kickbox's sandbox keys (`test_...`) and the documented response shape.
- Tests: `tests/*.unit.test.ts` (see `tests/canary-judge.unit.test.ts` for
  the pattern — pure logic extracted so it can be unit-tested without
  Supabase). `tsc --noEmit` is the gate; `next build`'s ESLint is ignored.

## Tasks

### 1. Auto-approve lives in the database, not env

- New `campaign_settings` key `auto_send_touches` →
  `{ touches: [1], pinned_prompt_version: "<PROMPT_VERSION>", changed_by, changed_at, reason }`.
- Engine reads it every pass (fall back to the env var only when the row is
  absent, then write the row so the env var is retired). Seed the row with
  `touches: [1]` in the migration/seed step and leave
  `CAMPAIGN_AUTO_SEND_TOUCHES` untouched on the mini.
- **Prompt-version pin:** a touch is auto only while `PROMPT_VERSION ===
  pinned_prompt_version`. If the constant changes, the engine re-gates that
  touch, posts "T1 re-gated: prompt changed vX → vY — review today's drafts,
  then reply `auto T1 on`" and leaves the row for Ryan.
- Telegram: `auto T1 on` / `auto T1 off` / `auto T2 on|off` (and `auto
  status`). `on` re-pins to the current prompt version.
- Any tripwire below that re-gates a touch writes `reason` into this row and
  says so on Telegram.

### 2. Removes stop holding the ramp; a floored copy tripwire replaces them

- Delete the `m.unsubs >= 2` yellow in `evaluateSenderDay` AND the matching
  line in the engine's health card (~line 1196). Removes stay on the daily
  card as a count.
- New per-sender, per-day rule (evaluate in the health pass and intraday in
  the inbox/send cycle):
  - **yellow** when `removes >= 3 AND removes >= 10% of sent today`: hold the
    rung (counts as a non-healthy day), Telegram "check the copy" with the
    subjects + prompt_version/variant of the removed sends.
  - **red** when `removes >= 5 AND removes >= 15%`: stop that sender for the
    rest of the day (same mechanism as the bounce breaker, Task 3) AND re-gate
    the touch that produced them (Task 1).
- Tag every remove with the originating send's `touch_number`,
  `prompt_version`, `variant` (join via the contact's latest sent row) into
  the event's `raw` so the Telegram line and later analysis can group by
  copy, not by day.

### 3. Intraday bounce circuit breaker

Per sender, per PT day, evaluated every engine cycle (not just at 5:15 PM):

| condition | action |
|---|---|
| 1st bounce | stamp contact (already happens), log, no other action |
| 2nd bounce, or bounce rate ≥ 2% once ≥ 10 sent | **day-stop**: that sender sends nothing more today; resumes automatically next weekday; Telegram one line |
| bounce rate ≥ 5% once ≥ 10 sent, or 3 bounces inside the first hour of sending | existing 48 h `pauseSender` + drop a rung (today's red) |

- Percentage conditions only apply at ≥ 10 sent that day, so a 1-of-3 day
  (offers, 2026-10-14) never trips. Below 10, only the absolute counts apply.
- Day-stop is a new state on the sender (`day_stop: { day, reason }`), honoured
  by `sendPass` budgets; the health pass treats a day-stopped day as yellow
  (hold), not red.
- Remove the end-of-day-only assumption from the health card text where it
  says a bounce rule "once ≥ 10 sent in the day".

### 4. Free DNS backstop at send time

- Before each send, resolve MX (fallback A) for the recipient domain, cached
  per domain per day. No MX and no A → mark the row failed with
  `error: "no_mx"`, suppress the contact (`source: "dns_no_mx"`), count on the
  card. Never block on DNS latency: 2 s timeout → treat as pass.

### 5. Kickbox verification module (`lib/verify.ts` + engine pass)

- `lib/verify.ts`: `verifyEmail(email) → { result: "deliverable" | "undeliverable" | "risky" | "unknown", reason, accept_all: boolean, sendex, checked_at }`
  using Kickbox `GET https://api.kickbox.com/v2/verify?email=&apikey=&timeout=10000`.
  Batch via sequential single calls with a small concurrency (≤ 5) — the list
  is 2–3k, there is no need for the async bulk endpoint. Respect 429s with
  backoff. Sandbox: Kickbox keys starting `test_` return canned results —
  unit-test the mapping against the documented response shape, not live.
- Columns on `campaign_contacts`: `verified_at timestamptz`,
  `verify_result text`, `verify_reason text`, `verify_accept_all boolean`.
  Migration in `supabase/migrations/` (follow the repo's naming; include
  `enable row level security` noise-free since the table already has it).
- Mapping → engine action:

  | Kickbox result | action |
  |---|---|
  | deliverable | eligible |
  | deliverable/risky with `accept_all: true` | eligible, counted separately on the card as "catch-all" (NEVER filtered) |
  | risky without accept_all | eligible (log the reason) |
  | unknown | hold out of the queue; re-verify after 7 days; still unknown → suppress `source: "verify_unknown"` |
  | undeliverable | suppress `source: "verify_undeliverable"`, contact `status = "bounced"` is wrong — use a new status value `"invalid"` so the July bounces stay distinguishable |

- **Send rule:** a contact is draft-eligible only when `verified_at` is within
  30 days and `verify_result` is eligible per the table. Gate this behind a
  `campaign_settings` key `verify_required` (`{ enabled: false }` until Ryan
  flips it after the first pass — see "Ryan's side").
- New pass `verifyPass()` running once per weekday morning before the mint:
  verify (a) anything due in the next 7 days whose `verified_at` is null or
  > 30 days old, (b) at the start of each touch (Task 6 transition), every
  active, non-suppressed contact at that touch. Budget-aware: stop at
  `VERIFY_DAILY_MAX` (default 500) and continue next day.
- CLI: `node scripts/campaign-engine.mjs --verify-all [--dry-run]` for the
  one-time first pass over the whole active queue, with a summary line
  (deliverable / catch-all / risky / unknown / undeliverable counts and the
  top 15 domains by catch-all) posted to Telegram. Also
  `--verify-domains <csv>`: verify one address per listed domain and print
  the accept_all flag — Ryan wants this run with the 100 free credits before
  buying a pack.
- Verify every new import before it enters the queue: hook the same
  function into `app/api/campaign/contacts/bulk/route.ts` (or mark imports
  `verified_at = null` and let `verifyPass` catch them next morning — pick
  the simpler one and say which).

### 6. Touch one takes the budget first (event-based touches)

- In `draftPass()`, after the existing priority sort, stable-partition
  `dueList` so every `touch_number === 0` contact precedes every
  `touch_number >= 1` contact, regardless of `next_touch_at`. Repliers /
  Relationships priority still applies *within* each partition.
- Result: T2 never mints while any T1 is due. The day the T1 queue is empty,
  T2 starts automatically, oldest `next_touch_at` first. No mode switch.
- Expose "T1 remaining" and "days of T1 supply at current caps" in the health
  card and `campaign status`.

### 7. Touch-two copy and the canary-two reminder

- Reword `campaign_templates` touch 2: replace "quick follow-up on my note
  last month" with wording that does not name a gap ("quick follow-up on my
  note from a while back" or similar — keep Ryan's voice; do not add
  anything else). Do it as a data migration with the old body in the PR
  description so Ryan can veto.
- Reminder: when T1 supply drops under 7 weekdays at current caps (first
  time only, then weekly until done), Telegram:
  "📣 Touch one runs out in ~N days. Time to prep canary two: (1) create a
  fresh consumer Gmail, (2) make an app password, (3) reply `canary2
  <address> <app password>`. T2 stays gated until it clears."
- Store `canary2_reminder_sent_at` in `campaign_settings`. The `canary2 …`
  command is OUT OF SCOPE here (just reply "noted — build pending"); the
  enrolled-contact canary design is in the memo for a later brief.

### 8. Respread late approvals

- When a row is approved after the window (or its `scheduled_for` is in the
  past at approval time), reassign `scheduled_for` to a random minute in the
  NEXT weekday's window instead of leaving the stale minute. Do it in the
  approve path (`app/api/campaign/telegram/route.ts` approve handler and the
  dashboard approve route) and as a safety net at the top of `sendPass`
  (rows with `scheduled_for < today 07:00 PT` get respread). Today (10-14)
  14 such rows would otherwise burst at 7:00–7:20 AM.

### 9. Postmaster Tools verification records

- Add Google Postmaster Tools verification TXT records for
  `lrghomesbuys.com` and `lrghomesoffers.com`. The Cloudflare token is in
  `.env.local` on the mini (`CLOUDFLARE_*`); this step runs from the mini,
  not the cloud — put the two `dig`-verifiable commands in the PR for the
  bridge session. Ryan has to add the domains in postmaster.google.com
  himself (his Google account) — two clicks, listed in the PR.

## Acceptance

- `tsc --noEmit` clean; new unit tests for: remove tripwire thresholds
  (2/8 → no trip; 3/20 → yellow; 5/30 → red), bounce breaker thresholds
  (1/3 → nothing; 2/8 → day-stop; 1/40 → nothing; 3/40 → red), Kickbox
  mapping incl. accept_all → eligible, T1-before-T2 partition, late-approval
  respread.
- `--dry-run` of a full engine cycle logs `auto T1 (db, pinned v…)`,
  partitions T1 first, and shows the verify rule as "disabled (verify_required
  off)".
- Telegram daily card shows: removes (count, no hold), catch-all sends count,
  T1 remaining + days of supply, any day-stop.
- Nothing in this brief sends more email than today's caps allow.

## Ryan's side (not blocking the build)

1. Kickbox account at ryan@lrghomes.com (free, 100 credits, no card). Paste
   the API key to the bridge session → it goes in `.env.local` + plist.
2. Bridge session runs `--verify-domains` on the top ~20 brokerage domains
   and reports the catch-all share. Ryan decides on the ~$25 pack.
3. After the first `--verify-all`, Ryan says "verify rule on" → bridge
   session flips `verify_required`.
4. Postmaster: add both domains in postmaster.google.com (two clicks).

## Out of scope

- Canary two itself (account, enrolment, shortened T2 due date, rotation).
- Any change to the one-click unsubscribe route, remove confirmation, or
  suppression semantics.
- Postmaster as a ramp gate (`requirePostmaster` stays false).
- Chasing departed agents to their new brokerage (broadcast, not 1:1).
