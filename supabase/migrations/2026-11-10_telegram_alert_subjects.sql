-- Who each Telegram alert is about (2026-11-10). Ryan replies to alerts with
-- "Draft: …" or a plain text; the reply handler used to work out who the
-- alert was about by parsing its text, and every alert format needed its own
-- parser (office-line, agents-line and call-summary alerts had none). Each
-- alert about a person now records its message id here, and the reply
-- handler looks the person up by the message Ryan replied to.
--
--   message_id       Telegram message_id in TELEGRAM_CHAT_ID (one bot, one chat)
--   kind             lead | relationship
--   lead_id          the lead row the alert was for (kind = lead)
--   relationship_id  the Relationships card (kind = relationship)
--   phone            E.164 the alert was about (where a reply text goes)
--   email            the address for an email-only lead
--   line             the Twilio line a reply goes out on: office | agents
--                    (relationships), null for leads (sendLeadSms picks)
--
-- Applied with: node scripts/run-migration.mjs supabase/migrations/2026-11-10_telegram_alert_subjects.sql
create table if not exists telegram_alert_subjects (
  message_id bigint primary key,
  created_at timestamptz not null default now(),
  kind text not null,
  lead_id uuid,
  relationship_id uuid,
  phone text,
  email text,
  line text
);
alter table telegram_alert_subjects enable row level security;
