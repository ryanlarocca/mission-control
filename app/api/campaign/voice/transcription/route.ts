import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { sendCampaignAlert } from "@/lib/campaignAlerts"

// Agents line — voicemail transcription callback (Twilio <Record
// transcribe>). Fires a minute or so after the recording callback with the
// text. Attaches the transcript to the voicemail event (matched by
// CallSid) and follows up on Telegram so Ryan reads instead of listens.
// Twilio only transcribes 2–120s English recordings; failures alert too —
// no silent outcomes (2026-07-30, Ryan asked for transcription).

export const dynamic = "force-dynamic"

function esc(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

export async function POST(request: NextRequest) {
  let params: URLSearchParams
  try {
    params = new URLSearchParams(await request.text())
  } catch {
    params = new URLSearchParams()
  }
  const status = params.get("TranscriptionStatus") || ""
  const text = (params.get("TranscriptionText") || "").trim()
  const callSid = params.get("CallSid") || ""

  const sb = getLeadsClient()
  // The voicemail event for this call — logged by the recording callback.
  const { data: vms } = await sb
    .from("campaign_events")
    .select("id, contact_id, caller_number")
    .eq("kind", "voicemail")
    .filter("raw->>call_sid", "eq", callSid)
    .order("occurred_at", { ascending: false })
    .limit(1)
  const vm = vms?.[0] ?? null

  let who = "unknown number"
  if (vm?.caller_number && vm.caller_number.length === 10) {
    const n = vm.caller_number
    who = `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`
  }
  if (vm?.contact_id) {
    const { data: c } = await sb.from("campaign_contacts").select("name").eq("id", vm.contact_id).limit(1)
    if (c?.[0]?.name) who = `${c[0].name} ${who === "unknown number" ? "" : who}`.trim()
  }

  if (status !== "completed" || !text) {
    await sendCampaignAlert(sb, `🎙 Voicemail from ${esc(who)} couldn't be transcribed (${esc(status || "no status")}) — use the recording link above.`)
    return NextResponse.json({ ok: true })
  }

  if (vm) {
    const { data: full } = await sb.from("campaign_events").select("raw").eq("id", vm.id).maybeSingle()
    await sb
      .from("campaign_events")
      .update({ raw: { ...((full?.raw ?? {}) as Record<string, unknown>), transcript: text } })
      .eq("id", vm.id)
  }
  await sendCampaignAlert(sb, `📝 <b>Voicemail transcript</b> — ${esc(who)}:\n"${esc(text.slice(0, 3200))}"`)
  return NextResponse.json({ ok: true })
}
