import { NextResponse } from "next/server"
import { sidecarHeaders } from "@/lib/sidecar"
import { getLeadsClient, isOwnedNumber, sendTelegramAlert, sendTwilioSms, CARD_LINE, FORWARD_TO } from "@/lib/leads"
import { getCardLineFlag } from "@/lib/card-line"
import { PROD_BASE } from "@/lib/relationship-calls"
import { toE164Phone } from "@/lib/relationships"

// Proxies to the CRMS FDA sidecar on localhost:5799
// Sidecar handles iMessage → SMS fallback via AppleScript + chat.db error detection.
//
// Card # (2026-10-26): when `id` names a contact with use_card_line ON, the
// text goes through Twilio from the business-card line (408) 458-5442 instead
// — never from any other line, and never silently: a failure is a 502 AND a
// Telegram alert. No `id`, or the flag off → the sidecar path, unchanged.

const SIDECAR_URL = process.env.SIDECAR_URL || "http://localhost:5799"
const SIDECAR_TIMEOUT = 35000 // 35s — iMessage send + 5s error check + SMS fallback

// Telegram parse_mode:HTML rejects raw <, >, & in user-written text.
function esc(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

async function sendFromCardLine(id: string, phone: string, message: string): Promise<NextResponse> {
  const to = toE164Phone(phone)
  if (!to) return NextResponse.json({ success: false, error: "not a valid US phone number" }, { status: 400 })
  if (isOwnedNumber(to) || to === FORWARD_TO) {
    return NextResponse.json({ success: false, error: `${to} is one of our own numbers — not texting` }, { status: 400 })
  }
  const { data: rel } = await getLeadsClient()
    .from("relationships")
    .select("name, status")
    .eq("id", id)
    .maybeSingle<{ name: string | null; status: string | null }>()
  if (rel?.status === "do_not_contact") {
    return NextResponse.json({ success: false, error: "contact is marked do-not-contact" }, { status: 409 })
  }
  const who = rel?.name ? `${rel.name} (${to})` : to
  try {
    const out = await sendTwilioSms({
      to,
      body: message,
      preferredFrom: CARD_LINE,
      strictFrom: true,
      statusCallback: `${PROD_BASE}/api/crms/sms-status?rid=${encodeURIComponent(id)}`,
    })
    return NextResponse.json({ success: true, via: CARD_LINE, sid: out.sid })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[crms/send] card-line text to ${to} failed:`, msg)
    await sendTelegramAlert(`⚠️ Card # text NOT sent to <b>${esc(who)}</b> from (408) 458-5442 — ${esc(msg)}`).catch(() => {})
    return NextResponse.json({ success: false, error: msg }, { status: 502 })
  }
}

export async function POST(request: Request) {
  try {
    const { id, phone, message } = await request.json()
    if (!phone || !message) {
      return NextResponse.json({ error: "phone and message required" }, { status: 400 })
    }

    // Any trouble reading the flag → the sidecar path, exactly as before.
    let cardLine = false
    if (typeof id === "string" && id) {
      try {
        cardLine = await getCardLineFlag(getLeadsClient(), id)
      } catch (e) {
        console.error("[crms/send] Card # flag check failed:", e instanceof Error ? e.message : String(e))
      }
    }
    if (cardLine) return await sendFromCardLine(id, String(phone), String(message))

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), SIDECAR_TIMEOUT)

    try {
      const res = await fetch(`${SIDECAR_URL}/send`, {
        method: "POST",
        headers: sidecarHeaders(),
        body: JSON.stringify({ phone, message }),
        signal: controller.signal,
      })
      clearTimeout(timeout)

      const data = await res.json()
      return NextResponse.json(data, { status: res.ok ? 200 : 500 })
    } catch (fetchErr: unknown) {
      clearTimeout(timeout)
      const isAbort = fetchErr instanceof Error && fetchErr.name === "AbortError"
      return NextResponse.json({
        success: false,
        error: isAbort ? "timeout" : "sidecar unavailable",
      }, { status: 503 })
    }
  } catch (err) {
    console.error("crms/send error:", err)
    return NextResponse.json({ success: false, error: "internal error" }, { status: 500 })
  }
}
