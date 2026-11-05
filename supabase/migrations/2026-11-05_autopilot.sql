-- Autopilot (2026-11-05): fixed-text check-ins for low-priority sellers that
-- send on their own and never reach the Follow Ups worklist unless the person
-- replies. Campaign lives in drip_campaign_type = 'autopilot'; these three
-- columns hold the rest of its state (scripts/autopilot.js).
--   autopilot_since       replies are counted only after this moment (enrolment,
--                         or the last reply autopilot already handled)
--   autopilot_hold_until  "not interested" reply → quiet until this date (1 year)
--   autopilot_done_at     ran all 8 texts with no reply → stopped and tagged
alter table leads add column if not exists autopilot_since timestamptz;
alter table leads add column if not exists autopilot_hold_until timestamptz;
alter table leads add column if not exists autopilot_done_at timestamptz;
create index if not exists leads_autopilot_idx on leads (drip_campaign_type) where drip_campaign_type = 'autopilot';
