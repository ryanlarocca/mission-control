import type { SupabaseClient } from "@supabase/supabase-js"
import { leadAlertBotToken } from "@/lib/leads"

// Once-a-day Telegram summary of automatic status moves (Ryan 2026-10-24:
// "I don't want to get infinite alerts"). At most one message a day, none on
// a day nothing moved. Each move carries a ↩️ Undo button (callback
// `lsundo:<event id>`, handled in /api/campaign/telegram — lead alerts post
// from the Marketing bot, so its taps land there).

export const UNDO_CB_PREFIX = "lsundo:"
const MAX_LINES = 20

const LABEL: Record<string, string> = { active: "Active", nurture: "Nurture", dead: "Dead", new: "New", contacted: "Contacted" }
const esc = (s: string) => s.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"))

export interface DigestEvent {
  id: string
  to_status: string
  rule: string | null
  reason: string | null
  who: string
}

/** Pure: message text + buttons for a set of moves. */
export function buildDigest(events: DigestEvent[]): { text: string; buttons: { text: string; data: string }[][] } | null {
  if (events.length === 0) return null
  const counts = new Map<string, number>()
  for (const e of events) counts.set(e.to_status, (counts.get(e.to_status) ?? 0) + 1)
  const head = Array.from(counts.entries()).map(([s, n]) => `${n} → ${LABEL[s] ?? s}`).join(" · ")
  const shown = events.slice(0, MAX_LINES)
  const lines = shown.map((e, i) => `${i + 1}. <b>${esc(e.who)}</b> → ${LABEL[e.to_status] ?? e.to_status}${e.reason ? ` — ${esc(e.reason)}` : ""}`)
  if (events.length > shown.length) lines.push(`…and ${events.length - shown.length} more (see the Leads tab).`)
  const text = `🔄 <b>Lead status moves</b> (${head})\n\n${lines.join("\n")}\n\nTap to undo any of them.`
  const buttons = shown.map((e, i) => [{ text: `↩️ Undo ${i + 1}. ${e.who.slice(0, 24)}`, data: `${UNDO_CB_PREFIX}${e.id}` }])
  return { text, buttons }
}

/** Collect undigested applied auto moves, send one message, mark them. */
export async function sendStatusDigest(sb: SupabaseClient): Promise<{ sent: boolean; count: number }> {
  const { data: evs, error } = await sb
    .from("lead_status_events")
    .select("id, lead_id, to_status, rule, reason, created_at")
    .eq("source", "auto")
    .eq("applied", true)
    .is("digested_at", null)
    .is("undone_at", null)
    .order("created_at", { ascending: true })
    .limit(200)
  if (error) throw new Error(error.message)
  if (!evs || evs.length === 0) return { sent: false, count: 0 }

  // Name each person from their cluster (the anchor row may be unnamed).
  const ids = Array.from(new Set(evs.map((e) => e.lead_id as string)))
  const { data: rows } = await sb.from("leads").select("id, name, caller_phone, email").in("id", ids)
  const byId = new Map((rows ?? []).map((r) => [r.id as string, r]))
  const events: DigestEvent[] = evs.map((e) => {
    const r = byId.get(e.lead_id as string)
    const who = (r?.name as string | null)?.trim() || (r?.caller_phone as string | null) || (r?.email as string | null) || "lead"
    return { id: e.id as string, to_status: e.to_status as string, rule: e.rule as string | null, reason: e.reason as string | null, who }
  })
  const digest = buildDigest(events)
  if (!digest) return { sent: false, count: 0 }

  const token = leadAlertBotToken()
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) throw new Error("Telegram bot token / chat id missing")
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: digest.text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: digest.buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) },
    }),
  })
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${(await res.text()).slice(0, 200)}`)
  await sb.from("lead_status_events").update({ digested_at: new Date().toISOString() }).in("id", events.map((e) => e.id))
  return { sent: true, count: events.length }
}
