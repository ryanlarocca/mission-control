# Cody Brief: Gmail Email Lead Capture

**Date:** 2026-05-04
**Project:** Email Lead Capture — Gmail Push → Supabase + AI Triage
**App:** `/Users/ryanlarocca/.openclaw/workspace/PROJECTS/mission-control/`
**Deploy:** `cd PROJECTS/mission-control && vercel --prod`
**Branch:** `feature/email-lead-capture` ← create this branch before starting

---

## Context for Cody

The CRMS already captures direct mail leads via Twilio (calls, voicemails, SMS) into a Supabase `leads` table. Ryan sent a direct mail campaign with two email addresses on the mailers:

- `ryansvg@lrghomes.com` → **Campaign A** (same bucket as Twilio MFM-A `+16504364279`)
- `ryansvj@lrghomes.com` → **Campaign B** (same bucket as Twilio MFM-B `+16506803671`)

Both are Google Workspace accounts. We want email leads to flow into the same `leads` table with the same UX (Telegram alert, Mission Control lead card, AI triage, status workflow).

**CAMPAIGN_MAP** (already in `lib/leads.ts`) maps phone numbers to campaign labels. We're extending this concept to email addresses.

---

## Infrastructure

### Supabase (LRG Homes project)
- URL: `https://vcebykfbaakdtpspkaek.supabase.co`
- Service role key: in `.env.local` as `LRG_SUPABASE_SERVICE_KEY`
- Table: `leads` — columns include `id`, `caller_phone`, `name`, `email`, `property_address`, `message`, `ai_notes`, `lead_type`, `source_type`, `source`, `status`, `twilio_number`, `recording_url`, `created_at`

### Existing leads table conventions
- `lead_type`: `"call"` | `"voicemail"` | `"sms"` | `"form"` | `"email"` ← new
- `source_type`: `"direct_mail"` | `"google_ads"`
- `source`: human-readable label e.g. `"MFM-A"`, `"MFM-B"` ← use `"SVG-A"` and `"SVJ-B"` for email campaigns
- `twilio_number`: null for outbound/non-Twilio rows
- `status`: `"new"` on insert

### Telegram
- Bot token + chat ID: in `.env.local` as `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`
- Use existing `sendTelegramAlert()` in `lib/leads.ts`

### OpenRouter (AI triage)
- Key: in `.env.local` as `OPENROUTER_API_KEY`
- Model: `anthropic/claude-haiku-4-5` — same as existing triage
- Keep prompts tight — token efficiency is a hard requirement

### Google Cloud / Gmail Push
- We need a Google Cloud project with Pub/Sub enabled
- The Gmail API watch pushes new mail events to a Pub/Sub topic
- Pub/Sub pushes (HTTP POST) to our Mission Control endpoint: `https://mission-control-three-chi.vercel.app/api/leads/email`
- Gmail watches expire every 7 days — need a renewal cron

### Google Service Account
- There is already a Google service account used for Sheets API in `lib/sheets.ts`
- Read `lib/sheets.ts` to find how the service account key is loaded (`GOOGLE_SERVICE_ACCOUNT_KEY` env var)
- We'll reuse this same service account for Gmail API access (it needs to be granted domain-wide delegation or we use OAuth2 — see Part 1 below)

---

## Parts

### Part 1: Google Cloud Pub/Sub + Gmail Watch Setup Script

Create `scripts/setup-gmail-watch.js` — a one-time setup script Thadius will run manually.

**What it does:**
1. Creates a Pub/Sub topic `lrg-gmail-leads` (if not exists) on the Google Cloud project
2. Grants `gmail-api-push@system.gserviceaccount.com` publisher rights on the topic (required by Gmail Push)
3. Creates a Pub/Sub push subscription pointing to `https://mission-control-three-chi.vercel.app/api/leads/email`
4. Calls `gmail.users.watch` on both `ryansvg@lrghomes.com` and `ryansvj@lrghomes.com` with:
   - `topicName`: the Pub/Sub topic ARN
   - `labelIds`: `["INBOX"]`
   - `labelFilterAction`: `"include"`

