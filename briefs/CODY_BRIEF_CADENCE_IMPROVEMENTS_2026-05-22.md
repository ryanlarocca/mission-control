# Cody Brief — Cadence System Improvements
**Date:** 2026-05-22
**Project:** `mission-control` — lead drip engine
**Status:** Part 1 already shipped today; Part 2 is what needs building

---

## Background

Ryan surfaced a class of cadence bugs where the drip engine was firing the next touch immediately after a manual action (send, email, call). Root cause: several outbound code paths weren't stamping `last_drip_sent_at`, which is the single cadence clock the engine uses.

A larger design conversation surfaced a second issue: the engine was treating engaged leads (leads who've actually talked back) the same as cold leads in terms of cadence timing — chasing them every 48-168h even after a real conversation.

---

## Part 1 — Already shipped (commit today)

Three code paths now call `registerManualTouch` after a successful outbound action, stamping `last_drip_sent_at` and canceling any queued drip:

1. `app/api/leads/send/route.ts` — manual SMS from the lead card
2. `app/api/leads/[id]/send-email/route.ts` — manual email from the lead card
3. `app/api/leads/drip-queue/route.ts` — when the approve flow auto-skips a stale drip (`stale_after_human_reply`), it now stamps the clock so the UI forecast doesn't show the next touch as immediately overdue

These are already deployed. No further action needed on Part 1.

---

## Part 2 — Needs building: 14-day floor for engaged leads

### The problem

When Ryan has had a real interaction with a lead (they called back, replied to a text, or had a conversation), the engine currently queues the next cold-sequence touch on the original interval — could be 72h or 168h. That's too aggressive for someone Ryan is actively working.

The engine already computes `responsiveness.state` on every pass using `extractResponsivenessSignals`. States:
- `first_contact` — Ryan hasn't reached out yet
- `never_responded` — Ryan has reached out, lead has never replied (voicemail-only callbacks land here — the lead called Ryan's number but Ryan hasn't reached a real conversation, so no genuine reply)
- `gone_quiet` — lead replied earlier but has gone silent
- `engaged` — lead replied within the last 7 days

The problem: `engaged` and `gone_quiet` states already shift the CONTENT tone (good), but the TIMING doesn't change at all.

### The fix

In `processLead` in `scripts/drip-engine.js`, move the `extractResponsivenessSignals` call from line 1232 (currently after the timing check) to just before the `sinceLast < entryHoldMs` check at line 1219. Then apply a minimum floor when the lead is engaged or gone quiet.

`entryHoldMs` (line 1214) is the computed required delay in ms: normally `nextTouch.delayHours * 3600 * 1000`, but for touch #1 of a non-missed-call lead it's `max(touchDelay, campaign.entryDelayHours)`.

```js
// 1. Move the existing extractResponsivenessSignals call to before line 1219.
//    Do NOT add a second call — just relocate the one that was at line 1232.

const ENGAGED_MIN_DELAY_MS = 14 * 24 * 3600 * 1000  // 14 days

// 2. After computing entryHoldMs, apply the floor (skip for long_term_nurture —
//    those intervals are already 60-180 days):
const effectiveHoldMs = (
  lead.drip_campaign !== 'long_term_nurture' &&
  (responsiveness.state === 'engaged' || responsiveness.state === 'gone_quiet')
)
  ? Math.max(entryHoldMs, ENGAGED_MIN_DELAY_MS)
  : entryHoldMs

// 3. Replace the existing check:
//   if (sinceLast < entryHoldMs)
// with:
//   if (sinceLast < effectiveHoldMs)
//   return { skipped: `not_due (need ${(effectiveHoldMs - sinceLast) / 3600000 | 0}h more)` }
```

**Important:** `never_responded` leads are unaffected — they stay on cold cadence (48h/72h/168h). The floor only applies when the lead has genuinely replied.

**Performance note:** Moving `extractResponsivenessSignals` earlier means it runs even for leads that get skipped by the timing check. At current volume (~50-100 active leads) this is fine — flag it in the commit message so it's on record.

### No new investigation needed

The fix is a relocation, not a duplication. `extractResponsivenessSignals` already runs in `processLead` — just move it above the timing check. See code snippet above.

---

## Optional Part 3 — Hold drip if upcoming call follow-up is set

Lower priority, Ryan's call whether to build this.

If `recommended_followup_date` is set on a lead's cluster and is in the future, it means Ryan has a call scheduled. Firing a drip text right before that call is awkward. The engine could check:

```js
if (lead.recommended_followup_date && new Date(lead.recommended_followup_date) > new Date()) {
  return { skipped: 'upcoming_call_followup' }
}
```

The "Done" action already calls `registerManualTouch` which cancels any pending drip, so this is purely about preventing the drip from firing before the call happens. Current behavior is: both show up as due on the same day, Ryan does the call, marks Done, drip is consumed. That's fine — this is just polish.

**Investigation needed:** In the leads table, a single lead is a cluster of rows sharing the same `caller_phone` (or `gmail_thread_id`). `fetchEligibleLeads` returns one row per cluster — the most-recent inbound. `recommended_followup_date` lives on the cluster's row in the `lead_clusters` table (or a related table — grep for `recommended_followup_date` to confirm). The engine's `lead` object fetched by `fetchEligibleLeads` may not join that table. Check the SELECT in `fetchEligibleLeads` and add a join or subselect if needed.

---

## Files to touch

| File | Change |
|------|--------|
| `scripts/drip-engine.js` | Move `extractResponsivenessSignals` call earlier in `processLead`, add 14-day floor logic |
| `scripts/drip-engine.js` | (Optional) Add `recommended_followup_date` to `fetchEligibleLeads` SELECT, add hold check |

No schema changes. No frontend changes. No lib changes.

---

## Cadence design decisions settled (don't revisit)

- **One clock** (`last_drip_sent_at`) — every outbound action stamps it. Already enforced by Part 1.
- **No track-switching** — don't auto-switch to `long_term_nurture` based on engagement. LTN stays a manual button for leads who explicitly said "not now, 1-2 years."
- **No buttons** for cold→warm flip — use observable signals only.
- **`never_responded`** (voicemail-only, no reply since first outbound) stays on cold cadence. Correct behavior.
- **`engaged`/`gone_quiet`** get a 14-day minimum delay. That's the only behavioral change.
