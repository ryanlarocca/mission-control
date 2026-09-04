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
- [ ] **(2) Engine multi-sender** — `CAMPAIGN_SENDERS` config, per-sender daily caps, per-sender gated warm-up ramp 5→10→20→35→50→75+ advancing only on healthy days per the brief
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

## Decisions taken by the builder (reversible, flag if wrong)

- D1 (9/3): did **not** request or add `gmail.send` anywhere in code. All
  send paths stay on `gmail.modify`, which is what's granted and what
  already works. Extending the grant is Ryan's Admin-console action only.

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
