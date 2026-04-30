import { createClient, type SupabaseClient } from "@supabase/supabase-js"

export const CAMPAIGN_MAP: Record<string, string> = {
  "+16504364279": "MFM-A",
  "+16506803671": "MFM-B",
}

export const FORWARD_TO = "+14085006293"

export type LeadType = "call" | "voicemail" | "sms" | "form"
export type LeadStatus = "new" | "hot" | "qualified" | "warm" | "junk" | "contacted"

// Conventions (no extra columns — keeps schema simple):
//   - `message` holds the text content of the event regardless of type:
//       SMS rows       → the SMS body (inbound or outbound)
//       voicemail rows → the Whisper transcription (also live-call recordings)
//       call rows      → null until the recording callback attaches transcript
//   - `twilio_number IS NULL` means the row is outbound (sent via the
//     iMessage sidecar, not Twilio). All inbound rows have twilio_number set.
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
- hot: Caller expressed clear intent to sell their property or meet with the investor
- qualified: Caller is interested but not urgent — wants more info, open to discussion
- warm: Caller is neutral or curious — returning a call, asking what the mailer was about
- junk: Wrong number, not interested in selling, spam, or irrelevant

Respond in this exact JSON format (no markdown, no explanation):
{"status": "<hot|qualified|warm|junk>", "summary": "<1-2 sentence summary of what the caller said/wanted>"}`

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
    const validStatuses = ["hot", "qualified", "warm", "junk"]
    if (!parsed.status || !validStatuses.includes(parsed.status)) return null
    if (!parsed.summary || typeof parsed.summary !== "string") return null

    return { status: parsed.status as LeadStatus, summary: parsed.summary.trim() }
  } catch (e) {
    console.error("[triage] Threw:", e)
    return null
  }
}
