# BRIEF — Relationships: second phone numbers, merge-by-name, phone edit (2026-10-15)

## Why

Vlad Rubashevsky (agent, email campaign) has two numbers. His card held his
office line (650-279-7872, from the 2024 agent list). On 2026-10-14 he called
the agents line from his cell (650-279-7880) *before* his email reply created
his real card, so `resolveAgentContact` didn't know him and created a
placeholder card named "(650) 279-7880". His email then said *"You can reach me
@6502797880 next week. If you want to call this week please call Alex
@6502799865."* Ryan hit Call on the real card and rang the office line; the
placeholder was a nameless duplicate he had to clean up by hand.

Three gaps, three tasks. One cloud session does all three on one branch
(`cloud/relationships-second-phone`). **No PR, no merge** — push the branch,
`npx tsc --noEmit` + `npx vitest run` clean, stop and report.

Ryan is not a developer; keep UI copy plain. No model identifiers anywhere in
commits or code.

## Ground rules

- `relationships.phone` (E.164) stays **the one number the Call/Text buttons
  dial**. Everything below adds a second list, `alt_phones`, used only for
  inbound matching and display. Never auto-swap `phone`.
- Phones are compared on their last 10 digits (`last10` in
  `lib/office-inbound.ts`). Store `alt_phones` entries as E.164 (`+1` + 10
  digits), de-duplicated, never equal to `phone`.
- The AGENT REPLY Telegram alert's first line must stay exactly
  `AGENT REPLY — <name> (after T#)` — a webhook regex parses it.
- The `name:` Telegram branch in `app/api/campaign/telegram/route.ts` must
  stay ABOVE every send path (comment in the file explains why).
- Vitest tests live in `tests/`. The cloud has no database: unit-test the pure
  functions (parsing, normalisation, merge planning), not Supabase calls.
- Migration is applied by Ryan's side with `node scripts/run-migration.mjs`;
  write it idempotent (`ADD COLUMN IF NOT EXISTS`). Don't try to run SQL.

## Task 0 — schema + matching (prerequisite for 1–3)

