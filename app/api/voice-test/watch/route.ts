import { NextResponse } from "next/server"
import { waitUntil } from "@vercel/functions"
import { handoffSignatureValid, watchCall, type WatchHandoff } from "@/lib/voiceTestWatch"

// Next leg of a Jackie call's sideband watcher (lib/voiceTestWatch.ts): a
// call can outlast one 300 s function, so the running watcher POSTs its
// state here every 4 min and detaches. Public path (middleware covers
// /api/voice-test); authenticity = HMAC of the body.

export const maxDuration = 300

function voiceApiKey(): string | undefined {
  return process.env.OPENAI_VOICE_API_KEY || process.env.OPENAI_API_KEY
}

export async function POST(request: Request) {
  const body = await request.text()
  if (!handoffSignatureValid(body, request.headers.get("x-voice-watch-sig") || "")) {
    return new NextResponse("bad signature", { status: 401 })
  }
  let handoff: WatchHandoff
  try {
    handoff = JSON.parse(body)
  } catch {
    return new NextResponse("bad json", { status: 400 })
  }
  const apiKey = voiceApiKey()
  if (!handoff.sessionId || !handoff.state?.t0 || !apiKey) {
    return new NextResponse("unusable handoff", { status: 400 })
  }
  // Runaway guard: an 11-minute call needs 3 hops at most.
  if (handoff.hop > 4) return NextResponse.json({ refused: "too many hops" })
  waitUntil(watchCall({ sessionId: handoff.sessionId, apiKey, t0: handoff.state.t0, hop: handoff.hop, caller: handoff.caller ?? "", twilioCallSid: handoff.twilioCallSid, state: handoff.state }))
  return NextResponse.json({ watching: true }, { status: 202 })
}
