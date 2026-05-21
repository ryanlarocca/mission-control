import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { google, gmail_v1 } from "googleapis"
import emailCampaigns from "@/config/email-campaigns.json"
import { isAnonymousCaller } from "./anonymous"

export const CAMPAIGN_MAP: Record<string, string> = {
  "+16504364279": "MFM-A",
  "+16506803671": "MFM-B",
  // Outbound caller-ID number used by /api/leads/call. Listed here so that
  // when a lead dials it back (or texts it), the voice/sms webhooks resolve
  // a campaign label and don't mis-bucket the row as "Unknown". Twilio
  // console must point this number's Voice + Messaging webhooks at
  // /api/leads/voice and /api/leads/sms.
  "+16502043247": "Outbound",
  // Google Ads landing-page number. Inbound voice + SMS get tagged
  // source_type=google_ads and routed to the google_ads_form drip (see
  // voice/sms route handlers).
  "+16506703914": "Google",
}

// Inbound calls/SMS to this number are almost always a lead returning Ryan's
// outreach, not a fresh intake. The voice + sms webhooks dedup against the
// existing lead group instead of starting a new drip cycle.
export const OUTBOUND_TWILIO_NUMBER = "+16502043247"

// Google Ads landing-page inbound number — drives source_type=google_ads
// and the google_ads_form drip path in the voice/sms webhooks.
export const GOOGLE_ADS_LANDING_NUMBER = "+16506703914"

// Phase 7C-may8 Bug 6: explicit STOP keywords flag the lead DNC and kill the
// drip. Match either an exact keyword (single-word "stop") or a substring
// for multi-word phrases. Lowercase the input and trim before comparing.
export const DNC_KEYWORDS = [
  "stop",
  "unsubscribe",
  "do not contact",
  "remove me",
  "opt out",
] as const

export function isDncMessage(text: string | null | undefined): boolean {
  if (!text) return false
  const normalized = text.toLowerCase().trim()
  if (!normalized) return false
  return DNC_KEYWORDS.some((kw) => normalized === kw || normalized.includes(kw))
}

// Phase 7C-may8 Bug 5: mobile-home / lot detection. Direct mail and Google
// Ads pull in addresses like "123 Main St Lot 191" — those are mobile homes
// in a park, not deals Ryan wants. Match "lot" followed by digits anywhere
// in the address or message body.
export function isMobileHome(text: string | null | undefined): boolean {
  if (!text) return false
  return /\blot\s+\d+/i.test(text)
}

// Mailers also list one email address per campaign that route through
// Gmail Push → Pub/Sub → /api/leads/email and land in the same `leads`
// table as their phone-number siblings. Source of truth lives in
// config/email-campaigns.json; both the watch-setup and watch-renewal
// scripts read the same file. To add a mailbox, run:
//   node scripts/add-email-mailbox.mjs <email> <campaign-label>
//
// Email mailboxes share campaign labels with their phone-number siblings
// (e.g. ryansvg@lrghomes.com → MFM-A, same bucket as +16504364279) so a
// customer who calls *and* emails surfaces under one unified campaign in
// reporting.
export interface EmailCampaign {
  source: string
  source_type: string
}

const UNKNOWN_EMAIL_CAMPAIGN: EmailCampaign = { source: "Unknown", source_type: "direct_mail" }

export const EMAIL_CAMPAIGN_MAP: Record<string, EmailCampaign> =
  emailCampaigns as Record<string, EmailCampaign>

export function getEmailCampaign(emailAddress: string | null | undefined): EmailCampaign {
  if (!emailAddress) return UNKNOWN_EMAIL_CAMPAIGN
  return EMAIL_CAMPAIGN_MAP[emailAddress.toLowerCase()] || UNKNOWN_EMAIL_CAMPAIGN
}

export function getEmailCampaignSource(emailAddress: string | null | undefined): string {
  return getEmailCampaign(emailAddress).source
}

// Reverse lookup: source label → owning mailbox email. Used by the
// /api/leads/sync-email proxy to know which mailbox the gog CLI should
// impersonate when pulling a Gmail thread (the thread record only exists
// in the inbox where the email landed).
export function getMailboxForSource(source: string | null | undefined): string | null {
  if (!source) return null
  for (const [mailbox, campaign] of Object.entries(EMAIL_CAMPAIGN_MAP)) {
    if (campaign.source === source) return mailbox
  }
  return null
}

