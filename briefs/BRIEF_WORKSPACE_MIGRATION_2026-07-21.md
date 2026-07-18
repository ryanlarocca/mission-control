# Brief — Migrate LRG work out of `~/.openclaw/workspace` → `~/Projects`

> ## ✅ EXECUTED 2026-07-18 (Ryan: "why wait?")
> Ran same-day instead of Monday — campaign engine was already unloaded, weekend traffic lowest.
> **All phases complete except:** campaign engine stays unloaded until Monday per its own
> weekend-lockdown plan (load it from `~/Library/LaunchAgents/` — plist already repointed);
> symlink bake until ~2026-08-01 (then Phase 5 removal); Ryan's items: `crontab -r`,
> Telegram round-trip test with openclaw, one live personal-cell send.
> **Verified 2026-07-18:** all 13 jobs reloaded from `~/Projects` — Next.js Ready on :3001,
> sidecar live on :5799, Cloudflare tunnel registered, localtunnel up, sidecar-URL updater
> pushed to Vercel, gmail watch renewed on all 8 mailboxes (exp 7/25), drip engine ticked
> (all skips = not_due, correct), reply-detection/sms-sync/orphan-rescue/heartbeat/boot-check
> all clean, gateway + ngrok untouched. Backups: `~/workspace-pre-migration-2026-07-18.tar.gz`
> (274 MB), `~/LaunchAgents.bak-2026-07-18/`. Memory dirs copied to `-Users-ryanlarocca-Projects-*`
> keys. New git repo at `~/Projects` (memos); old workspace repo committed the move.

**Date written:** 2026-07-18 (inventory verified this day)
**Executed:** same day — see banner above. The plan below is the as-run record.
**Decisions locked (Ryan, 2026-07-18):** new home is `~/Projects`; scope is **all LRG work + infra** (openclaw keeps only its own agent files and becomes an alert system); plan-first execution.

---

## End state

- `~/Projects/PROJECTS/` — mission-control, all project memos, lrghomes-landing (exactly the tree that exists today, moved wholesale so every relative link keeps working).
- `~/Projects/physiq-app/`, `~/Projects/lrg-homes-website/`, `~/Projects/scripts/` (LRG infra scripts), `~/Projects/logs/` (LRG job logs).
- `~/.openclaw/workspace/` keeps only openclaw's agent files (SOUL.md, MEMORY.md, HEARTBEAT.md, etc.) + **symlinks** at each moved folder's old path, left in place for a ~2-week bake, then removed.
- All launchd plists, crontab, runtime code, Claude memory, and memo cross-references point at `~/Projects`.
- A new git repo at `~/Projects` tracks the memos + scripts (nested code repos stay their own repos). The old workspace repo (last LRG commit `b64a056`) stays as history — no more LRG commits to it.

## Verified inventory — what points at the workspace today

### launchd jobs to rewrite (13)

Path fix for all: `s|/Users/ryanlarocca/.openclaw/workspace|/Users/ryanlarocca/Projects|` — **in `~/Library/LaunchAgents/` AND in the repo copies at `mission-control/infrastructure/launchd/`** (source of truth for reinstalls).

| Plist | References |
|---|---|
| com.lrghomes.campaign-engine | `PROJECTS/mission-control` (currently unloaded — weekend lockdown) |
| com.lrghomes.crms-reply-detection | `PROJECTS/mission-control` |
| com.lrghomes.drip-engine | `PROJECTS/mission-control` |
| com.lrghomes.gmail-watch-renewal | `PROJECTS/mission-control` |
| com.lrghomes.orphan-recording-rescue | `PROJECTS/mission-control` |
| com.lrghomes.outbound-sms-sync | `PROJECTS/mission-control` |
| com.lrghomes.personal-cell-heartbeat | `PROJECTS/mission-control` |
| com.lrghomes.mission-control | `PROJECTS/mission-control` + `node_modules/.bin/next` + `workspace/logs/mission-control.log` |
| com.lrghomes.boot-check | `workspace/scripts/boot-check.sh` + `workspace/logs/` |
| com.lrghomes.lead-tunnel | `workspace/lrg-homes-website/logs/` |
| com.openclaw.crms.sidecar | `PROJECTS/comprehensive-relationship-management/phase2/crms-sidecar.js` + logs |
| com.openclaw.crms.merge | `PROJECTS/comprehensive-relationship-management/scripts/phase5-merge-messages.js` |
| com.openclaw.crms.update-sidecar-url | `workspace/scripts/update-sidecar-url.sh` + `workspace/logs/` |
| com.openclaw.crms.cloudflare-tunnel | `workspace/logs/` (log path only) |
| com.openclaw.localtunnel.missioncontrol | `workspace/logs/` (log path only) |

**Unaffected (do not touch):** `ai.openclaw.gateway` (openclaw itself), `com.lrghomes.claude-remote*` (uses `~/bin`). (`com.lrghomes.ngrok*` was retired same-day post-migration — its only tunnel served the dead lead-webhook.)

### Broken/zombie things — ✅ RESOLVED 2026-07-18 (ahead of migration)

