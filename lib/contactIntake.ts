import Anthropic from "@anthropic-ai/sdk"
import { getLeadsClient } from "@/lib/leads"
import { normalizeCategory } from "@/lib/crms"
import { fetchAllRelationships, to10Digit } from "@/lib/relationships"

// Screenshot → Relationships contact, commanded from Telegram (2026-08-20).
//
// This used to be a Thadius/OpenClaw skill (mc-relationships): Ryan sends a
// photo of a contact card / business card / iMessage header with a caption
// like "add this personal relationship to the crms as an A level contact"
// and the contact lands in the Supabase `relationships` table. Thadius is
// phased out, so the campaign bot now owns it: the webhook downloads the
// photo, Claude vision extracts name/phone/email, the caption supplies
// category + tier, we dedupe against the book, and insert.
//
// Same rules as the old skill: fast path — if name + (phone|email) +
// category + tier are all known, add immediately, one reply. Ask only for a
// genuinely missing required field. Dedup ALWAYS runs first and a match
// blocks the insert until Ryan says "add anyway" / "update".

const MODEL = "claude-opus-5"

export const CATEGORIES = ["Agent", "Vendor", "Personal", "PM", "Investor", "PrivateMoney", "Seller"] as const
export type Category = (typeof CATEGORIES)[number]
export type Tier = "A" | "B" | "C" | "D" | "E"

export interface ExtractedContact {
  name: string | null
  phone: string | null // 10 digits
  email: string | null
  category: Category | null
  tier: Tier | null
  source: string | null
  notes: string | null
  /** other people visible in the image, if the card/thread showed several */
  otherNames: string[]
  uncertain: boolean
}

const EXTRACT_SYSTEM = `You extract ONE contact from a screenshot for a real estate investor's CRM.
The screenshot is usually an iPhone contact card, a business card, an iMessage thread header, an email header, or a Redfin/Zillow agent page. The caption (if any) is the user's instruction and overrides anything in the image for category, tier, source and notes.

Rules:
- name: the person's full name as shown. null if no name is visible.
- phone: the primary phone as exactly 10 digits (strip +1, punctuation). If the card shows the same number twice, that's one number. null if none.
- email: lowercase. null if none.
- category: map the caption's wording — "personal"/"friend"/"family" → Personal; "agent"/"realtor"/"broker" → Agent; "vendor"/"contractor"/"plumber"/"lender" → Vendor; "property manager"/"pm" → PM; "investor"/"wholesaler"/"buyer" → Investor; "private money"/"hard money" → PrivateMoney; "seller"/"owner" → Seller. If the caption doesn't say and the image makes it obvious (e.g. a Redfin agent page) use that; otherwise null.
- tier: the caption's "A level" / "tier B" / "level c" → that letter. null if not stated.
- source: one of Business Card, Referral, Redfin, iMessage, Networking, Email Thread, Other — infer from the image type (iPhone contact card → Other, iMessage → iMessage, business card → Business Card, Redfin → Redfin, email → Email Thread) unless the caption says.
- notes: any useful context from the caption or image (title, company, how they know each other). Short. null if nothing.
- otherNames: if the image clearly shows several distinct people, list the others' names. Usually [].
- uncertain: true only if the OCR is genuinely ambiguous (blurry digits, two candidate names, caption conflicts with image).
Never invent a phone or email that is not legible in the image.`

const CONTACT_TOOL: Anthropic.Tool = {
  name: "record_contact",
  description: "Record the single contact extracted from the screenshot + caption.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      name: { type: ["string", "null"] },
      phone: { type: ["string", "null"], description: "exactly 10 digits or null" },
      email: { type: ["string", "null"] },
      category: { type: ["string", "null"], enum: [...CATEGORIES, null] },
      tier: { type: ["string", "null"], enum: ["A", "B", "C", "D", "E", null] },
      source: { type: ["string", "null"] },
      notes: { type: ["string", "null"] },
      otherNames: { type: "array", items: { type: "string" } },
      uncertain: { type: "boolean" },
    },
    required: ["name", "phone", "email", "category", "tier", "source", "notes", "otherNames", "uncertain"],
    additionalProperties: false,
  },
}

