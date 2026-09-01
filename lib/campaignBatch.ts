import { getLeadsClient } from "@/lib/leads"
import { randomSendSlot } from "@/lib/campaignSlots"

// Phase B guardrails (2026-08-21, Ryan: "one tap a day, not twenty" +
// "draft the night before, I might be asleep"):
//   - the engine mints the next weekday's batch at ~6pm PT, posts ONE
//     Telegram message with [✅ Send all N] — tapping it approves every
//     draft in that batch and scatters them over the next weekday's window.
//   - nothing sends without the tap; un-tapped batches expire at the next mint.
//   - "pause campaign" / "resume campaign" flip a DB flag the engine checks
//     before every send; the engine also sets it on a bounce spike/throttle.

// randomSendSlot now comes from lib/campaignSlots — this file used to carry a
// third copy with a month-range DST guess (`m >= 3 && m <= 11 ? 7 : 8`) that
// mis-slots early-March / early-November approvals by an hour. The shared
// version round-trips the offset through Intl instead.

const PT = "America/Los_Angeles"

function ptParts(d: Date): { y: number; m: number; d: number; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: PT, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ""
  return { y: Number(get("year")), m: Number(get("month")), d: Number(get("day")), weekday: get("weekday") }
}

export async function approveBatch(batchDate: string): Promise<{ success: boolean; approved?: number; error?: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(batchDate)) return { success: false, error: "bad batch date" }
  const sb = getLeadsClient()
  const { data: rows, error } = await sb
    .from("campaign_sends")
    .select("id")
    .eq("status", "draft")
    .eq("batch_date", batchDate)
  if (error) return { success: false, error: error.message }
  if (!rows?.length) return { success: false, error: `no un-approved drafts left in the ${batchDate} batch (already approved, expired, or edited in /email-campaign)` }
  const now = new Date()
  let approved = 0
  for (const r of rows) {
    const { error: uErr } = await sb
      .from("campaign_sends")
      .update({ status: "approved", approved_at: now.toISOString(), scheduled_for: randomSendSlot() })
      .eq("id", r.id)
      .eq("status", "draft")
    if (!uErr) approved++
  }
  return { success: true, approved }
}

export interface PauseState {
  paused: boolean
  reason?: string
  until?: string | null
  by?: string
  at?: string
}

export async function getPauseState(): Promise<PauseState> {
  const sb = getLeadsClient()
  const { data } = await sb.from("campaign_settings").select("value").eq("key", "pause").maybeSingle()
  const v = (data?.value ?? {}) as PauseState
  if (v.paused && v.until && new Date(v.until).getTime() < Date.now()) return { paused: false }
  return { paused: !!v.paused, reason: v.reason, until: v.until ?? null, by: v.by, at: v.at }
}

export async function setPaused(paused: boolean, reason: string, by: string, hours?: number): Promise<void> {
  const sb = getLeadsClient()
  const value: PauseState = paused
    ? { paused: true, reason, by, at: new Date().toISOString(), until: hours ? new Date(Date.now() + hours * 3_600_000).toISOString() : null }
    : { paused: false, reason, by, at: new Date().toISOString() }
  await sb.from("campaign_settings").upsert({ key: "pause", value, updated_at: new Date().toISOString() })
}

export async function campaignStatusLine(): Promise<string> {
  const sb = getLeadsClient()
  const pause = await getPauseState()
  const today = (() => { const p = ptParts(new Date()); return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}` })()
  const startOfDay = new Date(`${today}T00:00:00-07:00`).toISOString()
  const [{ count: draft }, { count: approved }, { count: sentToday }, { count: bouncedToday }] = await Promise.all([
    sb.from("campaign_sends").select("id", { count: "exact", head: true }).eq("status", "draft"),
    sb.from("campaign_sends").select("id", { count: "exact", head: true }).eq("status", "approved"),
    sb.from("campaign_sends").select("id", { count: "exact", head: true }).eq("status", "sent").gte("sent_at", startOfDay),
    sb.from("campaign_events").select("id", { count: "exact", head: true }).eq("kind", "bounce").gte("occurred_at", startOfDay),
  ])
  const state = pause.paused ? `⏸ PAUSED (${pause.reason ?? "manual"}${pause.until ? ` until ${new Date(pause.until).toLocaleString("en-US", { timeZone: PT })}` : ""})` : "▶️ running"
  return `${state} · sender ${process.env.CAMPAIGN_SEND_AS ?? "?"} · today: ${sentToday ?? 0} sent, ${bouncedToday ?? 0} bounced · queue: ${draft ?? 0} drafts awaiting ✅, ${approved ?? 0} approved`
}