All four investigated and retired on 2026-07-18 (Ryan's call — "shut down what we aren't using"); full forensics in `lead-pipeline/CHANGELOG.md` (2026-07-18 entry). Summary: the lead-webhook chain was the landing page's "temp until Twilio A2P approved" AppleScript-SMS side-channel, obsolete since May 21 and serving only spam bots; webhook-manual was a crash-looping duplicate (623 MB log, deleted); nightly-bug-sweep failed nightly on expired OAuth; chatdb one-shots were Phase-2 relics. **Retired: `com.lrghomes.lead-webhook`, `com.lrghomes.webhook-manual`, `com.lrghomes.lead-tunnel`, `com.openclaw.nightly-bug-sweep`, `com.openclaw.chatdb.jesus`, `com.openclaw.chatdb.oneshot`** — plists archived in `~/Library/LaunchAgents-retired-2026-07-18/` (+ crontab backup). These jobs and their rows above/below **no longer need migrating** — skip them in every phase.

Still open for Ryan (TCC blocks agent crontab writes): run `crontab -r` in his own Terminal to drop the dead physiq-waitlist entry. Optional: delete `MAC_MINI_LEAD_WEBHOOK_URL` / `MAC_MINI_WEBHOOK_SECRET` from the lrghomes-landing Vercel project.

### Runtime code with a hardcoded workspace path

- `mission-control/app/api/crms/generate/route.ts:7` — `DATA_DIR = "/Users/ryanlarocca/.openclaw/workspace/PROJECTS/comprehensive-relationship-management/data"`. Used by the locally-hosted instance (:3001). Change to the `~/Projects` path — better, read from an env var with the new path as default. `tsc --noEmit`, commit, and redeploy/restart the local instance.

### Claude Code memory dirs (path-keyed — must be re-keyed by copy)

- `~/.claude/projects/-Users-ryanlarocca--openclaw-workspace-PROJECTS-mission-control/memory/` → copy to `-Users-ryanlarocca-Projects-PROJECTS-mission-control/memory/`
- `~/.claude/projects/-Users-ryanlarocca--openclaw-workspace/memory/` → copy to `-Users-ryanlarocca-Projects/memory/` (if sessions will be launched from `~/Projects`)
- The user-root store `~/.claude/projects/-Users-ryanlarocca/memory/` is path-independent — unaffected.
- Leave the old dirs in place until the bake period ends (harmless), then delete.
- After copying, fix workspace paths **inside** the memory files (e.g. `physiq-app-location-and-ops.md` points at `~/.openclaw/workspace/physiq-app`).

### Docs / memos with live workspace paths

- `PROJECTS/MEMO_INDEX.md` — the memory-dir heads-up line and wrap step 7 ("commit the workspace repo `~/.openclaw/workspace`") **must** be rewritten to point at the new `~/Projects` repo.
- `PROJECTS/physiq/PROJECT_MEMO.md` — references the PWA's workspace path.
- Historical mentions in changelogs and old CODY briefs: **leave them** — they're records, not live pointers.

## Openclaw continuity (verified 2026-07-18 — Ryan's explicit requirement: openclaw must keep working)

Ryan's directive: openclaw stays alive as the **alert system**; it may pull moved files "from somewhere else" — that's exactly what the symlinks provide. Audit of openclaw's own brain (`~/.openclaw/` outside the workspace):

- **`openclaw.json` references only the workspace root** (`~/.openclaw/workspace`) — which does not move. No config change needed.
- **All openclaw cron jobs are `enabled: False`** (Haiku Heartbeat, Agent Email Daily Send, Redfin scans, COI outreach, DM lead ingestion, bug digest — the whole list is dormant, superseded by the launchd/Vercel systems). The paths they reference are in `ACTIVE_SKILLS/` (staying put) or already-deleted folders (`agent-emails/`, `scripts/heartbeat-lead-ingestion.py` — gone). Nothing to migrate; do NOT re-enable any of them.
- **`ai.openclaw.gateway` launchd job**: untouched by this migration.
- Session transcripts under `agents/*/sessions/` mention old paths — historical records, harmless.
- The symlinks (Phase 2) guarantee that anything unaudited inside openclaw that reaches for `workspace/PROJECTS`, `workspace/physiq-app`, or `workspace/lrg-homes-website` still resolves.

**Openclaw verification step (add to Phase 4):** confirm `ai.openclaw.gateway` is still running (`launchctl list | grep gateway`), then message the openclaw agent in Telegram and get a reply; confirm it can read a file through a symlinked path (e.g. ask it to read `~/.openclaw/workspace/PROJECTS/MEMO_INDEX.md`).

## Execution plan

### Phase 0 — Prep (~10 min)
1. Snapshot: `tar` the workspace excluding `node_modules`/`.next` into `~/workspace-pre-migration-2026-07-21.tar.gz`; also `cp -R ~/Library/LaunchAgents ~/LaunchAgents.bak-2026-07-21`.
2. Clean git states: commit/stash anything dirty in `mission-control` (check for the untracked gym-tracker files — they move with the folder either way, but commit them to `feature/gym-tracker-prototype` first if Ryan has signed off) and commit the workspace repo.

### Phase 1 — Quiesce (~5 min)
`launchctl unload` every `com.lrghomes.*` and `com.openclaw.crms.*` / `chatdb.*` / `localtunnel.*` / `nightly-bug-sweep` job (gateway + ngrok stay up). Verify with `launchctl list | grep -Ei "lrghomes|openclaw"` — only `ai.openclaw.gateway` and ngrok should remain. Downtime while quiesced: local :3001 instance, iMessage sidecar (personal-cell texting), tunnels, form webhook. **Vercel prod and Twilio→Vercel lead capture are unaffected.**

### Phase 2 — Move + symlink (~10 min)
```
mkdir -p ~/Projects ~/Projects/logs
mv ~/.openclaw/workspace/PROJECTS        ~/Projects/PROJECTS
mv ~/.openclaw/workspace/physiq-app      ~/Projects/physiq-app
mv ~/.openclaw/workspace/lrg-homes-website ~/Projects/lrg-homes-website
mkdir -p ~/Projects/scripts   # move the LRG ones: boot-check.sh, update-sidecar-url.sh, text-lead.mjs, nightly-bug-sweep-prompt.md
ln -s ~/Projects/PROJECTS        ~/.openclaw/workspace/PROJECTS
ln -s ~/Projects/physiq-app      ~/.openclaw/workspace/physiq-app
ln -s ~/Projects/lrg-homes-website ~/.openclaw/workspace/lrg-homes-website
```
Leave everything else in the workspace (SOUL.md, ACTIVE_SKILLS, CORE, etc. — openclaw's own). Ambiguous folders (`weight-tracker`, `main`, `Bugs`, `lrg-homes-website` inside `PROJECTS/_archive`) — triage at execution; default is leave-in-place, nothing depends on them per the inventory.

### Phase 3 — Rewrite references (~20 min)
1. `sed -i ''` the 13+ plists in `~/Library/LaunchAgents/` (backup already taken) and the copies in `mission-control/infrastructure/launchd/`.
2. Fix `app/api/crms/generate/route.ts` DATA_DIR; `tsc --noEmit`; commit + push (Vercel deploys; also restart local instance later in Phase 4).
3. Fix crontab (delete dead physiq entry).
4. Copy Claude memory dirs to new keys; fix paths inside memory files.
5. Fix live paths in `MEMO_INDEX.md` + `physiq/PROJECT_MEMO.md`.
6. `git init ~/Projects` with a `.gitignore` (node_modules, logs, `archive/`, data exports, nested repos are auto-excluded by their own `.git`); initial commit: "migrated from ~/.openclaw/workspace repo @ b64a056 — history lives there".

### Phase 4 — Reload + verify (the real gate, ~30 min)
Reload each job and verify by **observed behavior, not clean logs** (the Google Voice lesson: synthetic checks pass while the real path is dead):

| Job | Verification |
|---|---|
| mission-control (local) | `curl -s localhost:3001` 200; new log lines in `~/Projects/logs/mission-control.log` |
| crms.sidecar | health endpoint / log heartbeat; then one real personal-cell send from the Relationships tab |
| cloudflare-tunnel + update-sidecar-url | tunnel log shows connection; sidecar URL reachable from Vercel prod (send path works end-to-end) |
| lead-tunnel / localtunnel | tunnel URLs respond |
| lead-webhook (post-cleanup) | submit the real www.lrghomes.com form → lead row + Telegram alert |
| drip-engine | trigger one manual run; `[drip-result]` line in log; hourly tick fires within the hour |
| gmail-watch-renewal | manual run: renewal lines for **all 7** GV mailboxes |
| personal-cell-heartbeat | manual run exits 0, timestamps bump |
| outbound-sms-sync / orphan-recording-rescue / crms-reply-detection / boot-check | one manual run each, exit 0 |
| campaign-engine | load LAST, per the weekend-lockdown exit plan; verify its first tick per `agent-email-v2` memo |
| **End-to-end smoke** | call/text a lead line → lead appears in Leads tab + Telegram alert; that exercises webhook → Vercel → DB → alert with zero local-path involvement, confirming nothing else regressed |

### Phase 5 — Bake + finish (~Aug 4)
- Symlinks stay 2 weeks. Then rename each (`mv PROJECTS PROJECTS.off`) for 24–48 h; if nothing breaks, delete symlink + old Claude memory dirs.
- Wrap: changelog entries to owning memos, bump MEMO_INDEX, note in agent memory that migration completed.

### Rollback
Everything is `mv` + text edits: reverse the moves, restore `~/LaunchAgents.bak-2026-07-21`, reload. The Phase-0 tar is the belt-and-suspenders copy.

## Open questions for execution day
1. lead-webhook `_archive` zombie — which webhook server is the real form intake?
2. Keep or kill: nightly-bug-sweep, chatdb one-shots, physiq waitlist notifier?
3. Has Ryan signed off on the gym-tracker prototype (commit it before or after the move)?
