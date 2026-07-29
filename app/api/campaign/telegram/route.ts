import { NextResponse } from "next/server"
import { sendAgentsLineText, startAgentsLineRelayCall } from "@/lib/campaignSms"
import { contactPhoneByName, sendCampaignEmailReply } from "@/lib/campaignEmail"
import {
  attachDraftMessageId,
  discardPendingDraft,
  draftCampaignEmail,
  findDraftByTgMessage,
  reviseCampaignDraft,
  sendPendingDraft,
  type DraftResult,
} from "@/lib/campaignDraft"

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
export const maxDuration = 60 // draft: commands wait on a Claude API call

const CALL_INTENT_RE = /^(please\s+)?call(\s+(her|him|them|back))*(\s+back)?[.!\s]*$/i

type TgMessage = {
  message_id?: number
  chat?: { id?: number }
  text?: string
  reply_to_message?: { message_id?: number; text?: string; caption?: string }
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

async function tg(
  method: string,
  body: Record<string, unknown>
): Promise<{ ok?: boolean; result?: { message_id?: number } } | null> {
  const token = botToken()
  if (!token) return null
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    return (await res.json()) as { ok?: boolean; result?: { message_id?: number } }
  } catch (e) {
    console.error(`[campaign-tg] ${method} failed:`, e instanceof Error ? e.message : String(e))
    return null
  }
}

/** Post a draft (new or revised) with its action buttons and link the
 * Telegram message back to the draft row so reply-to-draft revising works. */