// RFC 2047 encoded-word for an email header value. Email headers must be
// 7-bit ASCII — a raw UTF-8 character (em-dash, curly quote) dropped straight
// into a `Subject:` line renders as mojibake ("Ã¢Â€Â"") in the recipient's
// client. Plain-ASCII values pass through untouched so the wire stays
// human-readable for the common case. Used by every buildRawEmail().
export function encodeEmailHeader(value: string): string {
  if (/^[\x00-\x7F]*$/.test(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`
}

// Build a Gmail API client that impersonates the given mailbox owner via
// Google Workspace domain-wide delegation. DWD on the lrghomes.com tenant is
// authorized for gmail.modify only — gmail.readonly returns 401
// `unauthorized_client`, gmail.send is also unauthorized. gmail.modify
// includes the read AND send perms we need (see Phase 7.4 in the CRMS memo).
// Used by both /api/leads/email (for inbound thread fetch) and
// /api/leads/email-reply (for outbound send).
export function getGmailClient(userEmail: string): gmail_v1.Gmail {
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!key) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set")
  const credentials = JSON.parse(key)
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    subject: userEmail,
  })
  return google.gmail({ version: "v1", auth })
}

// Normalize a free-form phone string to E.164. Inputs like "(555) 123-4567",
// "555.123.4567", "5551234567", "+1 555-123-4567", and "1 555 123 4567" all
// produce "+15551234567". 11-digit non-1 country codes pass through with a
// "+" prefix. Anything we can't normalize is returned trimmed so the caller
// can log/raise rather than silently overwriting with junk.
export function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return ""
  const digits = String(raw).replace(/\D/g, "")
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`
  if (digits.length >= 10 && digits.length <= 15) return `+${digits}`
  return String(raw).trim()
}

// Blocked / withheld caller-ID detection lives in lib/anonymous.ts (a
// dependency-free module — this file pulls in googleapis and can't be
// bundled client-side). Imported for internal use here + re-exported so
// existing `@/lib/leads` importers keep working.
export { isAnonymousCaller }

export const FORWARD_TO = "+14085006293"

// Outbound Twilio number used as caller ID for click-to-call relays
// (`/api/leads/call` + `/api/leads/call/bridge`). Throws on missing so a
// misconfigured env doesn't silently fall back and surprise the lead.
export function getTwilioNumber(): string {
  // Defensive trim — `echo "..." | vercel env add` ships a trailing newline
  // which then ends up inside `callerId="…"` in TwiML and breaks Twilio.
  const n = process.env.TWILIO_NUMBER?.trim()
  if (!n) throw new Error("TWILIO_NUMBER must be set")
  return n
}

export type LeadType =
  | "call"
  | "voicemail"
  | "sms"
  | "form"
  | "email"
  // Phase 7B: drip-engine-generated outbound rows. The lead_type prefix
  // makes them easy to filter out of activity checks ("did Ryan reply
  // since the last drip?") and to badge separately in the timeline.
  | "drip_imessage"
  | "drip_email"

// Phase 7D lifecycle. Statuses are mutually exclusive stages in the funnel
// that Ryan moves a lead through manually. Temperature (hot/warm/cold) lives
// in its own `temperature` column and is AI-driven — Ryan never clicks it.
// DNC / Junk / Bad-Number remain orthogonal boolean flags.
// Phase 7C's transitional values (hot/warm as statuses) were remapped by
// phase7d-lifecycle-temperature.sql: hot/warm→active+temperature. The
// "nurture" value is manual-only — Ryan parks long-term follow-ups here so
// they leave the New/Contacted/Active filters without going Dead.
export type LeadStatus =
  | "new"
  | "contacted"
  | "active"
  | "nurture"
  | "dead"

// Phase 7D — AI-driven temperature column. Drives the read-only emoji badge
// on the lead card and the Temperature filter chip in the Leads tab. Never
// touched by the lifecycle dropdown; only `analyzeCallTranscript` /
// `applyAnalyzeCallResult` write to it.
export type Temperature = "hot" | "warm" | "cold"

export const VALID_TEMPERATURES: readonly Temperature[] = ["hot", "warm", "cold"] as const

export const TEMPERATURE_BADGE: Record<Temperature, { emoji: string; label: string }> = {
  hot:  { emoji: "🔥", label: "Hot" },
  warm: { emoji: "☀️", label: "Warm" },
  cold: { emoji: "❄️", label: "Cold" },
}

// Single source of truth for the hot/warm/cold rubric. Embedded verbatim in
// every prompt that classifies temperature (analyzeCallTranscript +
// triageEmailLead) so the three code paths can't drift apart — drift was the
// root cause of the "temperature is inconsistent" complaint. The rubric
// grades CURRENT engagement & deal viability, not just the seller's stated
// timeline: a real lead with no urgency is `cold` (still drip + nurture), not
// blank. Ryan owns the lifecycle "dead" status manually — the AI never picks it.
export const TEMPERATURE_RUBRIC = `Classify the lead's CURRENT engagement and deal viability — not just their stated timeline. Pick exactly one:

  hot  — Ready to TRANSACT now. Any of: asked Ryan for an offer / price quote,
         wants to sell within ~2 months, is actively negotiating (counter-
         offering, comparing Ryan's number to another), or stated explicit
         urgency. Warrants a call this week.
  warm — Active engagement OPENING A CONVERSATION, without (yet) asking to
         transact. Examples: responded to outreach by leaving a voicemail
         asking for a callback to discuss, confirmed which property they own
         + provided callback numbers, routed Ryan to their agent for details,
         asked clarifying questions about Ryan's process — anything that
         signals "I'm engaged, but I haven't asked for an offer yet."
         A simple "call me back" voicemail with property context IS warm —
         not hot (no offer requested) and not cold (real engagement). 3-6
         month timelines also land here. Worth periodic personal touches.
  cold — A real lead, but no urgency AND no active engagement right now. No
         timeline, "maybe someday", a vague or near-empty voicemail with no
         property context, or a price gap that stalled with no movement.
         Still gets the automated drip + a long-cycle follow-up — just not a
         priority call.

NEVER leave temperature blank. A price disagreement, a one-word voicemail, and
even an explicit "no / don't call me" all classify as cold — Ryan owns the
"dead" lifecycle status manually.`

// Conventions (no extra columns — keeps schema simple):
//   - `message` holds the text content of the event regardless of type:
//       SMS rows       → the SMS body (inbound or outbound)
//       voicemail rows → the Whisper transcription (also live-call recordings)
//       call rows      → null until the recording callback attaches transcript
//   - `twilio_number IS NULL` means the row is outbound. All inbound rows
//     have twilio_number set: a real Twilio number for SMS/voice/voicemail,
//     or `"email:<receiving-mailbox>"` for inbound email leads (e.g.
//     `"email:ryansvg@lrghomes.com"`). The "email:" prefix is non-null so
//     isOutbound() returns false, AND it tells /api/leads/email-reply
//     which mailbox to send the reply from without an extra lookup.
//   - `source_type` is the high-level bucket ('direct_mail' | 'google_ads')
//     while `source` is the specific campaign ('MFM-A', 'MFM-B', 'Google Ads').
export interface Lead {
  id: string
  created_at: string
  source: string | null
  source_type: string | null
  twilio_number: string | null
  caller_phone: string | null
  lead_type: LeadType | null
  message: string | null
  recording_url: string | null
  status: LeadStatus
  notes: string | null
  ai_notes: string | null
  name: string | null
  email: string | null
  property_address: string | null
  suggested_reply: string | null
  // Phase 7B: drip-tracking columns. Null on legacy rows that pre-date the
  // drip engine; the engine's eligible-lead query filters those out via
  // `drip_campaign_type IS NOT NULL`.
  drip_campaign_type?: string | null
  drip_touch_number?: number | null
  last_drip_sent_at?: string | null
  // Phase 7C flags + intelligence columns.
  is_dnc?: boolean | null
  is_junk?: boolean | null
  is_bad_number?: boolean | null
  ai_summary?: string | null
  ai_summary_generated_at?: string | null
  recommended_followup_date?: string | null
  followup_reason?: string | null
  followup_generated_at?: string | null
  suggested_status?: LeadStatus | null
  suggested_status_reason?: string | null
  campaign_label?: string | null
  // Phase 7D — AI-driven temperature, separate axis from lifecycle status.
  temperature?: Temperature | null
}

// Lifecycle statuses — must match the lib/leads.ts LeadStatus union.
export const VALID_LEAD_STATUSES: readonly LeadStatus[] = [
  "new",
  "contacted",
  "active",
  "nurture",
  "dead",
] as const

// Boolean flags on a lead. Used by the API PATCH route to whitelist
// allowed body fields and by the UI to drive badges + button visibility.
export const LEAD_FLAG_FIELDS = ["is_dnc", "is_junk", "is_bad_number"] as const
export type LeadFlagField = typeof LEAD_FLAG_FIELDS[number]

// Cluster-key derivation. ONE function in the codebase — used by the
// drips API (forecast cluster dedupe), campaigns/performance API
// (siblings + offer hoist), and the dedupeClusterStamps helper. Returns
// null when no real identifier exists; callers that need a guaranteed
// non-null bucket key (e.g. dedupe walks where each row needs a slot)
// can use clusterKeyOrId.
//
// "Anonymous" caller_phone is NOT a real key — every withheld-ID call
// shares the same placeholder, so treating it as a cluster identity
// would merge unrelated people. Fall through to thread/email/null.
//
// Email is lowercased so case variants don't fork the cluster.
export type ClusterIdentity = {
  caller_phone: string | null
  email: string | null
  gmail_thread_id?: string | null
}
export function clusterKey(r: ClusterIdentity): string | null {
  if (r.caller_phone && r.caller_phone !== "Anonymous") return `phone:${r.caller_phone}`
  if (r.gmail_thread_id) return `thread:${r.gmail_thread_id}`
  if (r.email) return `email:${r.email.toLowerCase()}`
  return null
}
export function clusterKeyOrId(r: ClusterIdentity & { id: string }): string {
  return clusterKey(r) ?? `id:${r.id}`
}

// Standalone offer-detection helper. Used by outbound send paths
// (send-email, send SMS/iMessage) to capture offers Ryan verbalizes in
// outgoing messages. Same prompt rules as analyzeCallTranscript's offer
// block: Ryan's price TO the seller, not the seller's asking price.
// Caller is responsible for applying the hands-off write-back rule
// (only stamp when current offer_amount is null).
export interface OfferDetectionResult {
  offer_amount: number | null
  offer_verbalized: boolean
}
export async function detectOfferFromText(
  text: string,
  ctx?: { channel?: "email" | "sms" | "imessage"; lead_name?: string | null; property?: string | null }
): Promise<OfferDetectionResult | null> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) return null
  const trimmed = (text || "").trim()
  if (trimmed.length < 10) return null
  // Cheap regex pre-filter — bail if there's no $-amount + Ryan-cue at all.
  // Saves a Haiku call on routine "thanks for the info" / "calling you back"
  // type messages.
  const hasMoney = /\$\s*[\d,]+(?:\.\d+)?\s*[kKmM]?|\b\d+(?:\.\d+)?\s*(?:million|thousand|[kKmM])\b|\b\d{3},\d{3}\b/.test(trimmed)
  if (!hasMoney) return { offer_amount: null, offer_verbalized: false }
  const channel = ctx?.channel ?? "email"
  const prompt = `You are reading an outgoing ${channel} from Ryan (a cash home buyer / investor in the Bay Area) to a real estate seller lead${ctx?.lead_name ? ` named ${ctx.lead_name}` : ""}${ctx?.property ? ` regarding ${ctx.property}` : ""}. Your job is to decide whether Ryan stated a specific purchase-price offer in this message, and if so capture the amount.

CRITICAL: this is RYAN'S price TO the seller. NOT a market reference / comp / asking price the seller mentioned previously.

Return JSON only:
{
  "offer_amount": number | null,
  "offer_verbalized": true | false
}

RULES:
- offer_verbalized=true ONLY when Ryan states a specific dollar amount he would pay / offer / do for THIS lead's property in THIS message.
- Soft / conditional offers count: "I could probably do around $700K" → 700000.
- Ranges → take the midpoint, round to nearest 1k: "$700-750K" → 725000.
- Discussion of OTHER market activity, comps, or seller's prior asking price does NOT count.
- When in doubt, return false. False positives lose campaign-performance signal.

OUTGOING MESSAGE:
"""
${trimmed}
"""

Respond with ONLY the JSON object.`
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/claude-haiku-4-5",
        max_tokens: 80,
        messages: [{ role: "user", content: prompt }],
      }),
    })
    if (!res.ok) {
      console.warn(`[detect-offer] Haiku ${res.status}`)
      return null
    }
    const j = await res.json() as { choices?: { message?: { content?: string } }[] }
    const content = j.choices?.[0]?.message?.content?.trim() || ""
    const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim()
    const parsed = JSON.parse(cleaned) as { offer_amount?: unknown; offer_verbalized?: unknown }
    return {
      offer_amount: typeof parsed.offer_amount === "number" && Number.isFinite(parsed.offer_amount) && parsed.offer_amount > 0
        ? parsed.offer_amount : null,
      offer_verbalized: parsed.offer_verbalized === true,
    }
  } catch (e) {
    console.warn("[detect-offer] threw:", e instanceof Error ? e.message : String(e))
    return null
  }
}

// Apply a detected offer to a lead row's cluster, honoring the hands-off
// rule: only stamps offer_amount + offer_verbalized_at when the row's
// current values are both null. Stamps timestamp = now() (live action).
// Returns true if a write happened.
export async function applyDetectedOfferToCluster(
  sb: SupabaseClient,
  args: { leadId: string; caller_phone: string | null; email: string | null; gmail_thread_id?: string | null; offer_amount: number }
): Promise<boolean> {
  // Check every row in the cluster — if ANY of them already has an offer
  // stamped, do nothing (Ryan's earlier pencil edit or a prior analyzer
  // pass wins).
  const orParts: string[] = []
  if (args.caller_phone) orParts.push(`caller_phone.eq.${args.caller_phone}`)
  if (args.email) orParts.push(`email.eq.${args.email}`)
  if (args.gmail_thread_id) orParts.push(`gmail_thread_id.eq.${args.gmail_thread_id}`)
  if (orParts.length === 0) {
    // Fallback: stamp directly on the lead row only.
    const { data: cur } = await sb.from("leads").select("offer_amount").eq("id", args.leadId).single()
    if (cur?.offer_amount != null) return false
    const now = new Date().toISOString()
    const { error } = await sb.from("leads").update({ offer_amount: args.offer_amount, offer_verbalized_at: now }).eq("id", args.leadId)
    return !error
  }
  const { data: cluster } = await sb.from("leads").select("id, offer_amount").or(orParts.join(","))
  const existing = (cluster ?? []).find(r => r.offer_amount != null)
  if (existing) return false
  // Stamp on the leadId provided (typically the just-inserted outbound row).
  const now = new Date().toISOString()
  const { error } = await sb.from("leads").update({ offer_amount: args.offer_amount, offer_verbalized_at: now }).eq("id", args.leadId)
  return !error
}

