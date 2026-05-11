import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { google, gmail_v1 } from "googleapis"
import emailCampaigns from "@/config/email-campaigns.json"

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
// Phase 7C's transitional values (hot/warm/nurture as statuses) were remapped
// by phase7d-lifecycle-temperature.sql: hot/warm→active+temperature, nurture
// →contacted+cold.
export type LeadStatus =
  | "new"
  | "contacted"
  | "active"
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
  "dead",
] as const

// Boolean flags on a lead. Used by the API PATCH route to whitelist
// allowed body fields and by the UI to drive badges + button visibility.
export const LEAD_FLAG_FIELDS = ["is_dnc", "is_junk", "is_bad_number"] as const
export type LeadFlagField = typeof LEAD_FLAG_FIELDS[number]

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
  cached = createClient(url, key, { auth: { persistSession: false } })
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
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } })
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
    // Writes temperature + ai_summary + name + property_address + follow-up
    // (with 24h default if AI didn't return one). Lifecycle status is left
    // alone for Ryan to manage.
    let analysis: AnalyzeCallResult | null = null
    if (direction === "inbound" && transcription && leadId) {
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
  recommended_followup_date: string | null
  followup_reason: string | null
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

TODAY IS ${today}. All recommended_followup_date values must be on or after today.${historyBlock ? "\n\nExtract NAME and PROPERTY_ADDRESS from the full conversation (prior + fresh). Other fields (temperature, summary, follow-up) should reflect the FRESH transcript primarily, using prior context for continuity.\n" : ""}

Produce a JSON object with these fields:

- temperature: one of "hot" | "warm" | "cold"
    hot  = actively wants to sell now or within 1-2 months, motivated
    warm = interested, 3-6 month timeline, open to exploring
    cold = curious, no timeline, "maybe someday", or unclear / inconclusive
    (For an explicit "no / don't call me", still pick cold — Ryan controls
     the lifecycle dead status manually.)

- summary: a plain prose paragraph, 2 to 6 sentences. No headers, no bullets,
    no bold. Cover who the caller is, what their inquiry is about, any
    obvious next-step or urgency cue. Emojis allowed where natural, not
    required. Example: "Brian called about a property he owns at 2127 Los
    Gatos Almaden Rd. He didn't share a timeline but sounded open to
    exploring options and wants a callback. Worth a quick follow-up
    tomorrow morning."

- name: the caller's stated name (best-effort, even if audio was unclear).
    Null only if the transcript contains no name reference at all.

- property_address: any property address the caller mentioned (best-effort,
    even partial — Ryan can clean it up). Null only if no address was
    mentioned.

- recommended_followup_date: ISO date YYYY-MM-DD ≥ today, or null if the
    caller said "don't call me".

- followup_reason: one short sentence on why that date.

Respond with ONLY the JSON object — no markdown fences, no explanation.

{
  "temperature": "...",
  "summary": "...",
  "name": "..." | null,
  "property_address": "..." | null,
  "recommended_followup_date": "YYYY-MM-DD" | null,
  "followup_reason": "..." | null
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
      recommended_followup_date:
        typeof parsed.recommended_followup_date === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(parsed.recommended_followup_date)
          ? parsed.recommended_followup_date
          : null,
      followup_reason:
        typeof parsed.followup_reason === "string" && parsed.followup_reason.trim()
          ? parsed.followup_reason.trim()
          : null,
    }
  } catch (e) {
    console.error("[analyze-call] threw:", e)
    return null
  }
}

// Phase 7D — default follow-up window when the AI didn't return a date.
// Brian's Phase 7D root cause: the analyzer ran but didn't always produce a
// date, and the Follow-Up tab queries WHERE recommended_followup_date IS NOT
// NULL, so the lead never surfaced. Defaulting to T+24h guarantees every
// inbound-call lead shows up in the to-do bucket — Ryan can snooze/clear if
// the AI's pick was off.
const DEFAULT_FOLLOWUP_DAYS = 1
const DEFAULT_FOLLOWUP_REASON = "Initial follow-up after inbound call."

function defaultFollowupDate(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + DEFAULT_FOLLOWUP_DAYS)
  return d.toISOString().slice(0, 10)
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
  const followupDate = result.recommended_followup_date ?? defaultFollowupDate()
  const followupReason = result.followup_reason ?? DEFAULT_FOLLOWUP_REASON

  const { data: existing } = await sb
    .from("leads")
    .select("name, property_address")
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

  const { error } = await sb.from("leads").update(update).eq("id", leadId)
  if (error) console.error(`[followup-only] update failed for ${leadId}:`, error.message)
}

// Phase 7D — persist the unified analyzer result. Writes:
//   - temperature           (AI-controlled badge)
//   - ai_summary            (short paragraph, replaces the verbose cached one)
//   - ai_summary_generated_at
//   - name + property_address (best-effort; only fills if the AI returned
//     a value AND the column is currently empty — never overwrites a
//     hand-corrected value)
//   - recommended_followup_date + followup_reason (defaulted to T+24h /
//     "Initial follow-up after inbound call." when AI didn't return them)
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
    .select("name, property_address, caller_phone, email")
    .eq("id", leadId)
    .maybeSingle()

  const update: Record<string, unknown> = {
    temperature: result.temperature,
    ai_summary: result.summary,
    ai_summary_generated_at: new Date().toISOString(),
    recommended_followup_date: result.recommended_followup_date ?? defaultFollowupDate(),
    followup_reason: result.followup_reason ?? DEFAULT_FOLLOWUP_REASON,
    followup_generated_at: new Date().toISOString(),
    suggested_status: null,
    suggested_status_reason: null,
  }
  if (result.name && !existing?.name) update.name = result.name
  if (result.property_address && !existing?.property_address) {
    update.property_address = result.property_address
  }

  const { error } = await sb.from("leads").update(update).eq("id", leadId)
  if (error) console.error(`[analyze-call] update failed for ${leadId}:`, error.message)

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
  "suggestedReply": "a short, natural text-message-style reply Ryan can send. Warm, direct, no fluff. 1-2 sentences max."
}

temperature:
  hot  = wants to sell now or requesting immediate callback
  warm = interested, has a property, wants info, 3-6 month timeline
  cold = curious, longer term, no urgency

is_dead: true ONLY for spam / wrong number / explicit unsubscribe / hostile.
  Default false. Use this flag, not temperature, to mark a lead as dead.`

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
    }
  } catch (e) {
    console.error("[triage-email] Threw:", e)
    return null
  }
}