**Auth approach:**
- Gmail Push requires either OAuth2 (user consent) or a service account with domain-wide delegation
- Check if the existing service account (`GOOGLE_SERVICE_ACCOUNT_KEY`) has domain-wide delegation configured
- If yes: use it with `subject` set to each email address
- If no: output clear instructions for Ryan to either (a) grant domain-wide delegation in Google Admin, or (b) manually run an OAuth2 consent flow
- Script should print exactly what it did and what Ryan needs to do next

**Dependencies:** `googleapis` (already in package.json for Sheets — check first before adding)

---

### Part 2: Gmail Watch Renewal Script

Create `scripts/renew-gmail-watch.js` — called weekly to re-register the watch before it expires (Gmail watches expire in 7 days).

Same logic as Part 1 steps 4 only — just re-calls `gmail.users.watch` on both addresses.

Thadius will set a weekly cron for this after deployment.

---

### Part 3: `/api/leads/email` Webhook Route

Create `app/api/leads/email/route.ts`.

**This endpoint is called by Google Cloud Pub/Sub** (HTTP POST with a JSON body containing a base64-encoded Gmail message notification).

**Flow:**
1. Verify the request is from Pub/Sub (check for `message.data` in body — Pub/Sub push format)
2. Decode the base64 `message.data` to get `{ emailAddress, historyId }`
3. Determine which campaign based on `emailAddress`:
   - `ryansvg@lrghomes.com` → `source: "SVG-A"`, campaign A
   - `ryansvj@lrghomes.com` → `source: "SVJ-B"`, campaign B
4. Use Gmail API to fetch the actual email via `historyId`:
   - Call `gmail.users.history.list` with `startHistoryId` to get message IDs added since last event
   - Call `gmail.users.messages.get` on each new message to get full payload
   - Parse `From` header → sender name + email
   - Parse `Subject` header
   - Extract plain text body (prefer `text/plain` part, strip quoted replies)
   - Extract phone number from body if present (regex: look for 10-digit patterns)
5. Run Haiku triage (see Part 4)
6. Insert into Supabase `leads`:
   - `lead_type: "email"`
   - `source_type: "direct_mail"`
   - `source`: campaign label
   - `name`: parsed sender name (or null)
   - `email`: sender email
   - `caller_phone`: extracted phone (or null)
   - `message`: email subject + "\n\n" + body text (truncated to 2000 chars)
   - `ai_notes`: triage result
   - `status: "new"`
   - `twilio_number: null`
7. Send Telegram alert: `📧 New email lead\n[Campaign A/B]\n👤 <name>\n📧 <email>\n📞 <phone if found>\n🏠 <property if mentioned>\n🤖 AI: <status> — <summary>`
8. Return 200 (Pub/Sub requires 200 or it retries)

**Important:** Use `waitUntil` from `@vercel/functions` for the Gmail fetch + Supabase insert + Telegram (same pattern as `/api/leads/voice/recording`). Return 200 immediately so Pub/Sub doesn't retry.

**Error handling:** Any failure in steps 4-7 should be caught and logged but must NOT cause a non-200 response (Pub/Sub will retry indefinitely on non-200).

**Add to `PUBLIC_PATHS` in middleware** — Pub/Sub hits this without a session cookie.

---

### Part 4: Haiku Email Triage

Add `triageEmailLead(subject: string, body: string): Promise<{ status: LeadStatus, summary: string, suggestedReply: string } | null>` to `lib/leads.ts`.

**Prompt (keep tight — token efficiency is critical):**

```
You are triaging an email response to a real estate direct mail campaign. The sender received a mailer about selling their home.

Subject: {subject}
Body: {body}

Respond in JSON only:
{
  "status": "hot" | "qualified" | "warm" | "junk",
  "summary": "one sentence summary",
  "suggestedReply": "a short, natural text-message-style reply Ryan can send. Warm, direct, no fluff. 1-2 sentences max."
}

hot = wants to sell now or requesting immediate callback
qualified = interested, has a property, wants info
warm = curious, not ready yet
junk = spam, wrong number, unsubscribe
```

