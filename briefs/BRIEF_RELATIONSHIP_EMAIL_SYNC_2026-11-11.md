# Relationships: email with contacts lands on the card, quietly (2026-11-11)

Ryan: "the relationships tab is really just a glorified reminder at this
point … if people that are in my relationships tab send me emails, then it
will update their card automatically. It'll do it silently, and it'll let me
know if there's an issue with it. But not everybody belongs in the
relationships tab. And I don't want to get pinged all day long by Telegram."

Today a Relationships card only learns from the Twilio lines and from emails
sent with the card's own Send button. Anything Ryan sends or receives in
Gmail on `ryan@lrghomes.com` never reaches the card.

## Rules Ryan set

- **Silent.** No Telegram message when it works. One alert a day at most when
  it stays broken.
- **Never add people.** An email from/to an address that is not on a card is
  ignored. No "add this person?" prompts.
- **No backfill.** Starts at go-live. One catch-up run for the 12 Mega Meetup
  contacts (from 2026-11-10) is done by hand after deploy.
- **Token-light.** Only real person-to-person email from a card contact gets
  an AI read.
- **Personal contacts** (category `Personal`): emails are recorded, but no
  automatic notes — from email or from texts.
- **Do-not-contact cards:** the email is recorded as history; no notes, status
  never changes.
- **Bounces:** note on the card + one line in the morning brief. No ping.
- The agent email campaign is not touched.

## Audit numbers (2026-11-11)

1,057 cards · 316 with an email (158 of them do-not-contact) · 0 emails shared
by two cards · 2 emails stored with capitals · last 30 days on ryan@: 12
inbound from card contacts, 18 sent to them, 0 sends reaching 2+ cards ·
`relationship_touches` has no Gmail id column (74 email touches exist).

## Contract between the two halves

The Mac-mini inbox agent finds candidate messages and POSTs them; Mission
Control matches, dedupes, saves and writes notes. Same shared-secret pattern
as `/api/reply/drip-draft` (header `x-reply-secret` =
`REPLY_INTERNAL_SECRET || MC_PASSWORD`, base `MC_BASE_URL` default
`https://mission-control-three-chi.vercel.app`).

`POST /api/crms/email-sync` (public path, secret-gated, `maxDuration = 60`)

```jsonc
// request — at most 10 messages
{ "messages": [ {
    "gmailId": "1a1c…",            // required
    "threadId": "1a1c…",
    "direction": "inbound" | "sent" | "bounce",
    "at": "2026-11-11T21:33:53Z",  // the email's own time
    "from": "acao@oldcapitallending.com",   // lowercased
    "to": ["a@b.com"],             // To + Cc, lowercased, Ryan's own domains removed
    "subject": "Re: Great meeting you at the Mega Meetup",
    "text": "plain-text body, unstripped",
    "failedRecipient": null        // bounce only: the address that bounced
} ] }

// response 200
{ "results": [ {
    "gmailId": "1a1c…",
    "cards": [ { "relationshipId": "…", "name": "Ashley Cao",
                 "status": "logged" | "stamped" | "duplicate" | "skipped",
                 "reason": "…",       // when skipped
                 "note": "[Nov 11, 2026 email] …" | null } ],
    "done": true                    // false = try this message again next pass
} ] }
```

`done: true` means the mini never needs to send that message again (logged,
duplicate, no card, a blast, …). A thrown error for one message → that entry
`done: false`, the others still processed. 401 on a bad secret.

## Work package A — Mission Control (lib/, app/, supabase/, middleware.ts)

1. **Migration** `supabase/migrations/2026-11-11_relationship_email_sync.sql`
   (idempotent): `relationship_touches.gmail_message_id text`,
   `.gmail_thread_id text`, unique index on
   `(relationship_id, gmail_message_id) where gmail_message_id is not null`;
   `relationships.texts_noted_through timestamptz`.
