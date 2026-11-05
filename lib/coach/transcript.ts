// Speaker-separated transcripts from Twilio dual-channel recordings
// (Sales Coach, 2026-11-02). Every <Dial> in the app records with
// `record-from-answer-dual` since today, so the WAV Twilio serves with
// `?RequestedChannels=2` carries one party per channel. We split the PCM
// here in plain Node (no ffmpeg on Vercel), run Whisper on each channel
// with segment timestamps, and merge the segments by time into a
// turn-by-turn transcript labelled "Ryan:" / "<Name>:". Before this, both
// voices went to Whisper as one mixed track and a live call came back as a
// single run-on paragraph (Phil Demmers, 2026-11-02).
//
// Which channel is Ryan depends on who the parent call leg is: Twilio puts
// the parent leg on channel 0 and the <Dial>ed party on channel 1. On a
// click-to-call (Twilio rings Ryan first, then dials the contact) Ryan is
// channel 0; on an inbound forward (the contact called a line, Twilio
// dialed Ryan's cell) Ryan is channel 1. The caller passes `ryanChannel`
// and `mergeTurns` double-checks with the "this is Ryan" tell.
//
// Returns null whenever the dual path can't be trusted (mono recording,
// a Whisper failure) so callers fall back
// to the existing mixed-track transcription.

import { fetchTwilioAudio } from "@/lib/leads"

export interface WavInfo {
  channels: number
  sampleRate: number
  bitsPerSample: number
  dataOffset: number
  dataLength: number
}

// Minimal RIFF/WAVE reader — enough for Twilio's PCM output.
export function parseWavHeader(buf: Buffer): WavInfo | null {
  if (buf.length < 44) return null
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null
  let pos = 12
  let fmt: { channels: number; sampleRate: number; bitsPerSample: number; audioFormat: number } | null = null
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === "fmt ") {
      if (body + 16 > buf.length) return null
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      }
    } else if (id === "data") {
      if (!fmt) return null
      if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) return null
      const dataLength = Math.min(size, buf.length - body)
      return { channels: fmt.channels, sampleRate: fmt.sampleRate, bitsPerSample: 16, dataOffset: body, dataLength }
    }
    pos = body + size + (size % 2)
  }
  return null
}

