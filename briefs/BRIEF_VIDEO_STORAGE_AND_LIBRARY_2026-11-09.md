# BRIEF — Video vault, clip library, mini housekeeping (Jobs 2 + 3, merged)

**Status:** v3 FINAL FOR APPROVAL (2026-11-09). Audited twice (deletion
safety; library design) after Ryan's "one job is collecting clips and the
other one is deleting them". Nothing built.
**Lives in:** `~/Projects/video-editor` (code), `~/Movies/VideoEditor` = `VE`
(working files), `mission-control` (heartbeat route, nightly backup,
migration), `~/bin` + `~/Library/LaunchAgents` (mini jobs).

## The model

**Drive is the vault. The mini is the workbench. Collect first, delete
last.** Every original goes to Drive once, in full, right after it lands
on the mini. The library is a searchable list of *moments* inside that
footage — no second copy of any video. One component (the keeper) is the
only thing that deletes video files, and only after re-checking Drive at
the moment of deletion.

**Build order inside this brief: A (collect + protect) → B (library) →
C (automatic clean-up).** The mini has ~65 GB free; nothing in C is
urgent, and C is built only after A and B have run on a real video.

## Facts (verified 2026-11-09)

- Footage: 152 video files, 6.25 GB, 3,357 s (≈1.9 MB/s) in 11 shoots,
  plus a stills folder (61 texted Quito photos, not in Photos). 134 clips
  vertical / 18 horizontal; ≥37 are 4:3. Only the 5 clips from 2024 are
  HDR; the rest are H.264 SDR.
- Six shoots have shoot reports (131 clips described). Undescribed: five
  early Halleck shoots (16 clips, 71 sheets) and 5 horizontal Severance
  clips.
- Both renderers cut from the **full source in source seconds**
  (`ve/cut/render.py:46-49`; `properties/limewood-dr/sample/build.py`).
  Frame-exact trimming needs ProRes at ~190 Mb/s (a 10 s clip ≈ 240 MB).
- Clip references are positional (`clip: 4`, `"D4"` = index into
  `shotlog.json`); `ve watch` rewrites the shotlog; `pulled.json` is
  already wrong (9 dead paths, a duplicate id, 4 files missing) and is
  written non-atomically. `ve pull` skips any id in it without checking
  the file exists.
- Nothing under `VE` is backed up (`mini-backup/backup.mjs` has no
  `~/Movies` source; `VE` is not a git repo): cut lists, shotlogs, paid
  shoot reports = 249 files, 4 MB, one copy.
- There is no standard cut list: `build.py` is bespoke; `timeline.json` is
  overwritten per variant; Severance uses `cut.yaml` + `take-map.json`.
- Scratch: `work/` and the larger `properties/<p>/.cache` (Severance
  1.95 GB, Quito 0.57 GB). A long-form build writes 15–25 GB of
  intermediates keyed by (clip, in, duration) and never pruned.
- Finals and drafts are indistinguishable on disk: all six local finals
  are byte-identical to Drive copies under other names.
- Drive: two folders named "Marketing" are shared with ryan@lrghomes.com
  — one owned by his personal account, one by an outside account; both
  uploaders take `files[0]` by name. Files in `Marketing/Videos` are owned
  by ryan@lrghomes.com. Limit 270 GiB (looks like a 9-seat pooled
  Workspace allowance shared with mail), 33 GB used. Drive keeps uploaded
  video bytes unchanged (md5 stable across rename/move). Files in this
  tree do get trashed (a Drafts folder is in trash now); trash purges
  after 30 days.
- Q's videos: 8 mp4s already in Drive `Marketing/Videos/Quocnam Luu 2024`
  (6 unique, md5-matched to `references/`); 1080p, 24 fps; several have
  burned-in titles/captions, other people's faces, and prices.
- `~/.openclaw/workspace` is live: the bridge launcher's PROJECT_DIR, the
  CRMS sidecar (`crms-sidecar.js:63-71`, incl. a real `Bugs/` folder) and
  the merge job's `node_modules` symlink all go through it. It is 0.15 GB
  and not in the nightly backup.
- `mini-heartbeat.sh` only upserts timestamps to Supabase every 60 s;
  alerts are sent by `app/api/mini/watch/route.ts` on state change.
- Worktrees: 43 left, 6.5 GB, of which 6.0 GB is `.next` in 9 of them;
  12 are "dirty" only from `__pycache__` / `esign/node_modules`; 7 are
  git-locked by the bridge.

## Phase A — collect + protect (no deletion code)

A1. **Pinned vault.** `Marketing/Videos/Library/` by folder **ID** (never
    by name); assert owner before every upload/verify. Fix
    `scripts/upload-draft.mjs` and `send-draft.mjs` the same way.
