import Anthropic from "@anthropic-ai/sdk"
import { getLeadsClient } from "@/lib/leads"
import { normalizeCategory } from "@/lib/crms"
import { fetchAllRelationships, normalizeAltPhones, planPhoneChange, relationshipsByAnyPhone, to10Digit } from "@/lib/relationships"
import { formatUsPhone } from "@/lib/office-inbound"

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

// Sonnet 5, thinking off: this is OCR-grade extraction and the Telegram
// webhook needs a fast answer (Opus 5 at effort low measured 31s; Telegram
// re-delivers slow updates, which risks double-adds).
const MODEL = "claude-sonnet-5"

export const CATEGORIES = ["Agent", "Vendor", "Personal", "PM", "Investor", "PrivateMoney"] as const
export type Category = (typeof CATEGORIES)[number]
// normalizeCategory still knows the retired "Seller" value; a seller is a lead,
// not a relationship, so the intake drops it and asks again.
function asIntakeCategory(c: string): Category | null {
  return (CATEGORIES as readonly string[]).includes(c) ? (c as Category) : null
}
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
- category: map the caption's wording — "personal"/"friend"/"family" → Personal; "agent"/"realtor"/"broker" → Agent; "vendor"/"contractor"/"plumber"/"lender" → Vendor; "property manager"/"pm" → PM; "investor"/"wholesaler"/"buyer" → Investor; "private money"/"hard money" → PrivateMoney. A seller or property owner is a lead, not a relationship — leave category null. If the caption doesn't say and the image makes it obvious (e.g. a Redfin agent page) use that; otherwise null.
- tier: the caption's "A level" / "tier B" / "level c" → that letter. null if not stated.
- source: one of Business Card, Referral, Redfin, iMessage, Networking, Email Thread, Other — infer from the image type (iPhone contact card → Other, iMessage → iMessage, business card → Business Card, Redfin → Redfin, email → Email Thread) unless the caption says.
- notes: useful context from the caption or image (title, company, how they know each other). Short. Do NOT restate category or tier. null if nothing.
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
      // NOTE: strict mode rejects `enum` containing null on a ["string","null"]
      // type (live 400 on 2026-08-20) — use anyOf with a null branch instead.
      category: { anyOf: [{ type: "string", enum: [...CATEGORIES] }, { type: "null" }] },
      tier: { anyOf: [{ type: "string", enum: ["A", "B", "C", "D", "E"] }, { type: "null" }] },
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
      thinking: { type: "disabled" },
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
      category: typeof raw.category === "string" ? asIntakeCategory(normalizeCategory(raw.category)) : null,
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
    const rPhone = to10Digit(r.phone)
    if (qName && rName === qName) fields.push("name")
    if (c.phone && rPhone === c.phone) fields.push("phone")
    else if (c.phone && (r.alt_phones ?? []).some((p) => to10Digit(p) === c.phone)) fields.push("phone")
    if (c.email && String(r.email ?? "").toLowerCase().trim() === c.email) fields.push("email")
    // Near-miss: same last name + same phone prefix (first 7 digits) — catches
    // "Jim Morelan 464-4436" vs on-file "James Morelan 464-4449" (2026-08-20).
    if (!fields.length && qName && c.phone && rPhone.length === 10) {
      const last = (n: string) => n.split(" ").pop() ?? ""
      if (last(qName) && last(qName) === last(rName) && rPhone.slice(0, 7) === c.phone.slice(0, 7)) fields.push("last-name+phone-prefix")
    }
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

// ---- Rename a contact from Telegram (2026-10-06) ----------------------
// Ryan hands out the business card; the caller lands in Relationships as
// "(408) 513-4444" (office-inbound placeholder). He names them by replying
// to the alert: "name: Dave Chen, agent, tier B" / "rename: …" /
// "this is: …". Category + tier are optional and ride the same vocabulary
// as the screenshot captions. "name:" / "this is:" only fill a placeholder;
// "rename:" is the explicit verb that overwrites a real name.

