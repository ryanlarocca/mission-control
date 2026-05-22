import { NextResponse } from "next/server"
import fs from "fs"
import { getLeadsClient } from "@/lib/leads"

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || ""
const MODEL = "anthropic/claude-sonnet-4-5"
const DATA_DIR = "/Users/ryanlarocca/.openclaw/workspace/PROJECTS/comprehensive-relationship-management/data"
const PREFS_FILE = `${DATA_DIR}/modality_prefs.json`

// ── Type system ────────────────────────────────────────────────────────────

type ContactType = "Agent" | "Personal" | "Vendor" | "PM" | "Investor" | "PrivateMoney" | "Seller"
type Modality = "Familiar" | "Reconnect" | "ColdReintro" | "Portfolio" | "CatchUp" | "CheckIn" | "Referral"

const MODALITIES_BY_TYPE: Record<ContactType, Modality[]> = {
  Agent:    ["Familiar", "Reconnect", "ColdReintro"],
  Vendor:   ["Referral", "Familiar", "Reconnect", "ColdReintro"],
  Investor: ["Familiar", "Reconnect", "ColdReintro"],
  PrivateMoney: ["Familiar", "Reconnect", "ColdReintro"],
  Seller:   ["Familiar", "Reconnect", "ColdReintro"],
  PM:       ["Portfolio", "Reconnect", "ColdReintro"],
  Personal: ["CatchUp", "CheckIn", "Reconnect"],
}

const DEFAULT_MODALITY: Record<ContactType, Modality> = {
  Agent: "Reconnect", Vendor: "Referral", Investor: "Reconnect", Seller: "Reconnect",
  PM: "Portfolio", Personal: "CheckIn", PrivateMoney: "Reconnect",
}

const LEGACY_MODALITY_MAP: Record<string, Modality> = {
  Direct:        "Reconnect",
  Collaborative: "Reconnect",
  "Check-in":    "ColdReintro",
  Casual:        "Familiar",
  "Cold Reintro":"ColdReintro",
  "Catch Up":    "CatchUp",
  "Check In":    "CheckIn",
}

function normalizeType(t: unknown): ContactType {
  if (typeof t !== "string") return "Agent"
  const s = t.trim()
  if (s === "Property Manager") return "PM"
  if (s === "Personal Contact") return "Personal"
  if (s === "Private Money" || s === "Private money") return "PrivateMoney"
  if (s === "Agent" || s === "Personal" || s === "Vendor" || s === "PM" || s === "Investor" || s === "PrivateMoney" || s === "Seller") return s
  return "Agent"
}

function normalizeModality(m: unknown, type: ContactType): Modality {
  const allowed = MODALITIES_BY_TYPE[type]
  if (typeof m === "string") {
    if ((allowed as string[]).includes(m)) return m as Modality
    const mapped = LEGACY_MODALITY_MAP[m]
    if (mapped && (allowed as string[]).includes(mapped)) return mapped
  }
  return DEFAULT_MODALITY[type]
}

// ── Prompts ────────────────────────────────────────────────────────────────

