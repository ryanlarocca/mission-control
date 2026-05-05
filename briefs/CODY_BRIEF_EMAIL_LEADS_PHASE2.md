# Cody Brief: Email Leads — Phase 2
**Date:** 2026-05-05
**Project:** Mission Control — Email Lead Capture (Phase 2)
**App:** `PROJECTS/mission-control/`
**Deploy:** `cd PROJECTS/mission-control && vercel --prod`
**Branch:** `feature/email-leads-phase2` ← create this branch before starting

---

## Context for Cody

Email lead capture was built in Phase 1 (feature/email-lead-capture). The `/api/leads/email` webhook accepts inbound leads from `ryansvg@lrghomes.com` (Campaign A) and `ryansvj@lrghomes.com` (Campaign B). It's live and inserting rows into Supabase.

**Six problems/features in this build:**

1. **Wrong campaign tags** — Email leads are tagged `SVJ-B` regardless of mailbox. Fix: map by mailbox instead of Twilio number.
2. **No grouping key for phone-less leads** — `LeadsTab` groups by `caller_phone`; email-only leads fall through. Fix: fallback grouping by email address.
3. **No way to add a phone number after the fact** — Once Ryan gets a phone number from an email lead, there's no UI to attach it. Adding it should save to Supabase, activate the Call button, and allow future Twilio calls to auto-merge.
4. **"(empty)" bubbles in the timeline** — Auto-outbound rows are being inserted without a message body, rendering as empty bubbles. Fix: save the actual auto-message copy to the row and hide any remaining null-message bubbles.
5. **iMessage thread not syncing** — When Ryan texts a lead directly from his iPhone, those messages never appear in Mission Control. Fix: auto-sync from chat.db via the sidecar when a lead card is expanded.
6. **Email thread not syncing** — When Ryan replies to a lead via Gmail, those exchanges don't appear in Mission Control. Fix: store `gmail_thread_id` on the lead row at creation and sync the full thread via sidecar's `gog` Gmail auth when the card is expanded.

---

## Infrastructure

**Supabase (LRG Homes project):**
- URL: `https://vcebykfbaakdtpspkaek.supabase.co`
- Service role key: in `.env.local` as `LRG_SUPABASE_SERVICE_KEY`
- Table: `leads`
- Current columns: `id`, `caller_phone`, `email`, `name`, `source`, `source_type`, `lead_type`, `status`, `message`, `suggested_reply`, `ai_notes`, `created_at`, `twilio_number`
- **New column needed (Part 6):** `gmail_thread_id TEXT` — run migration via Supabase SQL editor or ask Thadius to run it

**Campaign mapping (email mailbox → campaign):**
- `ryansvg@lrghomes.com` → source: `"MFM-A"`, source_type: `"direct_mail"`
- `ryansvj@lrghomes.com` → source: `"MFM-B"`, source_type: `"direct_mail"`

**CRMS Sidecar:**
- Running on Mac mini at `localhost:5799` via Cloudflare tunnel
- Tunnel URL is in `.env.local` as `CRMS_SIDECAR_URL`
- Has FDA (Full Disk Access) — can read `~/Library/Messages/chat.db`
- Has `gog` Gmail OAuth — can read Gmail via `gog gmail list` / `gog gmail thread`
- Existing endpoints: `/api/crms/send`, `/api/crms/enrich-one`, etc.
- **New endpoints to add (Parts 5 + 6):** `/api/leads/sync-imessage` and `/api/leads/sync-email`

**Existing files to read before starting:**
- `app/api/leads/email/route.ts` — email webhook (tagging bug lives here)
- `lib/leads.ts` — `CAMPAIGN_MAP`, `sendTelegramAlert`, `triageEmailLead`, shared helpers
- `app/leads/LeadsTab.tsx` — grouping logic + card rendering
- `app/api/leads/route.ts` — GET + PATCH endpoint
- `app/api/leads/call/route.ts` — call relay (model for call button logic)
- `crms-sidecar.js` (in PROJECTS/mission-control or workspace root — find it) — sidecar server, add new endpoints here

---

## Parts

### Part 1: Fix Campaign Tagging in Email Webhook

**File:** `app/api/leads/email/route.ts` + `lib/leads.ts`

The webhook receives a `mailbox` field in the POST body. Map it to the correct campaign:

