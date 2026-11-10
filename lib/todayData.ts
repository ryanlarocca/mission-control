// Supabase reads behind GET /api/today (Mission Control 2.0 shell,
// 2026-11-10). Server only — imports lib/leads. Every section is read in
// parallel and fails on its own: a broken source comes back null with a
// line in `errors`, and the page shows "couldn't load" for just that part.

import { getLeadsClient } from "@/lib/leads"
import { pacificDate, pacificDatePlusDays } from "@/lib/pacificDate"
import { GB_KB, spaceLevel } from "@/lib/miniSpace"
import {
  MINI_QUIET_MS, WATCHDOG_QUIET_MS, clusterAppointments, describeJackieCall, isFresh,
  judgeRanToday, lastNDays, monthStart, overnightWindow, shapeSpend, sumRollup,
  type ApptRow, type JackieItem, type JackieRow, type SpendSummary, type TodayAppointment,
} from "@/lib/today"

export interface TodayPayload {
  generatedAt: string
  health: {
    mini: { ok: boolean; beatAt: string | null; freeGb: number | null; lowSpace: boolean } | null
    bridge: { ok: boolean; at: string | null } | null
    judge: { ok: boolean; at: string | null } | null
    autopilot: { active: number } | null
  }
  appointments: TodayAppointment[] | null
  jackie: { items: JackieItem[]; count: number; prevCount: number } | null
  spend: SpendSummary | null
  errors: Record<string, string>
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

async function readHeartbeat() {
  const { data, error } = await getLeadsClient()
    .from("mini_heartbeat")
    .select("beat_at, watchdog_at, free_kb, space_level")
    .eq("id", "mini")
    .maybeSingle<{ beat_at: string; watchdog_at: string | null; free_kb: number | null; space_level: "warn" | "urgent" | null }>()
  if (error) throw new Error(error.message)
  return data
}

async function readJudge(): Promise<string | null> {
  const { data, error } = await getLeadsClient()
    .from("lead_verdicts")
    .select("judged_at")
    .order("judged_at", { ascending: false })
    .limit(1)
  if (error) throw new Error(error.message)
  return (data?.[0] as { judged_at?: string } | undefined)?.judged_at ?? null
}

// "On autopilot" = drip_campaign_type 'autopilot' and not finished — the
// same filter scripts/autopilot.js uses to pick who to text.
async function readAutopilot(): Promise<number> {
  const { count, error } = await getLeadsClient()
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("drip_campaign_type", "autopilot")
    .is("autopilot_done_at", null)
  if (error) throw new Error(error.message)
  return count ?? 0
}

async function readAppointments(now: Date): Promise<TodayAppointment[]> {
  const today = pacificDate(now)
  const last = pacificDatePlusDays(7, now)
  // appointment_at is the Pacific day at noon UTC (lib/appointments.ts).
  const { data, error } = await getLeadsClient()
    .from("leads")
    .select("id, created_at, caller_phone, email, name, property_address, status, is_dnc, is_junk, appointment_at, appointment_details")
    .gte("appointment_at", `${today}T00:00:00Z`)
    .lte("appointment_at", `${last}T23:59:59Z`)
    .order("created_at", { ascending: false })
    .limit(1000)
  if (error) throw new Error(error.message)
  return clusterAppointments((data ?? []) as ApptRow[], today, last)
}

async function readJackie(now: Date): Promise<{ items: JackieItem[]; count: number; prevCount: number }> {
  const sb = getLeadsClient()
  const w = overnightWindow(now)
  const [cur, prev] = await Promise.all([
    sb.from("leads")
      .select("id, created_at, caller_phone, name, call_arm, property_address, jackie_call")
      .not("jackie_call", "is", null)
      .gte("created_at", w.from.toISOString())
      .order("created_at", { ascending: false })
      .limit(200),
    sb.from("leads")
      .select("id", { count: "exact", head: true })
      .not("jackie_call", "is", null)
      .gte("created_at", w.prevFrom.toISOString())
      .lt("created_at", w.prevTo.toISOString()),
  ])
  if (cur.error) throw new Error(cur.error.message)
  if (prev.error) throw new Error(prev.error.message)
  const rows = (cur.data ?? []) as JackieRow[]
  // A name the person gave on any other row (Jackie's own row is often unnamed
  // until the intake is read).
  const phones = Array.from(new Set(rows.filter((r) => !r.name && r.caller_phone).map((r) => r.caller_phone as string)))
  const nameByPhone: Record<string, string> = {}
  if (phones.length) {
    const { data } = await sb.from("leads")
      .select("caller_phone, name")
      .in("caller_phone", phones)
      .not("name", "is", null)
      .order("created_at", { ascending: false })
      .limit(500)
    for (const r of (data ?? []) as { caller_phone: string; name: string | null }[]) {
      const n = (r.name ?? "").trim()
      if (n && !nameByPhone[r.caller_phone]) nameByPhone[r.caller_phone] = n
    }
  }
  return { items: rows.map((r) => describeJackieCall(r, nameByPhone)), count: rows.length, prevCount: prev.count ?? 0 }
}

// llm_usage_rollup() sums server-side — never page raw llm_usage rows
// (PostgREST caps a select at 1,000).
async function rollup(from: Date, to: Date): Promise<number> {
  const { data, error } = await getLeadsClient().rpc("llm_usage_rollup", { p_from: from.toISOString(), p_to: to.toISOString() })
  if (error) throw new Error(error.message)
  return sumRollup(data as { cost_usd: number | string | null }[])
}

async function readSpend(now: Date): Promise<SpendSummary> {
  const days = lastNDays(7, now)
  const month = monthStart(now)
  const [dayTotals, mtd] = await Promise.all([
    Promise.all(days.map((d) => rollup(d.from, d.to))),
    rollup(month.from, now),
  ])
  return shapeSpend(days.map((d, i) => ({ ymd: d.ymd, usd: dayTotals[i] })), mtd)
}

export async function buildToday(now: Date = new Date()): Promise<TodayPayload> {
  const errors: Record<string, string> = {}
  const soft = async <T>(name: string, p: Promise<T>): Promise<T | null> => {
    try {
      return await p
    } catch (e) {
      errors[name] = msg(e)
      console.error(`[today] ${name} failed:`, msg(e))
      return null
    }
  }
  const [beat, judgedAt, autopilot, appointments, jackie, spend] = await Promise.all([
    soft("heartbeat", readHeartbeat()),
    soft("judge", readJudge()),
    soft("autopilot", readAutopilot()),
    soft("appointments", readAppointments(now)),
    soft("jackie", readJackie(now)),
    soft("spend", readSpend(now)),
  ])
  const hbOk = !errors.heartbeat
  const level = beat ? spaceLevel(beat.free_kb, beat.space_level) : null
  return {
    generatedAt: now.toISOString(),
    health: {
      mini: hbOk
        ? {
            ok: isFresh(beat?.beat_at, MINI_QUIET_MS, now),
            beatAt: beat?.beat_at ?? null,
            freeGb: beat?.free_kb != null ? Math.round(beat.free_kb / GB_KB) : null,
            lowSpace: level !== null,
          }
        : null,
      bridge: hbOk ? { ok: isFresh(beat?.watchdog_at, WATCHDOG_QUIET_MS, now), at: beat?.watchdog_at ?? null } : null,
      judge: errors.judge ? null : { ok: judgeRanToday(judgedAt, now), at: judgedAt ?? null },
      autopilot: autopilot === null ? null : { active: autopilot },
    },
    appointments,
    jackie,
    spend,
    errors,
  }
}
