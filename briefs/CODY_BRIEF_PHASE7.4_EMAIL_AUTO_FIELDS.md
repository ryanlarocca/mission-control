# Cody Brief — Phase 7.4 Addendum: Auto-populate phone/name from email + immediate phone UI

**Date:** 2026-05-05
**Project:** Mission Control — Lead Pipeline
**App:** `PROJECTS/mission-control/`
**Deploy:** `cd PROJECTS/mission-control && vercel --prod`
**Branch:** `feature/phase7.4-email-auto-fields` ← create this branch before starting

---

## Context

Three small UX fixes for email leads. All changes are confined to the email ingest route and the LeadsTab component.

---

## Fix 1 — Auto-populate phone from email body

**Where:** `app/api/leads/email/route.ts`

**What:** `extractPhoneFromText()` already extracts a phone from the email body — but it stores it as a raw 10-digit string (e.g. `"7605559999"`), not E.164. The `normalizePhone()` helper in `lib/leads.ts` converts to `+1XXXXXXXXXX`. Currently the `caller_phone` insert uses the raw extracted value.

**Fix:** Run the extracted phone through `normalizePhone()` before inserting. Apply in both `handleAppsScript` and `processSingleMessage`:

```ts
const rawPhone = extractPhoneFromText(bodyText)
const phone = rawPhone ? normalizePhone(rawPhone) : null
```

If `normalizePhone` throws or returns null (bad format), fall back to null — don't fail the insert.

**Result:** When a lead includes their phone in the email body (e.g. "call me at (760) 555-9999"), Mission Control captures it immediately and the Call button activates without Ryan manually entering it.

---

## Fix 2 — Auto-populate name from email body / sender header

**Where:** `app/api/leads/email/route.ts`

**What:** `parseFromHeader()` already parses the sender name from the `From:` header (e.g. `"Pat Quinn <pat@gmail.com>"` → name `"Pat Quinn"`). This is already saved to the `name` column. ✅ That part works.

**Additional:** If the `From:` header has no display name (bare email like `pat@gmail.com`), attempt to extract a name from the email body. Common patterns:
- "Hi, my name is John Smith" / "I'm John" / "This is John Smith"
- First line of body if it looks like a name (2–3 words, title case, no @ or digits)

Add a `extractNameFromBody(text: string): string | null` helper that tries a few simple regex patterns. This is best-effort — if nothing matches, return null and let the name stay as whatever `parseFromHeader` returned (which may also be null for bare-email senders).

```ts
function extractNameFromBody(text: string): string | null {
  if (!text) return null
  // "my name is X" / "I'm X" / "This is X"
  const patterns = [
    /\bmy name is ([A-Z][a-z]+(?: [A-Z][a-z]+){0,2})/i,
    /\bI(?:'m| am) ([A-Z][a-z]+(?: [A-Z][a-z]+){0,2})/i,
    /\bthis is ([A-Z][a-z]+(?: [A-Z][a-z]+){0,2})/i,
  ]
  for (const re of patterns) {
    const m = re.exec(text)
    if (m) return m[1].trim()
  }
  return null
}
```

**Logic:**
```ts
const { name: headerName, email: senderEmail } = parseFromHeader(fromHeader)
const bodyName = extractNameFromBody(bodyText)
const name = headerName || bodyName  // prefer display name from header; fall back to body extraction
```

Apply in both `handleAppsScript` and `processSingleMessage`.

---

## Fix 3 — Immediate phone availability after manual entry (no refresh needed)

**Where:** `components/widgets/LeadsTab.tsx`

**What:** When Ryan manually types a phone into the "Add phone number" input and hits Save, the optimistic update calls:
```ts
setLeads(prev => prev.map(l => l.id === group.mostRecentId ? { ...l, caller_phone: normalized } : l))
```

This patches the lead row in state correctly. However, the group was keyed by `email:<addr>` (because it had no phone at insert time). After `setLeads`, `groupLeads()` re-runs and now keys this group by the phone number instead of `email:<addr>`. This key change causes React to unmount+remount the card, resetting expanded state — and the `syncedGroups` set (which tracks which groups have been synced) loses the old key, so the extra events (iMessage/Gmail thread) are dropped until refresh.

**Fix:** After a successful phone add, do a lightweight `fetchLeads(true)` (already available — it's the refresh-silently path). This re-fetches from Supabase with the persisted phone, re-keys the group correctly, and re-triggers the sync. The fetch is fast (~200ms) and the Call button will activate immediately after.

The current code does NOT call `fetchLeads` after `addPhone` — add it:

```ts
async function addPhone(group: LeadGroup, raw: string) {
  // ... existing try/catch ...
  // After successful PATCH:
  setLeads(prev => prev.map(l => l.id === group.mostRecentId ? { ...l, caller_phone: normalized } : l))
  setPhoneDraft(prev => ({ ...prev, [group.phone]: "" }))
  void fetchLeads(true)  // ← ADD THIS LINE — re-fetches silently, re-keys group
  // ... finally ...
}
```

This is the correct fix — don't try to manually re-key the group in local state (it's complex and fragile). Let the server be the source of truth; the silent refresh is fast enough to feel immediate.

---

## Build Order

1. `app/api/leads/email/route.ts` — Fix 1 (phone normalization) + Fix 2 (name extraction)
2. `components/widgets/LeadsTab.tsx` — Fix 3 (addPhone calls fetchLeads)
3. `tsc --noEmit` must pass

---

## Checkpoint Protocol

```
✅ CHECKPOINT: [Step Name] complete
Summary: [1-2 sentences]
Files touched: [list]
Blocked: [yes/no]
```

```
⏸ BLOCKED: [Issue]
Options: [A, B, C]
Waiting for input.
```

---

## Deploy Gate

Do NOT deploy. When `tsc --noEmit` passes:
```
🏁 READY FOR REVIEW
Changed files: [list]
What to test: [list]
Deploy command: cd PROJECTS/mission-control && vercel --prod
```

---

## Files Modified (allow-list)

- `app/api/leads/email/route.ts`
- `components/widgets/LeadsTab.tsx`
- `lib/leads.ts` (read-only reference for `normalizePhone` signature — do not modify unless it needs a minor export tweak)

Anything else: ask first.

## DO NOT TOUCH

- Any Twilio routes
- crms-sidecar.js / phase2/
- Supabase schema
- launchd plists
- config/email-campaigns.json
