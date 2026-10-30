import { getGmailClient, getLeadsClient } from "@/lib/leads"
import { buildEmailMime, toGmailRaw } from "@/lib/emailMime"
import { emailTouchMessage } from "@/lib/relationshipEmail"
import type { SupabaseClient } from "@supabase/supabase-js"

// Reply-by-Telegram for EMAIL alerts (2026-07-27, Ryan: typed replies to
// AGENT REPLY alerts should just send). Maps an alert's contact name back
// to the Gmail thread of their latest reply and sends Ryan's text as a
// proper threaded reply from info@ — with In-Reply-To/References so it
// threads correctly on the agent's side too.

// The reply goes out from whichever mailbox owns the thread — the reply
// event's raw.mailbox (info@, ryansvr@, or a September-rebuild sender).
// Anything without the field predates the 2026-08-06 migration → info@.
// (CAMPAIGN_SEND_AS is dead — removed 2026-09-06, rebuild item 4; senders
// live in config/campaign-senders.json.)
const LEGACY_SEND_AS = "info@lrghomes.com"
// Mailboxes the DWD grant can impersonate. A thread owned by anything else
// (the retired consumer Gmail, 2026-08-21 → 2026-09-01) can't be opened, so
// the reply goes out fresh from info@ instead of failing on auth.
const OWN_DOMAINS = ["lrghomes.com", "lrghomesbuys.com", "lrghomesoffers.com"]
const isOwnMailbox = (m: string) => OWN_DOMAINS.some((d) => m.toLowerCase().endsWith(`@${d}`))

export async function sendCampaignEmailReply(args: {
  contactName: string
  body: string
}): Promise<{ success: boolean; error?: string; label?: string; mailbox?: string }> {
  const { contactName, body } = args
  if (!body.trim()) return { success: false, error: "empty message" }
  const sb = getLeadsClient()

  const { data: contacts } = await sb
    .from("campaign_contacts")
    .select("id, name, email, gmail_thread_id, relationship_id")
    .ilike("name", contactName)
    .limit(2)
  if (!contacts?.length) return { success: false, error: `no contact named "${contactName}"` }
  if (contacts.length > 1) return { success: false, error: `two contacts named "${contactName}" — reply from Gmail` }
  const contact = contacts[0]

  // Their latest inbound email → the thread + message we're replying to.
  const { data: events } = await sb
    .from("campaign_events")
    .select("raw")
    .eq("contact_id", contact.id)
    .eq("kind", "email_reply")
    .order("occurred_at", { ascending: false })
    .limit(1)
  const evRaw = (events?.[0]?.raw ?? {}) as { gmail_id?: string; thread_id?: string; subject?: string; mailbox?: string }
  let raw = evRaw
  let sendAs = evRaw.mailbox ?? LEGACY_SEND_AS
  let threadId: string | undefined = evRaw.thread_id ?? contact.gmail_thread_id ?? undefined
  if (!isOwnMailbox(sendAs)) {
    // The retired sender owns this thread: no credentials for it, and its
    // Gmail ids mean nothing to info@. Start a fresh thread from info@ with
    // the same subject line rather than failing on auth.
    raw = { subject: evRaw.subject }
    sendAs = LEGACY_SEND_AS
    threadId = undefined
  } else if (!threadId) {
    return { success: false, error: "no Gmail thread on file — reply from Gmail" }
  }
  const gmail = getGmailClient(sendAs)

  // Pull threading headers + the actual sender address off their message.
  let inReplyTo = ""
  let references = ""
  let toAddr = contact.email ?? ""
  let subject = raw.subject ?? "Re: your reply"
  if (raw.gmail_id) {
    try {
      const { data: orig } = await gmail.users.messages.get({
        userId: "me",
        id: raw.gmail_id,
        format: "metadata",
        metadataHeaders: ["Message-ID", "References", "From", "Subject"],
      })
      const h = Object.fromEntries((orig.payload?.headers ?? []).map((x) => [String(x.name).toLowerCase(), x.value ?? ""]))
      inReplyTo = h["message-id"] ?? ""
      references = [h["references"], h["message-id"]].filter(Boolean).join(" ")
      const fromMatch = /<([^>]+)>/.exec(h["from"] ?? "")
      if (fromMatch) toAddr = fromMatch[1]
      else if ((h["from"] ?? "").includes("@")) toAddr = (h["from"] ?? "").trim()
      if (h["subject"]) subject = h["subject"]
    } catch {
      // metadata fetch is best-effort; threadId still threads it on our side
    }
  }
  if (!toAddr) return { success: false, error: "no email address on file" }
  if (!/^re:/i.test(subject)) subject = `Re: ${subject}`

  // plain + HTML alternative — Gmail hard-wraps plain-only bodies (2026-08-21)
  const mime = buildEmailMime({
    from: `Ryan LaRocca <${sendAs}>`,
    to: toAddr,
    subject,
    body,
    extraHeaders: [...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []), ...(references ? [`References: ${references}`] : [])],
  })
  const rawB64 = toGmailRaw(mime)

  try {
    await gmail.users.messages.send({ userId: "me", requestBody: { raw: rawB64, threadId } })
  } catch (e) {
    return { success: false, error: `Gmail send failed: ${e instanceof Error ? e.message : String(e)}` }
  }

  await sb.from("campaign_events").insert({
    contact_id: contact.id,
    kind: "email_out",
    body: body.slice(0, 1000),
    raw: { via: "telegram_reply", thread_id: threadId, mailbox: sendAs },
  })
  await logRelationshipEmailTouch(sb, {
    relationshipId: contact.relationship_id ?? null,
    emails: [contact.email, toAddr],
    subject,
    body,
  })
  return { success: true, label: `${contact.name} <${toAddr}>`, mailbox: sendAs }
}