// Pick the cluster's authoritative drip-driver row out of N stamped
// candidates. The decision is two-stage so a user-applied campaign
// change (e.g. Long-Term Nurture on a cluster previously running
// direct_mail_call) wins over a sibling with higher touch progress on
// the old campaign:
//   1. Group rows by drip_campaign_type. For each campaign group, find
//      the most-recent action time (max last_drip_sent_at, falling back
//      to created_at when the engine never touched the row). The campaign
//      with the latest action represents the most recent intent.
//   2. Inside the winning campaign group, pick the best row by:
//      engine-touched > highest drip_touch_number > most-recent
//      last_drip_sent_at > most-recent created_at.
// Exported for tests + the engine's defense-in-depth dedupe path (which
// duplicates the same logic in plain JS — the engine runs without TS).
type ClusterRow = {
  id: string
  drip_campaign_type: string | null
  drip_touch_number: number | null
  last_drip_sent_at: string | null
  created_at: string
}
export function pickClusterWinner<T extends ClusterRow>(rows: T[]): T {
  if (rows.length === 1) return rows[0]
  const byCampaign = new Map<string, T[]>()
  for (const r of rows) {
    const k = r.drip_campaign_type || "__null__"
    if (!byCampaign.has(k)) byCampaign.set(k, [])
    byCampaign.get(k)!.push(r)
  }
  let winningCampaign = rows[0].drip_campaign_type ?? "__null__"
  let bestActionTs = -Infinity
  byCampaign.forEach((crows, campaign) => {
    const maxTs = Math.max(...crows.map(r =>
      r.last_drip_sent_at ? new Date(r.last_drip_sent_at).getTime() : new Date(r.created_at).getTime()
    ))
    if (maxTs > bestActionTs) { bestActionTs = maxTs; winningCampaign = campaign }
  })
  const pool = byCampaign.get(winningCampaign)!
  return [...pool].sort((a, b) => {
    const aT = a.last_drip_sent_at != null
    const bT = b.last_drip_sent_at != null
    if (aT !== bT) return bT ? 1 : -1
    const aN = a.drip_touch_number ?? 0
    const bN = b.drip_touch_number ?? 0
    if (aN !== bN) return bN - aN
    const aL = a.last_drip_sent_at ? new Date(a.last_drip_sent_at).getTime() : 0
    const bL = b.last_drip_sent_at ? new Date(b.last_drip_sent_at).getTime() : 0
    if (aL !== bL) return bL - aL
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })[0]
}

// Cluster-stamp deduplication. The CRMS drip engine processes leads by
// scanning every row where `drip_campaign_type IS NOT NULL`, so a cluster
// (same phone / email / thread) with N stamped rows generates N parallel
// touches. Brian Bernasconi 2026-05-17 was the canonical case: 3 voicemail
// rows on +14089791400 all stamped direct_mail_call → 3 pending drips in
// the queue every cadence step.
//
// `dedupeClusterStamps` picks the canonical "active driver" row for a
// cluster and un-stamps every other stamped row. Used by the apply-drip /
// long-term-nurture endpoints (after stamping, sweep siblings), the
// engine's eligibility scan (defense-in-depth), and the one-shot
// backfill (`scripts/backfill-dedupe-cluster-stamps-2026-05-17.mjs`).
//
// Winner selection: among the cluster's stamped rows,
//   1. prefer rows the engine has actually touched (last_drip_sent_at IS NOT NULL)
//   2. within those, the highest drip_touch_number
//   3. tiebreak: most-recent last_drip_sent_at
//   4. then most-recent created_at
// EXCEPT when `preferredId` is passed — that row is forced to win regardless,
// which is what `apply-drip` and `long-term-nurture` use to make a user's
// just-applied campaign stamp authoritative even if cluster siblings have
// higher touch progress on a different campaign.
export async function dedupeClusterStamps(
  sb: SupabaseClient,
  clusterIdentity: { caller_phone?: string | null; email?: string | null; gmail_thread_id?: string | null },
  options: { preferredId?: string; dryRun?: boolean } = {}
): Promise<{ kept: string | null; unstamped: string[]; skipped: boolean }> {
  const { preferredId, dryRun } = options
  const { caller_phone, email, gmail_thread_id } = clusterIdentity

  // Find every stamped row in the cluster. We OR phone+email+thread so we
  // catch the case where a single physical person has rows that share
  // some-but-not-all identifiers (e.g. a phone row + an email-only row
  // with the same email).
  const orParts: string[] = []
  if (caller_phone) orParts.push(`caller_phone.eq.${caller_phone}`)
  if (email) orParts.push(`email.eq.${email}`)
  if (gmail_thread_id) orParts.push(`gmail_thread_id.eq.${gmail_thread_id}`)
  if (orParts.length === 0) return { kept: null, unstamped: [], skipped: true }

  const { data: rows, error } = await sb
    .from("leads")
    .select("id, drip_campaign_type, drip_touch_number, last_drip_sent_at, created_at")
    .or(orParts.join(","))
    .not("drip_campaign_type", "is", null)
  if (error) {
    console.error("[dedupe-cluster] lookup failed:", error.message)
    return { kept: null, unstamped: [], skipped: true }
  }
  if (!rows || rows.length <= 1) {
    // 0 or 1 stamped rows — nothing to dedupe.
    return { kept: rows?.[0]?.id ?? null, unstamped: [], skipped: true }
  }

  let winner: typeof rows[0]
  if (preferredId && rows.some(r => r.id === preferredId)) {
    winner = rows.find(r => r.id === preferredId)!
  } else {
    winner = pickClusterWinner(rows)
  }

  const losers = rows.filter(r => r.id !== winner.id)
  if (losers.length === 0) return { kept: winner.id, unstamped: [], skipped: true }

  if (dryRun) return { kept: winner.id, unstamped: losers.map(r => r.id), skipped: false }

  // Un-stamp the losers fully — drip_campaign_type AND drip_touch_number
  // AND last_drip_sent_at all cleared. Leaves the row's lead history
  // (lead_type, message, recording_url, ai_summary, ...) untouched.
  const { error: updErr } = await sb
    .from("leads")
    .update({ drip_campaign_type: null, drip_touch_number: null, last_drip_sent_at: null })
    .in("id", losers.map(r => r.id))
  if (updErr) {
    console.error("[dedupe-cluster] unstamp failed:", updErr.message)
    return { kept: winner.id, unstamped: [], skipped: true }
  }
  return { kept: winner.id, unstamped: losers.map(r => r.id), skipped: false }
}

// Halt all in-flight outreach for the cluster a lead belongs to. Fired when
// a lead gets junked or DNC'd — we have to sweep BOTH the Drips tab queue
// (pending/approved rows that were generated before the flag was set) and
// the Follow-Ups tab (any `recommended_followup_date` on cluster rows).
// Walks the cluster via caller_phone/email so siblings stamped with their
// own drip_campaign_type are caught too. Skips drip rows instead of
// deleting them so the audit trail survives.
//
// Idempotent / no-op when nothing to clean up. Designed to be called from
// any handler that flips is_junk or is_dnc to true on a lead row.
export async function haltOutreachForCluster(
  sb: SupabaseClient,
  flaggedLead: { id: string; caller_phone: string | null; email: string | null; is_dnc?: boolean | null; is_junk?: boolean | null; status?: string | null },
): Promise<{ skippedDrips: number; clearedFollowups: number }> {
  const reason = flaggedLead.is_dnc
    ? "lead_marked_dnc"
    : flaggedLead.is_junk
    ? "lead_marked_junk"
    : flaggedLead.status === "dead"
    ? "lead_marked_dead"
    : "lead_marked_junk"

  // Find every leads-table row in the cluster (same phone OR same email).
  // Falls back to just the flagged row if neither identifier is set.
  const orParts: string[] = []
  if (flaggedLead.caller_phone) orParts.push(`caller_phone.eq.${flaggedLead.caller_phone}`)
  if (flaggedLead.email) orParts.push(`email.eq.${flaggedLead.email}`)
  let clusterIds: string[]
  if (orParts.length > 0) {
    const { data: siblings } = await sb.from("leads").select("id").or(orParts.join(","))
    clusterIds = (siblings ?? []).map((r) => r.id as string)
    if (!clusterIds.includes(flaggedLead.id)) clusterIds.push(flaggedLead.id)
  } else {
    clusterIds = [flaggedLead.id]
  }

  // (1) Skip any pending/approved drip_queue rows for the cluster.
  const { data: killed, error: dqErr } = await sb
    .from("drip_queue")
    .update({ status: "skipped", error: reason })
    .in("lead_id", clusterIds)
    .in("status", ["pending", "approved"])
    .select("id")
  if (dqErr) console.warn(`[halt-outreach] drip_queue sweep failed:`, dqErr.message)
  const skippedDrips = (killed ?? []).length
  if (skippedDrips > 0) console.log(`[halt-outreach] skipped ${skippedDrips} drip_queue row(s) for cluster of ${flaggedLead.id} (${reason})`)

  // (2) Clear recommended_followup_date so the Follow-Ups tab drops the row.
  // Also clear followup_reason so a future un-junk doesn't leave stale text.
  const { data: cleared, error: fuErr } = await sb
    .from("leads")
    .update({ recommended_followup_date: null, followup_reason: null })
    .in("id", clusterIds)
    .not("recommended_followup_date", "is", null)
    .select("id")
  if (fuErr) console.warn(`[halt-outreach] follow-up clear failed:`, fuErr.message)
  const clearedFollowups = (cleared ?? []).length
  if (clearedFollowups > 0) console.log(`[halt-outreach] cleared follow-up on ${clearedFollowups} cluster row(s) of ${flaggedLead.id} (${reason})`)

  return { skippedDrips, clearedFollowups }
}

