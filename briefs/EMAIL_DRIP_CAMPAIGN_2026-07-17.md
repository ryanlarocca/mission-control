# Execution brief — 12-month email drip + master DNC

> **Date:** 2026-07-17 · **Status:** BUILT + LIVE (same day) — batch 1 of
> 200 drafts awaiting Ryan's review at /email-campaign. See BUILD STATE.

## BUILD STATE (end of 2026-07-17 build session)

**Shipped & verified live** (commits `62d895e` → `4fb128c` → `67ccf12` → agents-line webhooks):
- Master DNC `suppression` (68 rows / 5 sources) + DB-trigger write-through
  (verified both directions) + vendor export refactor.
- `campaign_contacts` 2,392 imported (2,348 active) + `campaign_sends` +
  `campaign_events`. Import idempotent, re-run = no-op.
- Engine (`scripts/campaign-engine.mjs`) on launchd every 20 min
  (`com.lrghomes.campaign-engine`): draft pass (200/day cap, suppression
  re-check) + send pass (Gmail as info@, 9:00–16:30 PT, 200/day, jitter,
  send-time re-checks). Verified: real Gmail send end-to-end (redirected).
- `/email-campaign` UI (Review queue + Contacts w/ timeline) deployed.
  **Batch 1 = 200 T1 drafts waiting for review.** Everything approval-gated.
- info@ inbox pipeline: bounce parse (VERIFIED with a real send→bounce
  round-trip in prod: hard bounce → contact bounced + sends cancelled +
  Telegram), reply → drip pause + Telegram alert, "remove"-style reply →
  auto-suppression. Privacy: non-campaign mail skipped before content.
  info@ watch registered (label AGENT-DRIP, daily renewal covers it).
- Agents line (650) 910-4007 webhooks live: call relay to cell (caller ID =
  the line, Telegram ring alert, no whisper, no live-call recording),
  voicemail record + Telegram link, SMS → event + Telegram + STOP handling.

**Blocked on Ryan (before batch 1 can send):**
- [ ] `CAMPAIGN_POSTAL_ADDRESS` in mission-control `.env.local` (CAN-SPAM
  postal address — send pass hard-refuses without it).
- [ ] Review/approve drafts at /email-campaign (start small ~50 per plan).
- [ ] Kelly Ray is the one active-lead flag in the import.

**Still to build (next session):**
- AI-drafted replies + interactive Telegram loop (dictate-summary →
  compose → approve buttons) — replies currently alert w/ manual reply.
- Voicemail Whisper transcription (URLs stored for retro-transcribe).
- Unsubscribe confirmation email (currently: suppress + stop, no confirm).
- Phase 6 dashboard (queue header shows core counts meanwhile).
- Unknown-caller name matching (Twilio Lookup / AI transcript match).
- Touch 10 copy (engine enforces the placeholder refusal).
> **Owner project:** lead-pipeline (this is effectively Phase 7.5 stale-lead
> re-engagement, email edition — confirm routing at first wrap)
> **Driver:** Ryan wants a 12-month auto email drip to a ~2,000-contact
> opted-in database, with bounce removal, AI-drafted replies, and a
> unified master DNC list across all outreach systems.

## Locked decisions (from Ryan, 2026-07-17)

1. **Platform: Gmail** (Workspace + existing service account / DWD), not an
   ESP. ~2,000 contacts, ~200 sends/day max, spaced as makes sense.
   Plain-text, Ryan-voice 1:1 emails.
