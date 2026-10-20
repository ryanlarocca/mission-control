import { getLeadsClient } from "@/lib/leads"
import { downloadDriveFile, driveClient, resolveDrivePath, uploadDriveFile, type Drive } from "@/lib/drive"
import {
  FIELD_LABELS,
  OFFER_DRIVE_ROOT_ID,
  OFFER_DRIVE_ROOT_NAME,
  OFFER_MINIAPP_URL,
  OFFER_TEMPLATE_FILE_ID,
  blankFields,
  fillOfferPdf,
  formatDateMMDDYYYY,
  formatMoney,
  offerDriveRelPath,
  offerFilename,
  parseOfferTerms,
  patchOfferTerms,
  resolveExpiration,
  streetFromAddress,
  validateFields,
  type OfferFields,
  type ParsedOffer,
  type RequiredField,
} from "@/lib/offerContract"

// Offer bot — the conversation + delivery side (briefs/OFFER_BOT.md).
// Shared by the Marketing-bot webhook (app/api/campaign/telegram/route.ts)
// and the Mini App API (app/api/offer/route.ts) so both surfaces move the
// same draft. Draft state lives in inbox_settings.key = 'offer'.
//
// Hard rules enforced here: the PDF only ever goes to Ryan's chat; Drive
// upload is a new file in his folder (no sharing); the template is
// downloaded fresh and filled in memory each run.

export const OFFER_CB_PREFIX = "offer:"
export const OFFER_SETTINGS_KEY = "offer"
export const OFFER_DRAFT_TTL_MS = 24 * 60 * 60 * 1000

export type OfferStatus = "awaiting_terms" | "awaiting_field" | "awaiting_edit" | "review" | "generating"

export interface OfferDraft {
  status: OfferStatus
  fields: OfferFields
  missing: RequiredField[]
  unclear: string[]
  /** Ryan's words — the original message plus every answer/edit appended. */
  source_text: string
  card_message_id: number | null
  prompt_message_id: number | null
  /** the label of the field the open question is about (awaiting_field) */
  asked: string | null
  /** stipulations the last parse dropped for not tracing to Ryan's words */
  dropped: string[]
  updated_at: string
}

export const OFFER_EXAMPLE =
  "/offer 1234 Main St San Jose 95125, seller John and Mary Smith, 1.2M, 10k EMD, 30 day close, seller can leave furniture, seller phone 408-555-1234"

export const OFFER_HELP_TEXT = `📄 <b>/offer</b> — fill the Purchase &amp; Sale Agreement from plain English.

Send <code>/offer</code> followed by the terms in one message: property address, seller name(s), price, earnest money, closing days, any special terms, seller phone/email. Money shorthand works (1.2M, 1520k, $10,000). Anything missing or unclear, I ask about that one thing. You get a review card, then ✅ makes the PDF, sends it here and files it in Drive under ${OFFER_DRIVE_ROOT_NAME}/Offers/&lt;street&gt;.

Example:
<code>${esc(OFFER_EXAMPLE)}</code>

<code>/offer</code> alone opens a blank form.`

// ------------------------------------------------------------ helpers

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function botToken(): string | undefined {
  return process.env.CAMPAIGN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN
}

/** Ryan's chat id — every offer message goes here and nowhere else. */
export function offerChatId(): number | null {
  const v = process.env.TELEGRAM_CHAT_ID
  const n = v ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

type TgResult = { ok?: boolean; description?: string; result?: { message_id?: number } }

export async function tgCall(method: string, body: Record<string, unknown>): Promise<TgResult | null> {
  const token = botToken()
  if (!token) return null
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    return (await res.json()) as TgResult
  } catch (e) {
    console.error(`[offer-bot] ${method} failed:`, e instanceof Error ? e.message : String(e))
    return null
  }
}

async function sendText(
  chatId: number,
  text: string,
  extra: Record<string, unknown> = {},
  replyTo?: number | null
): Promise<number | null> {
  const payload = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra }
  let out = await tgCall("sendMessage", { ...payload, ...(replyTo ? { reply_to_message_id: replyTo, allow_sending_without_reply: true } : {}) })
  if (!out?.ok) out = await tgCall("sendMessage", payload)
  if (!out?.ok) {
    // HTML rejected → plain text, degraded but delivered.
    out = await tgCall("sendMessage", { ...payload, parse_mode: undefined, text: text.replace(/<[^>]+>/g, "") })
  }
  return out?.result?.message_id ?? null
}