const RENAME_CMD_RE = /^(?:name|rename|this is)\s*:\s*([\s\S]+)$/i
const HINT_WORD =
  "(?:tier|level)\\s*[-:]?\\s*[a-e]|[a-e]\\s*(?:tier|level)|[a-e]|personal|friend|family|private\\s*money|hard\\s*money|property\\s*manager|pm|investor|wholesaler|buyer|vendor|contractor|plumber|electrician|lender|inspector|agent|realtor|broker"
const TRAILING_HINT_RE = new RegExp(`\\s+(?:${HINT_WORD})$`, "i")

export interface RenameCommand {
  verb: "name" | "rename" | "this is"
  name: string
  category: Category | null
  tier: Tier | null
}

/** "name: Dave Chen, agent, B" → { name: "Dave Chen", category: "Agent", tier: "B" }.
 * Separators (comma / dash / pipe) split name from hints; without one, hint
 * words are peeled off the end of the name so "name: Dave Chen agent B" works. */
export function parseRenameCommand(body: string): RenameCommand | null {
  const m = RENAME_CMD_RE.exec(body.trim())
  if (!m) return null
  const verb = /^rename/i.test(body.trim()) ? "rename" : /^this/i.test(body.trim()) ? "this is" : "name"
  const rest = m[1].replace(/[()]/g, " ").replace(/\s+/g, " ").trim()
  const segs = rest
    .split(/\s*(?:,|;|\||—|–|\s-\s)\s*/)
    .map((x) => x.trim())
    .filter(Boolean)
  if (!segs.length) return null
  let name = segs[0]
  const hints = segs.slice(1)
  for (;;) {
    const t = TRAILING_HINT_RE.exec(name)
    if (!t) break
    hints.unshift(t[0].trim())
    name = name.slice(0, t.index).trim()
  }
  if (!name || /^\+?[\d\s().-]+$/.test(name)) return null
  const hintText = hints.join(" ")
  const parsed = parseCaptionHints(hintText)
  const bare = /(?:^|\s)([a-e])(?:\s|$)/i.exec(hintText)
  const tier = parsed.tier ?? (bare ? (bare[1].toUpperCase() as Tier) : null)
  return { verb, name, category: parsed.category, tier }
}

export type RenameOutcome =
  | { success: true; merged: false; id: string; previous: string; name: string; category: string | null; tier: string | null; phone: string }
  | {
      success: true
      merged: true
      id: string
      name: string
      category: string | null
      tier: string | null
      /** 10 digits — the number the Call button dials after the merge */
      mainPhone: string
      /** 10 digits — the placeholder's number, now on the target card */
      addedPhone: string
      /** where the placeholder's number landed on the target */
      placement: "phone" | "alt_phones"
      movedTouches: number
    }
  | { success: false; reason: "not_found" | "has_name" | "error"; error?: string; current?: string; phone: string }
  | { success: false; reason: "ambiguous"; candidates: MergeCandidate[]; phone: string }

// A card that already carries the name Ryan typed — the merge target.
export interface MergeCandidate {
  id: string
  name: string
  phone: string | null
  alt_phones: string[] | null
  email: string | null
  category: string | null
  tier: string | null
}

export type MergePlan =
  | { kind: "rename" }
  | { kind: "merge"; target: MergeCandidate; placement: "phone" | "alt_phones"; altPhones: string[] }
  | { kind: "ambiguous"; candidates: MergeCandidate[] }

/** Decide what "name: X" does to a placeholder card when other cards are
 * named X too (2026-10-15 — Vlad called from his cell before his email reply
 * made his real card). Zero matches → plain rename. Exactly one → merge the
 * placeholder into it: its number becomes the target's `phone` when the
 * target has none, else an extra in `alt_phones`. Two or more → do nothing
 * and ask Ryan. Pure; the DB writes live in renameRelationshipByPhone. */