// Keyed by `${type}_${modality}`. Lookup falls back to Agent_<modality> for
// types without dedicated prompts (Investor, Seller). Vendor has its own —
// agent-style real-estate prospecting language is wrong for vendor contacts.
const PROMPTS: Record<string, string> = {
  Agent_Familiar: `Write a short iMessage from Ryan LaRocca (Bay Area real estate investor) to {name}, an agent Ryan knows well.
Use these notes if anything is current and relevant: {notes}
Start with a genuine check-in — ask how they're doing, reference something from the notes if relevant. Then naturally work in that Ryan is an investor looking for a project or deal they could work on together. This is a warm message to someone Ryan has a real relationship with — it should sound like texting a colleague you like.
2-4 sentences. No sign-off, no emojis. Sound exactly like the voice examples above.`,

  Agent_Reconnect: `Write a short iMessage from Ryan LaRocca (Bay Area real estate investor) to {name}, an agent Ryan has spoken to before but it's been a while.
Open with "Hey {name}, it's Ryan LaRocca" or similar.
Use these notes for context on how they connected: {notes}
Ryan is still actively buying investment properties (fixers, value-add) in the Bay Area — work that in naturally so the agent knows exactly what Ryan is looking for.
2-3 sentences. No sign-off, no emojis. Match the voice examples exactly.`,

  Agent_ColdReintro: `Write a short iMessage from Ryan LaRocca (Bay Area real estate investor) to {name}. Ryan doesn't really know this person — this is a reintroduction.
Open with "Hey {name}, this is Ryan LaRocca."
Briefly establish: investor, buys fixers/value-add.
Notes (use only if relevant): {notes}
Soft ask: "are you still active in real estate?" or similar.
2-3 sentences. No sign-off, no emojis. Match the voice examples exactly.`,

  PrivateMoney_Familiar: `Write a short iMessage from Ryan LaRocca (Bay Area real estate investor) to {name}, a capital partner Ryan knows well — someone who has partnered with Ryan on real estate deals, or could. They know who Ryan is — do NOT open with "it's Ryan LaRocca" or any self-introduction.
Use these notes if anything is current and relevant: {notes}
Start with a genuine check-in, then naturally signal that Ryan is actively finding deals and would love to partner with them on a project. Warm and peer-to-peer — texting someone you do business with and like.
2-4 sentences. No sign-off, no emojis. Sound exactly like the voice examples above.`,

  PrivateMoney_Reconnect: `Write a short iMessage from Ryan LaRocca (Bay Area real estate investor) to {name}, a capital partner Ryan has spoken with before but it's been a while.
Open with "Hey {name}, it's Ryan LaRocca" or similar.
Use these notes for context on how they connected: {notes}
Ryan is actively buying investment properties (fixers, value-add) in the Bay Area and is looking for partners to put capital to work on deals — work that in naturally so they know exactly what Ryan is after.
2-3 sentences. No sign-off, no emojis. Match the voice examples exactly.`,

  PrivateMoney_ColdReintro: `Write a short iMessage from Ryan LaRocca (Bay Area real estate investor) to {name}. Ryan doesn't really know this person well — this is a reintroduction.
Open with "Hey {name}, this is Ryan LaRocca."
Briefly establish: investor buying fixers/value-add in the Bay Area, looking for capital partners to team up on deals.
Notes (use only if relevant): {notes}
Soft ask: whether they're still active investing or open to partnering on a project.
2-3 sentences. No sign-off, no emojis. Match the voice examples exactly.`,

  Vendor_Familiar: `Write a short iMessage from Ryan to {name}, a vendor/tradesperson Ryan has worked with and knows well. They know who Ryan is — do NOT open with "it's Ryan LaRocca" or any self-introduction.
Notes: {notes}
Tone: checking in on them personally and their work. Ask how they've been or how business is going. NOT a real estate prospecting message — no "deals", "properties coming up", or "anything interesting."
OK to softly signal Ryan may have work coming up soon.
2-3 sentences. No sign-off, no emojis. Match the voice examples exactly.`,

  Vendor_Reconnect: `Write a short iMessage from Ryan LaRocca to {name}, a vendor/tradesperson. It's been a while.
Open with "Hey {name}, it's Ryan LaRocca."
Notes: {notes}
Ask how their business has been, whether they're still taking on jobs. Ryan may have work coming up.
NOT a real estate prospecting message.
2-3 sentences. No sign-off, no emojis. Match the voice examples exactly.`,

  Vendor_ColdReintro: `Write a short iMessage from Ryan LaRocca to {name}, a vendor/tradesperson. This is a reintroduction.
Open with "Hey {name}, this is Ryan LaRocca."
Notes: {notes}
Ask whether they're still taking on work. Polite, a touch tentative.
NOT a real estate prospecting message.
2-3 sentences. No sign-off, no emojis. Match the voice examples exactly.`,

  Vendor_Referral: `Write a short iMessage from Ryan LaRocca (Bay Area real estate investor) to {name}, a vendor/tradesperson. This is a DIRECT referral ask — get straight to the point, no dancing around it, no "just checking in."
Open with "Hey {name}, it's Ryan LaRocca."
Notes (use only for light personalization if genuinely current — otherwise ignore): {notes}
Be straight: Ryan is actively buying properties in the Bay Area and pays a share of the profit on any referral that closes. Ask them to send any owner looking to sell — a fixer, a tired rental, an estate — Ryan's way.
Confident and direct, not salesy. 3-4 short sentences. No sign-off, no emojis. Match the voice examples exactly.`,

  PM_Portfolio: `Write a short iMessage from Ryan LaRocca (Bay Area investor) to {name}, a property manager.
Notes: {notes}
Ask if anything in their portfolio has come up for sale or any owners looking to sell.
1-3 sentences. No sign-off, no emojis. Match the voice examples exactly.`,

  Personal_CatchUp: `Write a short iMessage from Ryan to {name}, a close friend.
Notes: {notes}
This is NOT a business message. No deals, no real estate. Genuine "how are you" energy.
1-3 sentences. No sign-off, no emojis. Match the voice examples exactly.`,

  Personal_CheckIn: `Write a short iMessage from Ryan to {name}. They've drifted apart.
Notes: {notes}
Warm but not forced. "Thinking about you" energy. No business talk.
1-3 sentences. No sign-off, no emojis. Match the voice examples exactly.`,

  Personal_Reconnect: `Write a short iMessage from Ryan to {name}. They've lost touch but this is someone Ryan actually knows — do NOT open with "it's Ryan" or any self-introduction.
Notes: {notes}
Genuine, forward-looking. No business talk. No "I know it's been a while."
2-3 sentences. No sign-off, no emojis. Match the voice examples exactly.`,
}

