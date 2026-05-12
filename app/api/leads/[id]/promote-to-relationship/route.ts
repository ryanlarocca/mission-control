import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { isValidCategory, RELATIONSHIP_CATEGORIES } from "@/lib/crms"
import { getSheetsClient, SHEET_ID } from "@/lib/sheets"

// Promote a lead into the Relationships (BoB) Google Sheet. Used when a
// caller turns out to be a referral source rather than a seller — e.g.
// Kelly Ray was an agent, Ricardo was an electrician. Both can drive
// future deals if they're in the cadence-driven follow-up queue instead
// of buried in the Leads tab.
//
// Side effects on the lead row:
//   - status set to "dead" so it falls out of New/Contacted/Active.
//   - notes prepended with a "[PROMOTED → Relationships: <category>]"
//     marker + the date, so future viewers know what happened.
//
// Sheet columns (Sheet1) for reference:
//   A=name  B=phone  C=—  D=—  E=type/category  F=—  G=LastContacted
//   H=tier  I=notes (with optional "[enriched: YYYY-MM-DD]" prefix)
//   J=snooze_until

const VALID_TIERS = new Set(["A", "B", "C", "D"])
const DEFAULT_TIER = "C"

function normalizePhoneLast10(phone: string | null | undefined): string | null {
  if (!phone) return null
  const digits = String(phone).replace(/\D/g, "")
  return digits.length >= 10 ? digits.slice(-10) : null
}

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  let body: { category?: unknown; tier?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const category = String(body.category || "").trim()
  if (!isValidCategory(category)) {
    return NextResponse.json(
      { error: `category must be one of: ${RELATIONSHIP_CATEGORIES.join(", ")}` },
      { status: 400 }
    )
  }
  const tierIn = String(body.tier || "").trim().toUpperCase()
  const tier = VALID_TIERS.has(tierIn) ? tierIn : DEFAULT_TIER

  try {
    const sb = getLeadsClient()
    const { data: lead, error: lookupErr } = await sb
      .from("leads")
      .select("id, name, caller_phone, email, ai_summary, notes, status")
      .eq("id", id)
      .maybeSingle()
    if (lookupErr) return NextResponse.json({ error: lookupErr.message }, { status: 500 })
    if (!lead) return NextResponse.json({ error: "lead not found" }, { status: 404 })

    const phone10 = normalizePhoneLast10(lead.caller_phone)
    if (!phone10) {
      return NextResponse.json(
        { error: "lead has no usable phone (Relationships sheet requires a 10-digit phone)" },
        { status: 400 }
      )
    }
    if (!lead.name || !lead.name.trim()) {
      return NextResponse.json(
        { error: "lead has no name (set it on the card first, then promote)" },
        { status: 400 }
      )
    }

    // Build the notes that land in column I. Carry the AI summary forward
    // (compressed to one line) so Ryan opens the contact with usable context
    // instead of a blank row. Tag with [enriched: YYYY-MM-DD] so the
    // CRMS-side staleness check (90 days) starts counting from today.
    const today = new Date().toISOString().slice(0, 10)
    const aiContext = (lead.ai_summary || "").replace(/\s+/g, " ").trim()
    const sheetNotes = aiContext
      ? `[enriched: ${today}] Promoted from Leads. ${aiContext}`.slice(0, 1000)
      : `[enriched: ${today}] Promoted from Leads.`

    // Append to Sheet1. Column order: A name | B phone | C — | D — | E category
    // | F — | G LastContacted (blank so the cadence fires) | H tier | I notes
    // | J snooze_until (blank).
    const sheets = getSheetsClient()
    let appendedRange: string | null = null
    try {
      const appendRes = await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: "Sheet1!A1",
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: {
          values: [[lead.name, phone10, "", "", category, "", "", tier, sheetNotes, ""]],
        },
      })
      appendedRange = appendRes.data.updates?.updatedRange || null
    } catch (e) {
      console.error("[promote-to-relationship] sheet append failed:", e)
      return NextResponse.json(
        { error: "Failed to write to Relationships sheet", details: e instanceof Error ? e.message : String(e) },
        { status: 502 }
      )
    }

    // Update the lead row: dead + marker in notes so the lead card and
    // any future viewer can see what happened.
    const promoMarker = `[PROMOTED → Relationships: ${category} · ${today}]`
    const newNotes = lead.notes && lead.notes.trim()
      ? `${promoMarker} ${lead.notes}`
      : promoMarker
    const { error: updErr } = await sb
      .from("leads")
      .update({ status: "dead", notes: newNotes })
      .eq("id", lead.id)
    if (updErr) {
      // Sheet write already succeeded — surface this but don't fail.
      console.error("[promote-to-relationship] lead update failed:", updErr.message)
      return NextResponse.json({
        ok: true,
        appendedRange,
        sheetWritten: true,
        leadUpdated: false,
        updateError: updErr.message,
      })
    }

    return NextResponse.json({
      ok: true,
      category,
      tier,
      appendedRange,
      sheetWritten: true,
      leadUpdated: true,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[promote-to-relationship] threw:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
