import { getGmailClient, getLeadsClient } from "@/lib/leads"

// Reply-by-Telegram for EMAIL alerts (2026-07-27, Ryan: typed replies to
// AGENT REPLY alerts should just send). Maps an alert's contact name back
// to the Gmail thread of their latest reply and sends Ryan's text as a
// proper threaded reply from info@ — with In-Reply-To/References so it
// threads correctly on the agent's side too.

// Sender migration 2026-08-06: new outbound goes out as ryansvr@ (info@'s
// reputation is resting). Replies to PRE-migration threads still send from
// info@ — the thread lives in info@'s mailbox and conversation continuity
// wins; the reply event's raw.mailbox says which box owns the thread.
const SEND_AS = process.env.CAMPAIGN_SEND_AS || "ryansvr@lrghomes.com"
const LEGACY_SEND_AS = "info@lrghomes.com"

export async function sendCampaignEmailReply(args: {
  contactName: string
  body: string
}): Promise<{ success: boolean; error?: string; label?: string }> {
  const { contactName, body } = args
  if (!body.trim()) return { success: false, error: "empty message" }
  const sb = getLeadsClient()

  const { data: contacts } = await sb
    .from("campaign_contacts")
    .select("id, name, email, gmail_thread_id")
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
  const raw = (events?.[0]?.raw ?? {}) as { gmail_id?: string; thread_id?: string; subject?: string; mailbox?: string }
  const threadId = raw.thread_id ?? contact.gmail_thread_id
  if (!threadId) return { success: false, error: "no Gmail thread on file — reply from Gmail" }

  // Which mailbox owns this thread? Post-migration events record it;
  // anything without the field predates the migration → info@.
  const sendAs = raw.mailbox ?? LEGACY_SEND_AS
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

  const mime = [
    `From: Ryan LaRocca <${sendAs}>`,
    `To: ${toAddr}`,
    `Subject: ${subject}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    body,
  ].join("\r\n")
  const rawB64 = Buffer.from(mime).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

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
  return { success: true, label: `${contact.name} <${toAddr}>` }
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
