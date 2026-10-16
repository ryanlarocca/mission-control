import type { SupabaseClient } from "@supabase/supabase-js"
import { getCampaignSource, sendTelegramAlert, sendTwilioSms } from "@/lib/leads"
import { addSuppression, normalizeSuppressionPhone } from "@/lib/suppression"

// Vendor marketing texts (2026-10-16). Thumbtack & co. blast promos at the
// lead-facing Twilio lines ("Pro Summit 2026 registration is live … Reply
// STOP to opt out. Register: https://thumbtack.app.link/…"). Their opt-out
// boilerplate tripped isDncMessage and Ryan got a "🚫 Lead DNC'd" alert for
// a sender that was never a lead.
//
// Ryan's rule: any marketing text to our lines → auto-reply STOP from the
// line that received it, a distinct Telegram alert that shows the full
// message, and NOTHING in the leads pipeline. The sender is remembered in
// `suppression` (source = vendor_marketing) so anything further from that
// number is dropped quietly — no second STOP, no second alert, never a lead.
//
// Lesson from the first live replay (10/16 07:06): Thumbtack answered our
// STOP within seconds — "You have successfully been unsubscribed … Reply
// START to resubscribe." — and that confirmation became a NEW lead with a
// direct-mail drip stamp. Hence (a) a known vendor sender is dropped on
// sight regardless of body, and (b) opt-out confirmations are recognised
// in their own right (✅ alert, no STOP back).

export const VENDOR_MARKETING_SOURCE = "vendor_marketing"

// A link of any shape — scheme, www., or a bare domain with a common TLD
// (branded short links like thumbtack.app.link carry no scheme in some
// vendors' templates).
const URL_RE =
  /\bhttps?:\/\/\S+|\bwww\.\S+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*\.(?:com|net|org|app|io|link|co|us|me|ly|gl|info|biz)\b(?:\/\S*)?/i

