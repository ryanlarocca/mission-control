import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient, parseTwilioBody, sendTelegramAlert } from "@/lib/leads"

// Twilio StatusCallback for Card # texts sent from /api/crms/send (2026-10-26).
// Twilio returns 201 on create and the carrier can still drop the text later
// (30034 & co.), so a `failed` / `undelivered` status posts a Telegram alert
// naming the contact + error code. Every other status → 204. Public (Twilio
// has no session cookie) — middleware PUBLIC_PATHS; the only effect of a
// forged POST is an alert to Ryan.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function esc(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

export async function POST(request: NextRequest) {
  let params: URLSearchParams
  try {
    params = parseTwilioBody(await request.text())
  } catch {
    return new NextResponse(null, { status: 204 })
  }
  const status = params.get("MessageStatus") || params.get("SmsStatus") || ""
  if (status !== "failed" && status !== "undelivered") return new NextResponse(null, { status: 204 })

  const to = params.get("To") || "unknown number"
  const code = params.get("ErrorCode") || "no code"
  const rid = request.nextUrl.searchParams.get("rid") || ""
  let name: string | null = null
  if (UUID_RE.test(rid)) {
    try {
      const { data } = await getLeadsClient().from("relationships").select("name").eq("id", rid).maybeSingle<{ name: string | null }>()
      name = data?.name ?? null
    } catch (e) {
      console.error("[crms/sms-status] contact lookup failed:", e instanceof Error ? e.message : String(e))
    }
  }
  const who = name ? `<b>${esc(name)}</b> (${esc(to)})` : esc(to)
  console.warn(`[crms/sms-status] Card # text to ${to} ${status} (${code}) sid=${params.get("MessageSid") ?? "?"}`)
  await sendTelegramAlert(`⚠️ Card # text to ${who} ${status} — Twilio error ${esc(code)}. They did NOT get it; text them again from your phone or check the line in Twilio.`).catch(() => {})
  return new NextResponse(null, { status: 204 })
}
