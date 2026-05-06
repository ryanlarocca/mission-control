import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { google, gmail_v1 } from "googleapis"
import emailCampaigns from "@/config/email-campaigns.json"

export const CAMPAIGN_MAP: Record<string, string> = {
  "+16504364279": "MFM-A",
  "+16506803671": "MFM-B",
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

// Phase 7C lifecycle. Statuses are mutually exclusive stages in the funnel;
// DNC / Junk / Bad-Number live as separate boolean flags on the lead row so
// they can stack on top of any lifecycle stage (e.g. `warm` + `is_bad_number`
// → drip drops phone touches but keeps emailing). Older 7B statuses
// (qualified / unqualified / do_not_contact / junk) are remapped at migration
// time and are no longer accepted by the API.
export type LeadStatus =
  | "new"
  | "contacted"
  | "active"
  | "hot"
  | "warm"
  | "nurture"
  | "dead"

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
}

// Lifecycle statuses — must match the lib/leads.ts LeadStatus union.
export const VALID_LEAD_STATUSES: readonly LeadStatus[] = [
  "new",
  "contacted",
  "active",
  "hot",
  "warm",
  "nurture",
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

// AI auto-triage: classify a transcribed call/voicemail and produce a short
// summary. Returns null on any failure so the caller can leave the lead as
// "new" and surface it to Ryan untouched.
export interface TriageResult {
  status: LeadStatus
  summary: string
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
          const { error } = await sb
            .from("leads")
            .update({ message: transcription })
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
    }

    // AI auto-triage is only meaningful for inbound recordings — for
    // outbound calls Ryan already knows what the conversation was about
    // and the row was inserted with status="contacted", not "new".
    let triage: TriageResult | null = null
    if (direction === "inbound" && transcription && leadId) {
      try {
        const sb = getLeadsClient()
        const { data: currentLead } = await sb
          .from("leads")
          .select("status")
          .eq("id", leadId)
          .single()

        if (currentLead?.status === "new") {
          triage = await triageLeadFromTranscript(transcription)
          if (triage) {
            const { error } = await sb
              .from("leads")
              .update({ status: triage.status, ai_notes: triage.summary })
              .eq("id", leadId)
            if (error) console.error("[triage] Update failed:", error)
            else console.log(`[triage] Lead ${leadId} → ${triage.status}: ${triage.summary}`)
          }
        } else {
          // Phase 7C — Part 4: lead has been classified before, so don't
          // overwrite its status. Run analyze-call which writes to
          // suggested_status (training wheels) plus follow-up fields. Ryan
          // confirms via banner in the UI.
          const analysis = await analyzeCallTranscript(transcription)
          if (analysis) {
            await applyAnalyzeCallResult(leadId, analysis)
            console.log(`[analyze-call] Lead ${leadId} suggested → ${analysis.status}: ${analysis.reason}`)
          }
        }
      } catch (e) {
        console.error("[triage] Threw:", e)
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
    if (triage) {
      captionLines.push("", `🤖 AI: <b>${triage.status.toUpperCase()}</b> — ${triage.summary}`)
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

// Brief summary of an outbound call. The inbound flow uses
// `triageLeadFromTranscript` which classifies AND summarizes — but for
// outbound, Ryan made the call and already knows the classification, so
// we only need a short "what was discussed / next steps" line for the
// timeline + ai_notes.
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

export async function triageLeadFromTranscript(
  transcription: string
): Promise<TriageResult | null> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    console.warn("[triage] OPENROUTER_API_KEY not set; skipping auto-triage")
    return null
  }

  const prompt = `You are an AI assistant for a real estate investor. Analyze this call/voicemail transcript and classify the lead.

TRANSCRIPT:
"${transcription}"

CLASSIFICATION (pick exactly one):
- hot: Caller expressed clear intent to sell now or within 1-2 months
- warm: Caller is interested, 3-6 month timeline, open to discussion
- nurture: Caller is curious but no clear timeline — long-term/maybe someday
- dead: Wrong number, spam, hostile, or explicit "do not contact"

Respond in this exact JSON format (no markdown, no explanation):
{"status": "<hot|warm|nurture|dead>", "summary": "<1-2 sentence summary of what the caller said/wanted>"}`

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
        max_tokens: 150,
      }),
    })

    if (!res.ok) {
      console.error(`[triage] OpenRouter failed ${res.status}: ${(await res.text()).slice(0, 300)}`)
      return null
    }

    const json = await res.json() as { choices?: { message?: { content?: string } }[] }
    const content = json.choices?.[0]?.message?.content?.trim()
    if (!content) return null

    // Strip markdown fences if the model wrapped the JSON.
    const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim()

    const parsed = JSON.parse(cleaned) as { status?: string; summary?: string }
    const validStatuses = ["hot", "warm", "nurture", "dead"]
    if (!parsed.status || !validStatuses.includes(parsed.status)) return null
    if (!parsed.summary || typeof parsed.summary !== "string") return null

    return { status: parsed.status as LeadStatus, summary: parsed.summary.trim() }
  } catch (e) {
    console.error("[triage] Threw:", e)
    return null
  }
}

