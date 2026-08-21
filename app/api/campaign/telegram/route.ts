import { NextResponse } from "next/server"
import { waitUntil } from "@vercel/functions"
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
import {
  applyTemplateCopy,
  discardTemplateCopy,
  reviseTemplateCopy,
  reviseTemplatePending,
  type CopyResult,
} from "@/lib/campaignTemplates"
import {
  extractContactFromImage,
  findDuplicates,
  formatPending,
  insertRelationship,
  parseCaptionHints,
  parsePending,
  retierRelationship,
  type ExtractedContact,
  type ImageMediaType,
  type Tier,
} from "@/lib/contactIntake"
import { CALENDAR_INTENT_RE, createCalendarEvent, extractEvent } from "@/lib/calendarIntake"

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
export const maxDuration = 60 // draft:/photo intake wait on a Claude API call

const CALL_INTENT_RE = /^(please\s+)?call(\s+(her|him|them|back))*(\s+back)?[.!\s]*$/i

type TgMessage = {
  message_id?: number
  chat?: { id?: number }
  text?: string
  caption?: string
  photo?: Array<{ file_id: string; file_size?: number; width?: number; height?: number }>
  document?: { file_id: string; mime_type?: string; file_size?: number }
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

/** Post a template-copy preview with Apply/Discard buttons. */
async function postCopyPreview(chatId: number, replyToMessageId: number | undefined, out: CopyResult): Promise<void> {
  const payload = {
    chat_id: chatId,
    text: `📄 T${out.touch} template rewrite (rendered for "Alex"):\n\n————————————\nSubject: ${out.preview?.subject}\n————————————\n${out.preview?.body}\n————————————\n\n✅ Apply updates the template AND re-renders every un-sent T${out.touch} draft in the queue. Reply to THIS message with tweaks to revise. Nothing changes until you tap ✅.`,
    reply_markup: {
      inline_keyboard: [[
        { text: "✅ Apply", callback_data: `capply:${out.eventId}` },
        { text: "❌ Discard", callback_data: `cdisc:${out.eventId}` },
      ]],
    },
  }
  let sent = await tg("sendMessage", {
    ...payload,
    ...(replyToMessageId ? { reply_to_message_id: replyToMessageId, allow_sending_without_reply: true } : {}),
  })
  if (!sent?.ok) sent = await tg("sendMessage", payload)
  const tgId = sent?.result?.message_id
  if (out.eventId && typeof tgId === "number") await attachDraftMessageId(out.eventId, tgId)
}

/** Download a Telegram file by file_id → base64 + media type. */
async function tgDownload(fileId: string): Promise<{ base64: string; mediaType: ImageMediaType } | { error: string }> {
  const token = botToken()
  if (!token) return { error: "bot token not set" }
  const meta = (await tg("getFile", { file_id: fileId })) as { ok?: boolean; result?: { file_path?: string } } | null
  const path = meta?.result?.file_path
  if (!meta?.ok || !path) return { error: "Telegram getFile failed" }
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${path}`)
  if (!res.ok) return { error: `download failed (${res.status})` }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > 15 * 1024 * 1024) return { error: "image too large" }
  const ext = path.toLowerCase().split(".").pop()
  const mediaType: ImageMediaType =
    ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/jpeg"
  return { base64: buf.toString("base64"), mediaType }
}

function fmtPhone(p: string | null): string {
  return p ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : "no phone"
}

/** Final step of contact intake: insert + confirm. Assumes required fields present. */
async function addContactAndReport(chatId: number, replyTo: number | undefined, c: ExtractedContact): Promise<void> {
  const out = await insertRelationship({
    name: c.name!,
    phone: c.phone,
    email: c.email,
    category: c.category!,
    tier: c.tier ?? "C",
    source: c.source,
    notes: c.notes,
  })
  await tg("sendMessage", {
    chat_id: chatId,
    text: out.success
      ? `✅ Added ${c.name} (${c.category} / Tier ${c.tier ?? "C"}) — ${fmtPhone(c.phone)}${c.email ? `, ${c.email}` : ""}. Live in Mission Control → Relationships.${c.tier ? "" : " Tier defaulted to C — say the word to re-tier."}`
      : `❌ Add failed — ${out.error}. Nothing was written.`,
    ...(replyTo ? { reply_to_message_id: replyTo, allow_sending_without_reply: true } : {}),
  })
}

/** Text or photo(+caption) → Google Calendar event (2026-08-21, replaces the
 * Thadius calendar-events skill). Creates immediately when unambiguous;
 * asks one question otherwise. */
async function handleCalendar(chatId: number, msg: TgMessage, text: string): Promise<void> {
  let image: { base64: string; mediaType: ImageMediaType } | undefined
  const fileId = msg.photo?.length ? msg.photo[msg.photo.length - 1].file_id : msg.document?.file_id
  if (fileId) {
    const img = await tgDownload(fileId)
    if ("error" in img) {
      await tg("sendMessage", { chat_id: chatId, text: `⚠️ Couldn't fetch the image — ${img.error}`, reply_to_message_id: msg.message_id })
      return
    }
    image = img
  }
  const { event, error } = await extractEvent({ text, image })
  if (!event) {
    await tg("sendMessage", { chat_id: chatId, text: `⚠️ Couldn't read an event — ${error}`, reply_to_message_id: msg.message_id })
    return
  }
  if (event.question || !event.summary || !event.start || !event.end) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: `🤔 ${event.question ?? "I couldn't pin down the date/time."}${event.summary ? ` (for: ${event.summary})` : ""}\nReply with the detail and the calendar keyword, e.g. "cal: Thursday 2pm".`,
      reply_to_message_id: msg.message_id,
    })
    return
  }
  const out = await createCalendarEvent(event)
  await tg("sendMessage", {
    chat_id: chatId,
    text: out.success
      ? `📅 ${out.summary} — ${out.when}${event.location ? `\n📍 ${event.location}` : ""}${out.htmlLink ? `\n${out.htmlLink}` : ""}`
      : `⚠️ Not added — ${out.error}`,
    reply_to_message_id: msg.message_id,
    disable_web_page_preview: true,
  })
}

