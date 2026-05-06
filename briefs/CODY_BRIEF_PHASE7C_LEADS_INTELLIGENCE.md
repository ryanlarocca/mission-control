# Cody Brief — Phase 7C: Leads Tab Intelligence

**Date:** May 6, 2026
**Project:** Mission Control — Leads Tab UX + AI Layer
**App:** `PROJECTS/mission-control/`
**Sidecar:** `PROJECTS/comprehensive-relationship-management/phase2/crms-sidecar.js`
**Deploy:** `cd PROJECTS/mission-control && vercel --prod`
**Branch:** `feature/leads-intelligence` ← create this branch before starting
**Depends on:** Phase 7B (Drip System) — assumes drip schema, campaigns, and engine already exist

---

## Context for Cody

The Leads tab (`/leads`) is live with basic lead management: status filters, contact cards, call/email/SMS timeline, drip queue. Phase 7B built the drip engine (auto follow-up with approval gate). This phase adds the intelligence and UX layer on top:

1. **AI-powered lead summaries** — context at a glance when opening a lead
2. **Auto-status from call transcripts** — AI reads recordings and suggests status changes
3. **Follow-up recommendation system** — AI recommends next call dates, shown in a new tab
4. **Lead card action buttons** — Apply Drip, Send Email, Bad Number, DNC
5. **Auto-drafted text/email** — AI generates drafts on demand
6. **Contact card persistence** — card stays visible during calls
7. **Status system overhaul** — new lifecycle + flag model
8. **Campaign relabeling** — clean up legacy direct mail leads
9. **DNC infrastructure** — standalone list for future mail campaign suppression
10. **Campaign analytics foundations** — tracking per-campaign conversion metrics

---

## Infrastructure (same as 7B)

**Supabase (LRG Homes project):**
- URL: `https://vcebykfbaakdtpspkaek.supabase.co`
- Service role key: in `.env.local` as `LRG_SUPABASE_SERVICE_KEY`

**Sidecar endpoints (localhost:5799):**
- `POST /api/crms/send` — sends iMessage (body: `{ phone, message }`)
- `POST /sync-imessage` — reads chat.db for a phone
- `POST /sync-email` — fetches Gmail thread

**OpenRouter:**
- Key: in `.env.local` as `OPENROUTER_API_KEY`
- Model for AI features: `anthropic/claude-haiku-4-5` (cheap, fast)

**Telegram:** Bot token + chat ID in `.env.local`

---

## Parts

### Part 1: Schema Migration

```sql
-- New status lifecycle (replace existing enum concept)
-- Statuses are stored as TEXT; update all validation/checks to accept these:
-- Lifecycle: new, contacted, active, hot, warm, nurture, dead
-- Flags (separate columns): is_dnc, is_junk, is_bad_number

-- Add flag columns
ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_dnc BOOLEAN DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_junk BOOLEAN DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_bad_number BOOLEAN DEFAULT false;

-- Add AI summary cache
ALTER TABLE leads ADD COLUMN IF NOT EXISTS ai_summary TEXT DEFAULT NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS ai_summary_generated_at TIMESTAMPTZ DEFAULT NULL;

-- Add follow-up recommendation
ALTER TABLE leads ADD COLUMN IF NOT EXISTS recommended_followup_date DATE DEFAULT NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS followup_reason TEXT DEFAULT NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS followup_generated_at TIMESTAMPTZ DEFAULT NULL;

-- Add suggested status (training wheels — AI suggests, Ryan confirms)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS suggested_status TEXT DEFAULT NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS suggested_status_reason TEXT DEFAULT NULL;

-- Add campaign_label for historical relabeling
ALTER TABLE leads ADD COLUMN IF NOT EXISTS campaign_label TEXT DEFAULT NULL;

-- DNC list table (standalone, maps to direct mail CSV format)
CREATE TABLE IF NOT EXISTS dnc_list (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  -- Core matching fields
  parcel_number TEXT,
  owner_name TEXT,
  site_address TEXT,
  site_city TEXT,
  site_state TEXT DEFAULT 'CA',
  site_zip TEXT,
  mail_address TEXT,
  mail_city TEXT,
  mail_state TEXT,
  mail_zip TEXT,
  county TEXT,
  -- Metadata
  source_lead_id UUID REFERENCES leads(id),
  reason TEXT, -- 'requested', 'hostile', 'wrong_number', 'manual'
  added_at TIMESTAMPTZ DEFAULT now(),
  added_by TEXT DEFAULT 'system' -- 'system' or 'ryan'
);

-- Campaign analytics table
CREATE TABLE IF NOT EXISTS campaign_metrics (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  campaign_source TEXT NOT NULL, -- 'MFM-A', 'MFM-B', 'DM-Legacy', etc.
  total_leads INTEGER DEFAULT 0,
  total_calls INTEGER DEFAULT 0,
  total_texts INTEGER DEFAULT 0,
  total_emails INTEGER DEFAULT 0,
  total_voicemails INTEGER DEFAULT 0,
  hot_count INTEGER DEFAULT 0,
  warm_count INTEGER DEFAULT 0,
  nurture_count INTEGER DEFAULT 0,
  dead_count INTEGER DEFAULT 0,
  dnc_count INTEGER DEFAULT 0,
  junk_count INTEGER DEFAULT 0,
  last_computed_at TIMESTAMPTZ DEFAULT now()
);

-- Status migration: remap old statuses to new lifecycle
UPDATE leads SET status = 'nurture' WHERE status = 'qualified';
UPDATE leads SET status = 'dead', is_dnc = true WHERE status = 'do_not_contact';
UPDATE leads SET is_junk = true WHERE status = 'junk';
-- 'unqualified' → keep as 'contacted' (it was a soft mismatch, not dead)
UPDATE leads SET status = 'contacted' WHERE status = 'unqualified';
-- Keep: new, hot, warm, active, contacted — these map 1:1
```

