# Sales Coach — execution brief

> **Status: PROPOSED — awaiting Ryan's approval (4 open decisions at bottom). No code or migrations yet.**
> Drafted 2026-09-01 from the DB audit + a full codebase map. Project memo: `../../sales-coach/PROJECT_MEMO.md`.

## Goal

A coaching tool built on Ryan's own seller/agent call data. Three features, priority order:

1. **Pre-call brief** — one screen before dialing: property summary, full cluster history, motivation, objections raised, last verbalized offer, the 2–3 questions that matter, suggested line for the most likely objection. In the lead view + triggerable from phone.
2. **Post-call critique** — per transcribed call: hedging on the number, talked-past closes, missed buying signals, talk ratio, one thing to change. Stored on the call row.
3. **Pattern view** — rolling weekly habits summary; closed-vs-died comparison once outcomes are labeled. Hypotheses, not conclusions (small n).

## What the codebase already gives us

- **Person clusters exist**: `clusterKey()` (`lib/leads.ts:378`) and `fetchClusterHistory()` (`lib/leads.ts:1793`) — the brief builds on these. Gap: `fetchClusterHistory` matches phone *or* email (not union) and drops `ai_notes`/offer/`property_details` — extend it.
- **Claude pattern to copy**: `lib/campaignDraft.ts` / `lib/contactIntake.ts` — Anthropic SDK direct, `ANTHROPIC_API_KEY`, `claude-sonnet-5`, tool-use for structured JSON. (Not the older OpenRouter path.)
- **Phone surface = the Telegram campaign bot** (`app/api/campaign/telegram/route.ts`): add a `brief:` text command beside `copy:` and a Brief inline button on lead alerts; bot imports the lib function directly (no self-HTTP).
- **UI insertion point**: expanded LeadCard in `components/widgets/LeadsTab.tsx`, between the Call button row and `NextTouchPill`.
- **Confirmed gaps**: leads webhooks discard `CallSid`/`Direction`/`DialCallStatus`/`RecordingDuration`; outbound click-to-call gets a `callSid` back and throws it away (`app/api/leads/call/route.ts:140`). The campaign stack (`app/api/campaign/voice/status/route.ts`) already captures duration — prior art.
- **Recordings are single-channel** (`record="record-from-answer"` in both TwiML dials). Twilio's `record-from-answer-dual` gives caller/callee on separate channels → perfect speaker separation for all future calls. The existing 229 need a diarizing pass (verify `channels` via the Recording API first).

## Phasing

**Phase 0 — scaffolding.** Repo `PROJECTS.md`, `PROJECTS/sales-coach/` memo + changelog (done 2026-09-01), this brief.

**Phase 1 — pre-call brief. Zero migrations; read-only on prod.**
- `lib/coach/brief.ts`: full cluster gather (phone∪email, all event types, offers, `property_details`, `ai_notes`, drip history) → one Claude call → `{ propertySummary, historyDigest, motivation, objections[], lastOffer, keyQuestions[2-3], likelyObjection, suggestedLine }`.
- `POST /api/leads/[id]/brief` (auth-gated by middleware automatically).
- LeadCard "Brief" button + panel; Telegram `brief: <name|phone>` command + inline button on lead alerts.
- v1 generates on demand (no cache column). Add cached `brief_json` later if latency annoys.

**Phase 2 — data prerequisites.** Each migration shown as SQL and individually approved before touching prod. New SQL home: `supabase/migrations/YYYY-MM-DD_name.sql`.
1. **Migration A — `call_transcripts`**: `id, lead_id, call_sid, segment_index, speaker (ryan|other|unknown), start_ms, end_ms, text`; index on `lead_id`. `leads.message` untouched as fallback.
2. **Migration B — `lead_status_history`**: `lead_id, field (status|temperature), old_value, new_value, changed_at, changed_by`; trigger on `leads`.
3. **Migration C — call metadata on `leads`**: `call_sid, recording_sid, duration_seconds, direction, disposition, lost_reason`.
4. **Webhook capture**: persist `CallSid`/`Direction` (`voice/route.ts`), `DialCallStatus`+`DialCallDuration` → disposition (`voice/no-answer`), `RecordingSid`/`RecordingDuration` (both recording routes), outbound `callSid` (`call/route.ts`). Flip both TwiML dials to `record-from-answer-dual`.
5. **Backfills**: (a) join Twilio Recordings→Calls (pattern: `scripts/rescue-all-orphan-recordings.mjs`; `RecordingSid` is parseable from `recording_url`) to fill call_sid/duration/direction; (b) re-transcribe the 229 recordings with diarization into `call_transcripts`. Recommended: hosted diarizing API (AssemblyAI or Deepgram, ~11 h audio ≈ a few dollars, one new env key) over Whisper+pyannote. Speaker→"ryan": by channel for dual; cheap Claude pass tags the investor speaker on diarized mono.

