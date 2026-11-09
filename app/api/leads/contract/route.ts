import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { contractCardLine, DEAL_UNDO_PREFIX, parseMoney, recordContractEvent, type ContractEvent } from "@/lib/deals"

// The e-sign service (esign/lib/crm.mjs, on the Mac mini) reports purchase
// agreements here (2026-11-09, lib/deals): "sent" → the Offer stage with the
// written price; "signed" → Pending, the terms, follow-ups stopped.
// Public path, gated by the shared secret header like /api/reply/drip-draft.
//
// Body: { event: "sent" | "signed", envelope_id, title?, property_address?,
//         at, drive_link?, fields: { purchase_price, earnest_money,
//         closing_days, seller_name }, sellers: [{ name, email, phone }] }
// Returns { status, leadId?, name?, closeBy?, line, undo? } — the e-sign
// service puts `line` and the Undo button in its own Telegram message.
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  const secret = process.env.REPLY_INTERNAL_SECRET || process.env.MC_PASSWORD || ""
  if (!secret || request.headers.get("x-reply-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }
  let body: Record<string, unknown>
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }

  const event = body.event === "sent" || body.event === "signed" ? body.event : null
  const envelopeId = typeof body.envelope_id === "string" ? body.envelope_id : ""
  const at = typeof body.at === "string" && !Number.isNaN(Date.parse(body.at)) ? body.at : ""
  if (!event || !envelopeId || !at) return NextResponse.json({ error: "event, envelope_id and at are required" }, { status: 400 })
  const fields = (body.fields && typeof body.fields === "object" ? body.fields : {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null)
  const days = Number(String(fields.closing_days ?? "").replace(/[^\d]/g, ""))
  const ev: ContractEvent = {
    event, envelopeId, at,
    title: str(body.title),
    propertyAddress: str(body.property_address),
    driveLink: str(body.drive_link),
    price: parseMoney(fields.purchase_price),
    earnestMoney: parseMoney(fields.earnest_money),
    closingDays: String(fields.closing_days ?? "").trim() && Number.isFinite(days) ? days : null,
    sellerName: str(fields.seller_name),
    sellers: (Array.isArray(body.sellers) ? body.sellers : []).slice(0, 8).map((s: Record<string, unknown>) => ({
      name: str(s?.name), email: str(s?.email), phone: str(s?.phone),
    })),
  }

  try {
    const r = await recordContractEvent(getLeadsClient(), ev)
    console.log(`[contract] ${event} ${envelopeId}: ${r.status}${r.leadId ? ` lead ${r.leadId}` : ""}`)
    return NextResponse.json({
      ...r,
      line: event === "signed" ? contractCardLine(r, ev) : null,
      undo: event === "signed" && r.status === "recorded" && r.leadId ? `${DEAL_UNDO_PREFIX}${r.leadId}` : null,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[contract] ${event} ${envelopeId} failed: ${msg}`)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
