# Mission Control — agent guide

Mission Control is the LRG Homes CRMS dashboard — Next.js, deployed on
Vercel at `mission-control-three-chi.vercel.app`.

## Project tracking lives OUTSIDE this repo

This repo's code spans several "projects." Work is tracked in per-project
memos in the sibling `PROJECTS/` folder — **not** in this repo:

- **[`../MEMO_INDEX.md`](../MEMO_INDEX.md)** — start here. The master index +
  the "where does this ship belong" triage table + the memo format spec.
- **`../lead-pipeline/`** — the **Leads tab**: Twilio capture, AI triage,
  drip engine, lifecycle, Follow Ups worklist, Campaign Performance.
- **`../comprehensive-relationship-management/`** — the **Relationships
  tab**: Book-of-Business outreach, daily cadence, enrichment.
- **`../lrg-public-web/`** — the public websites (`lrghomes.com` + landing).

Each project = `PROJECT_MEMO.md` (current state — read this first when
picking up cold) + `CHANGELOG.md` (append-only ship history).

> **Do NOT create a `CHANGELOG.md` or `PROJECT_MEMO.md` inside this repo.**
> Route every ship to the owning project's memo via the triage table in
> `../MEMO_INDEX.md`. (A repo-level `CHANGELOG.md` was created here by
> mistake on 2026-05-21 and reverted — don't repeat it.)

`briefs/*.md` — execution specs **do** live in this repo. That's the one
docs exception.

## When Ryan says "wrap"

"Wrap" is a defined procedure — see the canonical version in
[`../MEMO_INDEX.md`](../MEMO_INDEX.md) ("The Wrap procedure"). In short:

1. Finish + **verify** all in-flight work (build / test / deploy as
   appropriate) — nothing half-done.
2. Identify the owning project via the `../MEMO_INDEX.md` triage table.
3. Append a dated entry to that project's `CHANGELOG.md`.
4. Update that project's `PROJECT_MEMO.md` — the `📍 Where we left off`
   block, `Latest ships`, and the `Updated:` date.
5. Bump the project's "Last touched" date in `../MEMO_INDEX.md`.
6. Save durable learnings to agent memory
   (`~/.claude/projects/-Users-ryanlarocca/memory/`).
7. Commit + push.

## Repo conventions

- **Deploy:** production builds from `main` (Vercel auto-deploy). `tsc
  --noEmit` is the real gate — `next build`'s ESLint is
  `ignoreDuringBuilds`.
- **Concurrent agents** work this repo. Always check `git branch` /
  `git status` before committing; never `git add -A`.
- **Local dev:** see [`LOCAL_DEV.md`](./LOCAL_DEV.md).
- Cross-cutting infra (Mac mini sidecar, launchd, tunnels, chat.db) is
  documented in agent memory, not here.
