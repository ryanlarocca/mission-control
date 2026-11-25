// Model bake-off option 3 (Ryan, 11-25): Jackie's script on gpt-realtime-2.1.
// Realtime models can't run on GPT-Live sessions, so this call is accepted
// through the Realtime SIP API instead: OpenAI's `realtime.call.incoming`
// webhook (data.call_id) → POST /v1/realtime/calls/{call_id}/accept, then a
// sideband socket (wss …/v1/realtime?call_id=…) to make her pick up first.
// The same pending call also emits live.transport.incoming; the incoming
// route lets exactly one of the two accept it, by the x-lrg-pick header.
//
// Test line only. No call monitor here (its events are GPT-Live's): the
// caller hangs up, and Twilio's 11-minute Dial cap is the backstop.

import WebSocket from "ws"
import { sendTelegramAlert } from "@/lib/leads"
import { VOICE_TEST_GREETING, VOICE_TEST_VOICE } from "@/lib/voiceTest"

const OPENAI_BASE = "https://api.openai.com/v1"
const SIDEBAND_MS = 280_000 // stay inside the 300 s function limit

export async function acceptRealtimeCall(opts: {
  callId: string
  apiKey: string
  model: string
  instructions: string
}): Promise<Response> {
  return fetch(`${OPENAI_BASE}/realtime/calls/${encodeURIComponent(opts.callId)}/accept`, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "realtime",
      model: opts.model,
      instructions: opts.instructions,
      audio: {
        input: { turn_detection: { type: "semantic_vad" } },
        output: { voice: VOICE_TEST_VOICE },
      },
    }),
  })
}

/** Sideband: say the opener, then report when the call ends. */
export async function watchRealtimeCall(opts: { callId: string; apiKey: string; t0: number; timing: string[] }): Promise<void> {
  const { callId, apiKey, t0, timing } = opts
  const mark = (label: string) => timing.push(`${label} +${((Date.now() - t0) / 1000).toFixed(1)}s`)
  const outcome = await new Promise<string>((resolve) => {
    const ws = new WebSocket(`${OPENAI_BASE.replace("https", "wss")}/realtime?call_id=${encodeURIComponent(callId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    let done = false
    let spoke = false
    const finish = (why: string) => {
      if (done) return
      done = true
      clearTimeout(cap)
      try { ws.close() } catch { /* already closed */ }
      resolve(why)
    }
    const cap = setTimeout(() => finish("sideband detached at 4:40 (call may still be going)"), SIDEBAND_MS)
    ws.on("open", () => {
      mark("sideband open")
      ws.send(JSON.stringify({ type: "response.create", response: { instructions: VOICE_TEST_GREETING } }))
    })
    ws.on("message", (raw) => {
      let msg: { type?: string; error?: { message?: string } }
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (!spoke && (msg.type === "response.output_audio.delta" || msg.type === "response.audio.delta")) {
        spoke = true
        mark("Jackie speaking")
        void sendTelegramAlert(`🧪 Test line (option 3, realtime) timing: ${timing.join(" · ")}`)
      } else if (msg.type === "error") {
        console.error(`[voice-test] realtime sideband error: ${msg.error?.message ?? "unknown"}`)
        void sendTelegramAlert(`⚠️ Test line option 3 (realtime): ${msg.error?.message ?? "unknown error"}`)
      }
    })
    ws.on("error", (e) => finish(`socket error: ${e.message}`))
    ws.on("close", () => finish(spoke ? "call ended" : "call ended before she spoke"))
  })
  const secs = Math.round((Date.now() - t0) / 1000)
  await sendTelegramAlert(`🧪 Option 3 (gpt-realtime-2.1) call over at ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")} — ${outcome}`)
}
