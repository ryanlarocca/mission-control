# Lead intake hardening — Sonnet 5 everywhere, triage validator, email dedupe, mail-match re-link

> **Status:** SPEC 2026-10-21 — cloud build requested by Ryan after the NOO Q4 pre-wire audit.
> **Owner memo:** `../lead-pipeline/PROJECT_MEMO.md`. Background: `BRIEF_NOO_Q4_AB_PLUMBING_2026-10-12.md`,
> `BRIEF_DM_ABSENTEE_Q4_2026_2026-10-08.md`.
> **Branch:** `cloud/triage-sonnet-dedupe-matchlink`. No PR, no merge, no deploy — Ryan's bridge merges, applies the
> migration and deploys. Do NOT create a CHANGELOG/PROJECT_MEMO in this repo (`CLAUDE.md`).

## Why (what the 10/21 audit found)

1. Every lead-reading LLM call runs on Haiku 4.5 (`HAIKU` in `lib/llm.ts`). Ryan wants Sonnet 5 for all of them.
2. `triageEmailLead` (`lib/leads.ts` ~3061) is all-or-nothing: if the model returns `suggestedReply: null` or an
   off-list `temperature`, the validator returns `null` and the card gets NO summary, NO property_address, NO
   moment. Seen live 10/21 on probe emails (model correctly set suggestedReply null for a "please ignore" mail and the
   whole triage was dropped). Failure is silent (no log of the raw output, no Telegram).
3. Email leads duplicated: two identical rows 0.2 s apart, same `gmail_thread_id`. Both email paths dedupe by
   read-then-insert (`app/api/leads/email/route.ts` ~576 Apps Script path, ~853 Pub/Sub path: select last-hour rows
   from the sender, compare first 200 chars of message, then insert). Two Gmail notifications for one message race
   through it.
4. Mail-record matching (`lib/mailMatch.ts autoLinkMailRecord`) only runs at insert time in `app/api/leads/sms/route.ts`
   (~315) and `app/api/leads/voice/route.ts` (~264), plus the PATCH in `app/api/leads/route.ts` (~274). It is NOT
   called after the email insert (the comments at email/route.ts ~380 and ~652 claim it is — they are wrong), and NOT
   re-run after `processRecordingBackground` → `analyzeCallTranscript` writes `property_address` / `name` onto a
   call or voicemail row. So a caller who says their address on a voicemail gets the address on the card but never
   the link to their `mail_records` row. Phone-based matching can't work (mail_records has no phone column), so the
   address is the only key for callers.

## Build

### 1. Sonnet 5 at every Haiku call site
- `lib/llm.ts`: keep the constants; change nothing about the client. Add `const FAST = SONNET` is NOT the ask —
  Ryan wants Haiku gone: point `HAIKU` at `"claude-sonnet-5"` is acceptable only if you also rename the export to
  something honest (`STANDARD`) and update every import. Preferred: replace `model: HAIKU` with `model: SONNET` at
  every site and delete the `HAIKU` export so nothing can regress to it.
- Sites (16): `lib/leads.ts` 782 detect-offer, 1985 summarize, 2467 analyze-call, 3156 triage-email;
  `lib/relationship-calls.ts` 102, 123; `lib/reply/plan.ts` 87; `lib/reply/facts.ts` 54; `lib/campaignInbox.ts` 707;
  `lib/inboxAgent.ts` 204, 211, 708; `app/api/leads/[id]/draft-message/route.ts` 253;
  `app/api/leads/[id]/extract-followup/route.ts` 41; `app/api/leads/[id]/summary/route.ts` 227. Grep for `HAIKU`
  to be sure none is missed (also `scripts/*.mjs` — none today, verify).
- Sonnet 5 rules (memory `sonnet5-api-gotchas`): no `temperature`/`top_p` ever; adaptive thinking shares
  `max_tokens`. For every site that asks for short JSON (≤ 1500 tokens today) pass `thinking: false` so the budget
  isn't eaten; for analyze-call (2500) and summary (2500) raise `maxTokens` to 4096 and leave thinking on
  (`completeText` already retries once at 3× on truncation). `completeText` already handles `thinking:false` for
  Sonnet — confirm in `lib/llm.ts` ~60-80 and do not add sampling params.
- `maxDuration`: email route is 30 s and runs triage inline (`await triageEmailLead`). Sonnet is ~2-3× Haiku. Raise
  `app/api/leads/email/route.ts` `maxDuration` to 60. Recording route is already 300.
- Tests: `tests/*.unit.test.ts` that pin a model id (grep `haiku`) get updated. Add one test asserting no file under
  `lib/` or `app/` references `claude-haiku` (a plain fs scan, excluding `lib/mockData.ts` if it still has the
  fake `claude-sonnet-4.6` history rows — that string is display-only, leave it).

### 2. Triage validator keeps what it got
In `triageEmailLead` (and check `analyzeCallTranscript` ~2205 for the same pattern):
- Never return `null` because one field is off. Only return `null` when the model call threw or no JSON object could
  be extracted.
- Defaults: `temperature` not in `VALID_TEMPERATURES` → `"cold"`; `summary` missing → first 160 chars of the body;
  `suggestedReply` missing/null → `""` (the drafter runs separately via Reply Planner; an empty string must not break
  `triggerTelegramDraft` — guard it); `moment` off-list → `null`; `property_address` always carried through when
  it is a non-empty string.
