# BRIEF — "Card #" toggle on Relationships contacts (2026-10-26)

## What Ryan asked for

> "I would like to have a way to call the agent through my business card
> number … kind of like the My Cell button inside the leads cards. If that
> button gets toggled, it does all the calls and text messages through the
> business card number. The goal here is to transcribe the calls and have
> all the existing plumbing in place where we can add data to the card."
>
> "I would just leave everybody's existing settings as is, but go ahead and
> build this."

A per-contact **Card #** toggle on Relationships contacts. When ON, every
outbound call and text to that contact goes from the business-card line
**+1 408-458-5442** ("Office — Ryan", `OFFICE_NUMBERS` in `lib/leads.ts`)
instead of Ryan's personal cell. When OFF, behaviour is **exactly** today's.
**Default OFF for every contact** — no backfill, no auto-on for
`source = 'Business Card'` contacts (Ryan's explicit choice).

Why it matters: callbacks/texts to 458-5442 are already captured on the card
(office-line routing, `lib/office-inbound.ts`: Relationships phone match →
inbound touch, call recording → summary → notes, Telegram alert). Callbacks
to Ryan's cell are never captured. The toggle moves the conversation onto the
line we can capture.

## What exists today (read these first)

- **Calls:** `components/widgets/RelationshipCall.tsx` (`useRelationshipCall`,
  `CallButton`, `CallStatusLine`) → `POST /api/crms/call`
  (`app/api/crms/call/route.ts`) inserts a `relationship_touches` row, rings
  Ryan's cell (`FORWARD_TO`) from `getTwilioNumber()`, Twilio fetches the
  PUBLIC `app/api/crms/call/bridge/route.ts`, which `<Dial>`s the contact with
  `callerId = relationshipCallerId()` (Ryan's verified cell). Recording →
  `/api/crms/call/recording` → `processRelationshipRecording` → notes. All of
  that stays as is.
- **Texts out:** both surfaces call `POST /api/crms/send` with
  `{ phone, message }` → proxies to the Mac-mini iMessage sidecar. Then the
  UI calls `POST /api/crms/log` (`action: "sent"`, `modality` = the intent
  label like "Reconnect", not a channel) which inserts the touch and bumps
  `last_contacted_at`.
  - Queue card: `components/widgets/CRMSTab.tsx` ~line 843.
  - Contact modal (Quick send): `components/widgets/ContactDetailModal.tsx` ~line 402.
- **Texts in:** `app/api/leads/sms/route.ts` (office lines) and
  `app/api/campaign/sms/route.ts` (agents line 650-910-4007) call
  `logInboundTextTouch` (`lib/office-inbound.ts`) → touch with
  `modality='sms', action='inbound'`. Only Twilio lines write sms/inbound
  touches; nothing writes chat.db texts into `relationship_touches`.
- **Messages box:** `components/widgets/RelationshipThread.tsx` →
  `GET /api/crms/messages` → `fetchThread()` in `lib/relationship-messages.ts`
  (chat.db via sidecar ONLY — business-line texts are invisible there today).
  `fetchThread` is also read by `app/api/crms/generate/route.ts` (~line 582)
  and `lib/reply/context.ts` (~line 308) for AI drafts.
- **Twilio SMS:** `sendTwilioSms` / `getSenderPool` in `lib/leads.ts`.
  458-5442 is in the A2P "Low Volume Mixed" sender pool (added 2026-09-22).
  Twilio returns 201 for a From outside the pool and the carrier drops it
  later (30034), so the pool check up front is mandatory.
- **Telegram reply:** `app/api/telegram/webhook/route.ts`. Replying to a
  "💬 Office line text — …" alert currently falls to `sendLeadSms`, which
  texts from the default 650 outbound line (no leads row → no reply line) and
  writes a `leads` outbound row for a Relationships contact. Wrong line,
  wrong table. Fixed in Task 6.
- **Leads precedent:** the My Cell toggle — `app/api/leads/[id]/personal-cell/route.ts`,
  button in `components/widgets/LeadsTab.tsx` ~line 2943.

## Tasks

### 1. Schema (one migration)

`supabase/migrations/2026-10-26_relationships_card_line.sql`, header comment
in the style of `2026-10-15_relationships_alt_phones.sql`:

```sql
alter table relationships add column if not exists use_card_line boolean not null default false;
-- The Twilio line a text/call went out from or came in on (E.164). Null =
-- Ryan's own phone (iMessage sidecar / verified cell) or unknown (old rows).
alter table relationship_touches add column if not exists twilio_number text;
```

No backfill. Keep it this small. The cloud session cannot run SQL; it is
applied on the Mac mini after merge.

### 2. Constant + helpers

- `lib/leads.ts`: export `CARD_LINE = "+14084585442"` next to `OFFICE_NUMBERS`
  (use the constant in `OFFICE_NUMBERS` too).
- `lib/relationship-calls.ts` (or a small new `lib/card-line.ts`):
  `getCardLineFlag(sb, relationshipId): Promise<boolean>` (false on any error,
  logged).

### 3. Toggle route + UI on BOTH surfaces

- `POST /api/crms/card-line` `{ id, on: boolean }` → updates
  `relationships.use_card_line`, returns `{ ok, on }`. Auth-gated (NOT in
  `PUBLIC_PATHS`).
- Every contact payload that feeds the two surfaces carries `useCardLine`
  (find where `CRMSContact` / the modal's contact type are built — wherever
  `alt_phones` → `altPhones` is mapped, add `use_card_line` → `useCardLine`).
- **Contact modal header** (`ContactDetailModal.tsx`, the row with
  Agent + Tier pills) and **queue card** (`CRMSTab.tsx`, near its Call
  button): a toggle button styled like Leads' My Cell (sky colours,
  `min-h-[36px]` — Ryan is on an iPhone), label `Card #` / `Card # ✓`.
  Tooltip ON: "Calls and texts to this contact go from your business card
  number (408) 458-5442 — click to switch back to your cell". OFF:
  "Call and text from your business card number (408) 458-5442 instead of
  your cell".
- Optimistic flip, revert + toast on failure, keep the queue card and the
  modal in sync (same pattern as `handlePhoneChanged`).
- When ON, the Quick-send placeholder reads "Type a message and tap Send —
  goes out from (408) 458-5442." and `CallButton`'s title says the contact
  sees (408) 458-5442.

### 4. Calls + texts follow the flag (server decides, never the client)

**Calls** — `app/api/crms/call/route.ts` reads `use_card_line` for `body.id`.
When ON, append `&line=card` to the bridge URL and return
`callerId: CARD_LINE`. `app/api/crms/call/bridge/route.ts`: `line=card` →
`callerId = CARD_LINE`; anything else → `relationshipCallerId()` exactly as
today. Never accept a raw number from the query (the route is public). Also
stamp `twilio_number = CARD_LINE` on the touch when ON. The first leg (ringing
Ryan's cell from `getTwilioNumber()`) is unchanged. `useRelationshipCall`'s
status text: "Ringing your cell… answer to connect to X (they'll see
(408) 458-5442)" when ON.

**Texts** — both send handlers add `id: contact.id` to the
`/api/crms/send` body. `app/api/crms/send/route.ts`:
- No `id`, or flag OFF → the sidecar path, byte-for-byte as today.
- Flag ON →
  - refuse when the relationship's `status` is `do_not_contact` (409);
  - send through Twilio from `CARD_LINE` with **no fallback to another
    line**. Add a `strictFrom?: boolean` option to `sendTwilioSms` that
    throws (instead of falling back) when the line is not in the sender
    pool, the pool is unreadable, or Twilio rejects the From. A text from
    the 650 line would show the agent a stranger's number.
  - Set `StatusCallback` to a new public route
    `/api/crms/sms-status` (add to middleware `PUBLIC_PATHS` with a comment)
    that posts a Telegram alert (`sendTelegramAlert`) on `failed` /
    `undelivered`, naming the contact + error code. Other statuses → 204.
  - On any send failure: return an error (502) AND post a Telegram alert —
    silent failures on Ryan-initiated sends are not allowed.
  - Success response: `{ success: true, via: CARD_LINE, sid }`.
- Both UIs pass `twilioNumber: data.via ?? null` through to `/api/crms/log`.
  `app/api/crms/log/route.ts` stores it in `relationship_touches.twilio_number`.
  Everything else in `/log` (cadence bump, draft linking) is unchanged.

**Inbound** — `logInboundTextTouch` takes an optional `twilioNumber` and
stores it. `app/api/leads/sms/route.ts` passes the office line the text came
in on; `app/api/campaign/sms/route.ts` passes the agents line.

### 5. One conversation everywhere

- `lib/relationship-messages.ts`: `ThreadMessage` gains optional
  `via?: string` (E.164 of the Twilio line). New
  `fetchContactThread(sb, phone, timeoutMs?)` = `fetchThread(phone)` merged
  with that contact's business-line touches (ids via
  `relationshipsByAnyPhone`):
  `(modality = 'sms' AND action = 'inbound')` OR
  `(action = 'sent' AND twilio_number IS NOT NULL)`. Map to
  `{ at: occurred_at, fromMe: action === 'sent', text: message, via: twilio_number ?? 'business line' }`,
  skip empty messages, sort by `at`, drop exact text duplicates within 60 s.
  Best-effort: a Supabase error falls back to the chat.db thread alone.
