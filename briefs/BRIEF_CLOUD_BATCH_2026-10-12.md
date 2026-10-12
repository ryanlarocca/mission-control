# Cloud batch 2026-10-12 — three independent code tasks

> Each task runs in its own cloud session on its own branch. No PRs, no merges; the Mac mini merges, migrates, deploys. Read `CLAUDE.md` first (tsc --noEmit is the gate; never create CHANGELOG.md / PROJECT_MEMO.md here). No database or secrets are available in the cloud: write migrations, don't apply them; don't run scripts that need `.env.local`. `npx tsc --noEmit` and `npx vitest run` must pass before pushing.

---

## Task 1 — Ordered paging audit (branch `cloud/ordered-paging`)

**Bug class:** PostgREST `.range()` paging without `.order()` returns overlapping/shuffled pages on tables past ~1,000 rows. It produced a false reconciliation failure in `scripts/import-mail-records.mjs` on 2026-10-12 (fixed there and in `scripts/stamp-arrived.mjs`).

**Do:** find every Supabase read that pages with `.range(` (or `.limit(` + offset loops) in `lib/`, `app/`, `scripts/` (skip `scripts/archive/`). Known: `lib/leads.ts` (~line 663), `lib/relationships.ts` (~155), `lib/boardDb.ts` (~51), `app/api/leads/route.ts` (~41), `app/api/crms/cleanup/route.ts`, `app/api/campaign/contacts/route.ts`, `app/api/campaign/stats/route.ts` (three reads), `app/api/campaigns/[id]/segments/route.ts` (~65), `scripts/reply-review.mjs`, `scripts/import-relationships-agents.mjs`. For each: add a deterministic `.order(<unique column>, …)` before `.range(` — `id` (uuid) is fine as a tiebreaker; keep any existing business ordering and append `id` as the final key. Where a query already orders by a non-unique column (e.g. `created_at`), add `id` as a secondary key. Don't change page sizes or semantics.

**Tests:** add `tests/ordered-paging.unit.test.ts` that greps the source tree (lib, app, scripts minus archive) and fails if any `.range(` call is not preceded (within the same chained expression) by `.order(`. Keep the matcher simple and documented; it is a guard, not a parser.

**Report:** list of files/lines changed.

---

## Task 2 — Direct-mail response timing (branch `cloud/mail-timing`)

Planned in `briefs/BRIEF_DM_ABSENTEE_Q4_2026_2026-10-08.md` §3.4 ("Timing"), never built.

**Migration** `supabase/migrations/2026-10-12_mail_response_timing.sql` (idempotent): function `mail_response_timing(p_campaign uuid)` returning one row per batch: `batch int, pieces bigint, responders bigint, median_days numeric, p25_days numeric, p75_days numeric, weekly jsonb` where days = date of the cluster's FIRST non-junk inbound lead linked to the record (`leads.mail_record_id = m.id`, earliest `created_at`) minus `coalesce(m.arrived_at, m.drop_date)`; rows with neither date contribute to pieces/responders but not to the percentiles. `weekly` = JSON object `{"0": n, "1": n, …}` of responders by whole weeks since arrival (0 = first 7 days). Only `is_seed = false` and `arm in ('A','B','C')`. A second function `mail_response_timing_piece(p_campaign uuid, p_piece text)` with the extra `AND m.piece = p_piece` predicate (same pattern as `mail_segment_stats_piece`, see `supabase/migrations/2026-10-12_noo_q4_ab_children.sql`).

**Route** `GET /api/campaigns/[id]/timing`: mirrors `app/api/campaigns/[id]/segments/route.ts` — resolves A/B piece children to the parent's records with the `_piece` function; returns `{ has_mail_records, batches: [...] }`.

**UI:** in `components/widgets/CampaignSegmentsPanel.tsx` add a collapsed "Timing" section under the Segments table (same lazy-load pattern on first expand): one row per batch — batch, pieces, responders, median / p25 / p75 days (or "—" when no arrival date yet), and a compact weekly bar (text or tiny inline bars, no chart library). Note on the panel: "arrival = seed arrival stamp, else drop date".

**Tests:** unit-test any pure helper you extract (e.g. weekly bucket formatting). `tsc` clean.

**Report:** migration path, route path, what the panel shows when `arrived_at` is null everywhere (the state today).

---

## Task 3 — Lead-pipeline small fixes (branch `cloud/lead-pipeline-cleanups`)

Four unrelated, each small; separate commits.

1. **Piece-mismatch chip.** `lib/mailMatch.ts` logs `[mail-match] piece mismatch` when a lead's child campaign piece ≠ the matched record's `piece`. Surface it: in `components/widgets/LeadsTab.tsx` the lead card's "Mailed record" row / header badge area (search for the 📬 Matched / Candidates / Unmatched chip) shows an amber `⚠ piece mismatch (record B, line A)` chip when the group's linked record has a `piece` that differs from the piece of the campaign the group's newest inbound row is attributed to. The card already has the linked record (`mail_record_id`) — check what fields the Leads API returns for the record (`app/api/leads/route.ts` / `lib/leads.ts`) and extend minimally (the campaign's `piece` may need to be joined in; `campaigns.piece` exists). No new routes if avoidable.
2. **Own-number consolidation.** `LRG_OWN_NUMBERS` in `app/api/leads/email/route.ts` and `isOwnedNumber()` in `lib/leads.ts` are parallel definitions with different membership. Make `isOwnedNumber()` (CAMPAIGN_MAP keys + OFFICE_NUMBERS + any env-provided numbers) the single source and have the email route use it; delete the duplicate list; add a unit test that every number in the old list is still owned.
3. **Email dedupe window.** `app/api/leads/email/route.ts` per-sender dedupe query uses `limit(5)`; raise to `limit(50)` and add a comment (memo "Known limitations": bursts from one sender slip past 5).
4. **Scan script mailboxes.** `scripts/scan-missed-email-leads.mjs` has a hard-coded `MAILBOXES` list; derive the campaign (small) mailboxes from `config/email-campaigns.json` real mailboxes (entries without a `mailbox` field — see `watchedMailboxes()` in `lib/leads.ts`; the script is plain Node so re-implement the 5-line dedupe inline) and keep `info@` / `ryan@` as the two big ones.

**Report:** per item, what changed; anything you could not verify without a database.