// A manual outreach — a completed follow-up call, a hand-sent email or text —
// counts as a drip touch. The drip campaign is a fixed sequence of touches on
// a cadence; when Ryan reaches out himself, that manual outreach stands in for
// the drip touch that was next, so the cadence picks up at the touch AFTER it.
// Without this a stale `last_drip_sent_at` makes the next drip forecast
// immediately overdue and the contact stays pinned to the top of the Follow
// Ups worklist the moment Ryan finishes with them.
//
// For every drip-stamped row in the contact's cluster this:
//   (1) restarts the cadence clock (last_drip_sent_at = now), so the next
//       touch is a full interval out from this manual touch; and
//   (2) consumes the touch that was about to fire —
//         · a pending/approved drip_queue row is skipped (its touch number
//           was already advanced when the engine queued it), or
//         · a pure forecast advances drip_touch_number by one.
// Either way the net effect is the same: the next drip is the one after
// whatever the manual outreach replaced. This generalises the existing Skip
// behaviour (drip-queue Skip for a queued touch, forecast-skip for a
// forecast) so it fires automatically on Done / Email / Text.
export async function registerManualTouch(
  sb: SupabaseClient,
  lead: { id: string; caller_phone: string | null; email: string | null },
): Promise<{ clockReset: number; advanced: number; skippedDrips: number }> {
  // Resolve the cluster — same phone OR same email — so the reset lands on
  // whichever sibling row actually carries the drip campaign.
  const orParts: string[] = []
  if (lead.caller_phone) orParts.push(`caller_phone.eq.${lead.caller_phone}`)
  if (lead.email) orParts.push(`email.eq.${lead.email}`)
  let clusterIds: string[]
  if (orParts.length > 0) {
    const { data: siblings } = await sb.from("leads").select("id").or(orParts.join(","))
    clusterIds = (siblings ?? []).map((r) => r.id as string)
    if (!clusterIds.includes(lead.id)) clusterIds.push(lead.id)
  } else {
    clusterIds = [lead.id]
  }

  const touchAt = new Date().toISOString()

  // Skip any live drip_queue rows — the manual touch supersedes them — and
  // note which leads had one: those already had drip_touch_number advanced
  // at queue time, so they must NOT be advanced again below.
  const { data: liveQueue, error: lqErr } = await sb
    .from("drip_queue")
    .select("id, lead_id")
    .in("lead_id", clusterIds)
    .in("status", ["pending", "approved"])
  if (lqErr) console.warn(`[manual-touch] drip_queue lookup failed:`, lqErr.message)
  const queuedLeadIds = new Set((liveQueue ?? []).map((r) => r.lead_id as string))
  let skippedDrips = 0
  if ((liveQueue ?? []).length > 0) {
    const { data: killed, error: dqErr } = await sb
      .from("drip_queue")
      .update({ status: "skipped", error: "superseded_by_manual_touch" })
      .in("id", (liveQueue ?? []).map((r) => r.id as string))
      .select("id")
    if (dqErr) console.warn(`[manual-touch] drip_queue sweep failed:`, dqErr.message)
    skippedDrips = (killed ?? []).length
  }

  // For every drip-stamped row in the cluster: restart the cadence clock,
  // and advance the touch counter unless a (now-skipped) queue row already
  // did so when the engine queued it.
  const { data: dripRows, error: drErr } = await sb
    .from("leads")
    .select("id, drip_touch_number")
    .in("id", clusterIds)
    .not("drip_campaign_type", "is", null)
  if (drErr) console.warn(`[manual-touch] drip-row lookup failed:`, drErr.message)

  let clockReset = 0
  let advanced = 0
  for (const r of (dripRows ?? []) as { id: string; drip_touch_number: number | null }[]) {
    const update: Record<string, unknown> = { last_drip_sent_at: touchAt }
    if (!queuedLeadIds.has(r.id)) {
      update.drip_touch_number = (r.drip_touch_number ?? 0) + 1
      advanced++
    }
    const { error: upErr } = await sb.from("leads").update(update).eq("id", r.id)
    if (upErr) console.warn(`[manual-touch] cadence update failed for ${r.id}:`, upErr.message)
    else clockReset++
  }

  if (clockReset > 0 || skippedDrips > 0) {
    console.log(`[manual-touch] cluster of ${lead.id}: reset ${clockReset} cadence clock(s) (${advanced} advanced), skipped ${skippedDrips} queued drip(s)`)
  }
  return { clockReset, advanced, skippedDrips }
}

// Display label for a lead. Prefers campaign_label (Phase 7C overlay) over
// the historical source column. Both can be null on imports that didn't
// match a known mailbox or twilio number.
export function getLeadDisplayCampaign(
  lead: Pick<Lead, "campaign_label" | "source">
): string {
  return lead.campaign_label || lead.source || "Unknown"
}

export function isOutbound(lead: Pick<Lead, "twilio_number">): boolean {
  return !lead.twilio_number
}

let cached: SupabaseClient | null = null
export function getLeadsClient(): SupabaseClient {
  if (cached) return cached
  const url = process.env.LRG_SUPABASE_URL
  const key = process.env.LRG_SUPABASE_SERVICE_KEY
  if (!url || !key) {
    throw new Error("LRG_SUPABASE_URL and LRG_SUPABASE_SERVICE_KEY must be set")
  }
  // 2026-05-17 — `cache: "no-store"` on every Supabase fetch is critical
  // in the Next.js App Router. Next/Vercel automatically caches GET fetch()
  // responses at the URL level, and supabase-js makes its REST calls via
  // fetch. Without this override, every GET to PostgREST gets a stale
  // response indefinitely after the first successful read — caused the
  // Candace / Bill Koester "offer not showing on Campaigns" bugs where the
  // pencil-edit wrote to Supabase but subsequent reads from the function
  // returned the pre-write snapshot. force-dynamic on the route handler
  // only stops caching of the route's RESPONSE; the inner fetches still
  // get cached. This setting fixes that at the source.
  cached = createClient(url, key, {
    auth: { persistSession: false },
    global: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(input, { ...(init ?? {}), cache: "no-store" }),
    },
  })
  return cached
}

export function getCampaignSource(twilioNumber: string | null | undefined): string {
  if (!twilioNumber) return "Unknown"
  return CAMPAIGN_MAP[twilioNumber] || "Unknown"
}

export async function sendTelegramAlert(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) {
    console.warn("[telegram] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID")
    return
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    })
    if (!res.ok) {
      console.error(`[telegram] sendMessage failed ${res.status}: ${await res.text()}`)
    }
  } catch (e) {
    console.error("[telegram] Alert failed:", e)
  }
}

// Send an audio buffer to Telegram as a playable voice note. Falls back to
// sendTelegramAlert (text-only) on failure so Ryan still gets the alert.
export async function sendTelegramVoice(
  audioBuffer: Buffer,
  caption: string,
  filename: string = "voicemail.mp3"
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) {
    console.warn("[telegram] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID")
    return
  }
  try {
    const form = new FormData()
    form.append("chat_id", chatId)
    form.append("voice", new Blob([new Uint8Array(audioBuffer)], { type: "audio/mpeg" }), filename)
    form.append("caption", caption.slice(0, 1024)) // Telegram caption limit
    form.append("parse_mode", "HTML")

    const res = await fetch(`https://api.telegram.org/bot${token}/sendVoice`, {
      method: "POST",
      body: form,
    })
    if (!res.ok) {
      const errText = await res.text()
      console.error(`[telegram] sendVoice failed ${res.status}: ${errText}`)
      // Fall back to text-only so Ryan still gets the alert
      await sendTelegramAlert(caption)
    }
  } catch (e) {
    console.error("[telegram] sendVoice threw:", e)
    await sendTelegramAlert(caption)
  }
}

