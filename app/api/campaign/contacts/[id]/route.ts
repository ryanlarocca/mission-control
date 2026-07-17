import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { addSuppression } from "@/lib/suppression"

// Per-contact detail (timeline) + actions for the /email-campaign
// Contacts tab: pause / resume the drip, or add to master DNC.

export const dynamic = "force-dynamic"

export async function GET(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params
  try {
    const sb = getLeadsClient()
    const [{ data: contact, error: cErr }, { data: sends, error: sErr }, { data: events, error: eErr }] =
      await Promise.all([
        sb.from("campaign_contacts").select("*").eq("id", id).maybeSingle(),
        sb
          .from("campaign_sends")
          .select("id, touch_number, subject, status, sent_at, created_at, edited")
          .eq("contact_id", id)
          .order("created_at", { ascending: false }),
        sb
          .from("campaign_events")
          .select("id, kind, body, ai_summary, triage, duration_seconds, occurred_at, handled_at")
          .eq("contact_id", id)
          .order("occurred_at", { ascending: false }),
      ])
    if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 })
    if (!contact) return NextResponse.json({ error: "contact not found" }, { status: 404 })
    if (sErr) return NextResponse.json({ error: sErr.message }, { status: 500 })
    if (eErr) return NextResponse.json({ error: eErr.message }, { status: 500 })
    return NextResponse.json({ contact, sends: sends ?? [], events: events ?? [] })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params
  let body: { action?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "json body required" }, { status: 400 })
  }

  try {
    const sb = getLeadsClient()
    const { data: contact, error: cErr } = await sb
      .from("campaign_contacts")
      .select("id, name, email, phone, status")
      .eq("id", id)
      .maybeSingle()
    if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 })
    if (!contact) return NextResponse.json({ error: "contact not found" }, { status: 404 })

    const nowIso = new Date().toISOString()
    if (body.action === "pause") {
      await sb.from("campaign_contacts").update({ status: "paused", updated_at: nowIso }).eq("id", id)
    } else if (body.action === "resume") {
      await sb
        .from("campaign_contacts")
        .update({ status: "active", next_touch_at: nowIso, updated_at: nowIso })
        .eq("id", id)
      // clear any stale pending draft so the engine re-renders fresh
      await sb.from("campaign_sends").update({ status: "skipped", error: "superseded by resume" }).eq("contact_id", id).eq("status", "draft")
    } else if (body.action === "dnc") {
      await addSuppression(sb, {
        email: contact.email,
        phone: contact.phone,
        name: contact.name,
        reason: "added from campaign contact card",
        source: "ryan_manual",
        source_ref: `campaign_contact:${contact.id}`,
        channel: "all",
        audience: "agent",
      })
      await sb.from("campaign_contacts").update({ status: "suppressed", updated_at: nowIso }).eq("id", id)
      await sb.from("campaign_sends").update({ status: "skipped", error: "contact DNC'd" }).eq("contact_id", id).in("status", ["draft", "approved"])
    } else {
      return NextResponse.json({ error: `unknown action ${body.action}` }, { status: 400 })
    }
    return NextResponse.json({ ok: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
