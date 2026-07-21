import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { sendCampaignAlert } from "@/lib/campaignAlerts"
import { addSuppression } from "@/lib/suppression"

// Agents line — inbound SMS webhook. Every text: contact match (phone →
// campaign_contacts), timeline event, immediate Telegram alert (locked
// decision 5), drip pause on match. STOP-style texts also write master
// suppression (channel sms). No auto-reply in v1 — Ryan answers from his
// phone or the queue; AI-drafted replies are the Phase 5b follow-up.

export const dynamic = "force-dynamic"

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>'
const STOP_RE = /^\s*(stop|unsubscribe|remove( me)?|quit|cancel|end)\s*[.!]?\s*$/i

// Telegram parse_mode:HTML rejects raw <, >, & in user-written text.
function esc(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

export async function POST(request: NextRequest) {
  let params: URLSearchParams
  try {
    params = new URLSearchParams(await request.text())
  } catch {
    return new NextResponse(EMPTY_TWIML, { headers: { "Content-Type": "text/xml" } })
  }
  const from = params.get("From") || ""
  const body = (params.get("Body") || "").trim()
  const digits = from.replace(/\D/g, "").slice(-10)

  const sb = getLeadsClient()
  const { data } = await sb
    .from("campaign_contacts")
    .select("id, name, email, touch_number, status")
    .or(`phone.eq.${digits},alt_phones.cs.{${digits}}`)
    .limit(1)
  const contact = data?.[0] ?? null
  const who = contact?.name ?? from
  const nowIso = new Date().toISOString()

  if (STOP_RE.test(body)) {
    if (contact) {
      await addSuppression(sb, {
        email: contact.email,
        phone: digits,
        name: contact.name,
        reason: `texted "${body}" to the agents line`,
        source: "sms_optout",
        source_ref: `campaign_contact:${contact.id}:sms`,
        channel: "sms",
        audience: "agent",
      })
    }
    await sb.from("campaign_events").insert({
      contact_id: contact?.id ?? null,
      kind: "sms_in",
      caller_number: digits || null,
      body,
      triage: "remove_me",
      raw: { from },
    })
    await sendCampaignAlert(sb, `🚫 Agents line STOP from ${esc(who)} — sms suppression added`)
    return new NextResponse(EMPTY_TWIML, { headers: { "Content-Type": "text/xml" } })
  }

  await sb.from("campaign_events").insert({
    contact_id: contact?.id ?? null,
    kind: "sms_in",
    caller_number: digits || null,
    body,
    raw: { from },
  })
  await sendCampaignAlert(sb, 
    `💬 <b>Agents line text</b> — <b>${esc(who)}</b>${contact ? ` (after T${contact.touch_number})` : " (not in campaign)"}\n"${esc(body.slice(0, 250))}"\n\nReply from your phone — texts to the agents line reach you here.`
  )
  return new NextResponse(EMPTY_TWIML, { headers: { "Content-Type": "text/xml" } })
}
