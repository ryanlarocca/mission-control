import { NextResponse } from "next/server"
import { waitUntil } from "@vercel/functions"
import { createHmac, timingSafeEqual } from "crypto"
import WebSocket from "ws"
import { sendTelegramAlert } from "@/lib/leads"
import {
  VOICE_TEST_BACKEND_EFFORT,
  VOICE_TEST_BACKEND_MODEL,
  VOICE_TEST_GREETING,
  VOICE_TEST_OPENER,
  VOICE_TEST_INSTRUCTIONS,
  VOICE_TEST_MODEL,
  VOICE_TEST_OWNER_CELL,
  VOICE_TEST_COACH_NOTE,
  VOICE_TEST_VOICE,
  callbackTimingNote,
  callerIdNote,
  pickAuditionVoice,
} from "@/lib/voiceTest"

// OpenAI project webhook for the GPT-Live phone test line (lib/voiceTest.ts).
// Twilio's SIP trunk sends 408-337-2785 calls to OpenAI; OpenAI POSTs
// `live.transport.incoming` here and holds the call until we accept it.
// Public path (middleware) — authenticity is the Standard Webhooks signature,
// checked against OPENAI_VOICE_WEBHOOK_SECRET.

const OPENAI_BASE = "https://api.openai.com/v1"

// Room for the opener sideband (waitUntil) after the webhook response.
export const maxDuration = 30

function voiceApiKey(): string | undefined {
  // Dedicated key once Ryan creates one; the shared Whisper key until then.
  return process.env.OPENAI_VOICE_API_KEY || process.env.OPENAI_API_KEY
}

// Standard Webhooks: base64 HMAC-SHA256 of `${id}.${timestamp}.${body}`,
// keyed with the base64 secret after its `whsec_` prefix. The header may carry
// several space-separated `v1,<sig>` entries during secret rotation.
function signatureValid(secret: string, id: string, ts: string, body: string, header: string): boolean {
  const age = Math.abs(Date.now() / 1000 - Number(ts))
  if (!Number.isFinite(age) || age > 300) return false
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64")
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest()
  return header.split(" ").some((part) => {
    const [version, sig] = part.split(",")
    if (version !== "v1" || !sig) return false
    const got = Buffer.from(sig, "base64")
    return got.length === expected.length && timingSafeEqual(got, expected)
  })
}

function callerFrom(sipHeaders: unknown): string {
  if (!Array.isArray(sipHeaders)) return ""
  const from = sipHeaders.find((h) => typeof h?.name === "string" && h.name.toLowerCase() === "from")
  const match = typeof from?.value === "string" ? from.value.match(/\+?\d{10,15}/) : null
  return match ? (match[0].startsWith("+") ? match[0] : `+${match[0]}`) : ""
}

// The startup developer message only *suggests* a greeting; on 10-25 Jackie
// sat silent until Ryan spoke, three calls running. `session.instructions.append`
// didn't help either — the model treats it as a rule for its NEXT reply.
// OpenAI's documented "greet before the caller speaks" path is
// `session.commentary.append` on a sideband. We send it, watch the reflected
// output for her first sound, nudge once more at 4 s if she's still quiet,
// and log the timeline (console + Telegram while tuning).
async function sendOpener(sessionId: string, apiKey: string, timing: string[], t0: number): Promise<void> {
  const mark = (label: string) => timing.push(`${label} +${((Date.now() - t0) / 1000).toFixed(1)}s`)
  const url = `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`
  const outcome = await new Promise<string>((resolve) => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } })
    let sent = false
    let spoke = false
    let nudges = 0
    let nudge: ReturnType<typeof setTimeout> | undefined
    const done = (result: string) => {
      clearTimeout(timer)
      if (nudge) clearTimeout(nudge)
      try { ws.close() } catch { /* already closed */ }
      resolve(result)
    }
    const greet = () => {
      nudges += 1
      mark(`greet #${nudges}`)
      ws.send(JSON.stringify({
        type: "session.commentary.append",
        event_id: `opener_${nudges}_${Date.now()}`,
        delegation_id: null,
        content: nudges === 1
          ? VOICE_TEST_GREETING
          : `The caller is on the line and waiting in silence. Speak first, right now: say "${VOICE_TEST_OPENER}" and then listen.`,
      }))
    }
    const timer = setTimeout(() => done(spoke ? "ok" : sent ? "silent after greeting" : "timeout before send"), 14000)
    ws.on("open", () => {
      mark("sideband open")
      sent = true
      greet()
      nudge = setTimeout(() => { if (!spoke) greet() }, 4000)
    })
    ws.on("message", (raw) => {
      let msg: { type?: string; error?: { message?: string } } = {}
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg.type === "session.output_audio.delta" || msg.type === "session.output_transcript.delta") {
        if (!spoke) { spoke = true; mark("Jackie speaking"); done("ok") }
      } else if (msg.type === "error") {
        done(`error: ${msg.error?.message ?? "unknown"}`)
      }
    })
    ws.on("error", (e) => done(`socket error: ${e.message}`))
    ws.on("close", (code) => done(spoke ? "ok" : sent ? `closed ${code} after greeting` : `closed ${code} before send`))
  })
  const line = `${timing.join(" · ")} · result: ${outcome}`
  console.log(`[voice-test] ${line}`)
  await sendTelegramAlert(`🧪 Test line timing: ${line}`)
  if (outcome !== "ok") {
    console.error(`[voice-test] opener not delivered: ${outcome}`)
  }
}