function wavHeader(dataLength: number, sampleRate: number): Buffer {
  const h = Buffer.alloc(44)
  h.write("RIFF", 0, "ascii")
  h.writeUInt32LE(36 + dataLength, 4)
  h.write("WAVE", 8, "ascii")
  h.write("fmt ", 12, "ascii")
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(1, 22) // mono
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(sampleRate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write("data", 36, "ascii")
  h.writeUInt32LE(dataLength, 40)
  return h
}

export interface SplitChannel {
  wav: Buffer
  // Loudest sample on the channel (0–32767). A dead channel (the far side
  // never spoke, or a voicemail system that only beeped) stays near zero —
  // we skip Whisper on it rather than let it hallucinate "Thank you."
  peak: number
}

// Split an interleaved 16-bit stereo WAV into two mono WAVs.
export function splitStereoWav(buf: Buffer): [SplitChannel, SplitChannel] | null {
  const info = parseWavHeader(buf)
  if (!info || info.channels !== 2) return null
  const frames = Math.floor(info.dataLength / 4)
  const left = Buffer.alloc(frames * 2)
  const right = Buffer.alloc(frames * 2)
  let peakL = 0
  let peakR = 0
  let differing = 0
  for (let i = 0; i < frames; i++) {
    const src = info.dataOffset + i * 4
    const l = buf.readInt16LE(src)
    const r = buf.readInt16LE(src + 2)
    left.writeInt16LE(l, i * 2)
    right.writeInt16LE(r, i * 2)
    if (l !== r) differing++
    const al = Math.abs(l)
    const ar = Math.abs(r)
    if (al > peakL) peakL = al
    if (ar > peakR) peakR = ar
  }
  // A mono recording served as "2 channels" is the same track twice. Treat
  // it as mono — otherwise every line would come out once as Ryan and once
  // as the other side.
  if (frames > 0 && differing / frames < 0.01) return null
  return [
    { wav: Buffer.concat([wavHeader(left.length, info.sampleRate), left]), peak: peakL },
    { wav: Buffer.concat([wavHeader(right.length, info.sampleRate), right]), peak: peakR },
  ]
}

export interface Segment {
  speaker: "ryan" | "other"
  start: number
  end: number
  text: string
}

export interface MergedTranscript {
  // "Ryan: …\nRita: …" — one line per turn, in time order.
  labeled: string
  turns: Segment[]
  // Seconds each side spoke, from the segment timestamps.
  ryanSec: number
  otherSec: number
  // True when the "this is Ryan" tell showed up on the other channel and
  // the sides were swapped — logged so a wrong `ryanChannel` is visible.
  swapped: boolean
  // How long the caller waited on our side (Jackie's calls, measureReplies).
  replies?: ReplyTiming
}

// A speaker whose next word starts within this long of their previous one
// kept talking (see the talk-over pass in mergeTurns).
const TALK_OVER_GAP_SEC = 0.8

// "This is Ryan" / "Ryan with LRG" — how our side introduces itself. On a
// Jackie call our side is Jackie, so the tell is built from the label (a
// caller named Ryan must not flip her transcript).
function selfTell(name: string): RegExp {
  const n = name.replace(/[^a-z]/gi, "")
  return new RegExp(`\\b(this is|it'?s|i'?m) ${n}\\b|\\b${n} (with|from|at) lrg\\b`, "i")
}

// Merge two per-channel segment lists into labelled turns. Adjacent
// segments from the same speaker collapse into one turn. If the tell
// appears only on the "other" side, the labels were backwards — swap.
// `selfLabel` names our side: Ryan, or Jackie on a call she took (her
// segments still travel as speaker "ryan").
export function mergeTurns(
  ryanSegs: Segment[],
  otherSegs: Segment[],
  otherLabel: string,
  selfLabel = "Ryan",
): MergedTranscript {
  let ryan = ryanSegs
  let other = otherSegs
  let swapped = false
  const ryanText = ryan.map((s) => s.text).join(" ")
  const otherText = other.map((s) => s.text).join(" ")
  const tell = selfTell(selfLabel)
  if (tell.test(otherText) && !tell.test(ryanText)) {
    ;[ryan, other] = [
      other.map((s) => ({ ...s, speaker: "ryan" as const })),
      ryan.map((s) => ({ ...s, speaker: "other" as const })),
    ]
    swapped = true
  }
  // Time order, then collapse runs of the same speaker. The inputs are
  // word-level pieces (see toSegments), so a turn ends exactly where the
  // other side starts talking — segment-level pieces put a whole 10-second
  // Ryan segment before the reply it contained.
  // Ties on start time are common (wordsToPieces clamps out-of-order word
  // stamps to the same instant), so same-speaker ties keep their original
  // order — a comparator that answers "a first" for both (a,b) and (b,a)
  // let the sort scramble words inside a turn ("about your on property").
  const all = [...ryan, ...other]
    .map((s, i) => ({ s, i }))
    .sort((a, b) =>
      a.s.start - b.s.start
      || (a.s.speaker !== b.s.speaker ? (a.s.speaker === "ryan" ? -1 : 1) : a.i - b.i))
    .map((x) => x.s)
  // `lastStart` = when the turn's last word began, for the talk-over pass.
  const built: (Segment & { lastStart: number })[] = []
  for (const s of all) {
    const text = s.text.trim()
    if (!text) continue
    const last = built[built.length - 1]
    if (last && last.speaker === s.speaker) {
      last.text = `${last.text} ${text}`
      last.end = Math.max(last.end, s.end)
      last.lastStart = s.start
    } else {
      built.push({ ...s, text, lastStart: s.start })
    }
  }
  // Talk-over (2026-11-04, Jackie's calls): when both sides speak at once
  // the word-by-word merge ping-pongs ("Jackie: All / Caller: he / Jackie:
  // right, / Caller: wrote"). If a speaker's next word comes right after
  // their last one, they never stopped — whatever the other side said in
  // between was said over them, so it goes after the unbroken turn. A
  // reply that landed in a real pause is left where it is.
  for (let i = 1; i + 1 < built.length; ) {
    const a1 = built[i - 1], b = built[i], a2 = built[i + 1]
    if (a2.start - a1.lastStart >= TALK_OVER_GAP_SEC) { i++; continue }
    a1.text = `${a1.text} ${a2.text}`
    a1.end = Math.max(a1.end, a2.end)
    a1.lastStart = a2.lastStart
    built.splice(i + 1, 1)
    const next = built[i + 1]
    if (next && next.speaker === b.speaker) {
      b.text = `${b.text} ${next.text}`
      b.end = Math.max(b.end, next.end)
      b.lastStart = next.lastStart
      built.splice(i + 1, 1)
    }
    // Stay on `b`: its new neighbours may fold again.
  }
  const turns: Segment[] = built.map(({ lastStart: _lastStart, ...t }) => t)
  const labeled = turns.map((t) => `${t.speaker === "ryan" ? selfLabel : otherLabel}: ${t.text}`).join("\n")
  const sum = (segs: Segment[]) => segs.reduce((n, s) => n + Math.max(0, s.end - s.start), 0)
  return { labeled, turns, ryanSec: Math.round(sum(ryan)), otherSec: Math.round(sum(other)), swapped }
}

// ── Reply timing (2026-11-05) ─────────────────────────────────────────────
// Ryan: "there's like an awkward pause of like 5 seconds" before Jackie
// answers. Measured from the recording itself — each side's own channel —
// so it's what the caller heard, not what the model reports. Same method
// as the hand measurement of her first five calls (50 ms frames, speech =
// RMS over 350, a pause ≥ 0.45 s ends a stretch of speech).

export interface ReplyTiming {
  /** Times she answered after the caller stopped. */
  replies: number
  /** Typical wait before her answer, seconds. */
  median_s: number | null
  /** Longest wait: before an answer, or the caller left in silence until they spoke again. */
  slowest_s: number | null
  /** When in the call the longest wait began, seconds from the start of the recording. */
  slowest_at_s: number | null
  /** Waits of 3 s or more. */
  over_3s: number
  /** Pickup → her first word, seconds. */
  greeting_s: number | null
}

const SPEECH_RMS = 350
const FRAME_S = 0.05
const PAUSE_ENDS_SPEECH_S = 0.45
const MIN_SPEECH_S = 0.12
// The caller paused, nobody answered, and they started again. Under this,
// it's usually just them catching a breath mid-story.
const LEFT_HANGING_S = 3

/** Stretches of speech on a mono 16-bit WAV, [start, end] in seconds. */
export function speechSegments(wav: Buffer): Array<[number, number]> {
  const info = parseWavHeader(wav)
  if (!info || info.channels !== 1 || info.bitsPerSample !== 16) return []
  const frame = Math.max(1, Math.round(info.sampleRate * FRAME_S))
  const samples = Math.floor(info.dataLength / 2)
  const out: Array<[number, number]> = []
  let start = -1
  let last = 0
  let quiet = 0
  for (let i = 0; i + frame <= samples; i += frame) {
    let sum = 0
    for (let k = 0; k < frame; k++) {
      const v = wav.readInt16LE(info.dataOffset + (i + k) * 2)
      sum += v * v
    }
    const t = i / info.sampleRate
    if (Math.sqrt(sum / frame) > SPEECH_RMS) {
      if (start < 0) start = t
      quiet = 0
      last = t + FRAME_S
    } else if (start >= 0) {
      quiet += FRAME_S
      if (quiet >= PAUSE_ENDS_SPEECH_S) {
        if (last - start >= MIN_SPEECH_S) out.push([start, last])
        start = -1
      }
    }
  }
  if (start >= 0 && last - start >= MIN_SPEECH_S) out.push([start, last])
  return out
}

/** How long the caller waited on `self` (Jackie) — from the two segment lists. */
export function replyTimingFromSegments(self: Array<[number, number]>, caller: Array<[number, number]>): ReplyTiming {
  const r1 = (n: number) => Math.round(n * 10) / 10
  const gaps: number[] = []
  let slowest: { s: number; at: number } | null = null
  let over3 = 0
  const wait = (s: number, at: number) => {
    if (s >= 3) over3++
    if (!slowest || s > slowest.s) slowest = { s, at }
  }
  for (const [, end] of caller) {
    if (self.some(([a, b]) => a <= end && end <= b)) continue // she was already talking
    const nextSelf = self.find(([a]) => a >= end)?.[0] ?? null
    const nextCaller = caller.find(([a]) => a > end)?.[0] ?? null
    if (nextSelf !== null && (nextCaller === null || nextSelf <= nextCaller)) {
      gaps.push(nextSelf - end)
      wait(nextSelf - end, end)
    } else if (nextCaller !== null && nextCaller - end >= LEFT_HANGING_S) {
      wait(nextCaller - end, end) // she never answered; the caller had to fill the silence
    }
  }
  const sorted = [...gaps].sort((a, b) => a - b)
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null
  const worst = slowest as { s: number; at: number } | null
  return {
    replies: gaps.length,
    median_s: median === null ? null : r1(median),
    slowest_s: worst ? r1(worst.s) : null,
    slowest_at_s: worst ? r1(worst.at) : null,
    over_3s: over3,
    greeting_s: self.length ? r1(self[0][0]) : null,
  }
}

/** Reply timing from the two mono channel WAVs. */
export function replyTiming(selfWav: Buffer, callerWav: Buffer): ReplyTiming {
  return replyTimingFromSegments(speechSegments(selfWav), speechSegments(callerWav))
}

// Whisper's 25 MB upload cap. Twilio WAV is 8 kHz 16-bit mono per channel
// (16 KB/s) so one channel fits up to ~26 minutes. A longer call goes up in
// chunks (chunkMonoWav) — until 2026-11-05 it fell back to the mixed track,
// so Ryan's longest seller calls were the ones the coach read unlabelled.
const WHISPER_MAX_BYTES = 24_500_000
// Target chunk size: ~15 minutes of one channel.
const CHUNK_TARGET_BYTES = 14_400_000

export interface WavChunk {
  wav: Buffer
  // Where this chunk starts in the full recording, in seconds.
  offsetSec: number
}

/** Cut a mono 16-bit WAV into pieces of about `targetBytes`, each a valid
 *  WAV. Cuts land on the quietest quarter-second within 8 seconds of the
 *  even split, so a word is not sliced in half. A WAV already under the
 *  target comes back as one chunk. */
export function chunkMonoWav(wav: Buffer, targetBytes: number = CHUNK_TARGET_BYTES): WavChunk[] | null {
  const info = parseWavHeader(wav)
  if (!info || info.channels !== 1) return null
  const bytesPerSec = info.sampleRate * 2
  const total = info.dataLength - (info.dataLength % 2)
  const count = Math.max(1, Math.ceil(total / targetBytes))
  if (count === 1) return [{ wav, offsetSec: 0 }]
  const even = Math.floor(total / count)
  const win = Math.floor(bytesPerSec / 4) & ~1
  const search = bytesPerSec * 8
  const cuts: number[] = [0]
  for (let i = 1; i < count; i++) {
    const ideal = (even * i) & ~1
    const from = Math.max(cuts[cuts.length - 1] + win, ideal - search)
    const to = Math.min(total - win, ideal + search)
    let best = ideal
    let bestEnergy = Infinity
    for (let pos = from & ~1; pos + win <= to; pos += win) {
      let energy = 0
      for (let j = pos; j < pos + win; j += 2) energy += Math.abs(wav.readInt16LE(info.dataOffset + j))
      if (energy < bestEnergy) { bestEnergy = energy; best = pos + (win >> 1 & ~1) }
    }
    cuts.push(best)
  }
  cuts.push(total)
  const out: WavChunk[] = []
  for (let i = 0; i < count; i++) {
    const data = wav.subarray(info.dataOffset + cuts[i], info.dataOffset + cuts[i + 1])
    out.push({ wav: Buffer.concat([wavHeader(data.length, info.sampleRate), data]), offsetSec: cuts[i] / bytesPerSec })
  }
  return out
}

/** Whisper results from consecutive chunks → one result on the full
 *  recording's clock. */
export function joinChunkResults(parts: { raw: WhisperVerbose; offsetSec: number }[]): WhisperVerbose {
  const segments: WhisperSegment[] = []
  const words: WhisperWord[] = []
  for (const { raw, offsetSec } of parts) {
    for (const s of raw.segments) segments.push({ ...s, start: (Number(s.start) || 0) + offsetSec, end: (Number(s.end) || 0) + offsetSec })
    for (const w of raw.words) words.push({ ...w, start: (Number(w.start) || 0) + offsetSec, end: (Number(w.end) || 0) + offsetSec })
  }
  return { segments, words }
}
// Below this peak amplitude a channel is treated as silent (see SplitChannel).
const SILENT_PEAK = 250

export interface WhisperSegment { start: number; end: number; text: string; no_speech_prob?: number }
export interface WhisperWord { word: string; start: number; end: number }
export interface WhisperVerbose { segments: WhisperSegment[]; words: WhisperWord[] }

// Whisper with segment + word timestamps. Mirrors transcribeAudio's retry policy.
async function transcribeSegments(wav: Buffer, filename: string): Promise<WhisperVerbose | null> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return null
  const MAX_ATTEMPTS = 3
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const form = new FormData()
      form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), filename)
      form.append("model", "whisper-1")
      form.append("response_format", "verbose_json")
      form.append("timestamp_granularities[]", "segment")
      form.append("timestamp_granularities[]", "word")
      const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      })
      if (res.ok) {
        const json = await res.json() as { segments?: WhisperSegment[]; words?: WhisperWord[] }
        return { segments: Array.isArray(json.segments) ? json.segments : [], words: Array.isArray(json.words) ? json.words : [] }
      }
      const errText = await res.text()
      const retryable = res.status === 429 || res.status >= 500
      console.error(`[coach/transcript] Whisper ${filename} failed ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS}): ${errText.slice(0, 300)}`)
      if (!retryable) return null
    } catch (e) {
      console.error(`[coach/transcript] Whisper ${filename} threw (attempt ${attempt}/${MAX_ATTEMPTS}):`, e)
    }
    if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 1500 * attempt))
  }
  return null
}