const FALLBACKS: Record<string, string> = {
  Agent_Familiar: `Hey {first}, how are you? I've been ramping up on the investment side and looking for my next project — would love to work on something together if you come across anything.`,
  Agent_Reconnect: `Hey {first}, it's Ryan LaRocca — it's been a minute. I'm still actively buying investment properties in the Bay Area — fixers, value-add, that kind of thing. If anything crosses your desk, I'd love to hear about it.`,
  Agent_ColdReintro: `Hey {first}, this is Ryan LaRocca — I had your contact saved from a while back and wanted to reintroduce myself.

I'm an investor in the Bay Area buying fixers and value-add properties. Are you still active in real estate?`,
  PrivateMoney_Familiar: `Hey {first}, how have you been? I've been ramping up on the acquisition side and have a few deals in the works — would love to partner up on a project if the timing's right for you.`,
  PrivateMoney_Reconnect: `Hey {first}, it's Ryan LaRocca — it's been a minute. I'm actively buying investment properties in the Bay Area (fixers, value-add) and looking for capital partners on deals. Would love to catch up and see if there's a fit.`,
  PrivateMoney_ColdReintro: `Hey {first}, this is Ryan LaRocca — I had your contact saved from a while back and wanted to reintroduce myself.

I'm an investor in the Bay Area buying fixers and value-add properties, and I partner with folks looking to put their capital to work on deals. Are you still active investing?`,
  Vendor_Familiar: `Hey {first}, hope you've been staying busy. Been a minute since we had you out — how's the business?`,
  Vendor_Reconnect: `Hey {first}, it's Ryan LaRocca — appreciated the work you did for us a while back. How's the business been? I may have something coming up and wanted to see if you're still taking on jobs.`,
  Vendor_ColdReintro: `Hey {first}, this is Ryan LaRocca — I have your contact saved from a while back. Are you still taking on work these days?`,
  Vendor_Referral: `Hey {first}, it's Ryan LaRocca — I'm a real estate investor here in the Bay Area. I'll be straight with you: I'm actively buying properties, and I pay a share of the profit on any referral that closes. If you ever hear of an owner looking to sell — a fixer, a tired rental, an estate — send them my way. I'll make it worth your while.`,
  PM_Portfolio: `Hey {first}, it's Ryan LaRocca — I'm an investor in the Bay Area and I wanted to reach out. Do you have any properties in your portfolio where the owner might be looking to sell? Always looking for my next project.`,
  Personal_CatchUp: `Hey {first}, been a minute — how have you been? We need to catch up soon.`,
  Personal_CheckIn: `Hey {first}, was just thinking about you — hope you're doing well. What have you been up to?`,
  Personal_Reconnect: `Hey {first}, it's Ryan — it's been way too long. Hope life has been treating you well. We should grab coffee or something and catch up.`,
}