```typescript
// Add to lib/leads.ts alongside CAMPAIGN_MAP
export const EMAIL_CAMPAIGN_MAP: Record<string, { source: string; source_type: string }> = {
  'ryansvg@lrghomes.com': { source: 'MFM-A', source_type: 'direct_mail' },
  'ryansvj@lrghomes.com': { source: 'MFM-B', source_type: 'direct_mail' },
};
```

In `route.ts`, replace whatever is currently hardcoding `SVJ-B` with:
```typescript
const campaign = EMAIL_CAMPAIGN_MAP[mailbox] ?? { source: 'Unknown', source_type: 'direct_mail' };
```
If `mailbox` is unrecognized, log a warning: `console.warn('[email-webhook] Unknown mailbox:', mailbox)`.

---

### Part 2: Email-Based Lead Grouping in LeadsTab

**File:** `app/leads/LeadsTab.tsx`

Update the grouping key logic wherever leads are reduced into groups:

```typescript
const groupKey = (lead: Lead): string =>
  lead.caller_phone ?? (lead.email ? `email:${lead.email}` : `id:${lead.id}`);
```

- `caller_phone` present → group by phone (unchanged)
- No phone, but email present → group by `email:${email}`
- Neither → group by `id:${id}` (edge case safety)

**Card header for email-only groups** (where the group key starts with `email:`):
- Display email address where phone normally shows
- Use `Mail` (envelope) icon instead of `Phone` icon
- Show name if available in the card header
- Show campaign badge as normal
- Do NOT render the `tel:` phone link or Call button (no number yet — Part 3 adds the input)

---

### Part 3: Manual Phone Entry on Email-Only Cards

**Backend — `app/api/leads/route.ts` PATCH handler:**

Extend to accept `caller_phone`:

```typescript
const { id, status, notes, caller_phone } = await req.json();
const updates: Record<string, unknown> = {};
if (status !== undefined) updates.status = status;
if (notes !== undefined) updates.notes = notes;
if (caller_phone !== undefined) updates.caller_phone = normalizePhone(caller_phone);
```

Add `normalizePhone` helper in `lib/leads.ts`:
```typescript
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return raw; // return as-is, let it fail gracefully
}
```

**Frontend — `app/leads/LeadsTab.tsx`:**

In the expanded view of email-only cards (where `caller_phone` is null), below the email address line, add:

```
[ Add phone number          ] [Save]
```

- Small text input + emerald Save button
- On Save: `PATCH /api/leads` with `{ id, caller_phone: inputValue }`
- **Optimistic UI:** immediately update the group's local `caller_phone` in component state so the Call button renders without waiting for the 30s refresh
- Show a small inline error message if PATCH fails
- On next auto-refresh, the card re-groups under the phone number automatically (no special handling needed)

**Call button:**
Once `caller_phone` is set (optimistically or from DB), the emerald Call button renders exactly as it does for phone-grouped cards — same `/api/leads/call` relay, no changes needed there.

---

### Part 4: Fix "(empty)" Timeline Bubbles

**Context:** When the auto-outbound acknowledgment fires (the "Is there anything I can do to help?" message), it inserts a Supabase row but the `message` field is empty or null, causing "(empty)" bubbles in the timeline.

**Two-part fix:**

**4a — Save the message text.** Find where the auto-outbound row is being inserted (likely in `app/api/leads/email/route.ts` or wherever the auto-reply fires). Ensure the actual message copy is passed as `message` in the Supabase insert. The copy is something like: *"Hi, I saw you reached out. Is there anything I can do to help you with your home?"* — check the existing code for the actual string, use whatever is there.

**4b — Hide null/empty bubbles in the UI.** In `LeadsTab.tsx`, wherever timeline events render, add a guard:
```typescript
// Don't render bubbles with no content
if (!event.message && !event.recording_url && !event.transcription) return null;
```
This prevents any future null-message rows from showing as "(empty)" regardless of cause.

---

### Part 5: Auto-Sync iMessage Thread on Card Expand

When a lead card is expanded, silently fetch any matching iMessage/SMS thread from chat.db via the sidecar and merge it into the timeline.

**New sidecar endpoint — add to `crms-sidecar.js`:**

