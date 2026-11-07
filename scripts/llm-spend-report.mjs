#!/usr/bin/env node
// AI spend on Telegram (2026-11-07 API cost audit). Reads llm_usage (written
// by lib/llmUsage.ts and scripts/llm-usage.cjs) through llm_usage_rollup().
// launchd com.lrghomes.llm-spend-report runs it every hour at :10:
//   - every run: today's spend so far; once it passes $4 (Pacific day),
//     one ⚠️ alert with the biggest features.
//   - the 8 o'clock run: yesterday's line, every day through DAILY_UNTIL
//     (Ryan: "for the first week we can watch daily"), then a 7-day summary
//     on Mondays only.
// Target Ryan set: $80–100 a month across both keys (~$3/day).
//
//   node scripts/llm-spend-report.mjs                 # what launchd runs
//   node scripts/llm-spend-report.mjs --daily [--date 2026-11-08] [--dry]
//   node scripts/llm-spend-report.mjs --weekly [--dry]
//   node scripts/llm-spend-report.mjs --check [--dry]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { createClient } from "@supabase/supabase-js"

function loadEnv() {
  const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
  for (const line of envText.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2")
  }
}

export const DAILY_UNTIL = "2026-11-14" // last day that gets its own morning line
export const DAY_ALERT_USD = 4
export const MONTH_TARGET = "$80–100"
const TZ = "America/Los_Angeles"
const STATE_DIR = path.join(homedir(), ".lrg")
const STATE_FILE = path.join(STATE_DIR, "llm-spend-state.json")

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const flag = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null }
const DRY = has("--dry")

// ─── Pacific calendar ───────────────────────────────────────────────────────
export function pacificYmd(at = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(at)
}
function offsetMinutes(at) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "shortOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value || "GMT"
  const m = name.match(/GMT([+-]\d+)(?::(\d+))?/)
  if (!m) return 0
  const h = parseInt(m[1], 10)
  return h * 60 + Math.sign(h) * parseInt(m[2] || "0", 10)
}
/** UTC instant of 00:00 Pacific on a YYYY-MM-DD. */
export function pacificMidnight(ymd) {
  const [y, mo, d] = ymd.split("-").map(Number)
  const utcMidnight = Date.UTC(y, mo - 1, d)
  return new Date(utcMidnight - offsetMinutes(new Date(utcMidnight + 12 * 3600_000)) * 60_000)
}
export function addDays(ymd, n) {
  const [y, mo, d] = ymd.split("-").map(Number)
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10)
}
function pacificHour(at = new Date()) {
  return parseInt(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(at), 10)
}
function pacificWeekday(at = new Date()) {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(at)
}
function longDate(ymd) {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
}

// ─── plain names for Ryan ───────────────────────────────────────────────────
const FEATURES = [
  [/^\[reply\/auto\]$/, "Auto drafts"],
  [/^\[reply\/coach\]$/, "Coached drafts"],
  [/^\[reply\/(plan|facts|critic)\]$/, "Draft checks"],
  [/^\[coach\/rate\]$/, "Call ratings"],
  [/^\[coach\/script\]$/, "Call scripts"],
  [/^\[(crms\/generate|draft-message)\]$/, "Card composer"],
  [/^\[judge\]$/, "The judge"],
  [/^\[lead-stage\]$/, "Stage reader"],
  [/^\[drip(\/[a-z]+)?\]$/, "Drip engine"],
  [/^\[(analyze-call|summarize|summary|detect-offer|extract-followup|history-line|crms\/call [a-z]+|jackie-review)\]$/, "Call notes"],
  [/^\[(triage-email|campaign-inbox triage|vendor-pitch|ladder)\]$/, "Email & lead triage"],
  [/^\[(inbox-agent|classify|verify|event|screen|rules|propose|change|stmt-diff|inbox-[a-z-]+|backfill-[a-z]+)\]$/, "Inbox agent"],
  [/^\[(contact-intake|calendar-intake)\]$/, "Telegram intake"],
  [/^\[(campaign-[a-z]+|reply-review)\]$/, "Campaigns & reviews"],
  [/^\[market-cycle\]$/, "Market cycle"],
]
export function featureName(tag) {
  for (const [re, name] of FEATURES) if (re.test(tag || "")) return name
  return String(tag || "other").replace(/^\[|\]$/g, "")
}

const money = (n) => `$${n.toFixed(2)}`

/** Rollup rows → totals by lane and by feature. */
export function summarize(rows) {
  const out = { total: 0, calls: 0, failures: 0, lanes: { drafts: 0, background: 0 }, features: new Map(), input: 0, cacheRead: 0, top: [] }
  for (const r of rows) {
    const cost = Number(r.cost_usd) || 0
    out.total += cost
    out.calls += Number(r.calls) || 0
    out.failures += Number(r.failures) || 0
    out.lanes[r.lane] = (out.lanes[r.lane] || 0) + cost
    out.input += (Number(r.input_tokens) || 0) + (Number(r.cache_read_tokens) || 0) + (Number(r.cache_write_tokens) || 0)
    out.cacheRead += Number(r.cache_read_tokens) || 0
    const name = featureName(r.tag)
    const f = out.features.get(name) || { cost: 0, calls: 0 }
    f.cost += cost
    f.calls += Number(r.calls) || 0
    out.features.set(name, f)
  }
  out.top = [...out.features.entries()].sort((a, b) => b[1].cost - a[1].cost)
  return out
}

