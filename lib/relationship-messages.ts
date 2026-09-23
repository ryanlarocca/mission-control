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
      headers: { "Content-Type": "application/json" },
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

// Compact transcript of the most recent exchanges for the draft prompt.
export function formatThreadForPrompt(thread: ThreadMessage[], limit = 8): string {
  const recent = thread.slice(-limit)
  if (recent.length === 0) return ""
  return recent
    .map((m) => {
      const date = new Date(m.at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      const who = m.fromMe ? "Ryan" : "Them"
      const text = m.text.replace(/\s+/g, " ").slice(0, 400)
      return `[${date}] ${who}: ${text}`
    })
    .join("\n")
}
