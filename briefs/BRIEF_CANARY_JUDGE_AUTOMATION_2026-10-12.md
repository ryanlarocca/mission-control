# Brief: automate the canary judge (2026-10-12)

## Why

The agent drip (`scripts/campaign-engine.mjs`) ramps each sender one rung at a
time. One of the advancement gates is "canary Primary 3 days running": every
send day each sender mails one canary to the judge inbox
(`CAMPAIGN_CANARY_TO`, a consumer Gmail nobody opens) and Ryan is supposed to
read where it landed and reply `canary <label> <verdict>` on Telegram.

That human step is the only thing between the engine and the ramp, and it
slipped: 7 send days since Oct 2, 14 canaries sent, ONE verdict recorded
(2026-10-02). Both senders sat at rung 0 (5/day + 3/day = 8 emails/day) for
ten days with 7 healthy days banked. Ryan (2026-10-12): "I can't be having
this get stuck on me going forward."

Gmail's API exposes the placement as labels on the message
(`SPAM`, `CATEGORY_PROMOTIONS`, `INBOX`, `CATEGORY_PERSONAL`, …). This build
reads the verdict from the judge inbox itself. Reading via the API leaves the
message unread and unopened, which is better for the test than a human
reading it.

## Context you need

- Engine: `scripts/campaign-engine.mjs`. Passes run in order (bottom of the
  file): ramp → draft → send → digest → canary → health → scorecard, each
  isolated by `runPass()` so one failing pass never takes the others down.
  launchd runs it every 20 min (`StartInterval 1200`); health evaluates once
  per weekday after 5:15 PM PT.
- `canaryPass()` (search for `async function canaryPass`) sends one canary per
  sender per send day with subject `[C<n> <label>] <real subject>` from the
  sender mailbox to `CAMPAIGN_CANARY_TO`. It records `{ [senderEmail]: "C<n>" }`
  under `st[day].canary` in the local health state file
  (`.campaign-health-state.json`, `readHealthState()`).
- Sender ramp state lives in Supabase `campaign_settings` under
  `sender:<email>`; helpers in `scripts/campaign-senders.mjs`:
  `loadSenderStates`, `saveSenderState`, `withCanaryVerdict(state, day,
  verdict)`, `canaryGate(state, day, gates)`, `evaluateSenderDay(...)`.
  Verdicts are `"primary" | "promotions" | "spam"` keyed by `YYYY-MM-DD` (PT).
  The Next.js side (`lib/campaignSenders.ts`, `recordCanaryVerdict`) is what
  the Telegram command writes through; the engine must write the same slot.
- `SENDERS` (engine) = enabled senders from `config/campaign-senders.json`
  (`email`, `label`, `role`…). `telegram(text)` is the engine's Telegram helper.
  `ptToday()` gives the PT day string. `dryRun` is the `--dry-run` flag.
- Gmail auth today is service-account DWD for tenant mailboxes only
  (`scripts/campaign-gmail.mjs`, `gmailClientFor`). The judge is a
  consumer gmail.com account, so it needs OAuth (Desktop client, loopback
  redirect). `googleapis` is already a dependency. The August consent script
  was deleted in the rebuild; write a fresh one.
- `.env.local` convention: values may be single-quoted; the file is NOT in the
  cloud checkout, so nothing here can run against live. Keep the decision
  logic in pure, unit-tested functions.
- Tests: vitest, `tests/*.unit.test.ts`. Gate: `npx tsc --noEmit` and
  `npx vitest run`.

## Task 1 — judge consent script

`scripts/canary-judge-consent.mjs`:

- Env: `CANARY_JUDGE_OAUTH_CLIENT_ID`, `CANARY_JUDGE_OAUTH_CLIENT_SECRET`
  (Desktop OAuth client from GCP project lrg-mission-control), output
  `CANARY_JUDGE_OAUTH_REFRESH_TOKEN`.
- Scope: `https://www.googleapis.com/auth/gmail.readonly` only.
  `access_type: offline`, `prompt: consent` so a refresh token is always issued.
- Flow: start a loopback HTTP server on 127.0.0.1 (random free port), print the
  consent URL, wait for the redirect, exchange the code, print the refresh
  token. The browser running the consent is ON the same machine as the
  script, so the loopback redirect completes by itself.
- `--code=<code>` fallback exchanges a pasted code without the server.
- `--write-env` upserts `CANARY_JUDGE_OAUTH_REFRESH_TOKEN='…'` into
  `.env.local` (replace an existing line, else append). Never print or log
  the client secret.
