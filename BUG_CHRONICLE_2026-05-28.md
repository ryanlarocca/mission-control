# Bug Chronicle — 2026-05-28 (LRG lead pipeline / Mission Control)

Running log of bugs reported in this session + their root cause + fix + verification.
Owner: agent (Claude). Status legend: 🔴 open · 🟡 in progress · 🟢 fixed+verified · ⚪ deployed

**Shipped:** mission-control `f3dc07b` (main → Vercel). Bug 1 tooling in the
openclaw workspace (`scripts/text-lead.mjs`, `TOOLS.md`).
**Live verification (headless Chrome via CDP against prod):** Follow-Ups
worklist now renders Call:17 / Text:17 / **Email:17** — the Email button shows
on every contact (was gated before), with the new title
"Email — no address on file yet; you can add one". Backend Twilio send verified
end-to-end (HTTP 200 + real messageSid). Jesus transcript recovered + re-analyzed.

---

## Bug 1 — Telegram reply-to-lead sends via iPhone (imsg) instead of Twilio
**Reported:** session start.
**Symptom:** When Ryan replies in Telegram to a lead alert, the text goes out from the Mac mini's iMessage/iPhone number, not the Twilio outbound number (+16502043247).
**Root cause:** The Telegram bot is in *polling* mode for the Thadius agent (webhook URL is empty), so mission-control's `/api/telegram/webhook` (which already sends via Twilio) is dead code — the live reply path is Thadius the agent, which texts leads with `imsg` per TOOLS.md. One bot can't both poll (Thadius) and webhook (MC), so we can't just flip the webhook on.
**Fix:** New deterministic tool `scripts/text-lead.mjs` — authenticates to MC prod and sends via `/api/leads/send` (Twilio +16502043247 + full CRMS bookkeeping). TOOLS.md rewritten: lead texts MUST use `text-lead.mjs`; `imsg` is now explicitly Relationships/personal-only. Tested ✓ (sent from Twilio).
**Status:** 🟢 fixed+verified

## Bug 2 — No email button in the Follow-Ups tab
**Reported:** session start.
**Symptom:** Follow-Ups cards show Call + Text but no Email button.
**Root cause:** The Email button existed but was gated on `row.email` (`{row.email && ...}`), while Call/Text are gated on `row.phone`. Most inbound SMS/call leads have a phone but no email on file, so the button was invisible for them.
**Fix:** Email button now always renders in the CallBlock (FollowUpsTab.tsx). The ComposeModal shows a recipient-email input when the lead has no address on file; `/api/leads/[id]/send-email` accepts an optional validated `to` override and persists it onto the lead for future touches.
**Status:** 🟢 fixed + verified live on prod

## Bug 3 — Jesus call transcript didn't upload + follow-up not set
**Reported:** mid-session.
**Symptom:** Spoke with Jesus (79 Union St, San Jose — 5 units, separation/possible sale) on a 23-min call; transcript never uploaded and the lead got auto-stamped "cold, left no message — 6-month nurture."
**Root cause:** The recording→Whisper→analysis pipeline silently failed to transcribe the 23-min/5.5MB call (likely a transient OpenAI failure or the background time budget). When `transcription` is null, the inbound path calls `applyColdNoSignalDefault()` — which MISLABELS a transcription failure as "called but left no message → cold + 180-day." 7 leads total found in this state (mostly old anon voicemails pre-maxDuration-fix).
**Fix (Jesus, done):** Re-downloaded the Twilio recording, re-ran Whisper (recovered full 23-min transcript), saved to the lead, re-ran analysis → now WARM, property extracted (79 Union Street, San Jose 95110), follow-up 2026-06-11 (~2 wks, per Ryan), proper summary.
**Fix (recurrence, pending):** add retry to transcribeAudio; reconciliation script to re-transcribe any call lead with a recording but empty transcript; stop mislabeling transcription failures as cold.
**Status:** 🟢 Jesus recovered · 🟡 hardening pending

## Bug 4 — Sending a lead a message fails silently (CRITICAL)
**Reported:** mid-session.
**Symptom:** When sending a lead a message (the **drip** Send button), the lead card "just blinks" and no message is ever sent.
**Root cause (two compounding):**
  1. **Error gets wiped:** on a stale-draft 409, `sendDrip` set the error banner then immediately fired a *silent* `fetchData()` — and `fetchData` cleared the error on success (`setErr(null)`). So the banner flashed and vanished = the "blink," with no explanation and no send. The 30s poll did the same to any action error.
  2. **False success:** `/api/drips/[id]/send` kicks the Mac-mini sidecar to send, but swallowed the kick error and ALWAYS returned `triggered:true`. UI showed "Sent ✓", dropped the row, then the 6s refetch resurrected the still-pending row.
(Backend Twilio send itself is healthy — verified a live send end-to-end, HTTP 200 + real messageSid. Sidecar tunnel reachable; 3 drips sent successfully earlier today.)
**Fix:** (a) `fetchData` only clears the banner on explicit/manual loads, never on silent refetches — action errors persist until dismissed. (b) stale-409 now marks the row stale *in place* (shows Regenerate/Send-anyway/Skip) instead of refetching into a blink. (c) the send route reports `triggered` honestly; UI shows "Sent ✓" only when it actually fired, else "Queued — sends within the hour."
**Status:** 🟢 fixed + verified live on prod
