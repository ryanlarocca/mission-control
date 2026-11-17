# Lead email in ryan@ lands on the lead card — 2026-11-17

## Why

Ryan sometimes emails a lead by hand (or has me email them) from
**ryan@lrghomes.com**, not from the card. Two real cases this week:

- **Maryam Norton** (+16505207069, 5122 Severance Ct): written offer emailed
  Nov 13 from ryan@ (thread `1a1d6be335d9de09`).
- **David Leavitt** (+17073183456, 3885 Magnolia Dr): referral email Nov 17
  from ryan@ (thread `1a1eb41ae31153e9`).

Neither email reached the card (both were added by hand on 11-17 as
`leads` rows, `lead_type: "email"`, `gmail_thread_id` set). And if either one
**replies** to ryan@, nothing reaches the card either: lead email intake
(`app/api/leads/email/route.ts`) only watches the campaign mailboxes in
`config/email-campaigns.json`, and ryan@ isn't one of them. The judge
(`scripts/judge.js`) then never sees the email, so it keeps saying "you owe
them" or rules on stale facts.

ryan@ is already read every pass by the inbox agent on the Mac mini, and
`scripts/inbox-agent/cards.mjs` already syncs ryan@ mail with
**Relationships** cards through `/api/crms/email-sync`
(`lib/relationshipEmailSync.ts`, briefs/BRIEF_RELATIONSHIP_EMAIL_SYNC_2026-11-11.md
and BRIEF_RELATIONSHIP_EMAIL_ALERTS_2026-11-11.md). This build does the same
for **lead** cards. Follow that design; don't invent a second one.

## What it must do

1. **Sent mail** from ryan@ with a lead's email in To/Cc → one outbound row on
   that lead's card: `lead_type "email"`, `twilio_number null` (= Ryan out, see
   `isRyanOut` in scripts/judge.js), `status "contacted"`, `caller_phone` /
   `name` / `property_address` / `source` / `source_type` copied from the lead's
   cluster, `email` = the lead's address, `gmail_thread_id`, `created_at` =
   the message's own date (not now), `message` = `subject\n\nbody` (body
   without the quoted thread). Same row shape as
   `app/api/leads/[id]/send-email/route.ts`. Silent, no alert.
2. **A lead's reply** into ryan@ → one inbound row on the card, shaped like an
   inbound email lead row so the card, Follow Ups and the judge treat it as
   them emailing (`twilio_number "email:ryan@lrghomes.com"` so that replying
   from the card goes back out from ryan@ in the same thread via
   `lib/emailReply.ts`; check `resolveMailbox`/`getGmailClient` accept it).
   Status rules the same as an inbound email on an existing cluster in
   `app/api/leads/email/route.ts` (inherit the cluster; DNC stays DNC).
   **One Telegram alert** for it, the same lead-email alert intake sends
   (`sendTelegramAlert(..., { about: { kind: "lead", ... } })`, so Draft:/✅
   work). Make sure the inbox agent doesn't also alert the same message
   separately (one email = one alert; see how deal_lead is handled in the
   Relationships alerts brief).
3. **Matching a lead:** an address matches a lead if it's on any `leads.email`
   row (case-insensitive; Gmail dot-insensitivity is a nice-to-have, not
   required) or the message's Gmail thread is already on a lead row
   (`gmail_thread_id`). Ignore own domains (`OWN_DOMAINS` in cards.mjs).
   Junk/bad clusters (`is_junk`) are skipped. If one address is on both a lead
   and a Relationships card, both get it, with one alert total.
4. **Dedupe:** never two rows for the same Gmail message (lead rows already
   carry `gmail_message_id` with a partial unique index; reuse it, see
   `lib/emailDedupe`). The two hand-added rows above have no
   `gmail_message_id`: the sync must recognise them (same lead + same
   `gmail_thread_id` + lead_type email + Ryan-out + within a few minutes of
   the message date) and stamp the id instead of adding a duplicate.
5. **No backfill** beyond the existing card-sync window rules, except a
   one-time hand-run catch-up flag for the last 30 days (dry-run first).
6. Failures never stop the inbox agent's pass; same streak/alert pattern as
   cards.mjs (machine errors go to the ops bot, see `ops-alerts` usage).

## Shape (your call within this)

Likely: cards.mjs (or a sibling `leadmail.mjs`) loads the set of lead email
addresses + lead thread ids alongside the card emails, sends lead candidates
to a new `app/api/leads/email-sync/route.ts` (public path + same shared-secret
header as `/api/crms/email-sync`; add it to PUBLIC_PATHS in middleware), which
does the matching, dedupe, inserts and the alert. Keep pure logic exported and
unit-tested like `tests/inbox-cards.unit.test.ts`.

## Out of scope

- The judge's prompt (I'm editing `scripts/judge.js` myself in parallel; don't
  touch it).
- Any UI change. Campaign-mailbox intake stays as is.
- Sending anything. This build only reads mail and writes rows.

## Rules for the helper

- Work in this worktree only. No commit, no push, no deploy, no migration run,
  **no prod writes**. Read-only Supabase queries and dry runs are fine
  (env: `--env-file=/Users/ryanlarocca/Projects/PROJECTS/mission-control/.env.local`
  or read that file; node_modules live in the main checkout at
  `/Users/ryanlarocca/Projects/PROJECTS/mission-control/node_modules` — symlink
  it into the worktree if you need tsc/vitest, and remove the symlink after).
- If a migration is needed, write it under `supabase/migrations/` with RLS
  enabled (see existing migrations) and say so; I run it.
- `npx tsc --noEmit` and the relevant vitest files must pass.
- Report: files changed, the contract between mini and Mission Control, what
  the dry run against the real ryan@ mailbox found for the last 30 days
  (expect at least the Maryam and David sent emails, matched to the existing
  hand-added rows rather than new ones), and anything you weren't sure of.
