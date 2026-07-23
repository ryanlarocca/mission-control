import { NextResponse } from "next/server"
import { sendAgentsLineText, startAgentsLineRelayCall } from "@/lib/campaignSms"

// Dedicated campaign-bot webhook — the ZERO-TOKEN action path (2026-07-23,
// Ryan: "get the thinking time down... maybe even no tokens"). The campaign
// bot sends every campaign alert; this route handles what comes back:
//
//   • Button taps (callback_query): "call:<10digits>" → relay call (rings
//     Ryan's cell from the agents line, announces, connects). ~1s, no AI.
//   • Text replies to an alert: "call her back"-style intents → relay call;
//     anything else → sent as an SMS from the agents line to the number in
//     the replied-to alert. Deterministic string handling, no AI.
//
// Thadius/OpenClaw never sees this traffic — its polling is a different bot.
// Auth: Telegram echoes the secret we set at webhook registration
// (scripts/setup-campaign-bot.mjs). Fail closed without it.

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const CALL_INTENT_RE = /^(please\s+)?call(\s+(her|him|them|back))*(\s+back)?[.!\s]*$/i

type TgMessage = {
  message_id?: number
  chat?: { id?: number }
  text?: string
  reply_to_message?: { text?: string; caption?: string }
}
type TgUpdate = {
  update_id?: number
  message?: TgMessage
  callback_query?: { id?: string; data?: string; message?: TgMessage; from?: { id?: number } }
}

const seen = new Map<number, number>()
function isDup(id: number): boolean {
  const now = Date.now()
  for (const k of Array.from(seen.keys())) if (now - (seen.get(k) ?? 0) > 5 * 60_000) seen.delete(k)
  if (seen.has(id)) return true
  seen.set(id, now)
  return false
}

function botToken(): string | undefined {
  return process.env.CAMPAIGN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN
}

async function tg(method: string, body: Record<string, unknown>): Promise<void> {
  const token = botToken()
  if (!token) return
  try {
    await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  } catch (e) {
    console.error(`[campaign-tg] ${method} failed:`, e instanceof Error ? e.message : String(e))
  }
}

function extractPhone(text: string): string | null {
  const m = text.match(/\((\d{3})\)\s?(\d{3})-(\d{4})/)
  return m ? `${m[1]}${m[2]}${m[3]}` : null
}

export async function POST(request: Request) {
  const secret = process.env.CAMPAIGN_TG_SECRET
  if (!secret) {
    console.error("[campaign-tg] CAMPAIGN_TG_SECRET not set — rejecting")
    return new NextResponse("not configured", { status: 503 })
  }
  if (request.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return new NextResponse("forbidden", { status: 401 })
  }

  let update: TgUpdate
  try {
    update = (await request.json()) as TgUpdate
  } catch {
    return NextResponse.json({ ok: true })
  }
  if (typeof update.update_id === "number" && isDup(update.update_id)) return NextResponse.json({ ok: true })

  const allowedChat = process.env.TELEGRAM_CHAT_ID

  // ---- Button taps: instant, zero-token ----
  const cb = update.callback_query
  if (cb?.data) {
    const chatId = cb.message?.chat?.id
    if (allowedChat && String(chatId) !== String(allowedChat)) return NextResponse.json({ ok: true })
    const call = /^call:(\d{10})$/.exec(cb.data)
    if (call) {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Calling your cell now — answer to connect." })
      const out = await startAgentsLineRelayCall(call[1])
      await tg("sendMessage", {
        chat_id: chatId,
        text: out.success
          ? `📞 Calling your cell now — answer and you'll be connected to ${out.label}.`
          : `⚠️ Couldn't start the call — ${out.error}`,
      })
    } else {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Unknown action" })
    }
    return NextResponse.json({ ok: true })
  }

  // ---- Typed replies to an alert ----
  const msg = update.message
  const chatId = msg?.chat?.id
  if (!msg || typeof chatId !== "number") return NextResponse.json({ ok: true })
  if (allowedChat && String(chatId) !== String(allowedChat)) return NextResponse.json({ ok: true })

  const body = (msg.text || "").trim()
  const repliedText = msg.reply_to_message?.text || msg.reply_to_message?.caption || ""
  if (!body) return NextResponse.json({ ok: true })

  if (!msg.reply_to_message) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Reply to a specific alert to act on it (tap-and-reply). Buttons on alerts work too. For questions, ask Thadius.",
      reply_to_message_id: msg.message_id,
    })
    return NextResponse.json({ ok: true })
  }

  const to10 = extractPhone(repliedText)
  if (!to10) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: /AGENT REPLY/i.test(repliedText)
        ? "✉️ That's an email reply — answer it from Gmail (the thread is in info@)."
        : "⚠️ No phone number in that alert — reply to a call/text/voicemail alert.",
      reply_to_message_id: msg.message_id,
    })
    return NextResponse.json({ ok: true })
  }

  if (CALL_INTENT_RE.test(body)) {
    const out = await startAgentsLineRelayCall(to10)
    await tg("sendMessage", {
      chat_id: chatId,
      text: out.success
        ? `📞 Calling your cell now — answer and you'll be connected to ${out.label}.`
        : `⚠️ Couldn't start the call — ${out.error}`,
      reply_to_message_id: msg.message_id,
    })
    return NextResponse.json({ ok: true })
  }

  const out = await sendAgentsLineText({ to10, body })
  const fmt = `(${to10.slice(0, 3)}) ${to10.slice(3, 6)}-${to10.slice(6)}`
  await tg("sendMessage", {
    chat_id: chatId,
    text: out.success
      ? `✅ Texted ${out.contactName ? `${out.contactName} ` : ""}${fmt} from the agents line`
      : `⚠️ Not sent — ${out.error}`,
    reply_to_message_id: msg.message_id,
  })
  return NextResponse.json({ ok: true })
}
