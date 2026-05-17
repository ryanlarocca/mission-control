-- 2026-05-17 — Campaign Performance tab + offer tracking.
--
-- Adds a `campaigns` table (with parent / child A-B variants), and five
-- new columns on `leads` for campaign attribution + offer tracking. Seeds
-- the two live May 2026 direct-mail drops (MFM-A pink + MFM-B white) and
-- their parent campaign. See briefs/CODY_BRIEF_CAMPAIGN_PERFORMANCE_2026-05-17.md.
--
-- Idempotent — safe to re-run. Backfill of existing leads' campaign_id is
-- in scripts/backfill-campaign-ids-2026-05-17.mjs (run after this lands).

-- 1) campaigns table
CREATE TABLE IF NOT EXISTS campaigns (
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

CREATE INDEX IF NOT EXISTS idx_campaigns_channel_drop_date ON campaigns(channel, drop_date DESC);
CREATE INDEX IF NOT EXISTS idx_campaigns_variant ON campaigns(variant);
CREATE INDEX IF NOT EXISTS idx_campaigns_parent ON campaigns(parent_campaign_id);

-- 2) leads additions
ALTER TABLE leads ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS offer_verbalized_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS offer_amount numeric;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS deal_closed_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS deal_value numeric;

CREATE INDEX IF NOT EXISTS idx_leads_campaign_id ON leads(campaign_id);
CREATE INDEX IF NOT EXISTS idx_leads_offer_verbalized_at ON leads(offer_verbalized_at) WHERE offer_verbalized_at IS NOT NULL;

-- 3) Seed: parent + two children for the May 2026 MFM drop.
-- Guarded by NOT EXISTS so re-runs don't duplicate seed rows.
WITH new_parent AS (
  INSERT INTO campaigns (name, channel, drop_date, notes)
  SELECT 'MFM May 2026', 'direct_mail', '2026-04-30', 'Parent for MFM-A / MFM-B A/B split'
  WHERE NOT EXISTS (SELECT 1 FROM campaigns WHERE name = 'MFM May 2026')
  RETURNING id
),
parent_id AS (
  SELECT id FROM new_parent
  UNION ALL
  SELECT id FROM campaigns WHERE name = 'MFM May 2026' LIMIT 1
)
INSERT INTO campaigns (name, channel, drop_date, pieces_sent, total_cost, variant, parent_campaign_id)
SELECT 'MFM-A May 2026', 'direct_mail', '2026-04-30', 6837, 4800.99, 'pink-envelope', (SELECT id FROM parent_id LIMIT 1)
WHERE NOT EXISTS (SELECT 1 FROM campaigns WHERE name = 'MFM-A May 2026');

WITH parent_id AS (
  SELECT id FROM campaigns WHERE name = 'MFM May 2026' LIMIT 1
)
INSERT INTO campaigns (name, channel, drop_date, pieces_sent, total_cost, variant, parent_campaign_id)
SELECT 'MFM-B May 2026', 'direct_mail', '2026-04-30', 5007, 3377.78, 'white-envelope', (SELECT id FROM parent_id)
WHERE NOT EXISTS (SELECT 1 FROM campaigns WHERE name = 'MFM-B May 2026');
