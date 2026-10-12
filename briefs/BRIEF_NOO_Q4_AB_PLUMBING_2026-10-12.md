# NOO Q4 2026 — A/B piece plumbing (Mission Control side)

> **Status:** spec, approved by Ryan 2026-10-12. Built by a cloud session on a branch; merged, migrated and deployed from the Mac mini.
> **Owner memo:** `../lead-pipeline/PROJECT_MEMO.md`. Background: `BRIEF_DM_ABSENTEE_Q4_2026_2026-10-08.md`.

## What exists (do not rebuild)

- Parent campaign row **NOO Q4 2026** `5b71ff54-14f9-4c83-a14d-8d1eed6325f2`, `source_label = NOO-Q4-2026`, `variant = noo-q4-2026`, `channel = direct_mail`. All 28,205 `mail_records` rows belong to it. `mail_records.piece text` exists (null today) and is already a `mail_segment_stats` dimension; the Segments panel already has a "Piece A/B" pill; `scripts/import-mail-records.mjs` already maps a `piece` CSV column.
- `resolveCampaignId` (`lib/campaigns.ts`) is table-driven: `campaigns.source_label = lead.source` first, legacy if/else second.
- Phone attribution: `CAMPAIGN_MAP` in `lib/leads.ts` (`+14084186294 → "NOO-Q4-2026"`), `SOURCE_OVERRIDE_NUMBERS`, `SOURCE_BADGE` colours in `components/widgets/LeadsTab.tsx`.
- Email attribution: `config/email-campaigns.json` — aliases on the `campaigns@lrghomes.com` hub (`ryansvx@` and `ryansvy@` both map to `NOO-Q4-2026` today). Do not change the alias/mailbox structure, only labels.
- Lead ↔ record auto-link: `lib/mailMatch.ts autoLinkMailRecord` scopes the search by `lead.campaign_id`.
- Campaign Performance (`app/api/campaigns/performance/route.ts` + `CampaignPerformanceTab.tsx`) already renders parent + children (MFM May 2026 is the precedent: parent `MFM May 2026`, children `MFM-A` / `MFM-B` with `parent_campaign_id`).
- Segments: `GET /api/campaigns/[id]/segments` reads `mail_segment_stats(campaign_id)`; `CampaignSegmentsPanel.tsx`.

## The test

One list, two letters. **Piece A = bullets, Piece B = prose** (copy identical otherwise). Each mailed record gets `piece ∈ {A, B}`, randomized 50/50 inside arm × prior_mail × county × batch (done by the list-build step on the Mac mini, not here). Attribution: the dialed line / emailed alias decides the piece; the record match is the cross-check.

| | Piece A | Piece B |
|---|---|---|
| Phone | 408-418-6294 (`+14084186294`) | 408-418-8450 (`+14084188450`, idle ported line, Twilio webhooks already set) |
| Email | `ryansvx@lrghomes.com` | `ryansvy@lrghomes.com` |
| Lead `source` | `NOO-Q4-2026-A` | `NOO-Q4-2026-B` |

## Build (branch `cloud/noo-q4-ab-plumbing`, no PR, no merge)

1. **Migration** `supabase/migrations/2026-10-12_noo_q4_ab_children.sql` (idempotent):
   - `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS piece text;`
   - Insert two children if missing: `name = 'NOO Q4 2026 — A (bullets)'`, `source_label = 'NOO-Q4-2026-A'`, `variant = 'noo-q4-2026-a'`, `piece = 'A'`, `channel = 'direct_mail'`, `drop_date` = parent's, `parent_campaign_id` = parent id; same for B (`'NOO Q4 2026 — B (prose)'`, `NOO-Q4-2026-B`, `noo-q4-2026-b`, `'B'`).
   - Replace `mail_segment_stats` is NOT needed (piece dimension already there).
2. **Phone map** (`lib/leads.ts`): `+14084186294 → "NOO-Q4-2026-A"`, add `+14084188450 → "NOO-Q4-2026-B"`; add `+14084188450` to `SOURCE_OVERRIDE_NUMBERS` alongside 6294. Keep the legacy `"NOO-Q4-2026"` label resolving (parent row still has it). Add `SOURCE_BADGE` entries for the two labels (same hue family as the parent).
3. **Email labels** (`config/email-campaigns.json`): `ryansvx@ → NOO-Q4-2026-A`, `ryansvy@ → NOO-Q4-2026-B`; leave `campaigns@` (hub default) on `NOO-Q4-2026` and every other entry untouched.
4. **Auto-link scope** (`lib/mailMatch.ts`): when the lead's campaign is a child (has `parent_campaign_id`) or has no `mail_records`, search the parent's records. Implement as: load `campaigns.id, parent_campaign_id` for `lead.campaign_id`, scope by `parent_campaign_id ?? id`. Also, when the matched record's `piece` disagrees with the child campaign's `piece`, keep the link and set `mail_match_method` unchanged but log a warning line `[mail-match] piece mismatch` (the UI chip work is out of scope).
5. **Segments for a child**: `GET /api/campaigns/[id]/segments` — if the campaign has `parent_campaign_id`, run `mail_segment_stats(parent_id)` and keep only rows for the child's `piece` **for the `piece` dimension**, and additionally compute every other dimension restricted to that piece. Simplest correct approach: add a second SQL function `mail_segment_stats_piece(p_campaign uuid, p_piece text)` (same body as `mail_segment_stats` with `AND m.piece = p_piece`) in the migration, and have the route call it for children. Parent behaviour unchanged.
6. **Importer** (`scripts/import-mail-records.mjs`): after a `--commit`, also set each child's `pieces_sent` = mailed non-seed rows with that `piece` (children found by `parent_campaign_id` + `piece`). Reconciliation output prints the per-piece counts.
7. **Leads tab**: `isMailerSource` / the "Unmatched DM" filter must treat `NOO-Q4-2026-A/B` as mailer sources (check the predicate; likely a prefix test).
8. **Tests**: extend `tests/mailMatch.unit.test.ts` (or add `tests/noo-ab.unit.test.ts`) for the parent-scope resolution and the label map; `npx tsc --noEmit` clean; `npx vitest run` green.

## Out of scope

Twilio configuration (done), Workspace aliases (done), the list build / piece randomization / mail-house files (Mac mini), applying the migration and running the import (Mac mini), the lead-card "piece mismatch" chip, any change to `lib/mailMatch.ts` normalizers, any CHANGELOG/PROJECT_MEMO (they live outside this repo — see `CLAUDE.md`).

## Hand-off

Push the branch, then stop. Report: files changed, the migration file path, anything you could not verify without a database.
