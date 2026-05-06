# Cody Brief — Phase 7B: Lead Drip System

**Date:** May 5, 2026
**Project:** Mission Control — Lead Drip Engine
**App:** `PROJECTS/mission-control/`
**Sidecar:** `PROJECTS/comprehensive-relationship-management/phase2/crms-sidecar.js`
**Deploy:** `cd PROJECTS/mission-control && vercel --prod`
**Branch:** `feature/drip-system` ← create this branch before starting

---

## Context for Cody

Mission Control's Leads tab (`/leads`) captures inbound leads from two sources:
- **Google Ads** — form fills from `lrghomes-landing.vercel.app`, already fire an immediate email + iMessage via webhook on intake
- **Direct Mail** — calls, voicemails, SMS, and emails to two Twilio numbers (MFM-A `+16504364279`, MFM-B `+16506803671`) and two Gmail mailboxes (`ryansvg@lrghomes.com`, `ryansvj@lrghomes.com`)

Leads land in a Supabase `leads` table. The existing sidecar (port 5799 on Mac mini) handles iMessage sending, chat.db reading, and Gmail thread fetching. All of that infrastructure is already live.

**What's missing:** After the initial capture, there is NO automated follow-up. If Ryan doesn't manually reach out, leads go cold. This brief builds a smart drip engine that automatically follows up with leads on a defined cadence, pausing when Ryan is actively engaged.

---

## Infrastructure

**Supabase (LRG Homes project):**
- URL: `https://vcebykfbaakdtpspkaek.supabase.co`
- Service role key: in `.env.local` as `LRG_SUPABASE_SERVICE_KEY`
- Existing `leads` table — schema includes: `id`, `caller_phone`, `twilio_number`, `source`, `source_type`, `lead_type`, `status`, `message`, `recording_url`, `name`, `email`, `property_address`, `ai_notes`, `gmail_thread_id`, `created_at`

**Sidecar endpoints (localhost:5799):**
- `POST /api/crms/send` — sends iMessage via AppleScript (body: `{ phone, message }`)
- `POST /sync-imessage` — reads chat.db for a phone (body: `{ phone }`, returns message array)
- `POST /sync-email` — fetches Gmail thread (body: `{ threadId, mailbox }`)

**Email sending:**
- Gmail API via service account with Domain Wide Delegation
- `getGmailClient(userEmail)` in `lib/leads.ts` — impersonates mailbox via JWT
- Scope: `gmail.modify`

**OpenRouter (content generation):**
- Key: in `.env.local` as `OPENROUTER_API_KEY`
- Model for drip content: `anthropic/claude-haiku-4-5`

**Telegram (approval gate):**
- Bot token: in `.env.local` as `TELEGRAM_BOT_TOKEN`
- Chat ID: in `.env.local` as `TELEGRAM_CHAT_ID`

---

## Parts

### Part 1: Schema Migration

Add three columns to `leads` table:

```sql
ALTER TABLE leads ADD COLUMN IF NOT EXISTS drip_touch_number INTEGER DEFAULT NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS drip_campaign_type TEXT DEFAULT NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_drip_sent_at TIMESTAMPTZ DEFAULT NULL;
```

Also add new status enum values. Current valid statuses: `new`, `hot`, `qualified`, `warm`, `contacted`, `junk`. Add:
- `active` — Ryan is personally working this lead, drip permanently off
- `unqualified` — soft mismatch, one clarifying question sent, then pause
- `do_not_contact` — permanent hard stop, never touch again

Run via `node scripts/run-migration.mjs scripts/phase7b-drip-schema.sql`.

---

### Part 2: Campaign Definitions

Create `lib/drip-campaigns.ts` with typed campaign definitions:

```typescript
export type DripCampaignType =
  | 'google_ads_form'
  | 'google_ads_email_only'
  | 'direct_mail_call'
  | 'direct_mail_sms'
  | 'direct_mail_email';

export interface DripTouch {
  touchNumber: number;
  delayHours: number; // hours since last contact
  channel: 'imessage' | 'email';
}

export interface DripCampaign {
  type: DripCampaignType;
  touches: DripTouch[];
  entryDelayHours: number; // grace period before drip starts
}
```

**Campaign sequences:**