- On any defaulting, `console.warn("[triage-email] field defaulted: …", rawText.slice(0, 500))`.
- On a thrown call / no JSON: `console.error` with the raw text AND `sendTelegramAlert("⚠️ Email triage failed —
  lead from <sender> inserted without AI notes …")` (memory: silent failures on Ryan-facing paths must alert).
- Unit tests in `tests/email-triage-followup.unit.test.ts` (or a new file) with the exact probe JSON from 10/21
  (`suggestedReply: null`, `property_address` set) asserting the address survives.

### 3. Email dedupe becomes atomic
- Migration `supabase/migrations/2026-10-21_leads_gmail_message_id.sql` (idempotent): `ALTER TABLE leads ADD COLUMN
  IF NOT EXISTS gmail_message_id text;` + `CREATE UNIQUE INDEX IF NOT EXISTS leads_gmail_message_id_uniq ON leads
  (gmail_message_id) WHERE gmail_message_id IS NOT NULL;`. No new table, so no RLS change.
- Pub/Sub path: insert with `gmail_message_id = message.id`; on unique-violation (`23505`) log `[email] duplicate
  notification for <id>` and return — do not alert, this is the normal case.
- Apps Script path has no Gmail id: compute `gmail_message_id = "as:" + sha1(sender + "|" + subject + "|" + first 200
  chars of body)` so the same unique index covers it. Keep the existing last-hour fuzzy check as the second line.
- Backfill is NOT needed. The `lookupEmailCluster` / `dedupeClusterStamps` logic is untouched.
- Test: insert twice with the same id → one row (unit test with a mocked supabase client, same style as
  `tests/email-alias.unit.test.ts`).

### 4. Mail-record link re-runs when an address appears
- `app/api/leads/email/route.ts`: after BOTH inserts (Pub/Sub ~635 and Apps Script ~368 paths) call
  `autoLinkMailRecord(sb, inserted.id)` (dynamic import like the sms route), non-fatal, after `campaign_id` is set.
- `lib/leads.ts processRecordingBackground`: after `analyzeCallTranscript` writes `property_address` and/or `name`
  (the `.update(` around ~1843-1900), call `autoLinkMailRecord(sb, leadId)` when the row has no `mail_record_id`.
  Same for the followup-only branch if it writes an address.
- `autoLinkMailRecord` already inherits a sibling's link and scopes to the parent campaign; don't change its
  matching logic. If the lead has no `campaign_id`, it returns without matching — fine.
- Test: extend `tests/mailMatch.unit.test.ts` only if a pure helper is extracted; otherwise an integration-free unit
  test that the recording pipeline invokes the linker when `property_address` is set (mock the module).

### 6. A response on a NOO Q4 line/alias comes back as New (added 2026-10-21 after Ryan's live test)
Observed: +19492438530 called 408-418-6294 on 10/21. The number had called the MFM-A line in May 2026 and that
cluster was marked dead + junk, so the new row inherited `status = "dead"` (voice route ~165: `inheritedStatus` =
latest row for the caller with a non-null `twilio_number`). The card is buried under the Dead filter. Ryan's rule:
**a response to the new letter is a new lead.**
- Scope: ONLY intakes attributed to the NOO Q4 lines/aliases — `SOURCE_OVERRIDE_NUMBERS` for calls/texts
  (`app/api/leads/voice/route.ts`, `app/api/leads/sms/route.ts`) and the aliases whose `config/email-campaigns.json`
  source is `NOO-Q4-2026-A` / `NOO-Q4-2026-B` (both email paths). Legacy lines keep today's inheritance untouched.
  Make the email side table-driven too: treat any alias whose source label is a `SOURCE_OVERRIDE` label as an
  override (add a small `isSourceOverrideLabel(source)` helper in `lib/leads.ts` next to `SOURCE_OVERRIDE_NUMBERS`
  so the two stay in sync; the labels are the `CAMPAIGN_MAP` values for those numbers).
- Behaviour when the override applies: insert the new row with `status = "new"`, `is_junk = false`; do NOT change
  the old rows. Keep the drip-stamp inheritance exactly as today (don't restart a drip that is already running).
- DNC wins: if any row in the cluster has `is_dnc = true` (or the caller is on the suppression path), keep today's
  behaviour entirely — no reset, no alert change.
- Triage/analyze may still set `dead` afterwards (hostile / wrong number) — unchanged.
- Alert text: append " (returning caller, reset to New)" to the Telegram alert line when the reset happened.
- Tests: unit-test the decision helper (override line + prior dead → new; override line + DNC → inherited; legacy
  line + prior dead → inherited; override alias email → new) in `tests/noo-ab.unit.test.ts`.

### 5. Gates
`npx tsc --noEmit` clean, `npx vitest run` green (42 files today), no `HAIKU` left, migration file present, branch
pushed. Section 6 is in scope. Report: the per-site `maxTokens`/`thinking` table you ended up with, and the exact migration SQL.

## Out of scope
Deploying, applying the migration, Telegram/Twilio config, the Reply Planner prompts themselves, any voice/UI copy,
`lib/mockData.ts`, CHANGELOG/PROJECT_MEMO (outside this repo).
