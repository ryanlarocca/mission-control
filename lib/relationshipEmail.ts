// Email a Relationships contact from the card / detail modal (2026-10-09).
//
// Until now the Relationships tab only knew how to text — the `email` column
// was fetched and dropped on the floor, so an agent who emailed back (Kirsten
// Reilly's Yerba Buena pitch, 2026-10-08) could only be answered from Gmail.
//
// Threading: agent email-campaign replies land as campaign_events rows
// (kind "email_reply", raw.{gmail_id, thread_id, mailbox, subject}) on the
// campaign contact linked to this relationship. When the newest one lives in
// a mailbox the DWD grant can impersonate, the reply goes out from THAT
// mailbox inside THAT thread (threadId + In-Reply-To/References), so it lands
// in the agent's existing conversation. Otherwise it's a fresh email from
// RELATIONSHIP_EMAIL_FROM (ryan@ by default — his real inbox, where the Inbox
// Agent already watches for the answer).
//
// Every send logs a relationship_touches row (modality "email", action
// "sent", message = "<subject>\n<body>" to mirror the inbound format written
// by lib/agentsLineInbound.ts) and advances last_contacted_at, exactly like a
// text sent from the card.

import type { SupabaseClient } from "@supabase/supabase-js"
import { getGmailClient, getLeadsClient } from "@/lib/leads"
import { buildEmailMime, toGmailRaw } from "@/lib/emailMime"
import { markDraftSent } from "@/lib/reply/record"

export const DEFAULT_RELATIONSHIP_MAILBOX = "ryan@lrghomes.com"
export const DEFAULT_FRESH_SUBJECT = "Checking in"

// Mailboxes the Workspace DWD grant can send as (see lib/campaignEmail.ts).
const OWN_DOMAINS = ["lrghomes.com", "lrghomesbuys.com", "lrghomesoffers.com"]
export function isOwnMailbox(mailbox: string | null | undefined): boolean {
  const m = (mailbox ?? "").trim().toLowerCase()
  return !!m && OWN_DOMAINS.some((d) => m.endsWith(`@${d}`))
}

/** "Re: <subject>" with any existing Re:/Fwd: chain collapsed. Empty → fallback. */
export function replySubject(original: string | null | undefined, fallback = DEFAULT_FRESH_SUBJECT): string {
  const base = (original ?? "").replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, "").trim()
  if (!base) return fallback
  return `Re: ${base}`
}

/** Subject for a deliberate new thread: drop any Re:/Fwd: chain, empty → fallback. */
export function newThreadSubject(typed: string | null | undefined, fallback = DEFAULT_FRESH_SUBJECT): string {
  const base = (typed ?? "").replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, "").trim()
  return base || fallback
}

/** Mailbox a fresh (non-threaded) relationship email goes out from. */
export function freshMailbox(env: Record<string, string | undefined> = process.env): string {
  const m = (env.RELATIONSHIP_EMAIL_FROM ?? "").trim().toLowerCase()
  return isOwnMailbox(m) ? m : DEFAULT_RELATIONSHIP_MAILBOX
}

/** The touch-log line for a sent email: subject first, body after (inbound format). */
export function emailTouchMessage(subject: string, body: string): string {
  return `${subject.trim()}\n${body.trim()}`.slice(0, 4000)
}

/** Split a stored email touch back into subject + body for display. */
export function splitEmailTouch(message: string): { subject: string; body: string } {
  const nl = message.indexOf("\n")
  if (nl < 0) return { subject: message.trim(), body: "" }
  return { subject: message.slice(0, nl).trim(), body: message.slice(nl + 1).trim() }
}

export interface EmailThreadRef {
  campaignContactId: string
  mailbox: string
  threadId: string
  gmailId: string | null
  subject: string | null
}

type EventRaw = { gmail_id?: string; thread_id?: string; subject?: string; mailbox?: string }

/** Newest campaign email reply from this relationship that we can answer in-thread. */
export async function findLatestEmailThread(sb: SupabaseClient, relationshipId: string): Promise<EmailThreadRef | null> {
  const { data: cc } = await sb.from("campaign_contacts").select("id").eq("relationship_id", relationshipId).limit(10)
  const ids = (cc ?? []).map((c) => c.id as string)
  if (!ids.length) return null
  const { data: events } = await sb
    .from("campaign_events")
    .select("contact_id, raw")
    .in("contact_id", ids)
    .eq("kind", "email_reply")
    .order("occurred_at", { ascending: false })
    .limit(1)
  const ev = events?.[0]
  if (!ev) return null
  const raw = (ev.raw ?? {}) as EventRaw
  const mailbox = (raw.mailbox ?? "").toLowerCase()
  if (!raw.thread_id || !isOwnMailbox(mailbox)) return null
  return { campaignContactId: ev.contact_id as string, mailbox, threadId: raw.thread_id, gmailId: raw.gmail_id ?? null, subject: raw.subject ?? null }
}