// One channel → Whisper, in chunks when it is over the upload cap. Chunks
// run in parallel; one failed chunk fails the channel (the caller falls
// back to the mixed track rather than ship a transcript with a hole in it).
async function transcribeChannel(wav: Buffer, name: string): Promise<WhisperVerbose | null> {
  if (wav.length <= WHISPER_MAX_BYTES) return transcribeSegments(wav, `${name}.wav`)
  const chunks = chunkMonoWav(wav)
  if (!chunks) return null
  console.log(`[coach/transcript] ${name} channel is ${Math.round(wav.length / 1e6)} MB — transcribing in ${chunks.length} chunks`)
  const raws = await Promise.all(chunks.map((c, i) => transcribeSegments(c.wav, `${name}-${i + 1}.wav`)))
  const parts: { raw: WhisperVerbose; offsetSec: number }[] = []
  for (let i = 0; i < raws.length; i++) {
    const raw = raws[i]
    if (!raw) return null
    parts.push({ raw, offsetSec: chunks[i].offsetSec })
  }
  return joinChunkResults(parts)
}

// Word-level pieces for the merge, one channel at a time.
// - Whisper invents text on silence and flags those segments with a very
//   high no-speech probability; the words inside are dropped. The bar is
//   0.95 on purpose: at 0.7 it swallowed Ryan's real "Hi Rita, this is
//   Ryan" that came after a long wait through a screening greeting.
// - Whisper's word timestamps are occasionally out of order ("sent you a
//   at letter the time"); times are made monotonic so the merge keeps
//   Whisper's own word order within a channel.
// - Word pieces carry no punctuation, segment text does. When a segment's
//   whitespace tokens line up one-to-one with its words, the tokens are
//   used, so turns read "Nice man. Congrats on that." not "Nice man
//   Congrats on that".
export function wordsToPieces(raw: WhisperVerbose, speaker: "ryan" | "other"): Segment[] {
  if (!raw.words.length) {
    return raw.segments
      .filter((s) => (s.no_speech_prob ?? 0) < 0.95 && typeof s.text === "string" && s.text.trim())
      .map((s) => ({ speaker, start: Number(s.start) || 0, end: Number(s.end) || 0, text: s.text.trim() }))
  }
  const words = raw.words.filter((w) => typeof w.word === "string" && w.word.trim())
  const pieces: Segment[] = []
  let clock = 0
  let wi = 0
  const push = (w: WhisperWord, text: string) => {
    const start = Math.max(clock, Number(w.start) || 0)
    clock = start
    pieces.push({ speaker, start, end: Math.max(start, Number(w.end) || 0), text: text.trim() })
  }
  for (const seg of raw.segments) {
    const segEnd = Number(seg.end) || 0
    const segWords: WhisperWord[] = []
    while (wi < words.length && (Number(words[wi].start) || 0) < segEnd) segWords.push(words[wi++])
    if ((seg.no_speech_prob ?? 0) >= 0.95) continue
    const tokens = typeof seg.text === "string" ? seg.text.trim().split(/\s+/).filter(Boolean) : []
    const punctuated = tokens.length === segWords.length
    segWords.forEach((w, i) => push(w, punctuated ? tokens[i] : w.word))
  }
  for (; wi < words.length; wi++) push(words[wi], words[wi].word)
  return pieces
}

