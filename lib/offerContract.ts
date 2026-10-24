import { PDFBool, PDFDocument, PDFName, StandardFonts } from "pdf-lib"
import { SONNET, completeText, extractJsonObject } from "@/lib/llm"
import { formatMoney, formatPhone, parseMoney } from "@/lib/offerMoney"
import { DEFAULT_EXPIRATION_DAYS, formatExpirationTime, normalizeExpiration, normalizeExpirationTime, resolveExpiration } from "@/lib/offerExpiration"

export { formatMoney, formatPhone, parseMoney }
export {
  DEFAULT_EXPIRATION_DAYS,
  DEFAULT_EXPIRATION_TIME,
  addDays,
  daysBetween,
  expirationLabel,
  formatExpirationTime,
  normalizeExpiration,
  normalizeExpirationTime,
  parseExpirationDate,
  parseExpirationDays,
  parseExpirationTime,
  resolveExpiration,
} from "@/lib/offerExpiration"

// Offer bot — purchase & sale agreement fill (briefs/OFFER_BOT.md, 2026-10-15).
//
// This module is the dependency-light core: money/phone/date parsing and
// formatting, field validation, the Sonnet parse + patch calls, and the
// pdf-lib fill. Nothing here touches Telegram, Drive or Supabase — that is
// lib/offerBot.ts — so every rule unit-tests offline
// (tests/offer-contract.unit.test.ts).

export const OFFER_TEMPLATE_FILE_ID = process.env.OFFER_TEMPLATE_FILE_ID || "1ACbeyT4mC4u_fUCBZ1YnhVs-tpEFBR2F"
export const OFFER_DRIVE_ROOT_ID = process.env.OFFER_DRIVE_ROOT_ID || "1FOKTLfIP1cLW3HStneb2IWEvWSfOIzA5"
export const OFFER_MINIAPP_URL = process.env.OFFER_MINIAPP_URL || "https://mission-control-three-chi.vercel.app/offer"
export const OFFER_DRIVE_ROOT_NAME = "Business Operations"
export const OFFER_DRIVE_SUBFOLDER = "Offers/Drafts"
export const GOVERNING_STATE = "California"
export const DEFAULT_CLOSING_DAYS = 45
const PT = "America/Los_Angeles"

/** The normalised draft — what the card shows, what the PDF is filled from. */
export interface OfferFields {
  seller_name: string | null
  property_address: string | null
  address_needs_confirm: boolean
  purchase_price: number | null
  earnest_money: number | null
  closing_days: number
  special_stipulations: string[]
  /** YYYY-MM-DD */
  agreement_date: string
  /** term 4: "N days" | "YYYY-MM-DD" | null (= DEFAULT_EXPIRATION_DAYS after agreement_date); resolveExpiration() gives the date + days */
  expiration: string | null
  /** term 4: "HH:MM" 24h | null (= DEFAULT_EXPIRATION_TIME, 5:00 p.m.) */
  expiration_time: string | null
  seller_signer_name: string | null
  seller_tel: string | null
  seller_email: string | null
}

export type RequiredField = "seller_name" | "property_address" | "purchase_price" | "earnest_money"
export const REQUIRED_FIELDS: RequiredField[] = ["seller_name", "property_address", "purchase_price", "earnest_money"]

export const FIELD_LABELS: Record<keyof OfferFields, string> = {
  seller_name: "seller name",
  property_address: "property address",
  address_needs_confirm: "address confirmation",
  purchase_price: "purchase price",
  earnest_money: "earnest money deposit",
  closing_days: "closing days",
  special_stipulations: "special stipulations",
  agreement_date: "agreement date",
  expiration: "offer expiration",
  expiration_time: "offer expiration time",
  seller_signer_name: "seller signer name",
  seller_tel: "seller phone",
  seller_email: "seller email",
}