**`google_ads_form`** (entry delay: 0 — touch 0 already fired by webhook):
| Touch | Delay (hours from last contact) | Channel |
|---|---|---|
| 1 | 30 | iMessage |
| 2 | 48 | Email |
| 3 | 72 (3d) | iMessage |
| 4 | 168 (7d) | Email |
| 5 | 336 (14d) | iMessage |
| 6 | 720 (30d) | Email |
| 7 | 1440 (60d) | iMessage |
| 8 | 2160 (90d) | Email |
| 9 | 2160 (90d) | iMessage |
| 10 | 2160 (90d) | Email |
| 11 | 2160 (90d) | iMessage |
| 12 | 2160 (90d) | Email |
| 13 | 2160 (90d) | iMessage |

**`google_ads_email_only`** (entry delay: 0):
Same timing as `google_ads_form` but all channels are `email`. When `caller_phone` is populated, `drip_campaign_type` upgrades to `google_ads_form` — sequence continues from current touch number without restart.

**`direct_mail_call`** (entry delay: 0 for missed call [15-min buffer handled in engine], 48h for voicemail):
| Touch | Delay | Channel |
|---|---|---|
| 0 (missed call only) | 0.25h (15 min) | iMessage — "Hey, this is Ryan — I had a missed call from this number. Can I help you?" |
| 1 | 48 | iMessage |
| 2 | 72 (3d) | iMessage |
| 3 | 168 (7d) | iMessage |
| 4 | 336 (14d) | iMessage |
| 5 | 720 (30d) | iMessage |
| 6 | 1440 (60d) | iMessage |
| 7 | 2160 (90d) | iMessage |
| 8–13 | 2160 each | iMessage quarterly |

**`direct_mail_sms`** (entry delay: 48h):
Same as `direct_mail_call` touch 1 onward. iMessage only.

**`direct_mail_email`** (entry delay: 48h):
Same timing as `google_ads_email_only`. Email only, upgrades to iMessage + email when phone found.

---

### Part 3: Drip Engine Script

Create `scripts/drip-engine.js` — standalone Node.js script run by launchd hourly.

**Core loop:**
```
1. Fetch all leads from Supabase WHERE:
   - drip_campaign_type IS NOT NULL
   - status NOT IN ('active', 'junk', 'do_not_contact')
   - (drip_touch_number < max_touches for campaign OR drip_touch_number IS NULL)

2. For each lead:
   a. Determine campaign sequence from drip_campaign_type
   b. Get current touch number (default 0 if NULL — new lead entering drip)
   c. Calculate next touch delay
   d. Check last_drip_sent_at — is enough time elapsed?
   e. If not due → skip
   f. If due → CHECK FOR ACTIVE CONVERSATION (critical):
      - Call sidecar POST /sync-imessage { phone } — get recent messages
      - Check leads table for any non-drip outbound rows since last_drip_sent_at
      - If any outbound from Ryan (is_drip !== true) exists since last touch → HOLD, reset clock
      - If any INBOUND from lead exists since last touch → HOLD, reset clock
   g. If clear → generate content via Haiku
   h. Send Telegram approval request (when DRIP_AUTO_SEND=false)
   i. If approved (or auto-send enabled) → send via sidecar (iMessage) or Gmail API (email)
   j. Log touch to Supabase:
      - Insert new row in leads table: lead's phone, message content, twilio_number=null, lead_type='drip_imessage' or 'drip_email', source matches lead's source
      - Update lead row: drip_touch_number++, last_drip_sent_at=now()
```

**Critical rule:** Drip touches do NOT change lead `status`. Only Ryan's manual actions change status. Drip-sent rows are marked with `lead_type` prefixed by `drip_` so they're distinguishable in the timeline.

**Chat.db check logic:**
```javascript
async function hasRecentActivity(phone, sinceTimestamp) {
  // Call sidecar for iMessage history
  const messages = await fetch('http://localhost:5799/sync-imessage', {
    method: 'POST',
    body: JSON.stringify({ phone })
  }).then(r => r.json());

  // Check for any message (inbound or Ryan's outbound) after sinceTimestamp
  const recentMessages = messages.filter(m => m.timestamp > sinceTimestamp);
  return recentMessages.length > 0;
}
```

**Content generation:**
```javascript
async function generateDripMessage(lead, touchNumber, campaign, conversationHistory) {
  const systemPrompt = buildDripPrompt(lead, touchNumber, campaign);
  // Include full conversation history (iMessage + email) for context
  // Haiku generates a short, personal message — never repeats, always context-aware
  const response = await callOpenRouter({
    model: 'anthropic/claude-haiku-4-5',
    max_tokens: 200,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Generate touch #${touchNumber} for this lead.` }
    ]
  });
  return response;
}
```

**Prompt structure (bake into script):**

For Google Ads leads:
```
You are writing a text message (iMessage) / email from Ryan, a cash home buyer in the Bay Area.
The recipient filled out a form online about selling their property.