// Download a Twilio recording with Basic Auth and return the audio bytes.
// Twilio appends `.mp3` automatically when fetching with the .mp3 URL.
export async function fetchTwilioAudio(url: string): Promise<Buffer | null> {
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!sid || !token) {
    console.error("[twilio-audio] Missing TWILIO credentials")
    return null
  }
  const auth = Buffer.from(`${sid}:${token}`).toString("base64")
  try {
    // Defensive cache: no-store. Twilio recording URLs are unique per
    // recording so cache hits would return the same audio (not stale
    // data), but the audio buffers can be multi-MB — letting Next.js
    // hold them in its fetch cache would waste serverless memory.
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` }, cache: "no-store" })
    if (!res.ok) {
      console.error(`[twilio-audio] Fetch failed ${res.status}: ${url}`)
      return null
    }
    const ab = await res.arrayBuffer()
    return Buffer.from(ab)
  } catch (e) {
    console.error("[twilio-audio] Fetch threw:", e)
    return null
  }
}

// OpenAI Whisper transcription. Returns the text or null on failure.
export async function transcribeAudio(
  audioBuffer: Buffer,
  filename: string = "voicemail.mp3"
): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    console.warn("[whisper] OPENAI_API_KEY not set; skipping transcription")
    return null
  }
  try {
    const form = new FormData()
    form.append("file", new Blob([new Uint8Array(audioBuffer)], { type: "audio/mpeg" }), filename)
    form.append("model", "whisper-1")
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    })
    if (!res.ok) {
      const errText = await res.text()
      console.error(`[whisper] Transcription failed ${res.status}: ${errText.slice(0, 300)}`)
      return null
    }
    const json = await res.json() as { text?: string }
    return (json.text ?? "").trim() || null
  } catch (e) {
    console.error("[whisper] Threw:", e)
    return null
  }
}

export function parseTwilioBody(body: string): URLSearchParams {
  return new URLSearchParams(body)
}


// Shared background pipeline for both inbound recording callbacks
// (/api/leads/voice/recording) and outbound call recordings
// (/api/leads/call/recording). Downloads audio, runs Whisper, optionally
// runs AI auto-triage (only when status is still "new" so manual triage
// isn't clobbered), and posts the audio + caption to Telegram.
//
// `direction` flips the Telegram caption header so Ryan can tell at a
// glance whether the recording is from an inbound voicemail/call or an
// outbound call he made.
export async function processRecordingBackground(args: {
  fullUrl: string
  callerPhone: string
  source: string
  leadId: string | null
  direction?: "inbound" | "outbound"
}): Promise<void> {
  const { fullUrl, callerPhone, source, leadId } = args
  const direction = args.direction ?? "inbound"
  try {
    const audio = await fetchTwilioAudio(fullUrl)

    let transcription: string | null = null
    if (audio) {
      transcription = await transcribeAudio(audio)
      if (transcription && leadId) {
        try {
          const sb = getLeadsClient()
          // Phase 7C-may8 Bug 5: if the caller spoke a mobile-home address
          // ("123 Main St lot 5"), flag the lead as junk so it filters out.
          const update: Record<string, unknown> = { message: transcription }
          if (isMobileHome(transcription)) update.is_junk = true
          const { error } = await sb
            .from("leads")
            .update(update)
            .eq("id", leadId)
          if (error) console.error("[recording-bg] Transcription save failed:", error)
          else console.log(`[recording-bg] Saved transcription for lead ${leadId}`)
        } catch (e) {
          console.error("[recording-bg] Transcription save threw:", e)
        }
      }
    }

    // Outbound calls get a short summary saved to `ai_notes` (Ryan made
    // the call and already knows the classification, so no triage — just
    // a "what was discussed / next steps" line for the timeline).
    // We ALSO run analyze-call on the transcript to extract a follow-up
    // recommendation (date + reason). The status portion of that result
    // is dropped via applyFollowupOnlyResult — Ryan made the call and
    // already knows where the lead stands.
    let outboundSummary: string | null = null
    if (direction === "outbound" && transcription && leadId) {
      outboundSummary = await summarizeOutboundCall(transcription)
      if (outboundSummary) {
        try {
          const sb = getLeadsClient()
          const { error } = await sb
            .from("leads")
            .update({ ai_notes: outboundSummary })
            .eq("id", leadId)
          if (error) console.error("[summarize] Update failed:", error)
          else console.log(`[summarize] Saved outbound summary for lead ${leadId}: ${outboundSummary}`)
        } catch (e) {
          console.error("[summarize] Save threw:", e)
        }
      }
      try {
        // 2026-05-11 Fix 2 — pull prior conversation history so the
        // analyzer can extract name / property / follow-up context from
        // the FULL cluster, not just this single outbound recording.
        const sb = getLeadsClient()
        const clusterHistory = await fetchClusterHistory(sb, {
          callerPhone,
          excludeId: leadId,
        })
        const followup = await analyzeCallTranscript(transcription, { clusterHistory })
        if (followup) {
          await applyFollowupOnlyResult(leadId, followup)
          if (followup.recommended_followup_date) {
            console.log(`[followup-only] Lead ${leadId} → ${followup.recommended_followup_date}: ${followup.followup_reason}`)
          }
        }
      } catch (e) {
        console.error("[followup-only] Threw:", e)
      }
    }

    // Phase 7D — single analyzer pass for every inbound recording.
    // Writes temperature + ai_summary + name + property_address + email +
    // follow-up. Lifecycle status is left alone for Ryan to manage.
    //
    // If there's no transcript (caller hung up without leaving a message, or
    // Whisper failed) OR the analyzer can't produce a result, we fall back to
    // applyColdNoSignalDefault — the lead is still real, so it gets a cold
    // badge + a 6-month nurture follow-up instead of a blank badge and no
    // follow-up forever.
    let analysis: AnalyzeCallResult | null = null
    if (direction === "inbound" && leadId) {
      if (transcription) {
        try {
          // 2026-05-11 Fix 2 — same cluster-history wiring as the outbound
          // path. Especially important for follow-up voicemails ("I'm busy,
          // call me back") that don't restate the lead's name / property
          // from earlier rows in the cluster.
          const sb = getLeadsClient()
          const clusterHistory = await fetchClusterHistory(sb, {
            callerPhone,
            excludeId: leadId,
          })
          analysis = await analyzeCallTranscript(transcription, { clusterHistory })
          if (analysis) {
            await applyAnalyzeCallResult(leadId, analysis)
            console.log(`[analyze-call] Lead ${leadId} → ${analysis.temperature}: ${analysis.summary.slice(0, 100)}`)
          }
        } catch (e) {
          console.error("[analyze-call] Threw:", e)
        }
      }
      if (!analysis) {
        await applyColdNoSignalDefault(leadId)
        console.log(`[analyze-call] Lead ${leadId} → cold (no-signal default: ${transcription ? "analysis failed" : "no transcript"})`)
      }

      // Anonymous-caller promotion. Blocked-ID callers start is_junk=true at
      // intake (most are spam). But if this one left a SUBSTANTIVE voicemail
      // — real engagement, or they gave a name / address / email — it's a
      // genuine lead. Un-junk it so it surfaces in the leads list + Follow-Up
      // tab, and if they spoke an email, stamp a drip campaign so it enters
      // the drip system like any other lead. The row is already its own card
      // (groupLeads keys anonymous rows by id), so un-junking is all it takes.
      if (isAnonymousCaller(callerPhone) && analysis) {
        const hasSubstance =
          analysis.temperature !== "cold" ||
          !!analysis.name ||
          !!analysis.property_address ||
          !!analysis.email
        if (hasSubstance) {
          try {
            const sb = getLeadsClient()
            const promote: Record<string, unknown> = { is_junk: false }
            if (analysis.email) {
              promote.drip_campaign_type = "direct_mail_email"
              promote.drip_touch_number = 0
              promote.last_drip_sent_at = new Date().toISOString()
            }
            await sb.from("leads").update(promote).eq("id", leadId)
            console.log(`[anon-promote] Lead ${leadId} un-junked — substantive voicemail${analysis.email ? " + email drip stamped" : ""}`)
          } catch (e) {
            console.error("[anon-promote] Threw:", e)
          }
        }
      }
    }

    const header = direction === "outbound"
      ? `📤 Outbound call recording — <b>${source}</b> — ${callerPhone}`
      : `🎙️ New recording — <b>${source}</b> — ${callerPhone}`
    const captionLines = [header]
    if (transcription) {
      captionLines.push("", `📝 ${transcription}`)
    } else {
      captionLines.push("", `🔗 ${fullUrl}`)
    }
    if (analysis) {
      const badge = TEMPERATURE_BADGE[analysis.temperature]
      captionLines.push("", `${badge.emoji} <b>${badge.label}</b> — ${analysis.summary}`)
    }
    if (outboundSummary) {
      captionLines.push("", `🤖 Summary: ${outboundSummary}`)
    }
    const caption = captionLines.join("\n")

    if (audio) {
      await sendTelegramVoice(audio, caption)
    } else {
      await sendTelegramAlert(caption)
    }
  } catch (e) {
    console.error("[recording-bg] Threw:", e)
  }
}

// Brief summary of an outbound call. The inbound flow uses the unified
// `analyzeCallTranscript` (which writes summary + temperature + name +
// property + follow-up); for outbound, Ryan made the call himself and
// already knows the context, so we just save a short "what was discussed /
// next steps" line to ai_notes for the timeline.
export async function summarizeOutboundCall(
  transcription: string
): Promise<string | null> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    console.warn("[summarize] OPENROUTER_API_KEY not set; skipping outbound summary")
    return null
  }

  const prompt = `You are summarizing a phone call between Ryan (a real estate investor) and a lead. Based on the transcript below, write a brief 1-2 sentence summary of what was discussed and any next steps. No labels, no markdown, no quotes — just the summary text. Maximum 2 sentences.

If the caller and Ryan discussed property specifics — bed/bath count, multi-unit mix (e.g. duplex: 1x 3bd/2ba + 1x 2bd/1ba), per-unit or total monthly rents, vacancy status — include them explicitly. They're load-bearing details for Ryan; don't drop them to save words.

TRANSCRIPT:
"${transcription}"`

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "anthropic/claude-haiku-4-5",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 120,
      }),
    })

    if (!res.ok) {
      console.error(`[summarize] OpenRouter failed ${res.status}: ${(await res.text()).slice(0, 300)}`)
      return null
    }

    const json = await res.json() as { choices?: { message?: { content?: string } }[] }
    const content = json.choices?.[0]?.message?.content?.trim()
    if (!content) return null
    // Strip surrounding quote marks if the model wrapped its response.
    return content.replace(/^["'`]+|["'`]+$/g, "").trim() || null
  } catch (e) {
    console.error("[summarize] Threw:", e)
    return null
  }
}


// Phase 7D — single Haiku pass per call transcript. Replaces the older
// triage/analyze split. Extracts:
//   - temperature (hot/warm/cold) — drives the read-only badge in the UI
//   - summary — 2-6 sentence plain paragraph, rendered as the AI block on
//     the lead card (replaces the old verbose multi-bullet ai_summary)
//   - name + property_address — best-effort, written if AI confidence is
//     sufficient (Ryan can hand-correct via EditableInlineField)
//   - recommended_followup_date + followup_reason — drives the Follow-Up
//     sub-tab; defaulted to T+24h with a generic reason if AI didn't return
//     one (see applyAnalyzeCallResult)
//
// LIFECYCLE STATUS IS NEVER WRITTEN BY THE AI. Ryan owns the lifecycle
// dropdown; temperature is the AI's lane.
//
// Used by /api/leads/[id]/analyze-call (manual / Ryan-driven) and
// processRecordingBackground (auto on every inbound recording).

export interface AnalyzeCallResult {
  temperature: Temperature
  summary: string
  name: string | null
  property_address: string | null
  // Email the caller stated out loud — incl. spelled-out / "at gmail dot
  // com" forms, normalized. Lets a call-only lead get an email on the card
  // (and the send-email path) without Ryan typing it in. null if none said.
  email: string | null
  recommended_followup_date: string | null
  followup_reason: string | null
  // True when the seller explicitly opted out ("don't call me again," "take
  // me off your list," hostile opt-out). applyAnalyzeCallResult flips the
  // lead to is_dnc=true + status=dead and seeds a dnc_list row.
  is_dnc: boolean
  // Offer detection — Ryan's stated purchase price to the seller (NOT the
  // seller's asking price). Powers the Campaign Performance funnel
  // "Responded → Offer → Closed". Conservative: only fires when Ryan
  // verbalizes a specific dollar amount; soft/conditional offers still
  // count, but a seller-stated price alone does not.
  offer_amount: number | null
  offer_verbalized: boolean
}

