// Project memos → rows for the Projects page (Mission Control 2.0, 2026-11-10).
//
// Pure parser for ~/Projects/PROJECTS/<slug>/PROJECT_MEMO.md + CHANGELOG.md
// (format spec: "Memo format" in PROJECTS/MEMO_INDEX.md). Used by
// scripts/projects-sync.mjs on the Mac mini (which writes table
// project_memos) and by tests/project-memo.unit.test.ts.
//
// Constraints, because the sync script imports this file straight from Node
// (type stripping, like scripts/dnc-mail-scrub.mjs → lib/csv.ts):
//   - no imports at all (no "@/…" aliases — Node can't resolve them)
//   - erasable TypeScript only: no enums, namespaces or parameter properties
// The browser may import the types from here; nothing server-only lives here.

export type ProjectStatus = "active" | "planning" | "parked" | "retired"

export interface Ship {
  date: string // YYYY-MM-DD
  title: string
}

/** One project_memos row as the sync script writes it (synced_at added there). */
export interface ProjectMemoRow {
  slug: string
  name: string
  status: ProjectStatus
  status_line: string | null
  plain: string | null
  owns: string | null
  updated_on: string | null // YYYY-MM-DD
  left_off: string | null
  ships: Ship[]
  archived: boolean
}

/** What GET /api/projects returns per project. */
export interface ProjectRow extends ProjectMemoRow {
  synced_at: string
}

export const LEFT_OFF_MAX = 6000
export const SHIPS_MAX = 8
const TITLE_MAX = 160 // a ship title longer than this is cut at a word

// ── small text helpers ──────────────────────────────────────────────────────

/** Markdown inline formatting → plain text: links, bold/italic, code ticks. */
export function stripInline(md: string): string {
  return md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) → text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=$|[\s).,;:!?])/g, "$1$2")
    .replace(/(^|[\s(])_([^_\s][^_]*)_(?=$|[\s).,;:!?])/g, "$1$2")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

// Built with new RegExp: tsconfig sets no `target`, so tsc refuses /u literals.
const LEADING_SYMBOLS = new RegExp("^[\\p{Extended_Pictographic}\\p{Emoji_Presentation}\\uFE0F\\u200D\\u23F8\\u23F9\\s]+", "u")

function isYmd(s: string): boolean {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.toISOString().slice(0, 10) === s
}

/** The lines above the first `## ` heading (title + the `> **X:**` block). */
function headerRegion(text: string): string {
  const i = text.search(/^##\s/m)
  return i === -1 ? text : text.slice(0, i)
}

/** Value of a `> **Label:** value` header line (colon inside or outside the bold). */
export function headerField(text: string, label: string): string | null {
  const re = new RegExp(`^>?\\s*\\*\\*${label}:?\\*\\*:?[ \\t]*(.*)$`, "im")
  const m = headerRegion(text).match(re)
  if (!m) return null
  const v = m[1].trim()
  return v ? v : null
}

// ── status ──────────────────────────────────────────────────────────────────

const STATUS_EMOJI: [string, ProjectStatus][] = [
  ["\u{1F7E2}", "active"], // 🟢
  ["\u{1F7E1}", "planning"], // 🟡
  ["\u23F8", "parked"], // ⏸
  ["\u{1FAA6}", "retired"], // 🪦
]

const STATUS_WORDS: [RegExp, ProjectStatus][] = [
  [/\b(active|live)\b/i, "active"],
  [/\bplanning\b/i, "planning"],
  [/\bparked\b/i, "parked"],
  [/\b(dormant|retired)\b/i, "retired"],
]

const LEADING_STATUS_WORD = /^(?:active|live|planning|parked|dormant|retired)\b/i

/**
 * Status line → status + the phrase after the status word.
 *   "🟢 Active — offer bot v1 live (2026-10-15)" → active, "offer bot v1 live (2026-10-15)"
 *   "🟢 Active (phase 1 live 2026-11-02)"        → active, "phase 1 live 2026-11-02"
 *   "🟢 v0 live (search only)"                   → active, "v0 live (search only)"
 * The leading emoji wins; without one, the first status word in the line
 * decides. `status: null` = unrecognised (the caller warns and uses planning).
 */
export function parseStatus(raw: string | null): { status: ProjectStatus | null; statusLine: string | null } {
  if (!raw) return { status: null, statusLine: null }
  const trimmed = raw.trim()

  let status: ProjectStatus | null = null
  for (const [emoji, s] of STATUS_EMOJI) if (trimmed.startsWith(emoji)) { status = s; break }

  const body = trimmed.replace(LEADING_SYMBOLS, "").trim()
  if (!status) {
    let best = Infinity
    const plainBody = stripInline(body)
    for (const [re, s] of STATUS_WORDS) {
      const m = plainBody.match(re)
      if (m && m.index !== undefined && m.index < best) { best = m.index; status = s }
    }
  }

  // The phrase after the status word.
  let line = body
  const dash = body.match(/\s[—–]\s|\s-\s/)
  const head = dash && dash.index !== undefined ? stripInline(body.slice(0, dash.index)) : null
  if (dash && dash.index !== undefined && head !== null && head.length <= 40 && STATUS_WORDS.some(([re]) => re.test(head))) {
    line = body.slice(dash.index + dash[0].length)
  } else {
    const plainStart = body.replace(/^\*\*/, "")
    if (LEADING_STATUS_WORD.test(plainStart)) {
      line = plainStart.replace(LEADING_STATUS_WORD, "").replace(/^\*\*/, "").replace(/^[\s:,;—–-]+/, "")
      const wrapped = line.trim().match(/^\((.*)\)$/)
      if (wrapped) line = wrapped[1]
    }
  }
  const statusLine = stripInline(line)
  return { status, statusLine: statusLine || null }
}

// ── "📍 Where we left off" ───────────────────────────────────────────────────

/** The body of the `## 📍 Where we left off` section, markdown, capped. */
export function parseLeftOff(text: string, max: number = LEFT_OFF_MAX): string | null {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => /^##\s+.*where we left off/i.test(l))
  if (start === -1) return null
  const out: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) break
    out.push(lines[i])
  }
  const body = out.join("\n").replace(/^\s*\n+/, "").replace(/\s+$/, "")
  if (!body) return null
  return capMarkdown(body, max)
}

