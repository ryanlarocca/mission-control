import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import {
  composeVariantBody,
  lintBody,
  bodyHash,
  loadEditExamples,
  PROMPT_VERSION,
} from "../../../../../../scripts/campaign-compose.mjs"

// Regenerate one un-sent Phase B draft (Ryan 2026-08-24: cheaper than editing
// by hand, and a rejection is itself a voice-learning signal). Same compose +
// lint path as the engine; the rejected body is kept in campaign_send_edits
// as kind='regenerate' (body_after = the replacement).

export const maxDuration = 60

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })
  try {
    const sb = getLeadsClient()
    const { data: row, error } = await sb
      .from("campaign_sends")
      .select("id, status, subject, body, variant, touch_number, contact:campaign_contacts(id, name, first_name, email, property_address)")
      .eq("id", id)
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!row) return NextResponse.json({ error: "send not found" }, { status: 404 })
    if (row.status !== "draft") {
      // Never overwrite an approved (possibly hand-edited) body: unapprove first.
      return NextResponse.json({ error: `only drafts can be regenerated (this one is ${row.status})` }, { status: 409 })
    }
    if (!row.variant) {
      return NextResponse.json({ error: "only Phase B variant drafts (A/B/C) can be regenerated" }, { status: 409 })
    }
    const contact = Array.isArray(row.contact) ? row.contact[0] : row.contact
    if (!contact) return NextResponse.json({ error: "contact missing" }, { status: 409 })

    const { data: vt } = await sb
      .from("campaign_variants")
      .select("variant, touch_number, subject, body, personalize")
      .eq("touch_number", row.touch_number)
      .eq("variant", row.variant)
      .maybeSingle()
    if (!vt) return NextResponse.json({ error: `variant ${row.variant} template not found` }, { status: 409 })

    const examples = await loadEditExamples(sb, row.touch_number)
    let composed: { subject: string; body: string; firstName: string } | null = null
    let lastErr = ""
    for (let attempt = 0; attempt < 2 && !composed; attempt++) {
      const c = await composeVariantBody({ variant: vt, contact, seed: `regen-${id.slice(0, 8)}-${Date.now() % 100000}-${attempt}`, examples })
      const errs = lintBody({ subject: c.subject, body: c.body, firstName: c.firstName })
      if (errs.length) { lastErr = errs.join("; "); continue }
      if (bodyHash(c.body) === bodyHash(row.body)) { lastErr = "identical to current body"; continue }
      composed = c
    }
    if (!composed) return NextResponse.json({ error: `regenerate failed lint: ${lastErr}` }, { status: 422 })

    const { error: histErr } = await sb.from("campaign_send_edits").insert({
      send_id: row.id,
      contact_id: contact.id,
      touch_number: row.touch_number,
      variant: row.variant,
      kind: "regenerate",
      subject_before: row.subject,
      subject_after: composed.subject,
      body_before: row.body,
      body_after: composed.body,
    })
    if (histErr) return NextResponse.json({ error: `edit history: ${histErr.message}` }, { status: 500 })

    const { error: updErr } = await sb
      .from("campaign_sends")
      .update({ subject: composed.subject, body: composed.body, body_hash: bodyHash(composed.body), prompt_version: PROMPT_VERSION, edited: false })
      .eq("id", id)
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })
    return NextResponse.json({ ok: true, subject: composed.subject, body: composed.body })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
