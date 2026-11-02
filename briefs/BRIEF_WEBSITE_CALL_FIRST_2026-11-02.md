# Website leads: call-first (2026-11-02)

**Why.** Maryam Norton (5122 Severance Ct, fire damage, selling as-is) filled
out the lrghomes.com form at 10:11am. Ryan got no Telegram alert: the site
texted its alert to the Office — Info line, which Mission Control drops as one
of our own numbers. She got a canned "when are you planning to make the
move?" text. Her card showed her own note as "YOU", a double WEBSITE chip, and
"Next touch: Drip #1 in 1d 4h". Ryan: "I just need a functioning system here
for a website lead", and he expects more through the mailers.

**Approved by Ryan (2026-11-02):** everything below. Business hours are
8am–7pm Pacific, 7 days a week. Calls go right away, ~2h later and the next
morning. Alerts are Telegram only. The "just tried you" text is automatic.
He always calls with the Call button, never his phone keypad. The
situation-sorting idea (fire / inherited / tenant …) is parked.

## Flow
1. **Intake.** `lrg-homes-website/api/submit-lead.js` → `POST /api/leads/website-form`
   (header `x-website-secret` = `WEBSITE_FORM_SECRET`, set on both Vercel
   projects). Mission Control writes the form row on the **Website line**
   (`twilio_number = +16506703914`, so it's inbound and replies/calls use that
   line), stores `sms_consent`, sets `website_ladder='calling'` for sellers,
   and responds. The rest runs in `waitUntil`:
   - mailed-record match (`autoLinkMailRecord`). The alert names the
     campaign + owner and flags when the owner isn't the person on the form.
   - first text (texts-OK sellers only): "Hi Maryam, it's Ryan with LRG Homes.
     Got your note about Severance Ct. I'll give you a call in the next few
     minutes." After hours it says "first thing tomorrow morning".
   - confirmation email from info@ (who / 3 steps / site link / Website line).
   - Telegram alert with a **📞 Call** button (`lcall:<10 digits>` →
     `startLeadCall`, the same recorded relay as the card).
   - If Telegram fails, it texts Ryan's cell. If Mission Control is
     unreachable, the site writes the row itself and texts Ryan's cell.
     **Never the office line.**
2. **Ladder** (`lib/websiteLead.ts`, state derived from the cluster's rows).
   An attempt is an outbound call row whose lead leg ran
   (`call_conversation` set by `/api/leads/call/status`). The next attempt is
   written as the Follow Ups reminder "Call attempt N of 3 — website lead".
   The analyzer's per-voicemail reminders are cleared while the ladder runs.
3. **Missed call** (no answer / busy / under 60s; 60s or more → the transcript
   decides voicemail vs conversation): "Hi Maryam, it's Ryan with LRG Homes.
   Just tried you. Call or text me back at (650) 670-3914 whenever works."
   It goes by email when there's no text consent.
4. **Ladder ends** when a call connects, or the lead calls / texts / emails
   back. After 3 unanswered calls → the `website_followup` drip (4 touches on
   day 1 / 3 / 7 / 14, approval-gated, `_email` variant without consent). The
   engine then hands off to `long_term_nurture`.
5. **Sweep**: launchd `com.lrghomes.website-ladder` runs every 5 min
   (`scripts/website-ladder-sweep.mjs` → `/api/leads/website-ladder/sweep`).
   - Telegram pings, once each, in business hours only: attempt 1 at 8am for
     after-hours leads, a 15-minute "still not called" reminder, and
     attempts 2 and 3 when due.
   - The Website-line missed-call text: "Sorry I missed your call. I'll call
     you right back." It goes out 15 min after the missed call, in hours, and
     only if Ryan hasn't already called or texted back.

## Schema
`supabase/migrations/2026-11-02_website_call_first.sql`: `leads.sms_consent`,
`website_ladder`, `ladder_pings` (jsonb), `call_conversation`.

## Also fixed
- Form rows render as the lead, not "YOU" (`isOutbound` in LeadsTab).
- The source-type chip is hidden when it repeats the campaign chip.
- Replying "call her back" to a lead alert places the call instead of texting
  those words to the lead.
