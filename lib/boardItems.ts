// The Board (2026-11-20): one card per open thread in Ryan's life and work —
// deals, taxes, videos, admin, subscriptions — in four lanes. Replaces the
// retired 90-day goals board at /board. Table board_items
// (supabase/migrations/2026-11-20_board_items.sql), written by app/api/board
// (the page) and scripts/board.mjs (every Claude chat: "throw it on the board").
//
// Lanes:
//   you      Your move            Ryan has to do something
//   waiting  Waiting on someone   ball is in someone else's court
//   me       I'm handling         Claude is working it
// A done card (status "done") shows under "Done this week" for 7 days.

export const BOARD_LANES = ["you", "waiting", "me"] as const
export type BoardLane = (typeof BOARD_LANES)[number]

export const BOARD_LANE_LABEL: Record<BoardLane, string> = {
  you: "Your move",
  waiting: "Waiting on someone",
  me: "I'm handling",
}

// Short colored chip on each card. Free text is allowed; these get colors.
// No "Lead": person-by-person lead follow-ups live in Follow Ups / Relationships,
// never on the Board (Ryan, 2026-11-20). Marketing work (mailers) is "Mail".
export const BOARD_TAGS = ["Deal", "Mail", "Taxes", "Video", "Admin", "Money", "Subs", "Build", "Email", "Legal", "Health", "Personal"] as const

export type BoardStatus = "open" | "done"

export type BoardItem = {
  id: string
  /** Stable slug a chat uses to find and update its card ("amex-swap"). */
  key: string | null
  title: string
  /** The very next step, one line. */
  next_step: string | null
  lane: BoardLane
  /** Who the ball is with when lane = "waiting" ("Chicago Title"). */
  waiting_on: string | null
  /** YYYY-MM-DD (Pacific), or null for no date. */
  due_date: string | null
  /** Optional time or note shown with the date ("1:30 PM", "by 5"). */
  due_note: string | null
  tag: string | null
  /** Where the details live: a URL (Drive, Gmail, Mission Control page). */
  link: string | null
  status: BoardStatus
  done_at: string | null
  sort_order: number
  source: string | null
  created_at: string
  updated_at: string
}

export const BOARD_COLS =
  "id, key, title, next_step, lane, waiting_on, due_date, due_note, tag, link, status, done_at, sort_order, source, created_at, updated_at"

/** Days a done card stays visible under "Done this week". */
export const BOARD_DONE_DAYS = 7

export function isBoardLane(v: unknown): v is BoardLane {
  return typeof v === "string" && (BOARD_LANES as readonly string[]).includes(v)
}

/** Today's date in Pacific time as YYYY-MM-DD. */
export function pacificToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(now)
}

export type DueTone = "overdue" | "today" | "soon" | "later" | "none"

/** How urgent a card's date is, for the chip color. "soon" = within 3 days. */
export function dueTone(due: string | null, today = pacificToday()): DueTone {
  if (!due) return "none"
  if (due < today) return "overdue"
  if (due === today) return "today"
  const diff = (Date.parse(due + "T12:00:00Z") - Date.parse(today + "T12:00:00Z")) / 86_400_000
  return diff <= 3 ? "soon" : "later"
}

/** Chip text for a date: "Today", "Overdue · Thu", "Mon 11-23", "Dec 7". */
export function dueLabel(due: string | null, note: string | null, today = pacificToday()): string | null {
  if (!due) return note
  const d = new Date(due + "T12:00:00Z")
  const wd = d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })
  const md = `${d.getUTCMonth() + 1}-${d.getUTCDate()}`
  const tone = dueTone(due, today)
  const diff = Math.round((Date.parse(due + "T12:00:00Z") - Date.parse(today + "T12:00:00Z")) / 86_400_000)
  let base: string
  if (tone === "today") base = "Today"
  else if (tone === "overdue") base = `Overdue · ${diff >= -6 ? wd : md}`
  else if (diff === 1) base = "Tomorrow"
  else if (diff <= 6) base = `${wd} ${md}`
  else base = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
  return note ? `${base} ${note}` : base
}

/** Open cards: dated first (soonest first), then undated by sort_order then newest. */
export function sortOpen(a: BoardItem, b: BoardItem): number {
  if (a.due_date && b.due_date && a.due_date !== b.due_date) return a.due_date < b.due_date ? -1 : 1
  if (a.due_date && !b.due_date) return -1
  if (!a.due_date && b.due_date) return 1
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
  return a.created_at < b.created_at ? 1 : -1
}
