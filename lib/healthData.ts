// Supabase reads behind GET /api/health (Mission Control 2.0, Part E,
// 2026-11-10). Server only — imports lib/leads and lib/jackie. Every source is
// read in parallel and fails on its own: a broken one comes back null with a
// line in `errors` (mini_status in particular may not exist yet), and the
// page marks just that card.

import { getLeadsClient } from "@/lib/leads"
import { getJackieFlip } from "@/lib/jackie"
import { GB_KB, spaceLevel } from "@/lib/miniSpace"
import { lastNDays, monthStart } from "@/lib/today"
import { shapeHealthSpend, type HealthPayload, type HealthSpend, type RollupRow } from "@/lib/health"
import type { MiniSnapshot } from "@/lib/miniStatus"

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const WEEK_MS = 7 * 86_400_000

async function readHeartbeat(): Promise<HealthPayload["heartbeat"]> {
  const { data, error } = await getLeadsClient()
    .from("mini_heartbeat")
    .select("beat_at, watchdog_at, free_kb, space_level")
    .eq("id", "mini")
    .maybeSingle<{ beat_at: string; watchdog_at: string | null; free_kb: number | null; space_level: "warn" | "urgent" | null }>()
  if (error) throw new Error(error.message)
  if (!data) return { beatAt: null, watchdogAt: null, freeGb: null, lowSpace: false }
  return {
    beatAt: data.beat_at,
    watchdogAt: data.watchdog_at,
    freeGb: data.free_kb != null ? Math.round(data.free_kb / GB_KB) : null,
    lowSpace: spaceLevel(data.free_kb, data.space_level) !== null,
  }
}

async function readStatus(): Promise<HealthPayload["status"]> {
  const { data, error } = await getLeadsClient()
    .from("mini_status")
    .select("reported_at, snapshot")
    .eq("id", "mini")
    .maybeSingle<{ reported_at: string; snapshot: MiniSnapshot | null }>()
  if (error) throw new Error(error.message)
  if (!data?.snapshot || !Array.isArray(data.snapshot.jobs)) return null
  return { reportedAt: data.reported_at, snapshot: data.snapshot }
}

async function readJudge(): Promise<HealthPayload["judge"]> {
  const { data, error } = await getLeadsClient()
    .from("lead_verdicts")
    .select("judged_at")
    .order("judged_at", { ascending: false })
    .limit(1)
  if (error) throw new Error(error.message)
  return { at: (data?.[0] as { judged_at?: string } | undefined)?.judged_at ?? null }
}

async function readJackie(now: Date): Promise<HealthPayload["jackie"]> {
  const sb = getLeadsClient()
  const [flip, calls] = await Promise.all([
    getJackieFlip(sb),
    sb.from("leads")
      .select("id", { count: "exact", head: true })
      .not("jackie_call", "is", null)
      .gte("created_at", new Date(now.getTime() - WEEK_MS).toISOString()),
  ])
  if (calls.error) throw new Error(calls.error.message)
  return { on: flip.on, since: flip.changed_at ?? null, callsWeek: calls.count ?? 0 }
}

// llm_usage_rollup() sums server-side — never page raw llm_usage rows.
async function rollupRows(from: Date, to: Date): Promise<RollupRow[]> {
  const { data, error } = await getLeadsClient().rpc("llm_usage_rollup", { p_from: from.toISOString(), p_to: to.toISOString() })
  if (error) throw new Error(error.message)
  return (data ?? []) as RollupRow[]
}

async function readSpend(now: Date): Promise<HealthSpend> {
  const [yesterday] = lastNDays(2, now)
  const month = monthStart(now)
  const [monthRows, yRows] = await Promise.all([rollupRows(month.from, now), rollupRows(yesterday.from, yesterday.to)])
  const label = new Date(`${month.ymd}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short" })
  return shapeHealthSpend(monthRows, yRows, label)
}

export async function buildHealth(now: Date = new Date()): Promise<HealthPayload> {
  const errors: Record<string, string> = {}
  const soft = async <T>(name: string, p: Promise<T>): Promise<T | null> => {
    try {
      return await p
    } catch (e) {
      errors[name] = msg(e)
      console.error(`[health] ${name} failed:`, msg(e))
      return null
    }
  }
  const [heartbeat, status, judge, jackie, spend] = await Promise.all([
    soft("heartbeat", readHeartbeat()),
    soft("status", readStatus()),
    soft("judge", readJudge()),
    soft("jackie", readJackie(now)),
    soft("spend", readSpend(now)),
  ])
  return { generatedAt: now.toISOString(), heartbeat, status, judge, jackie, spend, errors }
}