**Phase 3 — post-call critique.** Extend `processRecordingBackground` (`lib/leads.ts:1378`): diarized transcript → Claude critique `{ hedges[], missedCloses[], missedBuyingSignals[], talkRatio (computed from segments, not LLM), oneThing }` → `coach_critique` jsonb on the call row. Collapsible block under the call bubble in the Timeline + Telegram push after each call.

**Phase 4 — outcomes + pattern view.** `/coach` page: labeling worklist (every cluster with `offer_amount` set or status dead/active; tap closed-won / lost-price / lost-competitor / ghosted / never-real, plus `deal_value` + close date for wins → writes `lost_reason`/`deal_closed_at`/`deal_value`). Rolling weekly pattern summary aggregating critiques + talk ratios, split by outcome once labels exist, every claim printed with its n.

**Phase 5 (deferred)** — `contacts` table (one row per person). The Phase 2 trigger solves status-history without it.

## Repo organization (incremental, no big-bang)

Findings: ~12 modules in one repo; `lib/` and `scripts/` flat; `lib/leads.ts` (2,642 lines) is the shared kernel imported by ~60 files; migrations split between `supabase/migrations/` (3 files) and loose `scripts/*.sql` (~20); pure-mock demo tabs (stocks, chat, agents, terminal, calendar…) and dead code (`PipelineWidget`, `lib/sheets.ts`, `public/data/*.json`). "Google Ads pipeline" is a mock tab — real Ads code is only attribution constants in the leads pipeline. "OpenClaw integration" is stale path strings in ~10 scripts, not an integration.

1. **`PROJECTS.md` at repo root** — module table: status (live/mock/dead), entry points (pages, API prefix, lib, scripts, launchd), docs link, owning `../PROJECTS/` memo. Rows: leads-pipeline, drip-engine, email-campaign, relationships/CRMS, the-board, physiq, deal-flow, sidecar-proxies, sales-coach, ads-attribution, mock-demo-tabs, dead-code list.
2. **New code born modular**: `lib/coach/` (own README with scope + entry points), `app/api/coach/…` where not natural extensions of `/api/leads`, `scripts/coach/`, `/coach` page.
3. **One migration home going forward**: `supabase/migrations/` (still applied manually with approval). Old `scripts/*.sql` stay; `PROJECTS.md` notes the split.
4. **Existing modules move incrementally**, each an approved step: (a) carve shared kernel from `lib/leads.ts` → `lib/core/` (Supabase client, phone, Twilio, Telegram, Gmail); (b) `lib/campaign*.ts` → `lib/campaign/`; (c) group `scripts/` by module — launchd-referenced engines only move together with their plist updates. Mock tabs + dead code get a separate delete-or-keep list.
5. Tracking stays in the memo system (`PROJECTS/sales-coach/`); this brief is the in-repo artifact.

## Working rules

- Read-only against production until each migration is approved.
- Running changelog: `PROJECTS/sales-coach/CHANGELOG.md`.

## Open decisions (blocking)

1. Approve the phasing (brief first, no migrations; then data layer; then critique; then patterns)?
2. Diarization vendor — hosted (AssemblyAI/Deepgram, new env key, ~$5 one-time) vs local pyannote? And OK to flip TwiML to dual-channel recording (no caller-facing change)?
3. Repo structure as proposed — anything to cut or reorder?
4. Outcome labeling: `/coach` page UI (recommended) vs generated spreadsheet?