/** Cut at the last line break that fits, then "…" — never mid-word. */
export function capMarkdown(body: string, max: number): string {
  if (body.length <= max) return body
  const room = max - 2 // "\n…"
  let cut = body.lastIndexOf("\n", room)
  if (cut < room / 2) cut = body.lastIndexOf(" ", room)
  if (cut <= 0) cut = room
  return `${body.slice(0, cut).replace(/\s+$/, "")}\n…`
}

// ── changelog → ships ───────────────────────────────────────────────────────

const HASH_TICKED = /`[0-9a-f]{7,40}`/
const HASH_BARE = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/

/** A trailing "(…)" that is only bookkeeping: commit hashes, LIVE, a PR number. */
function isNoiseParen(content: string): boolean {
  return /\bLIVE\b/.test(content) || HASH_TICKED.test(content) || HASH_BARE.test(content) || /\bPR\s*#\d+/i.test(content)
}

/**
 * A changelog heading's title, readable: trailing "(`150240d`)", "(…, LIVE)",
 * "(main 726971f)", "(PR #5)" go; other backtick-quoted commit hashes go;
 * markdown goes.
 */
export function cleanShipTitle(raw: string): string {
  let t = raw.trim()
  for (;;) {
    const m = t.match(/\s*\(([^()]*)\)[\s.]*$/)
    if (!m || m.index === undefined || !isNoiseParen(m[1])) break
    t = t.slice(0, m.index)
  }
  // Hashes mid-title: "applied (`c08545a`, live on the Mac mini): …" →
  // "applied (live on the Mac mini): …"; "merged (`8ed4626`), touch …" → "merged, touch …".
  t = t
    .replace(/`[0-9a-f]{7,40}`\s*,\s*/g, "")
    .replace(/\s*,?\s*`[0-9a-f]{7,40}`/g, "")
    .replace(/\s*\(\s*[,;]?\s*\)/g, "")
    .replace(/\s+([,;:])/g, "$1")
  const out = stripInline(t).replace(/[\s.;,:—–-]+$/, "").trim()
  return out.length > TITLE_MAX ? `${out.slice(0, out.lastIndexOf(" ", TITLE_MAX - 1) > 80 ? out.lastIndexOf(" ", TITLE_MAX - 1) : TITLE_MAX - 1)}…` : out
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]

function longDateToYmd(s: string): string | null {
  const m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/)
  if (!m) return null
  const mo = MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase().slice(0, 3)))
  if (mo === -1) return null
  const ymd = `${m[3]}-${String(mo + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`
  return isYmd(ymd) ? ymd : null
}

/** Text after the first " — " (or " – " / " - ") separator; null when there is none. */
function afterDash(s: string): string | null {
  const m = s.match(/\s[—–]\s|\s-\s/)
  return m && m.index !== undefined ? s.slice(m.index + m[0].length) : null
}