export async function POST(request: Request) {
  const t0 = Date.now()
  const body = await request.text()

  const secret = process.env.OPENAI_VOICE_WEBHOOK_SECRET
  if (!secret) {
    console.error("[voice-test] OPENAI_VOICE_WEBHOOK_SECRET not set; refusing webhook")
    return new NextResponse("not configured", { status: 503 })
  }
  const ok = signatureValid(
    secret,
    request.headers.get("webhook-id") || "",
    request.headers.get("webhook-timestamp") || "",
    body,
    request.headers.get("webhook-signature") || "",
  )
  if (!ok) return new NextResponse("bad signature", { status: 400 })

  let event: { type?: string; created_at?: number; data?: { session_id?: string; call_id?: string; sip_headers?: unknown } }
  try {
    event = JSON.parse(body)
  } catch {
    return new NextResponse("bad json", { status: 400 })
  }

  // `live.call.incoming` is the deprecated name. The project webhook may be
  // subscribed to Realtime's `realtime.call.incoming` instead (the dashboard
  // defaults to it); that event carries `call_id`, which we try as the Live
  // session id — a refusal surfaces in Telegram with OpenAI's reason.
  const known = ["live.transport.incoming", "live.call.incoming", "realtime.call.incoming"]
  if (!event.type || !known.includes(event.type)) {
    return NextResponse.json({ ignored: event.type ?? null })
  }

  const sessionId = event.data?.session_id || event.data?.call_id
  const apiKey = voiceApiKey()
  if (!sessionId || !apiKey) {
    console.error("[voice-test] missing session id or API key", { sessionId: !!sessionId, apiKey: !!apiKey })
    return new NextResponse("unusable event", { status: 500 })
  }

  const caller = callerFrom(event.data?.sip_headers)
  const timing: string[] = []

  // Voice audition: Ryan's cell rotates through lib/voiceTest VOICE_AUDITION.
  let voice = VOICE_TEST_VOICE
  if (caller === VOICE_TEST_OWNER_CELL) {
    try {
      const pick = await pickAuditionVoice(sessionId)
      if (pick) {
        voice = pick.voice
        timing.push(`🎙️ ${pick.voice} (audition ${pick.index + 1} of ${pick.total})`)
      }
    } catch (e) {
      console.error(`[voice-test] audition lookup failed: ${e instanceof Error ? e.message : e}`)
    }
  }

  if (event.created_at) timing.push(`OpenAI→us ${(t0 / 1000 - event.created_at).toFixed(1)}s`)
  const instructions =
    VOICE_TEST_INSTRUCTIONS +
    callerIdNote(caller) +
    callbackTimingNote() +
    (caller === VOICE_TEST_OWNER_CELL ? VOICE_TEST_COACH_NOTE : "")
  const accept = (withVoice: string) =>
    fetch(`${OPENAI_BASE}/live/sessions/${encodeURIComponent(sessionId)}/accept`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        session: {
          type: "live",
          model: VOICE_TEST_MODEL,
          instructions,
          audio: { output: { voice: withVoice } },
          delegation: {
            type: "responses",
            responses: { model: VOICE_TEST_BACKEND_MODEL, reasoning: { effort: VOICE_TEST_BACKEND_EFFORT } },
          },
          input: [
            { type: "message", role: "developer", content: [{ type: "input_text", text: VOICE_TEST_GREETING }] },
          ],
        },
      }),
    })
  let res = await accept(voice)

  // GPT-Live's voice list isn't published — if it refuses an audition voice,
  // pick up in the default voice rather than leave Ryan in silence.
  if (!res.ok && voice !== VOICE_TEST_VOICE) {
    const detail = (await res.text()).slice(0, 200)
    if (detail.includes("decision_already_made")) return NextResponse.json({ duplicate: true })
    timing.push(`⚠️ ${voice} refused (${res.status}: ${detail}) → ${VOICE_TEST_VOICE}`)
    voice = VOICE_TEST_VOICE
    res = await accept(voice)
  }

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300)
    // A duplicate delivery of an already-accepted call is fine.
    if (detail.includes("decision_already_made")) return NextResponse.json({ duplicate: true })
    console.error(`[voice-test] accept failed ${res.status}: ${detail}`)
    await sendTelegramAlert(`⚠️ AI test line: OpenAI refused to pick up (${res.status}, event ${event.type}) — caller ${caller || "unknown"}\n${detail}`)
    return NextResponse.json({ accepted: false })
  }

  timing.push(`accepted +${((Date.now() - t0) / 1000).toFixed(1)}s`)
  waitUntil(sendOpener(sessionId, apiKey, timing, t0))

  if (caller && caller !== VOICE_TEST_OWNER_CELL) {
    await sendTelegramAlert(`🤖 Someone other than Ryan reached the AI test line (408-337-2785): ${caller}. Recording is on the Twilio trunk.`)
  }
  return NextResponse.json({ accepted: true })
}
