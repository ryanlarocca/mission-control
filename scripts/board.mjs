#!/usr/bin/env node
// The Board CLI (2026-11-20) — PROJECTS, not tasks (one card per project). How every Claude chat reads and writes Ryan's
// board (table board_items; the page is /board). "Throw it on the board" =
// `add`. Cards are found by a stable --key slug so the next chat updates the
// same card instead of adding a duplicate.
//
//   node scripts/board.mjs list [--all] [--json]
//   node scripts/board.mjs add --key amex-swap --title "Amex: swap Platinum" --due 2026-11-27 \
//        [--next "..."] [--lane you|waiting|me] [--waiting-on "Chicago Title"] \
//        [--note "1:30 PM"] [--tag Admin] [--link URL] [--notes deals/261-bieber-dr.md] [--source "chat"]
//        (a NEW card needs --due or --hold: every card carries a next check-in date;
//         add on an existing key updates only the fields you pass)
//   node scripts/board.mjs update <key|id> [same flags]   (--due none clears the date)
//        --hold 2026-12-08   on hold until that date (folds away, comes back by itself)
//        --unhold            back to normal (keeps the date)
//   node scripts/board.mjs touch <key|id> [--why "checked texts, nothing new"]   (looked, no change: resets "stale", logs it)
//   node scripts/board.mjs log <key|id>       the card's dated history
//   node scripts/board.mjs review             MORNING REFRESH: every card with its last update, notes + flags
//   node scripts/board.mjs check [--json]     for wrap-check: notes moved but card not updated, cards with no date
//   node scripts/board.mjs done <key|id>      ·   reopen <key|id>   ·   remove <key|id> (delete; for cards that don't belong)
//   node scripts/board.mjs import <file.json> (array of {key, title, ...} — upsert by key)
//
// --notes: where the project's notes live, relative to ~/Projects/PROJECTS
// ("deals/261-bieber-dr.md", "taxes/PROJECT_MEMO.md") or "memory/<file>.md"
// (agent memory); comma-separated for several. Every write here is stamped
// updated_by "Claude"; a DB trigger logs each change to board_item_log.
//
// Lanes: you = Your move · waiting = Waiting on someone · me = I'm handling.
// Reads LRG_SUPABASE_URL / LRG_SUPABASE_SERVICE_KEY from the environment or
// from mission-control/.env.local (worktree or main checkout).
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"

const here = path.dirname(fileURLToPath(import.meta.url))
function loadEnv() {
  if (process.env.LRG_SUPABASE_URL && process.env.LRG_SUPABASE_SERVICE_KEY) return
  for (const p of [path.join(here, "..", ".env.local"), "/Users/ryanlarocca/Projects/PROJECTS/mission-control/.env.local"]) {
    if (!fs.existsSync(p)) continue
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1")
    }
    if (process.env.LRG_SUPABASE_URL) return
  }
}
loadEnv()
const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })

const COLS = "id, key, title, next_step, lane, waiting_on, due_date, due_note, tag, link, status, done_at, on_hold, notes_path, updated_by, sort_order, source, created_at, updated_at"
const STALE_DAYS = 10
const HOME = process.env.HOME || "/Users/ryanlarocca"
const MEMOS = path.join(HOME, "Projects/PROJECTS")
const MEMORY = path.join(HOME, ".claude/projects/-Users-ryanlarocca-Projects-PROJECTS-mission-control/memory")
const ptDay = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(d)
const TODAY = ptDay()
const dayDiff = (a, b) => Math.round((Date.parse(a + "T12:00:00Z") - Date.parse(b + "T12:00:00Z")) / 86_400_000)
const ago = (iso) => dayDiff(TODAY, ptDay(new Date(iso)))
const isHeld = (c) => c.status === "open" && c.on_hold && c.due_date && c.due_date > TODAY
const backFromHold = (c) => c.status === "open" && c.on_hold && c.due_date && c.due_date <= TODAY
/** [{ rel, abs, mtime|null }] for a card's notes_path. */
function notesFiles(c) {
  return (c.notes_path || "").split(",").map((s) => s.trim()).filter(Boolean).map((rel) => {
    const abs = rel.startsWith("/") ? rel : rel.startsWith("memory/") ? path.join(MEMORY, rel.slice(7)) : path.join(MEMOS, rel)
    return { rel, abs, mtime: fs.existsSync(abs) ? fs.statSync(abs).mtime : null }
  })
}
/** Notes edited after the card's last update (2-minute grace for same-turn writes). */
const notesAhead = (c) => notesFiles(c).filter((f) => f.mtime && f.mtime.getTime() > Date.parse(c.updated_at) + 120_000)
const LANES = ["you", "waiting", "me"]
const LANE_LABEL = { you: "Your move", waiting: "Waiting on someone", me: "I'm handling" }
const FLAG_TO_COL = { title: "title", next: "next_step", lane: "lane", "waiting-on": "waiting_on", due: "due_date", note: "due_note", tag: "tag", link: "link", notes: "notes_path", source: "source" }

