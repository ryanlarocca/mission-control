// Text messages from Ryan's own cell via the CRMS sidecar on this Mac
// (iMessage first, SMS fallback — the same path the Relationships tab uses).
import { env } from "./env.mjs"

const SIDECAR = (process.env.ESIGN_SIDECAR_URL || "http://127.0.0.1:5799").replace(/\/+$/, "")

export function normalizePhone(raw) {
  const d = String(raw || "").replace(/\D/g, "")
  if (d.length === 10) return `+1${d}`
  if (d.length === 11 && d.startsWith("1")) return `+${d}`
  return null
}

/** Throws with a readable message on failure. Returns the sidecar's result. */
export async function sendText(phone, message) {
  const to = normalizePhone(phone)
  if (!to) throw new Error(`"${phone}" is not a 10-digit US phone number`)
  if (process.env.ESIGN_DRY_MAIL === "1") {
    console.log(`[esign] DRY TEXT to=${to}\n${message}`)
    return { success: true, dry: true }
  }
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 40_000)
  let res, data
  try {
    res = await fetch(`${SIDECAR}/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: to, message }), signal: ctl.signal })
    data = await res.json().catch(() => ({}))
  } catch (e) {
    throw new Error(`text could not be sent (sidecar ${e?.name === "AbortError" ? "timed out" : "unreachable"}) — ${env.ownerName}'s Mac must be awake`)
  } finally { clearTimeout(t) }
  if (!res.ok || data?.success === false) throw new Error(`text failed: ${data?.error || res.status}`)
  return data
}
