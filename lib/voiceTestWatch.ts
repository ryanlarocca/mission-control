// Sideband watcher for a Jackie call: says her opener, then stays attached
// for the whole call so CallMonitor (lib/voiceCallMonitor.ts) can end it —
// goodbye, dead air, 11-minute limit. GPT-Live has no way to hang up by
// itself; ours is POST /v1/live/sessions/{id}/hangup.
//
// Vercel Hobby caps a function at 300 s, a call can run 11 min, so every
// HOP_MS the watcher hands the call (with the monitor's state) to a fresh
// invocation of /api/voice-test/watch and detaches.

import WebSocket from "ws"
import { createHmac, timingSafeEqual } from "crypto"
import { sendTelegramAlert } from "@/lib/leads"
import { CallMonitor, type MonitorState } from "@/lib/voiceCallMonitor"
import { VOICE_TEST_GREETING, VOICE_TEST_OPENER } from "@/lib/voiceTest"

const OPENAI_BASE = "https://api.openai.com/v1"
const HOP_MS = 240_000 // hand off well inside the 300 s function limit
const GIVE_UP_MS = 285_000
const TICK_MS = 250

export type WatchHandoff = { sessionId: string; hop: number; state: MonitorState; caller?: string }

function baseUrl(): string {
  return process.env.MC_BASE_URL || "https://mission-control-three-chi.vercel.app"
}

function handoffSecret(): string {
  return process.env.OPENAI_VOICE_WEBHOOK_SECRET || ""
}

export function signHandoff(body: string): string {
  return createHmac("sha256", handoffSecret()).update(body).digest("hex")
}

export function handoffSignatureValid(body: string, sig: string): boolean {
  if (!handoffSecret() || !sig) return false
  const expected = Buffer.from(signHandoff(body), "hex")
  const got = Buffer.from(sig, "hex")
  return got.length === expected.length && timingSafeEqual(got, expected)
}

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

// Backup: end the call on Twilio's side (the trunk leg is the caller's
// number → sip:proj…@sip.api.openai.com) if OpenAI's hangup doesn't take.
async function twilioHangup(caller: string): Promise<string> {
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!sid || !token || !caller) return "twilio: not configured"
  const auth = `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`
  const list = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json?From=${encodeURIComponent(caller)}&Status=in-progress&PageSize=5`,
    { headers: { Authorization: auth } },
  )
  if (!list.ok) return `twilio list ${list.status}`
  const calls = ((await list.json()) as { calls?: { sid: string; to?: string }[] }).calls ?? []
  const leg = calls.find((c) => (c.to ?? "").includes("sip.api.openai.com"))
  if (!leg) return "twilio: no in-progress leg"
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls/${leg.sid}.json`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: "Status=completed",
  })
  return res.ok ? "ok (twilio)" : `twilio ${res.status}`
}

async function hangup(sessionId: string, apiKey: string, caller: string): Promise<string> {
  const res = await fetch(`${OPENAI_BASE}/live/sessions/${encodeURIComponent(sessionId)}/hangup`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (res.ok) return "ok"
  const detail = `${res.status} ${(await res.text()).slice(0, 200)}`
  console.error(`[voice-test] OpenAI hangup failed: ${detail}`)
  const backup = await twilioHangup(caller)
  return backup.startsWith("ok") ? backup : `openai ${detail}; ${backup}`
}

async function handOff(handoff: WatchHandoff): Promise<boolean> {
  const body = JSON.stringify(handoff)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${baseUrl()}/api/voice-test/watch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-voice-watch-sig": signHandoff(body) },
        body,
      })
      if (res.ok) return true
      console.error(`[voice-test] handoff ${handoff.hop} refused: ${res.status}`)
    } catch (e) {
      console.error(`[voice-test] handoff ${handoff.hop} failed: ${e instanceof Error ? e.message : e}`)
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return false
}

/**
 * Watch one Jackie call until it ends or this invocation hands it off.
 * `opener` (first hop only): send the greeting over the sideband — the
 * startup message alone left Jackie silent on 10-25 — nudge once at 4 s,
 * and post the timing line to Telegram.
 */