// Phase 7C — Part 4 shared helper. Classifies a transcript, stores the
// result in suggested_status / suggested_status_reason / followup fields
// (training-wheels mode) or applies it directly when AUTO_STATUS=true,
// invalidates the AI summary cache so the next view regenerates, and
// fires a Telegram nudge. Returns true on success, false on failure
// (caller can log; this is non-fatal background work).
//
// Used by both /api/leads/[id]/analyze-call (manual / Ryan-driven) and
// processRecordingBackground (auto-trigger on subsequent recordings of
// already-classified leads).
const ANALYSIS_PROMPT_STATUSES = ["hot", "warm", "nurture", "dead", "contacted"] as const
type AnalysisPromptStatus = (typeof ANALYSIS_PROMPT_STATUSES)[number]

export interface AnalyzeCallResult {
  status: AnalysisPromptStatus
  reason: string
  recommended_followup_date: string | null
  followup_reason: string | null
}

export async function analyzeCallTranscript(
  transcript: string
): Promise<AnalyzeCallResult | null> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    console.warn("[analyze-call] OPENROUTER_API_KEY not set; skipping")
    return null
  }
  const prompt = `You are classifying a real estate seller lead based on a phone call transcript.
Ryan is a cash home buyer. The caller is a property owner.

Classify into exactly ONE status:
- hot: Actively wants to sell now or within 1-2 months. Motivated.
- warm: Open to selling in 3-6 months. Not urgent but interested.
- nurture: Longer term (6+ months), curious but no timeline. "Maybe someday."
- dead: Explicitly not interested. "Don't call me." "Not selling." No ambiguity.
- contacted: Inconclusive call. Brief, couldn't determine interest level.

Also extract:
- recommended_followup_date: When Ryan should call back (ISO date YYYY-MM-DD, or null if dead)
- followup_reason: One sentence why that date

Respond as JSON only:
{ "status": "...", "reason": "...", "recommended_followup_date": "YYYY-MM-DD" | null, "followup_reason": "..." }

TRANSCRIPT:
"${transcript}"`

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/claude-haiku-4-5",
        max_tokens: 250,
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
    if (!parsed.status || !(ANALYSIS_PROMPT_STATUSES as readonly string[]).includes(parsed.status)) return null
    if (!parsed.reason || typeof parsed.reason !== "string") return null
    return {
      status: parsed.status as AnalysisPromptStatus,
      reason: parsed.reason.trim(),
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

// Persist the analysis result against a lead. Honors AUTO_STATUS env var
// (when "true", applies the suggestion directly to status; otherwise
// writes to suggested_status for Ryan to confirm in the UI).
export async function applyAnalyzeCallResult(
  leadId: string,
  result: AnalyzeCallResult
): Promise<void> {
  const sb = getLeadsClient()
  const autoApply = process.env.AUTO_STATUS === "true"
  const lifecycleStatus =
    result.status !== "contacted" ? (result.status as LeadStatus) : null
  const update: Record<string, unknown> = {
    ai_summary: null,
    ai_summary_generated_at: null,
    followup_generated_at: new Date().toISOString(),
    recommended_followup_date: result.recommended_followup_date,
    followup_reason: result.followup_reason,
  }
  if (autoApply && lifecycleStatus) {
    update.status = lifecycleStatus
    update.suggested_status = null
    update.suggested_status_reason = null
  } else if (lifecycleStatus) {
    update.suggested_status = lifecycleStatus
    update.suggested_status_reason = result.reason
  }
  const { error } = await sb.from("leads").update(update).eq("id", leadId)
  if (error) console.error(`[analyze-call] update failed for ${leadId}:`, error.message)
}

// Email-lead triage — same Haiku model as the call/voicemail path, but the
// prompt is tuned for written replies and also asks the model to draft a
// short text-message-style reply that Ryan can edit and send from the
// lead card. Returns null on any failure (non-fatal).
export interface EmailTriageResult {
  status: LeadStatus
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
  "status": "hot" | "warm" | "nurture" | "dead",
  "summary": "one sentence summary",
  "suggestedReply": "a short, natural text-message-style reply Ryan can send. Warm, direct, no fluff. 1-2 sentences max."
}

hot = wants to sell now or requesting immediate callback
warm = interested, has a property, wants info, 3-6 month timeline
nurture = curious, longer term, no urgency
dead = spam, wrong number, unsubscribe, hostile`

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
      status?: string
      summary?: string
      suggestedReply?: string
    }
    const validStatuses = ["hot", "warm", "nurture", "dead"]
    if (!parsed.status || !validStatuses.includes(parsed.status)) return null
    if (!parsed.summary || typeof parsed.summary !== "string") return null
    if (!parsed.suggestedReply || typeof parsed.suggestedReply !== "string") return null

    return {
      status: parsed.status as LeadStatus,
      summary: parsed.summary.trim(),
      suggestedReply: parsed.suggestedReply.trim(),
    }
  } catch (e) {
    console.error("[triage-email] Threw:", e)
    return null
  }
}