2. **List is opted-in** — all past contacts. Ryan supplies raw data.
3. **Relationships-tab overlap does NOT exclude anyone** from the drip.
   Being in the BoB is fine; they still get the campaign. (Master-DNC
   matches are still excluded — that's the only hard suppression.)
4. **Approval gate on EVERYTHING at first.** No auto-sends for the entire
   first pass of the 2,000. After the first batch proves out, autonomy is
   loosened *little by little* (per-touch config, Ryan flips each switch).
   Context: a prior OpenClaw campaign of this shape mostly worked but had
   hiccups; the gate is the insurance while trust builds.
5. **Telegram notification on every reply.** Non-negotiable, from day one.
6. **Sending mailbox: `info@lrghomes.com`** (Ryan, 2026-07-17). Reply/bounce
   ingest must filter to campaign-contact matches + DSN messages only — the
   watch will see Ryan's regular business mail on this address too.
7. **UI mockup before code.** Ryan reviews a rendered mockup of the approval
   workspace before the Phase 3 UI is built. First version published
   2026-07-17: https://claude.ai/code/artifact/0182c666-14de-44b2-84fc-6209d45eb9cc
   — shows manual send-all, line items (address + message summary, expand
   for full text), flagged rows, replies tab, Telegram loop.
8. **Reply loop is Telegram-first** (Ryan's design): alert on reply → bot
   asks how he wants to respond → Ryan dictates a summary in his own words
   → AI composes the email from that summary → approve/revise via inline
   Telegram buttons → sends in-thread via Gmail. The Mission Control reply
   queue shows the same items for batch days / fallback. Builds on the
   existing `app/api/telegram/webhook/route.ts` (has update_id dedup).
9. **No pre-existing manual DNC file** — the master list backfills from the
   three system silos only; Ryan adds people ad hoc from then on.
10. **DNC entries carry channel scope** (`mail | email | sms | call | all`)
    + audience context (seller / agent / …) — ONE table, not separate lists.
    See Phase 1.

## Open inputs (needed before the relevant phase — none block Phase 1)

- [ ] **Raw contact data** from Ryan (CSV/sheet — whatever shape it's in).
      Promised "soon."
- [ ] **Touch cadence + content angle** — what the ~10–12 touches across 12
      months actually say (market updates / thinking-of-selling check-ins /
      value touches). Ryan decides; AI drafts within that frame. Ryan wants
      a dedicated conversation on this.
- [ ] **Mockup sign-off** — Ryan approves (or iterates) the published
      approval-workspace mockup before Phase 3 UI code.

## Existing infrastructure this reuses (do not rebuild)

| Piece | Where | Reused for |
|---|---|---|
| Gmail service account + DWD (`gmail.modify`) | sidecar / lead-pipeline | Sending + reading the campaign mailbox |
| Gmail watch → Pub/Sub → ingest | `app/api/leads/email/route.ts` + `config/email-campaigns.json` | Reply + bounce intake |
| Drip engine patterns (cadence, safety checks, `--now`, approval queue) | `drip-engine.js` + lead pipeline | Model for the email drip engine (likely a sibling engine, not a fork of lead cadence) |
| AI triage + `suggested_reply` Ryan-voice drafting | `lib/leads.ts` Haiku passes | Reply triage + draft generation |
| Telegram alerts | `sendTelegramAlert` (`lib/leads.ts`) | Reply notifications |
| DNC state (to be unified) | `leads.is_dnc` · `dnc_list` table · `relationships.status='do_not_contact'` | Backfill sources for master suppression |
| DNC vendor export | `app/api/dnc/export/route.ts` | Re-pointed at the master table |
| Supabase migrations | `scripts/run-migration.mjs` | All new tables |

---

## Phase 0 — Pre-flight (one sitting)

- Verify SPF / DKIM / DMARC on `lrghomes.com` (dig + a live test send).
  A bad record here tanks the whole domain including real business mail —
  hard gate before any campaign send.
- Create/confirm the dedicated sending mailbox; register its Gmail watch.
- Confirm every campaign email template carries an opt-out line + physical
  address (CAN-SPAM).

## Phase 1 — Master DNC (build first; useful even if the campaign never ships)

**New Supabase table `suppression`:**
`id, email (citext, nullable), phone (E.164-ish, nullable), name,
address fields (parcel/site/mail — superset of dnc_list), reason, source
(ryan_manual | email_unsubscribe | sms_optout | lead_dnc | relationship_dnc |
bounce_hard | vendor), source_ref (lead id etc.),
channel (mail | email | sms | call | all — what they opted out OF),
audience (seller | agent | vendor | personal | unknown — who they are),
created_at`.
Match rule: a contact is suppressed for a given send when **email OR phone**
matches AND (`channel = all` OR channel matches the send's channel).

**Design decision (2026-07-17): ONE table, scoped — not separate seller vs.
agent lists.** Separate lists recreate the silo problem this phase exists to
kill. Instead every entry records *who* (audience) and *what they opted out
of* (channel). Defaults: an explicit "remove me" / angry opt-out → `all`
(safe default); a soft channel-specific ask ("stop mailing letters") →
that channel only, Ryan's judgment. Views/filters give the "seller DNC"
and "agent DNC" slices on demand; the vendor CSV export filters
`channel IN (mail, all)`.

- **Backfill migration** — ✅ SHIPPED 2026-07-17: leads.is_dnc (29 rows) +
  dnc_list (19 rows) → suppression, channel=all, audience=seller.
  **Deviation from plan:** relationships do_not_contact (607 rows) is NOT
  backfilled — verified live that 100% are cleanup_verdict='never' rotation
  removals (Ryan's one-sided triage, incl. two false-positive-scanned
  vendors), zero genuine opt-outs; suppressing them would contradict the
  locked "BoB status never blocks the drip" rule. Write-through is DB
  **triggers** (scripts/2026-07-17-suppression-triggers.sql) on
  leads.is_dnc + dnc_list insert/delete — catches all 4+ code sites and
  any future ones; un-DNC removes the row. Verified live both directions.
- **Ad-hoc add path** for Ryan (no pre-existing manual file exists) — a
  simple add-to-DNC action usable from Telegram + Mission Control.
- **Write-through:** the existing DNC actions (lead DNC button/route,
  texted opt-out auto-DNC, relationships remove) also insert into
  suppression — the old flags stay (UI reads them) but suppression becomes
  the authoritative union.
- **Check-through:** new `lib/suppression.ts` helper `isSuppressed({email,
  phone})`; wired into (a) the new email drip send path, (b) the lead drip
  engine's eligibility query, (c) relationships queue build. (b)+(c) are
  belt-and-suspenders — their own flags already filter — but this catches
  cross-silo cases (e.g. a lead DNC who also exists as a relationship).
- **Export refactor:** `/api/dnc/export` reads suppression instead of its
  two-source union. Same CSV columns, same vendor workflow.

**Verify:** backfill counts vs. silo counts; a known-DNC contact is
rejected by all three send paths; vendor CSV diff ≈ old export + manual list.

## Phase 2 — Contact import & hygiene

**New table `campaign_contacts`:**
`id, name, email, phone, address/property fields (whatever the raw data
has), source_note, status (active | paused | replied | bounced |
unsubscribed | suppressed | bad_email), touch_number, next_touch_at,
last_sent_at, gmail_thread_id, created_at` (+ raw import blob for anything
that doesn't map).

Import script pipeline (dry-run mode first, report before write):
1. Parse raw data → normalize email/phone.
2. Dedupe within the list + against existing campaign_contacts.
3. **Suppression scrub** — matches imported as `status=suppressed`, never
   `active` (kept as rows so the count is auditable, never sent).
4. Cross-reference `leads` — someone in an *active* lead conversation gets
   flagged in the import report for Ryan's judgment call (not auto-excluded).
   Relationships overlap: noted in the report, **included** per decision 3.
5. Email validation: syntax + MX lookup on domain. Failures → `bad_email`
   before we ever burn sender reputation on them.
6. Output: import report (counts by bucket + the flagged list) → Ryan
   eyeballs → confirm → commit write.

## Phase 3 — Drip engine + approval queue (the core)

**New table `campaign_sends`:**
`id, contact_id, touch_number, subject, body, status (draft |
approved | sent | skipped | failed), scheduled_for, sent_at,
gmail_message_id, gmail_thread_id, approved_at, edited (bool)`.

- **Engine** (launchd on the Mac mini, like drip-engine.js): daily pass
  finds due contacts (`next_touch_at <= now`, status active, not
  suppressed — live re-check at send time, not just import time), drafts
  the touch (template + AI personalization from contact fields), writes
  `campaign_sends` rows as `draft`.
- **Approval queue UI** (new Mission Control view): batch review —
  paginated list of drafts with inline edit, per-row approve/skip, and
  select-all-approve for a reviewed page. Designed for "review 200 in
  minutes," not one-by-one modals. Edited drafts flag `edited` (future
  voice-learning signal, same pattern as Relationships).
- **Sender** (engine second pass or on-approve): sends `approved` rows via
  Gmail API from the campaign mailbox — daily cap (default 200),
  randomized minute-level jitter inside a business-hours window, stamps
  gmail ids, advances `touch_number` + `next_touch_at`.
- **Training wheels config:** per-touch `auto_send` boolean, all `false`
  at launch. Ryan flips them one touch at a time after the first pass of
  2,000 proves clean. Safety checks (suppression, bounced, replied,
  unsubscribed, daily cap) are NOT bypassable — they run even at full auto.
- **Stop-on-reply:** a contact with `status=replied` gets no further
  automated touches until Ryan re-activates (post-conversation) —
  mirrors the lead pipeline's conversation hold.

**Cadence (placeholder until Ryan locks content):** touches at day 0, 14,
30, then every ~35–40 days → ~11 touches / 12 months. 2,000 contacts on
that spread ≈ 60–120 sends/day steady-state after an initial ramp batch.

## Phase 4 — Bounce handling

Extend the mailbox ingest (Pub/Sub path already watches the campaign
mailbox): detect mailer-daemon / delivery-status messages, parse the
failed recipient + DSN code.
- **Hard bounce** (5.x.x) → contact `status=bounced`, drip stops, logged.
  NOT auto-added to suppression (bounce ≠ do-not-contact a *person*;
  phone outreach may still be fine) — recorded on the contact instead.
- **Soft bounce** (4.x.x) → retry at next touch; 2 consecutive softs →
  treat as hard.
- Bounce events land in the dashboard; a spike alerts via Telegram.

## Phase 5 — Reply handling + Telegram

**info@ shared-mailbox rules (locked 2026-07-17):**
- **Match by thread first, sender second.** Every campaign send stamps its
  `gmail_thread_id`; any inbound on a known campaign thread is a campaign
  reply even if it arrives from a different address than we mailed (people
  reply from new/forwarded addresses). Fallback: sender email matches a
  campaign contact. DSNs match by failed-recipient/original-message-id.
- **Non-matches are dropped BEFORE any AI call or logging** — Ryan's
  regular business mail on info@ never enters campaign logs, prompts, or
  Supabase. Silent skip, by design.
- **info@ must NOT route into the lead-pipeline ingest.** The Pub/Sub
  handler needs per-mailbox routing: info@ → campaign pipeline only, never
  `ingestEmail`-as-lead. (Watch config today only knows lead campaigns.)
- **"Not a campaign reply" escape hatch:** a campaign contact may email
  about something unrelated. The Telegram alert + MC card carry an Ignore
  action that un-pauses the drip and marks the message handled-outside.
- **Ryan's own manual replies count.** If Ryan answers from his phone
  directly, the watcher sees the outbound on the campaign thread
  (`isOwnAddress` pattern), marks the reply handled, and cancels the
  pending AI draft — no double-reply.
- **Accepted tradeoff:** campaign sends share reputation with Ryan's
  primary address. Low risk at 2k opted-in plain-text scale; revisit
  (dedicated mailbox) only if spam-complaint signals appear.

On inbound to `info@lrghomes.com` from a campaign contact (non-campaign
mail on info@ is ignored by this pipeline):
1. **Telegram alert immediately, every reply** (decision 5) — name, their
   text, triage tag — with inline buttons per decision 8:
   `[I'll summarize] [Draft for me] [DNC]`. Ryan's next message (voice
   dictation → text) is treated as his response summary; AI composes the
   email from it; bot returns the draft with `[Send] [Revise] [Open in MC]`.
   Send goes out in-thread via Gmail. Conversation state (which contact a
   given Ryan message answers) keyed per-chat with a pending-reply pointer +
   timeout; ambiguous states fall back to "tap the contact you mean."
2. Haiku triage: `interested | question | not_now | remove_me | auto_reply`.
   - `remove_me` → **auto-add to suppression** (source=email_unsubscribe) +
     contact `unsubscribed` + confirmation draft queued.
   - `auto_reply`/OOO → no action, drip continues.
   - Others → contact `status=replied` (drip pauses) + Ryan-voice draft
     queued **approval-gated** (replies stay gated even after send-side
     training wheels come off, until Ryan says otherwise).
3. Reply queue lives in the same Mission Control view as the approval
   queue (one campaign workspace).
4. `interested` contacts get a one-tap **promote to Leads** (existing
   machinery), which retires them from the campaign.
5. **Add to Relationships (one-tap, no screenshot).** Audience is agents, so
   the natural graduation is the BoB, not Leads. Reply cards in MC + a
   Telegram inline button (`➕ Relationships`) POST the contact's structured
   data straight to `/api/relationships` — the same endpoint + dedupe-GET
   the MC_RELATIONSHIPS OpenClaw skill uses (screenshot flow stays for
   ad-hoc adds; campaign contacts skip the vision step since we hold their
   data). Category=Agent, tier prompt (default C), notes prefilled with
   campaign context ("replied to T4, interested in East Side duplexes").
   **Adding to Relationships NEVER removes anyone from the drip — everyone
   stays on the drip, no hand-off, no option prompt** (Ryan, 2026-07-17:
   "plain and simple"). Only suppression/unsubscribe/bounce stop the drip.

## Phase 5b — Agent-line call/text tracking (designed 2026-07-17)

**Data model:** new `campaign_events` table — `id, contact_id (nullable
until matched), kind (email_reply | sms_in | sms_out | call_answered |
call_missed | voicemail | note), caller_number, body/transcript, duration,
ai_summary, triage, occurred_at, handled_at`. Every engagement event, one
timeline per contact.

**Answered call:** NO whisper (Ryan, 2026-07-17). Relay exactly like the
lead line: the call forwards to Ryan's cell **showing the agents-line
Twilio number as caller ID** — Ryan saves that number as a phone contact
("Agents Line") so every relayed call self-identifies on screen. Context
arrives via **Telegram alert on ring** (caller name when matched), same as
the leads pipeline. Live calls are **metadata-only — no recording** (CA
two-party consent; keep this line clean). After hangup the status webhook
logs the event; Telegram follow-up:
"Talked to Maria Delgado (after T3, 6 min) — [🎙 dictate note] [➕
Relationships] [nothing to do]". A dictated note lands on the contact
timeline.

**Missed call → voicemail:** greeting in Ryan's voice → recording → Whisper
→ Haiku summary → Telegram alert with transcript + [Call back] [Text back
(AI draft)] [➕ Relationships] [Ignore]. Voicemail recording is fine
(inherently consented).

**Unknown caller matching:** agents will call from cells we don't have on
file. Match order: (1) caller number vs. campaign_contacts + relationships;
(2) Twilio Lookup caller-name; (3) AI name-match from the voicemail
transcript ("it's Maria from Compass" → fuzzy match → Telegram "Looks like
Maria Delgado — confirm?"). A confirmed match **writes the number back to
the contact** (every call enriches the database). Unmatched events sit in
the Engagement queue for manual link-or-dismiss.

**Engagement pause:** an answered call or voicemail (like an email reply)
sets the contact to `replied` — drip pauses until Ryan resumes (button on
the Telegram follow-up + contact card). Distinct from the Relationships
rule: BoB membership never affects the drip; *live engagement* always does.

**UI:** the campaign workspace grows to three tabs —
1. **Review queue** (as mocked).
2. **Engagement** (evolution of the mocked Replies tab): email replies,
   texts, voicemails, missed calls, answered-call logs — one unified queue,
   each with triage badge + AI draft where applicable.
3. **Contacts**: searchable list of the 2,000 → per-contact timeline
   (touches sent, every campaign_event, notes) + actions (pause/resume,
   ➕ Relationships, DNC). This is "what UI tracks them."
Dashboard (Phase 6) rolls up: calls + texts + replies by touch = true
attribution (which email made the phone ring).

**Add-to-Relationships from a call:** same one-tap as replies — the
Telegram [➕ Relationships] button or the contact card. Payload includes the
newly-learned cell number + call context in notes ("called agent line Jul
20 after T2 re: duplex listing"). Same `/api/relationships` endpoint +
dedupe as the MC_RELATIONSHIPS skill.

## Phase 6 — Dashboard

Campaign view in Mission Control (modeled on Campaign Performance):
sends to date + by touch, reply rate per touch, bounce rate, unsubscribes,
suppression count, due-next forecast, and entry points to the approval +
reply queues. Ships last; counts accrue from Phase 3 via campaign_sends.

---

## Build order & verification

Each phase ships independently: **0 → 1 → 2 → 3 → 4 → 5 → 6.**

**Quality bar (Ryan, 2026-07-17: "minimal bugs this time"):** every
Gmail-touching feature is verified against **real raw messages, never
synthetic fixtures** — the July 3 GV outage happened because tests used
synthetic bodies that didn't match real Gmail structure. Concretely: bounce
parser tested on a real bounce (send to a fake address on purpose); reply
triage tested on real replies from Ryan-owned accounts; import run in
dry-run against the actual raw data file before any write; engine has a
`--dry-run` that prints would-send without sending. Failure modes alert
(Telegram), never silently skip — the "silent failure" class is the one
that has bitten this codebase repeatedly.
Phase-3 verification includes a live end-to-end test batch to Ryan-owned
addresses (send, bounce a fake address, reply from another account →
Telegram + draft) before the first real batch. First real batch is small
(~50) and reviewed together before opening the taps to 200/day.

## Content — 11-touch sequence (v1 draft, 2026-07-17)

**Audience:** ~2,000 Bay Area residential real-estate agents Ryan has
contacted before. **Goal:** own the mental slot "the buyer I call for
rough/stuck/small-multifamily deals." **Voice:** 2-short-paragraph personal
note from a working investor. Plain text, one idea per email, no
newsletter formatting, no "hope this finds you well."

**Locked buy box (Ryan, 2026-07-17):** single-family homes AND 2–15 unit
multifamily · Bay Area, **copy leans South Bay** (San Jose / Sunnyvale /
Santa Clara — where the closes are; box stays Bay-wide) · under $4M
("very comfortable") · as-is · fast close. **Proof closes (use lightly, ONE
email only — Ryan's call, volume has been lighter lately):** 674 Kirkland
Ave, Sunnyvale (6-unit) · 93 Ridgeview Ave, San Jose · 1958 Limewood Dr,
San Jose.

**Per-contact AI personalization:** greeting by name; farm-area line when
the data has it; later touches may reference earlier thread. Template is
the skeleton; AI fills, Ryan approves (per decision 4).

| # | Day | Angle | Draft copy (subject / body sketch) |
|---|-----|-------|------------------------------------|
| 1 | 0 | Reintro + buy box | *"buying again in the South Bay — quick reintro"* — Ryan LaRocca, LRG Homes; we've crossed paths before. I buy single-family and 2–15 unit multifamily — South Bay is home turf (San Jose, Sunnyvale, Santa Clara) but I'll go anywhere in the Bay under $4M. As-is, fast close. If you have a listing that fits — especially one that's rough or stuck — I'd love a look. Reply or text me at (650) 910-4007. |
| 2 | 14 | Why agents send me deals | Certainty pitch: proof of funds with every offer, no repair negotiations, no financing drama, you're welcome to both sides on your own listing, and I'm a repeat buyer — one relationship, multiple closings. |
| 3 | 35 | Proof of real | The one credentials email: Kirkland (6 units), Ridgeview, Limewood — different stories, same pattern: as-is, quick, done. "Not chasing volume, just the right ones." |
| 4 | 70 | Send me your headaches | Hoarder condition, tenants blocking showings, unpermitted additions, code violations, the listing that's been sitting — those are my favorite deals. |
| 5 | 105 | Fell out of escrow | Before you relist: text me, real number in 24 hours, seller skips the back-on-market stigma. |
| 6 | 140 | Buy-box refresher, SFH-forward | "What I'm hunting right now" — most of your work is single-family; I buy those too, not just units. Restate box in fresh words. |
| 7 | 175 | Mid-year human check-in | No pitch. How's your year? Anything sitting on your desk you're not sure what to do with, happy to be a second opinion — even if I'm not the buyer. |
| 8 | 210 | Off-market / pre-MLS | Coming-soons, sellers who won't do showings, pocket listings: I'll offer before it hits the MLS; you keep full commission, skip the prep. |
| 9 | 245 | Probate / trust / estate | The messy-paperwork deals — probate, trusts, estates, divorce. I've closed them, I'm patient with timelines, and the condition never scares me. |
| 10 | 285 | Market observation | PLACEHOLDER — drafted fresh at send time from Ryan's actual deal-flow observations (stale market commentary is worse than none). |
| 11 | 330 | Year-end thanks | Thanks, brief "still buying in the new year," warm close. Highest reply-rate slot — keep it genuinely pitch-free. |

**Content flags — resolved 2026-07-17:**
- ✅ Ridgeview close = **93 Ridgeview Ave, San Jose**.
- ✅ **Commission-framed only** — no referral-fee mentions.
- ✅ Copy **leans South Bay** ("I buy all over the Bay, but the South Bay
  is home turf") while keeping the Bay-wide box.
- ✅ **CTA phone number = NEW dedicated Twilio number** (Ryan, 2026-07-17:
  "cleaner and we can track everything"). Personal cell rejected (no
  personal number in mass marketing); GV rejected (fragile email-forward
  parsing — the Jun–Jul silent-outage path). Build notes:
  - ✅ **PROVISIONED 2026-07-17: +1 (650) 910-4007** (sid
    `PNfbb74d5e86d16ad136ba822a1153f592`, friendly name "Agents Line
    (email campaign)"). First pick +16502490532 showed **Spam Likely** on
    Ryan's cell → released same day, replaced with this one (pending
    Ryan's caller-ID verdict, call `CA31807291b3147e45712f7237276006fd`).
    Attached to the VERIFIED A2P messaging service
    `MG70a9310fb28d0aa7926e87a5e3941c2b` (same campaign as the lead line).
    Safe because: lead sends pin an explicit `From` (`TWILIO_MESSAGING_
    SERVICE_SID` is unset everywhere — ⚠ if anyone ever sets it, lead
    texts would pool-pick a sender; pin From+ServiceSid together first),
    and the service has `use_inbound_webhook_on_number: true` so each
    number routes its own inbound. Voice + SMS webhooks NOT yet configured
    (Phase 5b). The other messaging service (`MGf8fa…`) has a FAILED A2P
    campaign — dead weight, do not use.
  - Spam-label posture (Ryan, 2026-07-17 — NO registry sign-ups): verify
    empirically. Test-call Ryan's cell (+14085006293) from the number; if
    caller ID shows "Spam Likely" → release the number, buy another,
    re-test until clean. Attempt 1 (+16502490532): SPAM → released.
    Attempt 2 (+16509104007): ✅ **verified clean twice on Ryan's cell
    2026-07-17 — FINAL. This is the number in every email.** Ryan to save
    it in his phone as "Agents Line" for caller ID on relayed calls.
    Line is inbound-first so ongoing label risk is low; outbound texts
    ride the verified A2P campaign. Once a clean number goes into the
    email batches it's effectively permanent (printed in every sent
    email).
  - New webhook routes for this number → **campaign reply pipeline** (agent
    identified by line, matched to campaign_contacts by caller number;
    Telegram alert + AI draft, same loop as email replies). Never touches
    lead ingest.
  - Voice: forward calls to Ryan's cell; voicemail → existing
    Whisper-transcribe pattern → Telegram alert tagged as campaign.
  - Outbound replies (Ryan-approved texts) send from this same number via
    the sendLeadSms transport pattern (own module — keep campaign + lead
    send paths separate).
  - Number goes in every email signature/CTA once provisioned.

## Explicitly out of scope

- Open/click tracking (Gmail can't; pixels hurt deliverability anyway).
  Reply + bounce + unsubscribe rates are the metrics.
- HTML-designed newsletters — plain-text only.
- Any change to lead-pipeline cadence logic beyond the suppression check.
