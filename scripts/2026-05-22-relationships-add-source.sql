-- Relationships migration addendum — add the `source` column.
-- The BoB sheet's column D ("Source": Business Card / Redfin / Referral / …)
-- was missed by the initial schema because the brief's column map — written
-- from the app's read code, which never touched columns C/D — wrongly listed
-- C/D as unused. C is actually Email, D is Source. Idempotent.
alter table relationships add column if not exists source text;
