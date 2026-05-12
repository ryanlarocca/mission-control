import { NextResponse } from "next/server"
import { getLeadsClient, sendTelegramAlert } from "@/lib/leads"

// Cron-driven rescue for orphaned call/voicemail rows.
//
// Why this exists: voice/route.ts relies on Twilio's recordingStatusCallback
// to attach the recording_url after a Dial-record completes. That callback
// fires unreliably (see no-answer/route.ts header comment) — calls into
// the outbound caller-ID number especially have been dropping recordings.
// Until we have a deterministic per-call SID lookup, this cron sweeps for
// `lead_type IN ('call','voicemail') AND recording_url IS NULL` rows older
// than ~5 min, finds the matching Twilio Recording by From/To, and replays
// the webhook against /api/leads/voice/recording so the existing pipeline
// (attach → Whisper → AI → Telegram) runs end-to-end. Bounded to ~24h so
// repeated runs converge.
//
// Scheduled by vercel.json: */15 * * * * (every 15 minutes).
// Authenticated by Vercel Cron's standard Authorization: Bearer <CRON_SECRET>.

const TWILIO_API = "https://api.twilio.com/2010-04-01"
const PROD_BASE = "https://mission-control-three-chi.vercel.app"
const LOOKBACK_HOURS = 24
const MIN_AGE_MIN = 5 // skip rows newer than this so we don't race with Twilio

interface TwilioRecording {
  sid: string
  call_sid: string
  date_created: string
  duration: string | number | null
}
interface TwilioCall {
  sid: string
  from: string
  to: string
  date_created: string
}

export async function GET(request: Request) {
  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Reject anything
  // else so the route can't be abused (it spends Twilio API calls + triggers
  // Whisper jobs).
  const expected = process.env.CRON_SECRET
  const auth = request.headers.get("authorization") || ""
  if (!expected || auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  const twSid = process.env.TWILIO_ACCOUNT_SID
  const twToken = process.env.TWILIO_AUTH_TOKEN
  if (!twSid || !twToken) {
    return NextResponse.json({ error: "twilio creds missing" }, { status: 500 })
  }
  const twAuth = Buffer.from(`${twSid}:${twToken}`).toString("base64")

  const sb = getLeadsClient()
  const sinceIso = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString()
  const cutoffIso = new Date(Date.now() - MIN_AGE_MIN * 60 * 1000).toISOString()

  // ── 1. Pull orphans ────────────────────────────────────────────────────────
  const { data: orphans, error } = await sb
    .from("leads")
    .select("id, caller_phone, twilio_number, lead_type, created_at, name")
    .is("recording_url", null)
    .in("lead_type", ["call", "voicemail"])
    .gte("created_at", sinceIso)
    .lt("created_at", cutoffIso)
    .order("created_at", { ascending: false })
  if (error) {
    console.error("[cron/rescue] orphan query failed:", error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!orphans || orphans.length === 0) {
    return NextResponse.json({ ok: true, orphans: 0, matched: 0, rescued: 0 })
  }

  // ── 2. Pull recordings in the window (paginate if needed) ──────────────────
  const recordings: TwilioRecording[] = []
  let nextUrl: string | null = `${TWILIO_API}/Accounts/${twSid}/Recordings.json?DateCreatedAfter=${encodeURIComponent(sinceIso)}&PageSize=200`
  while (nextUrl) {
    const r = await fetch(nextUrl, { headers: { Authorization: `Basic ${twAuth}` } })
    if (!r.ok) {
      console.error(`[cron/rescue] Twilio Recordings ${r.status}`)
      return NextResponse.json({ error: "twilio recordings query failed" }, { status: 502 })
    }
    const body = await r.json() as { recordings?: TwilioRecording[]; next_page_uri?: string | null }
    recordings.push(...(body.recordings || []))
    nextUrl = body.next_page_uri ? `https://api.twilio.com${body.next_page_uri}` : null
  }

  // ── 3. Fetch each unique Call once (for From/To matching) ─────────────────
  const uniqueCallSids = Array.from(new Set(recordings.map(r => r.call_sid).filter(Boolean)))
  const callBySid = new Map<string, TwilioCall>()
  await Promise.all(uniqueCallSids.map(async (callSid) => {
    try {
      const cr = await fetch(`${TWILIO_API}/Accounts/${twSid}/Calls/${callSid}.json`, {
        headers: { Authorization: `Basic ${twAuth}` },
      })
      if (cr.ok) callBySid.set(callSid, await cr.json() as TwilioCall)
    } catch (e) {
      console.warn(`[cron/rescue] call ${callSid} lookup threw:`, e instanceof Error ? e.message : String(e))
    }
  }))

  // ── 4. Match orphans to recordings ────────────────────────────────────────
  interface Plan { orphan: typeof orphans[number]; recording: TwilioRecording; deltaSec: number }
  const plan: Plan[] = []
  for (const o of orphans) {
    const orphanTs = new Date(o.created_at).getTime()
    let best: { recording: TwilioRecording; deltaSec: number } | null = null
    for (const rec of recordings) {
      const call = callBySid.get(rec.call_sid)
      if (!call) continue
      if (call.from !== o.caller_phone) continue
      if (o.twilio_number && call.to !== o.twilio_number) continue
      const deltaSec = Math.round((new Date(rec.date_created).getTime() - orphanTs) / 1000)
      if (Math.abs(deltaSec) > 3600) continue
      if (!best || Math.abs(deltaSec) < Math.abs(best.deltaSec)) {
        best = { recording: rec, deltaSec }
      }
    }
    if (best) plan.push({ orphan: o, ...best })
  }

  // ── 5. Replay webhook for each match ──────────────────────────────────────
  // Serial with a 1.5s gap to avoid piling waitUntil(Whisper+AI) jobs on Vercel.
  let rescued = 0
  const errors: string[] = []
  for (const p of plan) {
    await sb.from("leads").update({ recording_url: null }).eq("id", p.orphan.id)
    const recordingBaseUrl = `${TWILIO_API}/Accounts/${twSid}/Recordings/${p.recording.sid}`
    const form = new URLSearchParams({
      RecordingUrl: recordingBaseUrl,
      RecordingSid: p.recording.sid,
      RecordingDuration: String(p.recording.duration ?? ""),
      From: p.orphan.caller_phone || "",
      To: p.orphan.twilio_number || "",
      CallSid: p.recording.call_sid,
    })
    try {
      const wr = await fetch(`${PROD_BASE}/api/leads/voice/recording`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      })
      if (wr.ok) rescued++
      else errors.push(`${p.orphan.id}: HTTP ${wr.status}`)
    } catch (e) {
      errors.push(`${p.orphan.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
    await new Promise(r => setTimeout(r, 1500))
  }

  // ── 6. Telegram summary (only when something was rescued or errored) ──────
  if (rescued > 0 || errors.length > 0) {
    const lines = [`🚑 Orphan-recording cron: ${rescued}/${plan.length} rescued (${orphans.length} orphans, ${plan.length - rescued} failed/unmatched)`]
    if (errors.length > 0) lines.push(`Errors: ${errors.slice(0, 3).join("; ")}`)
    void sendTelegramAlert(lines.join("\n"))
  }

  return NextResponse.json({
    ok: true,
    orphans: orphans.length,
    matched: plan.length,
    rescued,
    errors,
  })
}
