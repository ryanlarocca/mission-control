# Brief: Google Landing Page Phone Number

**Date:** 2026-05-11
**Project:** Mission Control + LRG Homes Websites
**App:** `/Users/ryanlarocca/.openclaw/workspace/PROJECTS/mission-control`
**Deploy:** `vercel --prod` (Mission Control) — wait for Ryan's go-ahead
**Branch:** `feature/google-landing-number` ← create from main, NOT from phase7d-polish

---

## Context

Ryan bought a new Twilio number for his Google Ads landing page: **(650) 670-3914** (`+16506703914`). Today, inbound calls to MFMA (+16504364279) and MFMB (+16506803671) log into Mission Control tagged as `source_type: "direct_mail"`. The new number is for Google Ads leads (people who called from the website/landing page after clicking an ad), so they need `source_type: "google_ads"` and the Google Ads drip sequence instead of the direct mail one.

---

## Infrastructure

- Twilio creds: `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` in TOOLS.md / env vars already set
- Supabase: LRG Homes project (already wired)
- Mission Control deployed at: `https://mission-control-three-chi.vercel.app`
- Prior webhook-config pattern: `PROJECTS/mission-control/briefs/CODY_BRIEF_OUTBOUND_CALLBACK_E2E.md` (lines ~18-23 for GET/verify, ~177-182 for POST/update) — follow that exact auth/curl pattern
- Target webhook URLs:
  - Voice: `https://mission-control-three-chi.vercel.app/api/leads/voice`
  - SMS: `https://mission-control-three-chi.vercel.app/api/leads/sms`

---

## Parts

### Part 0: Configure Twilio webhooks via API (`scripts/configure-twilio-number.mjs`)

Write and run a script to wire the new number's webhooks. Follow the curl/auth pattern in `briefs/CODY_BRIEF_OUTBOUND_CALLBACK_E2E.md`:

1. GET `https://api.twilio.com/2010-04-01/Accounts/{ACCOUNT_SID}/IncomingPhoneNumbers.json?PhoneNumber=%2B16506703914` → grab the `PN...` SID
2. POST to `IncomingPhoneNumbers/{PN_SID}.json` with body:
   - `VoiceUrl=https://mission-control-three-chi.vercel.app/api/leads/voice`
   - `VoiceMethod=POST`
   - `SmsUrl=https://mission-control-three-chi.vercel.app/api/leads/sms`
   - `SmsMethod=POST`
3. GET again to verify both URLs persisted — print the result in the checkpoint

Save the script as `scripts/configure-twilio-number.mjs` so it's reusable.

### Part 1: Add number to CAMPAIGN_MAP (`lib/leads.ts`)

Add `"+16506703914": "Google"` to the `CAMPAIGN_MAP` object. Read the file first — it's around line 10-15. No other changes to this file.

### Part 2: Fix `source_type` in voice route (`app/api/leads/voice/route.ts`)

Currently line 85 hardcodes `source_type: "direct_mail"`. Change the insert logic so:
- If the inbound Twilio number is `+16506703914` → use `source_type: "google_ads"` and `drip_campaign_type: "google_ads_form"`
- Otherwise → keep `source_type: "direct_mail"` and `drip_campaign_type: "direct_mail_call"` (existing behavior)

The cleanest way: derive a boolean `const isGoogleAds = twilioNumber === "+16506703914"` before the insert, then use it for both fields.

### Part 3: Fix `source_type` in SMS route (`app/api/leads/sms/route.ts`)

Same pattern — SMS from the new number should also be tagged `source_type: "google_ads"`. Read the file, find the two places where `source_type: "direct_mail"` is set, and apply the same conditional logic as Part 2. For `drip_campaign_type` in the SMS route, use `google_ads_form` for the new number (same as voice).

### Part 4: Update websites with new phone number

Two HTML files — replace every instance of `(408) 493-0632` and `4084930632` with `(650) 670-3914` and `6506703914` respectively.

Files (they live in _archive, not the paths listed in TOOLS.md):
- `/Users/ryanlarocca/.openclaw/workspace/PROJECTS/_archive/lrg-homes-website/index.html`
- `/Users/ryanlarocca/.openclaw/workspace/PROJECTS/_archive/lrghomes-landing/index.html`

Also check `thank-you.html` in both dirs if it exists.

Deploy both via: `cd PROJECTS/_archive/lrg-homes-website && vercel --prod` (wait for Ryan's go-ahead before deploying either site).

---

## Build Order

1. Part 0 — Twilio webhook config (can run immediately, no code deps)
2. Part 1 — CAMPAIGN_MAP (foundation for Parts 2+3)
3. Parts 2 & 3 — voice + SMS routes (can be done together)
4. Part 4 — website HTML files

---

## Checkpoint Protocol

After each part:
```
✅ CHECKPOINT: [Part name] complete
Summary: [1-2 sentences]
Files touched: [list]
Blocked: [yes/no]
```

Write a one-line status to `workspace/.cody-status` at each checkpoint or blocker.

---

## Deploy Gate

**Do NOT deploy to production.** When all code is written:
```
🏁 READY FOR REVIEW
Changed files: [list]
What to test: (1) Twilio API confirms VoiceUrl + SmsUrl set on PN SID for +16506703914, (2) call +16506703914 → Mission Control logs source=Google, source_type=google_ads, drip=google_ads_form
Deploy command: vercel --prod (Mission Control), then vercel --prod for each site
```

Wait for explicit "deploy" instruction.

---

## Files You May Touch

- `scripts/configure-twilio-number.mjs` (new)
- `lib/leads.ts`
- `app/api/leads/voice/route.ts`
- `app/api/leads/sms/route.ts`
- `PROJECTS/_archive/lrg-homes-website/index.html`
- `PROJECTS/_archive/lrg-homes-website/thank-you.html` (if exists)
- `PROJECTS/_archive/lrghomes-landing/index.html`
- `PROJECTS/_archive/lrghomes-landing/thank-you.html` (if exists)

## DO NOT TOUCH

- `lib/drip-campaigns.ts` — no new drip types needed
- `scripts/drip-engine.js` — no changes needed
- Anything on `feature/phase7d-polish`
- Any Supabase schema / migrations
