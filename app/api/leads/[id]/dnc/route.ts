import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// Phase 7C — Part 6 + Part 9: DNC button on the lead card.
//
// Sets is_dnc=true + status=dead on the lead, halts every outreach
// channel, and pulls whatever address/owner fields exist into a row on
// the standalone `dnc_list` table. Most fields will be sparse (the
// direct-mail CSV format is the target shape, but lead rows don't carry
// every column — that's expected and fine for cross-referencing
// site_address against future mailing lists).
const VALID_REASONS = ["requested", "hostile", "wrong_number", "manual"] as const
type DncReason = (typeof VALID_REASONS)[number]

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  let body: { reason?: unknown } = {}
  try {
    body = await request.json()
  } catch {
    // empty body is fine; reason defaults to "manual"
  }

  const reason: DncReason =
    typeof body.reason === "string" && (VALID_REASONS as readonly string[]).includes(body.reason)
      ? (body.reason as DncReason)
      : "manual"

  try {
    const sb = getLeadsClient()
    const { data: lead, error: fetchErr } = await sb
      .from("leads")
      .select("id, name, property_address, caller_phone, email")
      .eq("id", id)
      .maybeSingle()
    if (fetchErr) {
      return NextResponse.json({ error: fetchErr.message }, { status: 500 })
    }
    if (!lead) {
      return NextResponse.json({ error: "lead not found" }, { status: 404 })
    }

    const { error: updErr } = await sb
      .from("leads")
      .update({ is_dnc: true, status: "dead" })
      .eq("id", id)
    if (updErr) {
      return NextResponse.json({ error: updErr.message }, { status: 500 })
    }

    // Insert into dnc_list. Idempotency: if the same lead already has a row
    // (e.g. drip engine auto-flagged it earlier and Ryan re-clicks DNC), the
    // duplicate insert is harmless — there's no unique constraint and a
    // second row just records the manual confirmation timestamp.
    const { error: dncErr } = await sb.from("dnc_list").insert({
      site_address: lead.property_address || null,
      owner_name: lead.name || null,
      source_lead_id: lead.id,
      reason,
      added_by: "ryan",
    })
    if (dncErr) {
      // Don't fail the whole request — the lead is already flagged. Log only.
      console.warn(`[dnc] dnc_list insert failed for ${id}: ${dncErr.message}`)
    }

    return NextResponse.json({ ok: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// DELETE clears the DNC flag (Ryan changes his mind, or the dnc_list row
// was an auto-flag false positive). Lead's status doesn't auto-restore —
// Ryan picks the right lifecycle state himself.
export async function DELETE(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  try {
    const sb = getLeadsClient()
    const { error } = await sb.from("leads").update({ is_dnc: false }).eq("id", id)
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    // Best-effort: also remove from dnc_list. Don't fail if it's missing.
    await sb.from("dnc_list").delete().eq("source_lead_id", id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