RULES:
- Sound like a real person texted/emailed this. Short, casual, no filler.
- Never use "newsletter" tone, no subject-verb-object template patterns
- Never repeat an opener from prior touches (conversation history below)
- 1-3 sentences max for iMessage, 2-5 sentences for email
- No sign-off for iMessage. Email ends with "— Ryan" only.
- No emojis unless quoting something

PHASE GUIDANCE:
- Touches 1-3 (early): Low pressure — availability, "did you get my message", "happy to answer questions"
- Touches 4-6 (mid): Value prop — cash, fast close 2-3 weeks, no repairs, no commissions, no showings
- Touches 7+ (long-tail): Stay on radar — "still buying in your area", seasonal market angle, simple check-in

LEAD CONTEXT:
- Name: {name}
- Property: {property_address}
- Form submitted: {created_at}
- Prior conversation: {conversation_history}
- Touch number: {touchNumber} of {maxTouches}
- Days since first contact: {daysSinceCreated}
```

For Direct Mail leads:
```
You are writing a text message (iMessage) from Ryan, a cash home buyer in the Bay Area.
The recipient received a physical letter from Ryan about their property and reached out by {entry_method}.

RULES:
- Sound like a real person texted this. Short, casual, no filler.
- Reference the letter they received where natural
- Goal is to get them on a phone call — not to close digitally
- Never repeat an opener from prior touches
- 1-3 sentences max
- No emojis, no sign-off

PHASE GUIDANCE:
- Touch 0 (missed call only): "Hey, this is Ryan — I had a missed call from this number. Can I help you?"
- Touches 1-3 (early): Warm follow-up — reference voicemail/letter, offer to chat, no pressure
- Touches 4-6 (mid): "Still buying in your area, happy to chat when timing works"
- Touches 7+ (long-tail): Pure staying-on-radar — "still interested whenever you're ready"

QUALIFYING ANGLE (if missing info):
- If no address known: naturally ask about the property in early touches
- If address seems out-of-area: ask "I see [city] — are you looking to sell a Bay Area property?"
- If any confusion signals: ask a clarifying question, don't assume junk

LEAD CONTEXT:
- Name: {name}
- Property: {property_address || "unknown — ask naturally"}
- Entry method: {lead_type}
- Voicemail transcript: {voicemail_transcript || "N/A"}
- Prior conversation: {conversation_history}
- Touch number: {touchNumber}
```

---

### Part 4: Telegram Approval Gate

When `DRIP_AUTO_SEND=false` (the default):

Before sending any touch, the drip engine posts to Telegram:
```
🔄 Drip #{touchNumber} — {campaignType}
Lead: {name || phone}
Channel: {channel}

"{generated_message}"

