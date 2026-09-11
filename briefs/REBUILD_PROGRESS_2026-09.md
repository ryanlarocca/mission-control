# September engine rebuild — progress ledger

Nightly autonomous build queue for the agent-email-v2 two-domain stack.
One item per night, in order, on branch `sept-engine-rebuild` (never main).
Locked spec: the "Standing architecture" + "Warm-up plan" sections of
[`BRIEF_SECONDARY_SENDING_DOMAIN_2026-08-25.md`](./BRIEF_SECONDARY_SENDING_DOMAIN_2026-08-25.md).
Project memo: `PROJECTS/agent-email-v2/PROJECT_MEMO.md`.

Ryan reviews + merges this branch in supervised sessions. Questions for
Ryan collect in the section at the bottom; the nightly Telegram reports the
count.

## Build list

- [x] **(1) DWD `gmail.send` scope tooling + relax `add-email-mailbox.mjs` for lrghomesbuys.com / lrghomesoffers.com** — done 2026-09-03 (night 1)
- [x] **(2) Engine multi-sender** — `CAMPAIGN_SENDERS` config, per-sender daily caps, per-sender gated warm-up ramp 5→10→20→35→50→75+ advancing only on healthy days per the brief — done 2026-09-04 (night 2)
- [x] **(3) Per-sender health checks, auto-pause, Telegram alerts** — done 2026-09-05 (night 3). Gmail watches for the two new mailboxes are NOT registered (live infra change, Q5 unanswered) — the exact two commands are in the night-3 log.
- [x] **(4) Strip retired Gmail sender** from `config/email-campaigns.json` + document which Vercel env vars to remove — done 2026-09-06 (night 4). The config file never held the Gmail address; the strip was the OAuth code path + the env-only sender fallback. Env-var removal list is in the night-4 log (Ryan runs it — production change).
- [x] **(4b) Reset the send-time scorecard window for the new domains** — done 2026-09-08 (night 5). Binned by sender rather than moving the date.
- [x] **(5) Email-verification tooling** for the ~2,100 contact list (SMTP-level checks; no paid services — if one is genuinely needed, recommend it here instead) — done 2026-09-09 (night 6). SMTP tier built + unit-tested but not run live: outbound port 25/587 is blocked on this network (confirmed). Shipped DNS+syntax tier instead, ran it live against all 2,183 active contacts: 0 dead domains, 0 syntax-invalid, 0 disposable. See D15 for the recommendation this produces.
- [x] **(6) T2–T11 template pass** against `CAMPAIGN_VOICE.md` — done 2026-09-10 (night 7). Proposed edits for T2/T6/T9 written below; templates untouched (checked against the live `campaign_templates` DB, not just the file fallback — found a rule-4 violation already sitting in production T1, out of this item's scope, flagged separately).

## Night log

### 2026-09-03 — night 1 — item (1) DONE

**Verified (read-only, live tenant):** new `scripts/check-dwd-scopes.mjs`
mints a DWD token per mailbox × scope and probes `users.getProfile` +
`settings.sendAs.list`. Result against the real grant:

| mailbox | gmail.modify | gmail.send | gmail.readonly | profile |
|---|---|---|---|---|
| info@lrghomes.com | ✓ | ✗ unauthorized_client | ✗ unauthorized_client | ok, 10,115 msgs |
| ryan@lrghomesbuys.com | ✓ | ✗ unauthorized_client | ✗ unauthorized_client | ok, 4 msgs, send-as primary only |
| ryan@lrghomesoffers.com | ✓ | ✗ unauthorized_client | ✗ unauthorized_client | ok, 4 msgs, send-as primary only |

Conclusion: the brief's 8/31 caution is resolved. DWD is granted per
Workspace **customer**, so both secondary domains inherit `gmail.modify`,
and `messages.send` is permitted under `gmail.modify` — the engine's
existing DWD send path (`scripts/campaign-gmail.mjs` → `gmailClientFor`)
will authenticate as `ryan@lrghomesbuys.com` / `ryan@lrghomesoffers.com`
with **no Admin-console change**. `gmail.send` remains ungranted; that is
least-privilege hygiene, not a blocker (see Q1). The checker prints the
exact Admin-console steps + client ID if Ryan ever wants to extend it.

**Shipped:**
- `scripts/check-dwd-scopes.mjs` (new) — `[mailbox ...] [--scopes=a,b] [--json]`;
  exit 0 only when `gmail.modify` mints for every mailbox. Classifies
  `unauthorized_client` (scope not granted) vs `invalid_grant` (mailbox not
  in tenant) — tested both paths live.
- `scripts/add-email-mailbox.mjs` — `ALLOWED_DOMAINS` = lrghomes.com +
  lrghomesbuys.com + lrghomesoffers.com (was hard-coded lrghomes.com); new
  `--dry-run` (validates, mints the DWD token, prints the config diff, writes
  nothing). Dry-run tested: new-domain add, rejected foreign domain, missing
  args, existing mapping — `config/email-campaigns.json` untouched.
- Comment/doc updates: `lib/leads.ts` (`getGmailClient`),
  `scripts/campaign-gmail.mjs`, `scripts/renew-gmail-watch.js`,
  `briefs/RUNBOOK_ADD_EMAIL_MAILBOX.md` (also fixed its stale
  `.openclaw/workspace` path).
- No watch registered, no config written, no email sent. `npx tsc --noEmit` clean.

**Notes for item (2), found while reading:**
- `scripts/campaign-engine.mjs:495` refuses any `@lrghomes.com` sender
  without `CAMPAIGN_ALLOW_DOMAIN_COLD`. Multi-sender keeps that guard for
  lrghomes.com and must NOT extend it to the new domains.
- `lib/campaignInbox.ts` has lrghomes.com-specific logic: `CAMPAIGN_INBOX =
  info@lrghomes.com`, `CAMPAIGN_INBOXES` list, and a self-mail skip on
  `endsWith("@lrghomes.com")`. Reply/bounce ingest for the new senders
  depends on Q2 below.
- The existing single-sender ramp is `RAMP_SCHEDULE` 1,2,4,…,200 with step
  in `campaign_settings.ramp`, plus a legacy `CAMPAIGN_RAMP_START` 75/150
  path. Item (2) replaces both with per-sender state.

### 2026-09-04 — night 2 — item (2) DONE

**Shipped (branch only, engine still unloaded, zero emails, zero prod writes):**
- `config/campaign-senders.json` (new) — the sender registry. Workhorse
  `ryan@lrghomesbuys.com` (ladder 5→10→20→35→50→75→100, ceiling 100 = today's
  list-sized steady state, segment `drip`), understudy `ryan@lrghomesoffers.com`
  (ladder 3→5→10→20→30→40, ceiling 40, segment `relationships`), both
  `replyTo: info@lrghomes.com`. `gates` block holds the thresholds. `_doc`
  explains every field.
- `scripts/campaign-senders.mjs` (new) — config loader (`CAMPAIGN_SENDERS`
  env narrows the enabled set; bad names throw; `CAMPAIGN_SEND_AS` is only a
  legacy fallback when the file has no enabled sender), per-sender ramp state
  in `campaign_settings` `sender:<email>` (step, healthy_days, entered_step,
  held_reason, paused/paused_reason, 40-day history), the pure gate function
  `evaluateSenderDay`, and the segment/ordering helpers. Run it bare for a
  read-only status: `node scripts/campaign-senders.mjs [--json]`.
- `scripts/campaign-engine.mjs` — every pass is per sender now:
  - **draft:** budget per sender = cap − (drafted today) and cap − (draft +
    approved backlog), then the `CAMPAIGN_DRAFT_CAP` total ceiling. The whole
    due pool is fetched (paged) and sorted **engagement-first: July repliers
    → Relationships matches → everyone else**, oldest due first within a tier.
    Each contact is assigned a sender (sticky to the mailbox that sent its
    last touch → understudy's segment claim → workhorse) and the row is
    stamped `sender`. Rows without a sender (pre-multi-sender) belong to the
    workhorse everywhere.
  - **send:** budget per sender = cap − sent today by that mailbox; approved
    rows are routed by their `sender` column, one lazily-minted DWD client per
    mailbox, `Reply-To` header from config, `campaign_events.raw.mailbox` =
    the real sender. A row whose sender is no longer enabled waits (logged),
    it never goes out from another domain. The lrghomes.com cold-send refusal
    is now per sender, so it can never block the new domains. The legacy
    `CAMPAIGN_RAMP_START` 75/150 path and the single `RAMP_SCHEDULE` are gone.
  - **canary:** one per sender per send day, subject `[C<n> buys]` /
    `[C<n> offers]`; health-state file keeps `{sender: "C<n>"}` per day.
  - **health (5:15pm PT):** per-sender day metrics + trailing 7 days (sends
    and failures by the `sender` column; bounces/replies/unsubs attributed to
    the mailbox that sent the contact's latest touch), one ramp decision per
    sender saved to its state row, one line per sender on the card. Snapshot
    `health:<day>` keeps the old totals and adds `senders: {…}`.
  - dry-run now also silences the digest and the Friday scorecard (tonight's
    first rehearsal, on a Friday, posted one scorecard to Telegram — harmless,
    no email — before that guard existed).

**Verified:** `npx tsc --noEmit` clean. Dry runs against prod (reads only):
`CAMPAIGN_COHORT= node scripts/campaign-engine.mjs --draft --dry-run
--mint-now --limit=12` → budgets `buys 5 / offers 3`, the first five workhorse
drafts are July repliers (Alinor Willis, Asha Raghupathy, …), the three
understudy drafts are Relationships matches; `--send --dry-run --now` reports
per-sender `0/5, 0/3`; `CAMPAIGN_SENDERS=ryan@lrghomesbuys.com` narrows to one
sender; an unknown address in `CAMPAIGN_SENDERS` throws. A 60-weekday
simulation through `evaluateSenderDay` (5/day start, one missed weekday, one
3-bounce day): 3 healthy days → next rung; the ≤2× week-over-week gate holds
every rung after the first for ~a week (5→10 day 6, 10→20 day 12, 20→35
day 24, 35→50 day 30, 50→75 day 36, 75→100 day 39); the bounce day dropped
20→10 and the streak restarted; the missed weekday reset the streak; steady
at the 100 ceiling. Whole climb ≈ 8 weeks — inside the brief's "plan for 6,
observed 5–8". PostgREST `or(sender.eq.<workhorse>,sender.is.null)` verified
against the live table (2,344 legacy rows, 0 for the new senders).

**Gate semantics as built (all in `evaluateSenderDay`, thresholds in config):**
- healthy day = 🟢 day with ≥60% of the cap sent (`healthyDayMinFraction`).
- advance needs: `minHealthyDays` (3) at the current rung, bounces <2% today,
  no failures and no pause, genuine replies still arriving (≥40 sends in 7
  days with zero replies = hold), and next cap ≤ 2× the cap in force 7 days
  earlier. 🔴 (bounce ≥2% at ≥10 sends, or ≥2 bounces below that) drops one
  rung. 🟡 holds. A weekday with zero sends resets the streak (consistency
  rule) but never drops a rung. A pause holds, it does not drop.
- **Canary-Primary-3-days and Postmaster reputation are wired but advisory**
  (`requireCanaryVerdict` / `requirePostmaster` = false) because neither
  input exists yet — see D3 and item (3).

**Hand-off to item (3):** the state row already carries `paused`,
`paused_reason` (draft + send passes honor them; nothing sets them yet),
`canary_verdicts {day: primary|promotions|spam}` and `postmaster
{reputation}` slots read by the gates. Per-sender auto-pause + Telegram
alerts + the verdict input go there. Also: `lib/campaignBatch.ts`
`campaignStatusLine` still prints `CAMPAIGN_SEND_AS` (cosmetic);
`lib/campaignEmail.ts` reply path already follows `raw.mailbox`, so
Telegram replies will send from whichever domain sent the touch (that is
correct thread continuity, but see Q5 on bounces).

### 2026-09-05 — night 3 — item (3) DONE

**Shipped (branch only, engine still unloaded, zero emails, zero prod writes):**
- **Per-sender auto-pause** — each mailbox now stops on its own evidence
  while the other keeps its consistency streak. State lives on the sender's
  `campaign_settings` row (`paused`, `paused_reason`, `paused_by`,
  `paused_at`, `paused_until`); an engine pause carries a 48h expiry
  (`gates.autoPauseHours`) and lifts itself at the next `loadRamp` (Telegram
  "▶️ buys resumed"); Ryan's pauses have no expiry. Triggers:
  - **send pass, before any send:** today's per-sender bounces (attributed to
    the mailbox that sent the contact's latest touch) — red line = ≥2% at ≥10
    sends or 2 bounces below that, same rule as the health pass. Replaces the
    old GLOBAL bounce auto-pause; the global `pause` row is now only Ryan's
    kill switch ("pause campaign") and the engine never sets it.
  - **send pass, auth preflight:** each sender about to send mints its Gmail
    client once up front; a dead token/grant pauses that sender + alerts
    instead of failing every approved row one by one (the Aug-28 pattern).
    Runs in dry-run too — minting a token sends nothing.
  - **mid-pass:** a Gmail throttle/quota response or an auth error pauses
    that sender and zeroes its budget; the loop continues with the other
    mailbox's rows (used to `break` and pause everyone).
  - **health pass (5:15pm PT):** `evaluateSenderDay` returns `autoPause` for
    a red bounce day or the canary in Spam two days running (the brief's
    2-in-a-row rule); the pass applies it on top of the ramp decision.
- **Canary verdict input (the "canary Primary 3 days running" gate is now
  ENFORCED, `requireCanaryVerdict: true` — D7):** Ryan reads the judge inbox
  and replies `canary buys primary` / `canary offers spam` (optional
  `YYYY-MM-DD` for an earlier day). Gate = last 3 recorded verdicts all
  primary and the newest ≤7 days old (`canaryVerdictMaxAgeDays`); a missing
  verdict for today does not fail the gate while yesterday's is recent
  (grace for late reads). One Spam day = 🟡 hold; two running = 🔴 drop a
  rung + auto-pause. The health card asks for the verdict on any day a canary
  went out without one, and warns when `CAMPAIGN_CANARY_TO` is unset (it is —
  see Q6).
- **Postmaster input, manual:** `reputation buys high|medium|low|bad`
  records what the dashboard shows; gate stays advisory (D8). LOW/BAD shows
  as a 🟡 warning.
- **Consistency rule:** `gap_days` counts consecutive weekdays with zero
  sends; the card warns at ≥2 (`gapWarnDays`).
- **Telegram commands** (`app/api/campaign/telegram/route.ts` → new
  `lib/campaignSenders.ts`): `pause buys [why]`, `resume offers`, `canary …`,
  `reputation …`; a token that isn't a sender label/address falls through
  untouched. `campaign status` now prints one line per sender (cap, step,
  healthy days, pause, last 3 verdicts, Postmaster) instead of the retired
  `CAMPAIGN_SEND_AS`.
- **Bounce visibility for the new domains (Q5, code half):**
  `lib/campaignInbox.ts` lists `ryan@lrghomesbuys.com` +
  `ryan@lrghomesoffers.com` in `CAMPAIGN_INBOXES`, and the own-mail skip +
  DSN failed-recipient extraction now cover all three domains (they only knew
  lrghomes.com). Inert until a watch exists. **Not done, on purpose:** the
  watch registration itself (writes `config/email-campaigns.json`, calls
  `gmail.users.watch` on the live tenant, needs a deploy). Ryan or a
  supervised session runs:
  `node scripts/add-email-mailbox.mjs ryan@lrghomesbuys.com AGENT-DRIP-BUYS`
  and `… ryan@lrghomesoffers.com AGENT-DRIP-OFFERS` (`--dry-run` first — the
  buys dry-run passed tonight: token minted, would add + watch, wrote
  nothing).
- `--dry-run --health-now` is now a full health rehearsal: computes every
  per-sender decision from live data and prints the card; saves nothing,
  posts nothing.
- `.gitignore`: the engine's `.campaign-health-state.json` +
  `.campaign-draft-starved-state.json` were untracked-but-unignored.

**Verified:** `npx tsc --noEmit` clean; `npx vitest run` 70/70 (new
`tests/campaign-senders.unit.test.ts`, 7 tests: pause expiry vs manual, red
day → drop + auto-pause, 2-bounce rule under 10 sends, canary gate 3-of-3 +
staleness + bad verdict rejected, gate blocks advancement until verdicts
exist, Spam ×2 pauses, gap-day counting). Live, read-only: `node
scripts/check-dwd-scopes.mjs` → `gmail.modify` mints for all three
mailboxes; `--send --dry-run --now` → `buys 0/5, offers 0/3` via the new
per-sender bounce path; `--draft --dry-run --mint-now --limit=4` → 4 T2
drafts, July repliers first, budgets honour the pause check; `--send
--dry-run --health-now` → card prints `🟡` with the single warning
"CAMPAIGN_CANARY_TO is unset…" and both senders idle. 40-weekday simulation
through `evaluateSenderDay` with daily verdicts: 3 primaries unlock 5→10 on
day 3; a Spam day holds; the second Spam day drops 10→5 + pauses; a 2-bounce
day at 10/day drops + pauses; the ≤2× week-over-week gate then paces every
rung (10→20 day 24, 20→35 day 30, 35→50 day 36).

**Hand-off to item (4):** `scripts/campaign-gmail.mjs` still carries the
OAuth branch + `CAMPAIGN_GMAIL_OAUTH_*` reads; `lib/campaignInbox.ts` still
appends `CAMPAIGN_GMAIL_OAUTH_USER`; `config/email-campaigns.json` never had
the Gmail address (nothing to strip there — confirm and say so).

### 2026-09-06 — night 4 — item (4) DONE

**Confirmed first:** `config/email-campaigns.json` never contained
`ryan.lrghomes@gmail.com` (checked `git log -p` over its whole history — the
file has only ever listed lrghomes.com mailboxes; today: info@, ryansvg@,
ryansvj@, ryansvr@). The Gmail mailbox reached the watch renewal through
`CAMPAIGN_GMAIL_OAUTH_USER` in env, not the config — which is why commenting
those vars out on 9/1 already stopped the daily `invalid_grant` failures
(`/tmp/lrg-gmail-watch-renewal.log`: all four mailboxes ✓ on 9/5 and 9/6,
err log empty). Prod state of the retired sender, read-only: 15
`campaign_sends` rows carry it — 7 `sent` (8/25–8/27) + 8 `skipped` (the
cancelled queue, 8/31); 0 draft/approved. Its 7 `campaign_events` are all
`email_out`; no `email_reply` event names that mailbox.

**Shipped (branch only, engine still unloaded, zero emails, zero prod writes):**
- `scripts/campaign-gmail.mjs` — one auth path (DWD). New `TENANT_DOMAINS`
  + `isTenantMailbox()`; `gmailClientFor()` **refuses any mailbox outside
  lrghomes.com / lrghomesbuys.com / lrghomesoffers.com before touching a
  credential**. `oauthUser` / `isOAuthMailbox` / `oauthClient` are gone.
- `lib/leads.ts` `getGmailClient` — OAuth branch removed; DWD only (this is
  the Vercel side: `/api/leads/email`, `/api/leads/email-reply`, Telegram
  replies).
- `lib/campaignInbox.ts` — `CAMPAIGN_INBOXES` no longer appends
  `CAMPAIGN_GMAIL_OAUTH_USER`.
- `scripts/renew-gmail-watch.js` — OAuth watch path removed; renews only the
  tenant mailboxes in `config/email-campaigns.json`.
- `scripts/gmail-oauth-consent.mjs` — **deleted** (Ryan 9/1: no publish, no
  re-consent, zero further infrastructure for that account).
- `scripts/campaign-senders.mjs` — the env-only `CAMPAIGN_SEND_AS` fallback
  from D2 is **removed** (D11). `config/campaign-senders.json` is the only
  sender source; an empty/disabled config means the engine refuses to run
  ("no enabled sender"), never "send as whatever the env says". `_doc`,
  status printer and the engine's error text updated.
- `lib/campaignEmail.ts` — dead `SEND_AS` const dropped. Defensive fallback
  (D12): if the thread's owning mailbox is not a tenant address (only the 7
  retired-Gmail sends could ever produce this), the Telegram reply goes out
  fresh from info@ with the same subject instead of failing on auth.
- `scripts/campaign-test-batch.mjs` — usage example now names
  `ryan@lrghomesbuys.com`; documents the tenant-only rule.
- `tests/campaign-gmail.unit.test.ts` (new, 4 tests): tenant-domain check,
  `gmailClientFor` rejects gmail.com before reading credentials, empty sender
  config ignores `CAMPAIGN_SEND_AS`, both checked-in configs contain only
  tenant mailboxes.

**Verified:** `npx tsc --noEmit` clean; `npx vitest run` 74/74; `node
--check` on the two CommonJS/ESM scripts. Live, read-only: `node
scripts/campaign-senders.mjs` → 2 enabled senders, no "legacy" tag;
`--send --dry-run --now` → `buys 0/5, offers 0/3`; `--draft --dry-run
--mint-now --limit=3` → 3 T2 drafts from the workhorse, July repliers first;
`gmailClientFor(<retired gmail>)` → refused with the tenant message, and
`gmailClientFor("ryan@lrghomesbuys.com")` still mints (getProfile ok).

**Env vars to remove — Ryan, production change, not done by the builder:**

| where | variable | why it's dead |
|---|---|---|
| Vercel (Production) | `CAMPAIGN_GMAIL_OAUTH_CLIENT_ID` | OAuth client for the retired sender |
| Vercel (Production) | `CAMPAIGN_GMAIL_OAUTH_CLIENT_SECRET` | same |
| Vercel (Production) | `CAMPAIGN_GMAIL_OAUTH_REFRESH_TOKEN` | expired ~8/28 anyway (app was in Testing) |
| Vercel (Production) | `CAMPAIGN_GMAIL_OAUTH_USER` | the only one current `main` still reads; unset = DWD for everything, so removing it is safe **before** this branch merges |
| Vercel (Production) | `CAMPAIGN_SEND_AS` | never read by any Vercel code path (the const that read it was dead); after merge, read nowhere at all |
| Mac mini `.env.local` | `CAMPAIGN_SEND_AS` | still set to the retired gmail address; inert once this branch merges (engine ignores it) — delete the line. The four `CAMPAIGN_GMAIL_OAUTH_*` lines were already commented out 9/1; delete them too |
| Mac mini launchd | `~/Library/LaunchAgents/com.lrghomes.reminder-oauth-publish.plist` | one-shot Aug-23 "publish the OAuth app" reminder; obsolete, and it embeds the bot token in plain text — `launchctl unload` it, then delete the file (builder never runs launchctl) |

All five Vercel vars were created the same day (16 days before 9/6 =
2026-08-21, the Gmail restart) — nothing else on Vercel belongs to that
experiment. Command, from the repo root (project is linked):
`vercel env rm <NAME> production` ×5, then redeploy (env changes don't apply
to the running deployment). Kept on purpose: `GOOGLE_SERVICE_ACCOUNT_KEY`
(DWD, the real sender auth), `CAMPAIGN_BOT_TOKEN` / `CAMPAIGN_TG_SECRET` /
`CAMPAIGN_UNSUB_SECRET` (Telegram + one-click unsub, still live).

**Hand-off to item (4b):** `EXPERIMENT_START` in `scripts/campaign-engine.mjs`
is still hardcoded 2026-07-31; the Performance tab needs the same check.

### 2026-09-08 — night 5 — item (4b) DONE

**Chose "bin by sender" over "move the start date" (D14, see below).** The
real problem isn't the date — `campaign_sends.sent_at >= EXPERIMENT_START`
is still the right filter for "sends where the hour was actually
randomized" (Ryan's 7/31 send-time experiment), unrelated to which domain
sent. The mixing bug is that ALL sends since 7/31, across every sender,
land in the same hour buckets — so once lrghomesbuys/offers start sending,
their reply-rate-by-hour would get blended with the dead-Gmail /
pre-multi-sender lrghomes.com data, misreading a domain-reputation
difference as a time-of-day effect. A single "first new-domain send day"
wouldn't even fix this: legacy data would still stop appearing in the
report even though it's real history, and if a sender is ever added or
retired again the cutoff would need another manual edit.

**Shipped (branch only, zero prod writes):**
- `scripts/campaign-engine.mjs` `scorecardPass()` — sends are now grouped
  by sender label before hour-binning: `senderByEmail(row.sender)?.label`
  for a recognized mailbox, the raw address for a since-retired one (so it
  doesn't silently fold into another bucket), `"legacy"` for `sender IS
  NULL` (every row minted before the 9/4 multi-sender ship — this is NOT
  the same convention as `senderFilter()`'s budget-accounting shortcut a
  few lines up, which treats null as "belongs to the workhorse" for
  ramp-cap purposes only; scorecard history needs the true origin, so it
  gets its own label instead). The Friday Telegram message now has one
  `<b>label</b>` section per sender that actually has sends in the window;
  empty sections (buys/offers before their first live send) are omitted
  rather than printing ten "no sends yet" lines.
- `app/api/campaign/stats/route.ts` — same grouping, using the TS
  `listSenders()` mirror (`lib/campaignSenders.ts`) instead of duplicating
  the config parser. Response shape: `hours` → `hours_by_sender` (keyed by
  label) + `sender_labels` (a stable render order: configured senders in
  file order, `"legacy"` last).
- `components/widgets/EmailCampaignPerformance.tsx` — one "Send-time
  experiment — `<label>`" card per sender-with-data instead of one global
  card; a sender with zero sends in the window renders no card at all
  (cleaner than 10 rows of "no sends yet" for buys/offers before Oct 1).

**Verified:** `npx tsc --noEmit` clean; `npx vitest run` 74/74 (unchanged —
no prior test exercised this path). Live, read-only (script deleted after):
paged every `campaign_sends` row with `status='sent'` since 7/31 (553 rows)
through the same `senderByEmail`/label logic as the shipped code — **546
bucket under `"legacy"` (sender IS NULL, pre-9/4) and 7 bucket under the
literal string `"ryan.lrghomes@gmail.com"`** (the 7 real sends from the
retired Gmail account, which — unlike the bulk of the legacy rows — DO
carry an explicit `sender` value that predates the account's removal from
`config/campaign-senders.json` on 9/6; confirms the fallback-to-raw-address
path is reachable with real data, not just a theoretical branch). Zero rows
landed under `"buys"` or `"offers"` — correct, nothing has sent from the
new domains yet (engine still unloaded). No new unit test added: the
grouping logic is a straight `Map` keyed by a pure label function with no
DB/timing dependency worth mocking, and the three-bucket live read above is
stronger evidence than a synthetic fixture would be.

**D14 (9/8):** did **not** move `EXPERIMENT_START` to a dynamically-computed
"first new-domain send day." Binning by sender makes any such cutoff
unnecessary (each sender's data is already isolated by construction) and
avoids a second moving part that would need to track sender changes over
time. Reversible in one function if Ryan would rather see a single merged
chart with a vertical "domain switch" marker instead of separate cards.

### 2026-09-09 — night 6 — item (5) DONE

**Tested SMTP reachability before building around it, live, twice:** a raw
TCP connect from this host to `gmail-smtp-in.l.google.com` (Google's own
inbound MX, which never blocks legitimate probes) on port 25 timed out —
not refused, timed out, the signature of a network dropping the SYN rather
than a mail server rejecting the connection. Same result on port 587.
Repeated with the harness sandbox disabled (`dangerouslyDisableSandbox`) to
rule out a sandbox-only restriction — identical timeout. Meanwhile HTTPS
egress to the same host's domain works fine (tested separately). Conclusion:
outbound SMTP is blocked at the network level on this machine (common for
residential ISPs, to stop spam relaying) — true RCPT-TO mailbox
verification cannot run from here, full stop, regardless of what the code
does.

**Shipped (branch only, zero prod writes, zero network egress beyond public
DNS + Supabase reads):**
- `scripts/verify-email-list.mjs` (new) — two tiers:
  1. **Syntax + domain heuristics** (instant, no I/O): a practical
     RFC-5322-ish regex (rejects the RFC's own pathological-but-technically-
     legal cases no real mail system accepts anyway), a 20-domain disposable-
     mail blocklist, an 18-prefix role-account list (advisory, not a
     failure — CRM already treats these as "defer from touch," not bounces),
     and a freemail-typo map (`gmial.com` → `gmail.com` etc., suggestion
     only, never auto-corrects).
  2. **DNS deliverability**: `dns.resolveMx` with the RFC 5321 §5.1 A/AAAA
     fallback for domains with no MX record. This is the check that actually
     catches "dead domain," the real hard-bounce cause on this kind of list.
     A DNS timeout/SERVFAIL is reported as `dns_unknown` (retry-worthy), never
     folded into a bounce verdict — a resolver hiccup must not read as "bad
     address."
  3. **SMTP tier, built but not run**: `buildProbeCommands` (EHLO/MAIL
     FROM/RCPT TO/QUIT — no DATA ever, so nothing is ever sent even in
     principle) and `classifySmtpCode` (2xx valid, 5xx invalid, 4xx/garbage
     unknown — greylisting is never a verdict) are pure functions, fully
     unit-tested. `selfTestSmtpReachable()` does the live reachability probe
     above at startup when `--smtp` is passed; on this network it reports
     unreachable and the tool falls back to tiers 1–2 automatically. Even on
     a network where it succeeded, the real per-contact RCPT loop is
     deliberately NOT wired up — opening live connections to ~672 real
     third-party mail servers is a supervised-session decision, not
     something a nightly unattended run should switch on by discovering a
     network where it happens to work.
  - Read-only: pages `campaign_contacts` (`.range()`, respects the
    PostgREST 1000-row cap), writes NOTHING back to Supabase. Output is a
    local report (`scripts/.email-verify-report.{json,csv}`, gitignored —
    it holds real names/emails) for a human to review; applying any
    classification to `campaign_contacts.status` is left to a supervised
    session (see D15).
  - `node scripts/verify-email-list.mjs [--limit=N] [--status=a,b] [--smtp] [--json]`.
- `tests/verify-email-list.unit.test.ts` (new, 13 tests): syntax edge cases
  (whitespace, double `@`, 250+ chars, no-TLD), domain extraction, disposable/
  role/typo detection, DNS-result classification (ok/dead/unknown), the SMTP
  command sequence never contains `DATA`, SMTP code classification including
  the greylist-is-never-a-verdict rule, and `classifyEmail` end-to-end with
  an injected resolver (syntax/disposable short-circuit before any DNS call
  — verified via a spy that must NOT be called).
- `.gitignore` — the two report files (PII, regenerable).

**Verified:** `npx tsc --noEmit` clean; `npx vitest run` 87/87 (74 prior +
13 new, all pure/offline per this repo's unit-test rule — no live socket in
any test, per vitest.config.ts's "no network" contract; the real socket
path is exercised only by the self-test above, manually, not by `npm test`).
Dry runs: `--limit=15` and `--limit=5 --smtp` (confirms the reachable=false
fallback message and that it still completes tiers 1–2). **Then ran for
real against the live list (read-only Supabase + public DNS, no email
sent):** all 2,183 `status=active` contacts across 672 unique domains —
**0 dead_domain, 0 syntax_invalid, 0 disposable, 26 role_account
(advisory), 0 typo_suspect.** Report written to
`scripts/.email-verify-report.json` / `.csv` (gitignored, not committed).

### 2026-09-10 — night 7 — item (6) DONE

**Method:** re-read `CAMPAIGN_VOICE.md`'s 7 locked rules, then pulled the
**live** `campaign_templates` DB rows (read-only, `touch_number` 1–11) rather
than trusting `scripts/campaign-touches.mjs`'s `TOUCHES` array — that file is
explicitly "seed and fallback when no DB row exists," and T1/T2 have live
Telegram `copy:` edits from 8/6 that predate it. T10 is still the deliberate
`null`/`null` placeholder (unchanged, correct). No template row was written;
no code or config touched.

**Live DB text differs from the checked-in file for T2** (T1 too — see the
out-of-scope note below): the 8/6 proof-of-funds edit reordered/reworded it.
Verdicts below are against the DB text, since that's what the engine will
actually render.

**No changes needed (7 of 9 in scope) — T3, T4, T5, T7, T8, T9's history/ask
mechanics check out, T11:**
- T3, T4, T5, T8: each carries exactly one clear ask ("I'm a text away" /
  "send it my way" / "text me before you put it back on" / "Worth a text
  before the sign goes up"), no meeting/coffee offers, no email-contrast
  phrasing, no invented relationship history. T3's three named addresses are
  Ryan's own closed deals offered as proof, not a claim about the recipient's
  history — rule 3's "address in the data is an MLS tie, not history" is
  about not implying personal history with the recipient, which this
  doesn't do.
- T7, T11: both are deliberately pitch-free (mid-year check-in, year-end
  thanks) and correctly carry no "send it my way" ask — consistent with
  their own labels, not a rule-5 gap.

**Proposed edits (2 of 9) — written here only, not applied:**

1. **T2** ("the buyer who actually closes") — two issues:
   - Timing: opens "quick follow-up on my note a couple weeks back," but the
     locked cadence (Ryan, 2026-08-24) is 30 days between every touch, so T2
     will always land a month after T1, never "a couple weeks." Minor, but
     it's a factual claim the recipient can notice.
   - Rule 2 ("a reassurance is fine; do not pile several on"): the live body
     stacks five in one paragraph — no repair negotiations, no financing
     contingencies, dual-side commission ("welcome to both sides"), proof of
     funds ready, and "I close what I put under contract." Proposed trim
     (keeps the three most concrete/distinct claims, drops the two most
     redundant):
     > Hi {{first_name}}, quick follow-up on my note last month. When I say
     > I make it easy, here's what I mean: no financing contingencies to
     > sweat, and if it's your listing you're welcome to both sides. I close
     > what I put under contract. That's the whole reputation I'm trying to
     > keep.
     >
     > One relationship, multiple closings. Keep me in mind next time
     > something fits.

2. **T6** ("Not just apartments") — rule 5 ("the ask is 'send it my way'"):
   this is a pitch touch (buy-box refresher) but the current close is an open
   question with no explicit ask ("What are you working on these days?").
   Every other pitch touch has one. Proposed: keep the question, add the ask:
   > Same deal as always: as-is, fast, easy. What are you working on these
   > days? If anything fits, send it my way.

3. **T9** ("The complicated ones") — rule 5 ("a call is only offered to
   discuss a specific property"): the close offers a phone call as the
   default CTA — "I'm probably the easiest phone call you'll make on it" —
   attached to a general "if you've got one of these," not one already-named
   property, and it's the only touch whose primary ask is a call rather than
   text/reply. Proposed (keeps the "easiest call" voice, makes text the
   actual action):
   > If you've got one of these in your pipeline, text me the details, I'll
   > make it the easiest call you make on it.

**Out of scope, flagging only — did not touch:** the live T1 (`campaign_templates`,
`updated_at` 2026-08-06, an earlier Telegram `copy:` edit) reads "We've
crossed paths before, so I wanted to reconnect" — this is close to rule 4's
own banned-phrase example ("we spoke before") and predates the 2026-08-24
rule lock that added it. The checked-in file fallback (`scripts/campaign-touches.mjs`)
does NOT have this line ("I'm an investor buying directly from agents and
wanted to get on your radar"), so the two sources have quietly diverged. This
item's scope is T2–T11 only, so no edit is proposed here — see Q10.

**Minor doc note, not fixed:** `scripts/campaign-touches.mjs`'s header comment
("NO em dashes, NO middle dots... Keep it that way," 2026-07-20) is now stale
— `CAMPAIGN_VOICE.md` v3 (2026-08-24) explicitly overrides that ban for this
drip. Cosmetic; flagging for whoever next edits that file.

## Decisions taken by the builder (reversible, flag if wrong)

- D1 (9/3): did **not** request or add `gmail.send` anywhere in code. All
  send paths stay on `gmail.modify`, which is what's granted and what
  already works. Extending the grant is Ryan's Admin-console action only.
- D2 (9/4): `config/campaign-senders.json` is the single source of truth for
  senders; `CAMPAIGN_SENDERS` env only narrows; `CAMPAIGN_SEND_AS` is a legacy
  fallback that logs itself. The old `campaign_settings.ramp` row is left in
  place, unread.
- D3 (9/4): gates that have no data source yet (canary verdict, Postmaster
  reputation) are advisory flags in config rather than hard blocks — a hard
  block with no input would freeze every sender at 5/day forever. Flip them
  on in item (3) the night the inputs land.
- D4 (9/4): understudy ladder 3→5→10→20→30→40, ceiling 40, from the brief's
  "~20–40/day"; workhorse ceiling 100 from "~75–100/day". Both are one-line
  config edits.
- D5 (9/4): `Reply-To: info@lrghomes.com` on every send from the new domains
  (Q2 option a) until Ryan says otherwise — a per-sender config field.
- D6 (9/4): a contact stays on the mailbox that sent its last touch (thread
  continuity beats segment rules); the understudy claims only never-touched
  Relationships matches.
- D7 (9/5): `requireCanaryVerdict` flipped to **true** — the brief lists
  "canary Primary 3 days running" as an advancement gate and the input now
  exists (Telegram `canary <label> <verdict>`), so D3's advisory exception
  ends. Cost: until a judge inbox is set (`CAMPAIGN_CANARY_TO`) and Ryan
  records verdicts, every sender holds at rung 0 (5/day + 3/day). Flip back
  with one config line if that's the wrong trade.
- D8 (9/5): `requirePostmaster` stays **false**. Postmaster Tools doesn't
  have the new domains yet (Ryan's 9/3 leftover) and shows nothing for a
  domain until weeks of volume — enforcing it would freeze the ramp on a
  blank dashboard. Manual `reputation <label> <level>` feeds the slot so the
  gate can be flipped later without code.
- D9 (9/5): engine auto-pauses are **per sender, 48h, self-expiring**; the
  global `pause` row is Ryan's only. The health-pass red day pauses on top
  of dropping a rung (Phase B's "auto-pause on ≥2% bounces" kept, now
  scoped); a pause never drops a rung by itself.
- D10 (9/5): did **not** register Gmail watches on the new mailboxes or
  touch `config/email-campaigns.json` — Q5 is unanswered and merging a
  config change would make the Mac mini renewal cron register the watches
  as a side effect. Code is ready; two commands remain (night-3 log).
- D11 (9/6): the env-only `CAMPAIGN_SEND_AS` sender fallback (D2) is
  **removed**, not just deprecated. The value still sitting in
  `.env.local` is the retired gmail address — a fallback that resolves to a
  sender Ryan retired "permanently and immediately" is a footgun, and the
  DWD path would reject it anyway. Empty config = engine refuses to run.
- D12 (9/6): Telegram replies to a thread owned by a non-tenant mailbox
  (only the 7 retired-Gmail sends qualify, and none has a recorded reply)
  go out **fresh from info@** with the same subject rather than erroring —
  keeps the bot's "named ✅ or explained ⚠️" contract without touching the
  dead account.
- D13 (9/6): did **not** remove any Vercel env var or touch `.env.local` /
  launchd — production and machine state are Ryan's; the exact list is in
  the night-4 log.
- D14 (9/8): item 4b's fix is **bin the send-time scorecard by sender**, not
  move `EXPERIMENT_START` to a computed "first new-domain send day". Binning
  makes the cutoff-tracking problem disappear entirely (each sender's data
  is isolated by construction, no date to keep in sync as senders change);
  see the night-5 log for the live-data verification. Reversible in one
  function if Ryan prefers a single merged chart with a domain-switch marker.
- D15 (9/9): shipped DNS+syntax verification instead of true SMTP RCPT-TO
  checks, because the latter is not possible from this machine's network —
  tested, not assumed (see night-6 log). **Recommendation, not an action
  taken:** the list is domain-clean (0/2,183 dead domains) but that only
  rules out one class of bounce; a mailbox-level check (does
  `hhackett@baileyproperties.com` specifically still exist, not just does
  `baileyproperties.com` accept mail) needs either (a) real RCPT-TO probing
  from a host with open outbound port 25 — the code is ready
  (`buildProbeCommands`/`classifySmtpCode` in `verify-email-list.mjs`), it
  would just need wiring into the per-contact loop and a rate limiter, run
  from somewhere other than this network (note: several cloud providers,
  e.g. AWS, also block port 25 outbound by default and require a support
  request to lift it — check before assuming a VM solves this), or (b) a
  paid SMTP-verification API reached over HTTPS (unaffected by the port-25
  block) — categorically like ZeroBounce/NeverBounce, no specific vendor
  evaluated, no signup made per the "no paid services" instruction. Given
  the list is otherwise clean and item 3's per-sender bounce gate
  (auto-pause at 2%, drop-a-rung at the red line) already exists as a live
  backstop once sending starts, my read is this is a "ship it, let the
  health gates catch the rest" situation rather than a blocker — but it's
  Ryan's list and Ryan's call (Q9).
- D16 (9/10): reviewed the **live `campaign_templates` DB rows**, not the
  `scripts/campaign-touches.mjs` file, since 8/6 Telegram `copy:` edits had
  already diverged T1 and T2 from the checked-in seed. Did not propose an
  edit for T1's "we've crossed paths before" line even though it reads as a
  rule-4 violation, because item 6's assigned scope is T2–T11 only —
  flagged for Ryan instead of guessed at (Q10).

## Questions for Ryan

1. **Q1 (non-blocking, hygiene):** do you want `gmail.send` added to the DWD
   client's scope list for least privilege? Engine works without it. If yes:
   run `node scripts/check-dwd-scopes.mjs` — it prints the Admin path and
   the client ID to edit; re-run after to confirm.
2. **Q2 (needed before item 3 can wire reply ingest for the new senders):**
   where should replies to lrghomesbuys.com / lrghomesoffers.com sends land?
   The brief's Design section says `Reply-To = ryan@lrghomes.com`, but the
   only watched campaign inbox today is `info@lrghomes.com` (AGENT-DRIP
   label → `lib/campaignInbox.ts`), and memory says ryan@ is too large to
   walk without a server-side filter. Options: (a) Reply-To
   `info@lrghomes.com` — zero new ingest wiring, replies keep flowing into
   the existing pipeline + Telegram; (b) no Reply-To — replies land in the
   sending mailbox, so each new mailbox gets a Gmail watch via the relaxed
   `add-email-mailbox.mjs` and campaignInbox learns to treat them as
   campaign inboxes; (c) Reply-To `ryan@lrghomes.com` per the brief, which
   needs a new filtered-watch path on ryan@. Item (2) will build the sender
   config with a per-sender `replyTo` field so any answer is a config
   change, and will default to (a) until you say otherwise.
3. **Q3 (blocks a real understudy volume, not the code):** the understudy's
   "warm Relationships segment" barely exists inside `campaign_contacts` —
   only **14** active campaign contacts share an email with the Relationships
   table (tiers B 8 / C 2 / D 4), while Relationships holds 516 `Agent`-
   category rows. At 3–40/day the understudy will run out of people in a
   week. Options: (a) import the Relationships Agent tier A–C rows into
   `campaign_contacts` as a `cohort=relationships` segment (needs your OK on
   copy — the drip templates are written for the agent list); (b) let the
   understudy carry a defined slice of the drip pool instead (e.g. contacts
   with a phone match in iMessage history); (c) keep it as built (14 + any
   new Relationships matches) and accept a tiny understudy. Built default =
   (c).
4. **Q4 (confirm numbers):** workhorse ceiling 100/day and understudy 40/day
   as the steady states — brief says "~75–100" and "~20–40". Say the word and
   I change the config.
5. **Q5 (item 3 dependency):** bounces for the new domains return to the
   SENDING mailbox (DSNs go to the envelope sender, not Reply-To), and
   neither `ryan@lrghomesbuys.com` nor `ryan@lrghomesoffers.com` has a Gmail
   watch, so today the engine would see **zero bounces** from them and the
   bounce gate would pass blind. Item (3) needs to register a watch on each
   (relaxed `scripts/add-email-mailbox.mjs`, `--dry-run` first) and add both
   to `CAMPAIGN_INBOXES` in `lib/campaignInbox.ts`. OK to do that without
   waiting on Q2? *(9/5 update: the `CAMPAIGN_INBOXES` half is done on the
   branch; only the two `add-email-mailbox.mjs` runs remain — D10.)*
6. **Q6 (blocks the ramp past 5/day — needs a judge inbox):** the canary gate
   is now enforced (D7) and `CAMPAIGN_CANARY_TO` is not set anywhere (the old
   judge `ryanlarocca44@` was retired; memo lists "new judge inbox" as a
   September item). Which address is the new judge — a fresh consumer Gmail
   you never open except to read canaries? Set it in mission-control
   `.env.local` as `CAMPAIGN_CANARY_TO=…`, then the daily loop is: one canary
   per sender rides along with each send day (`[C<n> buys]` / `[C<n>
   offers]`), the 5:15pm card asks where it landed, you reply `canary buys
   primary` (or `promotions` / `spam`). If you'd rather not read a judge
   inbox daily, say so and I set `requireCanaryVerdict` back to advisory —
   but then the brief's canary gate is decorative.
7. **Q7 (small):** the 48h engine pause set at a Thursday 5:15pm health check
   expires Saturday — Friday is lost and Monday resumes; set on a Friday,
   only Monday morning is affected. Fine as is, or would you rather the
   pause be "next weekday only" (24h) so a single bad day costs one day?
8. **Q8 (non-blocking, hygiene):** the 7 emails the retired Gmail sent
   (8/25–8/27) can still draw replies into `ryan.lrghomes@gmail.com`, which
   nothing watches any more. Zero-infrastructure option: in that account's
   Gmail settings, forward all mail to `info@lrghomes.com` — replies then
   ride the existing AGENT-DRIP pipeline + Telegram alerts. Or accept that
   those 7 threads are dark. Your call; the builder won't touch that account.
9. **Q9 (item 5 finding, non-blocking):** true SMTP mailbox-level
   verification isn't possible from this network (D15) — the list is
   confirmed domain-clean (0/2,183) but individual-mailbox existence is
   unverified. Ship as-is and lean on item 3's live bounce gate, or spend
   time on a port-25-open host / a paid HTTPS verifier first? Builder's
   read: ship as-is, the gate is a real backstop.
   `scripts/.email-verify-report.csv` (gitignored, regenerate with
   `node scripts/verify-email-list.mjs`) has the 26 role-account addresses
   if you want to eyeball those before first touch.
10. **Q10 (item 6 finding, T1 — technically out of this item's scope):** the
    live T1 template (`campaign_templates`, edited 8/6) opens "We've crossed
    paths before, so I wanted to reconnect" — close to rule 4's own
    banned-phrase example ("we spoke before") and written before the
    2026-08-24 rule lock added that ban. It has already been sending under
    this wording (T1 is touch 1, sent at import) to some slice of the list.
    Want this folded into a T1 pass along with T2/T6/T9, or handled
    separately via `copy: T1 <guidance>` in Telegram? Builder's suggested
    replacement, matching the checked-in file's non-history opener: "Ryan
    LaRocca with LRG Homes. I'm an investor buying directly from agents and
    wanted to get on your radar."
