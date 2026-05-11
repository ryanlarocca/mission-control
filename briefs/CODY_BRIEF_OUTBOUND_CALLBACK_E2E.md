# Cody Brief: Outbound Callback Number — End-to-End Verification

**Project:** Mission Control (`/Users/ryanlarocca/.openclaw/workspace/PROJECTS/mission-control`)
**Date:** 2026-05-10 (night)
**Scope:** Verify (and bug-fix if needed) the inbound callback flow on `+16502043247`. Twilio webhooks already wired via API — code paths already exist. This brief is verification + small bug-fixes, not new build.
**Priority:** Tonight. Leads are starting to dial this number back and we cannot keep dropping them on Twilio's demo greeting.

---

## Context

`+16502043247` is the outbound caller-ID number Ryan uses when click-to-calling leads via Mission Control. Until tonight, when a lead called *back* on that number, Twilio answered with a generic demo greeting because the number's Voice + Messaging webhooks pointed at `demo.twilio.com`. Twilio config has been flipped via the REST API:

- Voice URL → `https://mission-control-three-chi.vercel.app/api/leads/voice` (POST)
- SMS URL → `https://mission-control-three-chi.vercel.app/api/leads/sms` (POST)

Verify the config with:

```bash
curl -s -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
  "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/IncomingPhoneNumbers/PNa9b914c8b981ccd1be1e2efab03d1870.json" \
  | jq '{phone:.phone_number, voice_url, sms_url}'
```

Expected output:
```json
{
  "phone": "+16502043247",
  "voice_url": "https://mission-control-three-chi.vercel.app/api/leads/voice",
  "sms_url": "https://mission-control-three-chi.vercel.app/api/leads/sms"
}
```

---

## What's Already Wired in Code

These are already implemented — your job is to verify they behave end-to-end, not rebuild them.

- `PROJECTS/mission-control/lib/leads.ts:5-19` — `CAMPAIGN_MAP` includes `+16502043247 → "Outbound"`. `OUTBOUND_TWILIO_NUMBER` constant exported.
- `PROJECTS/mission-control/app/api/leads/voice/route.ts:54-81` — when `twilioNumber === OUTBOUND_TWILIO_NUMBER`, looks up an existing lead by `caller_phone` (last 30 days), skips the drip-campaign stamp so it doesn't kick off a new cycle, but still inserts a lead row + dials Ryan's cell + records.
- `PROJECTS/mission-control/app/api/leads/voice/route.ts:36-39` — TwiML dials `FORWARD_TO` (`+14085006293`) with `record="record-from-answer"` and `recordingStatusCallback` → `/api/leads/voice/recording`.
- `PROJECTS/mission-control/app/api/leads/voice/recording/route.ts` — recording callback: stores `recording_url`, runs Whisper transcription, runs AI triage, sends Telegram alert with audio.
- `PROJECTS/mission-control/app/api/leads/sms/route.ts` — must mirror the voice route: dedup against existing lead by `caller_phone` when `To === OUTBOUND_TWILIO_NUMBER`. **First task: read this file and verify the outbound-callback branch exists. If not, mirror the voice-route pattern.**
- UI groups events by `caller_phone`, so a callback automatically clusters onto the same contact card.

---

## Tasks (in order)

### Task 1 — Verify Twilio config is live
Run the `curl` above. Confirm both URLs point at the leads routes. If anything else is set, restore using the Rollback section below in reverse (flip back to the leads routes).

### Task 2 — Audit `app/api/leads/sms/route.ts` for outbound-callback dedup
Read the file. Look for an `OUTBOUND_TWILIO_NUMBER` branch that:
1. Detects when `To === OUTBOUND_TWILIO_NUMBER`
2. Looks up the most recent lead row for that `caller_phone` in the last 30 days
3. Skips writing `drip_campaign_type` / `drip_touch_number` / `last_drip_sent_at` on the new SMS row

**If it does not exist**, add it. Mirror the pattern from `voice/route.ts:54-81`. Same 30-day window constant (`OUTBOUND_CALLBACK_DEDUP_DAYS = 30`).

Open a small PR with this change if needed. Title: `sms: dedup outbound-callback texts against existing lead`.

### Task 3 — Run the end-to-end test plan (below)
Ryan will be the live caller. You run the verification SQL after each test.

### Task 4 — Update `PROJECT_MEMO.md`
After all tests pass, append a dated note: outbound number is now a full two-way leads channel matching MFM-A/B. Note the Twilio config date and any SMS-route fix you shipped.

---

## End-to-End Test Plan

Ryan is the live caller. You watch logs + run SQL after each test.

### Test 1 — Outbound call from Ryan to a test number (baseline sanity)
1. Ryan opens a lead in Mission Control, hits "Call" → his cell dials out via Twilio bridge.
2. Ryan completes the call.
3. **Expect:**
   - Outbound row in `leads` table (`twilio_number IS NULL`, `lead_type='call'`).
   - Recording arrives, `recording_url` populated, transcript saved to `message`, AI summary saved to `ai_notes`.
   - Telegram alert with `📤 Outbound call recording`.

