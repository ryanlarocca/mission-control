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

## The Board — Ryan's project board (NOT a to-do list)

`/board` in Mission Control (table `board_items`) has **one card per
project**: a deal (261 Bieber flip), a dispute (Mercedes FTB), a lawsuit, a
video, a mailer, a system build, the Amex swap. Each card = project name +
one-line status · next step + whose move. Lanes: **you** (Your move) ·
**waiting** (Waiting on someone) · **me** (I'm handling); finished projects
show under Done for 7 days.

**Never put small tasks on it** (Ryan, 11-20: "This is not a reminders list.
This is a project management file."): no "print the packet", "pay the
property tax / mortgage / loan payment", "call this guy", "cancel this
trial", no lead follow-ups (those live in Follow Ups / Relationships). Tasks
go on iPhone Reminders (sidecar) or inside the project's notes; the card's
status line just reflects where the project stands.

```
node scripts/board.mjs list
node scripts/board.mjs add --key <project-slug> --title "Project name" --next "status · next step" \
     --lane you|waiting|me [--waiting-on "..."] [--due YYYY-MM-DD] [--tag Deal] [--link URL]
node scripts/board.mjs update <key> --next "..." --lane waiting    # when the project moves
node scripts/board.mjs done <key>     ·   remove <key>
```

- **New cards only when Ryan asks** (Ryan, 11-21: "I'll tell you when I want
  that from now on"). Never add a card on your own initiative. News on a
  project that already has a card → update its status line / lane / key date
  in the same turn.
- **When a project moves, do both, every time** (Ryan, 11-20): (1) set or
  adjust the iPhone reminder for the next check-in (sidecar + `reminders-index`),
  and (2) update the project's card: status line, whose move, and `--due` =
  that next check-in date. The reminder nudges him; the card shows where the
  whole project stands.
- Reuse the project's `--key` so every chat updates the same card.

**Board v2 (2026-11-24) — I keep the cards current, Ryan only taps done.**
- **Every card has a next check-in date** (`--due`); lanes sort by it. A new
  card needs one. Undated cards sink, marked "Needs a date".
- **On hold** = nothing needed from Ryan until a date: `--hold YYYY-MM-DD`
  folds it into the "On hold" group; it comes back by itself that day
  ("Back from hold") → refresh it, then `--unhold` or `--hold` a new date.
- **`--notes <path>`** links the card to its notes (`deals/<street>.md`,
  `taxes/PROJECT_MEMO.md`, `memory/<file>.md`). `wrap-check.mjs` fails when
  those notes changed today but the card didn't. Fix: update the card, or
  `board.mjs touch <key> --why "..."` if nothing on the card changes.
- **Morning refresh** (start of the daily workflow): `node scripts/board.mjs
  review` → for each flagged card (back from hold, check-in passed or due today,
  notes newer than the card, stale ≥10 days, last touched by Ryan) check its
  notes / texts / email and `update` or `touch` it. For cards Ryan added or
  edited himself, ask him one short question and fill it in; he doesn't want to
  fill cards in himself.
- History: every change is logged by a DB trigger (`board_item_log`);
  `board.mjs log <key>`; on the page, tap a card → History.
- Never mark a card done yourself (the done circle is Ryan's).

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
7. Commit + push this repo. Do **not** hand-commit the `~/Projects`
   memo/deal files: the wrap check saves them (next step).
8. Run `node scripts/wrap-check.mjs` — it saves the notes, verifies all of
   the above, fast-forwards the main checkout, refreshes the Projects page
   and starts a silent Drive backup. Done when it says **All clear**.

**Several chats wrapping at once (2026-11-24).** The memo repo and the
Board are shared, so the check sees every chat's open notes. It handles
that itself: one wrap at a time (a lock), it waits for files changed in the
last 45 s, then commits every open memo/deal file in one neutral commit and
fixes the index dates. Never commit another chat's memo or deal file by
hand, and never `board.mjs touch` a card just to clear a warning. If the
check says a file is still being written, or a card's notes changed minutes
ago, another chat is mid-wrap: run the check again in a minute. A card whose
notes changed a while ago and was left behind: read those notes and update
the card properly, whichever chat you are.

## Repo conventions

- **Deploy:** production builds from `main` (Vercel auto-deploy). `tsc
  --noEmit` is the real gate — `next build`'s ESLint is
  `ignoreDuringBuilds`.
- **Concurrent agents** work this repo. Always check `git branch` /
  `git status` before committing; never `git add -A`.
- **Local dev:** see [`LOCAL_DEV.md`](./LOCAL_DEV.md).
- Cross-cutting infra (Mac mini sidecar, launchd, tunnels, chat.db) is
  documented in agent memory, not here.