2. **`lib/relationshipEmailSync.ts`** + the route.
   - Card lookup: load every card's email (paged — the table is over
     PostgREST's 1,000-row cap) and match lower-cased in JS. Inbound →
     the sender. Sent → each To/Cc address; more than 5 outside recipients =
     a blast, skipped.
   - Dedupe: a touch with the same `(relationship_id, gmail_message_id)` =
     `duplicate`. Otherwise an existing email touch on the card with no Gmail
     id, the same action, and either within 10 minutes of `at` or the same
     subject (Re:/Fwd: stripped) on the same Pacific day → write the ids onto
     it (`stamped`) instead of inserting. (Covers the hand-logged rows from
     2026-11-11.)
   - Insert: `modality "email"`, `action "inbound" | "sent"`,
     `occurred_at = at`, `message = emailTouchMessage(subject, body)` with the
     quoted reply history and signature-less tail stripped the way
     `lib/campaignInbox.ts` does for campaign replies (reuse / export it),
     tier/category at touch, both Gmail ids.
   - Sent → `last_contacted_at = max(existing, at)` — never backwards.
   - Inbound → `landInboundNote` unless the card is do-not-contact or
     `Personal` (add the Personal skip inside `lib/inboundFacts.ts` so the
     text paths get it too).
   - Bounce → card matched by `failedRecipient`; one touch
     (`action "bounced"`, Gmail id for idempotency, does not touch
     `last_contacted_at`) + a dated note line
     `[<day> email] Email to <addr> bounced — the address on this card may be wrong.`
3. **Card sends carry their Gmail ids.** `sendRelationshipEmail` writes
   `gmail_message_id` / `gmail_thread_id` on its touch so the watcher does not
   log the same email twice.
4. **Reply in their thread.** `findLatestEmailThread` also considers the
   newest inbound email touch that has a `gmail_thread_id` (mailbox ryan@) and
   returns whichever is newer — it or the campaign thread.
   `campaignContactId` becomes nullable; the `campaign_events` insert only
   happens for campaign threads. The card's "Reply · Re: …" then works for
   ryan@ conversations with no UI change.
5. **Notes from cell texts when a card is opened**
   (`app/api/crms/messages/route.ts`, which already loads the last 15
   messages). Business categories only, not do-not-contact.
   `texts_noted_through` null → set it to now and read nothing (no history).
   Otherwise, inbound 1:1 phone texts (not ours, not the business-line rows —
   those were read on arrival) newer than the marker → claim by advancing the
   marker with a conditional update, then one batched `landInboundNote` under
   `waitUntil`. Never delays the response; no extra sidecar/chat.db reads.
6. Unit tests for the pure parts. `tsc --noEmit` clean.

## Work package B — inbox agent on the mini (scripts/inbox-agent/)

New `cards.mjs` (pure helpers + IO) and one hook in `index.mjs` after
`pollInbox`. Honour `--dry-run` (reads only, prints what it would post).

1. Start line in settings (`card_sync.since`), created as "now" on the first
   run. Flags for the hand catch-up: `--cards-only`,
   `--cards-since=<ISO date | Nd>`, `--cards-emails=a@b.com,c@d.com`.
2. Card emails: every `relationships.email`, paged, lower-cased.
3. Candidates since the start line (never older than 8 days unless the flag
   says so):
   - inbound: `inbox_messages` rows for this mailbox with kind `human` or
     `deal_lead` whose sender is a card email;
   - sent: `in:sent` mail with at least one To/Cc on a card;
   - bounces: mailer-daemon / postmaster mail whose failed recipient is a
     card email.
4. Skip what is already done: a `relationship_touches` row with that Gmail id,
   or an id in the settings done-list (`card_sync.done`, last 500). Fetch the
   body only for what is left, POST in batches of ≤ 10, record `done` ids.
5. Failures stay queued (no `done`), retried every pass. Three failed passes
   in a row → one Telegram alert, at most one per Pacific day:
   "⚠️ Relationships email sync is failing — <reason>. Nothing is lost; it
   will catch up." Success is silent.
6. A bounce result adds one line to the next morning brief.
7. Unit tests for the pure helpers (recipient parsing, candidate filtering,
   bounce recipient extraction, alert throttling).

## Out of scope

Adding people; alerts on success; matching by name; the agent email campaign;
other mailboxes (info@, the personal Gmail); a "where we left off" line.
