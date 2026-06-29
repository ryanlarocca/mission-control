import { NextResponse } from "next/server"
import { gmail_v1 } from "googleapis"

// Pub/Sub push ack timeout is 10s by default; Gmail history.list + message.get
// + Haiku triage + Supabase insert can blow past Vercel's 10s default. Bump it.
export const maxDuration = 30
import {
  CAMPAIGN_MAP,
  EMAIL_CAMPAIGN_MAP,
  FORWARD_TO,
  dedupeClusterStamps,
  getEmailCampaign,
  getGmailClient,
  getLeadsClient,
  isMobileHome,
  type LeadStatus,
  normalizePhone,
  sendTelegramAlert,
  triageEmailLead,
} from "@/lib/leads"
import { scoreLeadSpam, spamAlertLines, spamReviewColumns } from "@/lib/lead-spam"

// Gmail Push → Pub/Sub → this route. Pub/Sub HTTP push delivers an
// envelope of the form:
//   { message: { data: "<base64>", messageId, publishTime, ... }, subscription }
// where `data` is a base64-encoded JSON blob `{ emailAddress, historyId }`
// emitted by Gmail's watch.
//
// Pub/Sub treats anything other than 2xx as failure and retries with
// backoff. We process inline (await) instead of waitUntil — observed in
// production that waitUntil silently drops the work and produces no logs,
// matching the project-wide rule "always await load-bearing writes in
// Vercel route handlers." Push subscription deadline is 10s by default;
// maxDuration=30 above gives us headroom for Gmail+Haiku+Supabase+Telegram.
//
// Auth: this endpoint is whitelisted in middleware.ts because Pub/Sub
// hits it without a session cookie. Pub/Sub itself can be configured
// with an OIDC token verifier on top — we don't gate on that here so
// the script can wire it up incrementally.

interface PubSubEnvelope {
  message?: {
    data?: string
    messageId?: string
    publishTime?: string
    attributes?: Record<string, string>
  }
  subscription?: string
}

interface GmailNotification {
  emailAddress?: string
  historyId?: number | string
}

// Direct POST from Apps Script — simpler than Pub/Sub, no org-policy issues.
// Payload: { secret, mailbox, from, subject, body, date }
interface AppsScriptPayload {
  secret?: string
  mailbox?: string
  from?: string
  subject?: string
  body?: string
  date?: string
}