// Build a short prose timeline of every prior event in the contact's cluster
// (same caller_phone OR same email). Used by analyzeCallTranscript so the
// model can extract name / property / temperature / follow-up from the FULL
// conversation history rather than just the freshest recording — needed for
// follow-up voicemails like "I'm busy, call me back" that don't restate the
// earlier context. Returns null when there's nothing usable.
//
// `excludeId` lets the caller drop the row holding the fresh transcript from
// the history block so the prompt isn't duplicating it.
export async function fetchClusterHistory(
  sb: SupabaseClient,
  opts: {
    callerPhone?: string | null
    email?: string | null
    excludeId?: string | null
  }
): Promise<string | null> {
  let q = sb
    .from("leads")
    .select("id, created_at, lead_type, twilio_number, message")
    .order("created_at", { ascending: true })
    .limit(40)
  if (opts.callerPhone) {
    q = q.eq("caller_phone", opts.callerPhone)
  } else if (opts.email) {
    q = q.eq("email", opts.email)
  } else {
    return null
  }
  const { data, error } = await q
  if (error || !data) return null
  const rows = data.filter(
    (r) =>
      (r.message || "").trim().length > 0 &&
      (!opts.excludeId || r.id !== opts.excludeId)
  )
  if (rows.length === 0) return null
  // Per-message limit 4000 chars (bumped from 400 on 2026-05-11) — a full
  // call transcript can run 3-8k chars and the older 400-char cap was
  // truncating mid-conversation, making the analyzer treat clearly-rich
  // calls as "just getting started." 20 rows × 4000 chars ≈ 20k tokens
  // worst case, well inside Haiku's context.
  return rows
    .slice(-20)
    .map((r) => {
      const dir = r.twilio_number ? "lead" : "ryan"
      const kind = r.lead_type || "?"
      const text = (r.message || "").slice(0, 4000)
      return `[${r.created_at}] ${kind} (${dir}): ${text}`
    })
    .join("\n")
}

export async function analyzeCallTranscript(
  transcript: string,
  context?: { clusterHistory?: string | null }
): Promise<AnalyzeCallResult | null> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    console.warn("[analyze-call] OPENROUTER_API_KEY not set; skipping")
    return null
  }
  const today = new Date().toISOString().slice(0, 10)
  const history = context?.clusterHistory?.trim() || null
  // The history block is optional context, the fresh transcript is the
  // primary signal. We instruct the model accordingly so a brief follow-up
  // voicemail doesn't lose Cross-call info (name, property, prior promises).
  const historyBlock = history
    ? `\nPRIOR CONVERSATION (oldest → newest, context only — DO NOT treat as the current call):\n"""\n${history}\n"""\n`
    : ""
  const prompt = `You are analyzing a phone call transcript between Ryan (a cash home buyer) and a real estate seller lead.

TODAY IS ${today}. All recommended_followup_date values must be on or after today.${historyBlock ? "\n\nExtract NAME, PROPERTY_ADDRESS and EMAIL from the full conversation (prior + fresh). Other fields (temperature, summary, follow-up) should reflect the FRESH transcript primarily, using prior context for continuity.\n" : ""}

Produce a JSON object with these fields:

- temperature: one of "hot" | "warm" | "cold".
${TEMPERATURE_RUBRIC}

- summary: a plain prose paragraph, 2 to 6 sentences. No headers, no bullets,
    no bold. Cover who the caller is, what their inquiry is about, any
    obvious next-step or urgency cue. Emojis allowed where natural, not
    required.

    ANCHOR ON THE LATEST OUTCOME of the call. If Ryan made an offer, capture
    the dollar amount AND the seller's response (accepted / declined /
    countered / undecided). If the seller declined an offer, say "price gap"
    explicitly — don't soften the rejection to "motivated to sell." If the
    call ended with a stall or rejection, the summary should reflect that
    as the current state, not the conversational warmth that preceded it.

    PROPERTY SPECIFICS — if the caller and Ryan discuss any of the following,
    capture them EXPLICITLY and concretely in the summary (don't paraphrase
    them away). These are load-bearing details Ryan revisits later:
      • bed/bath count (e.g. "3bd/2ba")
      • multi-unit mix on a duplex / triplex / 4-plex / small MFR — list each
        unit's size when stated (e.g. "duplex: 1x 3bd/2ba + 1x 2bd/1ba",
        "4-plex with two 2bd/1ba and two 1bd/1ba")
      • monthly rents per unit or in total (e.g. "rents \$2,400 and \$1,800",
        "grossing ~\$8k/mo")
      • vacancy / occupancy status (which units are occupied, month-to-month
        vs lease, problem tenants)
      • square footage, lot size, or year built if stated

    Example: "Brian called about a duplex he owns at 2127 Los Gatos Almaden
    Rd — 1x 3bd/2ba renting for \$2,800 and 1x 2bd/1ba renting for \$2,100,
    both month-to-month. He didn't share a timeline but sounded open to
    exploring options and wants a callback. Worth a quick follow-up
    tomorrow morning."

- name: the SELLER caller's stated name (best-effort, even if audio was
    unclear). Null only if no seller name is present.

    DO NOT extract Ryan's own name as the caller. Ryan is the RECIPIENT —
    he runs LRG Homes. Watch for these tells that the transcript is Ryan's
    own voice (his outgoing voicemail greeting, or his outbound voicemail
    TO a seller) — in any of these cases set name=null:
      • "This is Ryan with LRG Homes" / "This is Brian with LRG Homes"
        (Whisper sometimes hears Ryan as Brian)
      • "I'm not available right now, leave your name and number"
      • "mailbox is full" / "cannot accept any messages"
      • "Hi <NAME>, this is Ryan with LRG Homes calling you back / returning
        your call / got your message" — Ryan addressing the seller is not
        the seller naming themselves.
    Only fill name when the SELLER themselves states their name. If the
    transcript is entirely the voicemail greeting / Ryan's own message,
    name=null AND property_address=null AND the summary should describe
    the situation honestly ("Outbound callback reached voicemail" /
    "Voicemail greeting only — no seller message captured").

- property_address: any property address mentioned (best-effort, even
    partial — Ryan can clean it up). Null only if no address was mentioned.
    Cluster history counts — if a prior conversation tied this caller to a
    specific property, surface it here even when the fresh transcript is
    just a voicemail greeting.

- email: any email address the caller stated. Callers often spell it out or
    say it aloud ("john smith at gmail dot com", "j-s-m-i-t-h") — normalize
    those spoken forms to a standard address (johnsmith@gmail.com). Null only
    if no email was mentioned.

- recommended_followup_date: ISO date YYYY-MM-DD ≥ today. Reason the follow-up
    timing from what was actually said — EVERY genuine seller lead gets a date.

    1. If the seller stated an explicit timeline, map it:
         "now" / "ASAP" / "this week"            → 3-7 days
         "next week" / "a week or two"            → 7-14 days
         "couple weeks" / "next few weeks"        → 14-30 days
         "next month" / "a month or so"           → 30-45 days
         "1-2 months" / "couple months"           → 45-75 days
         "3-6 months"                             → 90-180 days
         "later this year" / "before year end"    → near Dec 1 of this year
         "next year" / "a year from now"          → ~365 days
         "year or two" / "couple years"           → 365-730 days
         "few years out" / "3+ years"             → 730+ days

    2. If NO explicit timeline, reason an interval from the substance of the
       conversation:
         - Price gap / valuation mismatch that stalled (seller wants more than
           Ryan offered, no movement)          → ~180 days. Sellers often
                                                  soften over time; revisit then.
         - Actively engaged but no timeline (asked for an offer, routed you to
           their agent, wants more info)        → 14-30 days while it's warm.
         - Vague / brief / near-empty voicemail from a real person, no detail
                                                → ~180 days routine nurture check-in.
         - Any other real seller with no other signal
                                                → ~180 days nurture check-in.

    3. Return null ONLY when this clearly isn't a workable seller lead: an
       explicit "never contact me again" / hostile opt-out, an obvious wrong
       number, spam, or a non-seller inquiry.

- followup_reason: ONE short sentence that does BOTH:
    (1) Cites the basis — quote the seller's EXACT phrase in double quotes if
        they gave one, otherwise name the situation (price gap, vague
        voicemail, etc.).
    (2) States the resulting follow-up timing in plain words.
    Examples:
      "Seller said 'maybe in a year or two' — follow up ~1 year out."
      "Caller asked Ryan to 'call me back next week' — follow up in 7 days."
      "Wants 1.9M, Ryan offered 1.5M — price gap, revisit in ~6 months."
      "Brief voicemail with no detail — routine 6-month nurture check-in."
      "Said 'take me off your list' — opt-out, no follow-up."

- is_dnc: boolean. Set true ONLY when the seller has unambiguously asked to
    not be contacted. Triggering language (examples, not exhaustive):
      • "don't call me again" / "stop calling" / "take me off your list"
      • "remove me from your mailing list" / "I'm on the do-not-call list"
      • "I have no intention of selling — don't contact me again"
      • "lose my number" / hostile opt-out
    DO NOT set true for soft passes — "not interested right now," "maybe
    someday," "wrong number," vague voicemails, polite no-thanks without an
    opt-out request. Those stay cold with a regular nurture follow-up.
    When is_dnc is true, also return recommended_followup_date=null and put
    the opt-out quote in followup_reason. The system halts all outreach
    (drip + manual) on DNC, so be conservative — false negatives are fine,
    false positives lose real leads.

OFFER DETECTION
Ryan (the buyer/investor) sometimes states a specific purchase price to
the seller. When he does, capture it.

- offer_amount: dollar amount Ryan stated as a purchase price to the seller.
    Number only (e.g., 800000 for "$800K"). Null if no offer.
- offer_verbalized: true if Ryan stated a specific price to the seller;
    false otherwise.

CRITICAL: this is RYAN'S price to the seller — NOT the seller's asking
price. False positives lose real campaign-performance signal, so be
conservative.

- If ONLY the seller mentions a price ("I want $850K", "I'm asking $1.2M",
  "I'd take $900K"), set both to null. The seller stating a number is not
  Ryan offering a number.
- If Ryan says "I can offer you $800K" / "I was thinking $750K" / "what
  about $900K for the property" / "we'd be at around $650K" → set
  offer_amount to the number and offer_verbalized: true.
- Soft / conditional offers still count: "maybe around $700K if it checks
  out" → 700000.
- Ranges → take the midpoint, rounded to the nearest 1k: "$700-750K" →
  725000.
- Direct mail letter / "blind" offers in Ryan's mailer don't count — the
  letter is a marketing piece, not a verbalized offer in this conversation.

Examples:
  • Seller: "I'd take $900K." Ryan: "Let me think about it." →
      offer_amount: null, offer_verbalized: false
  • Ryan: "I can do $850,000 cash, close in 14 days." →
      offer_amount: 850000, offer_verbalized: true
  • Ryan: "We're typically in the $600-700K range for properties like this." →
      offer_amount: 650000, offer_verbalized: true
  • Ryan (in email): "Based on what you described, I could offer $1.1M." →
      offer_amount: 1100000, offer_verbalized: true
  • Seller: "Comps are $1.2M." Ryan: "Okay, what's your timeline?" →
      offer_amount: null, offer_verbalized: false (Ryan didn't state a price)

Respond with ONLY the JSON object — no markdown fences, no explanation.

{
  "temperature": "...",
  "summary": "...",
  "name": "..." | null,
  "property_address": "..." | null,
  "email": "..." | null,
  "recommended_followup_date": "YYYY-MM-DD" | null,
  "followup_reason": "..." | null,
  "is_dnc": true | false,
  "offer_amount": number | null,
  "offer_verbalized": true | false
}

${historyBlock}FRESH TRANSCRIPT (this is the current call):
"${transcript}"`

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/claude-haiku-4-5",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    })
    if (!res.ok) {
      console.error(`[analyze-call] OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`)
      return null
    }
    const json = await res.json() as { choices?: { message?: { content?: string } }[] }
    const content = json.choices?.[0]?.message?.content?.trim() || ""
    if (!content) return null
    const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim()
    const parsed = JSON.parse(cleaned) as Partial<AnalyzeCallResult>
    if (
      !parsed.temperature ||
      !(VALID_TEMPERATURES as readonly string[]).includes(parsed.temperature)
    ) {
      return null
    }
    if (!parsed.summary || typeof parsed.summary !== "string" || !parsed.summary.trim()) {
      return null
    }
    return {
      temperature: parsed.temperature as Temperature,
      summary: parsed.summary.trim(),
      name:
        typeof parsed.name === "string" && parsed.name.trim()
          ? parsed.name.trim()
          : null,
      property_address:
        typeof parsed.property_address === "string" && parsed.property_address.trim()
          ? parsed.property_address.trim()
          : null,
      email:
        typeof parsed.email === "string" && /\S+@\S+\.\S+/.test(parsed.email.trim())
          ? parsed.email.trim().toLowerCase()
          : null,
      recommended_followup_date:
        typeof parsed.recommended_followup_date === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(parsed.recommended_followup_date)
          ? parsed.recommended_followup_date
          : null,
      followup_reason:
        typeof parsed.followup_reason === "string" && parsed.followup_reason.trim()
          ? parsed.followup_reason.trim()
          : null,
      is_dnc: parsed.is_dnc === true,
      offer_amount:
        typeof parsed.offer_amount === "number" && Number.isFinite(parsed.offer_amount) && parsed.offer_amount > 0
          ? parsed.offer_amount
          : null,
      offer_verbalized: parsed.offer_verbalized === true,
    }
  } catch (e) {
    console.error("[analyze-call] threw:", e)
    return null
  }
}