async function postDraft(chatId: number, replyToMessageId: number | undefined, out: DraftResult): Promise<void> {
  const payload = {
    chat_id: chatId,
    text: `📝 Draft for ${out.label}:\n\n${out.draft}\n\nReply to THIS message with changes and I'll revise. Nothing sends until you tap ✅.`,
    reply_markup: {
      inline_keyboard: [[
        { text: "✅ Send", callback_data: `dsend:${out.eventId}` },
        { text: "❌ Discard", callback_data: `ddisc:${out.eventId}` },
      ]],
    },
  }
  // allow_sending_without_reply: a dead reply target (deleted message, or a
  // synthetic test update) must never eat the draft — post it standalone.
  let sent = await tg("sendMessage", {
    ...payload,
    ...(replyToMessageId ? { reply_to_message_id: replyToMessageId, allow_sending_without_reply: true } : {}),
  })
  if (!sent?.ok) sent = await tg("sendMessage", payload) // belt-and-suspenders retry without the reply link
  const tgId = sent?.result?.message_id
  if (out.eventId && typeof tgId === "number") await attachDraftMessageId(out.eventId, tgId)
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
    const dsend = /^dsend:([0-9a-f-]{36})$/.exec(cb.data)
    const ddisc = /^ddisc:([0-9a-f-]{36})$/.exec(cb.data)
    if (call) {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Calling your cell now — answer to connect." })
      const out = await startAgentsLineRelayCall(call[1])
      await tg("sendMessage", {
        chat_id: chatId,
        text: out.success
          ? `📞 Calling your cell now — answer and you'll be connected to ${out.label}.`
          : `⚠️ Couldn't start the call — ${out.error}`,
      })
    } else if (dsend) {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Sending…" })
      const out = await sendPendingDraft(dsend[1])
      if (out.success) {
        await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: cb.message?.message_id, reply_markup: { inline_keyboard: [] } })
      }
      await tg("sendMessage", {
        chat_id: chatId,
        text: out.success ? `✅ Emailed ${out.label} — same thread, from info@.` : `⚠️ Not sent — ${out.error}`,
        reply_to_message_id: cb.message?.message_id,
      })
    } else if (ddisc) {
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Discarding…" })
      const out = await discardPendingDraft(ddisc[1])
      if (out.success) {
        await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: cb.message?.message_id, reply_markup: { inline_keyboard: [] } })
      }
      await tg("sendMessage", {
        chat_id: chatId,
        text: out.success ? `🗑 Draft discarded — nothing sent.` : `⚠️ ${out.error}`,
        reply_to_message_id: cb.message?.message_id,
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

  // Reply to a posted DRAFT message = revision feedback (2026-07-29, the
  // Pamela 4plex/8plex fix). Claude rewrites with the old draft + feedback,
  // the old version is superseded (buttons cleared), v2 posts fresh buttons.
  const repliedTgId = msg.reply_to_message?.message_id
  if (typeof repliedTgId === "number") {
    const known = await findDraftByTgMessage(repliedTgId)
    if (known) {
      const out = await reviseCampaignDraft({ eventId: known.eventId, feedback: body })
      if (!out.success || !out.eventId) {
        await tg("sendMessage", {
          chat_id: chatId,
          text: `⚠️ Couldn't revise — ${out.error}`,
          reply_to_message_id: msg.message_id,
        })
        return NextResponse.json({ ok: true })
      }
      if (out.oldTgMessageId) {
        await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: out.oldTgMessageId, reply_markup: { inline_keyboard: [] } })
      }
      await postDraft(chatId, msg.message_id, out)
      return NextResponse.json({ ok: true })
    }
    // Draft posted before revisions shipped (no tg_message_id linkage)
    if (/^📝 Draft for /.test(repliedText)) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "⚠️ That draft is from before revisions shipped — reply to the agent's alert with draft: <guidance> for a fresh one.",
        reply_to_message_id: msg.message_id,
      })
      return NextResponse.json({ ok: true })
    }
  }

  // "draft: <guidance>" → Claude composes a full email in Ryan's voice;
  // posted back with [✅ Send] [❌ Discard]. Only the ✅ tap sends. Checked
  // BEFORE the phone branch so guidance is never blasted out as a raw SMS.
  const draftMatch = /^draft:\s*([\s\S]+)$/i.exec(body)
  if (draftMatch) {
    const nameMatch = /AGENT REPLY[^—]*—\s*(.+?)\s*\(after T/i.exec(repliedText)
    if (!nameMatch) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "⚠️ Drafting works on email AGENT REPLY alerts — reply to one of those with draft: <guidance>.",
        reply_to_message_id: msg.message_id,
      })
      return NextResponse.json({ ok: true })
    }
    const contactName = nameMatch[1].trim()
    const out = await draftCampaignEmail({ contactName, guidance: draftMatch[1] })
    if (!out.success || !out.eventId) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: `⚠️ Couldn't draft — ${out.error}`,
        reply_to_message_id: msg.message_id,
      })
      return NextResponse.json({ ok: true })
    }
    await postDraft(chatId, msg.message_id, out)
    return NextResponse.json({ ok: true })
  }

  const to10 = extractPhone(repliedText)
  if (!to10) {
    // Email AGENT REPLY alerts: typed replies SEND as a threaded email from
    // info@ (2026-07-27 — "Thank you Mary!" should just go). Call intents
    // look up the contact's phone and relay instead.
    const nameMatch = /AGENT REPLY[^—]*—\s*(.+?)\s*\(after T/i.exec(repliedText)
    if (nameMatch) {
      const contactName = nameMatch[1].trim()
      if (CALL_INTENT_RE.test(body)) {
        const phone = await contactPhoneByName(contactName)
        if (phone) {
          const out = await startAgentsLineRelayCall(phone)
          await tg("sendMessage", {
            chat_id: chatId,
            text: out.success
              ? `📞 Calling your cell now — answer and you'll be connected to ${out.label}.`
              : `⚠️ Couldn't start the call — ${out.error}`,
            reply_to_message_id: msg.message_id,
          })
        } else {
          await tg("sendMessage", { chat_id: chatId, text: `⚠️ No phone on file for ${contactName}.`, reply_to_message_id: msg.message_id })
        }
        return NextResponse.json({ ok: true })
      }
      const out = await sendCampaignEmailReply({ contactName, body })
      await tg("sendMessage", {
        chat_id: chatId,
        text: out.success
          ? `✅ Emailed ${out.label} — same thread, from info@.`
          : `⚠️ Not sent — ${out.error}`,
        reply_to_message_id: msg.message_id,
      })
      return NextResponse.json({ ok: true })
    }
    await tg("sendMessage", {
      chat_id: chatId,
      text: "⚠️ No phone number in that alert — reply to a call/text/voicemail/email alert.",
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
