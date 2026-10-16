-- Inbox Agent — ITI vendor filing + HomeSentry (tapinspect) report fetcher
-- (briefs/BRIEF_INBOX_VENDOR_FILING_TAPINSPECT_2026-10-16.md).
--
-- 1. campaigns.drive_folder_id — the campaign's Drive folder; the inbox agent
--    files the mail house's invoices / signed proofs / quotes / tax form into
--    "<folder>/3 - MAIL HOUSE (…)". Seeded for the NOO Q4 2026 parent
--    (My Hard Drive / Marketing / 2026 / NOO October2026).
-- 2. inbox_settings.vendors — the vendor rules (ITI only; upsert on key).
-- 3. inbox_files.meta — parsed invoice amounts {subtotal, shipping, discount,
--    tax, total, invoice_no, campaign_id, vendor, paid_at} (no other jsonb
--    column fits: classification lives on inbox_messages).
-- 4. inbox_fetches.status gains awaiting_payment / expired (free text; the
--    comment is the documentation).
-- Idempotent — safe to re-run.

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS drive_folder_id text;
COMMENT ON COLUMN campaigns.drive_folder_id IS 'Google Drive folder id of the campaign (e.g. Marketing/2026/NOO October2026); the inbox agent files mail-house paperwork under it. null = no folder.';

UPDATE campaigns SET drive_folder_id = '14qk007vZ5iHMPLU3lAjiOB-_o_Go0N--'
WHERE id = '5b71ff54-14f9-4c83-a14d-8d1eed6325f2' AND drive_folder_id IS DISTINCT FROM '14qk007vZ5iHMPLU3lAjiOB-_o_Go0N--';

INSERT INTO inbox_settings (key, value, updated_at)
VALUES (
  'vendors',
  '{"rules": [{"id": "iti", "name": "ITI Direct Mail", "senders": ["juan@letterprinting.net", "alan@letterprinting.net"], "relays": [{"sender": "docs@email.pandadoc.net", "subject_re": "iti Direct Mail|Proof.*order #"}], "doc_types": ["invoice", "proof", "quote", "tax_form"], "campaign_id": "5b71ff54-14f9-4c83-a14d-8d1eed6325f2", "subfolder": "3 - MAIL HOUSE"}]}'::jsonb,
  now()
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

ALTER TABLE inbox_files ADD COLUMN IF NOT EXISTS meta jsonb;
COMMENT ON COLUMN inbox_files.meta IS 'Per-document extras: vendor invoices carry {subtotal, shipping, discount, tax, total, invoice_no, campaign_id, vendor, paid_at}.';

COMMENT ON COLUMN inbox_fetches.status IS 'queued | running | done | failed | needs_code | needs_login | expired | duplicate | awaiting_new_link | resolved_by_new_link | needs_property | skipped | awaiting_payment (tapinspect: report gated behind invoice/agreement, retried daily via next_try_at for up to 14 days, then expired)';
