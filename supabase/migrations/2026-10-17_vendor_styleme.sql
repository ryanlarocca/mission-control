-- Inbox Agent — StyleMe Home Staging vendor rule (FreshBooks → Properties/<address>/Staging)
-- (briefs/BRIEF_INBOX_STAGING_VENDOR_FRESHBOOKS_2026-10-17.md, Part B).
--
-- Appends the `styleme` rule to inbox_settings.vendors.rules WITHOUT touching
-- the ITI rule: the row is seeded (with ITI) only if it does not exist yet, then
-- the StyleMe rule is appended only if no rule with id "styleme" is present.
-- Idempotent — safe to re-run. The worker mirrors both rules in
-- scripts/inbox-agent/vendors.mjs DEFAULT_VENDORS.

-- 1. A missing vendors row gets the ITI seed first (same JSON as 2026-10-16_campaign_drive_folder.sql).
INSERT INTO inbox_settings (key, value, updated_at)
VALUES (
  'vendors',
  '{"rules": [{"id": "iti", "name": "ITI Direct Mail", "senders": ["juan@letterprinting.net", "alan@letterprinting.net"], "relays": [{"sender": "docs@email.pandadoc.net", "subject_re": "iti Direct Mail|Proof.*order #"}], "doc_types": ["invoice", "proof", "quote", "tax_form"], "campaign_id": "5b71ff54-14f9-4c83-a14d-8d1eed6325f2", "subfolder": "3 - MAIL HOUSE"}]}'::jsonb,
  now()
)
ON CONFLICT (key) DO NOTHING;

-- 2. Append the StyleMe rule once.
UPDATE inbox_settings
SET value = jsonb_set(
      value,
      '{rules}',
      COALESCE(value->'rules', '[]'::jsonb) || '[{"id": "styleme", "name": "StyleMe Home Staging", "name_short": "StyleMe", "senders": [], "relays": [{"sender_re": "@fb\\d*\\.freshbooks\\.com$", "subject_re": "^StyleMe Home Staging"}], "doc_types": ["staging_proposal", "staging_invoice"], "destination": "property", "subfolder": "Staging"}]'::jsonb
    ),
    updated_at = now()
WHERE key = 'vendors'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(value->'rules', '[]'::jsonb)) r WHERE r->>'id' = 'styleme'
  );

-- 3. Document the fetch kinds FreshBooks jobs carry (free text; the comment is the documentation).
COMMENT ON COLUMN inbox_fetches.kind IS 'the inbox_messages.kind that queued it, or manual; FreshBooks jobs carry the vendor doc type (staging_proposal | staging_invoice), and staging_paid for the re-pull that replaces a filed StyleMe invoice with its paid copy';

-- Proof: both rules present.
-- select r->>'id' as id, r->>'destination' as destination, r->>'subfolder' as subfolder
--   from inbox_settings, jsonb_array_elements(value->'rules') r where key = 'vendors';
-- → iti | (null) | 3 - MAIL HOUSE ;  styleme | property | Staging
