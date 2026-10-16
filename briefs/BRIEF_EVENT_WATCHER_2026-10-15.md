# Brief — Inbox agent: networking-event watcher

**Date:** 2026-10-15 · **Owner project:** `PROJECTS/inbox-agent/` · **Runs on:** Mac mini worker (`scripts/inbox-agent/index.mjs`, launchd every 5 min) + the existing Telegram button handler on Vercel (`lib/inboxAgent.ts`).

## Why

Organizers email 5–7 reminders per event (Conventus sent seven for Sept 17; SJRENC
sent 21 Meetup emails for three monthly events). Ryan wants to hear about each
in-person networking event **once**, in the morning brief, with a Telegram card he can
clear the same way he clears open loops — and never be nagged about it again.

Ryan's decisions (2026-10-15, verbatim intent):
- **Wants:** mixers, happy hours, socials, soirées, holiday parties, client-appreciation
  events, meetups at bars, any real-estate / business networking event starting at
  5 PM or later. "Mixers are the top priority." SJRENC-style speaker-talk-plus-networking
  at night counts as an event.
- **Trash:** lunch-and-learns, luncheons, tax meetings, panels, seminars, trainings,
  classes, general meetings, board elections, webinars / anything virtual, tech/SaaS
  vendor events (Cloudflare, Zapier, OpenRouter, Resend…), broker listing blasts /
  open houses / "showings" / property tours, anything already past.
- **Local only:** South Bay / Peninsula / Santa Cruz — roughly SF down to Santa Cruz.
  Out-of-area events are skipped silently ("I don't really care about that").
- **Borderline** (panel then mixer, no time listed, daytime but explicitly social) is
  shown and flagged, never dropped.
- **Delivery:** nothing fires at detection time. The 7:30 AM brief gets a
  "Networking events" section listing NEW events only; one Telegram card per new event
  follows the brief with **✓ Done**, **📅 Add to calendar**, **🚫 Not interested**.
  Add to calendar creates the event on info@lrghomes.com (same calendar as `cal:` adds).
- **Already on the calendar** when detected → no card, a one-line note in the brief.
- **No learning from "Not interested"** — "it just depends on the event".
- Dropped as unnecessary: day-of reminders; a calendar sweep for events with no email
  (the only such case, SJRENC, turned out to live in the personal Gmail).

## Sources

- **ryan@lrghomes.com** — Gmail API via the service account (`gmail.mjs`), all
  categories. Must run *independently of* `pollInbox`'s Promotions drop: 34 of the 59
  event emails in the dry run were Promotions, 23 Updates.
- **ryanlarocca9@gmail.com** — IMAP (`imapflow`, app password in `.env.local` as
  `PILE_GMAIL_IMAP_USER/_PASSWORD`). This is where Meetup / SJRENC / Eventbrite land:
  31 Meetup emails in 60 days there, zero on ryan@. Read-only; `[Gmail]/All Mail`.
- **Calendar** — `gog` CLI on the mini as info@lrghomes.com (read for the
  already-on-calendar check, `gog calendar create` for the Add button — same tool the
  sidecar's `/calendar/create` uses).

## Pipeline (every 5-min pass, `scanEvents`)

1. List mail from the last 2 days (first run: `--events-backfill=30d`), skip ids already
   in `inbox_settings.events.seen` (pruned after 10 days).
2. **Stage 0, free:** sender/subject/snippet prefilter (`EVENT_HINT_RE`,
   `EVENT_SENDER_RE`) → candidates. Hard skips before the model: webinar/Zoom subjects,
   vendor domains, listing-blast subjects (`ON_MARKET_RE`), Meetup "posted/commented"
   digests.
3. **Stage 1, model:** Sonnet (`thinking: disabled`, strict JSON) extracts name, organizer,
   date, times, venue, address, city, cost, RSVP link, format, who's-in-the-room line.
   "Today" in the prompt is the email's **arrival date** (the dry run's first pass
   judged against the wall clock and hid every Conventus email).
4. **Rules decide the verdict** (`verdictFor`, unit-tested): past → skip; virtual /
   vendor / listing → skip; not local → skip; start ≥ 17:00 → include (format
   seminar/meeting with no social element → borderline); start < 17:00 → skip unless
   explicitly social → borderline; no time → borderline; no location → borderline.
5. **Dedupe** (`matchEvent`): same `event_date` and (same `organizer_family` or same city
   with a shared significant name token). Family = alias map (`cvlending.com` →
   `conventus`), else the Meetup group slug from the sender local-part, else the
   from-name's first significant word, else the sender domain. Venue is NOT in the key
   ("Terún" vs "Terun" split one event in two). A matched row gets `email_count++`,
   `source_ids` appended, details refreshed; if `details_hash` changed on an already-shown
   row, `details_changed=true` so the brief mentions it once. **The verdict is decided
   once per row** — reminders never re-judge.

## Surfacing (in `maybeDigest`)

- Before the brief: `gog calendar events` for the next 120 days; a `new` row whose
  date + name/venue token matches → `status=acknowledged, on_calendar=true`.
- Brief section `📅 Networking events (N new)`: one line per `new` row (date, time,
  name, venue/city, cost, ⚠️ borderline reason), then `already on calendar: …` lines and
  `updated: …` lines for `details_changed` rows.
- After the brief: one card per `new` row → `status=alerted`, `tg_message_id`.
  Buttons: `ix:ed:<id>` Done · `ix:ec:<id>` Add to calendar · `ix:en:<id>` Not interested.
- `applyEventDecisions` (every pass): `add_requested` → `gog calendar create primary
  --from/--to (RFC3339 PT) --location --description --source-url` → `status=added`,
  confirmation card with the calendar link (reply to the original card). Failure → card
  with the error, status back to `alerted`.

## Not in scope

No immediate alerts, no reminders, no muting rules, no edits to Gmail (labels) on
either account, no changes to the existing classifier or Promotions handling.

## Verification

- `tests/inbox-events.unit.test.ts` — prefilter, family/dedupe, `verdictFor`, RFC3339,
  card text.
- `node scripts/inbox-agent/index.mjs --events-only --events-backfill=60d --dry-run` —
  prints every would-be row and the brief section; writes nothing.
- First prod pass with `--events-backfill=30d`, then the 7:30 brief next morning.
