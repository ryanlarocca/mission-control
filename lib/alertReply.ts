// Replies to an alert whose person is known (lib/alertSubject) — the one
// path for "Draft: …", a typed text and "call him", on every alert about a
// lead or a Relationships contact (2026-11-10, Ryan: "I want to be able to
// draft a message for every lead type with the same command").
//
//   lead           Draft → coach draft by lead id (text or email by how they
//                  reached us); text → lead line (sendLeadSms), or a threaded
//                  email when we only have their address; call → startLeadCall
//   relationship   Draft → coach draft from the card; text → the line the
//                  alert was on (office / agents), logged as a touch so the
//                  cadence restarts; call → agents relay, or the card's own
//                  click-to-call for an office-line or email alert
//     line email   (2026-11-11, an email to ryan@) Draft → coach email draft;
//                  text → sendRelationshipEmail, from ryan@ in their thread.
//                  No phone needed anywhere.
//     line campaign (2026-11-11, an AGENT REPLY alert) Draft / text → the
//                  same campaign drafter and sender as always
//                  (draftCampaignEmail / sendCampaignEmailReply), with the
//                  campaign contact found through the card instead of by the
//                  name in the alert. "call her" stays on the route's
//                  AGENT REPLY branch (usesLegacyCampaignPath).
//
// Every function returns the Telegram confirmation line; the caller posts it.

import type { AlertSubject } from "./alertSubject"
import { getLeadsClient, lookupLeadName, normalizeE164, sendLeadSms } from "./leads"

type RelationshipSubject = Extract<AlertSubject, { kind: "relationship" }>

export type ReplyIntent = "draft" | "call" | "text"

const CALL_INTENT_RE = /^(please\s+)?call(\s+(her|him|them|back))*(\s+back)?[.!\s]*$/i
const DRAFT_RE = /^draft:\s*([\s\S]+)$/i

/** What a reply means. "draft:" with no guidance is handled by the caller
 * (it must never be sent as a text). */
export function replyIntent(body: string): { intent: ReplyIntent; gist: string } {
  const d = DRAFT_RE.exec(body.trim())
  if (d) return { intent: "draft", gist: d[1].trim() }
  if (CALL_INTENT_RE.test(body.trim())) return { intent: "call", gist: "" }
  return { intent: "text", gist: "" }
}

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

function e164(phone: string | null | undefined): string | null {
  return phone ? normalizeE164(phone) : null
}

/** The lead the alert was about: its id, else the newest row for its phone,
 * else for its email. */
export async function resolveSubjectLead(subject: Extract<AlertSubject, { kind: "lead" }>): Promise<string | null> {
  if (subject.leadId) return subject.leadId
  const sb = getLeadsClient()
  const phone = e164(subject.phone)
  if (phone) {
    const { data } = await sb.from("leads").select("id").eq("caller_phone", phone).order("created_at", { ascending: false }).limit(1).maybeSingle<{ id: string }>()
    if (data) return data.id
  }
  if (subject.email) {
    const { data } = await sb.from("leads").select("id").ilike("email", subject.email).order("created_at", { ascending: false }).limit(1).maybeSingle<{ id: string }>()
    if (data) return data.id
  }
  return null
}

export interface CampaignContactRef {
  id: string
  name: string | null
}

/** Of the campaign contacts linked to a card, the one whose email reply is
 * newest — the one the AGENT REPLY alert was about. A card with one linked
 * contact and no reply on file still has its contact; two with no replies
 * can't be told apart (null). */
export function pickCampaignContact(
  contacts: readonly CampaignContactRef[],
  replies: readonly { contact_id: string; occurred_at: string | null }[],
): CampaignContactRef | null {
  let best: { contact: CampaignContactRef; at: number } | null = null
  for (const r of replies) {
    const contact = contacts.find((c) => c.id === r.contact_id)
    const at = Date.parse(r.occurred_at ?? "")
    if (!contact || !Number.isFinite(at)) continue
    if (!best || at > best.at) best = { contact, at }
  }
  if (best) return best.contact
  return contacts.length === 1 ? contacts[0] : null
}

