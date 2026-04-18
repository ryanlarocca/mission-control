import { NextResponse } from "next/server"
import fs from "fs"

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

// Keyed by `${type}_${modality}`. Lookup falls back to Agent_<modality> so that
// Vendor / Investor / Seller share the agent prompts without duplication.
const PROMPTS: Record<string, string> = {
  Agent_Familiar: `You are writing a short iMessage on behalf of Ryan LaRocca, a real estate investor in the Bay Area.
Write a 1-3 sentence message to {name}. Ryan knows this person well — first-name basis, casual tone.
Reference something specific from these notes if relevant: {notes}
The core ask: Ryan is looking for a project / deal. Work that in naturally.
Do NOT introduce Ryan by full name. No sign-off, no emojis. Sound like a real text, not a template.`,

  Agent_Reconnect: `You are writing a short iMessage on behalf of Ryan LaRocca, a real estate investor in the Bay Area.
Write a 2-3 sentence message to {name}. Ryan has spoken to this person before but it's been a while.
Open with "Hey {name}, it's Ryan LaRocca" and reference how they connected if notes suggest it: {notes}
The core ask: Ryan is still actively buying and wants to know if they've seen anything interesting.
No sign-off, no emojis. Sound like a real text between two professionals catching up.`,

  Agent_ColdReintro: `You are writing a short iMessage on behalf of Ryan LaRocca, a real estate investor in the Bay Area.
Write a 2-3 sentence message to {name}. Ryan doesn't really know this person — it's a reintroduction.
Open with "Hey {name}, this is Ryan LaRocca" and briefly establish who he is (investor, buys fixers/value-add).
If notes have any context, reference it: {notes}
The ask should be soft: "are you still active in real estate?" or "have you come across anything interesting?"
No sign-off, no emojis. Conversational but professional.`,

  PM_Portfolio: `You are writing a short iMessage on behalf of Ryan LaRocca, a real estate investor in the Bay Area.
Write a 1-3 sentence message to {name}, a property manager. Ryan is interested in any properties coming up for sale in their portfolio.
Reference anything relevant from these notes: {notes}
The core ask: has anything in their portfolio come up for sale or are any owners looking to sell?
No sign-off, no emojis. Sound like a real text — casual and direct.`,

  Personal_CatchUp: `You are writing a short iMessage on behalf of Ryan LaRocca.
Write a 1-3 sentence message to {name}. This is a close friend or someone Ryan knows well personally.
Reference something from these notes if relevant: {notes}
This is NOT a business message. No deals, no real estate. Just genuine "how are you" energy.
No sign-off, no emojis. Sound like a real text to a friend.`,

  Personal_CheckIn: `You are writing a short iMessage on behalf of Ryan LaRocca.
Write a 1-3 sentence message to {name}. Ryan knows this person but they've drifted apart.
Reference something from these notes if relevant: {notes}
Tone: warm but not forced. "Hey, thinking about you" energy. No business talk.
No sign-off, no emojis. Sound like a real text.`,

  Personal_Reconnect: `You are writing a short iMessage on behalf of Ryan LaRocca.
Write a 2-3 sentence message to {name}. Ryan has lost touch with this person and wants to reconnect.
If notes have any context about how they know each other, reference it: {notes}
Tone: genuine, slightly nostalgic. "It's been way too long" energy. No business talk.
No sign-off, no emojis.`,
}

const FALLBACKS: Record<string, string> = {
  Agent_Familiar: `Hey {first}, hope you're doing well. I'm looking for a project right now — been seeing anything good lately?`,
  Agent_Reconnect: `Hey {first}, it's Ryan LaRocca — we connected a while back about off-market deals.

I'm still actively buying in the area — curious if anything interesting has crossed your desk lately?`,
  Agent_ColdReintro: `Hey {first}, this is Ryan LaRocca — I had your contact saved from a while back and wanted to reintroduce myself.

I'm an investor in the Bay Area buying fixers and value-add properties. Are you still active in real estate?`,
  PM_Portfolio: `Hey {first}, it's Ryan LaRocca — I'm an investor in the Bay Area and I wanted to reach out. Do you have any properties in your portfolio where the owner might be looking to sell? Always looking for my next project.`,
  Personal_CatchUp: `Hey {first}, been a minute — how have you been? We need to catch up soon.`,
  Personal_CheckIn: `Hey {first}, was just thinking about you — hope you're doing well. What have you been up to?`,
  Personal_Reconnect: `Hey {first}, it's Ryan — it's been way too long. Hope life has been treating you well. We should grab coffee or something and catch up.`,
}

function lookupPrompt(table: Record<string, string>, type: ContactType, modality: Modality): string {
  return table[`${type}_${modality}`]
    || table[`Agent_${modality}`]
    || table.Agent_Reconnect
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

    const prompt = lookupPrompt(PROMPTS, type, modality)
      .replace(/{name}/g, firstName)
      .replace(/{notes}/g, notes || "No notes available.")

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
