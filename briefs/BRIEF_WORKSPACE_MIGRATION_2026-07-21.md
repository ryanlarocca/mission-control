# Brief — Migrate LRG work out of `~/.openclaw/workspace` → `~/Projects`

**Date written:** 2026-07-18 (inventory verified this day)
**Execute:** Monday 2026-07-21, **before** reloading the campaign engine from weekend lockdown — migrate first, then bring the engine up from the new path.
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

**Unaffected (do not touch):** `ai.openclaw.gateway` (openclaw itself), `com.lrghomes.ngrok*`, `com.lrghomes.claude-remote*` (uses `~/bin`).

### Broken/zombie things to resolve during execution (found in inventory)

1. **com.lrghomes.lead-webhook is loaded and RUNNING (had pid) from `PROJECTS/_archive/lrg-homes-website/scripts/lead-webhook-server.js`** — a live service running out of an archive folder. There's also `com.lrghomes.webhook-manual` (exit 1) pointing at `workspace/lrg-homes-website`. Determine which one the www.lrghomes.com form intake actually depends on, promote the real one to a non-archive path, kill the other.
2. **Crontab entry is already dead:** `*/5 * * * * python3 …workspace/scripts/physiq-waitlist-notifier.py` — the script no longer exists (only its log remains). Delete the entry (or deliberately restore the script under `~/Projects/scripts/` if the waitlist notifier is still wanted).
3. **com.openclaw.chatdb.jesus / chatdb.oneshot** — one-shot extraction jobs from the Phase-2 era; almost certainly obsolete. Unload + delete rather than migrate.
4. **com.openclaw.nightly-bug-sweep** — last exit status 1, points at `workspace/scripts/nightly-bug-sweep-prompt.md`. Decide: migrate it to `~/Projects/scripts/` or retire it.

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