function lookupPrompt(table: Record<string, string>, type: ContactType, modality: Modality): string {
  const direct = table[`${type}_${modality}`]
  if (direct) return direct
  // Vendor and Personal must never fall back to agent prompts — their copy
  // is fundamentally different (no real-estate prospecting language).
  if (type === "Vendor") {
    return table.Vendor_Reconnect || table.Vendor_ColdReintro || table.Vendor_Familiar || table.Agent_Reconnect
  }
  if (type === "Personal") {
    return table.Personal_CheckIn || table.Personal_CatchUp || table.Personal_Reconnect || table.Agent_Reconnect
  }
  // Private Money — capital-partner copy; never fall back to Agent prompts.
  if (type === "PrivateMoney") {
    return table.PrivateMoney_Reconnect || table.PrivateMoney_ColdReintro || table.PrivateMoney_Familiar || table.Agent_Reconnect
  }
  return table[`Agent_${modality}`] || table.Agent_Reconnect
}

// Prepended to every AI prompt. Keeps the model from referencing expired
// transactional details (old showings, unanswered texts, deals from years ago)
// that make the message feel stale or passive-aggressive.
const CONTEXT_FILTER_PREAMBLE = `CONTEXT FILTERING RULES (apply before writing):
1. Today is {currentYear}. Only reference details that feel current and relevant NOW.
2. DO NOT mention: specific property showings, listings, offers, or deals older than 2 years.
3. DO NOT mention: unanswered messages, ignored calls, failed follow-ups ("you never got back to me", "last time I reached out", etc.) — always sounds passive-aggressive.
4. DO NOT mention: time-sensitive past events that have clearly expired.
5. DO OK mention: professional identity (their job, trade, company), relationship context ("we go back to our KW days"), personal facts that don't expire (hobbies, family, neighborhood).
6. If the notes contain ONLY stale transactional data or nothing usable, skip the notes entirely and write a warm generic reconnect message instead — something like: "Hey [first name], it's been a while since we last connected! I've been a full-time investor for the last several years and was hoping we could work together on something." Vary the wording, keep the tone warm and forward-looking.
7. When referencing ANY date, always include the year (e.g. "back in March 2022", not "back in March").
8. NEVER use these phrases — Ryan does not talk like this:
   - "I know it's been a while"
   - "I hope this finds you well"
   - "I've been keeping a lower profile"
   - "I was just thinking about you" (for business contacts)
   - "I hope you're doing well" (overused — only OK for close friends)
   - "that [specific] sale/deal/property" when referencing vague old transactions — be general ("we worked together on a deal in Palo Alto") not falsely specific ("that Palo Alto sale")
9. Keep sentences SHORT. Ryan averages 8-12 words per sentence in texts. Never write a sentence longer than 20 words.
10. Ryan says "Hey" not "Hi". He uses dashes (—) not semicolons. He writes like a text message, not an email.

STALE REFERENCE RULES (strict — applies to every modality: Familiar, Reconnect, ColdReintro, CatchUp, CheckIn, Portfolio):
- NEVER mention a specific property address, street name, or neighborhood-level location in any outreach message. Not "the Winchester property", not "that place on Oak Ave", not "the Menlo house". Generic city-level is fine ("in Palo Alto"); street/address level is never fine.
- If notes mention a property, deal, offer, or showing without a clear date within the last 6 months (relative to {currentYear}), treat it as stale — do not reference it at all.
- Dates without years in the notes are stale by default — do not reference them.
- If unsure whether a reference is current, omit it entirely. A warm generic message is always better than a specific but inaccurate one.

`

// ── Voice examples (dynamic few-shot from Log tab) ─────────────────────────

// Voice few-shot examples come from the relationship_touches table (formerly
// the BoB "Log" tab). Only the fields the few-shot needs are loaded.
type LogRow = {
  timestamp: string
  modality: string
  action: string
  category: string
  message: string
  replied: boolean
}

const VOICE_CACHE_TTL_MS = 5 * 60 * 1000
let voiceCache: { data: LogRow[]; fetchedAt: number } | null = null

async function loadLogRows(): Promise<LogRow[]> {
  const now = Date.now()
  if (voiceCache && now - voiceCache.fetchedAt < VOICE_CACHE_TTL_MS) {
    return voiceCache.data
  }
  try {
    const supabase = getLeadsClient()
    const { data, error } = await supabase
      .from("relationship_touches")
      .select("occurred_at, modality, action, category_at_touch, message, replied_at")
      .order("occurred_at", { ascending: false })
      .limit(1000)
    if (error) throw error
    const rows: LogRow[] = (data ?? []).map((r) => ({
      timestamp: r.occurred_at ?? "",
      modality: r.modality ?? "",
      action: r.action ?? "",
      category: r.category_at_touch ?? "",
      message: r.message ?? "",
      replied: r.replied_at != null,
    }))
    voiceCache = { data: rows, fetchedAt: now }
    return rows
  } catch (e) {
    console.error("loadLogRows failed:", e)
    // Cache empty so we don't hammer the DB on repeated failures
    voiceCache = { data: [], fetchedAt: now }
    return []
  }
}

