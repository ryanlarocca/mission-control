# Relationships: email alerts with Draft:, and the business line caught up (2026-11-11)

Ryan, a few hours after the silent ryan@ → card sync shipped
(`briefs/BRIEF_RELATIONSHIP_EMAIL_SYNC_2026-11-11.md`): "if somebody in the
relationships tab sends me an email, then I would like a Telegram response,
and I would like to be able to use the draft command … I want the same
plumbing that we have with agent emails. If somebody sends me an email and I
hit reply draft on Telegram, the same command I've been using, I want to be
able to click the little check mark if it looks good and send it." And: "if
somebody calls, texts, or does anything with the business line, I want the
Telegram alert with all the plumbing that we get with all of our favorite
lead sources." He does not want a flood: one alert per email.

## What exists (audit, 2026-11-11)

- One bot, one chat, one webhook (`/api/campaign/telegram`). Since 2026-11-10
  an alert records who it is about (`lib/alertSubject.ts`,
  `telegram_alert_subjects`) and a reply routes through `lib/alertReply.ts`
  (Draft: / typed text / "call him").
- A Relationships subject can only be `line: "office" | "agents"` — both are
  texts. Nothing in Telegram can email a contact from ryan@:
  `sendRelationshipEmail` (lib/relationshipEmail.ts) is only called by the
  card's Send button, and `coachDraftForRelationship` / `sendRelationshipDraft`
  / `redraftRelationship` (lib/reply/telegram.ts) are hard-coded `sms`.
- Email to ryan@ from a card contact: logged on the card by
  `/api/crms/email-sync` (lib/relationshipEmailSync.ts), no alert.
- "AGENT REPLY" (lib/campaignInbox.ts ~:579) is posted WITHOUT `about`; its
  Draft: and typed replies find the contact by the name in the alert text
  (route.ts legacy branches; `sendCampaignEmailReply` → `.ilike("name")`,
  which fails when two contacts share a name).
- Office line calls: ring alert + voicemail / summary alerts carry `about`.
  A caller who hangs up without leaving a voicemail produces nothing after
  the ring alert. "call him" on an office-line alert is refused
  (`callSubject` in lib/alertReply.ts tells him to use the card).

## Work package A — email on the one reply path

Owner of: `lib/alertSubject.ts`, `lib/alertReply.ts` (NOT `callSubject`),
`lib/reply/**`, `lib/relationshipEmailSync.ts`,
`app/api/crms/email-sync/route.ts`, `lib/campaignInbox.ts`,
`lib/campaignEmail.ts`, `lib/campaignDraft.ts`,
`app/api/campaign/telegram/route.ts`, tests `tests/relationship-email-alert*.unit.test.ts`.

1. **Two new lines.** `AlertLine = "office" | "agents" | "email" | "campaign"`.
   `email` = a conversation on ryan@; `campaign` = an agent-campaign reply
   (answered from the campaign mailbox it arrived in). `line` is a free-text
   column — no migration.
2. **The alert.** `/api/crms/email-sync` request gains two optional fields:
   top-level `quiet: boolean` (a hand catch-up — never alert) and per message
   `kind: string` (the inbox agent's classification). When an **inbound**
   message is newly `logged` on a card (not stamped / duplicate / skipped),
   the request is not quiet and `kind !== "deal_lead"` (the inbox agent
   already posts a deal card with its own Reply button for those), send ONE
   `sendTelegramAlert` with
   `about: { kind: "relationship", relationshipId, phone: <card phone or null>, line: "email" }`:

   ```
   ✉️ <b>Email</b> — <b>Ashley Cao</b> (Investor · B)
   <b>Re: Great meeting you at the Mega Meetup</b>
   "Likewise! What are you working on currently?"
   ```

   Body = the stripped new text (`touchBody`) through `alertQuote`
   (lib/alertText.ts). A do-not-contact card says so on the first line
   (" · do-not-contact"); Personal cards alert like any other. An alert that
   fails must not fail the sync or change the response contract. Never alert
   for `sent` or `bounce`.
3. **Draft: on an email alert.** `coachDraftForRelationship` learns
   `line: "email"`: `coachDraft({ channel: "email" })`, no phone required
   (a card may have none), the draft message shows the subject it will go out
   under (the thread `findLatestEmailThread` picks → `replySubject`), same
   ✅ / 🔁 / ❌ buttons, same reply-to-revise. `sendRelationshipDraft` with
   `line: "email"` → `sendRelationshipEmail({ relationshipId, body, draftId })`
   (it already threads into their ryan@ conversation, logs the touch with its
   Gmail ids, restarts the clock, marks the draft sent). `redraftRelationship`
   keeps the draft's channel. Follow how the LEAD path does email-channel
   drafts for parity.
4. **Typed reply on an email alert** → `sendRelationshipEmail` with the typed
   text; confirmation says who and that it went in the same thread (or as a
   new email when there was none).
5. **AGENT REPLY joins the path.** When `cardForReply` resolved a card, the
   AGENT REPLY alert passes
   `about: { kind: "relationship", relationshipId, phone, line: "campaign" }`.
   In `lib/alertReply.ts`, `line: "campaign"` routes Draft: and typed replies
   to the SAME functions Ryan uses today (`draftCampaignEmail`,
   `sendCampaignEmailReply`) but finds the campaign contact through the card
   (`campaign_contacts.relationship_id`, the one with the newest
   `email_reply` event) instead of by name — add an optional contact id to
   those functions; the name path stays for alerts posted before this deploy
   and for replies that have no card. Drafter, mailbox, bookkeeping and the
   wording Ryan sees must not change. Do not touch `callSubject` (the other
   package wires calls); a "call her" on a campaign alert keeps working
   through whatever handles it today.
6. Unit tests for the pure parts (when to alert, alert text, line parsing,
   campaign-contact pick). `tsc --noEmit` clean.

## Work package B — business line

Owner of: `app/api/crms/call/**`, `lib/relationship-calls.ts`,
`lib/office-inbound.ts`, new `lib/officeCall.ts`, `app/api/leads/voice/**`
only if unavoidable, tests `tests/office-call*.unit.test.ts`. Do NOT edit
`lib/alertReply.ts` or `app/api/campaign/telegram/route.ts`.

1. **Missed call, no voicemail.** When a Relationships contact calls an
   office line, nobody answers and no voicemail is left, send ONE alert:
   `📵 <b>Missed call</b> — office line — <b>Name</b> (Category) — <number>` +
   "No voicemail." with `about: { kind: "relationship", relationshipId, phone, line: "office" }`.
   Never in addition to a voicemail alert: a call that leaves a voicemail
   keeps exactly the alerts it has today. Use the callbacks that already
   exist; if "no voicemail was left" cannot be known reliably from them, stop
   and report what is missing rather than guessing.
2. **Call from Telegram.** Export `startOfficeRelayCall(...)` from
   `lib/officeCall.ts`: rings Ryan's cell and connects him to the contact
   through the card line, recorded onto the card exactly like the card's Call
   button (`/api/crms/call`) — extract that route's core so both use one
   function. Returns `{ ok, label?, error? }`. The wiring into "call him" is
   done separately.
3. Unit tests for the pure parts. `tsc --noEmit` clean.

## Wiring done by the reviewer after both land

`scripts/inbox-agent/cards.mjs` sends `quiet` (hand runs) and `kind`;
`callSubject` uses `startOfficeRelayCall` for `office` and `email` lines.

## Out of scope

Alerts for texts/calls on Ryan's own cell; changing what the inbox agent's
own cards do; adding people; any change to who gets campaign emails.