### Test 2 — Lead calls back the outbound number (the new path)
1. Ryan calls `+16502043247` from a second phone (acting as a lead returning Ryan's outreach).
2. **Expect:**
   - Within 1–2 seconds, Ryan's cell (+14085006293) rings.
   - Ryan answers; conversation happens. Hang up.
   - New row in `leads` table:
     - `twilio_number = '+16502043247'`
     - `caller_phone = <second phone>`
     - `source = 'Outbound'`
     - `lead_type = 'call'`
     - `status = 'new'`
     - `drip_campaign_type IS NULL` (callback dedup applied — there should be an existing recent row for that caller_phone from Test 1)
   - Within ~30s, recording callback fires: `recording_url` populated, `message` = Whisper transcript, AI triage updates `status` + `ai_notes`.
   - Telegram alert with `🎙️ New recording — Outbound — <phone>`.
   - **Critical:** Mission Control contact card for that `caller_phone` shows BOTH the original outbound call AND the new inbound callback in one timeline (UI groups by `caller_phone`).

### Test 3 — Lead misses (no answer / voicemail)
1. Ryan calls `+16502043247` from second phone, Ryan does NOT pick up on his cell.
2. **Expect:**
   - After 10s timeout, `/api/leads/voice/no-answer` plays voicemail prompt + records.
   - Recording callback fires same as Test 2 → transcript + triage + Telegram alert.

### Test 4 — Lead texts the outbound number
1. Ryan sends SMS from second phone to `+16502043247`.
2. **Expect:**
   - SMS row inserted in `leads` with `source = 'Outbound'`, `lead_type = 'sms'`, `message = <body>`.
   - If Task 2 dedup logic is in place, the row has `drip_campaign_type IS NULL`.
   - Telegram alert fires.
   - Contact card shows the SMS alongside the prior call timeline.

### Test 5 — Regression: MFM-A / MFM-B still work
1. Ryan calls `+16504364279` (MFM-A) from a clean third phone.
2. **Expect:** Same behavior as before — this was already working. Confirm no regression.

---

## Verification Queries (Supabase)

After each test, run:

```sql
-- Most recent rows for the test caller
SELECT id, created_at, source, twilio_number, caller_phone, lead_type, status,
       drip_campaign_type, drip_touch_number,
       LEFT(message, 80) AS message_preview,
       LEFT(ai_notes, 80) AS ai_notes_preview,
       recording_url IS NOT NULL AS has_recording
FROM leads
WHERE caller_phone = '<TEST_PHONE_E164>'
ORDER BY created_at DESC
LIMIT 5;
```

```sql
-- Confirm callback rows show source='Outbound' and have null drip stamp
SELECT count(*) FROM leads
WHERE twilio_number = '+16502043247'
  AND caller_phone = '<TEST_PHONE_E164>'
  AND drip_campaign_type IS NULL;
```

---

## Known Risks / Things to Watch

1. **SMS callback dedup may not exist yet.** Task 2 covers this. If you ship a fix, keep the diff tight — mirror `voice/route.ts:54-81` exactly. Do not refactor the SMS route beyond adding the branch.
2. **Caller-ID lookup keys on `caller_phone`, not `twilio_number`** — already correct in `voice/route.ts`, but verify the contact-card UI clusters by `caller_phone` and not by `twilio_number`. Spot-check by opening the lead card after Test 2.
3. **Recording callback uses an absolute URL** (`mission-control-three-chi.vercel.app/api/leads/voice/recording`) hardcoded at `voice/route.ts:30-31` — fine on prod, breaks on preview deploys. Not blocking tonight; note for future cleanup.
4. **AI triage runs on every recording** but only updates `status` if currently `new`. On callbacks where a prior lead exists with status ≠ `new`, it'll write to `suggested_status` instead (training-wheels mode). Intended behavior.
5. **Telegram alerts** depend on `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` env vars on Vercel. Already set for the prod deploy; if a test fires with no Telegram alert, check Vercel env vars first before chasing code.

---

## Success Criteria (must all be true)

- [ ] Twilio config verified: `+16502043247` voice + sms URLs point at leads routes
- [ ] Task 2: SMS route handles outbound-callback dedup (verified or shipped)
- [ ] Test 2 (callback) rings Ryan's cell within 2 seconds
- [ ] Test 2 produces a `leads` row with `source='Outbound'` and `drip_campaign_type IS NULL`
- [ ] Test 2 recording transcribes + AI-triages within 60 seconds of hangup
- [ ] Test 2 Telegram alert lands with audio + transcript + AI summary
- [ ] Test 2 contact card in Mission Control shows the callback in the same timeline as the prior outbound call (grouped by `caller_phone`)
- [ ] Test 3 (voicemail) writes transcript to `message`
- [ ] Test 4 (SMS) writes row with `lead_type='sms'` and `source='Outbound'`
- [ ] Test 5 (MFM-A regression) still works identically
- [ ] `PROJECT_MEMO.md` updated

---

## Rollback

If anything goes sideways during testing, revert the Twilio webhooks to the demo URLs so callers at least hear something predictable while you debug:

```bash
curl -X POST -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
  "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/IncomingPhoneNumbers/PNa9b914c8b981ccd1be1e2efab03d1870.json" \
  --data-urlencode "VoiceUrl=https://demo.twilio.com/welcome/voice/" \
  --data-urlencode "SmsUrl=https://demo.twilio.com/welcome/sms/reply"
```

Config-only — no code deploys needed for rollback.

---

## Working Notes

- Write status to `workspace/.cody-status` at each checkpoint or blocker.
- Ask Thadius if you hit any blockers.
- Do NOT touch MFM-A or MFM-B webhook config under any circumstance.
- Do NOT change the recording callback URL — it's hardcoded by design.
- If Task 2 requires a code change, ship it in a single small PR; do not bundle other cleanup.
