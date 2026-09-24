-- Reply Planner Phase 5: link a posted Telegram draft message to its
-- reply_drafts row so a reply-to-draft becomes a "why" and the buttons
-- can send / redraft / dismiss the right draft.
alter table reply_drafts add column if not exists tg_message_id bigint;
create index if not exists reply_drafts_tg_message_idx on reply_drafts (tg_message_id) where tg_message_id is not null;
