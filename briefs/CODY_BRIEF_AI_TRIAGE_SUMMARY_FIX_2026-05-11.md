# Cody Brief — AI Triage / Summary System Fix

**Date:** 2026-05-11
**Project:** Mission Control (Lead Pipeline)
**Priority:** High — AI cards are showing stale "no recorded contact events" text on leads that actually have full transcripts.

---

## Context — what's broken and why

There are **two parallel AI field paths** in the lead pipeline that don't talk to each other, plus a cache invalidation bug that pins stale text to the card forever.

### Path 1: `ai_notes`
Written directly by `applyAnalyzeCallResult` in `lib/leads.ts` when a call recording is processed via `processRecordingBackground`. This produces a good short summary from the transcript.

### Path 2: `ai_summary`
Written **only** by the `/api/leads/[id]/summary` endpoint, which is hit when Ryan expands a lead card in the UI. It has its own cache check: if `ai_summary_generated_at` is newer than the latest event's `created_at`, it returns the cached value.

### The cache invalidation bug
1. Card is expanded **early** (before the recording is processed).
2. Summary endpoint finds no transcript yet, writes `"no recorded contact events"` into `ai_summary`, stamps a fresh `ai_summary_generated_at`.
3. 30–90 seconds later, recording lands. `processRecordingBackground` correctly updates `ai_notes`, `recommended_followup_date`, `followup_reason`. **It does NOT touch `ai_summary_generated_at`.**
4. Next card expand: cache check sees `ai_summary_generated_at` (recent) > `latestEvent.created_at` (call row's created time — does not change when transcript arrives). Stale cache served forever.

### The name / property address extraction gap
`analyzeCallTranscript` extracts `name` and `property_address` from the transcript. `applyAnalyzeCallResult` has a (correct) hands-off rule: don't overwrite fields that are already set.

The bug: when the only fresh Whisper transcript is a brief follow-up voicemail (e.g., "I'm busy, call me back"), the name/address prompt may only be looking at the **fresh transcript** rather than the **full cluster conversation history** that `analyzeCallTranscript` already assembles internally.

### Concrete failure case
Lead at **+14082988610 (Luz)**:
- Row 1 (21:48): long conversation, no recording attached.
- Row 2 (21:55): follow-up call, she didn't answer, left brief voicemail. Recording exists here.
- `analyzeCallTranscript` ran on row 2's recording. Followup date and reason were set correctly (from conversation history context). But `ai_summary` shows `"no recorded contact events"` on the card. Name is still null despite being clearly stated earlier in the cluster.

---

## Investigation checklist (do this before touching anything)

- [ ] Read `PROJECTS/mission-control/lib/leads.ts`. Locate and fully read:
  - [ ] `processRecordingBackground` — what does it call, what does it write, in what order?
  - [ ] `analyzeCallTranscript` — how is the cluster history assembled? What does the prompt to Haiku look like? Does the name/property extraction draw from the full history or just the fresh transcript?
  - [ ] `applyAnalyzeCallResult` — exactly which fields does it write, which row does it write to, what is the hands-off rule?
- [ ] Read `PROJECTS/mission-control/app/api/leads/[id]/summary/route.ts` end-to-end. Map the cache check logic exactly: which timestamps are compared, what's the regen path, what does it write back.
- [ ] Read `PROJECTS/mission-control/app/api/leads/[id]/analyze-call/route.ts`. How does manual re-analysis differ from the background path? Does it touch `ai_summary` or only `ai_notes`?
- [ ] Identify the "anchor row" concept used by the summary endpoint — which row in the phone cluster is treated as canonical for `ai_summary` storage?
- [ ] Confirm the column names: `ai_notes`, `ai_summary`, `ai_summary_generated_at`, `caller_phone`, `recommended_followup_date`, `followup_reason`. Is there already a `recording_processed_at` or similar column? Check the migrations / schema.

Once you have a clear mental model of all three files and the data flow, proceed.

---

## Fix 1 — Cache invalidation after recording processing (MOST IMPORTANT)

After `applyAnalyzeCallResult` writes its fields, invalidate the `ai_summary` cache across the **entire phone cluster** so the next card expand regenerates a fresh summary that includes the transcript.

Three implementation options — read the code and pick the cleanest:

- **Option A (recommended starting point):** In `applyAnalyzeCallResult` (or at the tail of `processRecordingBackground`), after writing to the target row, issue a second UPDATE that sets `ai_summary_generated_at = NULL` on ALL rows sharing the same `caller_phone`. The summary endpoint already handles the null case by regenerating — this is the safest trigger.
- **Option B:** Write the new analysis directly into `ai_summary` on the cluster's anchor row in addition to `ai_notes`. Bypasses the endpoint entirely for post-recording updates. Risk: duplicates summary-generation logic.
- **Option C:** Add a `recording_processed_at` column and include it in the summary endpoint's cache freshness comparison. Requires a migration; more invasive.

**Critical requirement:** after a recording is processed, the card must show fresh AI content on the **next expand**, not stale "no events" text.

**Watch out:** The summary endpoint runs client-driven on card expand. The invalidation must work across the async gap between server-side recording processing (Mac mini / Vercel) and client-side expand (browser). A null `ai_summary_generated_at` is the safest signal because the endpoint already treats no-cache as regen.

---

## Fix 2 — Name and property address extraction from full conversation history

`analyzeCallTranscript` already builds a full cluster transcript before calling Haiku. The name / property_address extraction should draw from **that full history**, not just the most recent recording's transcript.

Things to verify in the code:

- [ ] Does the Haiku prompt instruct extraction from the full conversation history, or only from the fresh transcript text? If only the fresh transcript, wire the full cluster history into that prompt section.
- [ ] Confirm `applyAnalyzeCallResult`'s hands-off rule does NOT block writing `name`/`property_address` when the target row's value is null. Outbound call rows commonly have null name fields — the write should proceed.
- [ ] Test the path where the most recent recording is a brief voicemail but an earlier row in the cluster carries the full conversation transcript in its `message` field. The extraction must still work.

The infrastructure (cluster history assembly) already exists. This is likely a one-prompt-section change plus a write-path audit, not new plumbing.

---

## Fix 3 — `ai_summary` written by `applyAnalyzeCallResult` (OPTIONAL, only if clean)

Currently `ai_notes` (short one-liner) is written by `applyAnalyzeCallResult` and `ai_summary` (multi-event paragraph) is only written by the summary endpoint. That split is the root of the silo.

Evaluate: after recording analysis, should `applyAnalyzeCallResult` also write a fresh `ai_summary` directly to the cluster's anchor row? This eliminates the dependency on card-expand to refresh the summary.

**Only do this if:**
- It does not duplicate the summary-generation logic that lives in the endpoint.
- It does not require significant refactoring.

Otherwise skip it. Fix 1's cache invalidation handles the user-visible problem.

---

## Watch out

- **Race conditions:** Recording processing is async. If the card is expanded *during* `applyAnalyzeCallResult`, the cache invalidation must land after the analysis writes, not before. Order matters — invalidate as the **last** step.
- **Phone cluster scope:** Don't invalidate by `lead_id` — invalidate by `caller_phone` across the cluster, because the anchor row used by the summary endpoint may not be the same row the recording was attached to.
- **Hands-off rule asymmetry:** Verify the rule treats `null` and empty-string differently if needed. An outbound row might have `name = ""` rather than `name = NULL`. Both should be writable.
- **`latestEvent.created_at` semantics:** Confirm whether this is the call row's creation time or something that updates when the transcript arrives. The bug write-up assumes the former — verify in code.
- **Migration risk (Option C only):** If you pick Option C, the migration must ship before the code that reads/writes the new column. Prefer Option A unless you find a reason it won't work.

---

## Wrap-up checklist

- [ ] `cd PROJECTS/mission-control && npx tsc --noEmit` — zero errors.
- [ ] `npx vercel deploy --prod` from `PROJECTS/mission-control/`.
- [ ] Update `PROJECTS/lead-pipeline/PROJECT_MEMO.md` with a dated note describing what shipped and which option (A/B/C) was chosen for Fix 1.
- [ ] **Luz's lead (+14082988610):** after deploy, manually trigger a summary regen by either:
  - `POST /api/leads/<anchor-row-id>/summary`, or
  - Having Ryan hit the refresh icon on her card.
- [ ] **Do NOT backfill other leads.** Forward-only — existing stale caches stay stale until those cards are touched.

---

## Files in scope

- `PROJECTS/mission-control/lib/leads.ts`
- `PROJECTS/mission-control/app/api/leads/[id]/summary/route.ts`
- `PROJECTS/mission-control/app/api/leads/[id]/analyze-call/route.ts`
- `PROJECTS/lead-pipeline/PROJECT_MEMO.md` (wrap-up note only)