export async function watchCall(opts: {
  sessionId: string
  apiKey: string
  t0: number
  hop: number
  caller: string
  state?: MonitorState
  opener?: { timing: string[] }
}): Promise<void> {
  const { sessionId, apiKey, t0, hop, caller } = opts
  const startedAt = Date.now()
  const monitor = new CallMonitor(t0, opts.state)
  const timing = opts.opener?.timing ?? []
  const mark = (label: string) => timing.push(`${label} +${((Date.now() - t0) / 1000).toFixed(1)}s`)

  const outcome = await new Promise<string>((resolve) => {
    const ws = new WebSocket(`${OPENAI_BASE.replace("https", "wss")}/live/sessions/${encodeURIComponent(sessionId)}/attach`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    let finished = false
    let hangupReason: string | null = null
    let handingOff = false
    let openerReported = !opts.opener
    let nudges = 0
    // Diagnostics (10-26, call 11 never hung up): what the sideband sends.
    const counts: Record<string, number> = {}
    const shapes: Record<string, string> = {}
    const timers: ReturnType<typeof setTimeout>[] = []

    const reportOpener = (result: string) => {
      if (openerReported) return
      openerReported = true
      const line = `${timing.join(" · ")} · result: ${result}`
      console.log(`[voice-test] ${line}`)
      void sendTelegramAlert(`🧪 Test line timing: ${line}`)
    }
    const finish = (result: string) => {
      if (finished) return
      finished = true
      console.log(`[voice-test] watcher hop ${hop} stop: ${result} · events ${JSON.stringify(counts)} · shapes ${JSON.stringify(shapes)} · notes ${JSON.stringify(monitor.notes)}`)
      clearInterval(ticker)
      timers.forEach(clearTimeout)
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

    const ended = () =>
      hangupReason ? `Jackie hung up (${hangupReason})` : handingOff ? "handed off" : "caller hung up"

    const ticker = setInterval(() => {
      if (finished || hangupReason || handingOff) return
      const now = Date.now()
      for (const action of monitor.tick(now)) {
        if (action.type === "commentary" && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "session.commentary.append",
            event_id: `monitor_${now}`,
            delegation_id: null,
            content: action.content,
          }))
        } else if (action.type === "hangup") {
          const reason = action.reason
          hangupReason = reason
          void hangup(sessionId, apiKey, caller).then((r) => finish(r.startsWith("ok") ? ended() : `hangup failed (${reason}): ${r}`))
          return
        }
      }
      if (now - startedAt >= HOP_MS && !monitor.state.done) {
        handingOff = true // stop acting while the next invocation takes over
        void handOff({ sessionId, hop: hop + 1, state: monitor.state, caller }).then((ok) => {
          if (ok) finish("handed off")
          else {
            handingOff = false
            timers.push(setTimeout(() => finish("watcher out of time — handoff failed"), GIVE_UP_MS - (Date.now() - startedAt)))
          }
        })
      }
    }, TICK_MS)

    ws.on("open", () => {
      if (!opts.opener) return
      mark("sideband open")
      greet()
      timers.push(setTimeout(() => { if (!monitor.state.spoke) greet() }, 4000))
      timers.push(setTimeout(() => reportOpener(monitor.state.spoke ? "ok" : "silent after greeting"), 14000))
    })
    ws.on("message", (raw) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(String(raw)) } catch { return }
      const type = typeof msg.type === "string" ? msg.type : "?"
      counts[type] = (counts[type] ?? 0) + 1
      if (!shapes[type]) {
        shapes[type] = Object.entries(msg)
          .map(([k, v]) => `${k}:${typeof v === "string" ? (v.length > 40 ? `str${v.length}` : JSON.stringify(v)) : typeof v === "object" ? "obj" : String(v)}`)
          .join(",")
          .slice(0, 300)
      }
      const wasSpeaking = monitor.state.spoke
      monitor.onEvent(msg, Date.now())
      if (!wasSpeaking && monitor.state.spoke && opts.opener) {
        mark("Jackie speaking")
        reportOpener("ok")
      }
      if (msg.type === "session.closed") finish(ended())
      else if (msg.type === "error") {
        const err = msg.error as { message?: string } | undefined
        console.error(`[voice-test] sideband error: ${err?.message ?? "unknown"}`)
      }
    })
    ws.on("error", (e) => {
      reportOpener(`socket error: ${e.message}`)
      finish(`socket error: ${e.message}`)
    })
    ws.on("close", (code) => {
      reportOpener(`closed ${code}`)
      finish(ended())
    })
  })

  if (outcome === "handed off") return
  const line = `Jackie call over at ${clock(Date.now() - t0)} — ${outcome}${hop ? ` (watcher hop ${hop})` : ""}`
  console.log(`[voice-test] ${line}`)
  await sendTelegramAlert(`🧪 ${line}`)
}
