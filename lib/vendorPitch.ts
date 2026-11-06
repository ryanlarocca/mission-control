import type { SupabaseClient } from "@supabase/supabase-js"
import { completeText, extractJsonObject, hasLlmKey, SONNET } from "@/lib/llm"

// Vendor pitches on the website (Ryan, 2026-11-06). A painter texted the
// Website line and a lender (HeyLending) filled the "Sell a property" form;
// the lender got the seller confirmation email ("I'll be calling you
// shortly… a cash offer in writing") and both landed in Leads. Rule: before
// anything goes out, a person selling LRG Homes a service is screened out —
// no text, no email, no call reminders, the card is closed, and Ryan gets one
// quiet 🧹 line with their full message. NOT the Thumbtack path
// (lib/vendorMarketing): no STOP back to a real person, and nothing on the
// suppression list — they never asked off it.
//
// Fail open: unsure, no key, timeout or error → treated as a lead, exactly
// as before. Missing a seller costs more than a contractor getting an email.

export const VENDOR_PITCH_PREFIX = "Vendor pitch"

export interface VendorPitch {
  company: string | null
  gist: string
}

const SCREEN_TIMEOUT_MS = 8000

function buildPrompt(args: { channel: "form" | "text"; name?: string | null; topic?: string | null; message: string }): string {
  const from = args.channel === "form"
    ? `a contact form on lrghomes.com${args.topic ? ` (they picked "${args.topic}")` : ""}${args.name ? `, signed "${args.name}"` : ""}`
    : "a text to the phone number on lrghomes.com"
  return `LRG Homes is Ryan's small real-estate investing business: he buys houses for cash. This message came in through ${from}.

Decide one thing: is the sender pitching LRG Homes THEIR OWN product or service, to get Ryan as a customer? Examples that count: contractors and trades (painting, roofing, cleaning, landscaping), lenders and financing offers, marketing / SEO / lead-gen / web design, software, staffing, virtual assistants, insurance, "partnership" sales pitches.

These do NOT count — answer false: anyone who wants to sell a house or talk about a property; an agent, wholesaler or investor bringing a deal or a listing; a buyer or tenant; someone asking a question about LRG Homes; anything unclear. When in doubt, false.

Message:
"""
${args.message.slice(0, 2000)}
"""

Reply with JSON only: {"vendor": true|false, "company": "<their business name, or null>", "gist": "<what they're selling, under 12 words>"}`
}

/**
 * Screen a first message for a vendor pitch. Returns the pitch when the
 * sender is clearly selling LRG Homes something; null for a lead, unsure,
 * or any failure (fail open).
 */
export async function screenVendorPitch(args: {
  channel: "form" | "text"
  message: string | null | undefined
  name?: string | null
  topic?: string | null
}): Promise<VendorPitch | null> {
  const message = (args.message ?? "").trim()
  if (message.length < 20 || !hasLlmKey()) return null
  try {
    const call = completeText({
      prompt: buildPrompt({ ...args, message }),
      model: SONNET,
      maxTokens: 200,
      thinking: false,
      tag: "[vendor-pitch]",
    })
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), SCREEN_TIMEOUT_MS))
    const out = await Promise.race([call, timeout])
    if (!out) {
      console.warn("[vendor-pitch] screen timed out — treating as a lead")
      return null
    }
    const parsed = JSON.parse(extractJsonObject(out.text)) as { vendor?: unknown; company?: unknown; gist?: unknown }
    if (parsed.vendor !== true) return null
    const company = typeof parsed.company === "string" && parsed.company.trim() && parsed.company.trim().toLowerCase() !== "null"
      ? parsed.company.trim()
      : null
    const gist = typeof parsed.gist === "string" && parsed.gist.trim() ? parsed.gist.trim() : "a service pitch"
    return { company, gist }
  } catch (e) {
    console.warn("[vendor-pitch] screen failed — treating as a lead:", e instanceof Error ? e.message : String(e))
    return null
  }
}

/** The card's summary line — also how a later message from them is recognised. */
export function vendorPitchSummary(p: VendorPitch): string {
  return `${VENDOR_PITCH_PREFIX}${p.company ? ` — ${p.company}` : ""}: ${p.gist}. Not a lead; nothing was sent.`
}

/** Closes the card: dead + junk, summary says why, no follow-up date. */
export function vendorPitchColumns(p: VendorPitch): Record<string, unknown> {
  return {
    status: "dead",
    is_junk: true,
    ai_summary: vendorPitchSummary(p),
    recommended_followup_date: null,
  }
}

/** A number already closed as a vendor pitch (any row of theirs). */
export async function isKnownVendorPitch(sb: SupabaseClient, phone: string): Promise<boolean> {
  const { data, error } = await sb
    .from("leads")
    .select("id")
    .eq("caller_phone", phone)
    .eq("is_junk", true)
    .like("ai_summary", `${VENDOR_PITCH_PREFIX}%`)
    .limit(1)
  if (error) {
    console.warn("[vendor-pitch] known-vendor lookup failed:", error.message)
    return false
  }
  return (data ?? []).length > 0
}

/** The one quiet Telegram line — full message, no Call button. */
export function vendorPitchAlert(args: {
  where: string
  who: string
  pitch: VendorPitch | null
  message: string
  esc: (s: string) => string
}): string {
  const label = args.pitch
    ? `${args.pitch.company ? `${args.esc(args.pitch.company)} · ` : ""}${args.esc(args.pitch.gist)}`
    : "again"
  return [
    `🧹 Vendor pitch on the ${args.where} — ${args.who} — ${label}`,
    "Not a lead: nothing sent, no call reminders.",
    `"${args.esc(args.message.slice(0, 1200))}"`,
  ].join("\n")
}
