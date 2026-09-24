# Reply Planner — plan first, draft second, learn from "why"

**Status:** green-lit by Ryan 2026-09-24. Phase 0 built (awaiting Ryan's grades). **Phase 1 built 2026-09-24** — engine, table, routes, intake moments, send linkage, eval runner; first eval run: plan matched 17/22 of my provisional moment labels, soft-no drafts on principle with 0 critic rewrites after tuning. **Phase 2 built 2026-09-24** — plan chips, Not right + why (mic), Send executes plan, on all four Leads composers + the Follow Ups modal; auto-draft on expand when the last message is theirs. Ryan graded eval items 1–9 (8 keep; item 4 fix → first pending why) and stopped: the live loop replaces the rest. **Phase 3 built 2026-09-24** — Relationships queue composer and the contact modal's quick-send draft through `lib/reply` (intent × familiarity = the plan; edited sends by category as register; playbook `relationships_shared`); `crms/log` links the touch to its draft. Phase 4 (drips) next.
**Owning project memo:** `../lead-pipeline/` (Leads + Follow Ups + drips) with a
cross-entry in `../comprehensive-relationship-management/` (Relationships).
**Origin:** Virginia Slater's soft-no draft, 2026-09-24. The conversation
that produced this brief is summarised in "Philosophy" below.

## Philosophy (what we aligned on)

1. **A draft is only as good as the plan behind it.** Today the reply is
   written the moment an email lands, before anyone has decided what
   happens with the person. The plan (what kind of moment this is, how warm
   they are, what we do next) nearly determines the reply. So: propose the
   plan first, draft from it.
2. **Edits don't train anything. "Why" does.** An edit says what changed, not
   why. One sentence of reasoning generalises; a rewritten paragraph does
   not. The cheapest, highest-signal input Ryan can give is one spoken
   sentence when a draft is wrong, and he is paid back instantly with a
   better draft.
3. **Ryan never writes rules.** I read the why-sentences on a cadence. One
   is a question, not a rule. Three that rhyme become a proposed principle
   Ryan approves with a reply. The playbook stays small and true.
4. **Keep score or it's vibes.** A fixed eval set of real moments, graded
   once by Ryan; every prompt/playbook change runs against it before it
   ships. In production the one number is the share of drafts sent
   untouched.
5. **The reply and the drip are one conversation.** A "got it" reply
   followed two weeks later by "still thinking about selling?" burns the
   goodwill. Drips must honour the moment the reply acknowledged.
6. **Thorough means every surface.** Ryan's standing complaint: features
   land on one card. The coverage matrix at the bottom is the ship gate.

## Why today's drafts are unusable (inventory, 2026-09-24)

Six unrelated draft generators, no two sharing a prompt, a store, or an
edit path:

| Surface | Generator | Model | Sees | Pair stored? |
|---|---|---|---|---|
| Leads card `suggested_reply` | `triageEmailLead` in `lib/leads.ts` | Haiku, inside an 8-field classification call | the ONE inbound email | no (write-once at intake, never refreshed) |
| Leads / Follow Ups "AI draft" | `app/api/leads/[id]/draft-message` | Haiku | last 16 msgs both directions + notes | no (React state only) |
| Drip touches | `scripts/drip-engine.js` | Haiku | 50 rows + chat.db tail, responsiveness | edit overwrites the original in place |
| Relationships "generate" | `app/api/crms/generate` | Sonnet | last 8 thread msgs + notes + voice few-shot | **yes** (`relationship_touches.generated_message`, `was_edited`) but no why |
| Telegram lead-alert reply | none | — | — | — |
| Inbound SMS / call transcripts | none (no suggested reply at all) | — | — | — |

Existing feedback mechanisms: Relationships uses *edited* sends as voice
few-shot (register only). The bulk campaign engine has the best machinery
(`campaign_send_edits` with a `note`, `campaign_copy_rules`) but it is
bulk-only. There is no "why" capture on any per-contact surface and no
scoreboard anywhere.

## The design

### One engine, every surface

`lib/reply/` — a single module used by all surfaces:

- **`context.ts`** — assemble the full picture for a contact: Supabase
  cluster rows both directions, live sidecar tail (chat.db + Gmail thread;
  reuse `fetchLiveMessages` from `draft-message` and `fetchThread` from
  `lib/relationship-messages.ts`), property details, notes, status,
  temperature, current drip track, follow-up date, last N sent replies by
  Ryan for the same moment (exemplars).
- **`plan.ts`** — `proposePlan(ctx)` → `{ moment, temperature, next_action,
  reason }`. Moments are a closed list per surface (below). Cheap (Haiku),
  runs at intake and on demand.
- **`draft.ts`** — `draftReply(ctx, plan, why?)` → `{ subject?, body }`.
  Sonnet 5 (no `temperature` param, `max_tokens ≥ 4096` — see memory
  note on Sonnet 5 gotchas). Prompt = playbook principles for the moment +
  Ryan's exemplars for the moment (register only, "do not copy lines") +
  the thread + the plan + the why-sentence if this is a redraft. Reply
  channel matches inbound channel (email reads as email, text as text).
- **`critic.ts`** — second pass before the draft is shown: did it re-pitch
  after a no? promise something the plan doesn't include? contradict what
  Ryan already said in this thread? invent a figure? If yes → rewrite once.
- **`record.ts`** — write/update `reply_drafts` (below).

### Moments (closed lists; principles live in the playbook)

Leads: `soft_no`, `hard_no_optout`, `question`, `invitation_to_talk`,
`price_pushback`, `offer_requested`, `info_provided` (they answered our
questions), `silence_breaker` (Ryan initiating after quiet), `junk_wrong_person`.

Relationships: `re_engagement`, `reply_to_them`, `life_event`,
`referral_ask`, `check_in`. (Maps onto the existing type / modality /
familiarity system; those become the plan chips on that card.)

Drips: the drip touch inherits the moment of the last inbound message, and
the playbook says what a touch after that moment may and may not do.

### Playbook — `briefs/REPLY_PLAYBOOK.md` (runtime-read)

One section per moment, 3–5 **principles**, never example sentences
(example phrasings ship verbatim — memory note). Under each moment a
"Pending whys" list that I review. First entry, from today:

> **soft_no** — acknowledge cleanly, no "but", no re-pitch, no reframing
> their answer. Thank them for replying. One door on *their* side. Honest
> notice we'll stay in touch occasionally (this is consent for the drip).
> Name the trigger moment for their situation (tenant leaving, change of
> plans) in one clause. No valuation, no offer. Next action defaults to
> long-term nurture.

Vercel: add to `experimental.outputFileTracingIncludes` like
`CAMPAIGN_VOICE.md` (Next 14.2 gotcha in memory).

### Data — one table, every surface

`reply_drafts`: `id`, `surface` (leads_card | followups | relationships |
drip | telegram), `lead_id` / `relationship_id` / `drip_queue_id`
(nullable each), `channel`, `moment`, `temperature`, `next_action`,
`plan_json`, `draft_subject`, `draft_body`, `model`, `prompt_version`,
`playbook_version`, `why_text` (nullable), `parent_draft_id` (redraft
chain), `sent_subject`, `sent_body`, `sent_at`, `was_edited`, `created_at`.

Rules: every generated draft gets a row. Every send links to the draft it
came from (send routes accept `draft_id`). Redrafts chain to their parent
and carry the why. Relationships keeps writing `relationship_touches`
(voice few-shot depends on it) **and** writes `reply_drafts`. Drip edits
stop overwriting: the edit becomes a `reply_drafts` row with the original
as parent.

`leads.moment` + `leads.moment_at` for the worklist and drips.

### Interface (same on every card)

```
Plan
[ Soft no ▾ ]  [ Cold ▾ ]  [ Long-term nurture ▾ ]   next touch ~Jan 24

Reply                                   Not right   Expand
┌─────────────────────────────────────────┐
│ …draft…                                 │
└─────────────────────────────────────────┘
                    [ Send + start nurture ]
```

- **Plan row.** Three chips, pre-filled. Draft always matches the chips;
  change a chip → regenerate. No extra tap in the common case.
- **Not right.** One line with a mic. Speak a sentence → instant redraft
  with the sentence in context → sentence stored on the draft row.
- **Send executes the plan.** Button text says what it does. Status, drip
  track, follow-up date move together. Existing Apply Drip /
  Long-Term Nurture / status buttons stay for no-reply cases.
- **Edits count silently.** Draft/sent pair stored on send.
- **Off the card:** scoreboard + playbook + pending whys.

### The loop (my job)

`scripts/reply-review.mjs`, weekly (launchd or on demand): sent-untouched
rate per surface × moment; unreviewed whys grouped by moment; candidate
principles when ≥3 rhyme. I bring candidates to Ryan in one sentence each.
Approved → playbook edit → eval re-run → before/after shown → ship.

### Eval

`scripts/reply-eval.mjs`: 20 real past moments (mix across the leads
moments + a few relationships), each with thread + Ryan's approved reply.
Ryan grades once (thumb + optional why, ~20 minutes, delivered as a doc or
a plain list page). Every playbook/prompt change runs the set and prints
old vs new drafts side by side before anything ships.

## Build plan

Ordered by leverage (context + separate drafter first, then the why loop,
then principles), and by surface so nothing is left at one card.

**Phase 0 — Eval set + playbook seed** (1 session, needs Ryan's 20 min)
- Pull 20 real moments from `leads` / `relationship_touches`.
- Ryan grades. Store as `briefs/tests/reply-eval-set.json`.
- Write `REPLY_PLAYBOOK.md` with the soft_no entry and stubs for the rest.

**Phase 1 — Engine + data** (1–2 sessions)
- Migration: `reply_drafts`, `leads.moment`, `leads.moment_at`. Run from
  the main checkout (`scripts/run-migration.mjs`).
- `lib/reply/{context,plan,draft,critic,record}.ts`.
- Routes: `POST /api/reply/plan`, `POST /api/reply/draft` (accepts `why`
  + `parent_draft_id`), and `draft_id` on the four send routes
  (`email-reply`, `[id]/send-email`, `send`, `crms/send`+`crms/log`).
- Intake: `triageEmailLead` emits `moment`; inbound SMS and call transcripts
  get a plan too (SMS currently has no LLM call at all).
- `reply-eval.mjs` runs; must beat the current drafts on the set before
  Phase 2 starts.
- Verify: `tsc --noEmit`, eval report, one real lead end-to-end on prod.

**Phase 2 — Leads surfaces** (1–2 sessions)
- `LeadsTab.tsx`: plan row + draft + Not right + Send-executes-plan in all
  four composers (email, iMessage sub-composer, phone-only, pop-out modal).
- `FollowUpsTab.tsx` ComposeModal: identical.
- `suggested_reply` at intake is produced by the new engine, not triage.
- Verify on prod with a real soft-no and a real question lead.

**Phase 3 — Relationships** (1 session)
- `CRMSTab.tsx`: plan chips replace/absorb intent + familiarity pickers;
  Not right + why; `reply_drafts` written alongside `relationship_touches`.
- `ContactDetailModal.tsx` quick-send gets the same composer (today it has
  no AI at all).
- Verify on prod with one agent contact.

**Phase 4 — Drips** (1 session)
- `drip-engine.js` reads the playbook + the lead's `moment`; a
  `long_term_nurture` touch after `soft_no` may not re-pitch.
- Critic pass on every generated touch before it is queued.
- Drip edit → `reply_drafts` row, original preserved; Regenerate accepts a
  why.
- `regenerate-pending-drips.js` records old/new instead of printing.
- Verify: regenerate pending queue, spot-check the soft_no leads.

**Phase 5 — Telegram** (1 session)
- Lead alerts carry the plan line + draft with `[Send] [Not right]`
  (reuse the campaign `postDraft` pattern). A text reply to a draft is a
  why → redraft posted as v2. Reply-to-alert plain text still sends
  verbatim.

**Phase 6 — The loop** (½ session, then ongoing)
- `reply-review.mjs` + launchd weekly → Telegram summary to Ryan.
- First principle review two weeks after Phase 2 ships.

## Coverage matrix (ship gate — every cell before "done")

| Surface | Plan row | Draft from full thread | Not right + why | Pair stored | Send executes plan | Critic |
|---|---|---|---|---|---|---|
| Leads card — email composer | ☑ P2 | ☑ P2 | ☑ P2 (shared row) | ☑ P2 | ☑ P2 | ☑ P2 |
| Leads card — iMessage sub-composer | ☑ P2 (shared row) | ☑ P2 | ☑ P2 (shared row) | ☑ P2 | ☑ P2 | ☑ P2 |
| Leads card — phone-only composer | ☑ P2 | ☑ P2 | ☑ P2 | ☑ P2 | ☑ P2 | ☑ P2 |
| Leads card — email pop-out | ☑ P2 | ☑ P2 | ☑ P2 | ☑ P2 | ☑ P2 | ☑ P2 |
| Follow Ups compose modal | ☑ P2 (auto on open) | ☑ P2 | ☑ P2 | ☑ P2 | ☑ P2 | ☑ P2 |
| Intake `suggested_reply` (email) | ☑ moment stamped (P1) | ☑ P2: card auto-drafts from the plan on expand (triage text is only the placeholder) | n/a | ☐ | n/a | ☐ |
| Intake — inbound SMS | ☑ plan proposed + moment stamped (P1) | ☐ | n/a | ☐ | n/a | ☐ |
| Intake — call transcript | ☑ moment from analyzer (P1) | ☐ | n/a | ☐ | n/a | ☐ |
| Relationships card | ☑ P3 (intent × familiarity pickers) | ☑ P3 | ☑ P3 | ☑ P3 (`reply_drafts` + `relationship_touches`) | n/a (send = the action) | ☑ P3 |
| Relationships contact modal quick-send | ☑ P3 | ☑ P3 (AI draft) | ☑ P3 | ☑ P3 | n/a | ☑ P3 |
| Drip touch generation | inherits | ☐ | ☐ (Regenerate) | ☐ | n/a | ☐ |
| Drip edit in Follow Ups | n/a | n/a | ☐ | ☐ | n/a | n/a |
| Telegram lead alert | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| Eval set + scoreboard | — | — | — | ☑ eval set + runner (P0/P1); scoreboard P6 | — | — |
| Send routes link to draft (`draftId`) | — | — | — | ☑ email-reply, send-email, leads/send, crms/log (P1) | — | — |

Out of scope: the bulk campaign engine (`campaign-compose.mjs`) keeps its
own edits/rules machinery; unifying it onto `reply_drafts` is a later
decision.

## Decisions (Ryan, 2026-09-24)

1. **Sonnet for every per-contact draft** — yes.
2. **Standalone Apply Drip / Long-Term Nurture buttons** — keep them.
3. **Whys captured on the card first, Telegram in Phase 5** — yes, that order.