function parseFlags(argv) {
  const flags = {}, rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const k = a.slice(2)
      const v = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : true
      flags[k] = v
    } else rest.push(a)
  }
  return { flags, rest }
}

function rowFromFlags(flags) {
  const row = {}
  for (const [f, col] of Object.entries(FLAG_TO_COL)) {
    if (flags[f] === undefined) continue
    let v = flags[f] === true ? null : String(flags[f])
    if (col === "due_date" && v && /^(none|null|-)$/i.test(v)) v = null
    if (col === "due_date" && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) die(`--due must be YYYY-MM-DD (got ${v})`)
    if (col === "lane" && v && !LANES.includes(v)) die(`--lane must be one of ${LANES.join(", ")}`)
    row[col] = v
  }
  if (flags.hold !== undefined) {
    const d = String(flags.hold)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) die(`--hold needs the date it comes back, YYYY-MM-DD (got ${flags.hold})`)
    if (d <= TODAY) die(`--hold date must be after today (${TODAY})`)
    row.on_hold = true
    row.due_date = d
  }
  if (flags.unhold) row.on_hold = false
  if ("due_date" in row && row.due_date === null) row.on_hold = false
  return row
}

function die(msg) { console.error(`board: ${msg}`); process.exit(1) }
const isUuid = (s) => /^[0-9a-f-]{36}$/i.test(s)

async function find(ref) {
  const q = sb.from("board_items").select(COLS)
  const { data, error } = isUuid(ref) ? await q.eq("id", ref).maybeSingle() : await q.eq("key", ref).maybeSingle()
  if (error) die(error.message)
  return data
}

async function upsert(key, row) {
  if (!key) die("--key is required (a short slug like amex-swap)")
  const existing = await find(key)
  const now = new Date().toISOString()
  if (existing) {
    if (!Object.keys(row).length) return existing
    const { data, error } = await sb.from("board_items").update({ ...row, updated_at: now, updated_by: "Claude" }).eq("id", existing.id).select(COLS).single()
    if (error) die(error.message)
    return { ...data, _updated: true }
  }
  if (!row.title) die(`no card with key "${key}" yet, so --title is required`)
  if (!row.due_date) die(`a new card needs a next check-in date: --due YYYY-MM-DD (or --hold YYYY-MM-DD)`)
  const { data, error } = await sb.from("board_items").insert({ key, lane: "you", source: "chat", updated_by: "Claude", ...row }).select(COLS).single()
  if (error) die(error.message)
  return { ...data, _created: true }
}

function line(c) {
  const due = c.due_date ? ` · ${isHeld(c) ? "back " : ""}${c.due_date}${c.due_note ? " " + c.due_note : ""}` : " · NO DATE"
  const who = c.lane === "waiting" && c.waiting_on ? ` · on ${c.waiting_on}` : ""
  const tag = c.tag ? ` [${c.tag}]` : ""
  return `  ${c.status === "done" ? "✓" : "○"} ${c.title}${tag}${due}${who}${c.key ? `  (key: ${c.key})` : ""}${c.next_step ? `\n      → ${c.next_step}` : ""}`
}

const [cmd, ...argv] = process.argv.slice(2)
const { flags, rest } = parseFlags(argv)

