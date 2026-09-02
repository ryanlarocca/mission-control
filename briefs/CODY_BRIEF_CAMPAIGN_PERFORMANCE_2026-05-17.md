# Cody Brief — Campaign Performance Tab + Offer Tracking

**Date:** 2026-05-17
**Project:** Mission Control — Lead Pipeline
**App:** `PROJECTS/mission-control/`
**Deploy:** `cd PROJECTS/mission-control && vercel --prod`
**Branch:** `feature/campaign-performance-2026-05-17` ← create before starting

---

## Summary

Add a `campaigns` table (with parent/child A-B variants), auto-link incoming leads to the right campaign at ingest time, teach Haiku to detect when Ryan verbalizes a purchase price (offers), and ship a new top-level "Campaign Performance" tab in Mission Control that renders the Sent → Responded → Offer → Closed funnel for each campaign with cost-per-stage and ROI. Seed the two live May 2026 direct-mail campaigns (MFM-A pink, MFM-B white) and backfill existing leads.

---

## ⚠️ Issues / Open Questions

1. **Auto-link ambiguity when two campaigns overlap.** If Ryan ever runs two MFM-A drops within the same active response window (e.g., one in April, one in June), a lead in July with `source='MFM-A'` will match both. **Resolution:** pick the campaign with the **most recent `drop_date` that is `<= lead.created_at`**. If exactly one match, use it. If multiple campaigns share the same `drop_date`, pick the one with the latest `created_at`. Document this in code comments.

2. **No "response window" cutoff.** A lead that comes in 6 months after a drop will still link to that drop. This is probably fine (mailers do generate long-tail responses), but flag it in the data: when the campaign card renders, response rate is calculated on **all** linked leads regardless of age. If Ryan wants a 90-day window later, that's a future filter — not in scope here.

3. **Offer false positives — seller-stated prices.** Real risk. Sellers will often say "I want $850K" or "I'm asking $1.2M" and Haiku could mistake that for Ryan's offer. **Mitigation:** the prompt must be explicit that this is **Ryan's stated price to the seller**, not the seller's asking price. Use few-shot examples in the prompt. Also: only write `offer_verbalized_at` / `offer_amount` if currently null (hands-off rule, same as `name` / `property_address`). Ryan can manually override via the pencil icon if Haiku gets it wrong.

4. **Offer false positives — discussion vs. commitment.** Phrases like "I was thinking maybe $800K, but I'd have to see the property" are ambiguous. **Resolution:** count any specific dollar figure Ryan states to the seller as an offer event, even if soft. Better to over-capture than miss — Ryan can correct via the pencil. Track in `followup_reason` log if needed for later refinement.

