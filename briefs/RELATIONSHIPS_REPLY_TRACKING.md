# Brief — Reply-Rate Tracking + Outcome Learning (Relationships tab)

**Status:** Ready to execute. Scoped 2026-05-22.
**Project:** comprehensive-relationship-management (Relationships tab).
**Scope:** Items #1–3 of the 2026-05-22 workflow-review opinion. Smart
cadence (#4) and reply management (#5) are explicitly OUT — a separate,
deeper project (they rewire the queue engine + add a reply-handling UX).

## Why

The Relationships tab is open-loop: it measures messages *sent* and mimics
Ryan's writing *style*, but has zero signal on what actually gets *replies*.
This brief adds the outcome signal and makes the generator learn from it.

## Phase 1 — Detect & store replies

- **Schema:** `alter table relationship_touches add column replied_at
  timestamptz` (null = no reply detected).
- **Reply-detection script** (`scripts/`, launchd cron + on-demand): for
  each `action='sent'` touch, read the contact's inbound iMessages from the
  CRMS sidecar (chat.db) and set `replied_at` to the first inbound that
  lands within 7 days of `occurred_at`. A reply is attributed to the latest
  sent touch before it. Idempotent; backfills the ~191 existing touches.
  Recent touches are re-checked until their 7-day window closes.

## Phase 2 — Learn from winners

- `fetchVoiceExamples` (generate route): filter the AI few-shot to touches
  with `replied_at` set — so it mimics messages that *landed*, not just the
  most recent ones. Fall back to most-recent if fewer than 3 replied-to
  examples exist (cold start).

## Phase 3 — A/B copy variants

- **Schema:** `add column variant text` on `relationship_touches`.
- generate route: 2–3 prompt variants per modality; pick one per call;
  return the variant id in the response. CRMSTab passes it through to the
  `log` route, which stores it on the touch.
- Selection: random to start; epsilon-greedy (weight toward winners) once
  there is enough reply data.

## Phase 4 — Reply-rate stats view

- A panel in the Relationships tab: reply rate per modality and per
  variant, over a selectable window. The payoff — Ryan sees what works and
  tunes the copy with evidence instead of guessing.

## Open decisions

1. **Stats panel placement** — compact strip at the top of the
   Relationships tab (default), or a dedicated view.
2. **Reply window** — 7 days (default).
