import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient, haltOutreachForCluster } from "@/lib/leads"
import { isValidCategory, RELATIONSHIP_CATEGORIES } from "@/lib/crms"

// Promote a lead into the Relationships (Book of Business) Supabase table.
// Used when a caller turns out to be a referral source rather than a seller
// — e.g. Kelly Ray was an agent, Ricardo an electrician. Both can drive
// future deals once they're in the cadence-driven follow-up queue instead
// of buried in the Leads tab.
//
// Side effects on the lead row (unchanged from commit 8c32500):
//   - the whole contact cluster's status set to "dead".
//   - the clicked row's notes prefixed with a "[PROMOTED → Relationships]"
//     marker so future viewers know what happened.
//
// The new `relationships` row carries source_lead_id = lead.id. That FK is
// what lets applyAnalyzeCallResult self-heal the contact's notes if the call
// is still transcribing at promote time — dissolving the old partial-notes
// race (the bug that motivated the Sheet → Supabase migration).

const VALID_TIERS = new Set(["A", "B", "C", "D"])
const DEFAULT_TIER = "C"

function toE164(phone: string | null | undefined): string | null {
  if (!phone) return null
  const digits = String(phone).replace(/\D/g, "")
  if (digits.length < 10) return null
  return `+1${digits.slice(-10)}`
}

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  let body: { category?: unknown; tier?: unknown; preview?: unknown }
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

    const phoneE164 = toE164(lead.caller_phone)
    if (!phoneE164) {
      return NextResponse.json(
        { error: "lead has no usable phone (a relationship needs a 10-digit phone)" },
        { status: 400 }
      )
    }
    // Gather the WHOLE contact cluster up front (2026-08-21). The UI promotes
    // `mostRecentId`, which is usually the outbound call/text Ryan just made —
    // a row with an EMPTY ai_summary and no notes. Reading only that row
    // shipped contacts with "Promoted from Leads." and nothing else (Jerry /
    // 1115 Mariposa). Context lives across the cluster: the inbound
    // voicemail's ai_summary, each call's ai_notes, Ryan's typed notes.
    const clusterOr: string[] = []
    if (lead.caller_phone) clusterOr.push(`caller_phone.eq.${lead.caller_phone}`)
    if (lead.email) clusterOr.push(`email.eq.${lead.email}`)
    type ClusterRow = {
      id: string; name: string | null; email: string | null; created_at: string; lead_type: string | null
      ai_summary: string | null; ai_notes: string | null; notes: string | null; property_address: string | null
    }
    let cluster: ClusterRow[] = []
    if (clusterOr.length > 0) {
      const { data } = await sb
        .from("leads")
        .select("id, name, email, created_at, lead_type, ai_summary, ai_notes, notes, property_address")
        .or(clusterOr.join(","))
        .order("created_at", { ascending: true })
      cluster = (data ?? []) as ClusterRow[]
    }
    if (!cluster.some((r) => r.id === lead.id)) {
      cluster.push({ id: lead.id, name: lead.name, email: lead.email, created_at: new Date().toISOString(), lead_type: null, ai_summary: lead.ai_summary, ai_notes: null, notes: lead.notes, property_address: null })
    }

    const clean = (v: string | null | undefined) => (v || "").replace(/\s+/g, " ").trim()
    const name = clean(lead.name) || clean([...cluster].reverse().find((r) => clean(r.name))?.name)
    if (!name) {
      return NextResponse.json(
        { error: "lead has no name (set it on the card first, then promote)" },
        { status: 400 }
      )
    }
    const email = lead.email || cluster.find((r) => r.email)?.email || null
    const fmtDay = (iso: string) =>
      new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" })

    // Best narrative: the longest ai_summary in the cluster (the triage
    // summary is regenerated per inbound event; the richest one wins).
    const summary = cluster.map((r) => clean(r.ai_summary)).sort((a, b) => b.length - a.length)[0] || ""
    // Every distinct call analysis, chronological, dated.
    const seenNotes = new Set<string>()
    const callNotes = cluster
      .filter((r) => clean(r.ai_notes))
      .filter((r) => { const k = clean(r.ai_notes); if (seenNotes.has(k)) return false; seenNotes.add(k); return true })
      .map((r) => `• ${fmtDay(r.created_at)} (${r.lead_type || "call"}): ${clean(r.ai_notes)}`)
    // Ryan's typed notes, minus any prior promote marker.
    const manual = Array.from(new Set(cluster.map((r) => clean(r.notes).replace(/^\[PROMOTED[^\]]*\]\s*/, "")).filter(Boolean)))
    const addresses = Array.from(new Set(cluster.map((r) => clean(r.property_address)).filter(Boolean)))
      .sort((a, b) => b.length - a.length)
    const firstSeen = cluster[0]?.created_at
    const today = new Date().toISOString().slice(0, 10)

    const parts: string[] = [`Promoted from Leads ${today}${firstSeen ? ` · lead since ${fmtDay(firstSeen)}` : ""}`]
    if (addresses.length) parts[0] += `\nProperty: ${addresses[0]}`
    if (summary) parts.push(summary)
    if (callNotes.length) parts.push(`Call notes:\n${callNotes.join("\n")}`)
    if (manual.length) parts.push(`Ryan's notes: ${manual.join(" | ")}`)
    const notes = parts.join("\n\n")

    if (body.preview === true) {
      return NextResponse.json({ ok: true, preview: true, name, phone: phoneE164, email, category, tier, notes, clusterRows: cluster.length })
    }

    // Insert the Book-of-Business row. enriched_at = now() starts the 90-day
    // staleness clock from today.
    const { data: rel, error: insErr } = await sb
      .from("relationships")
      .insert({
        name,
        phone: phoneE164,
        email,
        category,
        tier,
        notes,
        enriched_at: new Date().toISOString(),
        source_lead_id: lead.id,
      })
      .select("id")
      .single()
    if (insErr) {
      console.error("[promote-to-relationship] relationships insert failed:", insErr)
      return NextResponse.json(
        { error: "Failed to create relationship", details: insErr.message },
        { status: 502 }
      )
    }
    const relationshipId = rel?.id ?? null

    // --- lead-side: unchanged from commit 8c32500 ---
    // Mark the WHOLE contact dead — not just the clicked row. A contact is a
    // cluster of leads rows sharing a phone/email; promotion means every row
    // for them must drop out of New/Contacted/Active and the Follow Ups
    // worklist.
    const promoMarker = `[PROMOTED → Relationships: ${category} · ${today}]`
    const newNotes = lead.notes && lead.notes.trim()
      ? `${promoMarker} ${lead.notes}`
      : promoMarker

    const orParts: string[] = []
    if (lead.caller_phone) orParts.push(`caller_phone.eq.${lead.caller_phone}`)
    if (lead.email) orParts.push(`email.eq.${lead.email}`)
    let clusterIds = [lead.id]
    if (orParts.length > 0) {
      const { data: siblings } = await sb.from("leads").select("id").or(orParts.join(","))
      const ids = (siblings ?? []).map((r) => r.id as string)
      if (ids.length > 0) clusterIds = Array.from(new Set([lead.id, ...ids]))
    }

    const { error: clusterErr } = await sb
      .from("leads")
      .update({ status: "dead" })
      .in("id", clusterIds)
    const { error: notesErr } = await sb
      .from("leads")
      .update({ notes: newNotes })
      .eq("id", lead.id)
    const updErr = clusterErr ?? notesErr
    if (updErr) {
      // The relationship row already exists — surface this but don't fail.
      console.error("[promote-to-relationship] lead update failed:", updErr.message)
      return NextResponse.json({
        ok: true,
        category,
        tier,
        relationshipId,
        relationshipCreated: true,
        leadUpdated: false,
        updateError: updErr.message,
      })
    }

    // Sweep the cluster's pending/approved drips + outstanding follow-up
    // dates — same halt the Leads-tab "mark dead" path runs.
    try {
      await haltOutreachForCluster(sb, { ...lead, status: "dead" })
    } catch (sweepErr) {
      console.warn(
        "[promote-to-relationship] halt-outreach sweep failed:",
        sweepErr instanceof Error ? sweepErr.message : String(sweepErr)
      )
    }

    return NextResponse.json({
      ok: true,
      category,
      tier,
      relationshipId,
      relationshipCreated: true,
      leadUpdated: true,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[promote-to-relationship] threw:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