Run via `node scripts/run-migration.mjs scripts/phase7c-leads-intelligence.sql`.

**Status type update** — everywhere `LeadStatus` is defined, replace with:
```typescript
type LeadStatus = "new" | "contacted" | "active" | "hot" | "warm" | "nurture" | "dead"
```

Flags (`is_dnc`, `is_junk`, `is_bad_number`) are separate booleans, not statuses. A lead can be `warm` + `is_bad_number = true` (drip switches to email-only). DNC overrides everything (all outreach stops).

---

### Part 2: Campaign Relabeling

Old leads from prior direct mail campaigns (SVR-A, SVR-B, SVG-A, SVJ-B, and any other non-MFM sources) need a clean label. These predate the current MFM-A/MFM-B campaigns.

**Migration script** (`scripts/relabel-legacy-campaigns.mjs`):

```javascript
// Logic:
// 1. Query all leads WHERE source NOT IN ('MFM-A', 'MFM-B', 'Google Ads')
//    AND source_type = 'direct_mail'
// 2. For each: set campaign_label = 'DM-Legacy'
// 3. Also set campaign_label on current leads:
//    - source = 'MFM-A' → campaign_label = 'MFM-A'
//    - source = 'MFM-B' → campaign_label = 'MFM-B'
//    - source_type = 'google_ads' → campaign_label = 'Google Ads'
//
// campaign_label becomes the canonical display label.
// source field stays unchanged (historical data integrity).
```

**UI impact:** The `SOURCE_BADGE` map in `LeadsTab.tsx` should use `campaign_label` for display. Add:
```typescript
"DM-Legacy": "bg-zinc-700 text-zinc-300",
```

**Future campaigns:** When Ryan loads a new mailing list, those leads get `campaign_label = '<campaign_name>'` at import time. The naming convention going forward is: `DM-<identifier>` for direct mail (e.g., `DM-MFM-A`, `DM-MFM-B`, `DM-Legacy`).

---

### Part 3: AI Lead Summary (Cached)

When a user opens/expands a lead card, the system should display a concise AI-generated summary of everything known about that lead.

**API route:** `POST /api/leads/[id]/summary`

```typescript
// 1. Check if ai_summary exists AND ai_summary_generated_at is after the most recent event
//    → if fresh, return cached summary
// 2. If stale or missing:
//    a. Gather all context: lead events, iMessage history (sidecar), Gmail threads, notes
//    b. Call Haiku with a summary prompt
//    c. Store result in ai_summary + ai_summary_generated_at
//    d. Return summary
```

