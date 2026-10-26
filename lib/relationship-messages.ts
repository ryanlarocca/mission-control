import type { SupabaseClient } from "@supabase/supabase-js"
import { sidecarHeaders } from "./sidecar"
import { relationshipsByAnyPhone } from "./relationships"
// Live iMessage/SMS thread for a Relationships contact, read from the Mac
// mini's chat.db through the CRMS sidecar (POST /sync-imessage). Nothing is
// stored — this is a read-through so the Relationships card can show the
// real conversation and the draft generator can continue it.
//
// Best-effort everywhere: any sidecar failure resolves to [] so the card
// still renders and the composer still drafts from notes alone.

export interface ThreadMessage {
  at: string           // ISO timestamp
  fromMe: boolean
  text: string
  // Business-line texts only (Card # / office / agents line, from
  // relationship_touches): the Twilio line, E.164, or "business line" when an
  // old row didn't record it. Absent = chat.db (Ryan's own phone).
  via?: string
}

// Sidecar timestamps are Apple-epoch milliseconds (2001-01-01 base).
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1)

export async function fetchThread(phone: string, timeoutMs = 10000): Promise<ThreadMessage[]> {
  const sidecarUrl = process.env.SIDECAR_URL?.replace(/\/+$/, "")
  const norm = String(phone ?? "").replace(/\D/g, "").slice(-10)
  if (!sidecarUrl || norm.length !== 10) return []
  try {
    const res = await fetch(`${sidecarUrl}/sync-imessage`, {
      method: "POST",
      headers: sidecarHeaders(),
      body: JSON.stringify({ phone: norm }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    })
    if (!res.ok) return []
    const data = await res.json()
    const raw: Array<{ timestamp?: number; is_from_me?: boolean | number; text?: string }> =
      Array.isArray(data?.messages) ? data.messages : []
    return raw
      .filter((m) => typeof m.text === "string" && m.text.trim() && Number.isFinite(Number(m.timestamp)))
      .map((m) => ({
        at: new Date(APPLE_EPOCH_MS + Number(m.timestamp)).toISOString(),
        fromMe: m.is_from_me === true || m.is_from_me === 1,
        text: m.text!.trim(),
      }))
      .sort((a, b) => a.at.localeCompare(b.at))
  } catch (e) {
    console.warn("[relationship-messages] sidecar thread fetch failed:", e instanceof Error ? e.message : String(e))
    return []
  }
}

const DUPLICATE_WINDOW_MS = 60_000

// The whole text conversation with a contact (2026-10-26): Ryan's phone
// (chat.db via the sidecar) merged with the texts on our Twilio lines, which
// chat.db never sees — inbound sms touches (office / agents line) and Card #
// sends (action 'sent' with a twilio_number). Best-effort: any Supabase
// error falls back to the chat.db thread alone.
export async function fetchContactThread(sb: SupabaseClient, phone: string, timeoutMs = 10000): Promise<ThreadMessage[]> {
  const [live, business] = await Promise.all([fetchThread(phone, timeoutMs), fetchBusinessLineTexts(sb, phone)])
  if (business.length === 0) return live
  const merged = [...live, ...business].sort((a, b) => a.at.localeCompare(b.at))
  const out: ThreadMessage[] = []
  for (const m of merged) {
    const t = Date.parse(m.at)
    let dup = false
    // Sorted by time, so only the tail within the window can match.
    for (let i = out.length - 1; i >= 0 && t - Date.parse(out[i].at) <= DUPLICATE_WINDOW_MS; i--) {
      if (out[i].text === m.text && out[i].fromMe === m.fromMe) { dup = true; break }
    }
    if (!dup) out.push(m)
  }
  return out
}

async function fetchBusinessLineTexts(sb: SupabaseClient, phone: string): Promise<ThreadMessage[]> {
  const norm = String(phone ?? "").replace(/\D/g, "").slice(-10)
  if (norm.length !== 10) return []
  try {
    const rels = await relationshipsByAnyPhone<{ id: string }>(sb, norm, "id")
    const ids = rels.map((r) => r.id).filter(Boolean)
    if (ids.length === 0) return []
    const { data, error } = await sb
      .from("relationship_touches")
      .select("occurred_at, action, message, twilio_number")
      .in("relationship_id", ids)
      .or("and(modality.eq.sms,action.eq.inbound),and(action.eq.sent,twilio_number.not.is.null)")
      .order("occurred_at", { ascending: false })
      .limit(200)
    if (error) throw error
    const rows = (data ?? []) as { occurred_at: string | null; action: string | null; message: string | null; twilio_number: string | null }[]
    return rows
      .filter((r) => typeof r.message === "string" && r.message.trim() && r.occurred_at)
      .map((r) => ({
        at: new Date(r.occurred_at!).toISOString(),
        fromMe: r.action === "sent",
        text: r.message!.trim(),
        via: r.twilio_number ?? "business line",
      }))
  } catch (e) {
    console.warn("[relationship-messages] business-line texts fetch failed:", e instanceof Error ? e.message : String(e))
    return []
  }
}

// Compact transcript of the most recent exchanges for the draft prompt.
export function formatThreadForPrompt(thread: ThreadMessage[], limit = 8): string {
  const recent = thread.slice(-limit)
  if (recent.length === 0) return ""
  return recent
    .map((m) => {
      const date = new Date(m.at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      const who = m.fromMe ? "Ryan" : "Them"
      const text = m.text.replace(/\s+/g, " ").slice(0, 400)
      // The drafter should know which number the thread is on.
      const line = m.fromMe && m.via ? " (from business line)" : ""
      return `[${date}] ${who}: ${text}${line}`
    })
    .join("\n")
}