- Model: `anthropic/claude-haiku-4-5`, `max_tokens: 200`
- Parse JSON response, validate status enum, return null on any failure (non-fatal)
- Save `suggestedReply` to a new column — see Part 5

---

### Part 5: Schema Migration

Add `suggested_reply TEXT` column to the `leads` table.

Create `scripts/phase8-email-migration.sql`:
```sql
ALTER TABLE leads ADD COLUMN IF NOT EXISTS suggested_reply TEXT;
```

Thadius will run this against Supabase before deploy. Just create the file — do not run it.

---

### Part 6: Mission Control UI — Email Lead Display + Suggested Reply

Update `LeadsTab.tsx` to handle `lead_type="email"` leads:

1. **Email icon** — use `Mail` from lucide-react for `lead_type="email"` in the timeline icon (same pattern as existing type icons)
2. **Email display in expanded card** — when `lead_type="email"`, show the email body (from `message` column) in a readable block in the timeline instead of the audio player
3. **Suggested reply** — if `suggested_reply` is non-null, show a pre-filled textarea below the notes field labeled "💡 Suggested Reply" with the AI draft. This replaces the empty composer for email leads. Ryan can edit and hit Send (uses existing `/api/leads/send` → iMessage composer)
4. **Source badge** — add `"SVG-A"` and `"SVJ-B"` to the campaign badge color map (match MFM-A/MFM-B colors respectively)

---

## Build Order

1. Check `package.json` for `googleapis` — add if missing
2. Part 5: create migration SQL file
3. Part 3: `/api/leads/email` route (core webhook)
4. Part 4: `triageEmailLead` in `lib/leads.ts` + `suggested_reply` field wired in
5. Part 6: UI updates in `LeadsTab.tsx`
6. Part 1: `scripts/setup-gmail-watch.js`
7. Part 2: `scripts/renew-gmail-watch.js`
8. Middleware: add `/api/leads/email` to `PUBLIC_PATHS`
9. `tsc --noEmit` + `next build` — must be clean

---

## Checkpoint Protocol

After completing each major step, announce:
```
✅ CHECKPOINT: [Step Name] complete
Summary: [1-2 sentences]
Files touched: [list]
Blocked: [yes/no — if yes, what you need]
```

If blocked:
```
⏸ BLOCKED: [Issue]
Options: [A, B, C]
Waiting for input.
```

---

## Deploy Gate

Do NOT deploy. When code is written and build is clean:
```
🏁 READY FOR REVIEW
Changed files: [list]
What to test: [list]
Deploy command: cd PROJECTS/mission-control && vercel --prod
```

Wait for explicit deploy instruction.

---

## Wrap-Up

When complete and deployed:
1. Update `PROJECTS/comprehensive-relationship-management/PROJECT_MEMO.md` with what shipped
2. Note follow-ups
3. Final status:
```
✅ PROJECT COMPLETE
Shipped: [summary]
Follow-up: [items]
Memo updated: yes
```

---

## Files Modified (allow-list)

- `app/api/leads/email/route.ts` ← new
- `lib/leads.ts` ← add `triageEmailLead`, `suggested_reply` type updates
- `app/(dashboard)/leads/LeadsTab.tsx` ← UI updates
- `middleware.ts` ← add to PUBLIC_PATHS
- `scripts/setup-gmail-watch.js` ← new
- `scripts/renew-gmail-watch.js` ← new
- `scripts/phase8-email-migration.sql` ← new
- `package.json` ← only if googleapis missing

## DO NOT TOUCH

- Any existing Twilio webhook routes
- `lib/sheets.ts` (read for auth pattern only)
- `app/api/crms/*` routes
- Supabase schema for any table other than `leads`
- `.env.local` (read only — do not modify)
- `vercel --prod` or `git push` without explicit instruction