/** The Telegram send lands on the agent's Relationships card too
 * (2026-10-30, Ryan: "I emailed Jessa back through Telegram — I don't see it
 * in Mission Control"). Same row shape as a card send (lib/relationshipEmail)
 * so the card's thread, # of touches and Last contacted all pick it up.
 * Card = campaign_contacts.relationship_id, else a Relationships row with the
 * same email. No card → nothing to log. Best-effort: the email already went. */
async function logRelationshipEmailTouch(
  sb: SupabaseClient,
  args: { relationshipId: string | null; emails: (string | null | undefined)[]; subject: string; body: string },
): Promise<void> {
  type Rel = { id: string; tier: string | null; category: string | null }
  let rel: Rel | null = null
  if (args.relationshipId) {
    const { data } = await sb.from("relationships").select("id, tier, category").eq("id", args.relationshipId).limit(1)
    rel = (data?.[0] as Rel) ?? null
  }
  for (const e of args.emails) {
    if (rel) break
    const addr = e?.trim().toLowerCase()
    if (!addr?.includes("@")) continue
    const { data } = await sb.from("relationships").select("id, tier, category").ilike("email", addr).order("status", { ascending: true }).limit(1)
    rel = (data?.[0] as Rel) ?? null
  }
  if (!rel) return
  const ins = await sb.from("relationship_touches").insert({
    relationship_id: rel.id,
    modality: "email",
    action: "sent",
    message: emailTouchMessage(args.subject, args.body),
    tier_at_touch: rel.tier,
    category_at_touch: rel.category,
  })
  if (ins.error) console.error("[campaign-email] touch insert failed:", ins.error.message)
  const upd = await sb.from("relationships").update({ last_contacted_at: new Date().toISOString() }).eq("id", rel.id)
  if (upd.error) console.error("[campaign-email] last_contacted_at update failed:", upd.error.message)
}

/** Contact phone lookup by name — lets "call him back" work on email alerts. */
export async function contactPhoneByName(contactName: string): Promise<string | null> {
  const sb = getLeadsClient()
  const { data } = await sb
    .from("campaign_contacts")
    .select("phone")
    .ilike("name", contactName)
    .limit(2)
  if (data?.length === 1 && data[0].phone && /^\d{10}$/.test(data[0].phone)) return data[0].phone
  return null
}
