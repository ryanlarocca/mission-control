-- Phase 7.4 follow-up backfill — fix existing email leads inserted BEFORE
-- the Bug 1 fix landed. Their `twilio_number IS NULL` makes `isOutbound()`
-- treat them as outbound ("You") in the LeadsTab timeline, AND blocks the
-- new "Send Email" button (which looks for an inbound email row in the
-- group's events).
--
-- After this runs, MFM-A leads → twilio_number='email:ryansvg@lrghomes.com',
-- MFM-B leads → 'email:ryansvj@lrghomes.com'. Outbound replies (which we
-- intentionally insert with twilio_number=NULL post-fix) are unaffected
-- because they have status='contacted' AND a non-null gmail_thread_id —
-- the WHERE clauses below scope to inbound-only via twilio_number IS NULL
-- AND status != 'contacted'.

UPDATE leads
SET twilio_number = 'email:ryansvg@lrghomes.com'
WHERE lead_type = 'email'
  AND source = 'MFM-A'
  AND twilio_number IS NULL
  AND status != 'contacted';

UPDATE leads
SET twilio_number = 'email:ryansvj@lrghomes.com'
WHERE lead_type = 'email'
  AND source = 'MFM-B'
  AND twilio_number IS NULL
  AND status != 'contacted';