async function clearButtons(chatId: number, messageId: number | null | undefined): Promise<void> {
  if (typeof messageId !== "number") return
  await tgCall("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } })
}

/** sendDocument via multipart; returns the Telegram message_id. Throws with
 *  Telegram's description on failure — the callers report it, never swallow. */
export async function sendOfferDocument(
  chatId: number,
  file: { filename: string; bytes: Uint8Array },
  caption: string,
  replyTo?: number | null
): Promise<number> {
  const token = botToken()
  if (!token) throw new Error("CAMPAIGN_BOT_TOKEN not set")
  const form = new FormData()
  form.append("chat_id", String(chatId))
  form.append("document", new Blob([new Uint8Array(file.bytes)], { type: "application/pdf" }), file.filename)
  form.append("caption", caption.slice(0, 1000))
  if (replyTo) {
    form.append("reply_to_message_id", String(replyTo))
    form.append("allow_sending_without_reply", "true")
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: form })
  const json = (await res.json().catch(() => null)) as TgResult | null
  if (!res.ok || !json?.ok) throw new Error(`Telegram sendDocument failed (${res.status}): ${json?.description ?? "no detail"}`)
  const id = json.result?.message_id
  if (typeof id !== "number") throw new Error("Telegram sendDocument returned no message_id")
  return id
}

// ------------------------------------------------------------ draft state

export async function getOfferDraft(): Promise<OfferDraft | null> {
  const sb = getLeadsClient()
  const { data } = await sb.from("inbox_settings").select("value").eq("key", OFFER_SETTINGS_KEY).maybeSingle()
  const v = data?.value as Partial<OfferDraft> | null | undefined
  if (!v || !v.status || !v.fields) return null
  const age = Date.now() - new Date(v.updated_at ?? 0).getTime()
  if (!Number.isFinite(age) || age > OFFER_DRAFT_TTL_MS) return null
  return {
    status: v.status,
    fields: { ...blankFields(), ...v.fields },
    missing: v.missing ?? [],
    unclear: v.unclear ?? [],
    source_text: v.source_text ?? "",
    card_message_id: v.card_message_id ?? null,
    prompt_message_id: v.prompt_message_id ?? null,
    asked: v.asked ?? null,
    dropped: v.dropped ?? [],
    updated_at: v.updated_at ?? new Date().toISOString(),
  }
}

/** Full replace (not the merge inboxAgent's setSetting does). */
export async function setOfferDraft(draft: OfferDraft): Promise<OfferDraft> {
  const sb = getLeadsClient()
  const value = { ...draft, updated_at: new Date().toISOString() }
  const { error } = await sb.from("inbox_settings").upsert({ key: OFFER_SETTINGS_KEY, value, updated_at: value.updated_at })
  if (error) throw new Error(`couldn't save the draft — ${error.message}`)
  return value
}

export async function clearOfferDraft(): Promise<void> {
  const sb = getLeadsClient()
  await sb.from("inbox_settings").delete().eq("key", OFFER_SETTINGS_KEY)
}

export function newDraft(partial: Partial<OfferDraft> = {}): OfferDraft {
  return {
    status: "awaiting_terms",
    fields: blankFields(),
    missing: [],
    unclear: [],
    source_text: "",
    card_message_id: null,
    prompt_message_id: null,
    asked: null,
    dropped: [],
    updated_at: new Date().toISOString(),
    ...partial,
  }
}

/** Is this Telegram message one of the bot's offer messages (card / prompt)? */
export function isOfferMessage(draft: OfferDraft | null, messageId: number | null | undefined): boolean {
  if (!draft || typeof messageId !== "number") return false
  return messageId === draft.card_message_id || messageId === draft.prompt_message_id
}

// ------------------------------------------------------------ card

