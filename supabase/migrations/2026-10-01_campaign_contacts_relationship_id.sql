-- Agents line + email-campaign replies now land on the Relationships card
-- (Ryan, 2026-10-01). Each campaign contact remembers which card it is so
-- the drip timeline and the card describe one person, not two shadows.
alter table campaign_contacts
  add column if not exists relationship_id uuid references relationships(id) on delete set null;

create index if not exists campaign_contacts_relationship_idx
  on campaign_contacts (relationship_id) where relationship_id is not null;