// Validation guard for AI-returned follow-up dates. When the AI's stated
// reason cites a long-horizon phrase ("year(s)", "long-term") but the date
// is within ~6 months, the AI hallucinated the date — clear it rather than
// surface a misleading near-term to-do. The prompt's explicit
// timeline-to-date mapping should make this rare, but the guard catches
// the obvious failures before they reach Ryan's Follow-Up tab.
function validateFollowupAgainstReason(
  date: string | null,
  reason: string | null
): { date: string | null; reason: string | null } {
  if (!date || !reason) return { date, reason }
  const r = reason.toLowerCase()
  const daysOut = Math.round(
    (new Date(date + "T00:00:00Z").getTime() - Date.now()) / 86_400_000
  )
  // "year(s)" / "long-term" in reason but date < 180 days → clear.
  const mentionsLongHorizon = /\byears?\b|\blong[- ]term\b|\bcouple years?\b/.test(r)
  if (mentionsLongHorizon && daysOut < 180) {
    console.warn(
      `[analyze-call] guard: reason mentions long horizon but date is ${daysOut}d out — clearing date+reason. reason="${reason}", date=${date}`
    )
    return { date: null, reason: null }
  }
  return { date, reason }
}

// Outbound variant: persist follow-up fields + opportunistically fill
// name/property_address from the transcript when missing. Ryan made the
// call himself — he already knows the lifecycle status, the temperature,
// and the conversation tone, so we deliberately don't write status /
// temperature / ai_summary here (those would clobber his judgment). But
// name and property_address are factual identity info that the analyzer
// can extract from the same transcript Ryan just heard. Auto-filling them
// matches the inbound path and saves the "click into the inline field and
// type her name" step. EditableInlineField in the UI lets Ryan correct a
// mishearing whenever the model gets one wrong.
//
// 2026-05-11: the hands-off rule mirrors applyAnalyzeCallResult — only
// write when the SAME ROW's value is null/empty. Cluster-wide preexisting
// names (e.g. from an earlier inbound row Ryan hand-corrected) are still
// preferred by the UI's groupLeads "first non-null wins" derivation, so
// the worst case is the outbound row carries a slightly off model guess
// while the lead card still shows the correct name from the older row.
export async function applyFollowupOnlyResult(
  leadId: string,
  result: AnalyzeCallResult
): Promise<void> {
  const sb = getLeadsClient()
  // Respect the AI's null — if no timeline was extracted from the transcript,
  // don't invent one. The Follow-Up tab will skip rows with null dates, which
  // is the desired behavior: Ryan only sees follow-ups the AI could justify.
  const { date: followupDate, reason: followupReason } = validateFollowupAgainstReason(
    result.recommended_followup_date ?? null,
    result.followup_reason ?? null
  )

  const { data: existing } = await sb
    .from("leads")
    .select("name, property_address, email, offer_amount, offer_verbalized_at, created_at")
    .eq("id", leadId)
    .maybeSingle()

  const update: Record<string, unknown> = {
    recommended_followup_date: followupDate,
    followup_reason: followupReason,
    followup_generated_at: new Date().toISOString(),
  }
  if (result.name && !existing?.name) update.name = result.name
  if (result.property_address && !existing?.property_address) {
    update.property_address = result.property_address
  }
  if (result.email && !existing?.email) update.email = result.email

  // Offer detection — same hands-off rule as applyAnalyzeCallResult.
  // Outbound calls are the canonical "Ryan stated a number" path, so
  // this branch is the typical write site for offer events.
  if (result.offer_verbalized && typeof result.offer_amount === "number" && result.offer_amount > 0) {
    if (existing?.offer_amount == null) update.offer_amount = result.offer_amount
    if (existing?.offer_verbalized_at == null) {
      update.offer_verbalized_at = existing?.created_at ?? new Date().toISOString()
    }
  }

  // Auto-DNC also honored on outbound-call analysis. The seller's opt-out is
  // valid regardless of who initiated the call — if Ryan rings them back and
  // they say "lose my number," we flag DNC here too.
  if (result.is_dnc) {
    update.is_dnc = true
    update.status = "dead"
    update.recommended_followup_date = null
  }

  const { error } = await sb.from("leads").update(update).eq("id", leadId)
  if (error) console.error(`[followup-only] update failed for ${leadId}:`, error.message)

  if (result.is_dnc) {
    await seedAiAutoDnc(sb, leadId, {
      name: (existing?.name as string | null) || result.name || null,
      property_address:
        (existing?.property_address as string | null) || result.property_address || null,
      reason_text: result.followup_reason || null,
    })
  }
}

// Shared dnc_list insert for the auto-DNC path. Mirrors the manual DNC
// route's shape (reason="requested", added_by tagged) so a future export
// reads cleanly regardless of who flagged it.
async function seedAiAutoDnc(
  sb: SupabaseClient,
  leadId: string,
  meta: { name: string | null; property_address: string | null; reason_text: string | null }
): Promise<void> {
  const { error } = await sb.from("dnc_list").insert({
    site_address: meta.property_address,
    owner_name: meta.name,
    source_lead_id: leadId,
    reason: "requested",
    added_by: "ai",
  })
  if (error) console.warn(`[auto-dnc] dnc_list insert failed for ${leadId}: ${error.message}`)
  console.log(`[auto-dnc] Lead ${leadId} flagged by AI: ${meta.reason_text || "no reason text"}`)
}

