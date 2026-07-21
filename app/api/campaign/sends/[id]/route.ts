import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// Per-draft actions for the email-campaign approval queue: approve, skip,
// unapprove, and inline edits (edits flag `edited` — the voice-learning
// signal, same convention as Relationships).

export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  let body: { action?: string; subject?: string; body?: string; scheduled_for?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "json body required" }, { status: 400 })
  }

  try {
    const sb = getLeadsClient()
    const { data: row, error: fetchErr } = await sb
      .from("campaign_sends")
      .select("id, status")
      .eq("id", id)
      .maybeSingle()
    if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 })
    if (!row) return NextResponse.json({ error: "send not found" }, { status: 404 })
    if (row.status === "sent") {
      return NextResponse.json({ error: "already sent — no edits" }, { status: 409 })
    }

    const patch: Record<string, unknown> = {}
    if (typeof body.subject === "string" && body.subject.trim()) {
      patch.subject = body.subject.trim()
      patch.edited = true
    }
    if (typeof body.body === "string" && body.body.trim()) {
      patch.body = body.body
      patch.edited = true
    }
    if (body.action === "approve") {
      patch.status = "approved"
      patch.approved_at = new Date().toISOString()
      // Optional "don't send before" time (else send in the next pass).
      if (typeof body.scheduled_for === "string" && body.scheduled_for.trim()) {
        const d = new Date(body.scheduled_for)
        if (Number.isNaN(d.getTime())) {
          return NextResponse.json({ error: "scheduled_for is not a valid time" }, { status: 400 })
        }
        patch.scheduled_for = d.toISOString()
      }
    } else if (body.action === "skip") {
      patch.status = "skipped"
    } else if (body.action === "unapprove") {
      patch.status = "draft"
      patch.approved_at = null
      patch.scheduled_for = null // drop the hold when it goes back to draft
    } else if (body.action) {
      return NextResponse.json({ error: `unknown action ${body.action}` }, { status: 400 })
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "nothing to do" }, { status: 400 })
    }

    const { error } = await sb.from("campaign_sends").update(patch).eq("id", id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