```javascript
app.post('/api/leads/sync-imessage', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });

  // Normalize the phone to the format chat.db uses (strip +1, or use E.164 — check what chat.db stores)
  const messages = await fetchLeadMessages(phone); // query chat.db for this phone
  res.json({ messages });
});
```

`fetchLeadMessages(phone)` should:
- Query chat.db (sidecar already has FDA) for all messages with this phone number
- Return array of `{ text, timestamp, is_from_me }` sorted ascending by timestamp
- Handle both E.164 (`+1XXXXXXXXXX`) and 10-digit formats in the WHERE clause

**New Mission Control endpoint — `app/api/leads/sync-imessage/route.ts`:**

```typescript
// Auth-gated (uses mc_session cookie like other CRUD routes)
POST { phone: string }
→ proxies to CRMS_SIDECAR_URL/api/leads/sync-imessage
→ returns { messages: [{ text, timestamp, is_from_me }] }
```

**Frontend — `LeadsTab.tsx`:**

In the `onExpand` handler (wherever `isExpanded` flips to true), fire the sync in the background:

```typescript
const onExpand = async (groupKey: string, phone: string | null) => {
  setExpandedGroup(groupKey);
  if (!phone) return; // email-only, no iMessage to sync
  
  // Background sync — don't await, don't block expand
  fetch('/api/leads/sync-imessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  })
    .then(r => r.json())
    .then(({ messages }) => {
      if (!messages?.length) return;
      // Merge into local timeline state for this group
      // Dedupe by timestamp+text to avoid duplicates with existing Supabase rows
      mergeIMessageEvents(groupKey, messages);
    })
    .catch(() => {}); // silent fail — sync is best-effort
};
```

`mergeIMessageEvents` should add any messages not already in the local timeline (dedupe on `timestamp` + `text`). iMessage events should render as timeline bubbles with a distinct style — maybe a gray left-aligned bubble with a small Apple Messages–style indicator, or just use the existing SMS bubble style.

The 30s auto-refresh continues to operate normally and will not interfere with the merged local events.

---

### Part 6: Auto-Sync Gmail Thread on Card Expand

When a lead card (email-grouped or phone-grouped with an email) is expanded, fetch the full Gmail thread via the sidecar and merge it into the timeline.

**Schema migration needed:**

Add `gmail_thread_id TEXT` column to the `leads` table. Run this SQL via Supabase SQL editor (or ask Thadius):
```sql
ALTER TABLE leads ADD COLUMN IF NOT EXISTS gmail_thread_id TEXT;
```

**Update email webhook to save thread ID:**

In `app/api/leads/email/route.ts`, the incoming webhook payload should include the Gmail `threadId` (check what the Apps Script / Pub/Sub payload sends). Save it:
```typescript
// In the Supabase insert
gmail_thread_id: payload.threadId ?? null,
```

**New sidecar endpoint — add to `crms-sidecar.js`:**

```javascript
app.post('/api/leads/sync-email', async (req, res) => {
  const { threadId } = req.body;
  if (!threadId) return res.status(400).json({ error: 'threadId required' });

  try {
    // Use gog CLI to fetch the thread
    const result = await execPromise(`/opt/homebrew/bin/gog gmail thread ${threadId} --account info@lrghomes.com --format json`);
    const thread = JSON.parse(result.stdout);
    res.json({ messages: thread.messages ?? [] });
  } catch (err) {
    console.error('[sync-email] gog error:', err);
    res.status(500).json({ error: 'Failed to fetch thread' });
  }
});
```

Note: Check what `gog gmail thread` actually returns — look at the gog CLI help or test it manually before implementing the parser. The goal is to get an array of `{ from, to, subject, body, timestamp, is_from_ryan }` messages. `is_from_ryan` = true when `from` contains `lrghomes.com`.

**New Mission Control endpoint — `app/api/leads/sync-email/route.ts`:**

```typescript
// Auth-gated
POST { threadId: string }
→ proxies to CRMS_SIDECAR_URL/api/leads/sync-email
→ returns { messages: [{ from, to, subject, body, timestamp, is_from_ryan }] }
```

**Frontend — `LeadsTab.tsx`:**

Extend the `onExpand` handler to also fire the email sync when the lead has a `gmail_thread_id`:

```typescript
if (lead.gmail_thread_id) {
  fetch('/api/leads/sync-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId: lead.gmail_thread_id }),
  })
    .then(r => r.json())
    .then(({ messages }) => {
      if (!messages?.length) return;
      mergeEmailEvents(groupKey, messages);
    })
    .catch(() => {});
}
```

