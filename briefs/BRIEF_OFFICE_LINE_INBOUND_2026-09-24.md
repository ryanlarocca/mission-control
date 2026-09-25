# Brief — Office-line inbound routing (business card)  · 2026-09-24

**Owner project:** comprehensive-relationship-management (Relationships tab) with a
Leads-tab touch point. **Status:** building.

## Why

Ryan's new business card carries the **Office — Ryan** line, (408) 458-5442
(ex ryan@ Google Voice). The card goes to homeowners, agents, inspectors —
anyone he meets face-to-face. Today every call/text to that line runs the
Leads intake: a lead row, direct-mail source type, Telegram "New lead call".
For a Relationships contact that row is then hidden by the Leads tab's
phone-match rule and nothing lands on their card.

## Rules (Ryan, 2026-09-24)

Applies to the two office lines only (`OFFICE_NUMBERS`: Office — Ryan,
Office — Info). Marketing lines (Google Ads, MFM-A/B, Legacy DM, Outbound)
are unchanged — unknown callers there are sellers and stay leads.

| Caller matches | Result |
|---|---|
| Relationships contact (phone) | Inbound call touch on their card; recorded + transcribed; summary appended to notes; Telegram alert with their name. No lead row. |
| Existing lead (phone, any prior inbound row) | Unchanged — new row joins the cluster, recorded, transcribed, triaged. Stays a lead. |
| Nobody | **New Relationships contact** (default, never a lead). Placeholder name = formatted phone, category Agent, tier C, source "Business Card". Transcript step fills name + category when the caller says them. |

Check order: Relationships → Leads → create Relationship. Anonymous /
withheld caller ID falls through to the Leads path (no usable key).
Texts to the office lines follow the same rule.

Edge case (deliberately NOT built): a seller who calls the card lands in
Relationships. Ryan: cross that bridge if we get there.

## Fixes folded in

- `/api/leads/voice/recording` gets the self-originated-call guard the
  voice handler already has (owned-number callers never insert a row).
- New lead rows created on the office lines get `source_type = "office"`
  instead of `direct_mail` (Campaign Performance was mis-bucketing them).

## Plumbing

- `lib/office-inbound.ts` — `resolveOfficeCaller`, `ensureRelationshipForCaller`,
  `openInboundCallTouch`, `logInboundTextTouch`, `formatUsPhone`.
- `/api/leads/voice` — office branch: resolve → touch → Dial TwiML whose
  `action` is `/api/crms/call/inbound?touchId=` and whose
  `recordingStatusCallback` is the existing `/api/crms/call/recording?touchId=`.
- `/api/crms/call/inbound` (new, public) — Dial action. `completed` → stamp
  status + duration + `last_contacted_at`. Otherwise play the voicemail
  greeting and `<Record action="/api/crms/call/recording?touchId=&voicemail=1">`.
- `/api/crms/call/recording` — accepts `voicemail=1`; hands `kind` to
  `processRelationshipRecording`, which now knows outbound / inbound /
  voicemail, uses a 3 s floor for voicemails, and for placeholder-named
  contacts asks Haiku for the caller's name + category from the transcript.
- `/api/leads/sms` — office branch: resolve → text touch + Telegram alert.
- `middleware.ts` — `/api/crms/call/inbound` added to PUBLIC_PATHS.

## Verify

`tsc --noEmit`, unit tests, deploy, then a real call from a non-owned phone
to (408) 458-5442 (self-originated test calls are filtered by design).
