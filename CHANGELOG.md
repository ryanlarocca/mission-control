# Changelog

Notable production changes to Mission Control (CRMS). Newest first.
This log starts 2026-05-21 — for earlier history see `git log`.

## 2026-05-21

### Follow Ups worklist — respect "handled" contacts (`8c32500`)
- **Promote to Relationships now retires the whole contact.** Promoting a
  lead dead-marks every lead row in its phone/email cluster (not just the
  clicked row) and runs `haltOutreachForCluster`, so a promoted contact
  fully drops out of the Follow Ups worklist and the drip engine. Before,
  a sibling row carrying the drip campaign stayed alive and kept the
  contact in the worklist.
- **A manual outreach now counts as a drip touch.** Completing a call
  (Done) or sending a hand-written Email/Text from Follow Ups resets the
  drip cadence clock (`last_drip_sent_at`) and consumes the touch that was
  due — skips a pending/approved `drip_queue` row, or advances
  `drip_touch_number` on a forecast. New `registerManualTouch` in
  `lib/leads.ts`, fired from the `/api/leads` PATCH route via a
  `manual_touch` flag. Snooze deliberately does not trigger it. Fixes
  contacts staying pinned to the top of the worklist after being handled.
- Data fix: corrected the live state of two contacts caught by the above
  bugs before the deploy.

### Outbound SMS → Twilio A2P 10DLC
- **Manual lead texts** (`/api/leads/send`) migrated off the Mac-mini
  iMessage sidecar to the Twilio Messaging API, sending from the outbound
  number `+16502043247` (`dafc770`, PR #1).
- **Drip engine** texts likewise migrated to Twilio (`bc6534a`).
- Leads now see one consistent number for both calls and texts.

### Scoped, not yet shipped
- Relationships tab (Book of Business) → Supabase migration. The tab is
  still backed by a Google Sheet; execution brief at
  `briefs/RELATIONSHIPS_SUPABASE_MIGRATION.md`.