Email events in the timeline:
- Use envelope icon, label "Email"
- Show sender name / email as subtitle
- Show email body (truncated to ~200 chars with expand option if long)
- Ryan's outbound emails right-aligned (emerald), inbound left-aligned (gray) — same visual convention as SMS/iMessage

---

## Build Order

Execute in this order — each part is independently testable:

1. **Part 1** — campaign tag fix. Quickest, standalone, no UI. Ship and verify first.
2. **Part 2** — email grouping. UI-only, no backend.
3. **Part 3** — manual phone entry. Backend first (`normalizePhone` + PATCH extension), then UI.
4. **Part 4** — empty bubble fix. Check email webhook for missing message copy, add UI guard.
5. **Part 5** — iMessage auto-sync. Sidecar endpoint first, then Mission Control proxy, then UI.
6. **Part 6** — Gmail thread sync. Schema migration first (ask Thadius if needed), then sidecar endpoint, then MC proxy, then UI.

---

## Checkpoint Protocol

After completing each part, announce:

```
✅ CHECKPOINT: Part N — [Name] complete
Summary: [1-2 sentences]
Files touched: [list]
Blocked: [yes/no — if yes, describe]
```

If blocked:
```
⏸ BLOCKED: [Description]
Options: [A / B / C if applicable]
Waiting for input.
```

**Do NOT proceed past a blocker without input from Thadius.**

---

## Deploy Gate

**Do NOT deploy to production.** When all parts are done and `tsc --noEmit` + `next build` are clean:

```
🏁 READY FOR REVIEW
Changed files: [list]
What to test:
  1. Email lead via ryansvg → MFM-A badge ✓
  2. Email lead via ryansvj → MFM-B badge ✓
  3. Email-only lead renders card grouped by email with envelope icon ✓
  4. "Add phone" input on email-only card → Call button activates on save ✓
  5. No "(empty)" bubbles in timeline ✓
  6. Expand a lead card with a known phone → iMessage thread appears in timeline ✓
  7. Expand an email lead card with gmail_thread_id → Gmail thread appears in timeline ✓
Deploy command: cd PROJECTS/mission-control && vercel --prod
```

Wait for explicit "deploy" from Ryan.

---

## Wrap-Up

When complete and deployed:
1. Update `PROJECTS/comprehensive-relationship-management/PROJECT_MEMO.md`:
   - Under `## ⚡ Live Now`: note that email leads now map to correct campaigns, group by email, support manual phone entry, and sync Gmail threads on expand; phone leads auto-sync iMessage on expand
   - Under `## 📜 History`: add "Phase 7.4 — Email Leads Phase 2 (2026-05-05)"
2. Final status:
```
✅ PROJECT COMPLETE
Shipped: [summary]
Follow-up: [any items]
Memo updated: yes
```

---

## Files Modified (allow-list)

- `app/api/leads/email/route.ts`
- `app/api/leads/route.ts`
- `app/api/leads/sync-imessage/route.ts` ← new file
- `app/api/leads/sync-email/route.ts` ← new file
- `app/leads/LeadsTab.tsx`
- `lib/leads.ts`
- `crms-sidecar.js` (add two new endpoints)
- `PROJECTS/comprehensive-relationship-management/PROJECT_MEMO.md`

Anything outside this list → ask Thadius first.

---

## DO NOT TOUCH

- `app/api/leads/voice/route.ts` — Twilio voice webhook (working)
- `app/api/leads/sms/route.ts` — Twilio SMS webhook (working)
- `app/api/leads/call/route.ts` — call relay (working)
- `app/api/leads/call/bridge/route.ts` — Twilio bridge webhook (working)
- `app/api/leads/call/recording/route.ts` — recording callback (working)
- `lib/supabase.ts` or any Physiq Supabase config — wrong project
- Any CRMS/relationships routes or components
- `vercel --prod` without Ryan's explicit go-ahead

---

Write a one-line status to `workspace/.cody-status` at each checkpoint or blocker.
No deploy without my explicit go-ahead. Update PROJECT_MEMO.md when done.
Ask Thadius if you hit any blockers — especially for the Supabase schema migration and gog CLI command syntax.
