# Brief — LRG Homes Inbox Agent

**Date:** 2026-09-24 · **Owner memo:** `../inbox-agent/PROJECT_MEMO.md` · **Status:** Phase 1 + interactive layer built, setup questions live

Ryan's ask (2026-09-24): a background agent that watches ryan@lrghomes.com, files deal
documents into Google Drive the way he would, screens inbound deals against his buy box,
keeps him informed through Telegram, and — beyond the spec — "keeps me on top of things
so that I don't forget" across the work inbox (personal inbox later). Runs on the Mac mini
alongside Mission Control. Phase 1 is read-only with a Telegram approval loop; it never
sends email.

## What exists (Phase 1)

| Piece | Where | Notes |
|---|---|---|
| Worker (poll, classify, propose, file, interview, loops, screens, digest) | `scripts/inbox-agent/index.mjs` (+ `env`, `gmail`, `drive`, `llm`, `telegram` modules) | launchd every 5 min, `com.lrghomes.inbox-agent` |
| Telegram decisions (taps + reply-texts) | `lib/inboxAgent.ts`, wired into `app/api/campaign/telegram/route.ts` | Supabase-only on Vercel; the worker executes ≤5 min later |
| State | `supabase/migrations/2026-09-24_inbox_agent.sql` | `inbox_messages`, `inbox_files`, `inbox_rules`, `inbox_interview`, `inbox_loops`, `inbox_deal_screens`, `inbox_settings` |
| Filing convention (learned) | `briefs/INBOX_FILING_RULES.md` (written by the agent after the interview) + `inbox_settings.rules.md` | the approved copy in Supabase is what the worker reads |
| launchd | `infrastructure/launchd/com.lrghomes.inbox-agent.plist` | logs `/tmp/lrg-inbox-agent*.log`; health line in `scripts/mac-mini-reset.sh` |

### Google access — the one architectural fact to know

- **Gmail:** the service account's domain-wide delegation (DWD) impersonates
  ryan@lrghomes.com with `gmail.modify` (verified 2026-09-24: 61,896 messages). Read +
  label. No watch/Pub/Sub — the mailbox is polled with `in:inbox newer_than:2d`, deduped
  against `inbox_messages`, capped at 25 new messages per pass.
- **Drive:** Ryan's working Drive (`My PC / My Hard Drive / Business Operations /
  Properties / <address>`) lives in his **personal** Google account
  (ryanlarocca1219@gmail.com), which DWD cannot impersonate. Design: Ryan shares
  *Business Operations* with ryan@lrghomes.com (Editor), the worker impersonates
  ryan@lrghomes.com with the full `drive` scope, uploads land in the shared folder.
  **Two one-time steps, both Ryan's (the agent nags once a day until done):**
  1. Personal Drive → *Business Operations* → Share → ryan@lrghomes.com, Editor.
     (The agent tried to do this via the Drive connector and was blocked by the permission
     classifier — it has to be Ryan.)
  2. admin.google.com → Security → API controls → Domain-wide delegation → client
     `118033894408819500850` → add `https://www.googleapis.com/auth/drive`.
  3. Enable the Drive API on GCP project `lrg-mission-control` (the service account can do
     this itself via Service Usage; done 2026-09-24).
  Verify: `node scripts/inbox-agent/index.mjs --drive-check`. **All three done 2026-09-24 ~9:50pm PT — Drive is connected.**

### Drive survey (2026-09-24) — how Ryan already organizes

```
Business Operations/
  Finance/            Chase statements ("Chase March2026.pdf")
  LLC Paperwork/
  Properties/
    93 Ridgeview/      DocuSign-named forms ("[RLA] Residential Listing Agreement.pdf", "[COL] …", "[CC] …"), "XO Staging Agreement 2024.pdf", Photos - Copy/
    Halleck/           "California Residential Purchase Agreement - 626.pdf" (created 9/24)
    2025/              closed deals by year: 1958 Limewood Dr/ ("1958 Limewood Dr Sellers Statement.pdf"), 674 Kirkland Dr/ (Expenses/, Purchase and Sale files/, Tenants/)
    Old/               2021/, 2022/ (1430 Jeffrey ave/, "722 Gleneagle Buyers Statement.pdf"), 141 Sobrante Ct/, 1810 Ednamary/, 2355 Sunrise Drive/, 407-411 Lyon St/, 829 Wilmington Ave San Mateo/
  Taxes/2021…2025/
  Marketing/ (Farms/, Logos, Photos/, Archive/)   Personal/Tax/2025/
```
Patterns: one folder per property under Properties/, named "<number> <street>" (sometimes
just the street: "Halleck"); closed deals moved into a year folder; statements renamed
"<address> Sellers/Buyers Statement.pdf"; DocuSign forms keep their bracketed names.
The interview confirms or corrects this before anything is filed.