/** What the model returns (raw strings; code converts). */
export interface ModelOffer {
  seller_name: string | null
  property_address: string | null
  address_needs_confirm: boolean
  purchase_price_raw: string | null
  earnest_money_raw: string | null
  closing_days: number | null
  special_stipulations: string[]
  agreement_date: string | null
  /** "YYYY-MM-DD" for a date or day name, "N days" for a count, null if not stated */
  expiration: string | null
  /** "HH:MM" 24h, null if not stated */
  expiration_time: string | null
  seller_signer_name: string | null
  seller_tel: string | null
  seller_email: string | null
  unclear: string[]
}

// ------------------------------------------------------------ phone / dates

/** Today's calendar date in Pacific time, YYYY-MM-DD. */
export function todayPT(now: Date = new Date()): string {
  // en-CA renders YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: PT, year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
}

export function humanNowPT(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: PT, weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(now)
}

/** "2026-10-16" → "10/16/2026" (what the form shows). */
export function formatDateMMDDYYYY(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return iso
  return `${m[2]}/${m[3]}/${m[1]}`
}

export function isIsoDate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
}

// ------------------------------------------------------------ filename / paths

/** Address up to the first comma, trimmed, filename-unsafe characters removed. */
export function streetFromAddress(address: string | null | undefined): string {
  const street = String(address ?? "").split(",")[0].trim().replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim()
  return street || "Unknown address"
}

export function offerFilename(fields: Pick<OfferFields, "property_address" | "agreement_date">): string {
  return `Purchase Agreement - ${streetFromAddress(fields.property_address)} - ${fields.agreement_date}.pdf`
}

/** Drive folder path under Business Operations. */
export function offerDriveRelPath(fields: Pick<OfferFields, "property_address">): string {
  return `${OFFER_DRIVE_SUBFOLDER}/${streetFromAddress(fields.property_address)}`
}

// ------------------------------------------------------------ fields

export function blankFields(now: Date = new Date()): OfferFields {
  return {
    seller_name: null,
    property_address: null,
    address_needs_confirm: false,
    purchase_price: null,
    earnest_money: null,
    closing_days: DEFAULT_CLOSING_DAYS,
    special_stipulations: [],
    agreement_date: todayPT(now),
    expiration: null,
    expiration_time: null,
    seller_signer_name: null,
    seller_tel: null,
    seller_email: null,
  }
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s ? s : null
}

function stringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x ?? "").trim()).filter(Boolean)
  if (typeof v === "string") return v.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
  return []
}

export function normalizeClosingDays(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.replace(/[^\d.]/g, "")) : NaN
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CLOSING_DAYS
  return Math.round(n)
}

/**
 * Model JSON (raw) → OfferFields + the questions still open. Money is parsed
 * here; a raw value the parser rejects is reported as `unclear` for that
 * field (percentages, bare small numbers), a null raw value as `missing`.
 */
export function normalizeModelOffer(
  raw: Partial<ModelOffer> | Record<string, unknown>,
  opts: { now?: Date } = {}
): { fields: OfferFields; missing: RequiredField[]; unclear: string[] } {
  const r = raw as Partial<ModelOffer>
  const now = opts.now ?? new Date()
  const unclear = stringList(r.unclear)
  const sellerName = str(r.seller_name)
  const agreementDate = isIsoDate(r.agreement_date) ? r.agreement_date : todayPT(now)

  const money = (key: "purchase_price" | "earnest_money", rawVal: unknown): number | null => {
    const s = str(rawVal)
    if (s === null) return null
    const n = parseMoney(s)
    if (n === null) {
      const label = FIELD_LABELS[key]
      if (!unclear.some((u) => u.toLowerCase().includes(label) || u.toLowerCase().includes(key))) {
        unclear.push(`${label}: "${s}" — I need a dollar amount (e.g. 10k, $10,000, 1.2M).`)
      }
      return null
    }
    return n
  }

  const expiration = normalizeExpiration(r.expiration, agreementDate)
  if (expiration.problem && !unclear.some((u) => u.toLowerCase().includes("offer expiration:"))) unclear.push(expiration.problem)
  const expirationTime = normalizeExpirationTime(r.expiration_time)
  if (expirationTime.problem && !unclear.some((u) => u.toLowerCase().includes("expiration time"))) unclear.push(expirationTime.problem)
  const fields: OfferFields = {
    seller_name: sellerName,
    property_address: str(r.property_address),
    address_needs_confirm: Boolean(r.address_needs_confirm),
    purchase_price: money("purchase_price", r.purchase_price_raw),
    earnest_money: money("earnest_money", r.earnest_money_raw),
    closing_days: normalizeClosingDays(r.closing_days),
    special_stipulations: stringList(r.special_stipulations),
    agreement_date: agreementDate,
    expiration: expiration.value,
    expiration_time: expirationTime.value,
    seller_signer_name: str(r.seller_signer_name) ?? sellerName,
    seller_tel: formatPhone(str(r.seller_tel)),
    seller_email: str(r.seller_email),
  }
  return { fields, missing: missingFields(fields, unclear), unclear }
}

