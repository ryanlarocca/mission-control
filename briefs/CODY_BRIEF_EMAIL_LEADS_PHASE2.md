# Cody Brief: Email Leads — Phase 2
**Date:** 2026-05-05
**Project:** Mission Control — Email Lead Capture (Phase 2)
**App:** `PROJECTS/mission-control/`
**Deploy:** `cd PROJECTS/mission-control && vercel --prod`
**Branch:** `feature/email-leads-phase2` ← create this branch before starting

---

## Context for Cody

Email lead capture was built in Phase 1 (feature/email-lead-capture). The `/api/leads/email` webhook accepts inbound leads from `ryansvg@lrghomes.com` (Campaign A) and `ryansvj@lrghomes.com` (Campaign B). It's live and inserting rows into Supabase.

**Three problems to fix in this build:**

1. **Wrong campaign tags** — Email leads are being tagged `SVJ-B` regardless of which mailbox they came from. The Twilio `CAMPAIGN_MAP` doesn't apply to email — we need mailbox-based mapping instead.

2. **No grouping key for phone-less leads** — The `LeadsTab` UI groups all leads by `caller_phone`. Email leads often have no phone number, so they either fail to render correctly or collision-group with other leads. We need email-based grouping as a fallback.

3. **No way to add a phone number after the fact** — When a phone-less email lead later provides their number (or Ryan finds it), there's no way to attach it to the card. Adding it should: (a) persist to the Supabase row, (b) activate the Call button, and (c) allow future Twilio inbound calls from that number to auto-merge into this lead's group.

---

## Infrastructure

**Supabase (LRG Homes project):**
- URL: `https://vcebykfbaakdtpspkaek.supabase.co`
- Service role key: in `.env.local` as `LRG_SUPABASE_SERVICE_KEY`
- Table: `leads`
- Relevant columns: `id`, `caller_phone`, `email`, `name`, `source`, `source_type`, `lead_type`, `status`, `message`, `suggested_reply`, `ai_notes`, `created_at`, `twilio_number`

**Campaign mapping (email mailbox → campaign):**
- `ryansvg@lrghomes.com` → source: `"MFM-A"`, source_type: `"direct_mail"` (same bucket as Twilio `+16504364279`)
- `ryansvj@lrghomes.com` → source: `"MFM-B"`, source_type: `"direct_mail"` (same bucket as Twilio `+16506803671`)

**Existing files to read before starting:**
- `app/api/leads/email/route.ts` — current email webhook (has the tagging bug)
- `lib/leads.ts` — `CAMPAIGN_MAP`, `sendTelegramAlert`, `triageEmailLead`, shared helpers
- `app/leads/LeadsTab.tsx` — UI grouping logic (currently keys off `caller_phone`)
- `app/api/leads/route.ts` — GET + PATCH endpoint
- `app/api/leads/call/route.ts` — existing call relay (model for the call button activation)

---

## Parts

### Part 1: Fix Campaign Tagging in Email Webhook

**File:** `app/api/leads/email/route.ts`

The webhook receives a `mailbox` field in the POST body (either `ryansvg@lrghomes.com` or `ryansvj@lrghomes.com`). Map it to the correct campaign:

```typescript
const EMAIL_CAMPAIGN_MAP: Record<string, { source: string; source_type: string }> = {
  'ryansvg@lrghomes.com': { source: 'MFM-A', source_type: 'direct_mail' },
  'ryansvj@lrghomes.com': { source: 'MFM-B', source_type: 'direct_mail' },
};
```

Use `EMAIL_CAMPAIGN_MAP[mailbox]` to set `source` and `source_type` on the Supabase insert. If `mailbox` is unrecognized, fall back to `{ source: 'Unknown', source_type: 'direct_mail' }` and log a warning.

Also move this map into `lib/leads.ts` so it's alongside `CAMPAIGN_MAP`.

---

### Part 2: Email-Based Lead Grouping in LeadsTab

**File:** `app/leads/LeadsTab.tsx`

Currently, leads are grouped by `caller_phone`. When `caller_phone` is null (email-only leads), they need to group by `email` instead.

**Grouping key logic:**
```typescript
const groupKey = lead.caller_phone ?? `email:${lead.email}` ?? `id:${lead.id}`;
```

- If `caller_phone` is present → group by phone (existing behavior, unchanged)
- If `caller_phone` is null but `email` is present → group by `email:${email}` (new)
- If neither → group by `id:${id}` (fallback for edge cases)