**Prompt:**
```
You are summarizing a real estate lead for a cash home buyer named Ryan.
Produce a 3-5 bullet summary covering:
- Who they are (name, property if known)
- How they came in (source, date)
- Where things stand (last contact, sentiment, any key quotes)
- What's next (pending drip touch, recommended action)

Be concise. No fluff. Use fragments not full sentences.

LEAD DATA:
{serialized lead + events + messages}
```

**Token cost:** ~1500 input + ~200 output per summary = ~$0.001 at Haiku pricing. Cached so only regenerates after new activity.

**UI:** Display the summary in a collapsible section at the top of the expanded lead card. Auto-fetch on card expand. Show a spinner while generating. If cached, instant display.

---

### Part 4: Auto-Status System (Training Wheels)

After a call recording is transcribed, AI reads the transcript and suggests a status update.

**Trigger:** When a new recording lands (a lead row with `recording_url` is inserted or updated), fire this analysis.

**API route:** `POST /api/leads/[id]/analyze-call`

```typescript
// 1. Fetch the transcription from ai_notes (already generated by existing pipeline)
//    OR fetch recording_url → transcribe if needed
// 2. Call Haiku with classification prompt
// 3. Store result in suggested_status + suggested_status_reason
// 4. Invalidate ai_summary cache (new activity)
// 5. Send Telegram notification: "📊 Status suggestion for {name}: {status} — {reason}"
```

**Classification prompt:**
```
You are classifying a real estate seller lead based on a phone call transcript.
Ryan is a cash home buyer. The caller is a property owner.

Classify into exactly ONE status:
- hot: Actively wants to sell now or within 1-2 months. Motivated.
- warm: Open to selling in 3-6 months. Not urgent but interested.
- nurture: Longer term (6+ months), curious but no timeline. "Maybe someday."
- dead: Explicitly not interested. "Don't call me." "Not selling." No ambiguity.
- contacted: Inconclusive call. Brief, couldn't determine interest level.

Also extract:
- recommended_followup_date: When Ryan should call back (ISO date, or null if dead)
- followup_reason: One sentence why that date (e.g., "Said they'll decide after summer")

Respond as JSON only:
{ "status": "...", "reason": "...", "recommended_followup_date": "YYYY-MM-DD" | null, "followup_reason": "..." }

TRANSCRIPT:
{transcript}
```

**UI (training wheels):** On the lead card, show a banner:
```
🤖 Suggested: Hot — "Caller said they want to sell before July, asking about timeline"
[Accept] [Dismiss]
```

Clicking Accept updates the lead's `status` to the suggested value and sets `recommended_followup_date`. Clicking Dismiss clears `suggested_status`.

**Future (full auto):** When `AUTO_STATUS=true` env var is set, skip the banner and apply directly. Default is `false` (training wheels).

---

### Part 5: Follow-Up Recommendation Tab

A new sub-tab inside the Leads section showing all leads with a `recommended_followup_date`, sorted by date (soonest first).

**UI component:** `components/widgets/FollowUpTab.tsx`

```typescript
// Fetch: GET /api/leads?has_followup=true&sort=followup_date_asc
// Display as a simple to-do list:
// [Date] [Name/Phone] [Property] [Reason] [Call button]
//
// Grouped by:
// - Overdue (date < today)
// - Today
// - This week
// - Later
```

Each row has:
- Lead name + phone (clickable → opens lead card)
- Property address
- Follow-up reason (from AI)
- "Call" button (triggers existing outbound call flow)
- "Done" button (clears followup after call is made)
- "Snooze" dropdown (push 1 day / 3 days / 1 week)

**Drip interaction:** When Ryan makes a follow-up call (logged in the system), the 14-day drip cool-off rule from Phase 7B applies. The follow-up tab only *recommends* — it doesn't pause drip. But the *call itself* pauses drip (same as any outbound call).