1. `supabase/migrations/2026-10-15_relationships_alt_phones.sql`:
   `alter table relationships add column if not exists alt_phones text[] not null default '{}';`
   plus a GIN index on it. (The table already has RLS enabled — don't touch.)
2. Add `alt_phones: string[]` to `RelationshipRow` (`lib/relationships.ts`),
   to `ApiContact` as `altPhones: string[]` (10-digit, for display), and to
   `REL_COLS` / `RelRow` in `lib/agentsLineInbound.ts`. Check
   `fetchAllRelationships` and `/api/crms/all-contacts` select the column.
3. Every inbound phone → card lookup matches `phone` **or** `alt_phones`:
   - `relByPhone` in `lib/agentsLineInbound.ts`
   - `resolveOfficeCaller` in `lib/office-inbound.ts`
   - `renameRelationshipByPhone` + `findDuplicates` in `lib/contactIntake.ts`
   - `/api/crms/touches` (`app/api/crms/touches/route.ts`, line ~30)
   Factor one helper, e.g. `relationshipsByAnyPhone(sb, phone10, cols)` that
   does `.or(\`phone.like.%${d},alt_phones.cs.{+1${d}}\`)` (match the exact
   PostgREST syntax already used at `lib/agentsLineInbound.ts:47`) and keeps
   the existing `order("status")` so active cards win over do_not_contact.
4. Display: wherever the card shows its phone — `ContactDetailModal.tsx`
   (~line 500, "Contact" grid) and the CRMSTab detail pane (~line 1446,
   "Structured fields" grid; there is no Phone row there today — add one above
   "Last contacted") — show `also: (650) 279-7872` in `text-zinc-500` under the
   main number when `altPhones` is non-empty.

## Task 1 — `name:` on a placeholder merges into an existing card

Today: `name: Vlad Rubashevsky` in reply to a "new caller" alert renames the
placeholder card. Wanted: if a **different** card already carries that name,
merge the placeholder into it instead of creating a duplicate.

In `renameRelationshipByPhone` (or a new `mergeOrRename…` it calls):

1. After finding the placeholder row (same lookup as today), search
   `relationships` for `name` equal to `cmd.name` case-insensitively (trimmed,
   `ilike` exact, no wildcards), excluding the placeholder's own id. Only when
   the found row is a **placeholder** (`isPlaceholderName`) does the merge
   apply; a real-named card with a *different* name keeps today's `has_name`
   behaviour.
2. Exactly one match → **merge**:
   - target's `phone` null → set it to the placeholder's phone; else append the
     placeholder's phone to target `alt_phones` (dedupe).
   - `update relationship_touches set relationship_id = target where relationship_id = placeholder`.
   - If the placeholder has `email` and target has none, copy it.
   - Append to target notes: `Merged via Telegram <Mon D, YYYY>: "(650) 279-7880" (Agents Line) → this card; 650-279-7880 added as an extra number.`
     Apply `cmd.category` / `cmd.tier` to the target if given (same as rename).
   - Delete the placeholder row **last**, only after the touch move succeeded.
   - Return a new outcome `{ success: true, merged: true, id: target.id, name, mainPhone, addedPhone, movedTouches }`.
3. Two or more matches → no write; return `{ success: false, reason: "ambiguous", candidates: [{id,name,phone,category,tier}] }`.
4. Zero matches → today's rename, unchanged.

Telegram reply text (`app/api/campaign/telegram/route.ts` rename branch):
- merged: `🔗 (650) 279-7880 merged into <b>Vlad Rubashevsky</b> (Agent, tier B). Main number stays (650) 279-7872; 7880 added as an extra. 2 calls moved. Reply "main" to make 7880 the number the Call button dials.`
- ambiguous: `⚠️ 2 cards are named Vlad Rubashevsky — (650) 279-7872 · Agent/B, (408) 555-0100 · Agent/C. Rename it from the Relationships tab.`

**`main` reply** (small, same branch area): a reply of exactly `main` (case-
insensitive, optional trailing period) to the bot's 🔗 merged message swaps
that card's `phone` and the added number: the added number becomes `phone`,
the old main goes into `alt_phones`. Parse the two numbers back out of the
replied message text (same stateless trick `parsePending` uses). Reply
`📞 Call button now dials (650) 279-7880 for Vlad Rubashevsky; (650) 279-7872 kept as an extra.`
Note line on the card: `Main number changed via Telegram <date>: 7872 → 7880.`

Tests (`tests/contact-intake-merge.unit.test.ts`): pure merge planner —
given placeholder row + candidate rows, returns rename / merge(with the
phone placement) / ambiguous; `main` parser extracts the two numbers from the
bot message.

## Task 2 — edit the phone on the card

New `POST /api/crms/phone` `{ id, phone }` (copy the shape of
`app/api/crms/tier/route.ts`):
- normalise to 10 digits → `+1…`; reject anything else with 400
  `"Enter a 10-digit US number"`.
- if another relationship already has it as `phone` or in `alt_phones` → 409
  `{ error: "That number is already on <Name>'s card" }` (no write).
- update `phone`; move the **old** `phone` into `alt_phones` (dedupe) so a
  call from the old number still lands on this card; remove the new number
  from `alt_phones` if it was there (this is the "promote an extra" path);
  append note `Phone changed on the card <Mon D, YYYY>: (650) 279-7872 → (650) 279-7880 (old number kept as an extra).`
- returns `{ success: true, phone: "<10 digits>", altPhones: [...] }`.

UI (both surfaces — `ContactDetailModal.tsx` Contact grid and the CRMSTab
detail pane Phone row from Task 0.4):
- a pencil (`Pencil` from lucide-react, `w-3 h-3 text-zinc-600 hover:text-zinc-300`)
  after the number → inline `<input>` pre-filled with the current number,
  Enter saves / Esc cancels, spinner while saving, error text under the
  input in `text-red-400` on 400/409.
- each `also:` extra number gets a small `make main` link (`text-zinc-600
  hover:text-zinc-300`) that POSTs the same route with that number.
- on success: update the local contact's `phone`/`altPhones` **and refetch
  touches + thread for the new phone** — the tab keys `touchesByPhone`, the
  `RelationshipThread`, and `invalidateRelationshipThread` by phone
  (`CRMSTab.tsx` ~454, ~768; `ContactDetailModal.tsx` ~177, ~356). Nothing
  server-side moves (touches are by `relationship_id`); only the client cache
  key changes.

Test: `tests/crms-phone.unit.test.ts` for the normalise + alt_phones
reshuffle helper (pure).

## Task 3 — numbers inside agent email replies land on the card

`triageReply` in `lib/campaignInbox.ts` (~line 590) already asks Haiku for
`{label, address, summary}`. Extend the prompt + JSON to
`"phones": [{"number": "<10 digits>", "whose": "self" | "other", "label": "<e.g. cell, office, Alex (partner)>"}]`
— max 3; `self` = a number the sender says to reach *them* at; `other` =
someone else they name (Alex). Parse defensively: keep only entries whose
`number` normalises to 10 digits, `whose` in {self, other}; otherwise `[]`.
Add `phones` to `ReplyTriage`.

Then in `cardForReply` (after `logInboundEmailTouch` succeeds, card resolved):
- for each `self` number not equal to the card's `phone` (last-10) and not
  already in `alt_phones` → append to `alt_phones` (dedupe, E.164). Never
  touch `phone`.
- append **one** note line per reply:
  `Numbers from their <Mon D, YYYY> email: 650-279-7880 (cell, added as an extra) · 650-279-9865 (Alex (partner), noted only).`
  Skip the note entirely when `phones` is empty.
- add a line to the Telegram AGENT REPLY alert body (not the first line):
  `📱 Added 650-279-7880 to the card · Alex (partner): 650-279-9865`.
- the triage result must reach `cardForReply` — pass it in rather than
  re-calling Haiku. If `triageReply` returns null, do nothing for phones.

Test: `tests/campaign-inbox-phones.unit.test.ts` — the JSON parser accepts
good entries, drops malformed ones, caps at 3; the alt_phones planner skips
the card's own number and existing extras.

## Done = 

- `npx tsc --noEmit` clean; `npx vitest run` green (existing + new).
- Branch `cloud/relationships-second-phone` pushed. Report: files touched,
  the migration file name, anything you could not verify without a database
  (list it — Ryan's side runs a prod check after merge).
