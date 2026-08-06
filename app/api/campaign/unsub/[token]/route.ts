import { createHmac, timingSafeEqual } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { addSuppression } from "@/lib/suppression"
import { sendCampaignAlert } from "@/lib/campaignAlerts"

// One-click unsubscribe (RFC 8058) — deliverability hardening 2026-08-06.
// Every campaign send carries List-Unsubscribe headers pointing here.
// POST = mail-provider one-click; GET = human tap on the link. Both write
// straight to the master DNC. Token = <contact_id>.<hmac16(contact_id)> —
// unguessable, per-contact, no login. Public path in middleware.

export const dynamic = "force-dynamic"

function verifyToken(token: string): string | null {
  const m = /^([0-9a-f-]{36})\.([0-9a-f]{32})$/.exec(token.replace(/\/$/, ""))
  if (!m || !process.env.CAMPAIGN_UNSUB_SECRET) return null
  const expect = createHmac("sha256", process.env.CAMPAIGN_UNSUB_SECRET).update(m[1]).digest("hex").slice(0, 32)
  try {
    if (!timingSafeEqual(Buffer.from(m[2]), Buffer.from(expect))) return null
  } catch {
    return null
  }
  return m[1]
}

async function unsubscribe(contactId: string, via: string): Promise<boolean> {
  const sb = getLeadsClient()
  const { data: contact } = await sb
    .from("campaign_contacts")
    .select("id, name, email, status")
    .eq("id", contactId)
    .maybeSingle()
  if (!contact) return false
  if (contact.status !== "unsubscribed") {
    await addSuppression(sb, {
      email: contact.email,
      name: contact.name,
      reason: `one-click unsubscribe (${via})`,
      source: "email_unsubscribe",
      source_ref: `campaign_contact:${contact.id}`,
      channel: "email",
      audience: "agent",
    })
    await sb
      .from("campaign_contacts")
      .update({ status: "unsubscribed", next_touch_at: null, updated_at: new Date().toISOString() })
      .eq("id", contact.id)
    await sb
      .from("campaign_sends")
      .update({ status: "skipped", error: "unsubscribed" })
      .eq("contact_id", contact.id)
      .in("status", ["draft", "approved"])
    await sb.from("campaign_events").insert({
      contact_id: contact.id,
      kind: "email_reply",
      triage: "unsubscribe",
      body: `one-click unsubscribe (${via})`,
      raw: { via: `unsub_${via}` },
    })
    await sendCampaignAlert(
      sb,
      `🚫 Campaign unsubscribe — <b>${(contact.name ?? contact.email ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</b> (one-click link) — handled automatically, drip stopped`
    )
  }
  return true
}

export async function POST(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  const contactId = verifyToken(token)
  if (!contactId) return new NextResponse("invalid", { status: 404 })
  await unsubscribe(contactId, "one_click")
  return NextResponse.json({ ok: true })
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  const contactId = verifyToken(token)
  if (!contactId) return new NextResponse("Link invalid or expired.", { status: 404 })
  const ok = await unsubscribe(contactId, "link")
  return new NextResponse(
    `<!doctype html><html><body style="font-family:system-ui;max-width:26rem;margin:4rem auto;text-align:center"><h2>${ok ? "You're unsubscribed." : "Something went wrong."}</h2><p>${ok ? "You won't receive further emails from Ryan at LRG Homes." : "Reply to any of our emails with the word remove instead."}</p></body></html>`,
    { headers: { "Content-Type": "text/html" } }
  )
}
