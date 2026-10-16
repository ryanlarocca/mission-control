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
// `suppression` (source = vendor_marketing) so a repeat from the same number
// is dropped quietly — no second STOP, no second alert.

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

export function escapeTelegramHtml(s: string): string {
  return s.replace(/[<>&]/g, c => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"))
}

export interface VendorMarketingOutcome {
  /** false when this sender was already handled once — nothing sent, no alert. */
  handled: boolean
  stopSent: boolean
  stopFrom: string | null
  stopError: string | null
  suppressionError: string | null
}

/**
 * Reply STOP from the receiving line, remember the sender, alert Ryan with
 * the full message. Never touches `leads`.
 */
export async function handleVendorMarketingText(
  sb: SupabaseClient,
  args: { from: string; to: string; body: string }
): Promise<VendorMarketingOutcome> {
  const { from, to, body } = args
  const label = getCampaignSource(to) || to || "unknown line"
  const phone10 = normalizeSuppressionPhone(from)

  // Repeat sender → quiet drop. (Short codes are <10 digits and never
  // normalize, so each short-code blast is handled fresh — rare enough.)
  if (phone10) {
    const { data, error } = await sb
      .from("suppression")
      .select("id")
      .eq("source", VENDOR_MARKETING_SOURCE)
      .eq("phone", phone10)
      .limit(1)
    if (error) console.warn("[vendor-marketing] suppression lookup failed:", error.message)
    else if ((data ?? []).length > 0) {
      console.log(`[vendor-marketing] repeat from ${from} to ${label} — dropped quietly`)
      return { handled: false, stopSent: false, stopFrom: null, stopError: null, suppressionError: null }
    }
  }

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

  // 2. Remember the sender so the next blast is a silent drop.
  let suppressionError: string | null = null
  if (phone10) {
    try {
      await addSuppression(sb, {
        phone: from,
        reason: `vendor marketing text to ${label}: ${body.slice(0, 140)}`,
        source: VENDOR_MARKETING_SOURCE,
        source_ref: phone10,
        channel: "sms",
        audience: "vendor",
      })
    } catch (e) {
      suppressionError = e instanceof Error ? e.message : String(e)
      console.error("[vendor-marketing] suppression insert failed:", suppressionError)
    }
  }

  // 3. Alert — its own shape (no 🚫, no "Lead"), full message quoted.
  const lines = [`📣 Vendor marketing text — <b>${escapeTelegramHtml(label)}</b> — ${escapeTelegramHtml(from)}`]
  lines.push(stopSent ? `Replied STOP from ${stopFrom}` : `⚠️ STOP reply failed: ${escapeTelegramHtml(stopError ?? "unknown")}`)
  if (suppressionError) lines.push(`⚠️ Not remembered (suppression insert failed): ${escapeTelegramHtml(suppressionError)}`)
  lines.push(`"${escapeTelegramHtml(body)}"`)
  await sendTelegramAlert(lines.join("\n"))

  return { handled: true, stopSent, stopFrom, stopError, suppressionError }
}