✅ /drip_approve_{leadId}
❌ /drip_skip_{leadId}
```

**Approval flow:**
- Create a new route: `POST /api/leads/drip-approve` — accepts `{ leadId, action: 'approve' | 'skip' }`, auth-gated
- The drip engine writes a pending row to a new `drip_pending` table (or a `drip_status: 'pending'` field on the lead)
- A second launchd job (or the same hourly job on its next pass) checks for approvals and fires the send
- Alternatively: the Telegram bot can hit the webhook directly with inline keyboard buttons

**Simpler approach (recommended):** The drip engine generates and sends to Telegram, then writes the pending touch to a `drip_queue` table (`lead_id`, `message`, `channel`, `status: pending|approved|skipped`, `created_at`). A second scan pass (or next hourly run) checks for approved items and sends them. Ryan approves via Mission Control UI (simpler than Telegram bot callbacks).

**When `DRIP_AUTO_SEND=true`:** Skip Telegram, fire directly.

---

### Part 5: Campaign Assignment on Intake

Modify existing lead intake routes to stamp `drip_campaign_type` and `drip_touch_number` on new leads:

**`app/api/leads/voice/route.ts`** (calls/voicemails):
- After inserting the lead row, set `drip_campaign_type = 'direct_mail_call'`
- Set `drip_touch_number = 0` (engine starts from there)
- Set `last_drip_sent_at = now()` (grace period timer starts)

**`app/api/leads/sms/route.ts`** (texts):
- Set `drip_campaign_type = 'direct_mail_sms'`
- Set `drip_touch_number = 0`, `last_drip_sent_at = now()`

**`app/api/leads/email/route.ts`** (emails):
- Check `source_type`: if `direct_mail` → `drip_campaign_type = 'direct_mail_email'`
- If source maps to Google Ads → `drip_campaign_type = 'google_ads_email_only'`
- Set `drip_touch_number = 0`, `last_drip_sent_at = now()`

**`lrghomes-landing/api/submit-lead.js`** (Google Ads form):
- Set `drip_campaign_type = 'google_ads_form'`
- Set `drip_touch_number = 0`, `last_drip_sent_at = now()`
- Note: touch 0 (immediate email + text) already fires here — engine starts at touch 1

**Campaign upgrade logic** (in drip engine):
- On each scan, if a `google_ads_email_only` or `direct_mail_email` lead now has `caller_phone` populated → upgrade `drip_campaign_type` to `google_ads_form` or add iMessage to the channel mix. Touch number does NOT reset.

---

### Part 6: Missed Call Immediate Text

Special handling for `direct_mail_call` leads with no voicemail:

**In drip engine:** When a new lead has `drip_campaign_type = 'direct_mail_call'` AND `recording_url IS NULL` AND `drip_touch_number = 0`:
- Wait 15 minutes from `created_at` (check if recording appeared — if yes, it's a voicemail, not a missed call)
- If still no recording after 15 min → fire immediate iMessage: "Hey, this is Ryan — I had a missed call from this number. Can I help you?"
- Set `drip_touch_number = 1`, update `last_drip_sent_at`
- Standard cadence continues from there (next touch at 48h)

For voicemail leads (recording_url IS NOT NULL): entry delay is 48h, engine starts at touch 1.

---

### Part 7: Status Audit + UI Updates

**Status audit — update these files:**
- `app/api/leads/route.ts` — PATCH handler accepts new status values
- `components/widgets/LeadsTab.tsx` — filter chips, status dropdown, badge colors:
  - `active` = blue
  - `unqualified` = gray
  - `do_not_contact` = red/dark
- Any `WHERE status IN (...)` queries — ensure they include/exclude new values appropriately

**New UI elements in LeadsTab:**
- Timeline badge for drip-sent messages: small "🤖 Auto" label vs no label for Ryan-sent
- "Next touch" field on lead card (calculate from `last_drip_sent_at` + next touch delay)
- Status dropdown includes new values with appropriate colors/icons

**Drip queue UI (if approval gate uses Mission Control):**
- New section or tab: pending drip touches awaiting approval
- Each shows: lead name/phone, message preview, approve/skip buttons
- Simple list, sorted by created_at

---

### Part 8: Junk Filter v1

In the drip engine's content generation step, add a pre-generation triage check:

```javascript
async function shouldContinueDrip(lead, conversationHistory) {
  // Hard stops — no AI needed:
  if (containsDNC(conversationHistory)) return { continue: false, reason: 'dnc_request' };
  if (containsHostile(conversationHistory)) return { continue: false, reason: 'hostile' };
  if (containsWrongNumber(conversationHistory)) return { continue: false, reason: 'wrong_number' };

  // Soft signals — ask Haiku:
  if (hasAmbiguousSignals(lead, conversationHistory)) {
    return { continue: true, clarify: true }; // next touch should be a clarifying question
  }

  return { continue: true, clarify: false };
}
```

**Hard stop patterns** (regex/keyword, no AI cost):
- "take me off", "stop texting", "don't contact", "remove me", "not interested", "wrong number", "fuck off", "leave me alone"
- On hard stop: auto-set status to `do_not_contact`, send Telegram alert to Ryan

**Soft signals** (passed to Haiku for the clarifying question):
- Property address doesn't match Bay Area (based on city/zip if parseable)
- Lead mentions "mobile home", "trailer", "manufactured", "renting", "my landlord"
- Any confusion signals in conversation

When `clarify: true`, the prompt instructs Haiku to generate a clarifying question instead of a standard follow-up.

---

## Build Order

Execute in this order to avoid dependency issues:

1. **Part 1** — Schema migration (columns + new status values)
2. **Part 2** — Campaign definitions (`lib/drip-campaigns.ts`)
3. **Part 5** — Campaign assignment on intake (stamp new leads entering the system)
4. **Part 3** — Drip engine script (core logic)
5. **Part 6** — Missed call immediate text (special case in engine)
6. **Part 8** — Junk filter v1 (integrated into engine)
7. **Part 4** — Telegram approval gate + drip queue
8. **Part 7** — Status audit + UI updates

---

## Checkpoint Protocol

**IMPORTANT:** After completing each Part, announce it clearly:

```
✅ CHECKPOINT: Part [N] — [Title] complete
Summary: [1-2 sentences of what was done]
Files touched: [list]
Blocked: [yes/no — if yes, what you need]
```

If you hit a blocker or need a decision, announce:
```
⏸ BLOCKED: [Issue description]
Options: [A, B, C if applicable]
Waiting for input.
```

**Do NOT proceed past a blocker without input.**

---

## Deploy Gate

**Do NOT deploy to production.** When all code is written and tested locally:
```
🏁 READY FOR REVIEW
Changed files: [list]
What to test: [list]
Deploy command: cd PROJECTS/mission-control && vercel --prod
```

Wait for explicit "deploy" instruction.

---

## Wrap-Up

When the project is complete and deployed:
1. Update `PROJECTS/comprehensive-relationship-management/PROJECT_MEMO.md` with Phase 7B shipped
2. Note any follow-up items or tech debt created
3. Final status:
```
✅ PROJECT COMPLETE — Phase 7B Drip System
Shipped: [summary]
Follow-up: [any items]
Memo updated: yes
```

---

## Env Vars Needed

These should already exist in `.env.local` and Vercel:
- `LRG_SUPABASE_URL`
- `LRG_SUPABASE_SERVICE_KEY`
- `OPENROUTER_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

