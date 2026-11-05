import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient, isAnonymousCaller } from "@/lib/leads"

// Put a person on autopilot, take them off, or undo a just-made switch
// (Ryan 2026-11-05 — replaces "Long-term nurture" as the park-this-lead
// button). Autopilot = the 8 fixed check-in texts in scripts/autopilot.js,
// run by the hourly drip engine; the person stays off Follow Ups until they
// reply.
//
//   POST { action: "on" }              → enrol; returns `undo` (the before-state)
//   POST { action: "off" }             → stop autopilot (no reminder is set)
//   POST { action: "undo", undo: {…} } → restore the before-state from "on"
//
// "on" for every row of the person (same phone): waiting drip drafts are
// skipped, drip stamps and call reminders cleared; one row carries
// drip_campaign_type='autopilot', touch 0, clock = now, so text #1 goes out
// on the next weekday-afternoon pass.

export const dynamic = "force-dynamic"

interface Snapshot {
  rows: { id: string; drip_campaign_type: string | null; drip_touch_number: number | null; last_drip_sent_at: string | null; recommended_followup_date: string | null; followup_reason: string | null }[]
  drafts: string[]
}

const SNAP_COLS = "id, drip_campaign_type, drip_touch_number, last_drip_sent_at, recommended_followup_date, followup_reason"

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  let body: { action?: string; undo?: Snapshot }
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }) }
  const sb = getLeadsClient()

  const { data: lead, error: lErr } = await sb.from("leads").select("id, caller_phone, email").eq("id", id).maybeSingle()
  if (lErr) return NextResponse.json({ error: lErr.message }, { status: 500 })
  if (!lead) return NextResponse.json({ error: "lead not found" }, { status: 404 })
  const phone = lead.caller_phone && !isAnonymousCaller(lead.caller_phone) ? lead.caller_phone : null

  if (body.action === "undo") {
    const snap = body.undo
    if (!snap || !Array.isArray(snap.rows)) return NextResponse.json({ error: "nothing to undo" }, { status: 400 })
    for (const r of snap.rows) {
      const { id: rowId, ...fields } = r
      const { error } = await sb.from("leads").update({ ...fields, autopilot_since: null }).eq("id", rowId)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (snap.drafts?.length) await sb.from("drip_queue").update({ status: "pending", error: null }).in("id", snap.drafts).eq("error", "moved_to_autopilot")
    return NextResponse.json({ ok: true })
  }

  if (!phone) return NextResponse.json({ error: "Autopilot texts need a phone number on the lead" }, { status: 400 })
  const { data: rows, error: rErr } = await sb
    .from("leads")
    .select(`${SNAP_COLS}, created_at, name, property_address, status, is_dnc, is_junk, is_bad_number`)
    .eq("caller_phone", phone)
    .order("created_at", { ascending: true })
  if (rErr) return NextResponse.json({ error: rErr.message }, { status: 500 })
  const cluster = rows ?? []

  if (body.action === "off") {
    const ids = cluster.filter((r) => r.drip_campaign_type === "autopilot").map((r) => r.id as string)
    if (ids.length) {
      const { error } = await sb.from("leads").update({ drip_campaign_type: null }).in("id", ids)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  }

  if (body.action !== "on") return NextResponse.json({ error: "action must be on / off / undo" }, { status: 400 })
  if (cluster.some((r) => r.is_dnc)) return NextResponse.json({ error: "They asked off the list (DNC) — no texts" }, { status: 409 })
  if (cluster.some((r) => r.is_junk || String(r.status || "").toLowerCase() === "dead")) {
    return NextResponse.json({ error: "Marked dead / junk — bring them back first" }, { status: 409 })
  }
  if (cluster.some((r) => r.is_bad_number)) return NextResponse.json({ error: "That number can't take texts (flagged bad number)" }, { status: 409 })
  try {
    const { checkContactDnc } = await import("@/lib/dnc")
    const dnc = await checkContactDnc(sb, { phone, email: lead.email }, "sms")
    if (dnc.dnc) return NextResponse.json({ error: `Not putting them on autopilot — ${dnc.why}` }, { status: 409 })
  } catch (e) {
    return NextResponse.json({ error: `DNC check failed (${e instanceof Error ? e.message : String(e)})` }, { status: 503 })
  }

  const ids = cluster.map((r) => r.id as string)
  const { data: drafts } = await sb.from("drip_queue").select("id").in("lead_id", ids).in("status", ["pending", "approved"])
  const undo: Snapshot = {
    rows: cluster.map((r) => ({
      id: r.id as string,
      drip_campaign_type: r.drip_campaign_type as string | null,
      drip_touch_number: r.drip_touch_number as number | null,
      last_drip_sent_at: r.last_drip_sent_at as string | null,
      recommended_followup_date: r.recommended_followup_date as string | null,
      followup_reason: r.followup_reason as string | null,
    })),
    drafts: (drafts ?? []).map((d) => d.id as string),
  }
  if (undo.drafts.length) await sb.from("drip_queue").update({ status: "skipped", error: "moved_to_autopilot" }).in("id", undo.drafts)
  const { error: clrErr } = await sb.from("leads").update({ drip_campaign_type: null, recommended_followup_date: null, followup_reason: null }).in("id", ids)
  if (clrErr) return NextResponse.json({ error: clrErr.message }, { status: 500 })

  // The texts read name + street from one row — pick the one that has them.
  const host = [...cluster].reverse().find((r) => r.name && r.property_address)
    ?? [...cluster].reverse().find((r) => r.property_address)
    ?? [...cluster].reverse().find((r) => r.name)
    ?? cluster[cluster.length - 1]
  const now = new Date().toISOString()
  const name = host.name ?? [...cluster].reverse().find((r) => r.name)?.name ?? null
  const address = host.property_address ?? [...cluster].reverse().find((r) => r.property_address)?.property_address ?? null
  const { error } = await sb.from("leads").update({
    name,
    property_address: address,
    drip_campaign_type: "autopilot",
    drip_touch_number: 0,
    last_drip_sent_at: now,
    autopilot_since: now,
    autopilot_hold_until: null,
    autopilot_done_at: null,
  }).eq("id", host.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, undo })
}
