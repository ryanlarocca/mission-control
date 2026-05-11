# CRMS Debug Notes — 2026-05-10 (Sun PM)

Ryan's live walkthrough findings while testing the CRMS workflow.

## Call: Brian Metcalf — 541-420-2638

- **Lead:** Brian Metcalf
- **Phone:** 541-420-2638 (inbound)
- **Property (correct):** 2127 Los Gatos Almaden Road
- **System captured:** wrong address (specifics TBD — needs investigation)

## Bugs / Gaps observed

1. **Lead name not populated** — call came in but system did not set lead's name on the record.
2. **Address not populated / wrong** — system pulled an incorrect address. Brian gave 2127 Los Gatos Almaden Road verbally.
3. **No follow-up created** — system did not auto-create a follow-up task after the inbound call.
4. **Outbound number not yet wired** — Ryan called back but the outbound caller-ID/recording path wasn't fully set up, so no call recording was captured.

## Feature requests

1. **Editable address field** on the lead/property record (so Ryan can fix when the system grabs the wrong one).
2. **Rework AI call summary:**
   - Simple, 2–6 sentence summary of what the lead and Ryan discussed.
   - Mention what their message/inquiry was about.
   - Include urgency / lead temperature tag (warm / hot).
   - Drop the current verbose format.

## Coming next from Ryan

- New voicemail recording — single voicemail to be used across all 3 numbers. Ryan will send the audio file in a follow-up message.

## Next actions

- [ ] Investigate why the inbound captured wrong address (Twilio webhook payload? geocoding?)
- [ ] Add editable address field to lead/property detail UI
- [ ] Patch AI summary prompt — shorter, 2–6 sentences, urgency tag
- [ ] Auto-create follow-up task on inbound call completion
- [ ] Wire outbound caller-ID + recording for callbacks (cross-ref CODY_BRIEF_OUTBOUND_CALLBACK_E2E.md)
- [ ] Deploy unified voicemail to all 3 Twilio numbers once Ryan sends file
