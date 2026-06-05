import { NextResponse } from "next/server"
import { getLeadsClient, lookupLeadName, normalizeE164, sendLeadSms } from "@/lib/leads"

// Telegram → lead reply bridge.
//
// Telegram delivers bot updates here (registered via scripts/set-telegram-
// webhook.mjs). When Ryan REPLIES to a lead-activity alert in the Telegram
// chat, the update carries the original alert in `reply_to_message`. Those
// alerts always embed the lead's phone number (see /api/leads/sms +
// /api/leads/voice), so we extract it from the replied-to text and send the
// reply body to that lead as an SMS — via the exact same path as a Send
// click in Mission Control (sendLeadSms: DNC guard, A2P Twilio send,
// outbound timeline row, offer detection, cadence reset).
//
// Anything that isn't a reply-with-text from the configured chat is ignored.
// We always return 200 once authenticated so Telegram doesn't retry.

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

type TgChat = { id?: number }
type TgMessage = {
  message_id?: number
  chat?: TgChat
  text?: string
  reply_to_message?: { text?: string; caption?: string }
}
type TgUpdate = { update_id?: number; message?: TgMessage; edited_message?: TgMessage }

// In-process dedup: Telegram can redeliver the same update_id on network
// hiccups. Track seen update_ids for 5 minutes — enough to catch any retry
// storm. Not 100% cross-instance safe but handles 99%+ of real-world cases;
// the 60-second dedup inside sendLeadSms is the backstop for the rest.
const seenUpdateIds = new Map<number, number>() // update_id → timestamp ms
function isDuplicateUpdate(id: number): boolean {
  const now = Date.now()
  for (const uid of Array.from(seenUpdateIds.keys())) {
    if (now - (seenUpdateIds.get(uid) ?? 0) > 5 * 60_000) seenUpdateIds.delete(uid)
  }
  if (seenUpdateIds.has(id)) return true
  seenUpdateIds.set(id, now)
  return false
}

// Post a message back into the Telegram chat, optionally as a reply. Inline
// (not sendTelegramAlert) so we can thread the confirmation under Ryan's
// reply via reply_to_message_id.
async function tgSend(chatId: number, text: string, replyTo?: number): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        ...(replyTo ? { reply_to_message_id: replyTo } : {}),
      }),
    })
  } catch (e) {
    console.error("[telegram/webhook] reply send failed:", e instanceof Error ? e.message : String(e))
  }
}

export async function POST(request: Request) {
  // Auth: Telegram echoes the secret token we set at registration time. This
  // route is public at the middleware layer, so this check is the ONLY gate —
  // fail closed if the secret isn't configured, otherwise a forged POST could
  // drive outbound SMS. (The chat-id check below is spoofable on its own.)
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (!secret) {
    console.error("[telegram/webhook] TELEGRAM_WEBHOOK_SECRET not set — rejecting")
    return new NextResponse("not configured", { status: 503 })
  }
  const got = request.headers.get("x-telegram-bot-api-secret-token")
  if (got !== secret) {
    console.warn("[telegram/webhook] rejected — bad secret token")
    return new NextResponse("forbidden", { status: 401 })
  }

  let update: TgUpdate
  try {
    update = (await request.json()) as TgUpdate
  } catch {
    return NextResponse.json({ ok: true })
  }

  // Drop duplicate deliveries — Telegram retries if it doesn't hear back fast.
  if (typeof update.update_id === "number" && isDuplicateUpdate(update.update_id)) {
    console.warn(`[telegram/webhook] duplicate update_id ${update.update_id} — dropping`)
    return NextResponse.json({ ok: true })
  }

  // Only act on fresh messages (ignore edits) that are replies with text.
  const msg = update.message
  const chatId = msg?.chat?.id
  if (!msg || typeof chatId !== "number") return NextResponse.json({ ok: true })

  // Scope strictly to the configured chat — never act on a message from
  // anyone else who might find the bot.
  const allowedChat = process.env.TELEGRAM_CHAT_ID
  if (allowedChat && String(chatId) !== String(allowedChat)) {
    console.warn(`[telegram/webhook] ignoring message from non-allowed chat ${chatId}`)
    return NextResponse.json({ ok: true })
  }

  const replyBody = (msg.text || "").trim()
  const repliedText = msg.reply_to_message?.text || msg.reply_to_message?.caption || ""

  // Not a reply, or the reply has no text body → nothing to send. Stay quiet.
  if (!msg.reply_to_message || !replyBody) return NextResponse.json({ ok: true })

  // The alert we're replying to embeds the lead's phone in E.164. Pull the
  // first one out. Telegram strips HTML, so the text is plain.
  const phoneMatch = repliedText.match(/\+\d{10,15}/)
  if (!phoneMatch) {
    await tgSend(chatId, "⚠️ Couldn't find a lead phone number in that message — reply to a lead alert to send.", msg.message_id)
    return NextResponse.json({ ok: true })
  }
  const phone = normalizeE164(phoneMatch[0]) || phoneMatch[0]

  const result = await sendLeadSms({ phone, message: replyBody, source: null })

  if (result.success) {
    let label = phone
    try {
      const name = await lookupLeadName(getLeadsClient(), phone)
      if (name) label = `${name} (${phone})`
    } catch {
      /* label stays as the phone */
    }
    const warn = result.logError ? "  ⚠️ (logged with a warning)" : ""
    await tgSend(chatId, `✅ Sent to ${label}${warn}`, msg.message_id)
  } else {
    await tgSend(chatId, `⚠️ Not sent — ${result.error || "unknown error"}`, msg.message_id)
  }

  return NextResponse.json({ ok: true })
}
