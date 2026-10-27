// Decides when Jackie's call should end — GPT-Live can't hang up on its own,
// so the sideband watcher (lib/voiceTestWatch.ts) feeds every event in here
// and acts on what tick() returns. Pure (no IO, caller-supplied clock) so the
// rules can be replayed against fake calls.
//
// Ryan's rules (receptionist-decisions, 10-25 + call 10 on 10-26):
// - After her goodbye, hang up instead of sitting on the line — unless the
//   caller starts saying something real.
// - Dead air: check in at ~20 s of silence, goodbye if still nothing, hang up.
// - Soft wrap at 10 min, hard hangup at 11 min.

export type MonitorAction =
  | { type: "commentary"; content: string }
  | { type: "hangup"; reason: string }

export type MonitorState = {
  t0: number
  spoke: boolean
  outputText: string
  lastOutputTextAt: number
  lastOutputAudioAt: number
  lastOutputLoudAt: number
  utterStartAt: number
  utterStartMs: number
  utterEndMs: number
  playbackEndAt: number
  lastInputTextAt: number
  lastLoudInputAt: number
  goodbye: { input: string; readyAt: number | null } | null
  quietStage: 0 | 1 | 2
  quietStageAt: number
  wrapSent: boolean
  done: boolean
}

export const WRAP_AT_MS = 10 * 60_000
export const CAP_AT_MS = 11 * 60_000
const GOODBYE_GRACE_MS = 2_500 // caller silence after her goodbye before we hang up
const GOODBYE_MAX_WAIT_MS = 8_000 // noisy line: hang up anyway
const LOUD_INPUT_HOLD_MS = 1_200 // caller audio this recent = they may be talking
const CHECK_IN_AFTER_MS = 20_000
const GOODBYE_AFTER_CHECK_IN_MS = 15_000
const DEAD_AIR_HANGUP_MS = 15_000 // after the dead-air goodbye prompt
const TEXT_GAP_MS = 1_000 // a pause this long in her transcript = new utterance
const LOUD_RMS = 500 // PCM16 RMS (~-36 dBFS): speech, not line noise

const GOODBYE_RE =
  /\b(take care(?! of)|bye|goodbye|good ?night|have a (good|great|nice|wonderful|lovely) (one|day|night|evening|afternoon|weekend)|talk (to you )?soon)\b/i

// Words a caller says while the call winds down; anything else after her
// goodbye means they're still talking to her.
const WIND_DOWN = new Set(
  "ok okay alright all right bye goodbye good night thanks thank you too take care have a nice great one day yeah yep yes no nope nah sure cool will do see ya you bet uh um mm hmm fuck off whatever".split(" "),
)
// The caller saying their own goodbye never keeps the line open — call 11
// (10-26): "No, I'm gonna go. Goodbye." over her "Take care, Michael. Bye."
// cancelled the hang-up.
const CALLER_GOODBYE_RE =
  /\b(bye|goodbye|gotta go|got to go|gonna go|going to go|i'?m going|i'?ll let you go|take care|have a (good|great|nice) \w+|talk (to you )?later|see ya|later)\b/i

export function isGoodbye(text: string): boolean {
  const t = text.trim()
  if (!t || t.endsWith("?")) return false
  // Only the tail counts — "take care" early in a turn that ends in a question isn't a goodbye.
  return GOODBYE_RE.test(t.slice(-80))
}

