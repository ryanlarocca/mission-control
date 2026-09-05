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
- [ ] **(3) Per-sender health checks, auto-pause, Telegram alerts**
- [ ] **(4) Strip retired Gmail sender** from `config/email-campaigns.json` + document which Vercel env vars to remove
- [ ] **(5) Email-verification tooling** for the ~2,100 contact list (SMTP-level checks; no paid services — if one is genuinely needed, recommend it here instead)
- [ ] **(6) T2–T11 template pass** against `CAMPAIGN_VOICE.md` — proposed edits written here for Ryan's review, templates untouched

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
   waiting on Q2?
