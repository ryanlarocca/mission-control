#!/usr/bin/env node
// The Board CLI (2026-11-20) — how every Claude chat reads and writes Ryan's
// board (table board_items; the page is /board). "Throw it on the board" =
// `add`. Cards are found by a stable --key slug so the next chat updates the
// same card instead of adding a duplicate.
//
//   node scripts/board.mjs list [--all] [--json]
//   node scripts/board.mjs add --key amex-swap --title "Amex: swap Platinum" \
//        [--next "..."] [--lane you|waiting|me] [--waiting-on "Chicago Title"] \
//        [--due 2026-11-27] [--note "1:30 PM"] [--tag Admin] [--link URL] [--source "chat"]
//        (add on an existing key updates only the fields you pass)
//   node scripts/board.mjs update <key|id> [same flags]   (--due none clears the date)
//   node scripts/board.mjs done <key|id>      ·   reopen <key|id>
//   node scripts/board.mjs import <file.json> (array of {key, title, ...} — upsert by key)
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

const COLS = "id, key, title, next_step, lane, waiting_on, due_date, due_note, tag, link, status, done_at, sort_order, source, created_at, updated_at"
const LANES = ["you", "waiting", "me"]
const LANE_LABEL = { you: "Your move", waiting: "Waiting on someone", me: "I'm handling" }
const FLAG_TO_COL = { title: "title", next: "next_step", lane: "lane", "waiting-on": "waiting_on", due: "due_date", note: "due_note", tag: "tag", link: "link", source: "source" }

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
    const { data, error } = await sb.from("board_items").update({ ...row, updated_at: now }).eq("id", existing.id).select(COLS).single()
    if (error) die(error.message)
    return { ...data, _updated: true }
  }
  if (!row.title) die(`no card with key "${key}" yet, so --title is required`)
  const { data, error } = await sb.from("board_items").insert({ key, lane: "you", source: "chat", ...row }).select(COLS).single()
  if (error) die(error.message)
  return { ...data, _created: true }
}

function line(c) {
  const due = c.due_date ? ` · ${c.due_date}${c.due_note ? " " + c.due_note : ""}` : c.due_note ? ` · ${c.due_note}` : ""
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
  const open = data.filter((c) => c.status === "open")
  console.log(`The Board — ${open.length} open`)
  for (const lane of LANES) {
    const cards = open.filter((c) => c.lane === lane)
    console.log(`\n${LANE_LABEL[lane]} (${cards.length})`)
    for (const c of cards) console.log(line(c))
  }
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
  const { data, error } = await sb.from("board_items").update({ ...row, updated_at: new Date().toISOString() }).eq("id", existing.id).select(COLS).single()
  if (error) die(error.message)
  console.log(`updated: ${data.title}`)
} else if (cmd === "done" || cmd === "reopen") {
  const ref = rest[0] ?? flags.key
  const existing = ref ? await find(ref) : null
  if (!existing) die(`no card "${ref}"`)
  const done = cmd === "done"
  const { error } = await sb.from("board_items").update({ status: done ? "done" : "open", done_at: done ? new Date().toISOString() : null, updated_at: new Date().toISOString() }).eq("id", existing.id)
  if (error) die(error.message)
  console.log(`${done ? "done" : "reopened"}: ${existing.title}`)
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
} else die(`unknown command "${cmd}" (list · add · update · done · reopen · import)`)