A2. **Footage to the vault, in full.** `Library/Footage/<shoot>/` gets
    every original right after the pull. Resumable, idempotent upload
    (look up by name + md5 before create), md5 check after. Backfill the
    11 shoots + stills folder (≈6.3 GB, minutes on this uplink).
A3. **One-copy originals** → vault, never auto-removed: narration
    recordings and takes, hand-trimmed music (`music/mixkit/*-hk.wav`),
    stills, footage sitting in property folders
    (`quito-rd/{disneyland,leftovers-and-demo-oct14,lighting-oct13}`).
    Q's videos: record their existing Drive ids, no re-upload.
A4. **Manifest** `VE/manifest.json` — file facts only: relative path,
    md5, size, class, Drive id, shoot, state (`local-only` → `in-vault`
    → `evicted`). Atomic writes + lock; mirrored to Drive; rebuildable
    from the vault alone (Drive path = local relative path). One-time
    adoption pass for what exists.
A5. **Stable clip ids.** Clip id = `<shoot>/<file stem>` + md5. Cut
    lists reference the id, not a number. `ve watch` merges into an
    existing shotlog. `ve pull`: "in pulled.json but file absent" =
    evicted → restore from the vault; atomic state write. Photos id
    becomes optional (Photos is not a safety basis).
A6. **Text backup.** Add `VE` text (cut lists, timelines, shotlogs, shoot
    reports, `plan.md`/`history.md`, manifest, catalog, `pulled.json`) to
    the nightly backup — one `add(...)`, skipping media, `work/`,
    `.cache/`. Also add `~/.openclaw/workspace` and untracked files in
    worktrees. Update `RESTORE_GUIDE.md`.
A7. **Low-space alert.** Heartbeat adds a `free_kb` column
    (`df -k /System/Volumes/Data`); the Vercel route alerts once per level
    change with hysteresis (warn < 25 GB, clears > 30; urgent < 10,
    clears > 15). Migration with RLS + deploy. Silent otherwise.
A8. **Weekly vault scrub** (launchd): list the vault, compare with the
    manifest; Telegram if a vaulted file is trashed/missing or the Drive
    pool is over 80 %. Runs more often than the 30-day trash purge.