export function renderOfferCard(draft: OfferDraft): string {
  const f = draft.fields
  const money = (n: number | null) => (n === null ? "⚠️ <i>missing</i>" : `$${formatMoney(n)}`)
  const text = (s: string | null) => (s ? esc(s) : "—")
  const expiration = resolveExpiration(f)
  const lines = [
    `📄 <b>Purchase Agreement — draft</b>`,
    ``,
    `<b>Seller:</b> ${f.seller_name ? esc(f.seller_name) : "⚠️ <i>missing</i>"}`,
    `<b>Property:</b> ${f.property_address ? esc(f.property_address) : "⚠️ <i>missing</i>"}${f.property_address && f.address_needs_confirm ? " ⚠️ <i>confirm</i>" : ""}`,
    `<b>Price:</b> ${money(f.purchase_price)}`,
    `<b>Earnest money:</b> ${money(f.earnest_money)}`,
    `<b>Close:</b> ${f.closing_days} days`,
    `<b>Agreement date:</b> ${formatDateMMDDYYYY(f.agreement_date)}`,
    `<b>Expires:</b> ${formatDateMMDDYYYY(expiration.date)} (${expiration.days} day${expiration.days === 1 ? "" : "s"}${f.expiration ? "" : ", default"})`,
    `<b>Seller signer:</b> ${text(f.seller_signer_name ?? f.seller_name)}`,
    `<b>Seller phone:</b> ${text(f.seller_tel)}`,
    `<b>Seller email:</b> ${text(f.seller_email)}`,
    `<b>Stipulations:</b>${f.special_stipulations.length ? "" : " none"}`,
    ...f.special_stipulations.map((s) => ` • ${esc(s)}`),
  ]
  if (draft.dropped.length) {
    lines.push(``, `⚠️ <i>Dropped — not in your words:</i> ${draft.dropped.map(esc).join("; ")}`)
  }
  if (draft.source_text.trim()) {
    lines.push(``, `<i>Your words:</i>`, `<i>“${esc(draft.source_text.trim())}”</i>`)
  }
  lines.push(``, `✅ makes the PDF. Reply to this message with changes (e.g. "price is 1.25M", "add stip: 14 day close option").`)
  return lines.join("\n")
}

export function offerCardMarkup(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        { text: "✅ Generate", callback_data: `${OFFER_CB_PREFIX}gen` },
        { text: "📝 Open form", web_app: { url: OFFER_MINIAPP_URL } },
      ],
      [
        { text: "✏️ Edit", callback_data: `${OFFER_CB_PREFIX}edit` },
        { text: "❌ Cancel", callback_data: `${OFFER_CB_PREFIX}cancel` },
      ],
    ],
  }
}

/** Post (or re-post) the review card; clears the previous card's buttons. */
export async function postOfferCard(chatId: number, draft: OfferDraft, replyTo?: number | null): Promise<OfferDraft> {
  await clearButtons(chatId, draft.card_message_id)
  const id = await sendText(chatId, renderOfferCard(draft), { reply_markup: offerCardMarkup() }, replyTo)
  return setOfferDraft({ ...draft, status: "review", card_message_id: id, prompt_message_id: null, asked: null })
}

/** Ask about the first open item only — force-reply so the answer threads back. */
export async function askOfferQuestion(chatId: number, draft: OfferDraft, replyTo?: number | null): Promise<OfferDraft> {
  const missing = draft.missing[0]
  const question = missing
    ? `What's the <b>${esc(FIELD_LABELS[missing])}</b>?`
    : `🤔 ${esc(draft.unclear[0] ?? "What should change?")}`
  const asked = missing ? FIELD_LABELS[missing] : draft.unclear[0] ?? null
  const id = await sendText(
    chatId,
    question,
    { reply_markup: { force_reply: true, input_field_placeholder: missing ? FIELD_LABELS[missing] : "your answer" } },
    replyTo
  )
  return setOfferDraft({ ...draft, status: "awaiting_field", prompt_message_id: id, asked })
}

/** Missing/unclear → ask; otherwise the review card. */
export async function settleOfferDraft(chatId: number, draft: OfferDraft, replyTo?: number | null): Promise<OfferDraft> {
  if (draft.missing.length || draft.unclear.length) return askOfferQuestion(chatId, draft, replyTo)
  return postOfferCard(chatId, draft, replyTo)
}

function applyParsed(draft: OfferDraft, parsed: ParsedOffer, sourceText: string): OfferDraft {
  return { ...draft, fields: parsed.fields, missing: parsed.missing, unclear: parsed.unclear, dropped: parsed.droppedStipulations, source_text: sourceText }
}

// ------------------------------------------------------------ flows (webhook)

export async function sendOfferHelp(chatId: number, replyTo?: number | null): Promise<void> {
  await sendText(chatId, OFFER_HELP_TEXT, {}, replyTo)
}

/** `/offer` with no terms: example + blank-form button, then a force-reply
 *  prompt (Telegram allows one reply_markup per message, so it takes two). */