### Interview set (real emails, one doc type each)

Victor Parra signed Addendum A (93 Ridgeview) · Chicago Title seller net via Zix (93
Ridgeview) · DocuSign "Completed: 2116 Quito Rd - OFFER" (signed RPA — the PDF *is*
attached to the completion email) · Obie bound policy + invoice (5764 Halleck) · prelim
title report (5764 Halleck) · Final Sellers Statement + 1099-S via Zix (674 Kirkland) ·
Kirk Jackson / Wyrick Reed Street OMs (direct lead) · Chris Sabido 1050 High Rd flyer
(broker blast) · Morelan cost estimate + sprinkler proposal (contractor bids).

Findings that shaped the build: DocuSign completions and Chicago Title's Zix messages
both arrive **with the PDF attached** — no DocuSign API or Zix portal automation needed
for Phase 1; if a completion ever arrives without the PDF the agent tells Ryan to grab it.

## Flow

1. **Interview** (`--interview` seeds it; then one question per pass until answered):
   "Here's <doc> for <property>. My guess: <folder>/<name>. Tap ✅ or reply with folder +
   name." → Sonnet writes `INBOX_FILING_RULES.md` from the answers + Drive tree → posted
   as a file with [👍 That's right] [✏️ Needs changes]; reply-text = feedback → rewrite.
   Only after 👍 does filing start.
2. **Filing** (training mode): per attachment → Haiku proposal from the convention +
   learned rules + Drive tree → Telegram [✅ Approve] [✏️ Change] [⏭ Skip]. Change =
   reply with the folder/name; stored as a rule (sender domain × doc type [× property] →
   folder/filename templates). A rule approved 5× in a row flips to **auto** (one-line
   confirmation with [↩️ Ask me next time]). Duplicates (sha256, or same name already in
   the folder) are skipped and noted in the digest. Filed messages get the Gmail label
   `MC/Filed`; nothing is archived.
3. **Deal screening:** direct leads (a person emailing Ryan about a property) → Sonnet
   reads the OM PDF and applies the buy box (per-door vs the 2026 ladder, GRM, 4→5 unit
   line, 1% aspiration, rent-increase room, cushion to comp) → Telegram summary with
   [👀 Look further] [🚫 Pass]. Broker blasts → Haiku facts only; posted only if
   multifamily and "look further", otherwise digest-only.
4. **Open loops ("don't forget"):** every human email is checked for "does the sender
   need something from Ryan" (answer, signature, document, decision, signing time) →
   `inbox_loops` with ask / due date / priority / category. High priority (money,
   closing, signature, deadline ≤3 days, direct deal) alerts immediately with [✓ Done]
   [⏰ Snooze 2d]; reply "done" / "snooze 3d" also works. Loops close automatically when
   Ryan replies on the thread (sent mail check) or when a DocuSign "Completed" matches a
   "Please Sign" envelope.
5. **7:30am PT brief:** waiting-on-you list (with age + due), proposals awaiting a tap,
   filed yesterday, duplicates, deals screened, interview/convention status, Drive
   setup nag.

## Buy box encoded in the screener

From agent memory `ryan-multifamily-buy-box-price-per-door` (2026-09-02): per-door vs
nearby per-door comps (never across the 4→5 line); 2026 ladder downtown SJ ≈ $200k/door,
Milpitas 2/1 townhome 4-plex $300–325k, Sunnyvale 6-plex $358k in / $445k out; income
comp; 1% rule as aspiration; AB 1482 rent-increase room; ≥10% cushion to comp = deal;
retail-priced = straight pass in one line. The model never presents its estimates as
Ryan-verified numbers.

## Operating it

```
node scripts/inbox-agent/index.mjs                 # one pass (what launchd runs)
node scripts/inbox-agent/index.mjs --interview     # (re)seed the interview — idempotent
node scripts/inbox-agent/index.mjs --status        # counts + settings
node scripts/inbox-agent/index.mjs --drive-check   # prove share + scope
node scripts/inbox-agent/index.mjs --digest-now
node scripts/inbox-agent/index.mjs --backfill=3d   # widen the first-run window
node scripts/inbox-agent/index.mjs --pause / --resume
--dry-run (no Telegram / Drive / new DB rows)  --limit=N  --no-poll
```
Env (all already in `.env.local`): `GOOGLE_SERVICE_ACCOUNT_KEY`, `LRG_SUPABASE_*`,
`ANTHROPIC_API_KEY`, `CAMPAIGN_BOT_TOKEN`/`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
Optional: `INBOX_AGENT_MAILBOX`, `INBOX_DRIVE_ROOT_ID`, `INBOX_AUTO_THRESHOLD` (5).

## Telegram interface (agreed with Ryan 2026-09-24, built the same night)

Five card types, each its own message so a tap or reply days later still resolves:

| Card | Buttons | Reply-text means |
|---|---|---|
| **Filing** (per attachment; 3+ on one email → one **batch** card) | ✅ Approve · ✏️ Change · ⏭ Skip / ✅ Approve all · 🗂 Pick individually · ⏭ Skip all | a correction ("Halleck folder, keep the name") → filed + learned as a rule |
| **Filed confirmation** | ↩️ Undo (24 h) | — (undo moves the file to `Properties/_Unsorted` and forgets the rule it taught) |
| **Setup question** (formerly "interview") | ✅ Use my guess · ⏭ Skip | your own folder + name |
| **Deal** (direct leads always; blasts only after the first cut) | 👀 Look further · 🚫 Pass · ✉️ Reply | after 👀: a follow-up ("get me rents and the 5+ comps") → Sonnet re-reads the OM + thread and answers on the card; "questions for the agent" come back as a numbered list Ryan sends himself |
| **Loop** (someone needs something from Ryan) | ✓ Done · ⏰ Snooze 2d | "done", "snooze 3d", or a note |
| **Draft** (after ✉️; drafted in Ryan's voice from thread + screen + verdict) | ✅ Send · ✏️ Edit · ❌ Dismiss | edit instructions or pasted wording → v2. **✅ is the only send path in the whole agent.** |
| **❓ Ask** (filing proposal unsure) | ✅ Use the guess · ⏭ Skip | the answer; remembered in `inbox_settings.knowledge` and fed to every later prompt |

Cross-cutting behaviour:
- **Questions on any card** ("what did Lisa say about the per diem?") are answered from the underlying Gmail thread (Haiku) instead of being treated as a correction. Detection: ends in "?" or starts with a question word.
- **Typed commands**, no reply-to: `inbox` (status + help), `open`, `file <address>`, `find <words>`, `rules`, `screen <pasted listing text>`, `inbox pause` / `inbox resume`.
- **Blast first cut (Ryan's words, 2026-09-24):** always show off-market + motivated seller, and anyone he's done business with (Relationships/Leads email, or a prior filed doc from that sender); SFR included; never retail listings or open-house invites; Bay Area only as a tie-breaker. Held blasts appear as one count line in the brief. Ryan's 👀/🚫 verdicts on past screens are fed to the model as calibration.
- **Pass** records the verdict and clears the buttons. Nothing is sent unless Ryan taps ✉️ and then ✅ on the draft.
- **Quiet hours** 9 pm–7 am PT (`inbox_settings.agent.quiet_hours`): filing cards and blast cards are held as `pending_post` and released after 7; high-priority loops and direct deals still post.
- **Weekly teach-back** Sunday 6 pm PT: filed / auto-filed / corrections / undos this week, the rules touched, and ✋ Make manual buttons for any auto rule.
- **Drive connected** notice posts once when the share + scope land.

## Not in Phase 1 (decided, not forgotten)

- **Personal inbox** (ryanlarocca1219@gmail.com): outside the Workspace tenant, so DWD
  can't read it. Needs a consumer OAuth consent (the campaign OAuth client from 8/21 still
  exists in `.env.local.bak-2026-09-01`; the app is in Testing status → 7-day tokens
  unless published). Phase 2 once the work inbox loop is proven.
- **Sending email** — never in Phase 1. The Reply Planner (`lib/reply`) is the place to
  add "draft a reply" for open loops later.
- **DocuSign API / Zix portal automation** — not needed so far (PDFs arrive attached);
  the agent flags the rare case where they don't.
- **Archiving** — label only. Flip when Ryan asks.
- **Gmail push (Pub/Sub)** — polling every 5 min is enough and keeps the lead-ingest
  route's "unmapped address" behaviour untouched.

## Verification (2026-09-24)

- `tsc --noEmit` clean; `node --check` on every module.
- Migration applied (24 statements) to the CRMS Supabase project.
- DWD probe: `gmail.modify` mints for ryan@lrghomes.com; `drive` does not (expected until
  step 2 above).
- Dry run of the interview seed against the nine real emails: 13 documents queued, Reed
  Street OMs screened (pass: $242.5k / $223.5k per door, all 1BR, 5+ units, retail), High
  Rd flyer screened (pass: San Mateo County SFH teardown). Run time 94 s (two Sonnet
  screens with PDFs).
