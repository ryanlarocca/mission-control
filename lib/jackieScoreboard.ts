// Jackie coin-flip scoreboard (Ryan, 2026-10-27).
//
// One row per first call stamped with call_arm on a NOO Q4 line. The metric:
// a caller is REAL if Ryan made contact within 7 days of that first call and
// they aren't DNC or junk (flamers end up as one or the other). Contact =
//   - Ryan answered that first call (arm "answered"), or
//   - a later inbound call to a Twilio line that he picked up, or
//   - his click-to-call that connected for a minute or more, or
//   - an iPhone call either way, a minute or more (phone_calls), or
//   - a text exchange: his own text (not a drip) and a text from them.
// Callers still inside their 7 days and not yet reached are "pending" and
// left out of the rate until the window closes.

import type { SupabaseClient } from "@supabase/supabase-js"
import { isAnonymousCaller } from "@/lib/anonymous"
import type { CallArm } from "@/lib/jackie"

export const CONTACT_WINDOW_DAYS = 7
export const CONTACT_MIN_CALL_SEC = 60
const DAY_MS = 86_400_000

export type ArmScore = {
  arm: CallArm
  callers: number
  real: number
  pending: number
  /** real / (callers − pending); null until a window has closed. */
  real_rate: number | null
  dnc: number
  junk: number
  // Jackie only
  jackie_failed?: number
  jackie_hangups_under_15s?: number
  jackie_intake_complete?: number
  jackie_avg_sec?: number | null
}

export type JackieScoreboard = {
  flip_on: boolean
  since: string | null
  arms: ArmScore[]
}

type IntakeRow = {
  id: string
  created_at: string
  caller_phone: string | null
  call_arm: CallArm
  is_dnc: boolean | null
  is_junk: boolean | null
  jackie_call: Record<string, unknown> | null
}

type ClusterRow = {
  id: string
  created_at: string
  caller_phone: string | null
  lead_type: string | null
  twilio_number: string | null
  call_duration_sec: number | null
  is_dnc: boolean | null
  is_junk: boolean | null
}

const ARMS: CallArm[] = ["jackie", "voicemail", "answered", "returning"]

async function pageAll<T>(fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await fetchPage(from, from + 999)
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
    if (!data || data.length < 1000) return out
  }
}

/** Did Ryan make contact with this caller inside [t0, t0 + 7 days]? Pure. */
export function madeContact(input: {
  arm: CallArm
  t0: number
  intakeId: string
  cluster: ClusterRow[]
  iphoneCalls: { occurred_at: string; duration_sec: number }[]
}): boolean {
  if (input.arm === "answered") return true
  const end = input.t0 + CONTACT_WINDOW_DAYS * DAY_MS
  const inWindow = (iso: string) => {
    const t = new Date(iso).getTime()
    return t >= input.t0 && t <= end
  }
  let ryanText = false
  let theirText = false
  for (const r of input.cluster) {
    if (r.id === input.intakeId || !inWindow(r.created_at)) continue
    const outbound = !r.twilio_number
    if (r.lead_type === "call") {
      // Inbound to a Twilio line stays "call" only when Ryan picked up
      // (no-answer promotes a missed one to "voicemail"). iPhone rows are
      // judged from phone_calls below, which has the real duration.
      if (!outbound && r.twilio_number !== "iphone") return true
      if (outbound && (r.call_duration_sec ?? 0) >= CONTACT_MIN_CALL_SEC) return true
    }
    if (r.lead_type === "sms") {
      if (outbound) ryanText = true
      else theirText = true
    }
  }
  if (ryanText && theirText) return true
  return input.iphoneCalls.some((c) => inWindow(c.occurred_at) && c.duration_sec >= CONTACT_MIN_CALL_SEC)
}