**Auto-clear:** When a new call is logged for a lead that has a `recommended_followup_date`, clear the recommendation (it's been acted on). AI will generate a new one from the new call's transcript if warranted.

---

### Part 6: Lead Card Action Buttons

Add the following buttons to each expanded lead card in `LeadsTab.tsx`:

**1. Apply Drip** (only shows if `drip_campaign_type IS NULL` and not DNC/Junk)
- On click: system checks available contact info
  - Has phone → assigns `direct_mail_call` campaign
  - Has email only → assigns `direct_mail_email` campaign
  - Has both → assigns `direct_mail_call` (phone takes priority, email included)
- Sets `drip_touch_number = 0`, `last_drip_sent_at = now()`
- Drip engine picks it up on next hourly run
- For bulk: add a "Select" checkbox on each lead card + "Apply Drip to Selected" button in the header toolbar. Each selected lead gets auto-routed to the appropriate campaign type.
- API: `POST /api/leads/[id]/apply-drip` (body: `{}` — server determines campaign type)
- Bulk: `POST /api/leads/bulk-apply-drip` (body: `{ leadIds: string[] }`)

**2. Send Email** (only shows if lead has an email address)
- Opens a compose modal with AI-generated draft (see Part 7 below)
- Ryan edits if needed → clicks Send
- Fires via Gmail API (same as drip email sends)
- API: `POST /api/leads/[id]/send-email` (body: `{ subject, body }`)

**3. Bad Number** 🚫
- Sets `is_bad_number = true` on the lead
- Effect on drip: if campaign includes phone/SMS touches, those get skipped — drip continues with email-only touches. If no email exists, drip halts entirely (lead becomes junk).
- UI: phone number shows with strikethrough + "Bad #" badge
- API: `PATCH /api/leads/[id]` (body: `{ is_bad_number: true }`)
- Drip engine update: when processing a touch, check `is_bad_number`. If touch channel is `imessage`, skip to next email touch. If no email touches remain, halt.

**4. DNC** 🛑
- Sets `is_dnc = true`
- Immediately halts ALL outreach (drip stops, no calls, no texts, no emails)
- Adds entry to `dnc_list` table with available fields (site address, owner name, etc.)
- UI: lead card gets red border + "DNC" badge, all action buttons hidden except "Remove DNC"
- API: `POST /api/leads/[id]/dnc` (body: `{ reason: 'requested' | 'hostile' | 'manual' }`)
- Also creates the `dnc_list` row by pulling fields from the lead record

**5. Mark Junk**
- Sets `is_junk = true`
- Drip stops but lead stays in system (for campaign analytics)
- Both phone AND email are bad, or the lead is clearly not a real prospect
- API: `PATCH /api/leads/[id]` (body: `{ is_junk: true }`)

---

### Part 7: Auto-Drafted Text & Email (On-Demand)

When Ryan clicks a "Draft Text" or "Draft Email" button on a lead card, AI generates a contextual message.

**API route:** `POST /api/leads/[id]/draft-message`

```typescript
// Body: { channel: 'imessage' | 'email' }
// 1. Gather lead context (events, iMessage history, Gmail threads, AI summary)
// 2. Call Haiku to generate a draft
// 3. Return { message, subject? } — NOT sent yet
// Ryan reviews in UI, edits if needed, then clicks Send
```

**Prompt (iMessage):**
```
You are drafting a text message from Ryan, a cash home buyer in the Bay Area.
This is a MANUAL follow-up (not part of the automated drip). Write as if Ryan typed it himself.

RULES:
- 1-3 sentences. Sound human. No emojis.
- Reference specific context from the conversation (property, last topic discussed, etc.)
- Goal: re-engage, get them on a phone call
- No sign-off

LEAD CONTEXT:
{name, property, conversation_history, last_contact_date, status}
```

**Prompt (email):**
```
Same as above but:
- 3-6 sentences. Professional but casual.
- Include a subject line (short, specific, not salesy)
- End with "— Ryan" only
- Reference the property or prior conversation specifically
```

**UI:** Button shows on the lead card. Clicking opens a draft preview modal. Ryan can edit inline. "Send" fires the message. "Cancel" discards.

---

### Part 8: Contact Card Persistence During Calls

**Problem:** When Ryan initiates a call from the Leads tab, the contact card (address, name, phone, notes) disappears from view.

**Fix:** The expanded lead card must remain visible and scrollable while a call is active. The call UI (if it's a modal or overlay) should NOT collapse the lead card.

**Implementation:**
- If the call button triggers a modal: make it a small floating panel (top-right or bottom-right) instead of a full-screen overlay
- The lead card stays expanded underneath
- Key info (property address, name, AI summary, notes) remains readable during the call
- If using the browser's `tel:` link or Twilio's outbound call API, the card should simply stay open — no state change on click

Check `LeadsTab.tsx` for what happens when the call/phone button is clicked. The fix is likely preventing a state change (like collapsing the card or navigating away) on call initiation.

---

### Part 9: DNC List Infrastructure

The `dnc_list` table (created in Part 1) serves as a standalone suppression list for future mailing campaigns.

**Export endpoint:** `GET /api/dnc/export?format=csv`
- Returns all `dnc_list` rows as a CSV matching the direct mail format:
  - Columns: `Parcel Number, Owner Name, Site Address, Site City, Site State, Site Zip, Mail Address, Mail City, Mail State, Mail Zip, County, Reason, Added Date`
- Ryan downloads this before sending a new campaign and cross-references against his mailing list
- Primary match key: `site_address` + `site_city` (most reliable data we'll have)
- Secondary: `parcel_number` if available, `owner_name` as fallback

**Auto-population:** When a lead is flagged DNC (Part 6 button), the system pulls whatever address/owner data exists on the lead and creates the `dnc_list` row. Most fields will be sparse — that's expected. The `site_address` field will usually be populated from `property_address` on the lead.

**Import endpoint (future):** `POST /api/dnc/import` — bulk upload from CSV. Not needed for this phase but structure the table to support it later.

---

### Part 10: Campaign Analytics Foundations

Add basic per-campaign tracking so Ryan can see conversion rates.

**Compute script:** `scripts/compute-campaign-metrics.mjs`
- Runs on demand (or add to a daily cron later)
- Queries `leads` table grouped by `campaign_label`
- Counts: total leads, calls, texts, emails, voicemails per campaign
- Counts by status: hot, warm, nurture, dead, dnc, junk
- Writes results to `campaign_metrics` table (upsert by `campaign_source`)

**UI (simple for now):** A small stats section at the top of the Leads tab or a separate "Analytics" sub-tab:
```
MFM-A: 47 leads | 12 calls | 8 texts | 3 hot | 5 warm | 2 dead
MFM-B: 39 leads | 9 calls | 6 texts | 2 hot | 4 warm | 1 dead
DM-Legacy: 23 leads | 0 calls | 0 texts | 0 hot | 0 warm | 0 dead
Google Ads: 15 leads | 3 calls | 5 texts | 1 hot | 2 warm | 0 dead
```

This is the foundation — we'll build richer dashboards later but the data collection starts now.

---

## Build Order

1. **Part 1** — Schema migration (new columns, flags, tables, status remap)
2. **Part 2** — Campaign relabeling script (run once, sets campaign_label on all leads)
3. **Part 8** — Contact card persistence (quick UX fix, no backend)
4. **Part 6** — Lead card action buttons (Apply Drip, Send Email, Bad Number, DNC, Junk)
5. **Part 9** — DNC list infrastructure (export endpoint, auto-population from Part 6 button)
6. **Part 3** — AI lead summary (cached, on card expand)
7. **Part 7** — Auto-drafted text/email (on-demand button)
8. **Part 4** — Auto-status system (call transcript → suggested status)
9. **Part 5** — Follow-up recommendation tab
10. **Part 10** — Campaign analytics foundations

---

## Status System Reference

**Lifecycle statuses** (mutually exclusive — auto-advance or AI-suggested):

| Status | Meaning | How it's set |
|---|---|---|
| new | Just imported, untouched | System (on intake) |
| contacted | Attempted contact, no real convo | System (on first outbound call/text/email) |
| active | In pipeline, engaged, drip running | System (on first inbound reply) |
| hot | Selling immediately (1-2 months) | AI suggested → Ryan confirms |
| warm | 3-6 months | AI suggested → Ryan confirms |
| nurture | Longer term, curious but no timeline | AI suggested → Ryan confirms |
| dead | Explicitly not interested | AI suggested → Ryan confirms |

**Auto-advance rules (no AI needed):**
- `new` → `contacted`: when first outbound (call, text, or email) is logged
- `contacted` → `active`: when first inbound reply is received (iMessage, email, or call back)

**Flags (stack on top of any status):**

| Flag | Column | Effect |
|---|---|---|
| DNC | `is_dnc` | ALL outreach stops. Lead visible but locked. Added to `dnc_list`. |
| Junk | `is_junk` | Drip stops. Lead stays for analytics. Hidden from active views by default. |
| Bad Number | `is_bad_number` | Phone drip stops. Email-only continues. If no email → becomes junk. |

**Drip engine integration:** Update the drip engine's WHERE clause:
```sql
WHERE drip_campaign_type IS NOT NULL
  AND is_dnc = false
  AND is_junk = false
  AND status != 'dead'
```
When `is_bad_number = true` and next touch is `imessage`, skip to next `email` touch.

---

## Checkpoint Protocol

**IMPORTANT:** After completing each Part, announce clearly:

```
✅ CHECKPOINT: Part [N] — [Title] complete
Summary: [1-2 sentences]
Files touched: [list]
Blocked: [yes/no]
```

If blocked:
```
⏸ BLOCKED: [Issue]
Options: [A, B, C]
Waiting for input.
```

**Do NOT proceed past a blocker without input.**

---

## Deploy Gate

**Do NOT deploy to production.** When all code is written:
```
🏁 READY FOR REVIEW
Changed files: [list]
What to test: [list]
Deploy command: cd PROJECTS/mission-control && vercel --prod
```

Wait for explicit "deploy" instruction.

---

## Env Vars

Existing (no new ones needed for this phase):
- `LRG_SUPABASE_URL`
- `LRG_SUPABASE_SERVICE_KEY`
- `OPENROUTER_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `SIDECAR_URL=http://localhost:5799`
- `DRIP_AUTO_SEND=false`

New (optional, defaults to false):
- `AUTO_STATUS=false` — when true, AI status applies immediately without confirmation

---

## Files Modified (allow-list)

**New files:**
- `scripts/phase7c-leads-intelligence.sql`
- `scripts/relabel-legacy-campaigns.mjs`
- `scripts/compute-campaign-metrics.mjs`
- `components/widgets/FollowUpTab.tsx`
- `app/api/leads/[id]/summary/route.ts`
- `app/api/leads/[id]/analyze-call/route.ts`
- `app/api/leads/[id]/draft-message/route.ts`
- `app/api/leads/[id]/apply-drip/route.ts`
- `app/api/leads/[id]/dnc/route.ts`
- `app/api/leads/bulk-apply-drip/route.ts`
- `app/api/dnc/export/route.ts`

**Modified files:**
- `components/widgets/LeadsTab.tsx` — action buttons, status overhaul, flag badges, summary display, campaign_label display, contact card persistence, bulk select
- `app/api/leads/route.ts` — accept new statuses, flag updates, followup queries
- `lib/leads.ts` — updated LeadStatus type, flag handling, campaign_label helpers
- `lib/drip-campaigns.ts` — bad number skip logic

**DO NOT TOUCH:** (same as Phase 7B list)
- `app/api/crms/*`
- `app/api/leads/call/*`
- `app/api/leads/voice/recording/route.ts`
- Google Sheets integration
- Auth middleware logic
- `phase2/crms-enrich*.js`
- Any `com.openclaw.*` launchd plists

---

## Key Decisions (locked)

1. **Statuses are lifecycle stages; DNC/Junk/BadNumber are flags.** A lead can be `warm` + `is_bad_number`. DNC is absolute.
2. **AI summary is cached in DB.** Only regenerates after new activity on that lead.
3. **Auto-status uses training wheels.** AI suggests, Ryan confirms. `AUTO_STATUS=true` removes gate later.
4. **Follow-up tab runs parallel to drip.** They don't block each other. An actual call triggers the 14-day drip cool-off.
5. **Apply Drip auto-routes campaign type** based on available contact data. Bulk select supported.
6. **DNC list matches on site_address + site_city.** Most other fields will be sparse. That's fine.
7. **Legacy campaigns labeled `DM-Legacy`.** Future campaigns get `DM-<name>` convention.
8. **Draft text/email is on-demand** (button click). Not auto-generated. Ryan approves before send.
9. **Campaign analytics are foundational.** Just counts for now. Richer dashboards later.
10. **Contact card stays visible during calls.** No state collapse on call initiation.

