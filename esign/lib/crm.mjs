// Purchase agreements → the lead card in Mission Control (2026-11-09).
//
// Sent to a seller → the Offer stage with the written price. Fully signed →
// Pending (under contract), the terms (price, close-by day, Drive link),
// follow-ups and auto-texts stopped. Mission Control does the matching and
// the writes (POST /api/leads/contract, lib/deals.ts); this side reads the
// terms off the agreement's own form fields and reports.
//
// Only offer-bot agreements (the template) with a seller count. Dry runs and
// tests (ESIGN_DRY_MAIL / ESIGN_DRY_DRIVE / ESIGN_DRY_CRM) never report.
import fs from "node:fs"
import { PDFDocument } from "pdf-lib"

const MC_BASE_URL = (process.env.MC_BASE_URL || "https://mission-control-three-chi.vercel.app").trim().replace(/\/$/, "")

export function crmEnabled() {
  return !["ESIGN_DRY_MAIL", "ESIGN_DRY_DRIVE", "ESIGN_DRY_CRM"].some((k) => process.env[k] === "1")
}

/** Ryan signed an agreement on his own (the sellers get the PDF some other way,
 *  e.g. by email): presenting it is the Offer (Ryan's rule, 2026-11-13). The
 *  lead is found by the property address. */
export function isBuyerSignedOffer(envelope, signers) {
  return envelope.kind !== "self" && !!envelope.is_template && !/^TEST\b/i.test(envelope.title || "") && signers.length > 0 && signers.every((s) => s.role === "buyer")
}

export function isSellerContract(envelope, signers) {
  return envelope.kind !== "self" && !!envelope.is_template && !/^TEST\b/i.test(envelope.title || "") && signers.some((s) => s.role === "seller")
}

/** The agreement's terms, read from its form fields. {} when unreadable. */
export async function contractFields(originalPath) {
  try {
    const doc = await PDFDocument.load(fs.readFileSync(originalPath))
    const out = {}
    for (const f of doc.getForm().getFields()) {
      const name = f.getName()
      if (!["purchase_price", "earnest_money", "closing_days", "seller_name"].includes(name)) continue
      try { out[name] = f.getText?.() ?? null } catch { out[name] = null }
    }
    return out
  } catch (e) {
    console.error("[esign] couldn't read the agreement's fields:", e?.message || e)
    return {}
  }
}

/** Report one event. Returns Mission Control's answer; throws when it can't be reached. */
export async function reportContract(event, envelope, signers) {
  const secret = process.env.REPLY_INTERNAL_SECRET || process.env.MC_PASSWORD || ""
  if (!secret) throw new Error("REPLY_INTERNAL_SECRET / MC_PASSWORD is not set")
  const body = {
    event,
    envelope_id: envelope.id,
    title: envelope.title,
    property_address: envelope.property_address,
    at: event === "signed" ? envelope.completed_at : envelope.created_at,
    drive_link: envelope.drive_final_link || null,
    fields: await contractFields(envelope.original_path),
    sellers: signers.filter((s) => s.role === "seller").map((s) => ({ name: s.name, email: s.email, phone: s.phone })),
  }
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 30000)
  try {
    const res = await fetch(`${MC_BASE_URL}/api/leads/contract`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-reply-secret": secret },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
    const json = await res.json().catch(() => null)
    if (!res.ok) throw new Error(`Mission Control ${res.status}: ${json?.error || "no detail"}`)
    return json
  } finally {
    clearTimeout(t)
  }
}