// CTIA-style opt-out boilerplate every compliant marketer appends. A seller
// replying to our letter never writes "Reply STOP to opt out" or quotes
// message-and-data rates.
const OPT_OUT_BOILERPLATE_RE =
  /\b(?:reply|text|txt|send|respond)\s+(?:with\s+)?["“']?stop\b|\bto\s+opt[\s-]?out\b|\bopt[\s-]?out\b.{0,40}\b(?:reply|text|txt)\b|\bunsubscribe\b|\bmsg\s*(?:&|and|\+)\s*data\s*rates\b|\bstop\s*(?:2|to)\s*(?:end|quit|cancel|opt)\b/i

// "You have successfully been unsubscribed … Reply START to resubscribe."
const OPT_OUT_CONFIRMATION_RE =
  /\b(?:successfully|been|now|are)\s+unsubscribed\b|\bwill\s+not\s+receive\s+any\s+(?:more|further)\b|\bno\s+(?:more|further)\s+(?:messages|texts)\s+(?:will|from)\b|\breply\s+(?:start|unstop|yes)\s+to\s+(?:re)?(?:subscribe|join|start|opt)\b|\bopt(?:ed)?[\s-]?out\s+(?:is\s+)?(?:confirmed|complete|successful)\b|\byou(?:'ve|\s+have)\s+(?:been\s+)?opted\s+out\b/i

export type VendorTextKind = "marketing" | "optout_confirmation"

/** Twilio delivers short-code senders as a bare 5–6 digit string. */
export function isShortCode(from: string | null | undefined): boolean {
  const s = String(from ?? "").trim().replace(/^\+/, "")
  return /^\d{5,6}$/.test(s)
}

/**
 * True when an inbound text is a business's marketing blast rather than a
 * person: the sender is a short code, or the body carries BOTH a link and
 * opt-out boilerplate. Checked before DNC / intake so the boilerplate never
 * reaches isDncMessage.
 */
export function isVendorMarketingText(from: string | null | undefined, body: string | null | undefined): boolean {
  if (isShortCode(from)) return true
  const text = String(body ?? "")
  if (!text.trim()) return false
  return URL_RE.test(text) && OPT_OUT_BOILERPLATE_RE.test(text)
}

/** A vendor's automated reply to our STOP. */
export function isOptOutConfirmation(body: string | null | undefined): boolean {
  const text = String(body ?? "")
  return !!text.trim() && OPT_OUT_CONFIRMATION_RE.test(text)
}

export function classifyVendorText(from: string | null | undefined, body: string | null | undefined): VendorTextKind | null {
  if (isOptOutConfirmation(body)) return "optout_confirmation"
  if (isVendorMarketingText(from, body)) return "marketing"
  return null
}

/** True when this number was already handled as a vendor (STOP sent, remembered). */
export async function isKnownVendorSender(sb: SupabaseClient, from: string): Promise<boolean> {
  const phone10 = normalizeSuppressionPhone(from)
  if (!phone10) return false
  const { data, error } = await sb
    .from("suppression")
    .select("id")
    .eq("source", VENDOR_MARKETING_SOURCE)
    .eq("phone", phone10)
    .limit(1)
  if (error) {
    console.warn("[vendor-marketing] suppression lookup failed:", error.message)
    return false
  }
  return (data ?? []).length > 0
}

export function escapeTelegramHtml(s: string): string {
  return s.replace(/[<>&]/g, c => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"))
}

export type VendorTextOutcome =
  | "not_vendor" // a person — carry on with normal intake
  | "dropped" // known vendor, nothing new to say
  | "stopped" // marketing blast: STOP sent, remembered, 📣 alert
  | "confirmed" // vendor confirmed our opt-out: remembered, ✅ alert

async function rememberVendor(sb: SupabaseClient, from: string, label: string, body: string): Promise<string | null> {
  const phone10 = normalizeSuppressionPhone(from)
  if (!phone10) return null
  try {
    await addSuppression(sb, {
      phone: from,
      reason: `vendor marketing text to ${label}: ${body.slice(0, 140)}`,
      source: VENDOR_MARKETING_SOURCE,
      source_ref: phone10,
      channel: "sms",
      audience: "vendor",
    })
    return null
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[vendor-marketing] suppression insert failed:", msg)
    return msg
  }
}

/**
 * The one entry point for the SMS webhook: classify, and if the text is a
 * vendor's, deal with it fully (STOP / remember / alert). Returns
 * "not_vendor" when the caller should proceed with normal lead intake.
 * Never touches `leads`.
 */
export async function handleInboundVendorText(
  sb: SupabaseClient,
  args: { from: string; to: string; body: string }
): Promise<VendorTextOutcome> {
  const { from, to, body } = args
  const label = getCampaignSource(to) || to || "unknown line"
  const kind = classifyVendorText(from, body)
  const known = await isKnownVendorSender(sb, from)

  if (!kind && !known) return "not_vendor"

  if (kind === "optout_confirmation") {
    const suppressionError = known ? null : await rememberVendor(sb, from, label, body)
    const lines = [`✅ Vendor confirmed opt-out — <b>${escapeTelegramHtml(label)}</b> — ${escapeTelegramHtml(from)}`]
    if (suppressionError) lines.push(`⚠️ Not remembered (suppression insert failed): ${escapeTelegramHtml(suppressionError)}`)
    lines.push(`"${escapeTelegramHtml(body)}"`)
    await sendTelegramAlert(lines.join("\n"))
    return "confirmed"
  }

  if (known) {
    // Anything else from a vendor we already STOPped — a second blast, a
    // "HELP" menu, whatever — is noise. No STOP, no alert, no lead.
    console.log(`[vendor-marketing] known vendor ${from} → ${label} — dropped quietly: ${body.slice(0, 80)}`)
    return "dropped"
  }

  const r = await handleVendorMarketingText(sb, { from, to, body, label })
  return r.stopSent || r.handled ? "stopped" : "dropped"
}

export interface VendorMarketingOutcome {
  handled: boolean
  stopSent: boolean
  stopFrom: string | null
  stopError: string | null
  suppressionError: string | null
}

/**
 * First-time marketing blast: reply STOP from the receiving line, remember
 * the sender, alert Ryan with the full message.
 */
export async function handleVendorMarketingText(
  sb: SupabaseClient,
  args: { from: string; to: string; body: string; label?: string }
): Promise<VendorMarketingOutcome> {
  const { from, to, body } = args
  const label = args.label ?? (getCampaignSource(to) || to || "unknown line")

  // 1. STOP back from the line they texted — carriers/vendors honour opt-out
  //    per recipient number, so it has to come from that line.
  let stopSent = false
  let stopFrom: string | null = null
  let stopError: string | null = null
  try {
    const r = await sendTwilioSms({ to: from, body: "STOP", preferredFrom: to || null })
    stopSent = true
    stopFrom = r.from
  } catch (e) {
    stopError = e instanceof Error ? e.message : String(e)
    console.error("[vendor-marketing] STOP reply failed:", stopError)
  }

  // 2. Remember the sender so everything further from it is a silent drop
  //    (their confirmation of our STOP arrives seconds later).
  const suppressionError = await rememberVendor(sb, from, label, body)

  // 3. Alert — its own shape (no 🚫, no "Lead"), full message quoted.
  const lines = [`📣 Vendor marketing text — <b>${escapeTelegramHtml(label)}</b> — ${escapeTelegramHtml(from)}`]
  lines.push(stopSent ? `Replied STOP from ${stopFrom}` : `⚠️ STOP reply failed: ${escapeTelegramHtml(stopError ?? "unknown")}`)
  if (suppressionError) lines.push(`⚠️ Not remembered (suppression insert failed): ${escapeTelegramHtml(suppressionError)}`)
  lines.push(`"${escapeTelegramHtml(body)}"`)
  await sendTelegramAlert(lines.join("\n"))

  return { handled: true, stopSent, stopFrom, stopError, suppressionError }
}