// Look up the cluster's most recent row so a new inbound row can inherit
// cluster identity: lifecycle status (parked nurture / contacted / active
// leads stay in their bucket — groupLeads keys cluster status off the
// most-recent inbound) and drip_campaign_type (fresh-stamping a second
// drip_campaign_type row for the same cluster causes the drip engine to
// double-fire touches). Precedence mirrors groupLeads' cluster key cascade:
// phone → gmail_thread → email. Returns null when no prior row exists.
async function lookupEmailCluster(args: {
  sb: ReturnType<typeof getLeadsClient>
  phone: string | null
  threadId: string | null
  senderEmail: string
}): Promise<{ status: LeadStatus; dripCampaignType: string | null } | null> {
  const { sb, phone, threadId, senderEmail } = args
  const shape = (row: { status: string | null; drip_campaign_type: string | null }) => ({
    status: (row.status as LeadStatus | undefined) ?? "new",
    dripCampaignType: row.drip_campaign_type ?? null,
  })
  if (phone) {
    const { data } = await sb
      .from("leads")
      .select("status, drip_campaign_type")
      .eq("caller_phone", phone)
      // Inbound rows only (twilio_number IS NOT NULL) — matching the
      // voice/sms intake lookups. Without this, the most recent row for the
      // phone could be an outbound call/SMS Ryan made (twilio_number=null,
      // status="contacted"), so a brand-new email lead was born "contacted"
      // and skipped the fresh drip stamp.
      .not("twilio_number", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
    if (data?.[0]) return shape(data[0])
  }
  if (threadId) {
    const { data } = await sb
      .from("leads")
      .select("status, drip_campaign_type")
      .eq("gmail_thread_id", threadId)
      .order("created_at", { ascending: false })
      .limit(1)
    if (data?.[0]) return shape(data[0])
  }
  const { data } = await sb
    .from("leads")
    .select("status, drip_campaign_type")
    .eq("lead_type", "email")
    .eq("email", senderEmail)
    .order("created_at", { ascending: false })
    .limit(1)
  if (data?.[0]) return shape(data[0])
  return null
}

// ─── Google Voice forwards ──────────────────────────────────────────────
// The legacy Google Voice line (an old direct-mail callback number) forwards
// every missed call / voicemail / text to a campaign mailbox as an email from
// voice-noreply@google.com. These are NOT direct-mail email replies:
//   • the real contact is the *caller* named in the GV body, not the sender;
//   • the body is wrapped in Google Voice chrome (voice.google.com links,
//     account URLs, "play message");
//   • a steady fraction are marketing / political SMS blasts from 5–6 digit
//     shortcodes (Sierra Club, etc.) that are never real sellers.
// Treating them as generic email leads merged every GV forward under the one
// shared voice-noreply@ identity (the email-key cluster fallback), which bled
// one lead's address onto all of them — e.g. Chris Bola's "618 Beta Court"
// landing on unrelated GV rows. We instead parse the forward into the
// underlying call/text, cluster on the *caller's* phone, label it "Legacy DM",
// and drop shortcode spam entirely.
const GOOGLE_VOICE_SENDER = "voice-noreply@google.com"

// Google Voice forwards arrive from two sender families:
//   • voice-noreply@google.com — calls / voicemails
//   • <gv-line>.<correspondent>.<hash>@txt.voice.google.com — text messages
// All of Ryan's ~8 GV numbers are antiquated legacy-campaign lines, so EVERY
// GV forward — whichever line, whichever sender — is a Legacy DM lead. We key
// off the correspondent named in the body (never the GV line), so it doesn't
// matter how many lines exist or which one a text came through. Match the
// whole voice.google.com domain family, not a single address — otherwise text
// notifications slip past into the generic email path and become junk leads
// with a google-gateway "email" (the bug Ryan hit 2026-06-29).
function isGoogleVoice(senderEmail: string): boolean {
  const s = senderEmail.toLowerCase().trim()
  if (s === GOOGLE_VOICE_SENDER) return true
  const domain = s.split("@")[1] || ""
  return domain === "voice.google.com" || domain.endsWith(".voice.google.com")
}

interface GoogleVoiceParse {
  kind: "text" | "voicemail" | "missed_call" | "unknown"
  // E.164 caller — only when the "from" token is a real 10-digit US number.
  // null for shortcode senders (69866) and anything unresolvable; those are
  // treated as spam and not ingested.
  callerPhone: string | null
  // Underlying message — SMS text or voicemail transcript, GV chrome stripped.
  // Empty for a bare missed call.
  content: string
}

// Lines that are pure Google Voice chrome, not lead content.
function isGvChromeLine(line: string): boolean {
  const t = line.trim()
  if (!t) return true
  if (/^<?https?:\/\//i.test(t)) return true
  if (/voice\.google\.com|accounts\.google\.com/i.test(t)) return true
  if (/^play message$/i.test(t)) return true
  if (/^call back$/i.test(t)) return true
  if (/^your account\b/i.test(t) || /help center/i.test(t)) return true
  if (/to respond to this message/i.test(t)) return true
  if (/launch google voice/i.test(t)) return true
  if (/to avoid missing calls/i.test(t)) return true
  if (/keep google voice/i.test(t)) return true
  if (/^hello .+,$/i.test(t)) return true // "Hello Ryan SVJ,"
  return false
}

function parseGoogleVoiceForward(subject: string, body: string): GoogleVoiceParse {
  const lines = body.split(/\r?\n/)
  const headerLine = lines.find((l) => l.trim()) || subject || ""
  const header = headerLine.trim()

  let kind: GoogleVoiceParse["kind"] = "unknown"
  if (/new text message/i.test(header)) kind = "text"
  else if (/new voicemail/i.test(header)) kind = "voicemail"
  else if (/new missed call|missed a call/i.test(header)) kind = "missed_call"

  // Caller token after "from". A real number → E.164; a shortcode (69866) or
  // anything non-numeric → null (spam, skip ingestion).
  let callerPhone: string | null = null
  const phoneMatch = header.match(
    /from\s+\+?1?[\s.]*\(?(\d{3})\)?[\s.\-]*(\d{3})[\s.\-]*(\d{4})/i
  )
  if (phoneMatch) {
    const n = normalizePhone(`${phoneMatch[1]}${phoneMatch[2]}${phoneMatch[3]}`)
    if (/^\+\d{10,15}$/.test(n)) callerPhone = n
  }

  // Content = body minus the header line minus GV chrome.
  const startIdx = lines.indexOf(headerLine)
  const content = lines
    .slice(startIdx >= 0 ? startIdx + 1 : 0)
    .filter((l) => !isGvChromeLine(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  return { kind, callerPhone, content }
}

// Ingest a Google Voice forward as a Legacy-DM call/text lead. Returns a
// status object the two POST entry points can fold into their own response.
async function ingestGoogleVoice(args: {
  sb: ReturnType<typeof getLeadsClient>
  subject: string
  body: string
  mailbox: string
  threadId: string | null
}): Promise<{ skipped?: string; leadId?: string }> {
  const { sb, subject, body, mailbox, threadId } = args
  const parsed = parseGoogleVoiceForward(subject, body)

  // Shortcode / unresolvable sender → marketing or political SMS blast, never
  // a real seller. Don't ingest (product decision). Log so we still see what
  // hit the line.
  if (!parsed.callerPhone) {
    console.log(
      `[email][gv] Skipping GV forward — no real caller phone (kind=${parsed.kind}) subject="${subject.slice(0, 80)}"`
    )
    return { skipped: "gv_shortcode_spam" }
  }

  const phone = parsed.callerPhone

  // The body's correspondent is one of OUR OWN lines — a Twilio campaign /
  // outbound number, or Ryan's forward-to cell texting his own GV line (e.g.
  // during testing). That's not a prospect. Skip. (LRG_OWN_NUMBERS is defined
  // lower in the module but only read here at request time, so the reference
  // is safe.)
  if (LRG_OWN_NUMBERS.has(phone.replace(/\D/g, "").slice(-10))) {
    console.log(`[email][gv] Skipping — body number ${phone} is one of our own lines`)
    return { skipped: "gv_own_number" }
  }

  const kindLabel =
    parsed.kind === "text"
      ? "Text message"
      : parsed.kind === "voicemail"
      ? "Voicemail"
      : parsed.kind === "missed_call"
      ? "Missed call"
      : "Message"
  // Name: self-identification in a voicemail transcript wins ("hi, this is
  // John"); otherwise the formatted phone stands in. NEVER "Google Voice".
  const name = extractNameFromBody(parsed.content) || formatPhoneForAlert(phone)
  const content = parsed.content || `${kindLabel} — no message left.`
  const messageText = `${kindLabel} (Google Voice)\n\n${content}`.slice(0, 2000)

  // Dedup on the *caller* (not the shared voice-noreply@ address) + message.
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { data: existing } = await sb
    .from("leads")
    .select("id, message")
    .eq("caller_phone", phone)
    .not("twilio_number", "is", null)
    .gte("created_at", oneHourAgo)
    .limit(50)
  if (
    existing &&
    existing.some((r) => (r.message || "").slice(0, 200) === messageText.slice(0, 200))
  ) {
    console.log(`[email][gv] Skipping duplicate GV ${parsed.kind} from ${phone}`)
    return { skipped: "duplicate" }
  }

  // Cluster on the caller's phone (or thread) ONLY. We must NOT pass the
  // shared voice-noreply@ address into lookupEmailCluster's email fallback:
  // every GV forward carries that same sender, so the fallback would latch a
  // brand-new caller onto whatever stale voice-noreply@ row sorts newest and
  // inherit its campaign + status — the exact identity/status bleed the
  // 2026-06-09 fix set out to kill (it bit a real prospect 2026-06-29: a new
  // GV text lead inherited a dead row's status + direct_mail_email drip).
  // Passing "" makes the email branch a guaranteed no-op.
  const cluster = await lookupEmailCluster({
    sb, phone, threadId, senderEmail: "",
  })
  const inheritedStatus = cluster?.status ?? "new"

  // Real caller w/ phone, no email → direct_mail_call: same drip + follow-up
  // as any other direct-mail call lead. Re-engagements carry the cluster's
  // existing clock without resetting it.
  const dripFields: Record<string, unknown> = !cluster
    ? {
        drip_campaign_type: "direct_mail_call",
        drip_touch_number: 0,
        last_drip_sent_at: new Date().toISOString(),
      }
    : cluster.dripCampaignType
    ? { drip_campaign_type: cluster.dripCampaignType }
    : {}

  // Triage the spoken/written content; a bare missed call has nothing to read.
  const triage =
    parsed.kind === "missed_call" && !parsed.content
      ? null
      : await triageEmailLead(subject, content)

  const { data: inserted, error: insertErr } = await sb
    .from("leads")
    .insert({
      lead_type: "email",
      source_type: "direct_mail",
      source: "Legacy DM",
      twilio_number: `email:${mailbox}`,
      caller_phone: phone,
      name,
      email: null,
      message: messageText,
      ai_notes: triage?.summary ?? null,
      suggested_reply: triage?.suggestedReply ?? null,
      status: triage?.is_dead ? "dead" : inheritedStatus,
      temperature: triage?.temperature ?? null,
      gmail_thread_id: threadId,
      ...dripFields,
    })
    .select("id")
    .single()
  if (insertErr) {
    console.error(`[email][gv] Insert failed:`, insertErr)
    return { skipped: "insert_failed" }
  }
  console.log(`[email][gv] Inserted Legacy DM lead ${inserted?.id} — ${parsed.kind} from ${phone}`)

  if (cluster?.dripCampaignType) {
    try {
      await dedupeClusterStamps(sb, { caller_phone: phone, gmail_thread_id: threadId })
    } catch (e) {
      console.warn("[email][gv] cluster dedupe failed:", e instanceof Error ? e.message : String(e))
    }
  }

  if (inserted?.id) {
    try {
      const { resolveCampaignId } = await import("@/lib/campaigns")
      const campaignId = await resolveCampaignId({
        source: "Legacy DM", source_type: "direct_mail", created_at: new Date(),
      })
      if (campaignId) await sb.from("leads").update({ campaign_id: campaignId }).eq("id", inserted.id)
    } catch (e) {
      console.warn("[email][gv] campaign attribution failed:", e instanceof Error ? e.message : String(e))
    }
  }

  const lines = [
    "📞 New Legacy DM lead (Google Voice)",
    `👤 ${name}`,
    `📞 ${formatPhoneForAlert(phone)}`,
    `✉️ ${kindLabel}`,
  ]
  if (triage) {
    const tempLabel = triage.is_dead ? "DEAD" : triage.temperature.toUpperCase()
    lines.push(`🤖 AI: <b>${tempLabel}</b> — ${escapeHtml(triage.summary)}`)
  }
  await sendTelegramAlert(lines.join("\n"))

  return { leadId: inserted?.id }
}

export async function POST(request: Request) {
  let rawBody: any
  try {
    rawBody = await request.json()
  } catch (e) {
    console.error("[email] Failed to parse request body:", e)
    return NextResponse.json({ ok: true })
  }

  // Route 1: Apps Script direct POST (has `mailbox` + `secret` fields)
  if (rawBody?.mailbox && rawBody?.secret) {
    return handleAppsScript(rawBody as AppsScriptPayload)
  }

  // Route 2: Pub/Sub envelope (legacy — kept for future use)
  const envelope = rawBody as PubSubEnvelope
  const dataB64 = envelope?.message?.data
  if (!dataB64) {
    console.warn("[email] Envelope missing message.data; ignoring")
    return NextResponse.json({ ok: true })
  }

  let notification: GmailNotification
  try {
    const decoded = Buffer.from(dataB64, "base64").toString("utf-8")
    notification = JSON.parse(decoded) as GmailNotification
  } catch (e) {
    console.error("[email] Failed to decode notification data:", e)
    return NextResponse.json({ ok: true })
  }

  const emailAddress = (notification.emailAddress || "").toLowerCase()
  const historyId = notification.historyId
  if (!emailAddress || !historyId) {
    console.warn(`[email] Notification missing fields — emailAddress:${!!emailAddress} historyId:${!!historyId}`)
    return NextResponse.json({ ok: true })
  }

  if (!EMAIL_CAMPAIGN_MAP[emailAddress]) {
    console.warn(`[email] Notification for unmapped address: ${emailAddress}`)
    return NextResponse.json({ ok: true })
  }

  const campaign = getEmailCampaign(emailAddress)
  console.log(`[email] Pub/Sub notification — ${emailAddress} (${campaign.source}) historyId:${historyId}`)

  await processEmailNotification({ emailAddress, historyId: String(historyId), campaign })
  return NextResponse.json({ ok: true })
}

async function handleAppsScript(payload: AppsScriptPayload): Promise<NextResponse> {
  const expectedSecret = process.env.EMAIL_WEBHOOK_SECRET
  if (!expectedSecret || payload.secret !== expectedSecret) {
    console.warn("[email] Apps Script request with invalid secret")
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }

  const mailbox = (payload.mailbox || "").toLowerCase()
  if (!EMAIL_CAMPAIGN_MAP[mailbox]) {
    console.warn(`[email] Apps Script payload for unmapped mailbox: ${mailbox}`)
    return NextResponse.json({ ok: true })
  }

  const campaign = getEmailCampaign(mailbox)
  const fromRaw = payload.from || ""
  const subject = payload.subject || "(no subject)"
  const bodyText = stripQuoted(payload.body || "")

  const { name: headerName, email: senderEmail } = parseFromHeader(fromRaw)
  if (!senderEmail) {
    console.warn(`[email] Apps Script payload missing sender email: ${fromRaw}`)
    return NextResponse.json({ ok: true })
  }
  // Self-identification in the body wins over the From-header display name.
  // The lead's spoken/written name is the most authoritative signal —
  // covers Google Voice voicemail forwards (header is always "Google Voice")
  // and any case where the sender's display name is generic/missing/wrong.
  // Header is the safety net when the body has no recognizable
  // self-identification phrase.
  const name = extractNameFromBody(bodyText) || headerName

  // Don't ingest mail sent from any of our own mailboxes — the receiving
  // inbox itself or a reply Ryan sent from a different LRG mailbox. See
  // isOwnAddress.
  if (isOwnAddress(senderEmail)) {
    console.log(`[email] Skipping — sent from an LRG mailbox (${senderEmail})`)
    return NextResponse.json({ ok: true })
  }

  // Don't ingest mailer-daemon bounces back from our own outbound sends.
  if (isBounceEmail(senderEmail, subject)) {
    console.log(`[email] Skipping bounce from ${senderEmail} — ${subject}`)
    return NextResponse.json({ ok: true, skipped: "bounce" })
  }

  // Google Voice forwards (legacy DM line) get their own parse/cluster/spam
  // path — see ingestGoogleVoice. The generic email-lead flow below would
  // merge them all under voice-noreply@ and bleed addresses across callers.
  if (isGoogleVoice(senderEmail)) {
    const res = await ingestGoogleVoice({
      sb: getLeadsClient(), subject, body: bodyText, mailbox, threadId: null,
    })
    return NextResponse.json({ ok: true, ...res })
  }

  // Extracted as 10 raw digits; normalize to E.164 so the `caller_phone`
  // column matches the format we use everywhere else (call relay, dedup,
  // PATCH path) and the Call button activates without a manual fix-up.
  const rawPhone = extractPhoneFromText(bodyText)
  const phone = rawPhone
    ? (() => {
        const n = normalizePhone(rawPhone)
        return /^\+\d{10,15}$/.test(n) ? n : null
      })()
    : null
  const messageText = `${subject}\n\n${bodyText}`.slice(0, 2000)

  // Dedup: check for same sender + similar message in the last hour
  const sb = getLeadsClient()
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { data: existing } = await sb
    .from("leads")
    .select("id, message")
    .eq("lead_type", "email")
    .eq("email", senderEmail)
    .gte("created_at", oneHourAgo)
    .limit(50)
  if (existing && existing.some((r) => (r.message || "").slice(0, 200) === messageText.slice(0, 200))) {
    console.log(`[email] Skipping duplicate from ${senderEmail}`)
    return NextResponse.json({ ok: true, deduplicated: true })
  }

  // Haiku triage — non-fatal
  const triage = await triageEmailLead(subject, bodyText)

  // Inherit cluster status + drip metadata so re-engagement doesn't reset to
  // "new" and doesn't double-stamp drip. Apps Script payloads carry no Gmail
  // threadId, so phone → email only.
  const cluster = await lookupEmailCluster({
    sb, phone, threadId: null, senderEmail,
  })
  const inheritedStatus = cluster?.status ?? "new"

  // Phase 7B: pick the drip campaign by source bucket. google_ads_email_only
  // upgrades to google_ads_form when caller_phone arrives; direct_mail_email
  // alternates channels mid-cycle once a phone is on the lead.
  const freshDripCampaignType = campaign.source_type === "google_ads"
    ? "google_ads_email_only"
    : "direct_mail_email"
  // Fresh-stamp drip only for genuinely new clusters. Re-engagements carry
  // the cluster's existing campaign forward without resetting the clock; the
  // original intake row owns drip_touch_number / last_drip_sent_at.
  const dripFields: Record<string, unknown> = !cluster
    ? {
        drip_campaign_type: freshDripCampaignType,
        drip_touch_number: 0,
        last_drip_sent_at: new Date().toISOString(),
      }
    : cluster.dripCampaignType
    ? { drip_campaign_type: cluster.dripCampaignType }
    : {}
  // Phase 7C-may8 Bug 5: mobile-home / lot-number flag.
  const isJunkAddr = isMobileHome(bodyText) || isMobileHome(subject)
  // Fake-lead detection — Google Ads leads only for now (direct-mail /
  // MFM campaigns are a different audience and excluded). Fresh leads
  // only: a returning known lead must not get re-flagged every time it
  // replies. `spam` is null for non-Google-Ads or re-engagements, which
  // suppresses both the review banner and the alert.
  const spam =
    cluster || campaign.source_type !== "google_ads"
      ? null
      : scoreLeadSpam({ name, email: senderEmail, phone })
  const { data: inserted, error: insertErr } = await sb
    .from("leads")
    .insert({
      lead_type: "email",
      source_type: campaign.source_type,
      source: campaign.source,
      // `email:<receiving-mailbox>` (NOT null) — `isOutbound()` keys off
      // null === outbound. Email leads from a sender are inbound, so we
      // need a non-null value. Encoding the receiving mailbox lets the
      // /api/leads/email-reply route know which mailbox to send replies
      // from without an extra lookup.
      twilio_number: `email:${mailbox}`,
      caller_phone: phone,
      name,
      email: senderEmail,
      message: messageText,
      ai_notes: triage?.summary ?? null,
      suggested_reply: triage?.suggestedReply ?? null,
      status: triage?.is_dead ? "dead" : inheritedStatus,
      temperature: triage?.temperature ?? null,
      is_junk: isJunkAddr || undefined,
      // Suspected-fake review banner (suggested_status + reason). {} when
      // the lead is clean or is a re-engagement — spreads harmlessly.
      ...(spam ? spamReviewColumns(spam) : {}),
      ...dripFields,
    })
    .select("id")
    .single()

  if (insertErr) {
    console.error(`[email] Insert failed:`, insertErr)
    return NextResponse.json({ ok: false, error: "insert_failed" }, { status: 500 })
  }

  console.log(`[email] Inserted email lead ${inserted?.id} from ${senderEmail} (${campaign.source})`)

  // Re-engagement carried the cluster's drip stamp onto this new event
  // row. Sweep so exactly ONE row drives the drip engine (same fix as the
  // voice/sms routes). No-op when the cluster has ≤1 stamped row.
  if (cluster?.dripCampaignType) {
    try {
      await dedupeClusterStamps(sb, { caller_phone: phone, email: senderEmail })
    } catch (e) {
      console.warn("[email] cluster dedupe failed:", e instanceof Error ? e.message : String(e))
    }
  }

  // Campaign attribution — best-effort, doesn't fail ingest if it returns null.
  if (inserted?.id) {
    try {
      const { resolveCampaignId } = await import("@/lib/campaigns")
      const campaignId = await resolveCampaignId({ source: campaign.source, source_type: campaign.source_type, created_at: new Date() })
      if (campaignId) {
        await sb.from("leads").update({ campaign_id: campaignId }).eq("id", inserted.id)
      }
    } catch (e) {
      console.warn("[email] campaign attribution failed:", e instanceof Error ? e.message : String(e))
    }
  }

  const lines = [
    "📧 New email lead",
    `[${formatCampaignLabel(campaign.source)}]`,
    `👤 ${name || "(no name)"}`,
    `📧 ${senderEmail}`,
  ]
  if (phone) lines.push(`📞 ${formatPhoneForAlert(phone)}`)
  if (triage) {
    const tempLabel = triage.is_dead ? "DEAD" : triage.temperature.toUpperCase()
    lines.push(`🤖 AI: <b>${tempLabel}</b> — ${escapeHtml(triage.summary)}`)
  }
  // Append the fake-lead warning to the alert Ryan already gets — one
  // note with all the context, not a second message. No-op when clean.
  if (spam) lines.push(...spamAlertLines(spam))
  await sendTelegramAlert(lines.join("\n"))

  return NextResponse.json({ ok: true, leadId: inserted?.id })
}

async function processEmailNotification(args: {
  emailAddress: string
  historyId: string
  campaign: { source: string; source_type: string }
}): Promise<void> {
  const { emailAddress, historyId, campaign } = args
  try {
    const gmail = getGmailClient(emailAddress)
    const messageIds = await fetchRecentInboxMessageIds(gmail)
    if (messageIds.length === 0) {
      console.log(`[email] No recent inbox messages for ${emailAddress} (notif historyId=${historyId})`)
      return
    }
    console.log(`[email] Scanning ${messageIds.length} recent message(s) for ${emailAddress}`)
    for (const messageId of messageIds) {
      try {
        await processSingleMessage({ gmail, messageId, emailAddress, campaign })
      } catch (e) {
        console.error(`[email] Failed to process message ${messageId}:`, e)
      }
    }
  } catch (e) {
    console.error("[email] Background processing threw:", e)
  }
}

async function processSingleMessage(args: {
  gmail: gmail_v1.Gmail
  messageId: string
  emailAddress: string
  campaign: { source: string; source_type: string }
}): Promise<void> {
  const { gmail, messageId, emailAddress, campaign } = args

  // Fetch the full message payload so we have headers + body.
  const { data: message } = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  })

  // Skip Gmail "CHAT" or items we don't want surfaced as leads.
  const labelIds = message.labelIds || []
  if (!labelIds.includes("INBOX")) {
    console.log(`[email] Skipping ${messageId} — not in INBOX`)
    return
  }

  const headers = message.payload?.headers
  const fromHeader = getHeader(headers, "From")
  const subject = getHeader(headers, "Subject") || "(no subject)"
  const { name: headerName, email: senderEmail } = parseFromHeader(fromHeader)
  if (!senderEmail) {
    console.warn(`[email] ${messageId} missing usable From header: ${fromHeader}`)
    return
  }
  // Don't ingest mail sent from any of our own mailboxes — the receiving
  // inbox itself (Ryan testing) or a reply Ryan sent to a lead from a
  // different LRG mailbox (which would otherwise be born as a bogus inbound
  // lead named after the From display name). See isOwnAddress.
  if (isOwnAddress(senderEmail)) {
    console.log(`[email] Skipping ${messageId} — sent from an LRG mailbox (${senderEmail})`)
    return
  }

  // Don't ingest mailer-daemon bounces back from our own outbound sends.
  if (isBounceEmail(senderEmail, subject)) {
    console.log(`[email] Skipping ${messageId} — bounce from ${senderEmail}`)
    return
  }

  const bodyText = extractPlainBody(message.payload)

  // Google Voice forwards (legacy DM line) — dedicated parse/cluster/spam
  // path. See ingestGoogleVoice + the handleAppsScript call site.
  if (isGoogleVoice(senderEmail)) {
    await ingestGoogleVoice({
      sb: getLeadsClient(), subject, body: bodyText,
      mailbox: emailAddress, threadId: message.threadId || null,
    })
    return
  }

  // Self-identification in the body wins over the From-header display name
  // (covers Google Voice forwarded voicemails + any lead whose header name
  // is generic/missing/wrong). Header is the safety net.
  const name = extractNameFromBody(bodyText) || headerName
  // Extracted as 10 raw digits; normalize to E.164 so the `caller_phone`
  // column matches the format we use everywhere else (call relay, dedup,
  // PATCH path) and the Call button activates without a manual fix-up.
  const rawPhone = extractPhoneFromText(bodyText)
  const phone = rawPhone
    ? (() => {
        const n = normalizePhone(rawPhone)
        return /^\+\d{10,15}$/.test(n) ? n : null
      })()
    : null

  // Idempotency: Pub/Sub redeliveries can repeat the same gmail messageId.
  // We dedupe by checking for an existing email-lead row from this sender
  // with matching message text within the last hour. If one exists, skip.
  // Limit 50 — high enough to absorb a busy thread (the 5 previously here
  // would silently miss matches when more than 5 emails from one sender
  // landed in the same hour during burst testing).
  const sb = getLeadsClient()
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { data: existing } = await sb
    .from("leads")
    .select("id, message")
    .eq("lead_type", "email")
    .eq("email", senderEmail)
    .gte("created_at", oneHourAgo)
    .limit(50)
  const messageText = `${subject}\n\n${bodyText}`.slice(0, 2000)
  if (existing && existing.some((r) => (r.message || "").slice(0, 200) === messageText.slice(0, 200))) {
    console.log(`[email] Skipping duplicate of ${messageId} from ${senderEmail}`)
    return
  }

  // Triage with Haiku — non-fatal; null leaves the lead with the inherited
  // cluster status (or "new" for fresh callers) and Ryan sees it untouched.
  const triage = await triageEmailLead(subject, bodyText)

  // Inherit cluster status + drip metadata (see lookupEmailCluster above).
  const cluster = await lookupEmailCluster({
    sb, phone, threadId: message.threadId || null, senderEmail,
  })
  const inheritedStatus = cluster?.status ?? "new"

  // Phase 7B: same drip-campaign mapping as handleAppsScript above.
  const freshDripCampaignType = campaign.source_type === "google_ads"
    ? "google_ads_email_only"
    : "direct_mail_email"
  // Fresh-stamp drip only for genuinely new clusters; re-engagements carry
  // the cluster's existing campaign forward without resetting the clock.
  const dripFields: Record<string, unknown> = !cluster
    ? {
        drip_campaign_type: freshDripCampaignType,
        drip_touch_number: 0,
        last_drip_sent_at: new Date().toISOString(),
      }
    : cluster.dripCampaignType
    ? { drip_campaign_type: cluster.dripCampaignType }
    : {}
  // Phase 7C-may8 Bug 5: mobile-home / lot-number flag.
  const isJunkAddr = isMobileHome(bodyText) || isMobileHome(subject)
  // Fake-lead detection — Google Ads + fresh leads only (see handleAppsScript).
  const spam =
    cluster || campaign.source_type !== "google_ads"
      ? null
      : scoreLeadSpam({ name, email: senderEmail, phone })
  const { data: inserted, error: insertErr } = await sb
    .from("leads")
    .insert({
      lead_type: "email",
      source_type: campaign.source_type,
      source: campaign.source,
      // See twilio_number explanation in handleAppsScript above — non-null
      // string with the receiving mailbox so isOutbound() returns false and
      // the email-reply route knows which mailbox to send from.
      twilio_number: `email:${emailAddress}`,
      caller_phone: phone,
      name,
      email: senderEmail,
      message: messageText,
      ai_notes: triage?.summary ?? null,
      suggested_reply: triage?.suggestedReply ?? null,
      status: triage?.is_dead ? "dead" : inheritedStatus,
      temperature: triage?.temperature ?? null,
      is_junk: isJunkAddr || undefined,
      // Suspected-fake review banner — {} when clean or a re-engagement.
      ...(spam ? spamReviewColumns(spam) : {}),
      // Persist the Gmail threadId so the Leads-tab card can pull the full
      // back-and-forth via /api/leads/sync-email when Ryan expands it. Falls
      // back to null when the message has no thread (rare — Gmail always
      // assigns one for inbound mail).
      gmail_thread_id: message.threadId || null,
      ...dripFields,
    })
    .select("id")
    .single()
  if (insertErr) {
    console.error(`[email] Insert failed for ${messageId}:`, insertErr)
    return
  }
  console.log(`[email] Inserted email lead ${inserted?.id} from ${senderEmail} (${campaign.source})`)

  // Re-engagement carried the cluster's drip stamp onto this new event
  // row — sweep so the engine sees one driver row.
  if (cluster?.dripCampaignType) {
    try {
      await dedupeClusterStamps(sb, {
        caller_phone: phone,
        email: senderEmail,
        gmail_thread_id: message.threadId || null,
      })
    } catch (e) {
      console.warn("[email] cluster dedupe failed:", e instanceof Error ? e.message : String(e))
    }
  }

  if (inserted?.id) {
    try {
      const { resolveCampaignId } = await import("@/lib/campaigns")
      const campaignId = await resolveCampaignId({ source: campaign.source, source_type: campaign.source_type, created_at: new Date() })
      if (campaignId) {
        await sb.from("leads").update({ campaign_id: campaignId }).eq("id", inserted.id)
      }
    } catch (e) {
      console.warn("[email] campaign attribution failed:", e instanceof Error ? e.message : String(e))
    }
  }

  const lines = [
    "📧 New email lead",
    `[${formatCampaignLabel(campaign.source)}]`,
    `👤 ${name || "(no name)"}`,
    `📧 ${senderEmail}`,
  ]
  if (phone) lines.push(`📞 ${formatPhoneForAlert(phone)}`)
  if (triage) {
    const tempLabel = triage.is_dead ? "DEAD" : triage.temperature.toUpperCase()
    lines.push(`🤖 AI: <b>${tempLabel}</b> — ${escapeHtml(triage.summary)}`)
  }
  // Append the fake-lead warning to the alert — no-op when clean.
  if (spam) lines.push(...spamAlertLines(spam))
  await sendTelegramAlert(lines.join("\n"))
}

// ─── Gmail helpers (lib/leads.ts owns the JWT client; helpers here stay
// local because they're only used by the inbound-message processing path)

// List inbox messages received within the last hour, newest first. We can't
// use Gmail's `history.list` keyed by the Pub/Sub-supplied historyId — that
// API returns events strictly *after* startHistoryId, but the notification's
// historyId is already the post-event watermark, so it always returns 0
// (verified in production). Scanning recent inbox messages every notification
// is stateless and cheap; processSingleMessage's per-sender dedup handles the
// re-delivery case.
async function fetchRecentInboxMessageIds(
  gmail: gmail_v1.Gmail
): Promise<string[]> {
  try {
    const { data } = await gmail.users.messages.list({
      userId: "me",
      q: "in:inbox newer_than:1h",
      maxResults: 25,
    })
    return (data.messages || []).map((m) => m.id || "").filter(Boolean)
  } catch (e) {
    console.error(`[email] messages.list failed:`, e)
    return []
  }
}

function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string
): string {
  if (!headers) return ""
  const lower = name.toLowerCase()
  for (const h of headers) {
    if ((h.name || "").toLowerCase() === lower) return h.value || ""
  }
  return ""
}

// Best-effort: pull a name out of the email body when the From header has
// no display name (bare email like "pat@gmail.com" → null). Tries a few
// natural-language patterns customers actually use ("my name is X",
// "I'm X", "this is X"). Strict title-case + 1–3 words to avoid grabbing
// random fragments. Returns null if nothing fits — caller falls back to
// whatever parseFromHeader produced (which may also be null).
function extractNameFromBody(text: string): string | null {
  if (!text) return null
  // Prefix is case-tolerant ([Mm]y, [Tt]his) so we catch transcripts that
  // capitalize the start of a sentence; capture is strict title-case so we
  // don't grab "Chris Bola my number" or "Pat smith and". Trailing
  // (?=\W|$) anchors to a word boundary, preventing greedy {0,2} from
  // overrunning into the next clause.
  const patterns = [
    /\b[Mm]y name is ([A-Z][a-z]+(?: [A-Z][a-z]+){0,2})(?=\W|$)/,
    /\bI(?:'m| am) ([A-Z][a-z]+(?: [A-Z][a-z]+){0,2})(?=\W|$)/,
    /\b[Tt]his is ([A-Z][a-z]+(?: [A-Z][a-z]+){0,2})(?=\W|$)/,
  ]
  for (const re of patterns) {
    const m = re.exec(text)
    if (m && m[1]) return m[1].trim()
  }
  return null
}

// Recognize bounce notifications (mailer-daemon, postmaster DSNs, "Undelivered
// Mail Returned to Sender") so we don't insert a lead for our own failed
// outbound send. Sender-address check catches the standard Gmail/Workspace
// envelope; the subject patterns are the belt-and-suspenders for forwarders
// that rewrite the From header.
function isBounceEmail(senderEmail: string, subject: string): boolean {
  const addr = senderEmail.toLowerCase()
  if (/^(mailer-daemon|postmaster|noreply-dsn|bounce(s|d)?)@/.test(addr)) return true
  const sub = subject.toLowerCase()
  return (
    sub.includes("delivery status notification") ||
    sub.includes("undelivered mail returned") ||
    sub.includes("undeliverable") ||
    sub.includes("mail delivery failed") ||
    sub.includes("returned mail") ||
    sub.startsWith("failure notice")
  )
}

// True when the sender is one of our own Workspace mailboxes. The exact
// receiving-mailbox check (senderEmail === emailAddress) only caught replies
// sent from the *same* inbox that received them; it missed the common case of
// Ryan replying to a lead from a *different* LRG mailbox (e.g. answering a
// ryansvj@ thread from info@ or ryan@). Those self-sends were ingested as
// brand-new inbound leads named after the From display name ("Info Info").
// Matching the whole lrghomes.com domain covers every campaign mailbox plus
// info@/ryan@ and any future internal address. The reply still lives in the
// Gmail thread and surfaces in the Leads-tab card via /api/leads/sync-email,
// so skipping ingestion loses nothing.
function isOwnAddress(addr: string): boolean {
  return addr.toLowerCase().endsWith("@lrghomes.com")
}

function parseFromHeader(value: string): { name: string | null; email: string | null } {
  if (!value) return { name: null, email: null }
  const m = value.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/)
  if (m) {
    const name = m[1].trim() || null
    const email = m[2].trim().toLowerCase() || null
    return { name, email }
  }
  const bare = value.trim().toLowerCase()
  if (/^[^\s@]+@[^\s@]+$/.test(bare)) return { name: null, email: bare }
  return { name: null, email: null }
}

function extractPlainBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return ""
  const plain = findPart(payload, "text/plain")
  if (plain) return stripQuoted(decodePart(plain))
  const html = findPart(payload, "text/html")
  if (html) return stripQuoted(stripHtml(decodePart(html)))
  if (payload.body?.data) return stripQuoted(decodeBase64Url(payload.body.data))
  return ""
}

