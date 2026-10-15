# Brief — Coached drafts ("tell it the gist, it drops the message")

Date: 2026-10-15 · Owner: Ryan · Build: cloud session on branch `feat/reply-coach`

## The problem, in one story

Ryan called Herb (lead `b6a07bb7-d478-4646-9090-19794e821cd4`, 409 Center St,
Santa Cruz, triplex). On the call Herb said the place appraised at $1.6M and
"I wouldn't go lower than that"; Ryan promised to text a ballpark number
within a couple of days. Ryan then ran his own comps (renovated small
multifamily nearby at $1.2–1.3M, this one is original) and landed at ~$950K.

He dictated that gist to an agent chat, which read the whole card and wrote
the text he sent:

> Hi Herb, it's Ryan. Thanks again for telling me about 409 Center. I ran the
> numbers and want to be straight with you. Since the units are mostly
> original, I'd be putting real work into all three, and renovated small
> multifamily near you is selling around $1.2–1.3M. That puts me at about
> $950K. All cash, no agents, no fees, and you pick the closing date. I know
> that's a long way from $1.6M, so no pressure at all. If things change down
> the road, I'd be glad to talk again.

The card's **AI Draft** could not have produced that. Why (verified in code):

1. `lib/reply/context.ts` `MAX_TEXT = 4000` clips every thread item. The call
   transcript is ~7,600 chars; Herb's "$1.6M floor" is at ~4,300 and Ryan's
   "I'll text you a number" promise at ~6,200. The drafter never sees them.
2. `context.ts:183` tags a row as `"ryan"` when it has no `twilio_number`.
   Ryan *placed* that call, so the whole two-voice transcript is labelled as
   Ryan speaking.
3. Ryan's number and reasoning live only in his head. `VOICE_SYSTEM` (rightly)
   forbids inventing figures, so the best the drafter can do is `[OFFER PRICE]`.
4. `briefs/REPLY_PLAYBOOK.md` has no principles yet for `offer_requested` and
   `price_pushback`.
5. Text channel rule caps at three sentences; delivering a low number
   politely needs reason + number + terms + open door.
6. There is no way to steer the *first* draft. The only input is the
   "What's off? One sentence." box after a bad draft.

## What to build

Two draft modes on every card that mounts `ReplyPlanner`, sharing the same
plan chips, critic and `reply_drafts` log:

- **Auto** — exactly what exists today (Haiku plan → Sonnet draft). Keep it.
  It is right for silence breakers, check-ins, thank-yous.
- **Coach** (new) — Ryan taps the mic (or types) and says the gist. Opus reads
  the *whole* history plus the gist and returns (a) a 2–3 line **read** of the
  situation and (b) the **draft**. He can then refine conversationally
  ("shorter", "drop the comps", "make it 925") — each refinement is another
  coach turn that sees the previous draft.

And a learning loop so coached sends make future Auto drafts better.

### A. Context fixes (benefit both modes) — `lib/reply/context.ts`

- Stop clipping call transcripts. Keep `MAX_TEXT` for texts/emails; call
  transcripts (`lead_type === "call"`, drip or not) get a separate generous
  cap (≥ 20,000 chars). If the total thread would blow the prompt, drop the
  *oldest* items, never the middle of a transcript.
- Fix speaker attribution for calls. Add `from: "call"` to `ThreadItem` for
  two-voice transcripts. `formatThread` renders it as
  `call transcript, both voices — Ryan placed this call` when the row has no
  `twilio_number`, and `inbound call transcript` when it does. Voicemails stay
  `"them"`.
- Surface the card's own money facts in `describeContact`: `offer_amount`,
  `offer_verbalized_at`, and the full `notes` (currently notes are only passed
  for relationships; leads carry history lines like `Offer 1.1` there).
- Unit test for both fixes using Herb's shape (a 7,600-char outbound call row,
  a Twilio-inbound voicemail row) — assert the floor sentence survives and the
  labels are right.

### B. Opus — `lib/llm.ts`

- Add `export const OPUS = "claude-opus-5-5"`. Treat it like `SONNET` for the
  `thinking` switch (adaptive thinking shares `max_tokens`; see the Sonnet
  comment). Coach calls run with thinking **on** and `maxTokens ≥ 8192`.
- Do not change Auto's models.

### C. Coach drafter — `lib/reply/coach.ts`

`coachDraft({ ctx, channel, surface, gist, turns, plan? })` →
`{ read, subject, body, draftId, plan }`.

Prompt assembly (reuse `VOICE_SYSTEM`, `describeContact`, `formatThread`,
`loadPlaybook`/`principlesFor`, `loadExemplars`):

- Full thread (post-A), contact block, playbook principles for the moment,
  exemplars with **coached exemplars first** (see F1), then:
- `RYAN'S GIST (dictated; authoritative on numbers, decisions and intent;
  rough speech — apply the meaning, never quote it)` + the gist.
- Prior turns if refining: each `{ gist, body }` pair; "Ryan's follow-up"
  wording like the existing `why` block.
- Ask for JSON `{ "read": "...", "subject": ..., "body": "..." }`. `read` =
  2–3 plain lines: what they said that matters (quote their words), what Ryan
  owes or promised, risks (contradictions between the gist and the record —
  e.g. a prior higher offer on the card; an attached owner; a stated floor).
  If the gist conflicts with the record, say so in `read` and still draft to
  the gist.
