import { NextResponse } from "next/server"
import fs from "fs"
import { getSheetsClient, SHEET_ID } from "@/lib/sheets"

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || ""
const MODEL = "anthropic/claude-sonnet-4-5"
const DATA_DIR = "/Users/ryanlarocca/.openclaw/workspace/PROJECTS/comprehensive-relationship-management/data"
const PREFS_FILE = `${DATA_DIR}/modality_prefs.json`

// ── Type system ────────────────────────────────────────────────────────────

type ContactType = "Agent" | "Personal" | "Vendor" | "PM" | "Investor" | "Seller"
type Modality = "Familiar" | "Reconnect" | "ColdReintro" | "Portfolio" | "CatchUp" | "CheckIn"

const MODALITIES_BY_TYPE: Record<ContactType, Modality[]> = {
  Agent:    ["Familiar", "Reconnect", "ColdReintro"],
  Vendor:   ["Familiar", "Reconnect", "ColdReintro"],
  Investor: ["Familiar", "Reconnect", "ColdReintro"],
  Seller:   ["Familiar", "Reconnect", "ColdReintro"],
  PM:       ["Portfolio", "Reconnect", "ColdReintro"],
  Personal: ["CatchUp", "CheckIn", "Reconnect"],
}

const DEFAULT_MODALITY: Record<ContactType, Modality> = {
  Agent: "Reconnect", Vendor: "Reconnect", Investor: "Reconnect", Seller: "Reconnect",
  PM: "Portfolio", Personal: "CheckIn",
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
  if (s === "Agent" || s === "Personal" || s === "Vendor" || s === "PM" || s === "Investor" || s === "Seller") return s
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
  Vendor_Familiar: `Hey {first}, hope you've been staying busy. Been a minute since we had you out — how's the business?`,
  Vendor_Reconnect: `Hey {first}, it's Ryan LaRocca — appreciated the work you did for us a while back. How's the business been? I may have something coming up and wanted to see if you're still taking on jobs.`,
  Vendor_ColdReintro: `Hey {first}, this is Ryan LaRocca — I have your contact saved from a while back. Are you still taking on work these days?`,
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

`

// ── Voice examples (dynamic few-shot from Log tab) ─────────────────────────

// Log tab columns: A=timestamp B=name C=phone D=sheetRow E=modality F=action
// G=tier H=category I=message
type LogRow = {
  timestamp: string
  modality: string
  action: string
  category: string
  message: string
}

const VOICE_CACHE_TTL_MS = 5 * 60 * 1000
let voiceCache: { data: LogRow[]; fetchedAt: number } | null = null

async function loadLogRows(): Promise<LogRow[]> {
  const now = Date.now()
  if (voiceCache && now - voiceCache.fetchedAt < VOICE_CACHE_TTL_MS) {
    return voiceCache.data
  }
  try {
    const sheets = getSheetsClient()
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Log!A:I",
    })
    const raw = (res.data.values || []) as string[][]
    // Drop header row if present (first cell contains "timestamp" or similar
    // non-ISO text — easiest detection: not parseable as date).
    const rows: LogRow[] = []
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i]
      if (!r || r.length < 9) continue
      const ts = r[0] || ""
      // Skip header: if row 0 and timestamp is not a parseable date
      if (i === 0 && isNaN(new Date(ts).getTime())) continue
      rows.push({
        timestamp: ts,
        modality: r[4] || "",
        action: r[5] || "",
        category: r[7] || "",
        message: r[8] || "",
      })
    }
    voiceCache = { data: rows, fetchedAt: now }
    return rows
  } catch (e) {
    console.error("loadLogRows failed:", e)
    // Cache empty so we don't hammer the API on repeated failures
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

async function fetchVoiceExamples(
  type: ContactType,
  modality: Modality,
  limit = 5
): Promise<string[]> {
  const rows = await loadLogRows()
  if (rows.length === 0) return []

  const sent = rows.filter(r => (r.action || "").toLowerCase() === "sent" && r.message && r.message.trim())

  // Pass 1: exact type + modality match
  let matched = sent.filter(r => rowMatchesType(r, type) && rowMatchesModality(r, modality, type))

  // Pass 2: same type, any modality — if we don't have 3+
  if (matched.length < 3) {
    matched = sent.filter(r => rowMatchesType(r, type))
  }

  // Sort by timestamp desc, take the first `limit`
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

function buildPrompt(
  type: ContactType,
  modality: Modality,
  firstName: string,
  notes: string,
  voiceExamples: string[] = []
): string {
  const base = lookupPrompt(PROMPTS, type, modality)
  const currentYear = String(new Date().getFullYear())
  const voiceBlock = buildVoiceBlock(voiceExamples, firstName)
  return (CONTEXT_FILTER_PREAMBLE + voiceBlock + base)
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

function isBadFirstName(first: string): boolean {
  if (!first) return true
  if (first.length < 2) return true
  if (/^agent$/i.test(first)) return true
  return false
}

// ── Routes ─────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { name, phone, notes, hasNotes, savePreference } = body

    const type = normalizeType(body.category ?? body.contactType ?? body.type)
    const modality = normalizeModality(body.modality, type)

    const firstName = (name || "").trim().split(/\s+/)[0] || ""
    if (isBadFirstName(firstName)) {
      return NextResponse.json({ error: "Bad contact data — fix name in sheet" }, { status: 400 })
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
    const prompt = buildPrompt(type, modality, firstName, notes, voiceExamples)

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

    const data = await res.json()
    const raw = data.choices?.[0]?.message?.content?.trim() || ""
    const message = raw
      .replace(/\*\*/g, "")
      .replace(/[\r\n]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim()

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
