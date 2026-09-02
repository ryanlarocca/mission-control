# Brief — Triage eval: 20-lead sample + self-measuring accuracy

**Status:** idea, not started · **Captured:** 2026-07-18
**Owning project:** lead-pipeline (Leads tab)

## Goal

Measure how often the AI lead triage (temperature / summary / follow-up
recommendation) is actually right, instead of assuming it. Move from
"I've built AI systems" to "I know how well they work."

## Background (what exists today)

Triage writes to the `leads` table in Supabase:
`temperature` (hot/warm/cold), `ai_summary`, `ai_summary_generated_at`,
`recommended_followup_date`, `followup_reason`. The raw material it judged
from is on the same row (`message` = transcript or email body).
Call/voicemail path and email path both run Haiku via OpenRouter —
see `lib/leads.ts` (`TEMPERATURE_RUBRIC` ~line 232, `triageEmailLead`
~line 2497, apply logic ~line 2284).

Manual re-triage currently **overwrites** the AI's answer — the
disagreement signal evaporates. That's the key thing to fix.

## Plan

### Phase 1 — one-time manual sample (calibrate)
1. Script (same shape as `scripts/seed-gym-tracker.mjs`): pull 20 random
   leads with `ai_summary_generated_at` in the last 30 days. Select
   transcript/email + AI temperature + summary + follow-up rec.
2. Render a scoring sheet (markdown or simple page): per lead — what the
   AI read, what it concluded, three checkboxes: temperature right?
   summary accurate? follow-up sensible? (~25 min of Ryan's time per round.)
3. Record: date, sample size, % agreement per field. Note *which kind*
   of lead it gets wrong (suspected weak spot: hot/warm boundary on
   ambiguous timelines).

### Phase 2 — self-measuring column (the durable version)
1. Migration: add `ai_temperature_original` to `leads` — written once at
   triage time, **never updated** by manual edits or re-triage.
2. Accuracy becomes one SQL query: final `temperature` vs
   `ai_temperature_original` disagreement rate. Zero ongoing effort;
   Ryan's normal corrections ARE the eval.

### Later / optional (from the same conversation)
- **Golden set**: 15–20 real transcripts/emails with known-correct
  answers; regression script runs on any `TEMPERATURE_RUBRIC` / prompt
  edit before deploy.
- **Calibration vs outcomes**: % of "hot" leads reaching an offer vs
  "warm" (uses `offer_amount` + lifecycle status).
- **Confidence + escalation**: triage outputs confidence; below
  threshold → flag for Ryan instead of silently classifying.
- **Model A/B**: run golden set through Sonnet vs Haiku via OpenRouter;
  is the delta worth 10× the price?

## Decision made

Start with Phase 2 (the column) after an initial Phase 1 round or two to
calibrate. Local models ruled out — constraint is verification, not
volume/privacy.