function rowMatchesType(row: LogRow, type: ContactType): boolean {
  return normalizeType(row.category) === type
}

function rowMatchesModality(row: LogRow, modality: Modality, type: ContactType): boolean {
  return normalizeModality(row.modality, type) === modality
}

// Narrow a pool of sent messages to the most relevant for (type, modality):
// exact type + modality, falling back to same-type/any-modality if thin.
function narrowExamples(pool: LogRow[], type: ContactType, modality: Modality): LogRow[] {
  const exact = pool.filter(r => rowMatchesType(r, type) && rowMatchesModality(r, modality, type))
  if (exact.length >= 3) return exact
  return pool.filter(r => rowMatchesType(r, type))
}

async function fetchVoiceExamples(
  type: ContactType,
  modality: Modality,
  limit = 5
): Promise<string[]> {
  const rows = await loadLogRows()
  if (rows.length === 0) return []

  const sent = rows.filter(r => (r.action || "").toLowerCase() === "sent" && r.message && r.message.trim())

  // Prefer messages that actually got a reply — the AI should mimic what
  // works, not just what's most recent. Cold-start fallback: if there are
  // fewer than 3 replied-to examples for this contact type, use all sent.
  let matched = narrowExamples(sent.filter(r => r.replied), type, modality)
  if (matched.length < 3) matched = narrowExamples(sent, type, modality)

  // Most recent first, capped at `limit`.
  matched.sort((a, b) => {
    const ta = new Date(a.timestamp).getTime() || 0
    const tb = new Date(b.timestamp).getTime() || 0
    return tb - ta
  })

  return matched.slice(0, limit).map(r => r.message.trim()).filter(Boolean)
}

function buildVoiceBlock(examples: string[], firstName: string): string {
  if (!examples.length) return ""
  const lines = examples.map((ex, i) => `Example ${i + 1}: "${ex}"`).join("\n")
  return `RYAN'S VOICE — study these real messages Ryan sent to similar contacts. Match his exact tone, vocabulary, sentence length, and phrasing. Do NOT add formality, filler phrases, or AI-isms he doesn't use:

${lines}

Now write a message to ${firstName} in this same voice.

`
}

// Prepended when Ryan has never contacted this person — overrides the
// preamble's "write a reconnect message" fallback so a first-ever outreach
// never claims a past relationship.
const NEW_CONTACT_RULE = `FIRST-EVER OUTREACH — Ryan has NEVER contacted this person before. Do NOT write "it's been a while", "been a minute", "since we last connected", "reconnect", "reaching back out", or imply any prior conversation or relationship. Write a genuine first introduction.

`

function buildPrompt(
  type: ContactType,
  modality: Modality,
  firstName: string,
  notes: string,
  voiceExamples: string[] = [],
  everContacted = true
): string {
  const base = lookupPrompt(PROMPTS, type, modality)
  const currentYear = String(new Date().getFullYear())
  const voiceBlock = buildVoiceBlock(voiceExamples, firstName)
  const newContactRule = everContacted ? "" : NEW_CONTACT_RULE
  return (newContactRule + CONTEXT_FILTER_PREAMBLE + voiceBlock + base)
    .replace(/{currentYear}/g, currentYear)
    .replace(/{name}/g, firstName)
    .replace(/{notes}/g, notes || "No notes available.")
}

// ── Prefs ──────────────────────────────────────────────────────────────────

type PrefRecord = { preferred_modality: Modality; last_used: string; count: number }

function readPrefs(): Record<string, PrefRecord> {
  try {
    const raw = JSON.parse(fs.readFileSync(PREFS_FILE, "utf8")) as Record<string, { preferred_modality: string; last_used: string; count: number }>
    const out: Record<string, PrefRecord> = {}
    for (const [k, v] of Object.entries(raw)) {
      // Best-effort: pref is just stored as a string; we let normalizeModality
      // sort it out at read time when we know the contact type.
      out[k] = { ...v, preferred_modality: v.preferred_modality as Modality }
    }
    return out
  } catch {
    return {}
  }
}