export function planNameMerge(placeholder: { id: string; phone: string | null }, candidates: MergeCandidate[]): MergePlan {
  const others = candidates.filter((c) => c.id !== placeholder.id)
  if (others.length === 0) return { kind: "rename" }
  if (others.length > 1) return { kind: "ambiguous", candidates: others }
  const target = others[0]
  if (!target.phone) {
    return { kind: "merge", target, placement: "phone", altPhones: normalizeAltPhones(target.alt_phones, placeholder.phone) }
  }
  return {
    kind: "merge",
    target,
    placement: "alt_phones",
    altPhones: normalizeAltPhones([...(target.alt_phones ?? []), placeholder.phone], target.phone),
  }
}

const RENAME_COLS = "id, name, phone, alt_phones, email, source, category, tier, notes, status"
type RenameRow = MergeCandidate & { source: string | null; notes: string | null; status: string | null }

function stampDay(): string {
  return new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" })
}

// "650-279-7880" — the dashed form the note lines use.
function dashedPhone(phone10: string): string {
  return `${phone10.slice(0, 3)}-${phone10.slice(3, 6)}-${phone10.slice(6)}`
}

// Escape ILIKE wildcards so "name: X" matches the name literally.
function ilikeLiteral(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/** Rename the Relationships contact whose phone ends in `phone10`. A real
 * (non-placeholder) name is only overwritten when `force` is set. When the
 * card is still a placeholder and exactly one other card already carries
 * the name, the placeholder is merged into that card instead (see
 * planNameMerge). */
export async function renameRelationshipByPhone(
  phone10: string,
  cmd: { name: string; category: Category | null; tier: Tier | null },
  opts: { force: boolean }
): Promise<RenameOutcome> {
  const sb = getLeadsClient()
  let rows: RenameRow[]
  try {
    rows = await relationshipsByAnyPhone<RenameRow>(sb, phone10, RENAME_COLS)
  } catch (e) {
    return { success: false, reason: "error", error: e instanceof Error ? e.message : String(e), phone: phone10 }
  }
  const row = rows[0]
  if (!row?.id) return { success: false, reason: "not_found", phone: phone10 }
  const previous = row.name ?? ""
  const placeholder = !previous.trim() || to10Digit(previous) === phone10
  if (!placeholder && !opts.force && previous.trim() !== cmd.name) {
    return { success: false, reason: "has_name", current: previous, phone: phone10 }
  }
  const day = stampDay()

  // A placeholder whose real name is already a card → merge, not a twin.
  if (placeholder) {
    const { data: same, error: sameErr } = await sb
      .from("relationships")
      .select(RENAME_COLS)
      .ilike("name", ilikeLiteral(cmd.name.trim()))
      .neq("id", row.id)
      .limit(10)
    if (sameErr) return { success: false, reason: "error", error: sameErr.message, phone: phone10 }
    const plan = planNameMerge(row, (same ?? []) as unknown as MergeCandidate[])
    if (plan.kind === "ambiguous") return { success: false, reason: "ambiguous", candidates: plan.candidates, phone: phone10 }
    if (plan.kind === "merge") return mergePlaceholderInto(sb, row, plan, cmd, day)
  }

  const bits = [`"${previous || "(blank)"}" → "${cmd.name}"`]
  if (cmd.category && cmd.category !== row.category) bits.push(`category ${row.category ?? "—"} → ${cmd.category}`)
  if (cmd.tier && cmd.tier !== row.tier) bits.push(`tier ${row.tier ?? "—"} → ${cmd.tier}`)
  const line = `Renamed via Telegram ${day}: ${bits.join("; ")}.`
  const prevNotes = row.notes ?? ""
  const patch: Record<string, string> = { name: cmd.name, notes: prevNotes ? `${prevNotes}\n\n${line}` : line }
  if (cmd.category) patch.category = cmd.category
  if (cmd.tier) patch.tier = cmd.tier
  const { error: upErr } = await sb.from("relationships").update(patch).eq("id", row.id)
  if (upErr) return { success: false, reason: "error", error: upErr.message, phone: phone10 }
  return {
    success: true,
    merged: false,
    id: row.id,
    previous,
    name: cmd.name,
    category: cmd.category ?? (row.category ?? null),
    tier: cmd.tier ?? (row.tier ?? null),
    phone: row.phone ?? phone10,
  }
}

/** Fold a placeholder card into the card that already has its name: the
 * number moves over (main or extra), its touches re-point, its email fills
 * a blank, and the placeholder row is deleted LAST — only once the touches
 * are safely on the target. */
async function mergePlaceholderInto(
  sb: ReturnType<typeof getLeadsClient>,
  placeholder: RenameRow,
  plan: Extract<MergePlan, { kind: "merge" }>,
  cmd: { name: string; category: Category | null; tier: Tier | null },
  day: string
): Promise<RenameOutcome> {
  const { target } = plan
  const phone10 = to10Digit(placeholder.phone)
  const addedPhone = phone10.length === 10 ? phone10 : ""
  const fail = (error: string): RenameOutcome => ({ success: false, reason: "error", error, phone: phone10 })

  const placed =
    plan.placement === "phone"
      ? `${dashedPhone(addedPhone)} set as the main number (the card had none)`
      : `${dashedPhone(addedPhone)} added as an extra number`
  const bits = [`"${placeholder.name || "(blank)"}"${placeholder.source ? ` (${placeholder.source})` : ""} → this card; ${placed}`]
  if (cmd.category && cmd.category !== target.category) bits.push(`category ${target.category ?? "—"} → ${cmd.category}`)
  if (cmd.tier && cmd.tier !== target.tier) bits.push(`tier ${target.tier ?? "—"} → ${cmd.tier}`)
  const line = `Merged via Telegram ${day}: ${bits.join("; ")}.`

  const { data: cur, error: curErr } = await sb.from("relationships").select("notes").eq("id", target.id).single()
  if (curErr) return fail(curErr.message)
  const prevNotes = String(cur?.notes ?? "").trim()
  const patch: Record<string, unknown> = { alt_phones: plan.altPhones, notes: prevNotes ? `${prevNotes}\n\n${line}` : line }
  if (plan.placement === "phone" && placeholder.phone) patch.phone = placeholder.phone
  if (placeholder.email && !target.email) patch.email = placeholder.email
  if (cmd.category) patch.category = cmd.category
  if (cmd.tier) patch.tier = cmd.tier
  const { error: upErr } = await sb.from("relationships").update(patch).eq("id", target.id)
  if (upErr) return fail(upErr.message)

  const { data: moved, error: mvErr } = await sb
    .from("relationship_touches")
    .update({ relationship_id: target.id })
    .eq("relationship_id", placeholder.id)
    .select("id")
  if (mvErr) return fail(`touches not moved — ${mvErr.message}; placeholder card left in place`)

  const { error: delErr } = await sb.from("relationships").delete().eq("id", placeholder.id)
  if (delErr) return fail(`placeholder not deleted — ${delErr.message}`)

  const mainPhone = plan.placement === "phone" ? addedPhone : to10Digit(target.phone)
  return {
    success: true,
    merged: true,
    id: target.id,
    name: target.name,
    category: cmd.category ?? (target.category ?? null),
    tier: cmd.tier ?? (target.tier ?? null),
    mainPhone,
    addedPhone,
    placement: plan.placement,
    movedTouches: moved?.length ?? 0,
  }
}

// ---- "main" reply to the 🔗 merged message (2026-10-15) ----------------
// After a merge the bot offers: reply "main" to make the added number the
// one the Call button dials. Stateless like the pending-contact flow: both
// numbers are parsed back out of the bot's own message text.

export const MERGED_MARKER = "🔗"

export function formatMergedMessage(out: Extract<RenameOutcome, { merged: true }>): string {
  const meta = [out.category, out.tier ? `tier ${out.tier}` : null].filter(Boolean).join(", ")
  const moved = out.movedTouches ? ` ${out.movedTouches} ${out.movedTouches === 1 ? "call" : "calls"} moved.` : ""
  const who = `<b>${out.name}</b>${meta ? ` (${meta})` : ""}`
  if (out.placement === "phone") {
    return `${MERGED_MARKER} ${formatUsPhone(out.addedPhone)} merged into ${who}. Main number is now ${formatUsPhone(out.addedPhone)}.${moved}`
  }
  return `${MERGED_MARKER} ${formatUsPhone(out.addedPhone)} merged into ${who}. Main number stays ${formatUsPhone(out.mainPhone)}; ${out.addedPhone.slice(6)} added as an extra.${moved} Reply "main" to make ${out.addedPhone.slice(6)} the number the Call button dials.`
}

export function isMainCommand(body: string): boolean {
  return /^main\.?$/i.test(body.trim())
}

/** The two numbers from a 🔗 merged message: the added extra and the
 * current main. Null unless the message is one with a "main" offer. */
export function parseMergedMessage(text: string): { addedPhone: string; mainPhone: string; name: string } | null {
  const t = text.trim()
  if (!t.startsWith(MERGED_MARKER)) return null
  const head = /^🔗\s*\((\d{3})\)\s*(\d{3})-(\d{4}) merged into (.+?)(?: \([^)]*\))?\. Main number/.exec(t)
  const main = /Main number stays \((\d{3})\)\s*(\d{3})-(\d{4})/.exec(t)
  if (!head || !main) return null
  return { addedPhone: `${head[1]}${head[2]}${head[3]}`, mainPhone: `${main[1]}${main[2]}${main[3]}`, name: head[4].trim() }
}