// The dual-channel WAV for a recording we know by its .mp3 URL.
export function dualWavUrl(mp3Url: string): string {
  return `${mp3Url.replace(/\.mp3$/i, "")}.wav?RequestedChannels=2`
}

/** Speaker-separated transcript of a dual-channel Twilio recording, or null
 *  when the recording is mono or Whisper failed — the caller then uses the
 *  mixed-track path. */
export async function transcribeDualChannel(args: {
  mp3Url: string
  ryanChannel: 0 | 1
  otherLabel: string
  // Our side's label when it isn't Ryan — "Jackie" on a call she took.
  selfLabel?: string
  // Also measure how long the caller waited on our side (ReplyTiming).
  measureReplies?: boolean
}): Promise<MergedTranscript | null> {
  const tag = "[coach/transcript]"
  try {
    const wav = await fetchTwilioAudio(dualWavUrl(args.mp3Url))
    if (!wav) { console.warn(`${tag} dual WAV download failed — mixed-track fallback`); return null }
    const split = splitStereoWav(wav)
    if (!split) { console.log(`${tag} recording is not 2-channel — mixed-track fallback`); return null }
    const ryanCh = split[args.ryanChannel]
    const otherCh = split[args.ryanChannel === 0 ? 1 : 0]
    const silent: WhisperVerbose = { segments: [], words: [] }
    const [ryanRaw, otherRaw] = await Promise.all([
      ryanCh.peak < SILENT_PEAK ? Promise.resolve(silent) : transcribeChannel(ryanCh.wav, "ryan"),
      otherCh.peak < SILENT_PEAK ? Promise.resolve(silent) : transcribeChannel(otherCh.wav, "other"),
    ])
    if (ryanRaw === null || otherRaw === null) return null
    const merged = mergeTurns(wordsToPieces(ryanRaw, "ryan"), wordsToPieces(otherRaw, "other"), args.otherLabel, args.selfLabel)
    if (!merged.turns.length) return null
    if (merged.swapped) console.warn(`${tag} channels were swapped by the "this is ${args.selfLabel ?? "Ryan"}" tell (ryanChannel=${args.ryanChannel})`)
    if (args.measureReplies) {
      try {
        merged.replies = merged.swapped ? replyTiming(otherCh.wav, ryanCh.wav) : replyTiming(ryanCh.wav, otherCh.wav)
      } catch (e) {
        console.warn(`${tag} reply timing failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return merged
  } catch (e) {
    console.error(`${tag} threw:`, e instanceof Error ? e.message : String(e))
    return null
  }
}
