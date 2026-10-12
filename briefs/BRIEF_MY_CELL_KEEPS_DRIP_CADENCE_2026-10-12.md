# "My Cell" leads stay on the drip cadence (2026-10-12)

> **Status:** spec, approved by Ryan 2026-10-12. Built by a cloud session on a branch; merged, tested and deployed from the Mac mini.
> **Owner memo:** `../lead-pipeline/PROJECT_MEMO.md` (Leads tab / drip engine).

## Ryan's decision (verbatim intent)

> "I just want the lead to stay in the follow-up cadence. But every correspondence
> happens through my cell phone now. I wasn't trying to do a complete overhaul of
> this system. … If a lead has an email drip, being on my cell phone should have
> no effect on that. I just want the cadence to stay the same for follow-up,
> whether they're on my cell phone or they're not."

So the **"My Cell" flag changes the TRANSPORT of text sends, never the cadence.**
Nothing else about Follow Ups changes — snooze, Done, "No follow-up", the Next
Touch resolver and the worklist buckets all stay exactly as they are.

## What exists (do not rebuild)

- Flag: `leads.use_personal_cell` (bool, default false), written across the whole
  phone cluster by `app/api/leads/[id]/personal-cell/route.ts` (POST = on,
  DELETE = off).
- Card send path already honours the flag: `lib/leads.ts sendLeadSms` checks the
  cluster and sends via `sendLeadViaSidecar` (POST `${SIDECAR_URL}/send`, body
  `{ phone: <10 digits>, message }`, response `{ success, service?, error? }`,
  35 s timeout) instead of Twilio. Keep this as the reference behaviour.
- Click-to-call already presents Ryan's cell as caller ID for flagged leads
  (`app/api/leads/call/route.ts`). No change.
- Drip engine: `scripts/drip-engine.js`, hourly via launchd, **approval-gate mode**
  (`DRIP_AUTO_SEND` unset → false). It queues `drip_queue` rows; Ryan approves in
  Follow Ups; `drainApprovedQueue` sends on the next pass through
  `sendDripTouch` → `sendSms` (Twilio A2P) for `channel === "imessage"` and
  `sendDripEmail` (Gmail DWD) for `channel === "email"`.
- The engine already talks to the sidecar: `SIDECAR_URL` const (default
  `http://localhost:5799`) and `fetchIMessageHistory` (POST `/sync-imessage`).

## The problem

Flipping "My Cell" on currently **removes the lead from the cadence**:

1. `fetchEligibleLeads` in `scripts/drip-engine.js` has `.eq("use_personal_cell", false)`
   — flagged leads are never scheduled or drafted again.
2. The POST toggle route marks every pending/approved `drip_queue` row for the
   cluster `skipped` / `switched_to_personal_cell`.
3. `drainApprovedQueue` → `sendDripTouch` would send a flagged lead's text over
   Twilio (wrong line) if a row ever got through.
4. Side effect of (1): `lib/next-touch.ts` doesn't know the flag, so a flagged lead
   with a drip stamp shows a forecast + "Prepare" that the engine silently refuses.
   Removing (1) makes the forecast truthful again — **no resolver change needed.**

## Build (branch `cloud/my-cell-keeps-cadence`, no PR, no merge)

1. **`scripts/drip-engine.js` — eligibility.** Delete the
   `.eq("use_personal_cell", false)` filter (and its comment) in
   `fetchEligibleLeads`. Flagged leads schedule and draft like everyone else.

2. **`scripts/drip-engine.js` — never auto-send a flagged lead.** In the
   `if (AUTO_SEND)` branch of the per-lead processor, if the lead's cluster is
   flagged, fall through to the queue path instead (log
   `[drip] personal-cell lead → approval gate regardless of AUTO_SEND`). Today
   AUTO_SEND is off so this is a guard for the future, but it must exist.

3. **`scripts/drip-engine.js` — transport at send time.** Add
   `async function clusterUsesPersonalCell(sb, phone)` → `true` when any
   `leads` row with `caller_phone = phone` has `use_personal_cell = true`
   (mirror the check in `lib/leads.ts sendLeadSms`; by phone, not by row). Add
   `async function sendViaSidecar(phone, message)` that POSTs
   `${SIDECAR_URL}/send` with `{ phone: last10digits, message }`, 35 s
   `AbortController` timeout, and **throws** on non-OK / `success === false` /
   timeout with a clear message (`personal-cell send failed: …`). In
   `sendDripTouch`, for `channel === "imessage"`: if the cluster is flagged →
   `sendViaSidecar`, log `[drip] text → <phone> from personal cell (<service>)`;
   else the existing Twilio path. **Email channel is untouched** (Ryan: no effect).
   A throw already marks the `drip_queue` row `failed` with the message, which
   surfaces in the Failed bucket with Retry — that is the desired behaviour
   (never fall back to Twilio for a flagged lead).

4. **`app/api/leads/[id]/personal-cell/route.ts` — stop wiping the queue.**
   Remove the `drip_queue` → `skipped` sweep in POST and rewrite the file's
   header comment: the flag changes transport (texts from Ryan's cell via the
   sidecar, calls with his cell as caller ID) and the lead **stays on its drip
   cadence**; drips are approval-gated as always and never auto-send for flagged
   leads. DELETE is unchanged.

5. **`components/widgets/LeadsTab.tsx` — copy.** Update the two `title` strings
   and the badge tooltip (search `usePersonalCell`): drop "automated drips are
   paused" / "pauses automated drips, handle manually" / "switch back to the
   business line + drips". New wording along the lines of: badge → "Texts go out
   from your personal cell (iMessage); drips stay on cadence"; button on →
   "Texts go from your personal cell and Call shows your cell as caller ID —
   click to switch back to the business line"; button off → "Text from your
   personal cell (iMessage) + Call with your cell as caller ID — drip cadence
   unchanged".

6. **Tests.** Add `tests/drip-personal-cell.unit.test.ts` covering, with the
   Supabase client and `fetch` mocked: (a) `clusterUsesPersonalCell` true when
   any cluster row is flagged, false otherwise; (b) `sendDripTouch` on an
   `imessage` channel calls the sidecar and **not** Twilio when flagged, and
   Twilio when not; (c) a sidecar `success:false` throws and nothing is sent via
   Twilio; (d) `email` channel ignores the flag. If `drip-engine.js` isn't
   importable without side effects, extract the two new helpers plus
   `sendDripTouch` into `scripts/lib/drip-send.js` (CommonJS, required by the
   engine) and test that module — keep the engine's behaviour identical.
   `npx tsc --noEmit` clean; `npx vitest run` green.

## Out of scope (explicitly rejected or deferred by Ryan)

- No "every live lead must have a next touch" invariant, no safety-net sweep.
- "Done → No follow-up" stays a valid choice.
- No new personal-nurture campaign; no changes to `lib/next-touch.ts`,
  `app/api/follow-ups/route.ts`, `FollowUpsTab.tsx`, or the Relationships tab.
- No migrations.

## Acceptance

1. Flag a test lead "My Cell" that carries a drip stamp → next hourly pass queues
   its touch (visible in Follow Ups with a draft), no `skipped` rows written by
   the toggle.
2. Approve it → the drain sends through the sidecar from Ryan's cell; the
   `drip_queue` row is `sent`, `last_drip_sent_at` bumps, an outbound
   `drip_imessage` row is logged; nothing goes through Twilio.
3. Stop the sidecar, approve another → row becomes `failed` with
   `personal-cell send failed: …`; nothing goes through Twilio.
4. An email touch on a flagged lead sends exactly as before.