- Channel rules for Coach: text stays a text (no subject, no sign-off,
  plain ASCII), but the three-sentence ceiling is lifted to "as long as the
  gist needs, as short as it can be". Email rules unchanged.
- Run the existing `critique` pass. Record via `recordDraft` with
  `mode: "coach"`, `gist`, `read` (new columns, see D). `prompt_version`
  `coach-v1-2026-10-15`.
- Plan: if the caller passes chips, use them; otherwise run `proposePlan`
  first so the moment/next_action are stamped like Auto.

### D. API + schema

- `POST /api/reply/coach` — body `{ leadId? | relationshipId?, channel,
  surface, gist, turns?: {gist, body}[], plan? }` → the `coachDraft` result.
  Same auth/middleware as `/api/reply/draft`.
- Migration `supabase/migrations/2026-10-15_reply_drafts_coach.sql`:
  `alter table reply_drafts add column if not exists mode text not null
  default 'auto'`, `gist text`, `read_text text`. Write the file only —
  **do not run it**; it is applied from the Mac mini.
- `lib/reply-client.ts`: `requestCoach(...)` mirroring `requestDraft`.

### E. UI — `components/widgets/ReplyPlanner.tsx` + every mount

- Add a mode toggle `Auto | Coach` above the draft. Coach shows: a textarea
  with the existing mic (`getSpeech`) wired to it, a `Draft from this`
  button, then the **read** (muted, above the draft), the draft (editable as
  today), and a follow-up box (`Refine: "shorter", "make it 925"…`, mic too)
  that posts another turn.
- Send path is the existing one — Send still executes the plan chips.
- Nudge: when an Auto draft body contains a bracketed placeholder
  (`/\[[A-Z][A-Z ]+\]/`), show `This one needs your number — Coach it` and
  switch the toggle on click.
- Mounts to cover (grep `ReplyPlanner` / `requestDraft`): `LeadsTab.tsx`,
  `FollowUpsTab.tsx` (two mounts), `CRMSTab.tsx`, `ContactDetailModal.tsx` if
  it drafts. Ship a **surface × capability matrix** (mic / gist / read /
  refine / nudge / send-executes-plan) in the PR description; a surface
  without Coach is a bug, not a follow-up.
- Phone width: the Leads card is used from the phone. Buttons ≥ 40px tall
  like the existing ones.

### F. Learning loop

1. **Coached sends become the top exemplars.** In `lib/reply/exemplars.ts`,
   `reply_drafts` rows with `mode = 'coach'` that were actually sent (see how
   `execute.ts` / `record.ts` mark a sent draft) rank first for the same
   moment/channel/surface, and `formatExemplars` renders them as
   `Ryan's gist: … → what he sent: …` so the register example carries the
   intent. Keep the existing "tone and length only" instruction; the critic's
   leak check must still catch another contact's numbers or phrases.
2. **Gists feed the playbook's pending list.** Find where `why` sentences
   are collected for the weekly review (`lib/reply/telegram.ts` / the review
   script) and add coached gists to the same pending list for that moment,
   prefixed `coach:`. No principle is written automatically — Ryan approves
   them, same as whys today (CLAUDE memory: edits are questions, not rules).
3. **Facts land on the card.** On a coached send for a **lead**, one Haiku
   call over `gist + final body` extracts `{ offer_amount: number|null,
   reasoning: one line }`. If a dollar figure was stated: set
   `leads.offer_amount` and `offer_verbalized_at` (on the cluster, like
   `stampLeadMoment`), and append a dated line to `notes`:
   `[Coach 2026-10-15] At $950K; renovated comps $1.2–1.3M; he is at $1.6M.`
   Relationships: append the same line to `notes` only.

### G. Gates

- `npx tsc --noEmit` clean (the real gate; ESLint is ignored in builds).
- Unit tests for A (context) and for the exemplar ranking in F1.
- A dry run of `coachDraft` against Herb's lead with the gist
  "I'm at 950, renovated comps 1.2 to 1.3, he's at 1.6, keep the door open"
  — paste the `read` and `body` in the PR. It should mention his $1.6M
  floor, the promised text, and the `Offer 1.1` history on the card.
- Do **not** run migrations, do not touch `.env.local`, do not send anything
  to a real contact. Commit on `feat/reply-coach`; the Mac mini session
  merges, migrates and deploys.

### Out of scope (v2)

- The coach looking things up itself (comps, listing photos, public records).
- Changing Auto's models or prompts beyond the shared context fixes in A.
- Any voice-rule written without Ryan's approval.

## Pointers

- `lib/reply/*` — planner (Haiku), drafter (Sonnet), critic, exemplars,
  playbook reader, record/execute. `briefs/BRIEF_REPLY_PLANNER_2026-09-24.md`
  is the original design.
- `lib/llm.ts` — the single Anthropic client; `completeText` retries once on
  truncation.
- `components/widgets/ReplyPlanner.tsx` — the shared draft panel; its
  "Not right" box already has the `SpeechRecognition` mic to reuse.
- `briefs/REPLY_PLAYBOOK.md` — principles per moment, runtime-read.
