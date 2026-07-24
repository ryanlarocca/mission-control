import { getLeadsClient } from "@/lib/leads"
import { sendCampaignAlert } from "@/lib/campaignAlerts"

// Outbound texting from the agents line (650) 910-4007 — used by the
// Telegram webhook when Ryan replies to an agents-line alert. Separate
// from sendLeadSms on purpose: different From number, different logging
// (campaign_events, not lead rows), different suppression semantics.

const AGENTS_LINE = "+16509104007"
const RYAN_CELL = "+14085006293"
// Ryan's leg of a relay rings from the LEAD line — a number his phone has
// trusted for months. After a day of short test calls, his device/carrier
// began screening the agents line (relay legs "completed" in 1-7s without
// ringing, 2026-07-23 evening). The AGENT-facing leg still shows the
// agents line. Revert to AGENTS_LINE once he whitelists the number.
const RELAY_RING_FROM = "+16502043247"

/** Mission-Control-style relay: ring Ryan's cell from the agents line,
 * announce the contact, then connect to them (their caller ID shows the
 * agents line). Returns the human label of who we're connecting to. */
export async function startAgentsLineRelayCall(to10: string): Promise<{ success: boolean; error?: string; label?: string }> {
  if (!/^\d{10}$/.test(to10)) return { success: false, error: `bad number: ${to10}` }
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!sid || !token) return { success: false, error: "Twilio env missing" }

  const sb = getLeadsClient()
  const { data: contacts } = await sb
    .from("campaign_contacts")
    .select("id, name")
    .or(`phone.eq.${to10},alt_phones.cs.{${to10}}`)
    .limit(1)
  const contact = contacts?.[0] ?? null
  const fmt = `(${to10.slice(0, 3)}) ${to10.slice(3, 6)}-${to10.slice(6)}`
  const label = contact?.name ? `${contact.name} ${fmt}` : fmt

  // No announcement (Ryan, 2026-07-23): answering connects straight to
  // ringing; identity arrives as a Telegram message at the same moment.
  const twiml = `<Response><Dial callerId="${AGENTS_LINE}"><Number>+1${to10}</Number></Dial></Response>`
  const form = new URLSearchParams({ To: RYAN_CELL, From: RELAY_RING_FROM, Twiml: twiml })
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  })
  if (!res.ok) return { success: false, error: `Twilio ${res.status}: ${(await res.text()).slice(0, 160)}` }
  await sendCampaignAlert(sb, `📞 Connecting you to <b>${label}</b> — answer your cell (ringing now)`)
  await sb.from("campaign_events").insert({
    contact_id: contact?.id ?? null,
    kind: "note",
    caller_number: to10,
    body: `relay call started to ${label}`,
  })
  return { success: true, label }
}

export async function sendAgentsLineText(args: {
  to10: string // 10-digit US number
  body: string
}): Promise<{ success: boolean; error?: string; contactName?: string | null }> {
  const { to10, body } = args
  if (!/^\d{10}$/.test(to10)) return { success: false, error: `bad number: ${to10}` }
  if (!body.trim()) return { success: false, error: "empty message" }

  const sb = getLeadsClient()

  // Respect texted opt-outs (STOP → sms-channel suppression) and full DNC.
  const { data: supp } = await sb
    .from("suppression")
    .select("id")
    .eq("phone", to10)
    .in("channel", ["sms", "all"])
    .limit(1)
  if ((supp ?? []).length > 0) {
    return { success: false, error: "that number is on the DNC / texted STOP — not sending" }
  }

  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!sid || !token) return { success: false, error: "Twilio env missing" }

  const form = new URLSearchParams({ To: `+1${to10}`, From: AGENTS_LINE, Body: body })
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  })
  if (!res.ok) {
    const detail = await res.text()
    return { success: false, error: `Twilio ${res.status}: ${detail.slice(0, 160)}` }
  }

  // Timeline: find the contact (if any) and log the outbound.
  const { data: contacts } = await sb
    .from("campaign_contacts")
    .select("id, name")
    .or(`phone.eq.${to10},alt_phones.cs.{${to10}}`)
    .limit(1)
  const contact = contacts?.[0] ?? null
  await sb.from("campaign_events").insert({
    contact_id: contact?.id ?? null,
    kind: "sms_out",
    caller_number: to10,
    body: body.slice(0, 1000),
    raw: { via: "telegram_reply", from: AGENTS_LINE },
  })
  return { success: true, contactName: contact?.name ?? null }
}
