// Today page (Mission Control 2.0 shell, 2026-11-10) — the pure helpers the
// page and /api/today share: Pacific day boundaries, the greeting, the
// overnight window Jackie's list reads, AI-spend shaping, appointment
// clustering, and how a Follow Ups row reads in the "Due today" list.
//
// Imported by the browser: NOTHING server-only may be imported here (no
// lib/leads, no Supabase client). Types only from server modules.

import { pacificDate, pacificDatePlusDays } from "@/lib/pacificDate"
import { isOnMarket, type LeadListing } from "@/lib/listing"
import { formatPhone } from "@/lib/utils"
import { isAnonymousCaller } from "@/lib/anonymous"
import {
  classifyUrgency, isOwedReason, stripOwedPrefix, touchSortKey, type NextTouch,
} from "@/lib/next-touch"

export const TZ = "America/Los_Angeles"
export const SPEND_TARGET_USD = 100
const DAY_MS = 86_400_000

// ── Pacific time ─────────────────────────────────────────────────────────────

/** Minutes the Pacific wall clock is ahead of UTC at instant `t` (−480 / −420). */
function pacificOffsetMin(t: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(t))
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour") % 24, n("minute"), n("second"))
  return Math.round((asUtc - Math.floor(t / 1000) * 1000) / 60_000)
}

/** The instant a Pacific wall-clock time happens (DST-aware). */
export function pacificWallToUtc(ymd: string, hour = 0, minute = 0): Date {
  const [y, m, d] = ymd.split("-").map(Number)
  const guess = Date.UTC(y, m - 1, d, hour, minute)
  const off1 = pacificOffsetMin(guess)
  let t = guess - off1 * 60_000
  const off2 = pacificOffsetMin(t)
  if (off2 !== off1) t = guess - off2 * 60_000
  return new Date(t)
}

/** Hour of the day (0–23) on Ryan's clock. */
export function pacificHour(at: Date = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(at)) % 24
}

export function greeting(at: Date = new Date()): string {
  const h = pacificHour(at)
  if (h >= 5 && h < 12) return "Morning, Ryan."
  if (h >= 12 && h < 17) return "Afternoon, Ryan."
  return "Evening, Ryan."
}

/** "Tuesday · Nov 10, 2026" */
export function dateLine(at: Date = new Date()): string {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long" }).format(at)
  return `${weekday} · ${fmtDate(at)}`
}

/** "Nov 10, 2026" (Pacific). */
export function fmtDate(at: Date | string): string {
  return new Date(at).toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric", year: "numeric" })
}

/** "Nov 10, 2026" for a bare YYYY-MM-DD (no timezone drift). */
export function fmtYmd(ymd: string): string {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" })
}

/** "10:30 AM" (Pacific). */
export function fmtTime(at: Date | string): string {
  return new Date(at).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" })
}

/** Today → "10:30 AM"; within the coming/past week → "Wed 10:30 AM"; else the date with the year. */
export function fmtWhen(at: Date | string, now: Date = new Date()): string {
  const d = new Date(at)
  const day = pacificDate(d)
  if (day === pacificDate(now)) return fmtTime(d)
  if (Math.abs(d.getTime() - now.getTime()) < 6 * DAY_MS) {
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(d)
    return `${wd} ${fmtTime(d)}`
  }
  return fmtDate(d)
}

/**
 * Jackie's overnight list: calls since 5:00 PM Pacific the previous day, and
 * the same window one day earlier for the ▲/▼ comparison.
 */
export function overnightWindow(now: Date = new Date()): {
  from: Date; to: Date; prevFrom: Date; prevTo: Date
} {
  const yesterday = pacificDatePlusDays(-1, now)
  const dayBefore = pacificDatePlusDays(-2, now)
  return {
    from: pacificWallToUtc(yesterday, 17),
    to: now,
    prevFrom: pacificWallToUtc(dayBefore, 17),
    prevTo: new Date(now.getTime() - DAY_MS),
  }
}

/** Pacific midnight → next Pacific midnight for each of the last `n` days, oldest first, ending today. */
export function lastNDays(n: number, now: Date = new Date()): { ymd: string; from: Date; to: Date }[] {
  const out: { ymd: string; from: Date; to: Date }[] = []
  for (let i = n - 1; i >= 0; i--) {
    const ymd = pacificDatePlusDays(-i, now)
    out.push({ ymd, from: pacificWallToUtc(ymd), to: pacificWallToUtc(pacificDatePlusDays(1, new Date(`${ymd}T12:00:00Z`))) })
  }
  return out
}

/** First of this Pacific month, as an instant, plus its YYYY-MM-DD. */
export function monthStart(now: Date = new Date()): { ymd: string; from: Date } {
  const ymd = `${pacificDate(now).slice(0, 7)}-01`
  return { ymd, from: pacificWallToUtc(ymd) }
}