5. **`source` field inconsistency.** Existing data uses both `'MFM-A'` / `'SVG-A'` for the pink campaign and `'MFM-B'` / `'SVJ-B'` for white. The auto-linker must handle both. Suggest normalizing at link time, not at insert time (don't break existing data).

6. **Google Ads cost is manual.** Brief says "Cost entry is manual per campaign period." That works for v1, but flag that this means ROI for Google Ads will be stale until Ryan updates the `total_cost` field. Not a blocker.

7. **`deal_closed_at` / `deal_value` have no UI in this brief.** The columns are added but there's no UI to populate them. That's fine for v1 (Ryan will set via Supabase Studio or a later brief), but the comparison table's "Closed" / "ROI" columns will be empty until then. Render `—` for null.

8. **No schema conflicts** with the existing `leads` table — all five new columns are nullable and additive.

---

## Schema Changes

### Migration: `supabase/migrations/<timestamp>_campaign_performance.sql`

```sql
-- 1) campaigns table
CREATE TABLE campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('direct_mail', 'google_ads')),
  drop_date date,
  pieces_sent integer,
  total_cost numeric,
  variant text,
  parent_campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_campaigns_channel_drop_date ON campaigns(channel, drop_date DESC);
CREATE INDEX idx_campaigns_variant ON campaigns(variant);
CREATE INDEX idx_campaigns_parent ON campaigns(parent_campaign_id);

-- 2) leads additions
ALTER TABLE leads ADD COLUMN campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL;
ALTER TABLE leads ADD COLUMN offer_verbalized_at timestamptz;
ALTER TABLE leads ADD COLUMN offer_amount numeric;
ALTER TABLE leads ADD COLUMN deal_closed_at timestamptz;
ALTER TABLE leads ADD COLUMN deal_value numeric;

CREATE INDEX idx_leads_campaign_id ON leads(campaign_id);
CREATE INDEX idx_leads_offer_verbalized_at ON leads(offer_verbalized_at) WHERE offer_verbalized_at IS NOT NULL;

-- 3) Seed: parent + two children for the May 2026 MFM drop
WITH parent AS (
  INSERT INTO campaigns (name, channel, drop_date, notes)
  VALUES ('MFM May 2026', 'direct_mail', '2026-04-30', 'Parent for MFM-A / MFM-B A/B split')
  RETURNING id
)
INSERT INTO campaigns (name, channel, drop_date, pieces_sent, total_cost, variant, parent_campaign_id)
SELECT 'MFM-A May 2026', 'direct_mail', '2026-04-30', 6837, 4800.99, 'pink-envelope', parent.id FROM parent
UNION ALL
SELECT 'MFM-B May 2026', 'direct_mail', '2026-04-30', 5007, 3377.78, 'white-envelope', parent.id FROM parent;
```

After running the migration, regenerate the Supabase TypeScript types (`lib/supabase-types.ts` or wherever the project keeps them) so the new columns are typed.

---

## Code Changes

### A. Auto-link helper — `lib/campaigns.ts` (NEW)

```ts
import { supabaseAdmin } from "./supabase"

type SourceInput = { source: string | null; source_type: string | null; created_at?: string | Date }

// Map raw source values to campaign-match predicates.
// Returns a Supabase query filter, NOT a campaign — caller picks newest matching.
export async function resolveCampaignId(input: SourceInput): Promise<string | null> {
  const { source, source_type } = input
  const createdAt = input.created_at ? new Date(input.created_at).toISOString() : new Date().toISOString()
  if (!source && !source_type) return null

  let variant: string | null = null
  let channel: "direct_mail" | "google_ads" | null = null

  const s = (source ?? "").toUpperCase()
  if (s === "MFM-A" || s === "SVG-A") { variant = "pink-envelope"; channel = "direct_mail" }
  else if (s === "MFM-B" || s === "SVJ-B") { variant = "white-envelope"; channel = "direct_mail" }
  else if (s === "GOOGLE" || source_type === "google_ads") { channel = "google_ads" }

  if (!channel) return null

  // Find the most recent campaign whose drop_date <= createdAt and channel/variant match.
  // Variant filter only applied when known (direct mail A/B); google_ads has no variant.
  let q = supabaseAdmin
    .from("campaigns")
    .select("id, drop_date, created_at, parent_campaign_id")
    .eq("channel", channel)
    .lte("drop_date", createdAt.slice(0, 10))
    .order("drop_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(5)

  if (variant) q = q.eq("variant", variant)

  const { data, error } = await q
  if (error || !data || data.length === 0) return null

  // Prefer child campaigns (have parent_campaign_id) over standalone — A/B child is more specific.
  const child = data.find((r) => r.parent_campaign_id) ?? data[0]
  return child.id
}
```

### B. Wire into ingest routes

- `app/api/leads/voice/route.ts` (and SMS route if separate)
- `app/api/leads/email/route.ts`

In each ingest path, **after** the lead row is inserted but **before** the analyzer write-back (or as part of the insert payload if simpler), call `resolveCampaignId({ source, source_type, created_at })` and `update leads set campaign_id = ... where id = ...`. Don't fail the ingest if resolution returns null.

### C. Offer detection — `lib/leads.ts`

Two changes to the analyzer output shape. Add to the TS return type of `analyzeCallTranscript` AND `triageEmailLead`:

```ts
offer_amount: number | null
offer_verbalized: boolean
```

**Prompt addition (insert into both `analyzeCallTranscript` and `triageEmailLead` system/user prompts, near where temperature + ai_summary instructions live):**

```
OFFER DETECTION
Ryan (the buyer/investor) sometimes states a specific purchase price to the seller. When he does, capture it.

Rules:
- "offer_amount": the dollar amount Ryan stated as a purchase price to the seller. Number only (e.g., 800000 for "$800K"). Null if no offer.
- "offer_verbalized": true if Ryan stated a specific price to the seller; false otherwise.

CRITICAL: This is RYAN'S price to the seller — NOT the seller's asking price.
- If only the seller mentions a price ("I want $850K", "I'm asking $1.2M"), set both to null.
- If Ryan says "I can offer you $800K" / "I was thinking $750K" / "what about $900K for the property" → offer_amount: 800000 (etc.), offer_verbalized: true.
- Soft/conditional offers still count ("maybe around $700K if it checks out") → capture the number.
- Ranges → take the midpoint, rounded ("$700-750K" → 725000).

Examples:
- Seller: "I'd take $900K." Ryan: "Okay, let me think about it." → offer_amount: null, offer_verbalized: false (Ryan didn't state a price)
- Ryan: "I can do $850,000 cash, close in 14 days." → offer_amount: 850000, offer_verbalized: true
- Ryan: "We're typically in the $600-700K range for properties like this." → offer_amount: 650000, offer_verbalized: true
- Email from Ryan: "Based on what you described, I could offer $1.1M." → offer_amount: 1100000, offer_verbalized: true
```

**JSON schema additions** — add `offer_amount` (number|null) and `offer_verbalized` (boolean) to the response_format JSON schema for both analyzers. Default `offer_verbalized: false`, `offer_amount: null`.

### D. Write-back — `lib/leads.ts`

In **both** `applyAnalyzeCallResult` and `applyFollowupOnlyResult` (and the equivalent path inside `triageEmailLead`/email apply), follow the same hands-off pattern used for `name` / `property_address`:

```ts
// Only write offer fields when currently null — Ryan's manual edits win.
const updates: Record<string, unknown> = { /* existing fields */ }

if (result.offer_verbalized && typeof result.offer_amount === "number" && result.offer_amount > 0) {
  if (currentLead.offer_amount == null) updates.offer_amount = result.offer_amount
  if (currentLead.offer_verbalized_at == null) {
    // Timestamp of the event being analyzed (call recording timestamp / email received_at),
    // NOT now() — so backfills set the correct historical date.
    updates.offer_verbalized_at = eventTimestamp ?? new Date().toISOString()
  }
}
```

Make sure `currentLead` is fetched (or already in scope) before the update — same as for the existing name/address hands-off check.

### E. Manual override API — `app/api/leads/[id]/route.ts` (PATCH)

The existing lead PATCH endpoint already accepts arbitrary column updates for name/property_address. Add `offer_amount` and `offer_verbalized_at` to the allow-list of patchable columns. When `offer_amount` is patched and `offer_verbalized_at` is null, set `offer_verbalized_at = now()` server-side.

### F. Lead card UI — `components/widgets/LeadsTab.tsx`

In the lead card render (next to the temperature badge and follow-up date row), add a read-only line when `offer_amount` is populated:

```
Offer: $800K · May 14    ✏️
```

- Format amount: `$Xk` if `< 1_000_000`, `$X.XM` if `>= 1_000_000`. Round to nearest 1k.
- Format date: short month + day, same helper used for `recommended_followup_date`.
- Pencil icon opens the existing inline-edit pattern (same as `name` / `property_address`). On save, PATCH `/api/leads/<id>` with `{ offer_amount: <number> }`. On clear, PATCH with `{ offer_amount: null, offer_verbalized_at: null }`.
- If `offer_amount` is null, do not render the row at all (don't show "Offer: —").

### G. Campaign Performance tab — `components/widgets/CampaignPerformanceTab.tsx` (NEW)

Register as a new top-level tab in whatever tab registry the app uses (check `components/MissionControl.tsx` or `app/page.tsx` for the existing tab list — match that pattern).

**Layout:**

```
┌──────────────────────────────────────────────────────┐
│ Campaign Performance                  [+ New Campaign]│
├──────────────────────────────────────────────────────┤
│ ▼ MFM May 2026  · direct_mail · 4/30/26              │
│   11,844 pieces · $8,178 · 120 responses (1.01%)      │
│   Pink outperformed White by 31% on response rate     │
│   ┌────────────────────────┐ ┌──────────────────────┐│
│   │ MFM-A · Pink Envelope  │ │ MFM-B · White Env.   ││
│   │ 6,837 pieces · $4,801  │ │ 5,007 pieces · $3,378││
│   │ Sent → Resp → Off → Cls│ │ Sent → Resp → Off → C││
│   │ 6837 → 77 (1.13%) → …  │ │ 5007 → 43 (0.86%) → …││
│   │ $/response: $62        │ │ $/response: $79      ││
│   │ $/offer: —             │ │ $/offer: —           ││
│   │ ROI: —                 │ │ ROI: —               ││
│   └────────────────────────┘ └──────────────────────┘│
├──────────────────────────────────────────────────────┤
│ Comparison Table                                      │
│ Name | Chan | Pieces | Spend | Resp | % | Off | %    │
│      | Closed | ROI                                   │
└──────────────────────────────────────────────────────┘
```

**Data fetching:**

Build a single server-side endpoint `app/api/campaigns/performance/route.ts` that returns:

```ts
type CampaignPerf = {
  id: string
  name: string
  channel: "direct_mail" | "google_ads"
  drop_date: string | null
  pieces_sent: number | null
  total_cost: number | null
  variant: string | null
  parent_campaign_id: string | null
  // Computed:
  responses: number              // count of leads with campaign_id = id, excluding is_junk
  response_rate: number | null   // responses / pieces_sent (null for google_ads)
  offers: number                 // count where offer_verbalized_at IS NOT NULL
  offer_rate: number | null      // offers / responses
  closed: number                 // count where deal_closed_at IS NOT NULL
  deal_value_total: number       // sum of deal_value where deal_closed_at IS NOT NULL
  cost_per_response: number | null
  cost_per_offer: number | null
  roi: number | null             // (deal_value_total - total_cost) / total_cost
}
```

Single query approach: `SELECT campaigns.*, COUNT(...) FILTER (WHERE ...)` grouped by `campaigns.id`, joined to `leads`. Compute derived metrics in TS after the query.

**Render logic:**

- Group by `parent_campaign_id`. Campaigns with no parent are "standalone parents."
- For a parent group: parent card on top, children rendered as side-by-side sub-cards underneath.
- Aggregated parent metrics = SUM of child pieces_sent, total_cost, responses, offers, closed. Response rate = aggregated_responses / aggregated_pieces_sent.
- "Outperformed by X%" line on parent: compute when there are exactly 2 children with non-null response_rate; show `(higher - lower) / lower * 100`.
- Funnel arrow rendering: simple text "Sent → Resp → Off → Cls" — don't over-engineer, no SVG required.

**Comparison table:** flat list, all campaigns (parents AND children). Sort by `drop_date DESC`. Show `—` for null cells.

**"+ New Campaign" modal:** simple form, POSTs to `app/api/campaigns/route.ts` (NEW). Fields: name (text, required), channel (select: direct_mail | google_ads), drop_date (date), pieces_sent (number, only show for direct_mail), total_cost (number), variant (text, free-form — Ryan can type "pink-envelope", "yellow-postcard", etc.), parent_campaign (select with existing campaigns, optional). On submit, refetch the performance endpoint.

---

## Seed Data / Backfill

### Seed (in the migration above)

Parent: "MFM May 2026" / direct_mail / 2026-04-30
Child A: "MFM-A May 2026" / direct_mail / 2026-04-30 / 6837 / 4800.99 / pink-envelope
Child B: "MFM-B May 2026" / direct_mail / 2026-04-30 / 5007 / 3377.78 / white-envelope

### Backfill script — `scripts/backfill-campaign-ids-2026-05-17.mjs` (NEW)

```js
#!/usr/bin/env node
// One-time backfill: assign campaign_id to existing leads by source + created_at.
// Usage: node scripts/backfill-campaign-ids-2026-05-17.mjs [--dry-run]

import { createClient } from "@supabase/supabase-js"

const DRY = process.argv.includes("--dry-run")
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

async function resolve(source, sourceType, createdAt) {
  // Same logic as lib/campaigns.ts resolveCampaignId — inlined here so the
  // script is standalone and doesn't depend on Next.js TS build.
  // ... (copy logic, keep in sync) ...
}

async function main() {
  const { data: leads, error } = await supabase
    .from("leads")
    .select("id, source, source_type, created_at, campaign_id")
    .is("campaign_id", null)
  if (error) throw error
  console.log(`Found ${leads.length} leads with null campaign_id`)
  let assigned = 0, skipped = 0
  for (const lead of leads) {
    const id = await resolve(lead.source, lead.source_type, lead.created_at)
    if (!id) { skipped++; continue }
    if (DRY) { console.log(`[dry] ${lead.id} → ${id}`); assigned++; continue }
    const { error: upErr } = await supabase.from("leads").update({ campaign_id: id }).eq("id", lead.id)
    if (upErr) console.error(`update failed ${lead.id}:`, upErr.message)
    else assigned++
  }
  console.log(`Done. Assigned: ${assigned}, Skipped: ${skipped}`)
}
main().catch((e) => { console.error(e); process.exit(1) })
```

Run dry first: `node scripts/backfill-campaign-ids-2026-05-17.mjs --dry-run`. Eyeball the counts (should land around 77 MFM-A + 43 MFM-B + however many Google leads). Then run for real.

**Note:** no offer backfill — historical calls won't be re-analyzed. `offer_verbalized_at` / `offer_amount` start populating from the next ingest after deploy. If Ryan wants historical offers detected, that's a separate batch re-analysis job (out of scope).

---

## Verification Steps

1. **Migration applied cleanly.** `select count(*) from campaigns;` → 3 (parent + 2 children). `\d leads` shows the 5 new columns. Type regen completed.
2. **Backfill dry run** shows roughly 77 MFM-A + 43 MFM-B + N Google assignments. Run for real, then `select source, campaign_id, count(*) from leads group by 1, 2 order by 1;` looks sane.
3. **New inbound voicemail with source='MFM-A'** lands with `campaign_id` set to the MFM-A child id (check logs + Supabase row).
4. **Offer detection — call test.** Drop a test transcript through `analyzeCallTranscript` where Ryan says "I could do $750K cash" — confirm `offer_amount=750000`, `offer_verbalized=true`, and the row in Supabase gets `offer_verbalized_at` populated. Confirm a second test where only the seller mentions a price → both fields stay null.
5. **Offer detection — email test.** Same drill via `triageEmailLead` with a sent-mail body containing "I'd be willing to offer $1.1M."
6. **Hands-off rule.** Manually set `offer_amount=999999` on a lead, send another follow-up event for it through the analyzer → confirm Haiku's new value does NOT overwrite (column stays 999999).
7. **Lead card** shows "Offer: $800K · May 14 ✏️" for leads with offers. Pencil opens edit, save PATCHes, value updates without page refresh.
8. **Campaign Performance tab loads.** Parent "MFM May 2026" card shows aggregated pieces (11,844), spend ($8,178.77), responses (~120), and the "Pink outperformed White by 31%" line. Sub-cards show correct per-variant funnel.
9. **+ New Campaign modal.** Create a dummy "TEST Postcard June 2026" / direct_mail / 100 pieces / $50 / variant 'test'. Confirm it appears in the comparison table and disappears when deleted from Supabase Studio.
10. **`tsc --noEmit` passes.** No type errors from the new column additions.

---

## Build Order

1. Migration + type regen
2. `lib/campaigns.ts` (resolveCampaignId)
3. Wire `campaign_id` into voice + email ingest routes
4. Backfill script + dry run
5. Offer detection prompt + JSON schema additions in `lib/leads.ts`
6. Write-back hands-off logic in `applyAnalyzeCallResult` / `applyFollowupOnlyResult` / email apply
7. PATCH endpoint allow-list update for offer fields
8. Lead card offer display + pencil edit
9. `app/api/campaigns/route.ts` (POST create) + `app/api/campaigns/performance/route.ts` (GET aggregates)
10. `CampaignPerformanceTab.tsx` + tab registration
11. `tsc --noEmit` must pass

---

## Checkpoint Protocol

```
✅ CHECKPOINT: [Step Name] complete
Summary: [1-2 sentences]
Files touched: [list]
Blocked: [yes/no]
```

```
⏸ BLOCKED: [Issue]
Options: [A, B, C]
Waiting for input.
```

---

## Deploy Gate

Do NOT deploy. When `tsc --noEmit` passes and all 10 verification steps pass locally:

```
🏁 READY FOR REVIEW
Changed files: [list]
What to test: [list]
Deploy command: cd PROJECTS/mission-control && vercel --prod
```

---

## Files Modified (allow-list)

- `supabase/migrations/<timestamp>_campaign_performance.sql` (NEW)
- `lib/supabase-types.ts` (regenerated)
- `lib/campaigns.ts` (NEW)
- `lib/leads.ts` (prompts + write-back + types)
- `app/api/leads/voice/route.ts` (campaign_id wiring)
- `app/api/leads/email/route.ts` (campaign_id wiring)
- `app/api/leads/[id]/route.ts` (PATCH allow-list)
- `app/api/campaigns/route.ts` (NEW — POST create + GET list)
- `app/api/campaigns/performance/route.ts` (NEW — GET aggregates)
- `components/widgets/LeadsTab.tsx` (offer field + pencil)
- `components/widgets/CampaignPerformanceTab.tsx` (NEW)
- `components/MissionControl.tsx` or wherever tabs register (1 line)
- `scripts/backfill-campaign-ids-2026-05-17.mjs` (NEW)

Anything else: ask first.

## DO NOT TOUCH

- Twilio routes' core call-handling logic (only add the post-insert `campaign_id` update)
- crms-sidecar.js / phase2/
- launchd plists
- config/email-campaigns.json
- Any existing migration files (only add a new one)
- The drip campaign system (`drip_campaign_type`, `drip_touch_number` columns)