/** The campaign contact behind a card (campaign_contacts.relationship_id), or null. */
export async function campaignContactForCard(relationshipId: string): Promise<CampaignContactRef | null> {
  try {
    const sb = getLeadsClient()
    const { data: cc, error } = await sb.from("campaign_contacts").select("id, name").eq("relationship_id", relationshipId).limit(20)
    if (error || !cc?.length) return null
    const contacts = cc as CampaignContactRef[]
    const { data: events } = await sb
      .from("campaign_events")
      .select("contact_id, occurred_at")
      .in("contact_id", contacts.map((c) => c.id))
      .eq("kind", "email_reply")
      .order("occurred_at", { ascending: false })
      .limit(20)
    return pickCampaignContact(contacts, (events ?? []) as { contact_id: string; occurred_at: string | null }[])
  } catch (e) {
    console.error("[alert-reply] campaign contact lookup failed:", e instanceof Error ? e.message : String(e))
    return null
  }
}

/** True when a reply to a campaign alert should take the route's older
 * AGENT REPLY branch (by the name in the alert's text): "call her" — that
 * branch relays by the contact's phone, and callSubject has no campaign
 * path — and a card no campaign contact links to. */
export function usesLegacyCampaignPath(intent: ReplyIntent, contactFound: boolean): boolean {
  return intent === "call" || !contactFound
}

/** The typed-reply confirmation for an email to a Relationships contact. HTML-escaped. */
export function emailReplyConfirmation(name: string, out: { threaded?: boolean; mailbox?: string; touchLogged?: boolean }): string {
  const how = out.threaded ? "same thread" : "as a new email (no earlier thread on file)"
  return `✅ Emailed ${esc(name)} — ${how}, from ${esc(out.mailbox ?? "ryan@lrghomes.com")}${out.touchLogged === false ? "  ⚠️ (logged with a warning)" : ""}`
}

async function draftCampaignForSubject(subject: RelationshipSubject, gist: string, replyTo?: number | null): Promise<string | null> {
  const contact = await campaignContactForCard(subject.relationshipId)
  if (!contact) return "⚠️ Couldn't draft — no campaign contact on that card"
  const { draftCampaignEmail, postCampaignDraft } = await import("./campaignDraft")
  const out = await draftCampaignEmail({ contactName: contact.name, contactId: contact.id, guidance: gist })
  if (!out.success || !out.eventId) return `⚠️ Couldn't draft — ${out.error}`
  await postCampaignDraft(out, replyTo)
  return null
}

/** "Draft: <gist>" — posts the draft with ✅/🔁/❌; returns an error line or null. */
export async function draftForSubject(subject: AlertSubject, gist: string, replyTo?: number | null): Promise<string | null> {
  const { coachDraftForLead, coachDraftForRelationship } = await import("./reply/telegram")
  if (subject.kind === "relationship") {
    if (subject.line === "campaign") return draftCampaignForSubject(subject, gist, replyTo)
    const out = await coachDraftForRelationship(subject.relationshipId, e164(subject.phone), gist, replyTo, subject.line)
    return out.ok ? null : `⚠️ Couldn't draft — ${out.error}`
  }
  const leadId = await resolveSubjectLead(subject)
  if (!leadId) return `⚠️ Couldn't draft — no lead on file for ${subject.phone ?? subject.email ?? "this alert"}`
  const out = await coachDraftForLead(leadId, gist, replyTo)
  return out.ok ? null : `⚠️ Couldn't draft — ${out.error}`
}

/** "call him" — rings Ryan's cell and connects; returns the confirmation. */
export async function callSubject(subject: AlertSubject): Promise<string> {
  const phone = e164(subject.phone)
  if (subject.kind === "lead") {
    if (!phone) return "⚠️ No phone on this lead — nothing to call."
    const { startLeadCall } = await import("./leadCall")
    const out = await startLeadCall({ phone, source: null })
    return out.ok ? `📞 Calling your cell now — answer and you'll be connected to ${phone}.` : `⚠️ Couldn't start the call — ${out.error}`
  }
  if (subject.line === "agents") {
    if (!phone) return "⚠️ No phone on this card — nothing to call."
    const { startAgentsLineRelayCall } = await import("./campaignSms")
    const out = await startAgentsLineRelayCall(phone.slice(-10))
    return out.success ? `📞 Calling your cell now — answer and you'll be connected to ${out.label}.` : `⚠️ Couldn't start the call — ${out.error}`
  }
  // Office line, or an email alert (2026-11-11): the same call the card's
  // Call button places — rings Ryan's cell, bridges the contact, recorded
  // onto the card (lib/officeCall). Until then this answered "use the Call
  // button on their card". The number on the alert, else the card's main one.
  const { startOfficeRelayCall } = await import("./officeCall")
  const out = await startOfficeRelayCall({ relationshipId: subject.relationshipId, phone })
  return out.ok
    ? `📞 Calling your cell now — answer and you'll be connected to ${esc(out.label ?? phone ?? "them")}.`
    : `⚠️ Couldn't start the call — ${esc(out.error ?? "unknown error")}`
}