// ── AI spend ────────────────────────────────────────────────────────────────

/** Sum the cost_usd column of llm_usage_rollup() rows (numeric arrives as a string). */
export function sumRollup(rows: { cost_usd: number | string | null }[] | null | undefined): number {
  return (rows ?? []).reduce((s, r) => s + (Number(r.cost_usd) || 0), 0)
}

export interface SpendDay { ymd: string; usd: number }
export interface SpendSummary {
  days: SpendDay[]            // oldest → today
  yesterdayUsd: number
  monthUsd: number
  monthLabel: string          // "Nov"
  targetUsd: number
  monthPct: number            // 0–100, capped
  bars: number[]              // heights 0–100 relative to the busiest day
  firstLabel: string          // "Nov 4, 2026"
  lastLabel: string           // "Nov 10, 2026"
}

export function shapeSpend(days: SpendDay[], monthUsd: number, targetUsd: number = SPEND_TARGET_USD): SpendSummary {
  const max = Math.max(0, ...days.map((d) => d.usd))
  const yesterday = days.length >= 2 ? days[days.length - 2].usd : 0
  const last = days[days.length - 1]?.ymd
  return {
    days,
    yesterdayUsd: round2(yesterday),
    monthUsd: round2(monthUsd),
    monthLabel: last ? new Date(`${last}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short" }) : "",
    targetUsd,
    monthPct: targetUsd > 0 ? Math.min(100, Math.max(0, (monthUsd / targetUsd) * 100)) : 0,
    // A day with any spend gets at least a sliver, so it reads as "some".
    bars: days.map((d) => (max > 0 ? (d.usd > 0 ? Math.max(4, Math.round((d.usd / max) * 100)) : 0) : 0)),
    firstLabel: days[0] ? fmtYmd(days[0].ymd) : "",
    lastLabel: last ? fmtYmd(last) : "",
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`
}

// ── Appointments ────────────────────────────────────────────────────────────

/** A leads row with an appointment on it (subset of columns /api/today reads). */
export interface ApptRow {
  id: string
  created_at: string
  caller_phone: string | null
  email: string | null
  name: string | null
  property_address: string | null
  status: string | null
  is_dnc: boolean | null
  is_junk: boolean | null
  appointment_at: string | null
  appointment_details: {
    start?: string | null
    location?: string | null
    with?: string | null
    source?: string | null
  } | null
}

export interface TodayAppointment {
  key: string
  /** Lead-card deep link key (phone or email:…), null when neither. */
  linkKey: string | null
  day: string             // YYYY-MM-DD Pacific
  start: string | null    // ISO instant when a time was booked
  title: string
  sub: string | null
}

function personKey(r: { id: string; caller_phone: string | null; email: string | null }): string {
  if (r.caller_phone && !isAnonymousCaller(r.caller_phone)) return r.caller_phone
  if (r.email) return `email:${r.email.toLowerCase()}`
  return r.id
}

const SOURCE_LABEL: Record<string, string> = { call: "Booked from a call", text: "Booked from a text", telegram: "Added from Telegram" }

/**
 * One appointment per person: rows clustered by phone (else email), the
 * newest row's appointment wins, dead / DNC / junk people dropped, and only
 * appointments on [fromDay, toDay] (Pacific days, inclusive) kept. Sorted
 * soonest first.
 */
export function clusterAppointments(rows: ApptRow[], fromDay: string, toDay: string): TodayAppointment[] {
  const byKey = new Map<string, ApptRow[]>()
  for (const r of rows) {
    const k = personKey(r)
    byKey.set(k, [...(byKey.get(k) ?? []), r])
  }
  const out: TodayAppointment[] = []
  for (const [key, group] of Array.from(byKey.entries())) {
    const newestFirst = [...group].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    if (group.some((r) => r.is_dnc || r.is_junk)) continue
    if ((newestFirst[0].status ?? "").toLowerCase() === "dead") continue
    const withAppt = newestFirst.find((r) => r.appointment_at)
    if (!withAppt?.appointment_at) continue
    const details = newestFirst.map((r) => r.appointment_details).find((d) => d && d.start) ?? withAppt.appointment_details
    const start = details?.start && !Number.isNaN(Date.parse(details.start)) ? new Date(details.start).toISOString() : null
    const day = start ? pacificDate(new Date(start)) : withAppt.appointment_at.slice(0, 10)
    if (day < fromDay || day > toDay) continue
    const name = newestFirst.map((r) => (r.name ?? "").trim()).find(Boolean) || null
    const phone = newestFirst.map((r) => r.caller_phone).find((p) => p && !isAnonymousCaller(p)) ?? null
    const who = name || details?.with || (phone ? formatPhone(phone) : null) || newestFirst.find((r) => r.email)?.email || "Seller"
    const place = details?.location || newestFirst.map((r) => r.property_address).find(Boolean) || null
    const subParts = [
      details?.with && details.with !== name ? `With ${details.with}` : null,
      details?.source ? SOURCE_LABEL[details.source] ?? null : null,
    ].filter(Boolean)
    out.push({
      key,
      linkKey: phone ?? (newestFirst.find((r) => r.email)?.email ? `email:${newestFirst.find((r) => r.email)!.email!.toLowerCase()}` : null),
      day,
      start,
      title: place ? `${who} · ${place.split(",")[0]}` : who,
      sub: subParts.length ? subParts.join(" · ") : null,
    })
  }
  return out.sort((a, b) => (a.start ?? `${a.day}T23:59`).localeCompare(b.start ?? `${b.day}T23:59`) || a.day.localeCompare(b.day))
}

/** When an appointment reads in the list: "10:30 AM", "Thu 2:00 PM", or the date with the year. */
export function apptWhen(a: Pick<TodayAppointment, "day" | "start">, now: Date = new Date()): string {
  if (a.start) return fmtWhen(a.start, now)
  if (a.day === pacificDate(now)) return "today"
  return fmtYmd(a.day)
}

// ── Jackie overnight ────────────────────────────────────────────────────────

export interface JackieRow {
  id: string
  created_at: string
  caller_phone: string | null
  name: string | null
  call_arm: string | null
  property_address: string | null
  jackie_call: Record<string, unknown> | null
}

export interface JackieItem {
  id: string
  at: string
  linkKey: string | null
  title: string
  sub: string
}

function mmss(sec: number): string {
  return sec >= 60 ? `${Math.round(sec / 60)} min` : `0:${String(Math.round(sec)).padStart(2, "0")}`
}

/** One line for a Jackie call: who, and what happened. */
export function describeJackieCall(r: JackieRow, nameByPhone: Record<string, string> = {}): JackieItem {
  const j = r.jackie_call ?? {}
  const anon = !r.caller_phone || isAnonymousCaller(r.caller_phone)
  const name = (r.name ?? "").trim() || (r.caller_phone ? nameByPhone[r.caller_phone] : "") || ""
  const caller = name || (anon ? "Blocked number" : formatPhone(r.caller_phone) ?? r.caller_phone ?? "Unknown caller")
  const kind = r.call_arm === "returning" || j.returning ? "returning caller" : "first-time caller"
  const sec = typeof j.duration_sec === "number" ? j.duration_sec : null
  let what: string
  if (j.failed === true) what = "Call to Jackie failed → your voicemail"
  else if (sec !== null && sec < 15) what = "Hung up"
  else if (j.not_selling === true) what = "Not selling"
  else if (j.intake_complete === true) {
    const cb = typeof j.callback_when === "string" && j.callback_when ? `call back ${j.callback_when}` : "intake done"
    what = cb
  } else if (j.reviewed_at || j.review_failed) what = "Intake not finished"
  else if (sec === null && !j.ended_at) what = "In progress or not read yet"
  else what = "Talked with Jackie"
  const extras = [
    r.property_address ? r.property_address.split(",")[0] : null,
    sec !== null ? mmss(sec) : null,
  ].filter(Boolean)
  return {
    id: r.id,
    at: r.created_at,
    linkKey: anon ? null : r.caller_phone,
    title: `${caller} · ${kind}`,
    sub: [what, ...extras].join(" · "),
  }
}

// ── Follow Ups rows (shape of GET /api/follow-ups `rows`) ─────────────────────

export interface FollowUpRowLite {
  clusterKey: string
  name: string | null
  phone: string | null
  email: string | null
  gmailThreadId: string | null
  propertyAddress: string | null
  listing?: LeadListing | null
  temperature: "hot" | "warm" | "cold" | null
  primary: NextTouch
  replied?: { at: string; kind: string; text: string | null } | null
}

export interface FollowUpsLite {
  rows: FollowUpRowLite[]
  failed: unknown[]
}

const TEMP_RANK: Record<string, number> = { hot: 0, warm: 1, cold: 2 }

/** Same order the Follow Ups worklist shows (FollowUpsTab buckets + sortWorklist). */
export function orderFollowUps(rows: FollowUpRowLite[], now: Date = new Date()): FollowUpRowLite[] {
  const sortWorklist = (list: FollowUpRowLite[]) => [...list].sort((a, b) => {
    const k = (a.primary.kind === "call" ? 0 : 1) - (b.primary.kind === "call" ? 0 : 1)
    if (k !== 0) return k
    const owed = Number(isOwedReason(b.primary.reason)) - Number(isOwedReason(a.primary.reason))
    if (owed !== 0) return owed
    const t = (a.temperature ? TEMP_RANK[a.temperature] ?? 3 : 3) - (b.temperature ? TEMP_RANK[b.temperature] ?? 3 : 3)
    if (t !== 0) return t
    const listed = Number(isOnMarket(a.listing)) - Number(isOnMarket(b.listing))
    if (listed !== 0) return listed
    return touchSortKey(a.primary) - touchSortKey(b.primary)
  })
  const replied: FollowUpRowLite[] = []
  const ready: FollowUpRowLite[] = []
  const overdue: FollowUpRowLite[] = []
  const rest: FollowUpRowLite[] = []
  for (const r of rows) {
    if (r.replied) replied.push(r)
    else if (r.primary.kind === "drip" && r.primary.isQueued) ready.push(r)
    else if (classifyUrgency(r.primary, now) === "overdue") overdue.push(r)
    else rest.push(r)
  }
  replied.sort((a, b) => (b.replied?.at ?? "").localeCompare(a.replied?.at ?? ""))
  return [...replied, ...sortWorklist(ready), ...sortWorklist(overdue), ...sortWorklist(rest)]
}

/** Lead-card deep-link key — the same rule FollowUpsTab's leadOverlayKey uses. */
export function followUpLinkKey(r: Pick<FollowUpRowLite, "phone" | "gmailThreadId" | "email">): string | null {
  if (r.phone) return r.phone
  if (r.gmailThreadId) return `thread:${r.gmailThreadId}`
  if (r.email) return `email:${r.email.toLowerCase()}`
  return null
}

export interface DueItem {
  key: string
  href: string | null
  name: string
  why: string
  when: string
  tone: "replied" | "overdue" | "today" | "later"
}

const REPLIED_LABEL: Record<string, string> = { "missed call": "Called you", voicemail: "Left a voicemail", email: "Emailed you" }

/** Days a touch is late, on Ryan's calendar (0 = due today or later). */
function daysLate(t: NextTouch, now: Date): number {
  const today = pacificDate(now)
  const dueDay = t.kind === "call" ? t.due.slice(0, 10) : pacificDate(new Date(t.due))
  if (dueDay >= today) return 0
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dueDay}T00:00:00Z`)) / DAY_MS)
}

/** How a Follow Ups row reads on Today: name, one line of why, "today" / "overdue 2d". */
export function describeDue(r: FollowUpRowLite, now: Date = new Date()): DueItem {
  const name = r.name || (r.phone && formatPhone(r.phone)) || r.email || "(unknown)"
  const place = r.propertyAddress ? r.propertyAddress.split(",")[0] : null
  let reason: string
  if (r.replied) {
    const said = r.replied.text && r.replied.kind !== "missed call" ? ` · “${r.replied.text}”` : ""
    reason = `${REPLIED_LABEL[r.replied.kind] ?? "Texted you"}${said}`
  } else if (r.primary.kind === "drip") {
    const n = r.primary.touchNumber ? ` #${r.primary.touchNumber}` : ""
    const ch = r.primary.channel === "email" ? "email" : "text"
    reason = r.primary.isQueued ? `Drip ${ch}${n} ready to send` : `Drip ${ch}${n} due`
  } else {
    reason = r.primary.reason ? stripOwedPrefix(r.primary.reason) : r.primary.channel === "email" ? "Follow-up email" : "Follow-up call"
  }
  const late = daysLate(r.primary, now)
  const urgency = classifyUrgency(r.primary, now)
  const tone: DueItem["tone"] = r.replied ? "replied" : late > 0 ? "overdue" : urgency === "today" || urgency === "overdue" ? "today" : "later"
  const when = r.replied ? "replied" : late > 0 ? `overdue ${late}d` : "today"
  const key = followUpLinkKey(r)
  return {
    key: r.clusterKey,
    href: key ? `/leads?phone=${encodeURIComponent(key)}` : null,
    name,
    why: place && !reason.includes(place) ? `${place} · ${reason}` : reason,
    when,
    tone,
  }
}

// ── Health ──────────────────────────────────────────────────────────────────

export const MINI_QUIET_MS = 4 * 60_000      // same as /api/mini/watch QUIET_MS
export const WATCHDOG_QUIET_MS = 20 * 60_000 // same as /api/mini/watch WATCHDOG_MS

export function isFresh(iso: string | null | undefined, maxAgeMs: number, now: Date = new Date()): boolean {
  if (!iso) return false
  const t = Date.parse(iso)
  return !Number.isNaN(t) && now.getTime() - t < maxAgeMs
}

/** The judge is fine when it last ran on Ryan's today. */
export function judgeRanToday(judgedAt: string | null | undefined, now: Date = new Date()): boolean {
  return !!judgedAt && pacificDate(new Date(judgedAt)) === pacificDate(now)
}
