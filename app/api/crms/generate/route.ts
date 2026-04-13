import { NextResponse } from "next/server"
import fs from "fs"

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "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"
const MODEL = "anthropic/claude-sonnet-4-5"
const DATA_DIR = "/Users/ryanlarocca/.openclaw/workspace/PROJECTS/comprehensive-relationship-management/data"
const PREFS_FILE = `${DATA_DIR}/modality_prefs.json`

type Modality = "Direct" | "Collaborative" | "Check-in" | "Casual"

const PROMPTS: Record<Modality, string> = {
  Direct: `You are writing a short iMessage on behalf of Ryan LaRocca, a real estate investor in the Bay Area.
Write a 1-2 sentence message to {name}, a Tier {tier} {category}.
Be direct and deal-focused. If notes are available and relevant, reference something specific from them: {notes}
If no notes or nothing relevant, ask if they've seen any interesting deals lately.
Do NOT introduce Ryan by name — they already know him. No fluff, no sign-off, no emojis.`,

  Collaborative: `You are writing a short iMessage on behalf of Ryan LaRocca, a real estate investor in the Bay Area.
Write a 1-2 sentence message to {name}, a Tier {tier} {category}.
Lead with a partnership angle — working together, finding deals together, or mutual benefit.
If notes are available, reference something specific: {notes}
If no notes, suggest connecting to find deals together.
Do NOT introduce Ryan by name. No fluff, no sign-off, no emojis.`,

  "Check-in": `You are writing a short iMessage on behalf of Ryan LaRocca, a real estate investor in the Bay Area.
Write a 1-2 sentence message to {name}, a Tier {tier} {category}.
Low-pressure, how's-business tone. If notes are available, reference something from their situation: {notes}
If no notes, ask how the market's been treating them lately.
Do NOT introduce Ryan by name. No fluff, no sign-off, no emojis.`,

  Casual: `You are writing a short iMessage on behalf of Ryan LaRocca, a real estate investor in the Bay Area.
Write a 1-2 sentence message to {name}, a Tier {tier} {category}.
Warm and friendly, like a text from a friend. If notes have something personal or specific, reference it: {notes}
If no notes, keep it simple — something like "Hey, been a minute, how's everything?"
Do NOT introduce Ryan by name. No fluff, no sign-off, no emojis.`,
}

// COI-style fallback for contacts with no notes
const COI_FALLBACK: Record<string, string[]> = {
  A: [`Hey {first}! How are you?`, `Hey {first}, been thinking about you! What's new?`],
  B: [
    `Hey {first}, this is Ryan LaRocca — we connected before about buying off market property. Seeing anything good lately?`,
    `Hey {first}, Ryan LaRocca here. I'm actively buying in the Bay Area right now — any interesting deals on your end?`,
  ],
  C: [
    `Hey {first}, this is Ryan LaRocca with LRG Homes. I'm an investor looking for value-add SFR and multi-unit properties — ready to move fast on the right deal. Seen anything interesting?`,
    `Hey {first}, Ryan LaRocca here. I buy fixers and multi-units throughout the Bay Area and move quickly. Have you come across anything that might be a fit?`,
  ],
  D: [
    `Hey {first}, this is Ryan LaRocca — long time! Hoping to reconnect. What's new with you?`,
    `Hey {first}, Ryan LaRocca here. It's been a while — would love to catch up whenever you have a minute.`,
  ],
}

function readPrefs(): Record<string, { preferred_modality: Modality; last_used: string; count: number }> {
  try {
    return JSON.parse(fs.readFileSync(PREFS_FILE, "utf8"))
  } catch {
    return {}
  }
}

function savePrefs(prefs: Record<string, { preferred_modality: Modality; last_used: string; count: number }>) {
  try {
    fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2))
  } catch {}
}

export async function POST(request: Request) {
  try {
    const { name, phone, tier, category, modality, notes, hasNotes, savePreference } = await request.json()

    const firstName = (name || "").split(" ")[0]

    // Save modality preference if requested
    if (savePreference && phone && modality) {
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

    // No notes — return COI-style fallback variants (no Claude call)
    if (!hasNotes) {
      const variants = COI_FALLBACK[tier] || COI_FALLBACK.C
      return NextResponse.json({
        message: variants[0].replace(/{first}/g, firstName),
        variants: variants.map(v => v.replace(/{first}/g, firstName)),
        isFallback: true,
      })
    }

    // Build prompt
    const promptTemplate = PROMPTS[modality as Modality] || PROMPTS["Check-in"]
    const prompt = promptTemplate
      .replace(/{name}/g, firstName)
      .replace(/{tier}/g, tier || "C")
      .replace(/{category}/g, category || "Agent")
      .replace(/{notes}/g, notes || "No notes available.")

    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 100,
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

// GET preferred modality for a phone number
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const phone = searchParams.get("phone")
  if (!phone) return NextResponse.json({ preferred_modality: null })

  const prefs = readPrefs()
  const norm = phone.replace(/\D/g, "").slice(-10)
  const pref = prefs[norm]
  return NextResponse.json({ preferred_modality: pref?.preferred_modality || null })
}