export async function promptForTerms(chatId: number, replyTo?: number | null): Promise<void> {
  const existing = await getOfferDraft()
  if (existing && existing.status !== "awaiting_terms") {
    await clearButtons(chatId, existing.card_message_id)
    await sendText(chatId, `♻️ Replacing the pending draft${existing.fields.property_address ? ` for ${esc(streetFromAddress(existing.fields.property_address))}` : ""}.`, {}, replyTo)
  }
  await sendText(
    chatId,
    `Send the terms, e.g.\n<code>${esc(OFFER_EXAMPLE)}</code>\n\nOr tap into a blank form:`,
    { reply_markup: { inline_keyboard: [[{ text: "📝 Open blank form", web_app: { url: OFFER_MINIAPP_URL } }]] } },
    replyTo
  )
  const id = await sendText(chatId, "Terms? ↩️", { reply_markup: { force_reply: true, input_field_placeholder: "address, seller, price, EMD, close…" } })
  await setOfferDraft(newDraft({ status: "awaiting_terms", prompt_message_id: id }))
}

/** `/offer <terms>` (or terms sent in reply to the "Terms?" prompt). Parses
 *  with Sonnet, then asks one question or posts the card. Runs inside
 *  waitUntil — the caller acks Telegram first. */
export async function startOffer(chatId: number, terms: string, replyTo?: number | null): Promise<void> {
  const existing = await getOfferDraft()
  if (existing && existing.status !== "awaiting_terms" && existing.status !== "generating") {
    await clearButtons(chatId, existing.card_message_id)
    await sendText(chatId, `♻️ Replacing the pending draft${existing.fields.property_address ? ` for ${esc(streetFromAddress(existing.fields.property_address))}` : ""}.`, {}, replyTo)
  }
  const parsed = await parseOfferTerms(terms)
  const draft = applyParsed(newDraft(), parsed, terms)
  await settleOfferDraft(chatId, draft, replyTo)
}

/** An answer to a question, an edit after ✏️, or a reply to the card. */
export async function applyOfferText(chatId: number, draft: OfferDraft, text: string, replyTo?: number | null): Promise<void> {
  if (draft.status === "awaiting_terms") return startOffer(chatId, text, replyTo)
  if (draft.status === "generating") {
    await sendText(chatId, "⏳ Still generating the last one — give it a moment.", {}, replyTo)
    return
  }
  const sourceText = `${draft.source_text}\n+ ${draft.asked ? `${draft.asked}: ` : ""}${text}`.trim()
  const instruction = draft.asked ? `About the ${draft.asked}: ${text}` : text
  const parsed = await patchOfferTerms({ fields: draft.fields, unclear: draft.unclear }, instruction, sourceText)
  const next = applyParsed({ ...draft, asked: null }, parsed, sourceText)
  await settleOfferDraft(chatId, next, replyTo)
}

export type OfferCallbackOut = { toast: string; clearButtons?: boolean; text?: string; background?: () => Promise<void> }

/** `offer:gen` / `offer:edit` / `offer:cancel`. The caller answers the
 *  callback with `toast`, clears buttons when asked, posts `text`, and hands
 *  `background` to waitUntil. */
export async function handleOfferCallback(chatId: number, data: string, cardMessageId: number | undefined): Promise<OfferCallbackOut> {
  const action = data.slice(OFFER_CB_PREFIX.length)
  const draft = await getOfferDraft()
  if (!draft || draft.status === "awaiting_terms") {
    return { toast: "No draft", clearButtons: true, text: "⚠️ That draft is gone (cancelled, generated, or older than 24h). Send /offer to start again." }
  }
  if (action === "cancel") {
    await clearOfferDraft()
    return { toast: "Cancelled", clearButtons: true, text: "❌ Cancelled — draft cleared." }
  }
  if (action === "edit") {
    return {
      toast: "What should change?",
      background: async () => {
        const id = await sendText(chatId, "✏️ What should change?", { reply_markup: { force_reply: true, input_field_placeholder: "e.g. price is 1.25M" } }, cardMessageId)
        await setOfferDraft({ ...draft, status: "awaiting_edit", prompt_message_id: id, asked: null })
      },
    }
  }
  if (action === "gen") {
    if (draft.status === "generating") return { toast: "Already generating…" }
    const v = validateFields(draft.fields)
    if (!v.ok) {
      return { toast: "Missing fields", text: `⚠️ Can't generate yet — missing ${v.missing.map((m) => FIELD_LABELS[m]).join(", ")}. Reply to the card with the value.` }
    }
    await setOfferDraft({ ...draft, status: "generating" })
    return {
      toast: "Generating…",
      clearButtons: true,
      background: async () => {
        try {
          await generateAndDeliver(chatId, draft, cardMessageId)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          console.error("[offer-bot] generate failed:", msg)
          // Put the draft back so ✅ can be retried from a fresh card.
          const back = await setOfferDraft({ ...draft, status: "review" })
          await sendText(chatId, `⚠️ Generation failed — ${esc(msg)}`, {}, cardMessageId)
          await postOfferCard(chatId, back)
        }
      },
    }
  }
  return { toast: "Unknown action" }
}

