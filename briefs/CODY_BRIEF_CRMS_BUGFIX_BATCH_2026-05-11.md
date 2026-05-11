# Cody Brief — Mission Control Bug Fixes + Features (Batch 2026-05-11)

**Codebase:** `PROJECTS/mission-control/` (Next.js 14 App Router, Supabase, Vercel, Mac mini sidecar, Twilio, OpenRouter/Haiku)
**Mode:** Read first, then edit. Do not guess at file layouts — every file referenced here exists. Confirm before changing.

---

## Pre-flight — do this before touching anything

1. Read `PROJECTS/mission-control/components/widgets/LeadsTab.tsx` end-to-end. You need to understand `expandedPhone`, how the card list is rendered, and how scroll/expand currently works.
2. Read `PROJECTS/mission-control/components/widgets/FollowUpTab.tsx` end-to-end. Find `FollowUpRow`, the fetch query, the Done button, and the Snooze button.
3. Read `PROJECTS/mission-control/app/api/leads/voice/route.ts` and `app/api/leads/sms/route.ts`. Find both the callback dedup branch for `+16502043247` AND the separate Google Ads landing branch for `+16506703914`. Confirm you can tell them apart.
4. Read `PROJECTS/mission-control/lib/leads.ts` — locate `CAMPAIGN_MAP` and confirm `+16502043247 → "Outbound"`.
5. `ls ~/Library/LaunchAgents/` and read every plist that looks project-related (sidecar, drip-engine, gmail-watch, cloudflared, etc.). Note their `Label`, `ProgramArguments`, `KeepAlive`, and `RunAtLoad`.
6. Read `TOOLS.md` at the workspace root (NOT inside mission-control) to match its formatting style before appending.

Only after the above, start coding.

---

## Item 1 — Callback preserves original source (bug)

**Files:** `app/api/leads/voice/route.ts`, `app/api/leads/sms/route.ts`

The callback dedup path triggers when a lead calls the outbound caller-ID (`+16502043247`) and an existing lead row for that phone exists within 30 days.

**Do:**
- In the matched-lead branch, read `source`, `source_type`, and `drip_campaign_type` from the existing row and use those when inserting the new inbound row, in place of `CAMPAIGN_MAP[twilio_number]`.
- If the existing row's `source` is null/empty, fall back to the CAMPAIGN_MAP default (current behavior).
- Apply the same fix in both `voice` and `sms` routes — they have parallel dedup logic. Don't fix one and miss the other.

**Do NOT:**
- Touch the `+16506703914` (Google Ads landing) branch. That has its own logic. If you can't cleanly tell the two branches apart, stop and re-read the file.
- Backfill historical rows. Forward-only.

**Verify:**
- Search the file for every spot the old (wrong) source/source_type/drip_campaign_type was being assigned in the callback path. Make sure all three fields are pulled from the existing lead, not just `source`.

---

## Item 2 — Filter "Anonymous" in Follow-up tab

**File:** `components/widgets/FollowUpTab.tsx` → `FollowUpRow` sub-component.

