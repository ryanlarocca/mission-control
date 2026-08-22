# Agent email campaign — running learnings log

> Append-only. One dated line per thing we learned about deliverability or
> replies, with the evidence. Read the whole file before changing copy,
> volume, or sender. Rules section at the bottom is the current operating
> doctrine; change it only with a dated entry above explaining why.

## Log

- **2026-08-21** — The `lrghomes.com` domain is spam-flagged at Gmail, not a mailbox. Clean inbox: 8/8 Spam from info@ and ryansvr@ regardless of copy, banner "previous messages from lrghomes.com were marked as spam". Same words from `ryan.lrghomes@gmail.com` → Primary. (Brief: BRIEF_EMAIL_DELIVERABILITY_2026-08-21.md)
- **2026-08-21** — July cause, best guess: 2,361 sends at 200/day from a cold start with a **7.1% bounce rate** (stale brokerage addresses) + unknown spam reports. Gmail's guidance is <0.3% spam-report and <2% bounce; we blew through bounce on day one and never ramped.
- **2026-08-21** — Gmail hard-wraps `text/plain`-only bodies at ~70 chars; every July email arrived with broken lines. Fixed: multipart plain+HTML everywhere.
- **2026-08-21** — From the new sender, copy barely matters for placement: 10/11 Primary (July template verbatim, pitch language, long, address-subject all Primary). **List-Unsubscribe headers were the one reproducible Promotions trigger** (both days, both senders). T1 ships without them; T2+ keep them.
- **2026-08-21** — Test-inbox hygiene: a personal inbox that knows the sender trains itself within a few emails and stops being a judge. Never reuse a body across inboxes; Gmail fingerprints repeats as bulk.
- **2026-08-21** — Consumer Gmail sender limits: 500 recipients/day hard cap, no Postmaster Tools, no brand DKIM, throttling on cold patterns. Our practical ceiling target ~120–150/day after a full ramp.

## Signals we watch (daily 🩺 health card, Telegram, ~5:15pm PT)

| Signal | Source | Watch | Act |
|---|---|---|---|
| Bounce rate / day | `campaign_events` kind=bounce vs sends | ≥1% 🟡 | ≥2% → auto-pause 48h |
| Gmail throttle / quota error | send pass exception | any | auto-pause 48h |
| Removes ("remove"/unsub) | `email_reply` triage=unsubscribe | ≥2/day 🟡 | ≥3/day → hold volume, review copy |
| Genuine reply rate (7-day) | `email_reply` triage=null within 14d | <1% on ≥40 sends 🟡 | copy/list review before any ramp step |
| Send failures | `campaign_sends.status=failed` | any | investigate same day |
| Lint rejections | engine counter | ≥3/day | prompt/template fix |
| Canary placement | `[Cn]` emails to `CAMPAIGN_CANARY_TO` | Ryan reads weekly | any Spam → stop ramp, investigate |
| Auto-replies / dead mailboxes | triage auto_reply / dead_mailbox | trend only | list quality |

Daily snapshots are stored in `campaign_settings` as `health:<YYYY-MM-DD>` for trend analysis.

## Ramp doctrine (current)

1. 20/day × 3 send days (Phase B test) → 40 → 80 → ~120. Each step needs **3 consecutive green days** and Ryan's explicit OK. Never skip a step.
2. Any 🔴 (auto-pause) → drop back one step after resuming and hold 48h.
3. Canary in Spam or Promotions twice in a row → freeze volume, run a clean-inbox placement batch before continuing.
4. Never send cold from `lrghomes.com`. Keep lrghomes.com for replies and warm threads only while it heals.
5. T1: no List-Unsubscribe headers, body "reply remove" line only. Unique body per recipient, always.
6. Weekly (Friday scorecard): review variant reply rates; promote the winner only after ≥60 sends per variant.