A9. **Weekly tidy — non-video only**: delete `.next` in worktrees idle
    > 48 h; remove worktrees that are clean (treating `__pycache__`,
    `*.pyc`, `esign/node_modules` as junk), merged, unlocked-or-lock-pid-
    dead, not `protected()` (claude-remote-ctl.py), chat idle ≥ 7 days
    (recursive scan; no transcript folder → the worktree's own mtime);
    list ignored files first and refuse anything outside an allowlist;
    `git fetch` first; `npm cache clean --force`; `/private/tmp/ve-*`.
    One Telegram line naming idle worktrees that hold real uncommitted
    files. Move `tsx` into devDependencies (market-cycle runs `npx tsx`).
A10. **The bridge launcher stays where it is.** Do not remove
    `~/.openclaw`. (Repointing saves 0.15 GB and costs a bridge restart
    plus sidecar/merge restarts.) A6 backs it up instead.

## Phase B — the clip library

B1. **A library entry is a moment**: clip id + in/out + facets. No
    trimmed files. No length rule — a moment is the beat the describer
    marked; talk moments are sentence-bounded from the transcript;
    room-tone moments (speech-free ≥ 2 s) are added automatically.
B2. **Side-by-side = a pair recipe** (after clip + in/out, before clip +
    in, crop offsets, labels, which side carries the voice), rendered per
    video at that video's frame size. Backfill Limewood's 13 from
    `build.py` (free).
B3. **Facets, not folders**: house, stage, room/subject, shot type,
    people, shape (w×h, aspect, fps, HDR), speech/ambient, topic. Ryan's
    eight shelf names survive as saved searches. Stills are entries too.
B4. **Every described clip is filed automatically** by parsing
    `shoot-report.md` right after the describe helper (sync-sound recipe
    step 3, long-form step 3). Quality and problems are fields, never a
    gate — no "keepers" chosen for him. Add Room, People, Readable
    text/prices and Beats lines to `prompts/describe.md`; never
    hand-condense a report. No new step for Ryan.
B5. **Standard cut list.** Both renderers write `<output>.cutlist.json`:
    video, variant, shape, audience, published-where, code commit, inputs
    as clip id + in/out + role (picture / voice / before / music / still).
    Snapshot one per delivered version. Backfill from `build.py` (full,
    short, web) and Severance `cut.yaml`.
B6. **Used-in is computed** from cut lists, never typed: per range, per
    published video family (full + short + web = one), per platform
    (website viewers haven't seen YouTube). `same-shot` group id for
    near-duplicates. Lint: no moment in two consecutive videos on the
    same platform.
B7. **Flags, three-state, per range**: `clean` / `flagged` / `unchecked`
    for prices (any number or money word in the transcript, with quote +
    time — Whisper mis-hears numbers), profanity, address spoken, house
    status (owned / lead-only → needs his OK), someone else's face (who,
    when — information, never an automatic drop). A cut with
    `audience: website` fails the build on a flagged range.
B8. **Shape safety**: queries filter by the deliverable's shape; the
    renderer refuses a full-frame segment of the wrong shape unless it is
    a split.
B9. **Catalog files**: one moments file per shoot under `VE/library/`,
    compiled by `ve lib index`; `ve lib find --shape h --stage before
    --unused` returns text. Atomic writes + lock. Backed up by A6.
B10. **"Running low" → `VE/library/wanted.md`**, at most 3 asks: a bucket
    (stage × shape × shot type) with fewer than N unused moments, limited
    to what his next known location can supply plus location-free shots.
    Shown in `plan.md` when there's a planning session, else one line at
    the end of a delivery. Today's gap: unused horizontal B-roll ≈ 45 s.
B11. **His view** = contact sheets per saved search (`ve/overview.py`) in
    Drive `Library/`, on Telegram on request. No folder of clips to wait
    on.
B12. **Homes for non-property videos**: `VE/videos/<slug>/` + a Drive
    name map (letter video, topic videos).
B13. **Backfill** (AI usage, spread out): text-only pass turning the six
    existing reports into moments (est. 100–200k tokens, unmeasured);
    describe the 5 Halleck shoots + 5 Severance clips (est. 0.4–0.6M, 3
    helpers); Q's videos — Day in the Life, Off Market, Limewood Updates
    first (est. 0.35–0.5M), all six 0.5–0.7M.

## Phase C — the keeper (automatic clean-up; built last)

C1. **`video.json` per video**: state (`open` / `wrapped`), which files
    are finals, which shoots / references / music it uses, the rebuild
    command. The keeper deletes nothing in a video folder that the record
    doesn't class. Unknown = in use.
C2. **Scratch = `work/` + `.cache/`.** Cleared at wrap only after a
    rebuild-inputs check (cut list snapshot, take, shotlogs, music,
    sources local or in vault) passes; otherwise refuse. Each build
    prunes intermediates the current cut lists no longer reference.
C3. **Drafts** cleared at wrap when byte-identical in Drive and not
    listed as finals.
C4. **Eviction** of vaulted footage only when space is needed: shoot-level
    pins from `video.json`; an unreviewed shoot is pinned; ≥ 14 days since
    last recorded use (from `ve` events, not file access times); skipped
    while a render lock is held.
C5. **Delete-time check, every time**: re-fetch the Drive file by id and
    require fresh local md5 = Drive md5, same size, `trashed = false`,
    owner = ryan@lrghomes.com, parent chain reaches the pinned vault.
    Missing/unparsable manifest = delete nothing + alert.
C6. **`ve restore <video|shoot>`**: downloads to the exact original
    paths, md5-checked.
C7. **Budget**: scratch has its own allowance outside the footage cap;
    pre-flight before a long render (free ≥ estimated scratch + 30 GB);
    over budget with nothing evictable = alert, never delete.
C8. **Drive unreachable at wrap** → stop before any delete, record "wrap
    pending", retry, one Telegram alert.

## Decisions — answered by Ryan 2026-11-09

- D1. Severance working files + cache: **cleared** (his yes; `cuts/v1..v3/work`
  and `.cache`, ≈3 GB). Finals, `cut.yaml`, `take/` kept.
- D2. Backfill pacing: he asked "what old footage?" — explained (5 early
  Halleck shoots + 5 Severance clips never described; six described
  shoots → library entries; Q's six videos). Default: spread out, unless
  he says otherwise.
- D3. Emergency "free up space" button: **no** — C9 is dropped.

## What the audits changed vs draft v2

No trimmed library clips (library = moments over vault footage). No
rendered composites (pair recipes). No "keepers" (every clip filed).
Folders → facets. Vault pinned by ID. Delete-time Drive re-check + weekly
scrub. `video.json` so finals can't be mistaken for drafts. `.cache`
classed as scratch. Text + `~/.openclaw/workspace` into the nightly
backup. Low-space alert moved to the Vercel route. Worktree tidy rules
corrected (`.next`, junk, locks). "Remove `~/.openclaw`" dropped. Stable
clip ids and standard cut lists added. Phased so deletion is built last.