export interface SendRelationshipEmailArgs {
  relationshipId: string
  body: string
  subject?: string | null
  draftId?: string | null
  generatedMessage?: string | null
  wasEdited?: boolean | null
  /** Ryan chose "New thread": ignore any prior campaign thread and send fresh from ryan@. */
  newThread?: boolean | null
}

export interface SendRelationshipEmailResult {
  ok: boolean
  status: number
  error?: string
  to?: string
  mailbox?: string
  subject?: string
  threaded?: boolean
  sentMessageId?: string | null
  touchLogged?: boolean
  lastContactedWritten?: boolean
}

export async function sendRelationshipEmail(args: SendRelationshipEmailArgs): Promise<SendRelationshipEmailResult> {
  const relationshipId = (args.relationshipId || "").trim()
  const body = (args.body || "").trim()
  if (!relationshipId) return { ok: false, status: 400, error: "relationship id required" }
  if (!body) return { ok: false, status: 400, error: "message required" }

  const sb = getLeadsClient()
  const { data: rel, error: relErr } = await sb
    .from("relationships")
    .select("id, name, email, status, tier, category")
    .eq("id", relationshipId)
    .maybeSingle<{ id: string; name: string | null; email: string | null; status: string | null; tier: string | null; category: string | null }>()
  if (relErr) return { ok: false, status: 500, error: `lookup failed: ${relErr.message}` }
  if (!rel) return { ok: false, status: 404, error: "contact not found" }
  if (rel.status === "do_not_contact") return { ok: false, status: 409, error: "contact is marked do not contact" }
  if (!rel.email?.includes("@")) return { ok: false, status: 400, error: "no email address on file" }

  const thread = args.newThread ? null : await findLatestEmailThread(sb, rel.id)
  const mailbox = thread?.mailbox ?? freshMailbox()
  const gmail = getGmailClient(mailbox)

  // Threading headers + the address they actually wrote from, off their message.
  let toAddr = rel.email.trim()
  let inReplyTo = ""
  let references = ""
  let threadSubject = thread?.subject ?? null
  if (thread?.gmailId) {
    try {
      const { data: orig } = await gmail.users.messages.get({
        userId: "me", id: thread.gmailId, format: "metadata",
        metadataHeaders: ["Message-ID", "References", "From", "Subject"],
      })
      const h = Object.fromEntries((orig.payload?.headers ?? []).map((x) => [String(x.name).toLowerCase(), x.value ?? ""]))
      inReplyTo = h["message-id"] ?? ""
      references = [h["references"], h["message-id"]].filter(Boolean).join(" ")
      const fromMatch = /<([^>]+)>/.exec(h["from"] ?? "")
      if (fromMatch) toAddr = fromMatch[1]
      else if ((h["from"] ?? "").includes("@")) toAddr = (h["from"] ?? "").trim()
      if (h["subject"]) threadSubject = h["subject"]
    } catch {
      // best-effort: threadId alone still threads it on our side
    }
  }

  const typed = (args.subject ?? "").trim()
  const subject = thread ? (typed || replySubject(threadSubject)) : newThreadSubject(typed)

  const mime = buildEmailMime({
    from: `Ryan LaRocca <${mailbox}>`,
    to: toAddr,
    subject,
    body,
    extraHeaders: [...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []), ...(references ? [`References: ${references}`] : [])],
  })

  let sentMessageId: string | null = null
  try {
    const { data } = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: toGmailRaw(mime), ...(thread ? { threadId: thread.threadId } : {}) },
    })
    sentMessageId = data.id ?? null
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[relationship-email] Gmail send failed:", msg)
    return { ok: false, status: 502, error: `Gmail send failed: ${msg}` }
  }

  // ── Bookkeeping: touch row, cadence clock, planner draft, campaign side ──
  const ins = await sb.from("relationship_touches").insert({
    relationship_id: rel.id,
    modality: "email",
    action: "sent",
    message: emailTouchMessage(subject, body),
    generated_message: typeof args.generatedMessage === "string" ? args.generatedMessage : null,
    was_edited: args.wasEdited === true ? true : args.wasEdited === false ? false : null,
    tier_at_touch: rel.tier,
    category_at_touch: rel.category,
  })
  if (ins.error) console.error("[relationship-email] touch insert failed:", ins.error.message)

  const upd = await sb.from("relationships").update({ last_contacted_at: new Date().toISOString() }).eq("id", rel.id)
  if (upd.error) console.error("[relationship-email] last_contacted_at update failed:", upd.error.message)

  if (args.draftId) await markDraftSent(args.draftId, { subject, body })

  if (thread) {
    await sb.from("campaign_events").insert({
      contact_id: thread.campaignContactId,
      kind: "email_out",
      body: body.slice(0, 1000),
      raw: { via: "relationships_card", thread_id: thread.threadId, mailbox },
    })
  }

  return {
    ok: true, status: 200, to: toAddr, mailbox, subject, threaded: !!thread, sentMessageId,
    touchLogged: !ins.error, lastContactedWritten: !upd.error,
  }
}