// Phase 7D — persist the unified analyzer result. Writes:
//   - temperature           (AI-controlled badge)
//   - ai_summary            (short paragraph, replaces the verbose cached one)
//   - ai_summary_generated_at
//   - name + property_address (best-effort; only fills if the AI returned
//     a value AND the column is currently empty — never overwrites a
//     hand-corrected value)
//   - recommended_followup_date + followup_reason (null when the AI couldn't
//     justify a date from the transcript — Follow-Up tab filters rows with
//     null dates out, so Ryan only sees follow-ups with explicit reasoning)
//   - followup_generated_at
//
// Status (lifecycle) is NEVER touched by this function — Ryan owns it.
// suggested_status / suggested_status_reason are cleared so the old training-
// wheels banner doesn't linger after re-analyze.
export async function applyAnalyzeCallResult(
  leadId: string,
  result: AnalyzeCallResult
): Promise<void> {
  const sb = getLeadsClient()

  // Look up existing name/property so we never clobber a hand-corrected
  // value with a worse AI guess. EditableInlineField in the UI lets Ryan
  // fix mis-parses; once he has, the AI re-runs shouldn't overwrite.
  // Also pull caller_phone + email so we can invalidate the summary cache
  // across the full contact cluster (Fix 1 below).
  const { data: existing } = await sb
    .from("leads")
    .select("name, property_address, caller_phone, email, offer_amount, offer_verbalized_at, created_at")
    .eq("id", leadId)
    .maybeSingle()

  // Respect the AI's null (no clear timeline in transcript → no auto-followup)
  // and run the guard against "reason mentions year but date is near-term."
  const { date: followupDate, reason: followupReason } = validateFollowupAgainstReason(
    result.recommended_followup_date ?? null,
    result.followup_reason ?? null
  )

  const update: Record<string, unknown> = {
    temperature: result.temperature,
    ai_summary: result.summary,
    ai_summary_generated_at: new Date().toISOString(),
    recommended_followup_date: followupDate,
    followup_reason: followupReason,
    followup_generated_at: new Date().toISOString(),
    suggested_status: null,
    suggested_status_reason: null,
  }
  if (result.name && !existing?.name) update.name = result.name
  if (result.property_address && !existing?.property_address) {
    update.property_address = result.property_address
  }
  // Email the caller stated aloud — fill only when the row has none, so a
  // hand-corrected address is never clobbered. This is what makes the
  // send-email path light up for a call-only lead (e.g. Mike Cummings).
  if (result.email && !existing?.email) update.email = result.email

  // Offer detection — hands-off rule. Only write the amount + timestamp
  // when the row's current values are null, so Ryan's manual pencil edits
  // on the lead card always win over a later re-analysis. offer_verbalized
  // is a transient signal from the analyzer (not a column on leads); the
  // persisted state is (offer_amount, offer_verbalized_at).
  if (result.offer_verbalized && typeof result.offer_amount === "number" && result.offer_amount > 0) {
    if (existing?.offer_amount == null) update.offer_amount = result.offer_amount
    if (existing?.offer_verbalized_at == null) {
      // Use the lead row's created_at as the offer-event timestamp — that's
      // when this conversation actually happened. Falls back to now() if
      // somehow missing. Backfills (re-running analyze on an old row) will
      // therefore stamp the historical date, not today's.
      update.offer_verbalized_at = existing?.created_at ?? new Date().toISOString()
    }
  }

  // Auto-DNC: when the seller explicitly opts out, mirror the manual DNC
  // path (POST /api/leads/[id]/dnc) — flag is_dnc=true, drop lifecycle to
  // dead, clear the recommended follow-up date. This halts the drip engine
  // (its WHERE clause filters is_dnc=true) and removes the row from the
  // active queue. Prompt is conservative on this flag; false positives lose
  // real leads, so we trust Haiku here.
  if (result.is_dnc) {
    update.is_dnc = true
    update.status = "dead"
    update.recommended_followup_date = null
  }

  const { error } = await sb.from("leads").update(update).eq("id", leadId)
  if (error) console.error(`[analyze-call] update failed for ${leadId}:`, error.message)

  if (result.is_dnc) {
    await seedAiAutoDnc(sb, leadId, {
      name: (existing?.name as string | null) || result.name || null,
      property_address:
        (existing?.property_address as string | null) || result.property_address || null,
      reason_text: result.followup_reason || null,
    })
  }

  // 2026-05-11 Fix 1 — cluster-wide cache invalidation. The summary endpoint
  // builds its paragraph from the FULL conversation cluster while this
  // analyzer only sees the fresh recording. If a card was expanded BEFORE
  // the recording landed, the summary endpoint already wrote
  // ai_summary_generated_at=<recent> onto an anchor row whose own
  // created_at never updates when the transcript arrives — so the cache
  // check (cachedTs > latestEventTs) keeps serving the stale "no recorded
  // contact events" paragraph forever. Nulling ai_summary_generated_at on
  // every row in this contact's cluster forces the next /summary call to
  // miss cache and regenerate against the full transcript.
  //
  // Done as the LAST step so it can't race against the analysis write
  // above. Scoped by caller_phone when present, else by email, so call /
  // SMS clusters and email-only clusters both invalidate correctly.
  try {
    let invQ = sb.from("leads").update({ ai_summary_generated_at: null })
    let scoped = false
    if (existing?.caller_phone) {
      invQ = invQ.eq("caller_phone", existing.caller_phone)
      scoped = true
    } else if (existing?.email) {
      invQ = invQ.eq("email", existing.email)
      scoped = true
    }
    if (scoped) {
      const { error: invErr } = await invQ
      if (invErr) {
        console.error(`[analyze-call] cluster cache invalidate failed for ${leadId}:`, invErr.message)
      }
    }
  } catch (e) {
    console.error(`[analyze-call] cluster cache invalidate threw for ${leadId}:`, e)
  }
}

// Cold no-signal default. Used when an inbound call produced no transcript
// (caller hung up without leaving a message, or Whisper failed) or the
// analyzer couldn't produce a result. The lead is still real — it just gave
// us nothing to grade — so rather than leave a blank temperature badge and
// no follow-up forever, we stamp it `cold` with a 6-month nurture follow-up
// so it stays on the drip and resurfaces. Only fills fields that are
// currently empty, so a later real transcript (or a hand edit) wins.
export async function applyColdNoSignalDefault(leadId: string): Promise<void> {
  const sb = getLeadsClient()
  const { data: existing } = await sb
    .from("leads")
    .select("temperature, recommended_followup_date, ai_summary")
    .eq("id", leadId)
    .maybeSingle()
  if (!existing) return

  const update: Record<string, unknown> = {}
  if (!existing.temperature) update.temperature = "cold"
  if (!existing.recommended_followup_date) {
    const d = new Date()
    d.setDate(d.getDate() + 180)
    update.recommended_followup_date = d.toISOString().slice(0, 10)
    update.followup_reason =
      "Called but left no message — cold, routine 6-month nurture check-in."
    update.followup_generated_at = new Date().toISOString()
  }
  if (!existing.ai_summary) {
    update.ai_summary =
      "Caller reached voicemail but didn't leave a message — no details to go on yet. Kept on the nurture drip with a 6-month check-in."
    update.ai_summary_generated_at = new Date().toISOString()
  }
  if (Object.keys(update).length === 0) return

  const { error } = await sb.from("leads").update(update).eq("id", leadId)
  if (error) console.error(`[cold-default] update failed for ${leadId}:`, error.message)
}

// Email-lead triage — same Haiku model as the call/voicemail path, but the
// prompt is tuned for written replies and also asks the model to draft a
// short text-message-style reply that Ryan can edit and send from the
// lead card. Returns null on any failure (non-fatal).
//
// Phase 7D: outputs temperature (hot/warm/cold) instead of a status — the
// lifecycle dropdown is Ryan's, AI only sets temperature. `is_dead` is a
// separate boolean for spam/unsubscribe so the caller can still flip
// lifecycle status to "dead" without conflating it with temperature.
export interface EmailTriageResult {
  temperature: Temperature
  is_dead: boolean
  summary: string
  suggestedReply: string
  // Offer detection — same rules as analyzeCallTranscript. Captures the
  // case where Ryan has emailed the seller a specific number (typical
  // direct-mail back-and-forth ending in "Based on what you described,
  // I could offer $X").
  offer_amount: number | null
  offer_verbalized: boolean
}

export async function triageEmailLead(
  subject: string,
  body: string
): Promise<EmailTriageResult | null> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    console.warn("[triage-email] OPENROUTER_API_KEY not set; skipping triage")
    return null
  }

  const prompt = `You are triaging an email response to a real estate direct mail campaign. The sender received a mailer about selling their home.

Subject: ${subject}
Body: ${body}

Respond in JSON only:
{
  "temperature": "hot" | "warm" | "cold",
  "is_dead": true | false,
  "summary": "one sentence summary",
  "suggestedReply": "a short, natural text-message-style reply Ryan can send. Warm, direct, no fluff. 1-2 sentences max.",
  "offer_amount": number | null,
  "offer_verbalized": true | false
}

temperature:
${TEMPERATURE_RUBRIC}

is_dead: true ONLY for spam / wrong number / explicit unsubscribe / hostile.
  Default false. Use this flag, not temperature, to mark a lead as dead.

OFFER DETECTION
- offer_amount: dollar amount Ryan stated as a purchase price to the seller
    in THIS email thread. Number only (e.g., 800000 for "$800K"). Null if
    no offer.
- offer_verbalized: true if Ryan stated a specific price; false otherwise.
- CRITICAL: this is RYAN'S price to the seller — NOT the seller's asking
    price. If only the seller mentions a price ("I'm asking $1.2M"), both
    fields stay null. Soft offers count: "I could offer around $700K" →
    700000. Ranges → midpoint rounded.
- The body field may contain the seller's reply only or a full email
    thread. Identify which lines are Ryan's (look for "From: Ryan" or his
    sign-off "— Ryan" / "Ryan LaRocca"). If you can't tell who said the
    number, default to null.`

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "anthropic/claude-haiku-4-5",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 200,
      }),
    })

    if (!res.ok) {
      console.error(`[triage-email] OpenRouter failed ${res.status}: ${(await res.text()).slice(0, 300)}`)
      return null
    }

    const json = await res.json() as { choices?: { message?: { content?: string } }[] }
    const content = json.choices?.[0]?.message?.content?.trim()
    if (!content) return null

    const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim()
    const parsed = JSON.parse(cleaned) as {
      temperature?: string
      is_dead?: unknown
      summary?: string
      suggestedReply?: string
      offer_amount?: unknown
      offer_verbalized?: unknown
    }
    if (
      !parsed.temperature ||
      !(VALID_TEMPERATURES as readonly string[]).includes(parsed.temperature)
    ) {
      return null
    }
    if (!parsed.summary || typeof parsed.summary !== "string") return null
    if (!parsed.suggestedReply || typeof parsed.suggestedReply !== "string") return null

    return {
      temperature: parsed.temperature as Temperature,
      is_dead: parsed.is_dead === true,
      summary: parsed.summary.trim(),
      suggestedReply: parsed.suggestedReply.trim(),
      offer_amount:
        typeof parsed.offer_amount === "number" && Number.isFinite(parsed.offer_amount) && parsed.offer_amount > 0
          ? parsed.offer_amount
          : null,
      offer_verbalized: parsed.offer_verbalized === true,
    }
  } catch (e) {
    console.error("[triage-email] Threw:", e)
    return null
  }
}