- Use it in `app/api/crms/messages/route.ts`, `app/api/crms/generate/route.ts`
  and `lib/reply/context.ts` in place of `fetchThread`. In
  `/api/crms/messages`, business-line texts still return when the sidecar
  is not configured (`ok` keeps meaning "sidecar reachable").
- `RelationshipThread.tsx`: a small muted tag on business-line bubbles,
  e.g. `via 458-5442` (last 7 digits formatted; "business line" when unknown).
- `formatThreadForPrompt`: append ` (from business line)` to Ryan's
  business-line messages so the drafter knows which number the thread is on.

### 6. Telegram replies to office-line texts go out from the office line

`app/api/telegram/webhook/route.ts`, a new branch ABOVE the generic
`sendLeadSms` path (mirror the agents-line branch): when the replied-to text
matches `/Office line text/i` and its `+1…` number resolves to a
Relationships contact (`relationshipsByAnyPhone`):
- send from the office line that contact last texted (newest sms/inbound
  touch's `twilio_number` that is in `OFFICE_NUMBERS`), else `CARD_LINE`,
  via `sendTwilioSms({ strictFrom: true, … })`;
- insert a touch (`modality: 'sms'`, `action: 'sent'`, `message`,
  `twilio_number`) and bump `last_contacted_at`, the same writes `/api/crms/log`
  does for a sent text;
- never write a `leads` row; confirm in Telegram ("✅ Texted <name> from
  (408) 458-5442") or "⚠️ Not sent — …".
- Do NOT touch the `name:` / `rename:` branch in the campaign Telegram route.
  This is the leads-bot webhook only.
- If the alert's number does not resolve to a Relationships contact, fall
  through to today's path unchanged.

This runs regardless of the toggle. They texted the office line, so the
reply goes back on it.

## Tests (vitest, `tests/*.unit.test.ts`)

- Bridge: `line=card` → `callerId="+14084585442"`; missing/other `line` →
  `relationshipCallerId()`; a raw `callerId=` query param is ignored.
- `sendTwilioSms({ strictFrom: true })`: throws when the line is not in the
  pool / pool unreadable / Twilio rejects; never calls the default line
  (mock `fetch`).
- `fetchContactThread` merge: inbound sms + sent-with-number touches
  interleave with sidecar messages by time; sent touches with null
  `twilio_number` are excluded; 60 s duplicate dropped; Supabase error →
  sidecar thread only.
- Telegram branch: an "Office line text" reply for a Relationships phone
  sends from the office line and inserts a touch, not a lead row; a non-match
  falls through.
- `npx tsc --noEmit` clean, full `npx vitest run` green.

## Out of scope

- Leads-tab changes; the My Cell toggle; drips; email.
- Backfilling `twilio_number` on old touches.
- Caller-ID name (CNAM) registration for 458-5442.

## Delivery

Push branch `cloud/relationships-card-line`. No PR, no merge, no migration
run. Report: files changed, test count, and anything you could not verify
(PostgREST filters, Twilio status callback shape, live sends).
