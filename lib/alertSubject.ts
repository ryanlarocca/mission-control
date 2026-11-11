// Who a Telegram alert is about (2026-11-10). Every alert about a person
// records its message id → the lead or Relationships card it's for, so a
// reply to it ("Draft: …" or a plain text) finds the person without parsing
// the alert's wording. Before this each alert format needed its own parser,
// and office-line, agents-line and call-summary alerts had none ("no lead on
// file", "Drafting works on lead alerts…"). Table: telegram_alert_subjects.
//
// Never throws: a failed write only means a reply to that alert falls back
// to the text parsing that came before.

import { getLeadsClient } from "./leads"

// office / agents = a text on that Twilio line. Since 2026-11-11
// (briefs/BRIEF_RELATIONSHIP_EMAIL_ALERTS_2026-11-11.md): email = a
// conversation on ryan@ (answered from ryan@, in their thread); campaign = an
// agent-campaign reply (answered from the campaign mailbox it arrived in).
export type AlertLine = "office" | "agents" | "email" | "campaign"

const ALERT_LINES: readonly AlertLine[] = ["office", "agents", "email", "campaign"]

/** The stored line → a known one. Anything else (null, a typo, a line a
 * newer deploy wrote) reads as "office", as it always has. */
export function parseAlertLine(raw: string | null | undefined): AlertLine {
  return (ALERT_LINES as readonly string[]).includes(raw ?? "") ? (raw as AlertLine) : "office"
}

export type AlertSubject =
  | { kind: "lead"; leadId?: string | null; phone?: string | null; email?: string | null }
  | { kind: "relationship"; relationshipId: string; phone?: string | null; line: AlertLine }

interface Row {
  kind: string
  lead_id: string | null
  relationship_id: string | null
  phone: string | null
  email: string | null
  line: string | null
}

/** Store who the alert `messageId` is about. A lead with neither an id, a
 * phone nor an email isn't worth a row. */
export async function rememberAlertSubject(messageId: number | null | undefined, subject: AlertSubject | null | undefined): Promise<void> {
  if (typeof messageId !== "number" || !subject) return
  if (subject.kind === "lead" && !subject.leadId && !subject.phone && !subject.email) return
  const row =
    subject.kind === "lead"
      ? { message_id: messageId, kind: "lead", lead_id: subject.leadId ?? null, phone: subject.phone ?? null, email: subject.email ?? null, relationship_id: null, line: null }
      : { message_id: messageId, kind: "relationship", relationship_id: subject.relationshipId, phone: subject.phone ?? null, line: subject.line, lead_id: null, email: null }
  try {
    const { error } = await getLeadsClient().from("telegram_alert_subjects").upsert(row, { onConflict: "message_id" })
    if (error) console.error("[alert-subject] remember failed:", error.message)
  } catch (e) {
    console.error("[alert-subject] remember threw:", e instanceof Error ? e.message : String(e))
  }
}

/** The person the alert `messageId` was about, or null (older alert, or one
 * that isn't about a person). */
export async function alertSubjectFor(messageId: number): Promise<AlertSubject | null> {
  try {
    const { data, error } = await getLeadsClient()
      .from("telegram_alert_subjects")
      .select("kind, lead_id, relationship_id, phone, email, line")
      .eq("message_id", messageId)
      .maybeSingle<Row>()
    if (error) {
      console.error("[alert-subject] lookup failed:", error.message)
      return null
    }
    return data ? subjectFromRow(data) : null
  } catch (e) {
    console.error("[alert-subject] lookup threw:", e instanceof Error ? e.message : String(e))
    return null
  }
}

export function subjectFromRow(r: Row): AlertSubject | null {
  if (r.kind === "relationship" && r.relationship_id) {
    return { kind: "relationship", relationshipId: r.relationship_id, phone: r.phone, line: parseAlertLine(r.line) }
  }
  if (r.kind === "lead" && (r.lead_id || r.phone || r.email)) {
    return { kind: "lead", leadId: r.lead_id, phone: r.phone, email: r.email }
  }
  return null
}

/** message_id out of a Telegram sendMessage / sendVoice response body. */
export function messageIdOf(json: unknown): number | null {
  const id = (json as { result?: { message_id?: unknown } } | null)?.result?.message_id
  return typeof id === "number" ? id : null
}