/**
 * Changelog → newest-first ships (up to SHIPS_MAX). Reads, in order of
 * preference (the first form that yields anything wins):
 *   1. `## YYYY-MM-DD[ (when)| → …] — title` headings (the spec form)
 *   2. a "Ship index" of `- YYYY-MM-DD — title` bullets
 *   3. `- **Month D, YYYY (when)** — **Title.** …` bullets (agent-email-v2)
 */
export function parseShips(changelog: string | null | undefined, max: number = SHIPS_MAX): Ship[] {
  if (!changelog) return []
  const lines = changelog.split(/\r?\n/)
  let found: Ship[] = []

  for (const l of lines) {
    const m = l.match(/^##\s+(\d{4}-\d{2}-\d{2})(.*)$/)
    if (!m || !isYmd(m[1])) continue
    // No dash ("## 2026-08-19: Title", "## 2026-08-19 (pm) Title"): drop a
    // leading "(when)" and punctuation, keep the rest.
    const rest = afterDash(m[2]) ?? m[2].replace(/^\s*\([^)]*\)/, "").replace(/^[\s:—–-]+/, "")
    const title = cleanShipTitle(rest)
    if (title) found.push({ date: m[1], title })
  }

  if (!found.length) {
    for (const l of lines) {
      const m = l.match(/^\s*[-*]\s+(\d{4}-\d{2}-\d{2})\S*(.*)$/)
      if (!m || !isYmd(m[1])) continue
      const rest = afterDash(m[2])
      const title = rest ? cleanShipTitle(rest) : ""
      if (title) found.push({ date: m[1], title })
    }
  }

  if (!found.length) {
    for (const l of lines) {
      const m = l.match(/^\s*[-*]\s+\*\*([A-Za-z]+\s+\d{1,2},\s*\d{4})[^*]*\*\*(.*)$/)
      if (!m) continue
      const date = longDateToYmd(m[1])
      const rest = afterDash(m[2])
      if (!date || !rest) continue
      const bold = rest.trim().match(/^\*\*(.+?)\*\*/)
      const raw = bold ? bold[1] : rest.split(/\.\s/)[0]
      const title = cleanShipTitle(raw)
      if (title) found.push({ date, title })
    }
  }

  const seen = new Set<string>()
  found = found.filter((s) => {
    const k = `${s.date}|${s.title.toLowerCase()}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  // Stable: same-day entries keep file order (newest first by convention).
  return found
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.date < b.s.date ? 1 : a.s.date > b.s.date ? -1 : a.i - b.i))
    .slice(0, max)
    .map(({ s }) => s)
}

// ── the whole memo ──────────────────────────────────────────────────────────

/**
 * PROJECT_MEMO.md (+ CHANGELOG.md) → one project_memos row and any warnings
 * worth printing. Anything under _archive/ is retired + archived whatever its
 * Status line says; an unrecognised status reads as planning, with a warning.
 */
export function parseMemo(
  memo: string,
  opts: { slug: string; archived?: boolean; changelog?: string | null },
): { row: ProjectMemoRow; warnings: string[] } {
  const { slug } = opts
  const archived = !!opts.archived
  const warnings: string[] = []

  const h1 = headerRegion(memo).match(/^#\s+(.+)$/m)
  const name = (h1 ? stripInline(h1[1]) : "") || slug
  if (!h1) warnings.push(`${slug}: no "# Name" title — using the folder name`)

  const rawStatus = headerField(memo, "Status")
  const parsed = parseStatus(rawStatus)
  let status: ProjectStatus
  if (archived) status = "retired"
  else if (parsed.status) status = parsed.status
  else {
    status = "planning"
    warnings.push(`${slug}: ${rawStatus ? `status "${rawStatus.slice(0, 60)}" not recognised` : "no Status line"} — showing it as Planning`)
  }

  const plainRaw = headerField(memo, "Plain")
  const ownsRaw = headerField(memo, "Owns")
  const updatedRaw = headerField(memo, "Updated")
  const ymd = updatedRaw?.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null
  const updated_on = ymd && isYmd(ymd) ? ymd : null
  if (!updated_on && !archived) warnings.push(`${slug}: no Updated date`)

  return {
    row: {
      slug,
      name,
      status,
      status_line: parsed.statusLine,
      plain: plainRaw ? stripInline(plainRaw) || null : null,
      owns: ownsRaw ? stripInline(ownsRaw) || null : null,
      updated_on,
      left_off: parseLeftOff(memo),
      ships: parseShips(opts.changelog),
      archived,
    },
    warnings,
  }
}
