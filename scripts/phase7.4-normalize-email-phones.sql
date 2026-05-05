-- Phase 7.4 follow-up: backfill any email-lead caller_phone values stored as
-- raw 10-digit strings (pre-fix). Post-fix code normalizes via
-- normalizePhone() in lib/leads.ts ("+1XXXXXXXXXX"), but rows that
-- predated the deploy can still hold "4085006293" etc.
--
-- Idempotent — the WHERE clause skips anything already prefixed.

UPDATE leads
SET caller_phone = '+1' || caller_phone
WHERE lead_type = 'email'
  AND caller_phone IS NOT NULL
  AND caller_phone ~ '^[0-9]{10}$';
