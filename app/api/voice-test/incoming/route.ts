import { NextResponse } from "next/server"
import { createHmac, timingSafeEqual } from "crypto"
import { sendTelegramAlert } from "@/lib/leads"
import {
  VOICE_TEST_BACKEND_MODEL,
  VOICE_TEST_GREETING,
  VOICE_TEST_INSTRUCTIONS,
  VOICE_TEST_MODEL,
  VOICE_TEST_OWNER_CELL,
  VOICE_TEST_VOICE,
} from "@/lib/voiceTest"

// OpenAI project webhook for the GPT-Live phone test line (lib/voiceTest.ts).
// Twilio's SIP trunk sends 408-337-2785 calls to OpenAI; OpenAI POSTs
// `live.transport.incoming` here and holds the call until we accept it.
// Public path (middleware) — authenticity is the Standard Webhooks signature,
// checked against OPENAI_VOICE_WEBHOOK_SECRET.

const OPENAI_BASE = "https://api.openai.com/v1"

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

export async function POST(request: Request) {
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

  let event: { type?: string; data?: { session_id?: string; call_id?: string; sip_headers?: unknown } }
  try {
    event = JSON.parse(body)
  } catch {
    return new NextResponse("bad json", { status: 400 })
  }

  // `live.call.incoming` is the deprecated name. Realtime's
  // `realtime.call.incoming` can fire for the same call — ignore it so only
  // one handler makes the accept decision.
  if (event.type !== "live.transport.incoming" && event.type !== "live.call.incoming") {
    return NextResponse.json({ ignored: event.type ?? null })
  }

  const sessionId = event.data?.session_id || event.data?.call_id
  const apiKey = voiceApiKey()
  if (!sessionId || !apiKey) {
    console.error("[voice-test] missing session id or API key", { sessionId: !!sessionId, apiKey: !!apiKey })
    return new NextResponse("unusable event", { status: 500 })
  }

  const res = await fetch(`${OPENAI_BASE}/live/sessions/${encodeURIComponent(sessionId)}/accept`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      session: {
        type: "live",
        model: VOICE_TEST_MODEL,
        instructions: VOICE_TEST_INSTRUCTIONS,
        audio: { output: { voice: VOICE_TEST_VOICE } },
        delegation: { type: "responses", responses: { model: VOICE_TEST_BACKEND_MODEL } },
        input: [
          { type: "message", role: "developer", content: [{ type: "input_text", text: VOICE_TEST_GREETING }] },
        ],
      },
    }),
  })

  const caller = callerFrom(event.data?.sip_headers)
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300)
    // A duplicate delivery of an already-accepted call is fine.
    if (detail.includes("decision_already_made")) return NextResponse.json({ duplicate: true })
    console.error(`[voice-test] accept failed ${res.status}: ${detail}`)
    await sendTelegramAlert(`⚠️ AI test line: OpenAI refused to pick up (${res.status}) — caller ${caller || "unknown"}\n${detail}`)
    return NextResponse.json({ accepted: false })
  }

  if (caller && caller !== VOICE_TEST_OWNER_CELL) {
    await sendTelegramAlert(`🤖 Someone other than Ryan reached the AI test line (408-337-2785): ${caller}. Recording is on the Twilio trunk.`)
  }
  return NextResponse.json({ accepted: true })
}
