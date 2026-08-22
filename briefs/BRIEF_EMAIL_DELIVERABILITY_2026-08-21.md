# Brief — Agent email deliverability: findings + restart plan

> **Date:** 2026-08-21 · **Status:** DIAGNOSED, restart NOT started. Engine idle
> (0 sends since Aug 6). Ryan's decision: new sender = `ryan.lrghomes@gmail.com`
> (consumer Gmail), **not** a sibling domain. Next session starts at Phase A §1.
> Owning memo: `../agent-email-v2/PROJECT_MEMO.md`.

## The July campaign, fully counted (corrected — earlier tallies were cut by the 1000-row cap)

| | |
|---|---|
| Sent | **2,361** emails, 12 send days Jul 20 – Aug 4, ~200/day, all from `info@lrghomes.com`, cold start, no ramp |
| Bounces | **168 DSNs / 150 addresses = 7.1%** (Gmail target <2%). 132 hard "address not found" (stale brokerage addresses), 21 soft, 3 blocked. Gmail mailbox count == our `campaign_events` count — the watcher missed none; all 149 contacts are `bounced`/`bad_email`, 0 still active |
| Replies | 37 (1.6%) |
| Unsubscribes | 18 explicit + 6 manual; 26 email rows in master `suppression`. One-click header, typed-reply regex, and manual paths all verified writing through |
| Spam reports | unknowable (Google only shows the rate in Postmaster Tools, which was never set up) |

## What the tests proved (Aug 21, ~50 test emails to Ryan's own inboxes only)

Recipients: `ryanlarocca9@gmail.com` (personal, knows Ryan — **trained itself during testing** and became unreliable), `ryanlarocca44@gmail.com` (never touched by info@/ryansvr@ — the clean judge), plus internal `ryansvg@`.

1. **It is the `lrghomes.com` domain.** Clean inbox: 6/6 Spam from BOTH `info@` and `ryansvr@`, every copy style, plus 2 more from `ryansvr@` with never-before-seen wording → Spam. Gmail's banner on every one: *"previous messages from lrghomes.com were marked as spam."* Same two never-seen bodies typed from a fresh `ryan.lrghomes@gmail.com` → **Primary** (one marked Important). Auth (SPF/DKIM/DMARC p=none) is fine; the mailboxes are fine; the list is scrubbed.
2. **Copy moves Primary↔Promotions once past the spam gate** (Round 1, trained inbox, directional only): `List-Unsubscribe` headers alone flipped the base email to Promotions (A8); a property address as subject → Promotions (A11); "just send it my way" CTA → Promotions vs "happy to grab coffee near your office" → Primary (A13); signature+phone, "reply remove" body line, "quick question" subject, "Hi Ryan," salutation, touch-2 "Re:" framing all stayed Primary. Winning shape: short, one specific hook, an in-person/two-way ask, conversational subject.
3. **Formatting bug, fixed & deployed (`d9b9f55`):** every July email arrived with hard line breaks at ~70 chars — Gmail re-wraps `text/plain`-only bodies on delivery regardless of transfer encoding. All three senders (campaign engine, drip engine, Telegram `draft:` replies) now send `multipart/alternative` plain+HTML via `lib/emailMime.ts` (CJS twin `scripts/email-mime.js`). Verified intact on a received copy.
4. **Test-inbox rules learned the hard way:** never open/mark test mail before the batch is read; one designed batch beats ad-hoc sends; never reuse a body across inboxes (Gmail fingerprints repeats as bulk); mail-tester rejects API mail without its per-page token; cancel log watchers when a batch is killed.

## Decision + constraints (Ryan, Aug 21 evening)

Sender = **`ryan.lrghomes@gmail.com`**. On the record: 500 recipients/day hard cap, consumer-Gmail throttling on cold patterns, no Postmaster Tools for gmail.com, no brand DKIM. Health signals will be bounce rate, reply rate, throttle errors, and the `44@` test inbox. `lrghomes.com` sends nothing cold and heals in the background (replies/leads/warm threads unaffected — all verified landing).

## Plan — next session

### Phase A — plumbing + baseline (no agents)
1. **OAuth for the Gmail account.** Service account DWD can't impersonate gmail.com. Create an OAuth client in the mission-control GCP project, one consent click by Ryan as `ryan.lrghomes@` (2-step verification must be on), store the refresh token (env `CAMPAIGN_GMAIL_OAUTH_*`). Same token drives the inbox watcher (`lib/campaignInbox.ts`) for replies/bounces so Telegram alerts keep working.
2. **API-vs-app baseline:** 3 unique typed bodies from the new account *through the engine path* → `44@`. Must land Primary.
3. **Clean copy batch** (~8, 2 min apart) from the new sender → `44@`: July template / friendly note / "Intero" base / base+unsub headers / bullets / pitch language / long / address-subject. First fully trustworthy copy read.

### Phase B — real agents, reply rate is the metric
4. 3 variants × 20 agents, 20/day × 3 days: Phase-A winner, July template (baseline), Claude-personalized (brokerage + property on file). Verified emails only; exclude bouncers/repliers/unsubs.
5. Ramp: 20/day×3 → 40 → 80 → ~120, only while daily bounces <2% and no Gmail 4xx throttle; any throttle → halve, hold 48h.
6. Send-time experiment (already built: random minute in 7a–5p window, reply%-by-hour on /email-campaign Performance tab) layers on once daily volume supports slots.

### Engine changes (do alongside A)
- OAuth sender path beside the service-account path; `SEND_AS` → rotation table with per-sender caps + ramp.
- T1: **no `List-Unsubscribe` headers**, "reply remove" body line only. T2+: headers back on.
- Unique body per recipient (Claude varies from template; never identical text twice); variant tag on every send → Campaign Performance rolls up reply rate per variant.
- Pre-send verification pass on the 2,199 active contacts (bounce-verify service or probe); drop failures.
- Auto-pause a sender on a ≥2% bounce day or a Gmail throttle response.

## Test-inbox protocol (use every time)
`ryanlarocca44@gmail.com` is the judge. Do not open, star, or "not spam" anything there until the batch is fully read. Unique bodies only. Tag subjects `[Xn]`. Read Spam folder first, then Promotions, remainder = Primary. Replace the judge inbox once it has seen a sender ~20 times.
