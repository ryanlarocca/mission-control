# Cody Brief: Lead System Bug Fixes (May 8, 2026)

## Context
Mission Control leads system (`/app/api/leads/`, `/components/widgets/LeadsTab.tsx`, `/lib/leads.ts`). Ryan found 6 bugs during a live workflow test. Fix all of them in one pass.

---

## Bug 1: Outbound Number (+16502043247) Not Wired Up

**Problem:** The outbound Twilio number (`+16502043247`, env var `TWILIO_NUMBER`) is used as caller ID for click-to-call but has NO inbound webhook. When a lead calls it back:
- It doesn't ring through to Ryan's phone
- It doesn't log to the leads table
- It doesn't record, transcribe, or triage
- No voicemail if Ryan doesn't answer

**Root cause:** `CAMPAIGN_MAP` in `lib/leads.ts` only maps MFM-A and MFM-B. The outbound number isn't listed. There's no Twilio Voice/SMS webhook configured for it.

**Fix:**
1. Add `"+16502043247": "Outbound"` to `CAMPAIGN_MAP` in `lib/leads.ts`
2. The existing `/api/leads/voice/route.ts` webhook already handles any Twilio number — just configure the Twilio console to point +16502043247's Voice webhook to `https://mission-control-three-chi.vercel.app/api/leads/voice` (document this in a comment or README)
3. **Critical dedup:** When an inbound call/SMS arrives on this number, DON'T blindly insert a new lead row. Instead:
   - Look up the `caller_phone` in existing leads (within last 30 days)
   - If found: update that lead's status (if still "new" or "contacted" → "contacted"), attach the new event as a row BUT link it to the existing group (same `caller_phone` means same group in the UI)
   - If not found: insert normally
4. Add SMS webhook handling for this number (same as voice — Twilio console config)
5. **Voicemail:** The existing `/api/leads/voice/no-answer` route already handles voicemail with greeting + recording. Since it reads `To` from the Twilio params and the number will be in CAMPAIGN_MAP, it'll work automatically once the webhook is configured. No code change needed — just the Twilio console webhook.

**Note:** The voicemail greeting (`/public/voicemail-greeting.mp3`) will play for callbacks on this number too. If Ryan wants a different greeting for the outbound number, that's a future enhancement.

---

## Bug 2 + 6 (Tied): Google Leads Not Auto-Updating Status + "Stop" Replies Not Triggering DNC

**Problem A:** When Ryan talks to a Google Ads lead (calls them, texts them), the lead status doesn't update from "new" → "contacted" or further.

**Root cause:** The `/api/leads/send` route (outbound SMS) inserts a NEW row with `status: "contacted"` rather than updating the existing lead's status. The lead card groups by `caller_phone`, so the group's status is driven by `mostRecentId` — but only if the outbound row is newer. The real issue: the outbound row has `source: null` (or whatever the UI passed), which may not match the original group. And the original intake row stays at `status: "new"`.

**Fix for A:**
In `/api/leads/send/route.ts`:
- After sending successfully, find the most recent lead row for that `caller_phone` where `twilio_number IS NOT NULL` (the inbound/intake row)
- Update that row's `status` to `"contacted"` if it's currently `"new"`
- Still insert the outbound row for timeline purposes, but the status promotion happens on the intake row

**Problem B:** Lead replies "stop" → should auto-DNC.

**Fix for B:**
In `/api/leads/sms/route.ts`, after parsing the body:
```typescript
const DNC_KEYWORDS = ["stop", "unsubscribe", "do not contact", "remove me", "opt out"]
const isDnc = DNC_KEYWORDS.some(kw => bodyText.toLowerCase().trim() === kw || bodyText.toLowerCase().includes(kw))
```
If `isDnc`:
- Find existing lead by `caller_phone` (most recent within 90 days)
- Set `is_dnc = true` on that row
- Set `status = "dead"` 
- Do NOT insert a new row — just update the existing one and append the "stop" message to timeline
- Skip Telegram alert (or send a brief "🚫 Lead DNC'd: {phone}" notice)

---

## Bug 3: Initial Message Not Showing in Timeline

**Problem:** When a Google Ads lead comes in via form submission, an automatic first-touch text goes out. That outbound message doesn't appear in the lead's communication timeline.

**Root cause:** The initial outbound message is sent by the LEAD_TRACKER scripts (`ACTIVE_SKILLS/LEAD_TRACKER/scripts/`) which call the sidecar directly or use `imsg send`. They don't hit `/api/leads/send` (which logs to Supabase), so the row never gets created.

**Fix:**
In `/api/leads/send/route.ts`, the outbound row IS being created (I can see the insert). The issue is likely that the initial message bypasses this endpoint entirely.

