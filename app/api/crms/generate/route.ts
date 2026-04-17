import { NextResponse } from "next/server"
import fs from "fs"

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || ""
const MODEL = "anthropic/claude-sonnet-4-5"
const DATA_DIR = "/Users/ryanlarocca/.openclaw/workspace/PROJECTS/comprehensive-relationship-management/data"
const PREFS_FILE = `${DATA_DIR}/modality_prefs.json`

type Modality = "Familiar" | "Reconnect" | "ColdReintro"

const LEGACY_MODALITY_MAP: Record<string, Modality> = {
  Direct:          "Reconnect",
  Collaborative:   "Reconnect",
  "Check-in":      "ColdReintro",
  Casual:          "Familiar",
}

function normalizeModality(m: unknown): Modality {
  if (typeof m !== "string") return "Reconnect"
  if (m === "Familiar" || m === "Reconnect" || m === "ColdReintro") return m
  if (m === "Cold Reintro") return "ColdReintro"
  return LEGACY_MODALITY_MAP[m] || "Reconnect"
}

const PROMPTS: Record<Modality, string> = {
  Familiar: `You are writing a short iMessage on behalf of Ryan LaRocca, a real estate investor in the Bay Area.
Write a 1-3 sentence message to {name}. Ryan knows this person well — first-name basis, casual tone.
Reference something specific from these notes if relevant: {notes}
The core ask: Ryan is looking for a project / deal. Work that in naturally.
Do NOT introduce Ryan by full name. No sign-off, no emojis. Sound like a real text, not a template.`,

  Reconnect: `You are writing a short iMessage on behalf of Ryan LaRocca, a real estate investor in the Bay Area.
Write a 2-3 sentence message to {name}. Ryan has spoken to this person before but it's been a while.
Open with "Hey {name}, it's Ryan LaRocca" and reference how they connected if notes suggest it: {notes}
The core ask: Ryan is still actively buying and wants to know if they've seen anything interesting.
No sign-off, no emojis. Sound like a real text between two professionals catching up.`,

  ColdReintro: `You are writing a short iMessage on behalf of Ryan LaRocca, a real estate investor in the Bay Area.
Write a 2-3 sentence message to {name}. Ryan doesn't really know this person — it's a reintroduction.
Open with "Hey {name}, this is Ryan LaRocca" and briefly establish who he is (investor, buys fixers/value-add).
If notes have any context, reference it: {notes}
The ask should be soft: "are you still active in real estate?" or "have you come across anything interesting?"
No sign-off, no emojis. Conversational but professional.`,
}

const FALLBACK: Record<Modality, string> = {
  Familiar: `Hey {first}, hope you're doing well. I'm looking for a project right now — been seeing anything good lately?`,

  Reconnect: `Hey {first}, it's Ryan LaRocca — we connected a while back about off-market deals.

I'm still actively buying in the area — curious if anything interesting has crossed your desk lately?`,

  ColdReintro: `Hey {first}, this is Ryan LaRocca — I had your contact saved from a while back and wanted to reintroduce myself.

I'm an investor in the Bay Area buying fixers and value-add properties. Are you still active in real estate?`,
}

function readPrefs(): Record<string, { preferred_modality: Modality; last_used: string; count: number }> {
  try {
    const raw = JSON.parse(fs.readFileSync(PREFS_FILE, "utf8")) as Record<string, { preferred_modality: string; last_used: string; count: number }>
    const migrated: Record<string, { preferred_modality: Modality; last_used: string; count: number }> = {}
    for (const [k, v] of Object.entries(raw)) {
      migrated[k] = { ...v, preferred_modality: normalizeModality(v.preferred_modality) }
    }
    return migrated
  } catch {
    return {}
  }
}

function savePrefs(prefs: Record<string, { preferred_modality: Modality; last_used: string; count: number }>) {
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

export async function POST(request: Request) {
  try {
    const { name, phone, modality: rawModality, notes, hasNotes, savePreference } = await request.json()

    const firstName = (name || "").trim().split(/\s+/)[0] || ""
    if (isBadFirstName(firstName)) {
      return NextResponse.json({ error: "Bad contact data — fix name in sheet" }, { status: 400 })
    }

    const modality = normalizeModality(rawModality)

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
      const template = FALLBACK[modality]
      return NextResponse.json({
        message: template.replace(/{first}/g, firstName),
        isFallback: true,
      })
    }

    const prompt = PROMPTS[modality]
      .replace(/{name}/g, firstName)
      .replace(/{notes}/g, notes || "No notes available.")

    const body = JSON.stringify({
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
      body,
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