export async function buildJackieScoreboard(sb: SupabaseClient, now: number = Date.now()): Promise<JackieScoreboard> {
  const { getJackieFlip } = await import("@/lib/jackie")
  const flip = await getJackieFlip(sb)

  const intake = await pageAll<IntakeRow>((a, b) =>
    sb.from("leads")
      .select("id, created_at, caller_phone, call_arm, is_dnc, is_junk, jackie_call")
      .not("call_arm", "is", null)
      .order("created_at", { ascending: true })
      .range(a, b),
  )
  const phones = Array.from(new Set(intake.map((r) => r.caller_phone).filter((p): p is string => !!p && !isAnonymousCaller(p))))

  const cluster = new Map<string, ClusterRow[]>()
  const iphone = new Map<string, { occurred_at: string; duration_sec: number }[]>()
  for (let i = 0; i < phones.length; i += 100) {
    const chunk = phones.slice(i, i + 100)
    const [rows, calls] = await Promise.all([
      pageAll<ClusterRow>((a, b) =>
        sb.from("leads")
          .select("id, created_at, caller_phone, lead_type, twilio_number, call_duration_sec, is_dnc, is_junk")
          .in("caller_phone", chunk)
          .range(a, b),
      ),
      pageAll<{ phone: string; occurred_at: string; duration_sec: number; kind: string | null }>((a, b) =>
        sb.from("phone_calls")
          .select("phone, occurred_at, duration_sec, kind")
          .in("phone", chunk)
          .range(a, b),
      ),
    ])
    for (const r of rows) {
      const k = r.caller_phone as string
      cluster.set(k, [...(cluster.get(k) ?? []), r])
    }
    for (const c of calls) {
      if (c.kind === "business_line") continue
      iphone.set(c.phone, [...(iphone.get(c.phone) ?? []), c])
    }
  }

  const scores = new Map<CallArm, ArmScore>(ARMS.map((arm) => [arm, { arm, callers: 0, real: 0, pending: 0, real_rate: null, dnc: 0, junk: 0 }]))
  const jackieSecs: number[] = []
  for (const r of intake) {
    const s = scores.get(r.call_arm)
    if (!s) continue
    s.callers += 1
    const anon = !r.caller_phone || isAnonymousCaller(r.caller_phone)
    const rows = anon ? [] : cluster.get(r.caller_phone as string) ?? []
    const dnc = !!r.is_dnc || rows.some((x) => x.is_dnc)
    const junk = !dnc && (rows.length ? rows.every((x) => x.is_junk) : !!r.is_junk)
    const t0 = new Date(r.created_at).getTime()
    if (dnc) s.dnc += 1
    else if (junk) s.junk += 1
    else if (madeContact({ arm: r.call_arm, t0, intakeId: r.id, cluster: rows, iphoneCalls: anon ? [] : iphone.get(r.caller_phone as string) ?? [] })) s.real += 1
    else if (now < t0 + CONTACT_WINDOW_DAYS * DAY_MS) s.pending += 1

    if (r.call_arm === "jackie") {
      const j = r.jackie_call ?? {}
      s.jackie_failed = (s.jackie_failed ?? 0) + (j.failed === true ? 1 : 0)
      s.jackie_intake_complete = (s.jackie_intake_complete ?? 0) + (j.intake_complete === true ? 1 : 0)
      const sec = typeof j.duration_sec === "number" ? j.duration_sec : null
      if (sec !== null) {
        jackieSecs.push(sec)
        if (sec < 15) s.jackie_hangups_under_15s = (s.jackie_hangups_under_15s ?? 0) + 1
      }
    }
  }
  for (const s of Array.from(scores.values())) {
    const decided = s.callers - s.pending
    s.real_rate = decided > 0 ? s.real / decided : null
  }
  const j = scores.get("jackie")!
  j.jackie_failed ??= 0
  j.jackie_intake_complete ??= 0
  j.jackie_hangups_under_15s ??= 0
  j.jackie_avg_sec = jackieSecs.length ? Math.round(jackieSecs.reduce((a, b) => a + b, 0) / jackieSecs.length) : null

  return { flip_on: flip.on, since: intake[0]?.created_at ?? null, arms: ARMS.map((a) => scores.get(a)!) }
}