function findPart(
  part: gmail_v1.Schema$MessagePart,
  mime: string
): gmail_v1.Schema$MessagePart | null {
  if (part.mimeType === mime && part.body?.data) return part
  if (part.parts) {
    for (const child of part.parts) {
      const found = findPart(child, mime)
      if (found) return found
    }
  }
  return null
}

function decodePart(part: gmail_v1.Schema$MessagePart): string {
  if (!part.body?.data) return ""
  return decodeBase64Url(part.body.data)
}

function decodeBase64Url(data: string): string {
  try {
    const normalized = data.replace(/-/g, "+").replace(/_/g, "/")
    return Buffer.from(normalized, "base64").toString("utf-8")
  } catch {
    return ""
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim()
}

// Drop replied-to history so the AI sees only the new content.
function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  for (const line of lines) {
    if (/^On .+ wrote:\s*$/i.test(line.trim())) break
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(line.trim())) break
    if (line.trim().startsWith(">")) continue
    out.push(line)
  }
  return out.join("\n").trim()
}

// LRG's own numbers (last-10-digit form): the Twilio campaign numbers, the
// outbound caller-ID line, the forward-to cell. A direct-mail reply email
// routinely quotes the original mailer — which prints Ryan's callback number
// — so the naive "first 10 digits wins" grabbed Ryan's number and merged the
// lead onto the wrong cluster. Skip any match that is one of these.
const LRG_OWN_NUMBERS = new Set(
  [...Object.keys(CAMPAIGN_MAP), FORWARD_TO].map((n) => n.replace(/\D/g, "").slice(-10))
)

