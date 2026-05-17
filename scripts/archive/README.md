# scripts/archive/

One-shot scripts that have already run — kept for the audit trail, not
intended to be re-run from scratch. Most are dated (e.g. `-2026-05-17.mjs`)
to mark the day they ran in prod.

If you need to re-run one, copy it back up to `scripts/` first so its
relative imports + `.env.local` reads still resolve. Don't run it in
place — schema or row-shape may have drifted since it was authored.

## Index

### Data backfills
- `backfill-anonymous-leads-2026-05-14.mjs` — anonymous-caller dedupe + re-keying
- `backfill-campaign-ids-2026-05-17.mjs` — attributed existing leads to MFM-A / MFM-B campaigns
- `backfill-dedupe-cluster-stamps-2026-05-17.mjs` — Brian Bernasconi fix; un-stamped 40 duplicate cluster rows
- `backfill-junk-to-dead-2026-05-11.mjs` — moved junk-flagged leads to lifecycle=dead
- `backfill-offer-detection-2026-05-17.mjs` — ran Haiku offer-detect over historical transcripts (found Tony/Jose/Brian Metcalf)
- `backfill-orphan-transcripts-2026-05-17.mjs` — re-ran Whisper for rows where recording_url was set but message was null (Gigi / Al Meir recovery)
- `reanalyze-leads-2026-05-14.mjs` — bulk re-ran `analyze-call` against the backlog after the Phase 7D rubric rewrite

### Cleanups
- `cleanup-spurious-rescue-fallbacks-2026-05-12.mjs` — removed bad fallback rows from the recording-rescue path
- `cleanup-diag-leads.mjs` — diagnostic test-row cleanup
- `dismiss-stale-failed-drips-2026-05-14.mjs` — flipped old failed drip_queue rows to skipped
- `drip-mistagged-cleanup-2026-05-11.mjs` — removed bad drip stamps
- `drip-queue-cleanup-2026-05-11.mjs` — removed stale drip_queue rows
- `clear-default-followup-dates-2026-05-12.mjs` — nulled out junk default-date stamps
- `apply-triage-2026-05-16.mjs` — one-off re-triage pass

### Audits / Investigations
- `audit-dnc-*` (`.mjs` + `.json` pairs) — DNC candidate audits prior to applying
- `apply-anonymous-dnc.mjs` — applied DNC to a known anonymous spam cluster
- `inspect-dnc-candidates.mjs` — paired diagnostic for the audit
- `dump-candidates.mjs` — one-off cluster dump
- `find-ricardo-call-2026-05-12.mjs` — specific lookup tied to a debug session
- `find-offer-leads.mjs` — offer-leads scan that predates the proper `offer_amount` column

## Active scripts (kept in `scripts/`)

These are reusable tools and stay outside the archive:
- `inspect-lead.mjs` — full-state dump for any lead (phone / uuid / email)
- `check-lead-full.mjs`, `check-leads-by-phone.mjs`, `check-recent-leads.mjs`, `check-email-leads.mjs`
- `count-statuses.mjs`
- `compute-campaign-metrics.mjs`
- `drip-engine.js` (load-bearing — runs hourly via launchd)
- `drips-e2e-test.mjs`
- `run-migration.mjs`
- `relabel-legacy-campaigns.mjs` — still useful for new campaign tagging
- `regenerate-pending-drips.js`
- `phase7d-backfill-analyzer.mjs` — kept active because the analyzer prompt evolves and re-runs are expected
- `*.sql` migrations (idempotent, safe to re-run via `run-migration.mjs`)