/** A typed reply — sent to the person as-is; returns the confirmation. */
export async function textSubject(subject: AlertSubject, body: string): Promise<string> {
  const sb = getLeadsClient()
  if (subject.kind === "relationship" && subject.line === "campaign") {
    // The AGENT REPLY sender and its wording, with the contact found through the card.
    const contact = await campaignContactForCard(subject.relationshipId)
    if (!contact) return "⚠️ Not sent — no campaign contact on that card"
    const { sendCampaignEmailReply } = await import("./campaignEmail")
    const out = await sendCampaignEmailReply({ contactName: contact.name, contactId: contact.id, body })
    return out.success
      ? `✅ Emailed ${esc(out.label ?? contact.name ?? "the agent")} — same thread, from ${esc(out.mailbox ?? "info@")}.`
      : `⚠️ Not sent — ${esc(out.error ?? "unknown error")}`
  }
  if (subject.kind === "relationship") {
    const { data: rel, error } = await sb.from("relationships").select("id, name, phone, status, tier, category").eq("id", subject.relationshipId).maybeSingle<{ id: string; name: string | null; phone: string | null; status: string | null; tier: string | null; category: string | null }>()
    if (error) return `⚠️ Not sent — couldn't look up the contact (${esc(error.message)})`
    if (!rel) return "⚠️ Not sent — that Relationships card no longer exists"
    if (subject.line === "email") {
      // From ryan@, into their newest conversation; logs the touch and restarts the clock.
      const { sendRelationshipEmail } = await import("./relationshipEmail")
      const out = await sendRelationshipEmail({ relationshipId: rel.id, body })
      return out.ok ? emailReplyConfirmation(rel.name ?? out.to ?? "them", out) : `⚠️ Not sent — ${esc(out.error ?? "unknown error")}`
    }
    const to = e164(subject.phone) ?? e164(rel.phone)
    if (!to) return "⚠️ Not sent — no phone on the card"
    if (subject.line === "agents") {
      const { sendAgentsLineText } = await import("./campaignSms")
      const out = await sendAgentsLineText({ to10: to.slice(-10), body })
      return out.success
        ? `✅ Texted ${esc(rel.name ?? to)} from the agents line${out.logWarning ? "  ⚠️ (logged with a warning)" : ""}`
        : `⚠️ Not sent — ${esc(out.error ?? "unknown error")}`
    }
    const { sendOfficeText } = await import("./office-reply")
    const { displayLine } = await import("./card-line")
    const out = await sendOfficeText(sb, rel, to, body)
    return out.ok
      ? `✅ Texted ${esc(rel.name ?? to)} from ${displayLine(out.from)}${out.logWarning ? "  ⚠️ (logged with a warning)" : ""}`
      : `⚠️ Not sent — ${esc(out.error ?? "unknown error")}`
  }

  const phone = e164(subject.phone)
  if (phone) {
    const out = await sendLeadSms({ phone, message: body, source: null })
    if (!out.success) return `⚠️ Not sent — ${esc(out.error || "unknown error")}`
    const name = await lookupLeadName(sb, phone).catch(() => null)
    return `✅ Sent to ${esc(name ? `${name} (${phone})` : phone)} from the lead line${out.logError ? "  ⚠️ (logged with a warning)" : ""}`
  }
  // Email-only lead: a threaded reply to their newest inbound email.
  const leadId = await resolveSubjectLead(subject)
  if (!leadId) return "⚠️ Not sent — no lead on file for this alert"
  const { buildLeadContext } = await import("./reply/context")
  const ctx = await buildLeadContext(leadId, { live: false })
  if (!ctx) return "⚠️ Not sent — lead not found"
  const { data: inbound } = await sb.from("leads").select("id").in("id", ctx.clusterIds).eq("lead_type", "email").not("twilio_number", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle<{ id: string }>()
  if (!inbound) return "⚠️ Not sent — no phone and no inbound email to reply to"
  const { sendThreadedEmailReply } = await import("./emailReply")
  const out = await sendThreadedEmailReply({ leadId: inbound.id, text: body })
  return out.ok ? `✅ Emailed ${esc(ctx.name || ctx.email || "the lead")} — same thread` : `⚠️ Not sent — ${esc(out.error ?? "unknown error")}`
}