export function isSubstantive(input: string): boolean {
  if (CALLER_GOODBYE_RE.test(input)) return false
  const words = input.toLowerCase().match(/[a-z']+/g) ?? []
  return words.some((w) => !WIND_DOWN.has(w.replace(/'/g, "")))
}

// Jackie continuing after a goodbye: more than a few words, or a question.
export function isSubstantiveReply(text: string): boolean {
  const t = text.trim()
  return t.endsWith("?") || (t.match(/[a-z']+/gi) ?? []).length > 3
}

export function pcm16Rms(b64: string): number {
  const buf = Buffer.from(b64, "base64")
  const n = Math.floor(buf.length / 2)
  if (n === 0) return 0
  let sum = 0
  let count = 0
  for (let i = 0; i < n; i += 4) {
    const s = buf.readInt16LE(i * 2)
    sum += s * s
    count += 1
  }
  return Math.sqrt(sum / count)
}

export class CallMonitor {
  state: MonitorState
  /** Human-readable decisions, logged when the watcher stops (not persisted). */
  notes: string[] = []

  constructor(t0: number, prior?: MonitorState) {
    this.state = prior ?? {
      t0,
      spoke: false,
      outputText: "",
      lastOutputTextAt: 0,
      lastOutputAudioAt: 0,
      lastOutputLoudAt: 0,
      utterStartAt: 0,
      utterStartMs: 0,
      utterEndMs: 0,
      playbackEndAt: 0,
      lastInputTextAt: 0,
      lastLoudInputAt: 0,
      goodbye: null,
      quietStage: 0,
      quietStageAt: 0,
      wrapSent: false,
      done: false,
    }
  }

  onEvent(msg: Record<string, unknown>, now: number): void {
    const s = this.state
    const text = typeof msg.delta === "string" ? msg.delta : typeof msg.text === "string" ? msg.text : ""
    switch (msg.type) {
      case "session.output_audio.delta": {
        // Reflected output may stream continuously (silence included), so
        // "she's talking" = the audio is actually loud, not merely present.
        const loud = typeof msg.delta === "string" ? pcm16Rms(msg.delta) > LOUD_RMS : true
        if (loud) {
          s.spoke = true
          s.lastOutputLoudAt = now
        }
        // Only loud chunks count toward "when does her speech finish playing":
        // the stream is continuous (10-26 observer: one 200 ms chunk every
        // 200 ms for the whole call), so silent chunks would pin playbackEndAt
        // to "now" and she'd never be "done talking".
        const start = loud && typeof msg.start_ms === "number" ? msg.start_ms : null
        const end = loud && typeof msg.end_ms === "number" ? msg.end_ms : null
        if (start !== null && end !== null) {
          // Audio can arrive faster than it plays; map her timeline onto the
          // wall clock from the first chunk of each utterance.
          if (s.utterEndMs === 0 || start - s.utterEndMs > 400) {
            s.utterStartAt = now
            s.utterStartMs = start
          }
          s.utterEndMs = Math.max(s.utterEndMs, end)
          s.playbackEndAt = s.utterStartAt + (s.utterEndMs - s.utterStartMs)
        }
        s.lastOutputAudioAt = now
        break
      }
      case "session.output_transcript.delta": {
        s.spoke = true
        if (now - s.lastOutputTextAt > TEXT_GAP_MS) s.outputText = ""
        s.outputText += text
        s.lastOutputTextAt = now
        // Re-judged on every fragment: "Take care! Oh, one more thing?" isn't a goodbye.
        if (isGoodbye(s.outputText)) {
          if (!s.goodbye) {
            s.goodbye = { input: "", readyAt: null }
            this.note(now, `goodbye heard: "${s.outputText.trim().slice(-60)}"`)
          }
        } else if (s.goodbye && !isSubstantiveReply(s.outputText)) {
          // a stray "mm-hmm" / "you bet" after her goodbye keeps it armed
        } else {
          if (s.goodbye) this.note(now, `goodbye cancelled — Jackie went on: "${s.outputText.trim().slice(0, 60)}"`)
          s.goodbye = null
        }
        break
      }
      case "session.input_transcript.delta": {
        if (!text.trim()) break
        s.lastInputTextAt = now
        s.quietStage = 0
        if (s.goodbye) {
          s.goodbye.input += ` ${text}`
          if (isSubstantive(s.goodbye.input)) {
            this.note(now, `goodbye cancelled — caller: "${s.goodbye.input.trim().slice(0, 60)}"`)
            s.goodbye = null
          }
        }
        break
      }
      case "session.input_audio.append": {
        if (typeof msg.audio === "string" && pcm16Rms(msg.audio) > LOUD_RMS) s.lastLoudInputAt = now
        break
      }
    }
  }

  tick(now: number): MonitorAction[] {
    const s = this.state
    if (s.done) return []
    const elapsed = now - s.t0
    if (elapsed >= CAP_AT_MS) return this.end("11-minute limit")

    const actions: MonitorAction[] = []
    if (elapsed >= WRAP_AT_MS && !s.wrapSent) {
      s.wrapSent = true
      actions.push({
        type: "commentary",
        content:
          "The call is close to ten minutes. Wrap up now: let them know Ryan will follow up, thank them, and say goodbye.",
      })
    }

    const speakingDone = now >= s.playbackEndAt + 300 && now - s.lastOutputLoudAt >= 700
    if (s.goodbye && speakingDone) {
      if (s.goodbye.readyAt === null) s.goodbye.readyAt = now
      const waited = now - s.goodbye.readyAt
      const callerQuiet = now - s.lastLoudInputAt >= LOUD_INPUT_HOLD_MS
      if ((waited >= GOODBYE_GRACE_MS && callerQuiet) || waited >= GOODBYE_MAX_WAIT_MS) {
        return [...actions, ...this.end(s.quietStage === 2 ? "dead air" : "goodbye")]
      }
    }

    if (s.spoke && speakingDone && !s.goodbye) {
      const lastActivity = Math.max(s.lastInputTextAt, s.lastLoudInputAt, s.lastOutputLoudAt, s.playbackEndAt)
      const quiet = now - lastActivity
      if (s.quietStage === 0 && quiet >= CHECK_IN_AFTER_MS) {
        s.quietStage = 1
        s.quietStageAt = now
        actions.push({
          type: "commentary",
          content:
            "It's been quiet on the line for a while. Briefly and kindly check whether they're still there. If they asked you to hold on, just let them know you're still here.",
        })
      } else if (s.quietStage === 1 && quiet >= GOODBYE_AFTER_CHECK_IN_MS && now - s.quietStageAt >= GOODBYE_AFTER_CHECK_IN_MS) {
        s.quietStage = 2
        s.quietStageAt = now
        actions.push({
          type: "commentary",
          content:
            "There's still no answer. Say a short, friendly goodbye now (Ryan will follow up), then stop talking.",
        })
      }
    }
    if (s.quietStage === 2 && now - s.quietStageAt >= DEAD_AIR_HANGUP_MS && !s.goodbye) {
      return [...actions, ...this.end("dead air")]
    }
    return actions
  }

  private note(now: number, text: string): void {
    if (this.notes.length < 40) this.notes.push(`${((now - this.state.t0) / 1000).toFixed(1)}s ${text}`)
  }

  private end(reason: string): MonitorAction[] {
    this.state.done = true
    return [{ type: "hangup", reason }]
  }
}