// ------------------------------------------------------------ generation

export interface OfferDelivery {
  filename: string
  driveUrl: string | null
  drivePath: string
  telegramMessageId: number
}

/** Steps kept separate so scripts/offer-dry-run.ts can run them one at a time. */
export async function loadOfferTemplate(drive: Drive): Promise<Buffer> {
  const bytes = await downloadDriveFile(drive, OFFER_TEMPLATE_FILE_ID)
  if (!bytes.length) throw new Error("template download returned 0 bytes")
  return bytes
}

export async function uploadOfferToDrive(drive: Drive, fields: OfferFields, filename: string, bytes: Uint8Array): Promise<{ id: string; url: string | null; path: string }> {
  const rel = offerDriveRelPath(fields)
  const folder = await resolveDrivePath(drive, OFFER_DRIVE_ROOT_ID, rel, { create: true })
  if (!folder.id) throw new Error(`Drive folder ${rel} could not be created`)
  const up = await uploadDriveFile(drive, folder.id, filename, "application/pdf", bytes)
  return { id: up.id, url: up.webViewLink, path: `${OFFER_DRIVE_ROOT_NAME}/${rel}/${filename}` }
}

/** e-sign (esign/ on the Mac mini, briefs/ESIGN.md): the admin "new request"
 *  page pre-filled from the offer — Drive file, seller, property, date. */
export const ESIGN_BASE_URL = (process.env.ESIGN_BASE_URL || "https://sign.lrghomes.com").replace(/\/+$/, "")

export function esignNewRequestUrl(fields: OfferFields, driveFileId: string, filename: string): string {
  const q = new URLSearchParams()
  q.set("drive", driveFileId)
  q.set("title", filename.replace(/\.pdf$/i, ""))
  if (fields.property_address) q.set("address", fields.property_address)
  if (fields.agreement_date) q.set("date", fields.agreement_date)
  const signer = fields.seller_signer_name || fields.seller_name
  if (signer) q.set("name", signer)
  if (fields.seller_email) q.set("email", fields.seller_email)
  if (fields.seller_tel) q.set("phone", fields.seller_tel)
  return `${ESIGN_BASE_URL}/admin/new?${q.toString()}`
}

/**
 * ✅: template → fill → PDF to Ryan's chat → Drive → "📁 Saved" reply →
 * draft cleared. Throws on any failure (the caller reports it); a Drive
 * failure after the Telegram send says so explicitly.
 */
export async function generateAndDeliver(chatId: number, draft: OfferDraft, replyTo?: number | null): Promise<OfferDelivery> {
  const v = validateFields(draft.fields)
  if (!v.ok) throw new Error(`missing ${v.missing.map((m) => FIELD_LABELS[m]).join(", ")}`)
  const drive = await driveClient()
  const template = await loadOfferTemplate(drive)
  const { bytes, absent } = await fillOfferPdf(template, draft.fields)
  if (absent.length) console.warn("[offer-bot] template lacks fields:", absent.join(", "))
  const filename = offerFilename(draft.fields)
  const telegramMessageId = await sendOfferDocument(chatId, { filename, bytes }, `📄 ${filename}`, replyTo)
  let saved: { id: string; url: string | null; path: string }
  try {
    saved = await uploadOfferToDrive(drive, draft.fields, filename, bytes)
  } catch (e) {
    throw new Error(`the PDF was sent to Telegram, but the Drive upload failed — ${e instanceof Error ? e.message : String(e)}`)
  }
  await sendText(
    chatId,
    `📁 Saved to Drive: ${saved.url ? `<a href="${esc(saved.url)}">${esc(filename)}</a>` : esc(filename)}\n<i>${esc(saved.path)}</i>`,
    { reply_markup: { inline_keyboard: [[{ text: "✍️ Send for signature", url: esignNewRequestUrl(draft.fields, saved.id, filename) }]] } },
    telegramMessageId
  )
  await clearOfferDraft()
  return { filename, driveUrl: saved.url, drivePath: saved.path, telegramMessageId }
}