**Card header for email-only groups:**
- Show email address where phone normally displays
- Use an envelope icon instead of phone icon
- Show name if available
- Show campaign badge (MFM-A / MFM-B) as normal
- Do NOT show "tap to call" phone link (no number yet)

**Auto-merge on phone addition (Part 3 enables this):**
When Ryan adds a phone number to an email-only card (Part 3), the group key will shift from `email:...` to the phone number on next refresh. This is fine — the card will re-group correctly because the Supabase row will now have `caller_phone` set. No special handling needed here.

---

### Part 3: Manual Phone Entry on Email-Only Lead Cards

This is the main new feature. Email-only cards need an "Add phone number" input field. When Ryan enters a number and saves, it:
1. PATCHes the Supabase row with the normalized phone number
2. Activates the Call button immediately (optimistic UI)
3. On next auto-refresh, the card re-groups under the phone number

**Backend — PATCH `/api/leads`:**
The existing PATCH handler accepts `{ id, status?, notes? }`. Extend it to also accept `caller_phone`:

```typescript
// In app/api/leads/route.ts PATCH handler
const { id, status, notes, caller_phone } = await req.json();

const updates: Partial<Lead> = {};
if (status !== undefined) updates.status = status;
if (notes !== undefined) updates.notes = notes;
if (caller_phone !== undefined) {
  // Normalize to E.164
  updates.caller_phone = normalizePhone(caller_phone);
}
```

Add a `normalizePhone(raw: string): string` helper in `lib/leads.ts` that:
- Strips all non-digit characters
- If 10 digits, prepend `+1`
- If 11 digits starting with 1, prepend `+`
- Otherwise return as-is (let it fail gracefully)

**Frontend — LeadsTab.tsx:**

In the expanded view of email-only cards (where `caller_phone` is null), add:

```
[ Add phone number          ] [Save]
```

- Small input field + Save button, below the email address line
- On Save: call `PATCH /api/leads` with `{ id, caller_phone: inputValue }`
- Optimistic UI: immediately set `caller_phone` on the local group state so the Call button appears without waiting for refresh
- Show inline error if PATCH fails
- After save, the 30s auto-refresh will re-group the card under the phone number — no special handling needed

**Call button activation:**
Once `caller_phone` is set (either from DB or optimistically), the emerald Call button should render exactly as it does for phone-grouped cards — same logic, same relay via `/api/leads/call`.

---

## Build Order

1. **Part 1 first** — fix the tagging bug. Standalone, no UI changes. Fastest to ship and test.
2. **Part 2** — update grouping logic. No backend changes, just LeadsTab rendering.
3. **Part 3** — PATCH extension (backend first, then UI).

---

## Checkpoint Protocol

**IMPORTANT:** After completing each major step, announce it clearly:

```
✅ CHECKPOINT: [Step Name] complete
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

**Do NOT deploy to production.** When all parts are done and the build is clean:

```
🏁 READY FOR REVIEW
Changed files: [list]
What to test:
  1. Email lead comes in via ryansvg → shows MFM-A badge
  2. Email lead comes in via ryansvj → shows MFM-B badge
  3. Email-only lead (no phone) renders as its own card grouped by email
  4. "Add phone" input appears on email-only cards
  5. Typing a number + Save → Call button appears immediately
  6. Next refresh → card re-groups under phone number
Deploy command: cd PROJECTS/mission-control && vercel --prod
```

Wait for explicit "deploy" instruction from Ryan.

---

## Wrap-Up

When complete and deployed:
1. Update `PROJECTS/comprehensive-relationship-management/PROJECT_MEMO.md` under `## ⚡ Live Now` — add a note that email leads now group by mailbox/email and support manual phone entry
2. Add to `## 📜 History` section as "Phase 7.4 — Email Leads Phase 2"
3. Final status:
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
- `app/leads/LeadsTab.tsx`
- `lib/leads.ts`
- `PROJECTS/comprehensive-relationship-management/PROJECT_MEMO.md`

Anything outside this list → ask first.

---

## DO NOT TOUCH

- `app/api/leads/voice/route.ts` — Twilio voice webhook (working, leave alone)
- `app/api/leads/sms/route.ts` — Twilio SMS webhook (working, leave alone)
- `app/api/leads/call/route.ts` — call relay (working, leave alone)
- `lib/supabase.ts` or any Physiq Supabase config — wrong project
- Any CRMS/relationships routes or components
- `vercel --prod` without Ryan's explicit go-ahead

---

Write a one-line status to `workspace/.cody-status` at each checkpoint or blocker.
No deploy without my explicit go-ahead. Update PROJECT_MEMO.md when done.
Ask me if you hit any blockers.