**New env var:**
- `DRIP_AUTO_SEND=false` — add to `.env.local` and the drip script. When `true`, drip fires without Telegram approval.
- `SIDECAR_URL=http://localhost:5799` — already used by MC routes, confirm drip script reads it

---

## Files Modified (allow-list)

**New files:**
- `scripts/phase7b-drip-schema.sql`
- `scripts/drip-engine.js`
- `lib/drip-campaigns.ts`
- `infrastructure/launchd/com.lrghomes.drip-engine.plist`

**Modified files:**
- `app/api/leads/voice/route.ts` — stamp campaign type on intake
- `app/api/leads/sms/route.ts` — stamp campaign type on intake
- `app/api/leads/email/route.ts` — stamp campaign type on intake
- `app/api/leads/route.ts` — accept new status values in PATCH
- `components/widgets/LeadsTab.tsx` — new status chips, drip badge, next-touch display
- `lib/leads.ts` — export campaign helpers, status type updates
- `_archive/lrghomes-landing/api/submit-lead.js` — stamp campaign type on Google Ads form

**Sidecar (technically out-of-repo but on allow-list for this brief):**
- `PROJECTS/comprehensive-relationship-management/phase2/crms-sidecar.js` — only if new endpoints needed (prefer reusing existing)

---

## DO NOT TOUCH

- `app/api/crms/*` — CRMS relationship system (separate from leads)
- `app/api/leads/call/*` — outbound call relay (working, don't modify)
- `app/api/leads/voice/recording/route.ts` — recording pipeline (working)
- Google Sheets API integration (`lib/sheets.ts`)
- Authentication middleware logic (except adding new PUBLIC_PATHS if needed)
- `phase2/crms-enrich.js`, `phase2/crms-enrich-one.js` — enrichment scripts
- Any `com.openclaw.*` launchd plists

---

## Key Architectural Decisions (locked)

1. **Drip touches do NOT change lead status.** Only Ryan's manual actions change status. Drip rows are marked with `lead_type: 'drip_imessage'` or `'drip_email'`.
2. **Hold logic checks for non-drip activity.** Ryan's sends pause the drip. The drip's own sends just advance the touch counter.
3. **chat.db is read via sidecar, not directly.** Drip script calls `POST /sync-imessage` — does not need FDA itself.
4. **Campaign upgrade is seamless.** Email-only → combined sequence, same touch number, no restart.
5. **One script, one launchd job, hourly.** No per-lead schedulers.
6. **Approval gate is the default.** Telegram + Mission Control approval before any send. `DRIP_AUTO_SEND=true` removes the gate later.
7. **Touch 0 for Google Ads is handled by the existing webhook.** Engine starts at touch 1.
