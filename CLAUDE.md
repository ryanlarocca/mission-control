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

## The Board — Ryan's one list of everything in motion

`/board` in Mission Control (table `board_items`) holds one card per open
thread: deals, taxes, videos, admin, subscriptions. Lanes: **you** (Your
move) · **waiting** (Waiting on someone) · **me** (I'm handling); done cards
show for 7 days. Every chat keeps it current:

```
node scripts/board.mjs list                     # read it when Ryan asks "where am I at" / starts a day
node scripts/board.mjs add --key <slug> --title "..." --next "..." --lane you|waiting|me \
     [--waiting-on "..."] [--due YYYY-MM-DD] [--note "1:30 PM"] [--tag Deal] [--link URL]
node scripts/board.mjs update <key> --next "..." --lane waiting   # when something moves
node scripts/board.mjs done <key>
```

- **"Throw it on the board"** = `add`. Don't wait to be asked: any new thread
  with a next step (a promise, a deadline, a follow-up, waiting on someone)
  gets a card **in the same turn**, and news on an existing one updates it.
- Reuse the card's `--key` (stable slug like `amex-swap`, `bieber-occupants`)
  so the next chat updates the same card instead of adding a duplicate.
- **No lead follow-ups on the Board** (Ryan, 11-20): calling/texting a seller,
  agent or contact back lives in Follow Ups / Relationships (the judge sets
  those dates). The Board is for his own projects, admin, money, deals in
  escrow, videos, marketing work and decisions.
- iPhone reminders still go through the sidecar; the board is the overview,
  not a replacement for them.

## Looking up someone's message — texts first, automatically

When Ryan references a person's message, text, pitch, deal, or "what X
sent me", check his **recent texts first**, before memory, Supabase or
Gmail. One command, no fan-out:

```
node scripts/pile/ask.mjs recent --days 7        # who texted him lately (add --unsaved for unknown numbers)
node scripts/pile/ask.mjs person "<name>" --since <date>   # one person; falls back to unsaved threads that mention the name
```

Go to email only when he mentions email ("my inbox", "forwarded", …).
Say in one line what you're checking before you search so he can
redirect early. (2026-11-03: ten steps of searching before "check my
texts" — don't repeat it.)

## When Ryan says "wrap"

"Wrap" is a defined procedure — see the canonical version in
[`../MEMO_INDEX.md`](../MEMO_INDEX.md) ("The Wrap procedure"). In short:

1. Finish + **verify** all in-flight work (build / test / deploy as
   appropriate) — nothing half-done.
2. Route each thing that moved via the `../MEMO_INDEX.md` triage table:
   a system → its project memo; a deal → `../deals/<street>.md`;
   a rule, lesson or person → agent memory.
3. Append dated entries: project `CHANGELOG.md` / deal `## Log`.
4. Rewrite each touched memo's `📍 Where we left off` (Now ≤ 5 lines;
   older text → `WHERE_WE_LEFT_OFF_ARCHIVE.md`) + `Updated:`, and each
   touched deal's `## Status`.
5. Bump "Last touched" in `../MEMO_INDEX.md`.
6. Save durable learnings to agent memory — one folder:
   `~/.claude/projects/-Users-ryanlarocca-Projects-PROJECTS-mission-control/memory/`
   (the others are symlinks to it).
7. Commit + push this repo; commit the `~/Projects` repo.
8. Run `node scripts/wrap-check.mjs` — it verifies all of the above,
   fast-forwards the main checkout, refreshes the Projects page and
   starts a silent Drive backup. Done when it says **All clear**.

## Repo conventions

- **Deploy:** production builds from `main` (Vercel auto-deploy). `tsc
  --noEmit` is the real gate — `next build`'s ESLint is
  `ignoreDuringBuilds`.
- **Concurrent agents** work this repo. Always check `git branch` /
  `git status` before committing; never `git add -A`.
- **Local dev:** see [`LOCAL_DEV.md`](./LOCAL_DEV.md).
- Cross-cutting infra (Mac mini sidecar, launchd, tunnels, chat.db) is
  documented in agent memory, not here.