function extractPhoneFromText(text: string): string | null {
  if (!text) return null
  const re = /(?:\+?1[\s.\-]*)?\(?(\d{3})\)?[\s.\-]*(\d{3})[\s.\-]*(\d{4})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const digits = `${m[1]}${m[2]}${m[3]}`
    if (LRG_OWN_NUMBERS.has(digits)) continue // skip Ryan's / Twilio's own numbers
    return digits
  }
  return null
}

function formatPhoneForAlert(input: string): string {
  // Accepts either bare 10 digits or E.164 (+1XXXXXXXXXX). Strip non-digits
  // and take the last 10 to render as "(XXX) XXX-XXXX". Returns input as-is
  // if we can't get a clean 10-digit US number.
  const digits = input.replace(/\D/g, "")
  const last10 = digits.length > 10 ? digits.slice(-10) : digits
  if (last10.length !== 10) return input
  return `(${last10.slice(0, 3)}) ${last10.slice(3, 6)}-${last10.slice(6)}`
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"))
}

// Telegram alert label — pretty up the bare campaign code so the message
// reads "[Campaign A]" rather than "[MFM-A]".
function formatCampaignLabel(source: string): string {
  if (source === "MFM-A") return "Campaign A"
  if (source === "MFM-B") return "Campaign B"
  return source
}