/** Photo (+ caption) → Relationships contact. Replaces the old Thadius
 * mc-relationships skill (2026-08-20). Dedup first, fast-path add when
 * nothing required is missing, otherwise ask for just the missing field. */
async function handleContactPhoto(chatId: number, msg: TgMessage): Promise<void> {
  const caption = msg.caption ?? ""
  const fileId = msg.photo?.length ? msg.photo[msg.photo.length - 1].file_id : msg.document?.file_id
  if (!fileId) return
  const img = await tgDownload(fileId)
  if ("error" in img) {
    await tg("sendMessage", { chat_id: chatId, text: `⚠️ Couldn't fetch the image — ${img.error}`, reply_to_message_id: msg.message_id })
    return
  }
  const { contact, error } = await extractContactFromImage({ imageBase64: img.base64, mediaType: img.mediaType, caption })
  if (!contact) {
    await tg("sendMessage", { chat_id: chatId, text: `⚠️ Couldn't read a contact from that image — ${error}`, reply_to_message_id: msg.message_id })
    return
  }
  // Caption is authoritative for category/tier — deterministic parse wins.
  const hints = parseCaptionHints(caption)
  if (hints.category) contact.category = hints.category
  if (hints.tier) contact.tier = hints.tier

  const missing: string[] = []
  if (!contact.name) missing.push("name")
  if (!contact.phone && !contact.email) missing.push("a phone or email")
  if (!contact.category) missing.push("category (Agent / Vendor / Personal / PM / Investor / PrivateMoney / Seller)")
  if (missing.length) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: `⚠️ Not added — I read ${contact.name ?? "no name"}, ${fmtPhone(contact.phone)}${contact.email ? `, ${contact.email}` : ""} but still need: ${missing.join(", ")}. Re-send the screenshot with those in the caption.`,
      reply_to_message_id: msg.message_id,
    })
    return
  }

  const dups = await findDuplicates(contact)
  if (dups.length) {
    await tg("sendMessage", { chat_id: chatId, text: formatPending(contact, dups), reply_to_message_id: msg.message_id })
    return
  }
  if (contact.uncertain || contact.otherNames.length) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: `${formatPending(contact, []).split("\n\n")[0]}\n\n🤔 I'm not fully sure about that read${contact.otherNames.length ? ` (also saw: ${contact.otherNames.join(", ")})` : ""}. Reply to THIS message "add" to add it, or "skip".`,
      reply_to_message_id: msg.message_id,
    })
    return
  }
  await addContactAndReport(chatId, msg.message_id, contact)
}