/** Required fields that are still null — minus the ones already in `unclear`
 *  (those get asked with the model's wording, not "what's the price?"). */
export function missingFields(fields: OfferFields, unclear: string[] = []): RequiredField[] {
  const flagged = unclear.map((u) => u.toLowerCase())
  return REQUIRED_FIELDS.filter((k) => {
    const v = fields[k]
    if (v !== null && v !== undefined && v !== "") return false
    const label = FIELD_LABELS[k]
    return !flagged.some((u) => u.includes(label) || u.includes(k))
  })
}

/** Form / API payload (strings) → OfferFields. Money accepts the same
 *  shorthand as chat. Returns the per-field problems alongside. */
export function fieldsFromInput(
  input: Record<string, unknown>,
  opts: { now?: Date } = {}
): { fields: OfferFields; missing: RequiredField[]; unclear: string[] } {
  const now = opts.now ?? new Date()
  const unclear: string[] = []
  const money = (key: "purchase_price" | "earnest_money"): number | null => {
    const v = input[key]
    if (v === null || v === undefined || v === "") return null
    const n = parseMoney(typeof v === "number" ? v : String(v))
    if (n === null) unclear.push(`${FIELD_LABELS[key]}: "${String(v)}" — I need a dollar amount (e.g. 10k, $10,000, 1.2M).`)
    return n
  }
  const sellerName = str(input.seller_name)
  const agreementDate = isIsoDate(input.agreement_date) ? input.agreement_date : todayPT(now)
  const expiration = normalizeExpiration(input.expiration, agreementDate)
  if (expiration.problem) unclear.push(expiration.problem)
  const expirationTime = normalizeExpirationTime(input.expiration_time)
  if (expirationTime.problem) unclear.push(expirationTime.problem)
  const fields: OfferFields = {
    seller_name: sellerName,
    property_address: str(input.property_address),
    address_needs_confirm: Boolean(input.address_needs_confirm),
    purchase_price: money("purchase_price"),
    earnest_money: money("earnest_money"),
    closing_days: normalizeClosingDays(input.closing_days),
    special_stipulations: stringList(input.special_stipulations),
    agreement_date: agreementDate,
    expiration: expiration.value,
    expiration_time: expirationTime.value,
    seller_signer_name: str(input.seller_signer_name) ?? sellerName,
    seller_tel: formatPhone(str(input.seller_tel)),
    seller_email: str(input.seller_email),
  }
  return { fields, missing: missingFields(fields, unclear), unclear }
}

/** Ready to generate? */
export function validateFields(fields: OfferFields): { ok: boolean; missing: RequiredField[] } {
  const missing = missingFields(fields)
  return { ok: missing.length === 0, missing }
}

// ------------------------------------------------------------ stipulations

const STOP = new Set(["the", "and", "that", "with", "from", "this", "will", "shall", "have", "must", "seller", "buyer", "property", "close", "closing", "days", "day", "escrow", "agreement", "contract", "offer", "price"])