- Verify at the end: call `users.getProfile` with the new token and print the
  address it belongs to, warning loudly if it is not `CAMPAIGN_CANARY_TO`.

## Task 2 — judge pass in the engine

Add `judgePass()` and run it AFTER `canary` and BEFORE `health` in the pass
list. New `scripts/canary-judge.mjs` holds the pure logic + the Gmail read
so the engine file stays thin.

Behaviour:

- Skip silently (one log line) when `CANARY_JUDGE_OAUTH_REFRESH_TOKEN` is
  unset. The Telegram path keeps working exactly as today.
- For each sender with a canary recorded for today in the health state
  (`st[day].canary[sender.email] = "C<n>"`) and NO verdict for today in its
  sender state: search the judge mailbox for
  `from:<sender.email> subject:"[C<n> <label>]" newer_than:3d`, take the
  newest match, read `labelIds`, map to a verdict, and persist it with
  `withCanaryVerdict` + `saveSenderState`. Then persist `canary_judged` on the
  health state day so the pass does not re-query every 20 minutes.
- Give Gmail a beat: only judge on a pass at least 20 minutes after the canary
  went out. Store `canary_at: { [sender]: ISO }` in the health state from
  `canaryPass()` (additive; existing readers only look at `canary`).
- Verdict mapping (pure function `verdictFromLabels(labelIds)`):
  - contains `SPAM` → `spam`
  - else contains any of `CATEGORY_PROMOTIONS`, `CATEGORY_SOCIAL`,
    `CATEGORY_UPDATES`, `CATEGORY_FORUMS` → `promotions`
  - else contains `INBOX` → `primary`
  - else (archived/trashed/unknown) → `null`, treat as not found.
- Never overwrite a verdict Ryan already recorded for that day (his Telegram
  reply is the override).
- Telegram: ONE line per day once every sender with a canary is judged, e.g.
  `🐤 judge: buys C8 → Primary · offers C8 → Promotions`. Spam or
  Promotions verdicts go out immediately rather than waiting for the
  other sender.
- Not found by the health pass hour (after 5:15 PM PT, pass still unjudged):
  Telegram `⚠️ judge: canary C8 buys not in the judge inbox — reply "canary
  buys primary|promotions|spam"` once, record nothing. Silent failures are
  banned on this project.
- Auth/API failure: one Telegram alert per day (`⚠️ judge: Gmail auth failed
  (invalid_grant) — rerun scripts/canary-judge-consent.mjs --write-env`), log
  the error, return. The engine's other passes must be unaffected.
- `--dry-run --judge-now`: run the read and print what WOULD be recorded, write
  nothing, send nothing.
- `--judge-backfill`: for every canary message in the judge inbox from the
  last 30 days (`subject:"[C" newer_than:30d`), derive sender from `from:`,
  the PT day from `internalDate`, and record a verdict for any (sender, day)
  that has none. Prints a table; `--dry-run` prints without writing. This is
  how the Oct 5–12 history gets filled on the first run.

## Task 3 — stall watchdog in the health report

In `healthPass()`'s per-sender Telegram lines (search for `senderLines.push`),
when a sender's decision is `hold`, `healthy_days >= gates.minHealthyDays`,
and the ONLY failing check is the canary gate, prepend a loud line at the top
of the report:

`🚨 ramp stalled: buys has 7 healthy days but only 1/3 canary verdicts — the
judge is not recording. Check CANARY_JUDGE_OAUTH_REFRESH_TOKEN or reply
"canary buys primary|promotions|spam".`

Pure helper `stallReason(evaluation, gates)` in `scripts/canary-judge.mjs`,
unit-tested. One line per stalled sender, only when stalled.

## Tests

`tests/canary-judge.unit.test.ts`: `verdictFromLabels` (all four branches),
subject/sender parsing for backfill, PT-day derivation from `internalDate`,
`stallReason` (stalled vs held on bounces vs advancing), and "never overwrite
an existing verdict".

## Out of scope

- Do NOT change draft/send/canary budgets, the ramp ladder, gates, or any
  template. No new dependencies. No DB migrations.
- No PR, no merge. Push the branch, run tsc + vitest, stop and report with a
  summary of files changed and the exact Mac-mini steps to go live
  (env vars to add, consent command, first `--judge-backfill` run).