/** Reply to a ⏸ PENDING CONTACT message: add / add anyway / update / skip. */
async function handlePendingReply(chatId: number, msg: TgMessage, pendingText: string, body: string): Promise<boolean> {
  const pending = parsePending(pendingText)
  if (!pending) return false
  const b = body.toLowerCase().trim()
  const c = pending.contact
  if (/^(skip|no|cancel|nevermind|never mind)\b/.test(b)) {
    await tg("sendMessage", { chat_id: chatId, text: "👍 Skipped — nothing written.", reply_to_message_id: msg.message_id })
    return true
  }
  if (/^(update|re-?tier|retier)\b/.test(b)) {
    const id8 = pending.dupIds[0]
    const tierM = /\b([a-e])\b/i.exec(b.replace(/^(update|re-?tier|retier)/, ""))
    const tier = (tierM ? tierM[1].toUpperCase() : c.tier ?? "C") as Tier
    if (!id8) {
      await tg("sendMessage", { chat_id: chatId, text: "⚠️ No existing contact to update in that message.", reply_to_message_id: msg.message_id })
      return true
    }
    const dups = await findDuplicates(c)
    const target = dups.find((d) => d.id.startsWith(id8))
    if (!target) {
      await tg("sendMessage", { chat_id: chatId, text: "⚠️ Couldn't find that existing contact anymore.", reply_to_message_id: msg.message_id })
      return true
    }
    const out = await retierRelationship(target.id, tier)
    await tg("sendMessage", {
      chat_id: chatId,
      text: out.success ? `✅ ${target.name} re-tiered to ${tier}.` : `❌ Update failed — ${out.error}`,
      reply_to_message_id: msg.message_id,
    })
    return true
  }
  if (/^(add|yes|go|add anyway|add it|add as new)\b/.test(b) || /^(a|add)$/.test(b)) {
    // Tier override inline: "add as B"
    const tierM = /\b(?:as|tier|level)\s+([a-e])\b/i.exec(b)
    if (tierM) c.tier = tierM[1].toUpperCase() as Tier
    if (!c.name || !c.category || (!c.phone && !c.email)) {
      await tg("sendMessage", { chat_id: chatId, text: "⚠️ That pending contact is missing required fields — re-send the screenshot.", reply_to_message_id: msg.message_id })
      return true
    }
    await addContactAndReport(chatId, msg.message_id, c)
    return true
  }
  await tg("sendMessage", {
    chat_id: chatId,
    text: 'Reply "add anyway", "update" (optionally with a tier letter), or "skip".',
    reply_to_message_id: msg.message_id,
  })
  return true
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
    } else if (/^capply:/.test(cb.data)) {
      const id = cb.data.slice(7)
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Applying…" })
      const out = await applyTemplateCopy(id)
      if (out.success) {
        await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: cb.message?.message_id, reply_markup: { inline_keyboard: [] } })
      }
      await tg("sendMessage", {
        chat_id: chatId,
        text: out.success
          ? `✅ T${out.touch} template updated — ${out.redrafted} queued draft${out.redrafted === 1 ? "" : "s"} re-rendered with the new copy. All future T${out.touch} emails use it.`
          : `⚠️ Not applied — ${out.error}`,
        reply_to_message_id: cb.message?.message_id,
      })
    } else if (/^cdisc:/.test(cb.data)) {
      const id = cb.data.slice(6)
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Discarding…" })
      const out = await discardTemplateCopy(id)
      if (out.success) {
        await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: cb.message?.message_id, reply_markup: { inline_keyboard: [] } })
      }
      await tg("sendMessage", {
        chat_id: chatId,
        text: out.success ? "🗑 Copy edit discarded — template unchanged." : `⚠️ ${out.error}`,
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

  // ---- Photo → Relationships contact (2026-08-20, replaces Thadius) ----
  // Any image sent to this bot is a contact-intake request; the caption
  // carries category/tier ("add this personal relationship ... A level").
  // Ack Telegram immediately and finish in the background (waitUntil keeps
  // the function alive) — a slow vision call must never make Telegram
  // re-deliver the update, which would double-add the contact.
  if (msg.photo?.length || (msg.document?.mime_type ?? "").startsWith("image/")) {
    const caption = msg.caption ?? ""
    const job = CALENDAR_INTENT_RE.test(caption) ? handleCalendar(chatId, msg, caption) : handleContactPhoto(chatId, msg)
    waitUntil(
      job.catch(async (e) => {
        console.error("[campaign-tg] contact photo failed:", e instanceof Error ? e.message : String(e))
        await tg("sendMessage", { chat_id: chatId, text: `⚠️ Contact intake crashed — ${e instanceof Error ? e.message : String(e)}`, reply_to_message_id: msg.message_id })
      })
    )
    return NextResponse.json({ ok: true })
  }

  const body = (msg.text || "").trim()
  const repliedText = msg.reply_to_message?.text || msg.reply_to_message?.caption || ""
  if (!body) return NextResponse.json({ ok: true })

  // "cal: <what/when>" / "add to calendar …" / "put this on my calendar …"
  // → Google Calendar event. Standalone text, no reply-to needed.
  if (/^(cal(endar)?:|add (this |it )?to (my )?calendar\b|put (this |it )?on (my )?calendar\b|schedule:)/i.test(body)) {
    waitUntil(
      handleCalendar(chatId, msg, body).catch(async (e) => {
        console.error("[campaign-tg] calendar failed:", e instanceof Error ? e.message : String(e))
        await tg("sendMessage", { chat_id: chatId, text: `⚠️ Calendar add crashed — ${e instanceof Error ? e.message : String(e)}`, reply_to_message_id: msg.message_id })
      })
    )
    return NextResponse.json({ ok: true })
  }

  // Reply to a ⏸ PENDING CONTACT prompt → add anyway / update / skip.
  if (repliedText && (await handlePendingReply(chatId, msg, repliedText, body))) {
    return NextResponse.json({ ok: true })
  }

  // "copy: T2 <guidance>" — TEMPLATE-level edit (2026-08-06, Ryan: "handle
  // everything inside Telegram... change the copy... at the template
  // level"). Standalone command, no reply-to needed. Approval-gated: the
  // preview posts with [✅ Apply] [❌ Discard]; apply also re-renders the
  // touch's un-sent queue so nothing sends with stale wording.
  if (/^copy:?(\s|$)/i.test(body)) {
    const m = /^copy:?\s*t?\s*(\d{1,2})\s+([\s\S]+)$/i.exec(body)
    if (!m) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "⚠️ Nothing changed. Usage: copy: T2 <what to change> — e.g. copy: T2 shorten the middle paragraph and mention 1031 buyers.",
        reply_to_message_id: msg.message_id,
      })
      return NextResponse.json({ ok: true })
    }
    const out = await reviseTemplateCopy({ touch: Number(m[1]), guidance: m[2].trim() })
    if (!out.success || !out.eventId) {
      await tg("sendMessage", { chat_id: chatId, text: `⚠️ Couldn't rewrite — ${out.error}`, reply_to_message_id: msg.message_id })
      return NextResponse.json({ ok: true })
    }
    await postCopyPreview(chatId, msg.message_id, out)
    return NextResponse.json({ ok: true })
  }

  if (!msg.reply_to_message) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Reply to a specific alert to act on it (tap-and-reply). Buttons on alerts work too. Send a screenshot of a contact card with a caption (e.g. \"add as personal, tier A\") to add them to Relationships. Say \"cal: showing at 123 Main St tomorrow 2pm with Ana\" (or send an invite screenshot captioned \"add to calendar\") to create a calendar event.",
      reply_to_message_id: msg.message_id,
    })
    return NextResponse.json({ ok: true })
  }

  // "draft:" with no guidance must NEVER fall through to the literal-send
  // paths — Robert Moreno and Marisela Molina both received an email whose
  // entire body was "draft:" (2026-08-03/06). Catch it before anything else.
  if (/^draft:?\s*$/i.test(body)) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "⚠️ Nothing sent. draft: needs guidance — e.g. draft: thank him and ask if the seller has a price in mind.",
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
    if (known && (known.triage === "pending_copy" || known.triage.startsWith("copy_"))) {
      // Reply to a template-copy preview = template tweaks. Live pending
      // edit → revise it. Stale preview (already applied/discarded/
      // superseded) → start a FRESH edit of that touch's CURRENT template
      // from the reply (2026-08-06, Ryan: "i just want to be able to reply
      // to the message instead of copy: as a command").
      const out =
        known.triage === "pending_copy"
          ? await reviseTemplatePending({ eventId: known.eventId, feedback: body })
          : known.touch
            ? await reviseTemplateCopy({ touch: known.touch, guidance: body.replace(/^copy:\s*/i, "") })
            : { success: false as const, error: "couldn't tell which touch that preview was for — use copy: T2 <changes>" }
      if (!out.success || !out.eventId) {
        await tg("sendMessage", { chat_id: chatId, text: `⚠️ Couldn't revise — ${out.error}`, reply_to_message_id: msg.message_id })
        return NextResponse.json({ ok: true })
      }
      if ("oldTgMessageId" in out && out.oldTgMessageId) {
        await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: out.oldTgMessageId, reply_markup: { inline_keyboard: [] } })
      }
      await postCopyPreview(chatId, msg.message_id, out)
      return NextResponse.json({ ok: true })
    }
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