if (!cmd || cmd === "list") {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString()
  let q = sb.from("board_items").select(COLS)
  q = flags.all ? q.or(`status.eq.open,done_at.gte.${since}`) : q.eq("status", "open")
  const { data, error } = await q.order("due_date", { ascending: true, nullsFirst: false }).limit(1000)
  if (error) die(error.message)
  if (flags.json) { console.log(JSON.stringify(data, null, 2)); process.exit(0) }
  const open = data.filter((c) => c.status === "open" && !isHeld(c))
  const held = data.filter(isHeld)
  console.log(`The Board — ${open.length} open · ${held.length} on hold`)
  for (const lane of LANES) {
    const cards = open.filter((c) => c.lane === lane)
    console.log(`\n${LANE_LABEL[lane]} (${cards.length})`)
    for (const c of cards) console.log(line(c))
  }
  if (held.length) { console.log(`\nOn hold (${held.length})`); for (const c of held) console.log(line(c)) }
  const done = data.filter((c) => c.status === "done")
  if (done.length) { console.log(`\nDone this week (${done.length})`); for (const c of done) console.log(line(c)) }
} else if (cmd === "add") {
  const c = await upsert(flags.key, rowFromFlags(flags))
  console.log(`${c._created ? "added" : c._updated ? "updated" : "unchanged"}: ${c.title} (key: ${c.key}, lane: ${c.lane})`)
} else if (cmd === "update") {
  const ref = rest[0] ?? flags.key
  if (!ref) die("update needs a key or id")
  const existing = await find(ref)
  if (!existing) die(`no card "${ref}"`)
  const row = rowFromFlags(flags)
  if (!Object.keys(row).length) die("nothing to change")
  if (row.on_hold && !(row.due_date ?? existing.due_date)) die("on hold needs a date to come back (--hold YYYY-MM-DD)")
  const { data, error } = await sb.from("board_items").update({ ...row, updated_at: new Date().toISOString(), updated_by: "Claude" }).eq("id", existing.id).select(COLS).single()
  if (error) die(error.message)
  console.log(`updated: ${data.title}${data.on_hold ? ` (on hold until ${data.due_date})` : ""}`)
} else if (cmd === "done" || cmd === "reopen") {
  const ref = rest[0] ?? flags.key
  const existing = ref ? await find(ref) : null
  if (!existing) die(`no card "${ref}"`)
  const done = cmd === "done"
  const { error } = await sb.from("board_items").update({ status: done ? "done" : "open", done_at: done ? new Date().toISOString() : null, updated_at: new Date().toISOString(), updated_by: "Claude" }).eq("id", existing.id)
  if (error) die(error.message)
  console.log(`${done ? "done" : "reopened"}: ${existing.title}`)
} else if (cmd === "remove") {
  const ref = rest[0] ?? flags.key
  const existing = ref ? await find(ref) : null
  if (!existing) die(`no card "${ref}"`)
  const { error } = await sb.from("board_items").delete().eq("id", existing.id)
  if (error) die(error.message)
  console.log(`removed: ${existing.title}`)
} else if (cmd === "import") {
  const file = rest[0]
  if (!file) die("import needs a JSON file")
  const cards = JSON.parse(fs.readFileSync(file, "utf8"))
  let created = 0, updated = 0
  for (const card of cards) {
    const { key, status, done_at, ...fields } = card
    const row = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined))
    const c = await upsert(key, row)
    if (status === "done") await sb.from("board_items").update({ status: "done", done_at: done_at ?? new Date().toISOString() }).eq("id", c.id)
    c._created ? created++ : updated++
  }
  console.log(`import: ${created} added, ${updated} updated`)
} else if (cmd === "touch") {
  const ref = rest[0] ?? flags.key
  const existing = ref ? await find(ref) : null
  if (!existing) die(`no card "${ref}"`)
  const now = new Date().toISOString()
  const { error } = await sb.from("board_items").update({ updated_at: now, updated_by: "Claude" }).eq("id", existing.id)
  if (error) die(error.message)
  const why = typeof flags.why === "string" ? flags.why : null
  const { error: e2 } = await sb.from("board_item_log").insert({ item_id: existing.id, kind: "checked", by_who: "Claude", title: existing.title, next_step: existing.next_step, lane: existing.lane, waiting_on: existing.waiting_on, due_date: existing.due_date, on_hold: existing.on_hold, note: why })
  if (e2) die(e2.message)
  console.log(`checked: ${existing.title}${why ? ` (${why})` : ""}`)
} else if (cmd === "log") {
  const ref = rest[0] ?? flags.key
  const existing = ref ? await find(ref) : null
  if (!existing) die(`no card "${ref}"`)
  const { data, error } = await sb.from("board_item_log").select("at, kind, by_who, next_step, lane, waiting_on, due_date, on_hold, note").eq("item_id", existing.id).order("at", { ascending: false }).limit(100)
  if (error) die(error.message)
  console.log(`History — ${existing.title} (${data.length})`)
  for (const h of data) {
    console.log(`  ${new Date(h.at).toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} · ${h.by_who ?? "—"} · ${h.kind} · ${LANE_LABEL[h.lane] ?? h.lane} · ${h.due_date ? (h.on_hold ? "hold until " : "check-in ") + h.due_date : "no date"}${h.note ? ` · ${h.note}` : ""}`)
    if (h.kind !== "checked" && h.next_step) console.log(`      → ${h.next_step}`)
  }
} else if (cmd === "review" || cmd === "check") {
  const { data, error } = await sb.from("board_items").select(COLS).eq("status", "open").limit(1000)
  if (error) die(error.message)
  const cards = data.map((c) => {
    const flagsOut = []
    if (!c.due_date) flagsOut.push("NO DATE — give it a next check-in")
    else if (backFromHold(c)) flagsOut.push(`BACK FROM HOLD (${c.due_date}) — refresh it; --unhold or --hold a new date`)
    else if (c.due_date < TODAY) flagsOut.push(`OVERDUE check-in (${c.due_date})`)
    else if (c.due_date === TODAY) flagsOut.push("check-in TODAY")
    if (!isHeld(c) && ago(c.updated_at) >= STALE_DAYS) flagsOut.push(`STALE — no update in ${ago(c.updated_at)} days`)
    const ahead = notesAhead(c)
    if (ahead.length) flagsOut.push(`NOTES MOVED after the card's last update: ${ahead.map((f) => f.rel).join(", ")}`)
    if (!c.notes_path) flagsOut.push("no --notes path")
    if (c.updated_by === "Ryan" || (c.source === "board page" && !c.next_step)) flagsOut.push("Ryan touched it last — ask him what changed / fill it in")
    return { ...c, flags: flagsOut, ahead }
  })
  if (cmd === "check") {
    // wrap-check: hard problems = notes moved today but the card didn't; cards with no date.
    const recent = (f) => f.mtime && ptDay(f.mtime) === TODAY
    const problems = []
    for (const c of cards) {
      const moved = c.ahead.filter(recent)
      if (moved.length) problems.push(`${c.key}: ${moved.map((f) => f.rel).join(", ")} changed today after the card's last update — update the card (or board.mjs touch ${c.key} --why "...")`)
      if (!c.due_date) problems.push(`${c.key}: no check-in date`)
    }
    const info = { overdue: cards.filter((c) => c.due_date && c.due_date < TODAY && !c.on_hold).length, back: cards.filter(backFromHold).length, stale: cards.filter((c) => !isHeld(c) && ago(c.updated_at) >= STALE_DAYS).length }
    if (flags.json) console.log(JSON.stringify({ open: cards.length, problems, ...info }))
    else { console.log(problems.length ? problems.join("\n") : "Board: every card dated, no notes ahead of their cards"); console.log(info) }
    process.exit(problems.length ? 1 : 0)
  }
  const order = (c) => (c.flags.some((f) => /^(NO DATE|BACK|OVERDUE|NOTES|check-in TODAY)/.test(f)) ? 0 : c.flags.some((f) => /^STALE|Ryan/.test(f)) ? 1 : isHeld(c) ? 3 : 2)
  cards.sort((a, b) => order(a) - order(b) || (a.due_date ?? "9").localeCompare(b.due_date ?? "9"))
  console.log(`Morning refresh — ${TODAY} · ${cards.length} open cards (${cards.filter(isHeld).length} on hold)`)
  console.log(`For each: check its notes / texts / email for news → board.mjs update <key> (status · next step, lane, --due next check-in)`)
  console.log(`or board.mjs touch <key> --why "..." if nothing changed. Ask Ryan one line about anything only he knows.\n`)
  for (const c of cards) {
    console.log(`${c.flags.length && order(c) === 0 ? "⚠️ " : "○ "} ${c.title}  (key: ${c.key})`)
    console.log(`     ${LANE_LABEL[c.lane]}${c.lane === "waiting" && c.waiting_on ? ` on ${c.waiting_on}` : ""} · ${c.due_date ? `${isHeld(c) ? "on hold until" : "check-in"} ${c.due_date} (${dayDiff(c.due_date, TODAY) >= 0 ? "in " + dayDiff(c.due_date, TODAY) : -dayDiff(c.due_date, TODAY) + " days ago"}${dayDiff(c.due_date, TODAY) >= 0 ? " days" : ""})` : "NO DATE"}`)
    console.log(`     status: ${c.next_step ?? "(empty)"}`)
    console.log(`     last update: ${ptDay(new Date(c.updated_at))} (${ago(c.updated_at)} days ago${c.updated_by ? `, ${c.updated_by}` : ""})`)
    for (const f of notesFiles(c)) console.log(`     notes: ${f.rel} — ${f.mtime ? `edited ${ptDay(f.mtime)}${c.ahead.some((a) => a.rel === f.rel) ? "  ← newer than the card" : ""}` : "MISSING FILE"}`)
    if (c.link) console.log(`     link: ${c.link}`)
    for (const f of c.flags) console.log(`     ⚑ ${f}`)
    console.log("")
  }
} else die(`unknown command "${cmd}" (list · add · update · touch · log · review · check · done · reopen · remove · import)`)