/**
 * Keep only stipulations that trace to Ryan's words: every stipulation must
 * share at least one content word (4+ letters, not boilerplate) or a number
 * with the source text. A rewrite for clarity passes ("seller can leave
 * furniture" → "Seller may leave furniture in the property"); an invented
 * term ("Buyer waives inspection contingency") does not.
 */
export function traceStipulations(stips: string[], source: string): { kept: string[]; dropped: string[] } {
  const src = source.toLowerCase()
  const srcWords = new Set(src.match(/[a-z][a-z'-]{3,}/g) ?? [])
  const srcNums = new Set(src.match(/\d+(?:[.,]\d+)*/g) ?? [])
  const kept: string[] = []
  const dropped: string[] = []
  for (const s of stips) {
    const lower = s.toLowerCase()
    const words = (lower.match(/[a-z][a-z'-]{3,}/g) ?? []).filter((w) => !STOP.has(w))
    const nums = lower.match(/\d+(?:[.,]\d+)*/g) ?? []
    const hit = words.some((w) => srcWords.has(w)) || nums.some((n) => srcNums.has(n))
    if (hit) kept.push(s)
    else dropped.push(s)
  }
  return { kept, dropped }
}

// ------------------------------------------------------------ model calls

const JSON_SHAPE = `{
  "seller_name": string | null,
  "property_address": string | null,
  "address_needs_confirm": boolean,
  "purchase_price_raw": string | null,
  "earnest_money_raw": string | null,
  "closing_days": integer | null,
  "special_stipulations": string[],
  "agreement_date": "YYYY-MM-DD" | null,
  "expiration": "YYYY-MM-DD" | "N days" | null,
  "expiration_time": "HH:MM" | null,
  "seller_signer_name": string | null,
  "seller_tel": string | null,
  "seller_email": string | null,
  "unclear": string[]
}`

function fieldRules(now: Date): string {
  return `Today is ${humanNowPT(now)} (${todayPT(now)}, America/Los_Angeles).

Field rules:
- seller_name: the seller(s) exactly as named. null if not stated.
- property_address: the full address "street, City, CA ZIP". If Ryan gives the street and city but not the state or ZIP, complete the state (California addresses) and the ZIP when the city makes it certain, and set address_needs_confirm true. If the city cannot be determined, keep what he wrote and add an entry to unclear. null if no address at all.
- address_needs_confirm: true whenever you completed or changed any part of the address; false when it is copied as given.
- purchase_price_raw / earnest_money_raw: the amount exactly as Ryan wrote it ("1.2M", "10k", "$450,000", "2.5%"). Do not convert, compute or normalise. null if not stated. If the earnest money is given as a percentage, pass it through as written — code will ask.
- closing_days: an integer number of days. If Ryan gives a closing date instead, convert to days from the agreement date. null if not stated.
- special_stipulations: one entry per term Ryan stated beyond price, deposit and closing. Rewrite each ONLY for clarity, as a short, plain contract sentence that says exactly what he said. Never add a term, condition, contingency, credit, deadline, or detail he did not state. Nothing stated → [].
- agreement_date: YYYY-MM-DD only if Ryan names a date for the agreement; null otherwise (code defaults to today).
- expiration: the DATE the offer expires (term 4). A number of days ("good for 5 days", "5 day expiration") → "5 days" exactly as a count, do not convert it to a date. A date or a day name ("expires Friday", "by 5pm Wednesday", "end of day 10/24") → that date as YYYY-MM-DD, resolved from today's date above (the next such weekday). null if not stated (code defaults to ${DEFAULT_EXPIRATION_DAYS} calendar days after the agreement date).
- expiration_time: the TIME of day the offer expires, only if Ryan states one, as "HH:MM" 24-hour: "noon" → "12:00"; "5pm" / "5 pm" / "5:00 p.m." → "17:00"; "end of day" / "EOD" / "midnight" → "23:59"; "9am" → "09:00". null if not stated (code defaults to 5:00 p.m.). A time you cannot read → pass it through as written; code will ask.
- seller_signer_name: only if Ryan names a different signer than the seller; otherwise null.
- seller_tel / seller_email: as given, null if not given.
- unclear: one short question per thing you could not resolve from his words (an ambiguous number, two candidate sellers, a term you could not understand). Name the field. Empty when nothing is unclear.

Never guess a required field (seller, address, price, earnest money). Missing means null — do not fill from assumptions. Output only the JSON object, no prose, no code fence.`
}

const PARSE_SYSTEM = `You extract the terms of a residential real-estate purchase offer from a short message typed by the buyer, Ryan, and return them as one JSON object. You are a form-filler, not a negotiator: you never invent, infer, estimate or add any term he did not state, and you rewrite his stipulations only for clarity. Return JSON only.`

export function buildParsePrompt(text: string, now: Date = new Date()): string {
  return `${fieldRules(now)}

Return exactly this shape:
${JSON_SHAPE}

Ryan's message:
"""
${text}
"""`
}

export function buildPatchPrompt(draft: ModelOffer, instruction: string, now: Date = new Date()): string {
  return `${fieldRules(now)}

Below is the current draft of the offer (same JSON shape you return). Ryan has sent a correction or an answer. Apply it to the draft and change NOTHING else: every field he did not mention stays exactly as it is, including special_stipulations (add, remove or reword an entry only when his message says to). Resolve any entry in "unclear" that his message answers and drop it from the list; keep the ones it does not answer.

Current draft:
${JSON.stringify(draft, null, 2)}

Ryan's message:
"""
${instruction}
"""

Return the full updated JSON object only.`
}

/** OfferFields → the raw shape the patch prompt shows the model. */
export function fieldsToModelOffer(fields: OfferFields, unclear: string[]): ModelOffer {
  return {
    seller_name: fields.seller_name,
    property_address: fields.property_address,
    address_needs_confirm: fields.address_needs_confirm,
    purchase_price_raw: fields.purchase_price === null ? null : formatMoney(fields.purchase_price),
    earnest_money_raw: fields.earnest_money === null ? null : formatMoney(fields.earnest_money),
    closing_days: fields.closing_days,
    special_stipulations: [...fields.special_stipulations],
    agreement_date: fields.agreement_date,
    expiration: fields.expiration,
    expiration_time: fields.expiration_time,
    seller_signer_name: fields.seller_signer_name === fields.seller_name ? null : fields.seller_signer_name,
    seller_tel: fields.seller_tel,
    seller_email: fields.seller_email,
    unclear: [...unclear],
  }
}

export interface ParsedOffer {
  fields: OfferFields
  missing: RequiredField[]
  unclear: string[]
  /** stipulations the model returned that don't trace to Ryan's words */
  droppedStipulations: string[]
}

async function runModel(prompt: string, tag: string): Promise<Record<string, unknown>> {
  const out = await completeText({ prompt, system: PARSE_SYSTEM, model: SONNET, maxTokens: 2000, thinking: false, tag })
  let parsed: unknown
  try {
    parsed = JSON.parse(extractJsonObject(out.text))
  } catch {
    throw new Error("the model did not return valid JSON")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("the model did not return a JSON object")
  return parsed as Record<string, unknown>
}

/** First pass: Ryan's free text → fields. `sourceText` is what the
 *  stipulations must trace to (the message itself). */
export async function parseOfferTerms(text: string, opts: { now?: Date } = {}): Promise<ParsedOffer> {
  const now = opts.now ?? new Date()
  const raw = await runModel(buildParsePrompt(text, now), "[offer-parse]")
  return finishParse(raw, text, now)
}

/** Patch pass: apply an answer / edit to the current draft. `sourceText`
 *  must already include the new message so a reworded stipulation traces. */
export async function patchOfferTerms(
  current: { fields: OfferFields; unclear: string[] },
  instruction: string,
  sourceText: string,
  opts: { now?: Date } = {}
): Promise<ParsedOffer> {
  const now = opts.now ?? new Date()
  const draft = fieldsToModelOffer(current.fields, current.unclear)
  const raw = await runModel(buildPatchPrompt(draft, instruction, now), "[offer-patch]")
  return finishParse(raw, sourceText, now)
}

export function finishParse(raw: Record<string, unknown>, sourceText: string, now: Date): ParsedOffer {
  const norm = normalizeModelOffer(raw, { now })
  const traced = traceStipulations(norm.fields.special_stipulations, sourceText)
  norm.fields.special_stipulations = traced.kept
  return { fields: norm.fields, missing: norm.missing, unclear: norm.unclear, droppedStipulations: traced.dropped }
}

// ------------------------------------------------------------ PDF fill

/** The 15 template fields → their string values. seller_date stays blank; the
 *  addendum checkbox (addendum_attached) is e-sign's, left alone. */
export function pdfFieldValues(fields: OfferFields): Record<string, string> {
  const expiration = resolveExpiration(fields)
  return {
    agreement_date: formatDateMMDDYYYY(fields.agreement_date),
    seller_name: fields.seller_name ?? "",
    property_address: fields.property_address ?? "",
    purchase_price: fields.purchase_price === null ? "" : formatMoney(fields.purchase_price),
    earnest_money: fields.earnest_money === null ? "" : formatMoney(fields.earnest_money),
    closing_days: String(fields.closing_days),
    expiration_time: formatExpirationTime(expiration.time), // "by 5:00 p.m. (Pacific time)"
    expiration_date: formatDateMMDDYYYY(expiration.date), // "on 10/22/2026 (the "Expiration Date")"
    special_stipulations: fields.special_stipulations.join("\n"),
    governing_state: GOVERNING_STATE,
    seller_signer_name: fields.seller_signer_name ?? fields.seller_name ?? "",
    seller_tel: fields.seller_tel ?? "",
    seller_email: fields.seller_email ?? "",
    buyer_date: formatDateMMDDYYYY(fields.agreement_date),
    seller_date: "",
  }
}

/** Roughly five 9pt lines fit the 491×60pt stipulations box. */
const STIPS_AUTOSIZE_LINES = 5
const STIPS_AUTOSIZE_CHARS = 5 * 110

/**
 * Fill a copy of the template in memory. Fields stay fillable (no flatten);
 * appearances are regenerated with Helvetica and NeedAppearances is set so
 * every viewer shows the text. Template fields the values map doesn't name
 * are left alone; names the template lacks are reported, not fatal.
 */
export async function fillOfferPdf(
  templateBytes: Uint8Array | ArrayBuffer | Buffer,
  fields: OfferFields
): Promise<{ bytes: Uint8Array; filled: string[]; absent: string[] }> {
  const doc = await PDFDocument.load(templateBytes, { updateMetadata: false })
  const form = doc.getForm()
  const values = pdfFieldValues(fields)
  const filled: string[] = []
  const absent: string[] = []
  for (const [name, value] of Object.entries(values)) {
    let field
    try {
      field = form.getTextField(name)
    } catch {
      absent.push(name)
      continue
    }
    // The real template's special_stipulations carries /MaxLen 100 (found on
    // the first live fill, 2026-10-16): pdf-lib's setText throws
    // ExceededMaxLengthError past it. Clear the limit on every text field of
    // the in-memory copy so a future template tweak can't break generation.
    if (field.getMaxLength() !== undefined) field.setMaxLength(undefined)
    if (name === "special_stipulations") {
      field.enableMultiline()
      const lines = value ? value.split("\n").length : 0
      if (lines > STIPS_AUTOSIZE_LINES || value.length > STIPS_AUTOSIZE_CHARS) {
        try { field.setFontSize(0) } catch { /* no /DA font size to override — keep the template's */ }
      }
    }
    field.setText(value)
    filled.push(name)
  }
  const font = await doc.embedFont(StandardFonts.Helvetica)
  form.updateFieldAppearances(font)
  form.acroForm.dict.set(PDFName.of("NeedAppearances"), PDFBool.True)
  const bytes = await doc.save({ useObjectStreams: false })
  return { bytes, filled, absent }
}