Two options (pick the simpler one):
1. **Option A (preferred):** After the LEAD_TRACKER inserts the intake form row, have it also call `/api/leads/send` for the auto-reply. This means the script needs to POST to the Mission Control API instead of calling iMessage directly.
2. **Option B:** Add a `initial_message` column to the leads table and populate it at intake time. Show it in the timeline as the first event.

**For Cody:** Go with Option A. In the Google Ads form intake flow (check `/api/leads/route.ts` POST or whatever creates the form row — it might be in the LEAD_TRACKER scripts at `ACTIVE_SKILLS/LEAD_TRACKER/scripts/log-lead.py`), after inserting the lead row, POST to `/api/leads/send` with the auto-reply message. If the auto-reply is generated elsewhere, trace where it fires and ensure it logs via the send endpoint.

Actually — re-check: the `/api/leads/send` route DOES insert an outbound row. The problem may be that the LeadsTab groups by `caller_phone` and the outbound row's `caller_phone` matches. So check if the timeline rendering in `LeadsTab.tsx` actually shows outbound SMS rows. Look for `isOutbound()` filtering in the events display. If outbound events are being hidden from the timeline, show them.

---

## Bug 4: AI Summary → AI Notes Style

**Problem:** The current AI summary display in the lead card is not useful. Ryan wants the `ai_notes` style (like on John Mallik's card) — a clean narrative line in the communication timeline, not a separate summary block.

**Fix:**
In `LeadsTab.tsx`, find where `ai_summary` or `aiSummary` is rendered (likely a separate section/card). Replace it with:
- Show `ai_notes` inline in the communication timeline, styled as a system event (maybe with a 🤖 icon)
- Remove or hide the standalone "AI Summary" section
- `ai_notes` is already populated by `processRecordingBackground()` for outbound calls and `triageLeadFromTranscript()` for inbound — it's the `summary` field from triage

If there's a separate `ai_summary` field that's generated on-demand via `/api/leads/[id]/summary`, either:
- Remove that UI element entirely, OR  
- Replace its display with the same inline timeline style

The goal: AI intelligence shows up AS a timeline entry, not as a floating card.

---

## Bug 5: Mobile Home Leads Not Filtered

**Problem:** Leads with addresses containing "lot" (e.g., "123 Main St Lot 191") are mobile homes. Ryan doesn't want these.

**Fix:**
Add junk detection at intake. In EVERY intake path (`/api/leads/voice`, `/api/leads/sms`, `/api/leads/email`, and the form intake), after the row is inserted and we have any `property_address` or `message` content:

```typescript
function isMobileHome(text: string | null): boolean {
  if (!text) return false
  // Match "lot" followed by a number, case-insensitive
  return /\blot\s+\d+/i.test(text)
}
```

For form submissions where `property_address` is available at intake:
- If `isMobileHome(property_address)` → set `is_junk = true` on insert

For other intake types where we only have `message`:
- Check `isMobileHome(message)` after insert
- If true, update `is_junk = true`

Add this helper to `lib/leads.ts` and call it from each intake route.

---

## Bug 7 (added): Outbound Number Voicemail

Already covered in Bug 1 — the existing voicemail flow handles this automatically once the Twilio webhook is pointed at `/api/leads/voice`. No additional code needed.

---

## File Map (what to touch)

| File | Changes |
|------|---------|
| `lib/leads.ts` | Add outbound number to CAMPAIGN_MAP, add `isMobileHome()` helper, add DNC keyword list |
| `app/api/leads/voice/route.ts` | No code changes needed (already handles any mapped number) |
| `app/api/leads/sms/route.ts` | Add dedup logic, DNC keyword detection, update existing lead instead of blind insert |
| `app/api/leads/send/route.ts` | After successful send, update the intake row's status to "contacted" |
| `components/widgets/LeadsTab.tsx` | Move AI notes to inline timeline, remove/restyle AI summary block |
| `app/api/leads/email/route.ts` | Add `isMobileHome()` check on property_address at insert |

## Priority Order
1. Bug 2+6 (SMS dedup + DNC keywords) — highest impact, prevents bad UX
2. Bug 1 (outbound number) — mostly Twilio console config, code is minimal  
3. Bug 3 (initial message) — trace the form intake path, ensure outbound logs
4. Bug 5 (mobile home filter) — quick regex
5. Bug 4 (AI notes style) — UI only

## Completion Notes (2026-05-09)

Status: Bugs 1, 2, 4, 5, 6 complete. Bug 3 deferred — see notes below. Not deployed; ready for review.

### Bug 1 — Outbound number wired up
- `lib/leads.ts` CAMPAIGN_MAP: added `"+16502043247": "Outbound"`. Exported `OUTBOUND_TWILIO_NUMBER` constant.
- `app/api/leads/voice/route.ts`: when `To === OUTBOUND_TWILIO_NUMBER`, looks up the most recent intake row for that `caller_phone` (last 30 days, `twilio_number IS NOT NULL`). On hit, the new call event row is inserted WITHOUT drip-campaign fields so the engine doesn't kick off a fresh cycle. UI groups by `caller_phone`, so the event still attaches to the existing card.
- `app/api/leads/sms/route.ts`: same dedup pattern for inbound SMS to the outbound number.
- Twilio console action still required: point the +16502043247 Voice + Messaging webhooks at `https://mission-control-three-chi.vercel.app/api/leads/voice` and `/api/leads/sms`. No code change needed there.

### Bug 2 — Outbound send promotes intake row status
- `app/api/leads/send/route.ts`: after a successful sidecar send, finds the most recent row for `caller_phone` where `twilio_number IS NOT NULL` (the intake side). If `status === "new"`, updates it to `"contacted"`. The outbound row still inserts as before so the timeline shows the message.

### Bug 4 — AI notes/summary moved into timeline
- `components/widgets/LeadsTab.tsx`: removed the standalone "AI summary" card and standalone "🤖 AI Notes" block. Added `TimelineAiEntry` rendered at the end of the timeline list, styled as a centered system row with a 🤖 icon and a small refresh button. Fed by `summary || group.aiNotes` so the AI summary cache wins, falling back to the most recent `ai_notes`.

### Bug 5 — Mobile home filter
- `lib/leads.ts`: added `isMobileHome(text)` helper using `\blot\s+\d+/i`.
- `app/api/leads/sms/route.ts`: checks the SMS body at insert; sets `is_junk: true` on match.
- `app/api/leads/email/route.ts`: checks subject + body in both the Apps Script and Pub/Sub paths; sets `is_junk: true` on match.
- `lib/leads.ts processRecordingBackground()`: when transcription saves to a voice/voicemail row, also sets `is_junk: true` if the transcription contains "lot N".

### Bug 6 — STOP / DNC keywords
- `lib/leads.ts`: added `DNC_KEYWORDS` (stop, unsubscribe, do not contact, remove me, opt out) and `isDncMessage(text)` helper.
- `app/api/leads/sms/route.ts`: when an inbound SMS body matches DNC, finds the most recent matching intake row for `caller_phone` (last 90 days) and sets `is_dnc=true, status="dead"` on it. The STOP message itself is still inserted (with `is_dnc=true, status="dead"`, no drip fields) so the timeline shows it. Telegram alert reduced to `🚫 Lead DNC'd — <source> — <phone>`.

### Bug 3 — Initial message not in timeline (DEFERRED)
- Investigated: the LEAD_TRACKER scripts (`ACTIVE_SKILLS/LEAD_TRACKER/scripts/log-lead.py`) write to Google Sheets, not Supabase, and don't POST to `/api/leads/send`. So the initial auto-reply for a Google Ads lead never gets a Supabase row in the first place — this is the upstream cause, not a render-time filter.
- Confirmed in `LeadsTab.tsx`: outbound SMS rows ARE rendered (TimelineEvent at line 1880+, the `if (outbound)` branch produces the right-aligned emerald bubble). Render layer is fine.
- Recommended next step (Option A from the brief): update the form-intake flow that fires the auto-reply to POST to `/api/leads/send` instead of (or in addition to) the iMessage sidecar. Likely lives in the LEAD_TRACKER pipeline that ingests Google Ads form submissions — the exact firing point wasn't located in the mission-control repo. Cody should pick this up next pass with access to the script that actually fires the auto-reply.

### Files touched
- `lib/leads.ts`
- `app/api/leads/sms/route.ts`
- `app/api/leads/voice/route.ts`
- `app/api/leads/send/route.ts`
- `app/api/leads/email/route.ts`
- `components/widgets/LeadsTab.tsx`

Typecheck: `npx tsc --noEmit` passes.

## Testing Notes
- Outbound number: Have someone call +16502043247, verify it rings Ryan + logs + records
- DNC: Text "stop" to MFM-A or MFM-B, verify lead gets `is_dnc=true` and status→dead
- Mobile home: Submit a form with "123 Main St Lot 5" as address, verify `is_junk=true`
- Initial message: Submit a Google Ads form, verify the auto-reply appears in timeline
- AI notes: Check John Mallik's card for reference styling, verify it matches after changes
