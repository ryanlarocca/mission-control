import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient, isOwnedNumber, parseTwilioBody } from "@/lib/leads"
import { sendCampaignAlert } from "@/lib/campaignAlerts"
import { addSuppression } from "@/lib/suppression"
import { logInboundTextTouch } from "@/lib/office-inbound"
import { describeAgent, findCampaignContactByPhone, markRelationshipDoNotContact, resolveAgentContact } from "@/lib/agentsLineInbound"

// Agents line — inbound SMS webhook. Every text: campaign match (phone →
// campaign_contacts), Relationships card (campaign list → Relationships →
// Leads → new card, tier B — 2026-10-01), timeline event + inbound SMS
// touch on the card, immediate Telegram alert. The drip NEVER pauses on a
// reply (Ryan 2026-07-20 / 2026-10-01); STOP-style texts write master
// suppression (channel sms), stop the drip and mark the card do-not-contact.
// No auto-reply — Ryan answers from Telegram (reply = text back from the
// agents line) or his phone.

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
    params = parseTwilioBody(await request.text())
  } catch {
    return new NextResponse(EMPTY_TWIML, { headers: { "Content-Type": "text/xml" } })
  }
  const from = params.get("From") || ""
  const body = (params.get("Body") || "").trim()
  const digits = from.replace(/\D/g, "").slice(-10)

  const sb = getLeadsClient()
  const contact = digits.length === 10 ? await findCampaignContactByPhone(sb, digits) : null
  const fmt = digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : from
  const selfTest = !!from && isOwnedNumber(from)
  const isStop = STOP_RE.test(body)
  const who = digits.length === 10 && !selfTest
    ? await resolveAgentContact(sb, { phone: from, campaign: contact, channel: "sms", reactivate: !isStop })
    : { kind: "lead" as const }
  const rel = who.kind === "relationship" ? who : null
  const label = rel ? `${describeAgent(rel)} ${fmt}` : contact?.name ? `<b>${esc(contact.name)}</b> ${fmt} (after T${contact.touch_number})` : `${fmt}${selfTest ? " (our own line — system test)" : " (not in campaign)"}`

  if (isStop) {
    if (contact || rel) {
      await addSuppression(sb, {
        email: contact?.email ?? null,
        phone: digits,
        name: contact?.name ?? rel?.name ?? null,
        reason: `texted "${body}" to the agents line`,
        source: "sms_optout",
        source_ref: contact ? `campaign_contact:${contact.id}:sms` : `relationship:${rel!.id}:sms`,
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
      raw: { from, relationship_id: rel?.id ?? null },
    })
    if (rel) {
      await logInboundTextTouch(sb, rel, body)
      await markRelationshipDoNotContact(sb, rel.id, `texted "${body}" to the agents line`)
    }
    await sendCampaignAlert(sb, `🚫 Agents line STOP from ${label} — sms suppression added${rel ? ", card marked do-not-contact" : ""}`)
    return new NextResponse(EMPTY_TWIML, { headers: { "Content-Type": "text/xml" } })
  }

  await sb.from("campaign_events").insert({
    contact_id: contact?.id ?? null,
    kind: "sms_in",
    caller_number: digits || null,
    body,
    raw: { from, relationship_id: rel?.id ?? null },
  })
  if (rel) await logInboundTextTouch(sb, rel, body)
  await sendCampaignAlert(sb,
    `💬 <b>Agents line text</b> — ${label}\n"${esc(body.slice(0, 250))}"\n\nReply to this message to text back from the agents line.`,
    { buttons: digits.length === 10 ? [{ text: "📞 Call them", data: `call:${digits}` }] : undefined }
  )
  return new NextResponse(EMPTY_TWIML, { headers: { "Content-Type": "text/xml" } })
}
