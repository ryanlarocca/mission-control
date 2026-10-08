-- NOO Q4 2026 direct-mail campaign (2026-10-08).
--
-- 1. campaigns.source_label — the lead `source` label (CAMPAIGN_MAP /
--    config/email-campaigns.json) that resolves straight to this campaign.
--    resolveCampaignId (lib/campaigns.ts) checks this first, so a future
--    campaign is a row, not an if/else branch. Unique when set.
-- 2. Seed the NOO Q4 2026 row (absentee SFR, three counties, one piece, one
--    line 408-418-6294, one mailbox ryansvx@lrghomes.com). pieces_sent /
--    total_cost are filled by the mail_records importer once the list is final.
-- Idempotent — safe to re-run.

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS source_label text;

CREATE UNIQUE INDEX IF NOT EXISTS campaigns_source_label_uniq
  ON campaigns (source_label) WHERE source_label IS NOT NULL;

INSERT INTO campaigns (name, channel, drop_date, variant, source_label, notes)
SELECT 'NOO Q4 2026', 'direct_mail', '2026-10-08', 'noo-q4-2026', 'NOO-Q4-2026',
       'Absentee-owner SFR test of list segments (arms A tenure / B signals / C heirs). Line 408-418-6294 (ex ryansvb@ GV), mailbox ryansvx@lrghomes.com. drop_date = campaign start; real drops are staggered by the mail house.'
WHERE NOT EXISTS (SELECT 1 FROM campaigns WHERE source_label = 'NOO-Q4-2026');
