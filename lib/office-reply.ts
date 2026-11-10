import type { SupabaseClient } from "@supabase/supabase-js"
import { CARD_LINE, OFFICE_NUMBERS, normalizeE164, sendTwilioSms } from "./leads"
import { relationshipsByAnyPhone } from "./relationships"
import { displayLine } from "./card-line"
import { PROD_BASE } from "./relationship-calls"
import { markDraftSent } from "./reply/record"

// Telegram reply to a "💬 Office line text — …" alert (2026-10-26). The
// contact texted the business-card line, so the reply goes back out on the
// office line they last texted (else the card line) — strictly: never from
// another line, never a `leads` row. Before this a reply fell to sendLeadSms,
// which texted from the default 650 line and wrote a leads outbound row for
// a Relationships contact. Runs regardless of the Card # toggle.
//
// `handled: false` = not an office-line alert for a Relationships contact;
// the caller falls through to its existing path unchanged.

export type OfficeReplyResult =
  | { handled: false }
  | { handled: true; ok: true; name: string; from: string; logWarning: boolean }
  | { handled: true; ok: false; error: string }

export type Rel = { id: string; name: string | null; status: string | null; tier: string | null; category: string | null }

export async function replyToOfficeLineText(sb: SupabaseClient, repliedText: string, body: string): Promise<OfficeReplyResult> {
  if (!/Office line text/i.test(repliedText)) return { handled: false }
  const raw = repliedText.match(/\+\d{10,15}/)?.[0]
  const to = raw ? normalizeE164(raw) : null
  if (!to) return { handled: false }

  let rel: Rel | undefined
  try {
    rel = (await relationshipsByAnyPhone<Rel>(sb, to, "id, name, status, tier, category"))[0]
  } catch (e) {
    // Don't fall through to the lead line on a lookup hiccup — that's the
    // wrong line this branch exists to avoid.
    return { handled: true, ok: false, error: `couldn't look up the contact (${e instanceof Error ? e.message : String(e)})` }
  }
  if (!rel) return { handled: false }
  const out = await sendOfficeText(sb, rel, to, body)
  return out.ok ? { handled: true, ok: true, name: rel.name ?? to, from: out.from, logWarning: out.logWarning } : { handled: true, ok: false, error: out.error }
}

// The contact on a "💬 Office line text" alert: the first +1… in it (their
// main number when the card was matched by a signed number) and the card.
export async function officeAlertContact(sb: SupabaseClient, repliedText: string): Promise<{ to: string; rel: Rel } | null> {
  if (!/Office line text/i.test(repliedText)) return null
  const raw = repliedText.match(/\+\d{10,15}/)?.[0]
  const to = raw ? normalizeE164(raw) : null
  if (!to) return null
  const rel = (await relationshipsByAnyPhone<Rel>(sb, to, "id, name, status, tier, category"))[0]
  return rel ? { to, rel } : null
}

// Text a Relationships contact from the office line they last texted (else
// the card line) and log it as a sent touch — the same writes /api/crms/log
// does, so last_contacted_at restarts their cadence. Shared by a typed
// reply and the ✅ on a Draft: to an office-line alert.
export async function sendOfficeText(
  sb: SupabaseClient,
  rel: Rel,
  to: string,
  body: string,
  draftId?: string | null,
): Promise<{ ok: true; from: string; logWarning: boolean } | { ok: false; error: string }> {
  if (rel.status === "do_not_contact") return { ok: false, error: `${rel.name ?? to} is marked do-not-contact` }
  const from = await lastOfficeLine(sb, rel.id)
  try {
    await sendTwilioSms({
      to,
      body,
      preferredFrom: from,
      strictFrom: true,
      statusCallback: `${PROD_BASE}/api/crms/sms-status?rid=${encodeURIComponent(rel.id)}`,
    })
  } catch (e) {
    return { ok: false, error: `${e instanceof Error ? e.message : String(e)} (from ${displayLine(from)})` }
  }

  const logged = await logSentText(sb, rel, body, from, draftId)
  return { ok: true, from, logWarning: !logged }
}

// A text that went out to a Relationships contact on one of our lines: the
// sent touch + last_contacted_at (what restarts their cadence) + the
// reply_drafts link. The same writes /api/crms/log does. false = a write
// failed (logged, never thrown — the text already went out).
export async function logSentText(sb: SupabaseClient, rel: Pick<Rel, "id" | "tier" | "category">, body: string, line: string, draftId?: string | null): Promise<boolean> {
  const ins = await sb.from("relationship_touches").insert({
    relationship_id: rel.id,
    modality: "sms",
    action: "sent",
    message: body,
    twilio_number: line,
    tier_at_touch: rel.tier,
    category_at_touch: rel.category,
  })
  if (ins.error) console.error("[office-reply] touch insert failed:", ins.error.message)
  if (draftId) await markDraftSent(draftId, { subject: null, body })
  const upd = await sb.from("relationships").update({ last_contacted_at: new Date().toISOString() }).eq("id", rel.id)
  if (upd.error) console.error("[office-reply] last_contacted_at update failed:", upd.error.message)
  return !ins.error && !upd.error
}


// The office line this contact last texted — newest inbound sms touch whose
// twilio_number is an office line — else the business-card line.
async function lastOfficeLine(sb: SupabaseClient, relationshipId: string): Promise<string> {
  const { data, error } = await sb
    .from("relationship_touches")
    .select("twilio_number")
    .eq("relationship_id", relationshipId)
    .eq("modality", "sms")
    .eq("action", "inbound")
    .not("twilio_number", "is", null)
    .order("occurred_at", { ascending: false })
    .limit(10)
  if (error) console.error("[office-reply] last office line lookup failed:", error.message)
  for (const row of (data ?? []) as { twilio_number: string | null }[]) {
    if (row.twilio_number && OFFICE_NUMBERS.has(row.twilio_number)) return row.twilio_number
  }
  return CARD_LINE
}

// Telegram confirmation line for a handled reply.
export function officeReplyMessage(out: Exclude<OfficeReplyResult, { handled: false }>): string {
  const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  if (!out.ok) return `⚠️ Not sent — ${esc(out.error)}`
  return `✅ Texted ${esc(out.name)} from ${displayLine(out.from)}${out.logWarning ? "  ⚠️ (logged with a warning)" : ""}`
}