export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp"

export async function extractContactFromImage(args: {
  imageBase64: string
  mediaType: ImageMediaType
  caption: string
}): Promise<{ contact?: ExtractedContact; error?: string }> {
  if (!process.env.ANTHROPIC_API_KEY) return { error: "ANTHROPIC_API_KEY not set" }
  const client = new Anthropic()
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      output_config: { effort: "low" },
      system: EXTRACT_SYSTEM,
      tools: [CONTACT_TOOL],
      tool_choice: { type: "tool", name: "record_contact" },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: args.mediaType, data: args.imageBase64 } },
            { type: "text", text: args.caption.trim() ? `Caption from the user: "${args.caption.trim()}"` : "(no caption)" },
          ],
        },
      ],
    })
    if (response.stop_reason === "refusal") return { error: "model declined to read this image" }
    const block = response.content.find((b) => b.type === "tool_use")
    if (!block || block.type !== "tool_use") return { error: "model returned no contact" }
    const raw = block.input as Record<string, unknown>
    const phone10 = to10Digit(typeof raw.phone === "string" ? raw.phone : null)
    const contact: ExtractedContact = {
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : null,
      phone: phone10.length === 10 ? phone10 : null,
      email: typeof raw.email === "string" && raw.email.includes("@") ? raw.email.trim().toLowerCase() : null,
      category: typeof raw.category === "string" ? normalizeCategory(raw.category) : null,
      tier: typeof raw.tier === "string" && /^[A-E]$/.test(raw.tier) ? (raw.tier as Tier) : null,
      source: typeof raw.source === "string" && raw.source.trim() ? raw.source.trim() : null,
      notes: typeof raw.notes === "string" && raw.notes.trim() ? raw.notes.trim() : null,
      otherNames: Array.isArray(raw.otherNames) ? raw.otherNames.filter((n): n is string => typeof n === "string") : [],
      uncertain: raw.uncertain === true,
    }
    return { contact }
  } catch (e) {
    return { error: `Claude API: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** Parse category/tier straight from the caption without AI — used to
 * override/guarantee what the model read, since the caption is authoritative. */
export function parseCaptionHints(caption: string): { category: Category | null; tier: Tier | null } {
  const c = caption.toLowerCase()
  let category: Category | null = null
  if (/\b(personal|friend|family)\b/.test(c)) category = "Personal"
  else if (/\b(private\s*money|hard\s*money)\b/.test(c)) category = "PrivateMoney"
  else if (/\b(property\s*manager|pm)\b/.test(c)) category = "PM"
  else if (/\b(investor|wholesaler|buyer)\b/.test(c)) category = "Investor"
  else if (/\b(vendor|contractor|plumber|electrician|lender|inspector)\b/.test(c)) category = "Vendor"
  else if (/\b(agent|realtor|broker)\b/.test(c)) category = "Agent"
  else if (/\b(seller|owner)\b/.test(c)) category = "Seller"
  const t = /\b(?:tier|level)\s*[-:]?\s*([a-e])\b|\b([a-e])[\s-]*(?:level|tier)\b/i.exec(caption)
  const tier = t ? ((t[1] || t[2]).toUpperCase() as Tier) : null
  return { category, tier }
}

export interface DupMatch {
  id: string
  name: string
  phone: string | null
  email: string | null
  category: string
  tier: string
  fields: string[]
}

export async function findDuplicates(c: { name: string | null; phone: string | null; email: string | null }): Promise<DupMatch[]> {
  const sb = getLeadsClient()
  const rows = await fetchAllRelationships(sb)
  const qName = (c.name ?? "").toLowerCase().split(/\s+/).filter(Boolean).join(" ")
  const out: DupMatch[] = []
  for (const r of rows) {
    const fields: string[] = []
    const rName = String(r.name ?? "").toLowerCase().split(/\s+/).filter(Boolean).join(" ")
    if (qName && rName === qName) fields.push("name")
    if (c.phone && to10Digit(r.phone) === c.phone) fields.push("phone")
    if (c.email && String(r.email ?? "").toLowerCase().trim() === c.email) fields.push("email")
    if (fields.length) out.push({ id: r.id, name: r.name, phone: r.phone, email: r.email, category: r.category, tier: r.tier, fields })
  }
  return out
}

export async function insertRelationship(c: {
  name: string
  phone: string | null
  email: string | null
  category: Category
  tier: Tier
  source: string | null
  notes: string | null
}): Promise<{ success: boolean; id?: string; error?: string }> {
  const sb = getLeadsClient()
  const { data, error } = await sb
    .from("relationships")
    .insert({
      name: c.name,
      phone: c.phone ? `+1${c.phone}` : null,
      email: c.email,
      category: c.category,
      tier: c.tier,
      source: c.source,
      notes: c.notes,
    })
    .select("id")
    .single()
  if (error) return { success: false, error: error.message }
  return { success: true, id: data.id }
}

export async function retierRelationship(id: string, tier: Tier): Promise<{ success: boolean; error?: string }> {
  const sb = getLeadsClient()
  const { error } = await sb.from("relationships").update({ tier }).eq("id", id)
  return error ? { success: false, error: error.message } : { success: true }
}

// ---- Stateless Telegram round-trip -----------------------------------
// When dedup blocks the add, we post a summary and wait for Ryan to reply
// to that message. Vercel functions hold no state, so the pending contact
// is serialized INTO the bot's message text and parsed back out of
// reply_to_message on the next turn (same trick the draft flow uses).

export const PENDING_MARKER = "⏸ PENDING CONTACT"

export function formatPending(c: ExtractedContact, dups: DupMatch[]): string {
  const fmt = (p: string | null) => (p ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : "—")
  const lines = [
    `${PENDING_MARKER}`,
    `Name: ${c.name ?? "—"}`,
    `Phone: ${fmt(c.phone)}`,
    `Email: ${c.email ?? "—"}`,
    `Category: ${c.category ?? "—"}`,
    `Tier: ${c.tier ?? "—"}`,
    `Source: ${c.source ?? "—"}`,
    `Notes: ${c.notes ?? "—"}`,
    "",
    "⚠️ Already in Relationships:",
    ...dups.slice(0, 3).map(
      (d) => `• ${d.name} — ${d.category} / Tier ${d.tier} — ${d.phone ? fmt(to10Digit(d.phone)) : d.email ?? "no contact"} (matched ${d.fields.join("+")}) [${d.id.slice(0, 8)}]`
    ),
    "",
    `Reply to THIS message: "add anyway" to add as new, "update" to re-tier the existing to ${c.tier ?? "C"}, or "skip".`,
  ]
  return lines.join("\n")
}

export function parsePending(text: string): { contact: ExtractedContact; dupIds: string[] } | null {
  if (!text.startsWith(PENDING_MARKER)) return null
  const get = (label: string) => {
    const m = new RegExp(`^${label}: (.*)$`, "m").exec(text)
    const v = m ? m[1].trim() : ""
    return v && v !== "—" ? v : null
  }
  const phone10 = to10Digit(get("Phone"))
  const cat = get("Category")
  const tier = get("Tier")
  const contact: ExtractedContact = {
    name: get("Name"),
    phone: phone10.length === 10 ? phone10 : null,
    email: get("Email"),
    category: cat ? normalizeCategory(cat) : null,
    tier: tier && /^[A-E]$/.test(tier) ? (tier as Tier) : null,
    source: get("Source"),
    notes: get("Notes"),
    otherNames: [],
    uncertain: false,
  }
  const dupIds = Array.from(text.matchAll(/\[([0-9a-f]{8})\]/g)).map((m) => m[1])
  return { contact, dupIds }
}