function topLine(s, n) {
  return s.top.slice(0, n).filter(([, f]) => f.cost >= 0.005).map(([name, f]) => `${name} ${money(f.cost)} (${f.calls})`).join(" · ") || "nothing yet"
}

export function dailyText(ymd, s) {
  const lines = [
    `🧾 <b>AI spend ${longDate(ymd)}: ${money(s.total)}</b>`,
    `Drafts &amp; coaching ${money(s.lanes.drafts || 0)} · Background ${money(s.lanes.background || 0)}`,
    `Biggest: ${topLine(s, 4)}`,
  ]
  if (s.input > 0) lines.push(`Read from cache: ${Math.round((100 * s.cacheRead) / s.input)}% of what the models read`)
  if (s.failures) lines.push(`⚠️ ${s.failures} call${s.failures === 1 ? "" : "s"} failed`)
  lines.push(`At this pace: ~${money(s.total * 30)}/month (target ${MONTH_TARGET})`)
  return lines.join("\n")
}

export function weeklyText(fromYmd, toYmd, s, days) {
  const lines = [
    `🧾 <b>AI spend, ${longDate(fromYmd)} – ${longDate(toYmd)}: ${money(s.total)}</b>`,
    `Average ${money(s.total / days)}/day · ~${money((s.total / days) * 30)}/month (target ${MONTH_TARGET})`,
    `Drafts &amp; coaching ${money(s.lanes.drafts || 0)} · Background ${money(s.lanes.background || 0)}`,
    `Biggest: ${topLine(s, 6)}`,
  ]
  if (s.input > 0) lines.push(`Read from cache: ${Math.round((100 * s.cacheRead) / s.input)}% of what the models read`)
  if (s.failures) lines.push(`⚠️ ${s.failures} call${s.failures === 1 ? "" : "s"} failed`)
  return lines.join("\n")
}

// ─── IO ─────────────────────────────────────────────────────────────────────
function db() {
  const url = process.env.LRG_SUPABASE_URL
  const key = process.env.LRG_SUPABASE_SERVICE_KEY
  if (!url || !key) throw new Error("LRG_SUPABASE_URL / LRG_SUPABASE_SERVICE_KEY not set")
  return createClient(url, key, { auth: { persistSession: false } })
}

async function rollup(fromYmd, toYmdExclusive) {
  const { data, error } = await db().rpc("llm_usage_rollup", {
    p_from: pacificMidnight(fromYmd).toISOString(),
    p_to: pacificMidnight(toYmdExclusive).toISOString(),
  })
  if (error) throw new Error(`llm_usage_rollup: ${error.message}`)
  return data || []
}

async function telegram(text) {
  if (DRY) { console.log(`--- (dry) Telegram ---\n${text}\n---`); return }
  const token = process.env.CAMPAIGN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN
  const chat = process.env.TELEGRAM_CHAT_ID
  if (!token || !chat) throw new Error("Telegram not configured")
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML" }),
  })
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`)
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")) } catch { return {} }
}
function saveState(s) {
  if (DRY) return
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2))
}

async function postDaily(ymd) {
  await telegram(dailyText(ymd, summarize(await rollup(ymd, addDays(ymd, 1)))))
}
async function postWeekly(endYmd) {
  const from = addDays(endYmd, -6)
  await telegram(weeklyText(from, endYmd, summarize(await rollup(from, addDays(endYmd, 1))), 7))
}
async function checkToday(state) {
  const today = pacificYmd()
  if (state.alertedDay === today && !DRY) return
  const s = summarize(await rollup(today, addDays(today, 1)))
  console.log(`[llm-spend] today ${today}: ${money(s.total)} over ${s.calls} calls`)
  if (s.total < DAY_ALERT_USD) return
  await telegram(`⚠️ <b>AI spend today is ${money(s.total)} so far</b> — over the ${money(DAY_ALERT_USD)}/day line.\nBiggest: ${topLine(s, 4)}`)
  state.alertedDay = today
}

async function main() {
  const state = loadState()
  if (has("--daily")) return postDaily(flag("--date") || addDays(pacificYmd(), -1))
  if (has("--weekly")) return postWeekly(flag("--date") || addDays(pacificYmd(), -1))
  if (has("--check")) return checkToday(state)

  await checkToday(state)
  const today = pacificYmd()
  if (pacificHour() === 8 && state.postedDay !== today) {
    const yesterday = addDays(today, -1)
    if (yesterday <= DAILY_UNTIL) await postDaily(yesterday)
    else if (pacificWeekday() === "Mon") await postWeekly(yesterday)
    state.postedDay = today
  }
  saveState(state)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadEnv()
  main().catch(async (e) => {
    console.error("[llm-spend] failed:", e)
    // A silent failure means Ryan stops seeing spend — say so, once a day
    // (this runs hourly).
    const state = loadState()
    if (state.failedDay !== pacificYmd()) {
      try { await telegram(`⚠️ AI spend report failed: ${String(e.message || e).slice(0, 200)}`) } catch { /* nothing else to do */ }
      state.failedDay = pacificYmd()
      saveState(state)
    }
    process.exit(1)
  })
}