export type MakeMainOutcome =
  | { success: true; name: string; phone: string; kept: string }
  | { success: false; error: string }

/** Swap a card's main number with one of its extras: `newMain10` becomes
 * `phone`, the old main goes into alt_phones. The card is found by its
 * current main number. */
export async function makeMainPhone(mainPhone10: string, newMain10: string): Promise<MakeMainOutcome> {
  const sb = getLeadsClient()
  type Row = { id: string; name: string | null; phone: string | null; alt_phones: string[] | null; notes: string | null }
  let rows: Row[]
  try {
    rows = await relationshipsByAnyPhone<Row>(sb, mainPhone10, "id, name, phone, alt_phones, notes, status")
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) }
  }
  const row = rows.find((r) => to10Digit(r.phone) === mainPhone10) ?? rows[0]
  if (!row) return { success: false, error: `no card with ${formatUsPhone(mainPhone10)}` }
  if (to10Digit(row.phone) === newMain10) {
    return { success: true, name: row.name ?? formatUsPhone(newMain10), phone: newMain10, kept: mainPhone10 }
  }
  const next = planPhoneChange(row, newMain10)
  if (!next) return { success: false, error: `${newMain10} is not a 10-digit number` }
  const line = `Main number changed via Telegram ${stampDay()}: ${mainPhone10.slice(6)} → ${newMain10.slice(6)}.`
  const prevNotes = (row.notes ?? "").trim()
  const { error } = await sb
    .from("relationships")
    .update({ ...next, notes: prevNotes ? `${prevNotes}\n\n${line}` : line })
    .eq("id", row.id)
  if (error) return { success: false, error: error.message }
  return { success: true, name: row.name ?? formatUsPhone(newMain10), phone: newMain10, kept: mainPhone10 }
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
    category: cat ? asIntakeCategory(normalizeCategory(cat)) : null,
    tier: tier && /^[A-E]$/.test(tier) ? (tier as Tier) : null,
    source: get("Source"),
    notes: get("Notes"),
    otherNames: [],
    uncertain: false,
  }
  const dupIds = Array.from(text.matchAll(/\[([0-9a-f]{8})\]/g)).map((m) => m[1])
  return { contact, dupIds }
}
