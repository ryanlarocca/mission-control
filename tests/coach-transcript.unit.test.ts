import { describe, it, expect } from "vitest"
import { parseWavHeader, splitStereoWav, mergeTurns, dualWavUrl, wordsToPieces, type Segment } from "@/lib/coach/transcript"

// Build a tiny 16-bit PCM WAV with the given interleaved samples.
function wav(channels: number, sampleRate: number, samples: number[]): Buffer {
  const data = Buffer.alloc(samples.length * 2)
  samples.forEach((s, i) => data.writeInt16LE(s, i * 2))
  const h = Buffer.alloc(44)
  h.write("RIFF", 0, "ascii"); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8, "ascii")
  h.write("fmt ", 12, "ascii"); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22)
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34)
  h.write("data", 36, "ascii"); h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

describe("dual-channel WAV split", () => {
  it("parses Twilio-style headers", () => {
    const info = parseWavHeader(wav(2, 8000, [1, 2, 3, 4]))
    expect(info).toMatchObject({ channels: 2, sampleRate: 8000, bitsPerSample: 16, dataOffset: 44, dataLength: 8 })
  })

  it("splits interleaved stereo into two mono tracks with peaks", () => {
    // L = 100, 300, -500 ; R = 0, 0, 0 (silent far side)
    const split = splitStereoWav(wav(2, 8000, [100, 0, 300, 0, -500, 0]))
    expect(split).not.toBeNull()
    const [l, r] = split!
    expect(parseWavHeader(l.wav)).toMatchObject({ channels: 1, sampleRate: 8000, dataLength: 6 })
    expect(l.wav.readInt16LE(44)).toBe(100)
    expect(l.wav.readInt16LE(48)).toBe(-500)
    expect(l.peak).toBe(500)
    expect(r.peak).toBe(0)
  })

  it("refuses a mono recording so the caller falls back", () => {
    expect(splitStereoWav(wav(1, 8000, [1, 2, 3]))).toBeNull()
  })

  it("refuses a stereo file whose channels are the same track", () => {
    expect(splitStereoWav(wav(2, 8000, [100, 100, 300, 300, -500, -500]))).toBeNull()
  })

  it("asks Twilio for the 2-channel WAV", () => {
    expect(dualWavUrl("https://api.twilio.com/x/Recordings/RE1.mp3")).toBe("https://api.twilio.com/x/Recordings/RE1.wav?RequestedChannels=2")
  })
})

describe("wordsToPieces", () => {
  const w = (word: string, start: number, end: number) => ({ word, start, end })

  it("keeps Whisper's word order when a timestamp is out of order, and restores punctuation", () => {
    const pieces = wordsToPieces({
      segments: [{ start: 0, end: 2, text: " Nice man. Congrats on that." }],
      // "Congrats" is stamped before "man." — the merge must not reorder them.
      words: [w("Nice", 0, 0.3), w("man", 0.9, 1.1), w("Congrats", 0.5, 0.8), w("on", 1.2, 1.3), w("that", 1.3, 1.6)],
    }, "ryan")
    expect(pieces.map((p) => p.text)).toEqual(["Nice", "man.", "Congrats", "on", "that."])
    expect(pieces.map((p) => p.start)).toEqual([0, 0.9, 0.9, 1.2, 1.3])
  })

  it("falls back to bare words when the tokens don't line up, and drops no-speech junk", () => {
    const pieces = wordsToPieces({
      segments: [
        { start: 0, end: 1, text: " Thank you.", no_speech_prob: 0.99 },
        { start: 1, end: 2, text: " Hello there, Phil" },
      ],
      words: [w("Thank", 0, 0.4), w("you", 0.4, 0.8), w("Hello", 1, 1.3), w("there", 1.3, 1.6), w("Phil", 1.6, 1.9), w("extra", 1.9, 2.0)],
    }, "other")
    expect(pieces.map((p) => p.text)).toEqual(["Hello", "there", "Phil", "extra"])
  })

  it("uses segments when no word timestamps came back", () => {
    const pieces = wordsToPieces({ segments: [{ start: 0, end: 2, text: " Hi Rita. " }], words: [] }, "ryan")
    expect(pieces).toEqual([{ speaker: "ryan", start: 0, end: 2, text: "Hi Rita." }])
  })
})

describe("mergeTurns", () => {
  const seg = (speaker: "ryan" | "other", start: number, end: number, text: string): Segment => ({ speaker, start, end, text })

  it("interleaves by time, collapses same-speaker runs and labels the lines", () => {
    const m = mergeTurns(
      [seg("ryan", 0, 2, "Hi Rita, this is Ryan with LRG Homes."), seg("ryan", 2.2, 4, "You called me last August.")],
      [seg("other", 4.5, 6, "Oh yes, I remember.")],
      "Rita",
    )
    expect(m.labeled).toBe("Ryan: Hi Rita, this is Ryan with LRG Homes. You called me last August.\nRita: Oh yes, I remember.")
    expect(m.turns).toHaveLength(2)
    expect(m.ryanSec).toBe(4)
    expect(m.otherSec).toBe(2)
    expect(m.swapped).toBe(false)
  })

  it("swaps the sides when the 'this is Ryan' tell is on the wrong channel", () => {
    const m = mergeTurns(
      [seg("ryan", 0, 3, "Hello, who is this?")],
      [seg("other", 3, 6, "Yeah, this is Ryan with LRG Homes.")],
      "Phil",
    )
    expect(m.swapped).toBe(true)
    expect(m.labeled).toBe("Phil: Hello, who is this?\nRyan: Yeah, this is Ryan with LRG Homes.")
  })

  it("cuts a turn exactly where the other side starts talking (word-level pieces)", () => {
    const m = mergeTurns(
      [seg("ryan", 0, 0.4, "You"), seg("ryan", 0.4, 0.8, "sold"), seg("ryan", 0.8, 1.2, "it?"), seg("ryan", 3.0, 3.4, "Congrats.")],
      [seg("other", 1.5, 1.9, "Yeah,"), seg("other", 1.9, 2.4, "last"), seg("other", 2.4, 2.8, "year.")],
      "Phil",
    )
    expect(m.labeled).toBe("Ryan: You sold it?\nPhil: Yeah, last year.\nRyan: Congrats.")
  })

  it("keeps same-speaker pieces in their given order when start times tie", () => {
    const tied = ["about", "your", "property", "on", "Sunrise", "Drive."].map((t) => seg("ryan", 5, 5.2, t))
    const m = mergeTurns([seg("ryan", 4, 4.5, "year"), ...tied], [], "Rita")
    expect(m.labeled).toBe("Ryan: year about your property on Sunrise Drive.")
  })

  it("drops empty segments", () => {
    const m = mergeTurns([seg("ryan", 0, 1, "  ")], [seg("other", 1, 2, "Hi")], "Lead")
    expect(m.turns).toHaveLength(1)
  })
})