function savePrefs(prefs: Record<string, PrefRecord>) {
  try {
    fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2))
  } catch {}
}

// Role / descriptor words that get entered ahead of a real name in the BoB
// ("Painter Art", "Realtor Mike", "Agent Smith"). Never use one as a first name.
const ROLE_WORDS = new Set([
  "agent", "agents", "realtor", "realtors", "broker", "brokers", "painter",
  "plumber", "contractor", "handyman", "roofer", "electrician", "landscaper",
  "vendor", "investor", "lender", "seller", "buyer", "wholesaler",
  "mr", "mrs", "ms", "dr",
])

// First real name from a contact name — skips leading role/descriptor words
// so "Painter Art" → "Art" and "Realtor Mike Jones" → "Mike". Returns "" when
// there's no usable name (caller then blocks the message).
function extractFirstName(name: string): string {
  for (const t of String(name || "").trim().split(/\s+/)) {
    const clean = t.replace(/[^a-zA-Z]/g, "")
    if (clean.length >= 2 && !ROLE_WORDS.has(clean.toLowerCase())) return clean
  }
  return ""
}

function isBadFirstName(first: string): boolean {
  if (!first || first.length < 2) return true
  return ROLE_WORDS.has(first.toLowerCase())
}

// ── Routes ─────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { name, phone, notes, hasNotes, savePreference } = body
    // Default true (safe): only a contact the UI explicitly flags as never
    // contacted gets the first-outreach prompt rule.
    const everContacted = body.everContacted !== false

    const type = normalizeType(body.category ?? body.contactType ?? body.type)
    const modality = normalizeModality(body.modality, type)

    const firstName = extractFirstName(name)
    if (isBadFirstName(firstName)) {
      return NextResponse.json({ error: "Bad contact data — fix the contact's name" }, { status: 400 })
    }

    if (savePreference && phone) {
      const prefs = readPrefs()
      const norm = String(phone).replace(/\D/g, "").slice(-10)
      const existing = prefs[norm]
      prefs[norm] = {
        preferred_modality: modality,
        last_used: new Date().toISOString().slice(0, 10),
        count: (existing?.count || 0) + 1,
      }
      savePrefs(prefs)
    }

    if (!hasNotes) {
      const template = lookupPrompt(FALLBACKS, type, modality)
      return NextResponse.json({
        message: template.replace(/{first}/g, firstName),
        isFallback: true,
      })
    }

    // Voice few-shot examples (dynamic — from Log tab, 5-min cache)
    const voiceExamples = await fetchVoiceExamples(type, modality, 5)
    const prompt = buildPrompt(type, modality, firstName, notes, voiceExamples, everContacted)

    const reqBody = JSON.stringify({
      model: MODEL,
      max_tokens: 120,
      messages: [{ role: "user", content: prompt }],
    })

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_KEY}`,
        "Content-Type": "application/json",
      },
      body: reqBody,
    })

    // The fallback template — used whenever OpenRouter fails or returns
    // nothing usable, so the composer never silently shows a blank message.
    const fallbackMessage = () =>
      lookupPrompt(FALLBACKS, type, modality).replace(/{first}/g, firstName)

    if (!res.ok) {
      const errText = await res.text().catch(() => "")
      console.error(`crms/generate: OpenRouter ${res.status}`, errText.slice(0, 300))
      return NextResponse.json({ message: fallbackMessage(), isFallback: true })
    }

    const data = await res.json().catch(() => null)
    const raw = data?.choices?.[0]?.message?.content?.trim() || ""
    const message = raw
      .replace(/\*\*/g, "")
      .replace(/[\r\n]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim()

    if (!message) {
      console.error("crms/generate: OpenRouter returned an empty message")
      return NextResponse.json({ message: fallbackMessage(), isFallback: true })
    }

    return NextResponse.json({ message, isFallback: false })
  } catch (err) {
    console.error("crms/generate error:", err)
    return NextResponse.json({ error: "Failed to generate message" }, { status: 500 })
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const phone = searchParams.get("phone")
  if (!phone) return NextResponse.json({ preferred_modality: null })

  const prefs = readPrefs()
  const norm = phone.replace(/\D/g, "").slice(-10)
  const pref = prefs[norm]
  return NextResponse.json({ preferred_modality: pref?.preferred_modality || null })
}
