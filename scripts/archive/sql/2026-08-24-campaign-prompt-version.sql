-- Copy-quality work (2026-08-24): attribute reply rate to the compose prompt
-- that produced each body, and record regenerate rejections next to edits.
alter table campaign_sends add column if not exists prompt_version text;
alter table campaign_send_edits add column if not exists kind text not null default 'edit'; -- 'edit' | 'regenerate'
