import { NextResponse } from "next/server"
import { validateTelegramInitData } from "@/lib/telegramWebApp"
import { FIELD_LABELS, blankFields, fieldsFromInput, formatMoney, validateFields } from "@/lib/offerContract"
import {
  clearOfferDraft,
  generateAndDeliver,
  getOfferDraft,
  newDraft,
  offerChatId,
  postOfferCard,
  setOfferDraft,
  settleOfferDraft,
  tgCall,
  type OfferDraft,
} from "@/lib/offerBot"

// Offer bot Mini App API (briefs/OFFER_BOT.md). Public in middleware; auth is
// Telegram initData (HMAC over CAMPAIGN_BOT_TOKEN) and the user must be
// Ryan (TELEGRAM_CHAT_ID). GET loads the pending draft (or a blank one);
// POST saves / generates / cancels. Generation is the same pipeline as the
// ✅ button — the PDF goes to Ryan's chat and Drive, never anywhere else.

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

type Auth = { ok: true; chatId: number } | { ok: false; status: number; error: string }

function authenticate(initData: unknown): Auth {
  const token = process.env.CAMPAIGN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || ""
  const allowed = process.env.TELEGRAM_CHAT_ID
  if (!token || !allowed) return { ok: false, status: 503, error: "offer bot not configured" }
  if (typeof initData !== "string" || !initData) return { ok: false, status: 401, error: "open this page from the Telegram bot" }
  const v = validateTelegramInitData(initData, token)
  if (!v.ok) return { ok: false, status: 401, error: v.error }
  if (String(v.user.id) !== String(allowed)) return { ok: false, status: 403, error: "not allowed" }
  const chatId = offerChatId()
  if (chatId === null) return { ok: false, status: 503, error: "TELEGRAM_CHAT_ID invalid" }
  return { ok: true, chatId }
}

/** What the form shows: strings, money pre-formatted, stips one per line. */
function draftForForm(draft: OfferDraft | null) {
  const d = draft ?? newDraft()
  const f = d.fields
  return {
    status: d.status,
    missing: d.missing,
    unclear: d.unclear,
    source_text: d.source_text,
    fields: {
      seller_name: f.seller_name ?? "",
      property_address: f.property_address ?? "",
      address_needs_confirm: f.address_needs_confirm,
      purchase_price: f.purchase_price === null ? "" : formatMoney(f.purchase_price),
      earnest_money: f.earnest_money === null ? "" : formatMoney(f.earnest_money),
      closing_days: String(f.closing_days),
      agreement_date: f.agreement_date,
      seller_signer_name: f.seller_signer_name ?? "",
      seller_tel: f.seller_tel ?? "",
      seller_email: f.seller_email ?? "",
      special_stipulations: f.special_stipulations.join("\n"),
    },
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const auth = authenticate(url.searchParams.get("initData"))
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status })
  const draft = await getOfferDraft()
  return NextResponse.json({ ok: true, draft: draftForForm(draft) })
}

export async function POST(request: Request) {
  let body: { initData?: unknown; action?: unknown; fields?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ ok: false, error: "bad JSON" }, { status: 400 })
  }
  const auth = authenticate(body.initData)
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status })
  const { chatId } = auth
  const action = body.action

  if (action === "cancel") {
    const existing = await getOfferDraft()
    await clearOfferDraft()
    if (existing?.card_message_id) {
      await tgCall("editMessageReplyMarkup", { chat_id: chatId, message_id: existing.card_message_id, reply_markup: { inline_keyboard: [] } })
    }
    await tgCall("sendMessage", { chat_id: chatId, text: "❌ Cancelled — draft cleared." })
    return NextResponse.json({ ok: true })
  }

  if (action !== "save" && action !== "generate") {
    return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 })
  }
  const input = body.fields && typeof body.fields === "object" ? (body.fields as Record<string, unknown>) : {}
  const existing = await getOfferDraft()
  const parsed = fieldsFromInput(input)
  // The form is Ryan typing the values himself — no model, nothing to trace;
  // the card keeps quoting the chat text that started the draft, if any.
  const source = existing?.source_text?.trim() ? `${existing.source_text.trim()}\n+ (edited in the form)` : ""
  const draft: OfferDraft = {
    ...(existing ?? newDraft()),
    fields: { ...blankFields(), ...parsed.fields },
    missing: parsed.missing,
    unclear: parsed.unclear,
    dropped: [],
    asked: null,
    source_text: source,
  }

  if (action === "save") {
    // Re-post the card (or the one open question) so chat and form agree.
    const saved = await settleOfferDraft(chatId, { ...draft, status: "review" })
    return NextResponse.json({ ok: true, status: saved.status, missing: saved.missing, unclear: saved.unclear })
  }

  // generate
  const v = validateFields(draft.fields)
  if (!v.ok || parsed.unclear.length) {
    const problems = [...v.missing.map((m) => `missing ${FIELD_LABELS[m]}`), ...parsed.unclear]
    return NextResponse.json({ ok: false, error: problems.join("; "), missing: v.missing, unclear: parsed.unclear }, { status: 400 })
  }
  if (existing?.status === "generating") {
    return NextResponse.json({ ok: false, error: "already generating — check the chat" }, { status: 409 })
  }
  const generating = await setOfferDraft({ ...draft, status: "generating" })
  if (generating.card_message_id) {
    await tgCall("editMessageReplyMarkup", { chat_id: chatId, message_id: generating.card_message_id, reply_markup: { inline_keyboard: [] } })
  }
  try {
    const out = await generateAndDeliver(chatId, generating, generating.card_message_id)
    return NextResponse.json({ ok: true, driveUrl: out.driveUrl, drivePath: out.drivePath, filename: out.filename })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[offer-api] generate failed:", msg)
    // Never silent: say so in the chat too, and leave the draft retryable.
    const back = await setOfferDraft({ ...generating, status: "review" })
    await tgCall("sendMessage", { chat_id: chatId, text: `⚠️ Generation failed — ${msg}` })
    await postOfferCard(chatId, back)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