**Do:**
- Wherever `lead.name` is rendered, treat the literal string `"Anonymous"` (case-sensitive, matches Twilio's payload) the same as `null` — fall through to phone number display.
- Display-only fix. No DB writes, no migration.

**Watch out:**
- Item 3 builds on this. Make sure the "is the name usable?" check is a single helper (e.g. `displayName(lead)` or `isUsableName(name)`) so Item 3 can reuse it.

---

## Item 3 — Show name in Follow-up tab (cross-row name lookup)

**File:** `components/widgets/FollowUpTab.tsx`

The follow-up date often lives on an outbound-call row with `name = null`, but the same phone number has another row (inbound) with the real name. Stitch them.

**Do:**
- After the primary `recommended_followup_date` fetch, collect every `caller_phone` for leads whose name is null/Anonymous.
- Issue ONE batch Supabase query: `select caller_phone, name from leads where caller_phone in (...) and name is not null and name != 'Anonymous'`.
- Build a `Map<phone, name>` (first hit wins, or prefer most-recent — your call, just be consistent).
- When rendering each `FollowUpRow`, if the lead's name is missing, look it up by phone in that map.
- Email-only leads (no `caller_phone`): skip the lookup, render whatever exists, don't crash.

**Watch out:**
- One batch query, not N queries in a loop. Use `.in('caller_phone', phones)`.
- Don't mutate the original leads array — derive a display value.

---

## Item 4 — Tap name → open lead card in Follow-up tab

**Files:** `components/widgets/FollowUpTab.tsx`, `app/(dashboard)/leads/page.tsx`, `components/widgets/LeadsTab.tsx`.

**Do:**
1. In the leads page/tab, on mount read `useSearchParams()` for `phone` (and optionally `email`). If present, set `expandedPhone` to that value and scroll the matching card into view (use `ref` + `scrollIntoView({ behavior: 'smooth', block: 'center' })`).
2. If `expandedPhone` is already URL-driven elsewhere, just confirm and reuse — don't add a parallel mechanism.
3. In `FollowUpTab.tsx`, wrap the name/phone display in a clickable element (button or `Link`). `useRouter().push('/leads?phone=' + encodeURIComponent(caller_phone))`.
4. Email-only leads: if Leads tab supports `?email=`, use it. Otherwise render the row non-clickable (disabled style, no pointer cursor) rather than navigating to a broken state.

**Watch out:**
- `encodeURIComponent` the phone — `+` will get mangled otherwise.
- Don't break existing keyboard/click handlers on the row (Done, Snooze) — make the name region its own click target, stopPropagation if needed.
- App Router: client component needs `'use client'` and `useSearchParams` — confirm the file already has it.

---

## Item 5 — Mac mini reset tool

**Files to create:** `scripts/mac-mini-reset.sh`, possibly a new launchd plist for the sidecar.
**File to update:** `TOOLS.md` at the **workspace root** (not the mission-control subfolder).

**Investigate first:**
- `ls -la ~/Library/LaunchAgents/` and read each plist. Identify the ones for: sidecar (port 5799), drip-engine, cloudflared tunnel, Gmail watch renewal.
- Note the exact `Label` of each — the script will reload by label/path.
- Check whether the sidecar plist has `KeepAlive=true` and `RunAtLoad=true`. If not, that's the missing piece.

**Script must:**
1. For each project-owned plist in `~/Library/LaunchAgents/`: `launchctl unload <path>` then `launchctl load <path>`. Identify project plists by a clear naming prefix (e.g. `com.lrghomes.*` — match the existing naming convention). Don't blanket-reload every plist in the directory.
2. Health-check each service after load:
   - Sidecar: `curl -sf http://localhost:5799/health` (or the real health endpoint — read the sidecar code first).
   - Cloudflare tunnel: `cloudflared tunnel info <name>` or curl the public URL.
   - Drip engine: `launchctl list | grep <label>` for last exit status + confirm PID is alive.
   - Gmail watch: check the renewal log file's last-modified timestamp.
3. Print a clearly-formatted summary table: service name, status (`[OK]` / `[FAIL]`), detail.
4. Exit 0 if all OK, non-zero if any FAIL.

**KeepAlive plist:**
- If the sidecar plist lacks `KeepAlive=true`, create/update it so reboots no longer require manual intervention.
- Follow the naming convention of existing project plists.

**TOOLS.md entry:**
- Append one line in the existing format: path `PROJECTS/mission-control/scripts/mac-mini-reset.sh`, description "Reloads all Mac mini project services after reboot and prints health summary."

**Watch out:**
- **Do not hardcode the Mac mini's LAN IP anywhere.** If you find an existing config that does (`192.168.x.x` or `10.x.x.x`), leave it alone but add a `# TODO: Ryan — hardcoded LAN IP here, should be tunnel URL` comment and flag it in your final report.
- `launchctl unload` on a not-loaded plist errors — use `2>/dev/null || true` to keep the script idempotent.
- Don't `sudo` anything. User-level LaunchAgents only.

---

## Item 6 — Follow-up Done → hybrid (recent-call detect + interval picker)

**File:** `components/widgets/FollowUpTab.tsx`

**Behavior on "Done" tap:**

1. Query Supabase: any row where `caller_phone = lead.caller_phone` AND `lead_type IN ('call', 'voicemail')` AND `created_at > now() - interval '60 minutes'`. Use `.limit(1).select('id')` — cheap check.
   - **YES (recent call):** MC click-to-call just fired, recording is in flight, `analyzeCallTranscript` will set the next date. Clear `recommended_followup_date` + `followup_reason`. Show a brief toast: `"Logged — AI will set your next follow-up"`. Done.
   - **NO:** Show an inline interval picker directly below the row.
2. Inline picker options: `1 week · 1 month · 3 months · 6 months · No follow-up`. Pill buttons, horizontal row, wraps on mobile.
3. Tap an interval → PATCH `recommended_followup_date = today + interval`, `followup_reason = "Manual — <label>"` (e.g. `"Manual — 3 months"`). The PATCH handler already supports both fields — verify before touching it.
4. "No follow-up" is the ONLY option that clears `recommended_followup_date` to null.

**Watch out:**
- Picker must be inline, not a modal or sheet. Mobile-first.
- `followup_reason` must always be set when date is set — the follow-up banner needs the text.
- Use local timezone for date math. Check for an existing date helper before importing a new library.
- "Done" must NEVER silently null `recommended_followup_date` without (a) detected recent call OR (b) explicit "No follow-up" tap.
- Existing Snooze button: keep if working, consolidate if now redundant — document the decision in the commit message.

---

## Wrap-up checklist

1. `cd PROJECTS/mission-control && npx tsc --noEmit` — zero errors required.
2. `npx vercel deploy --prod` from `PROJECTS/mission-control/`.
3. Update `PROJECTS/lead-pipeline/PROJECT_MEMO.md` with a dated note covering all six items shipped.
4. Append the `mac-mini-reset.sh` entry to `TOOLS.md` at the workspace root.
5. Commit with a clear message.

---

## General gotchas

- All Supabase queries from FollowUpTab/LeadsTab are client-side (anon key + RLS). Confirm new queries (cross-row name lookup, recent-call check) are allowed by existing policies.
- Don't introduce new dependencies unless necessary — the repo already has what you need.
- When in doubt about a file's current behavior: read it. Don't pattern-match from memory.
- If anything in this brief contradicts what you find in the code, flag it in your final report rather than guessing.
