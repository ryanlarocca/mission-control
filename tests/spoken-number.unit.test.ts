import { describe, it, expect } from "vitest"
import { numberIsInTranscript } from "@/lib/spokenNumber"

// The guard on a number a hidden-caller-ID caller gave on the call
// (lib/spokenNumber, 2026-11-13): the model's digits only count when the
// caller said them, in order, as one number.

const NUM = "6505550147"

describe("numberIsInTranscript", () => {
  it("finds a plainly spoken number", () => {
    expect(numberIsInTranscript("Hi, this is Dana, call me at 650 555 0147, thanks.", NUM)).toBe(true)
  })

  it("finds dashes, dots and parens", () => {
    expect(numberIsInTranscript("my number is (650) 555-0147", NUM)).toBe(true)
    expect(numberIsInTranscript("my number is 650-555-0147", NUM)).toBe(true)
    expect(numberIsInTranscript("my number is 650.555.0147", NUM)).toBe(true)
    expect(numberIsInTranscript("reach me at 1-650-555-0147", NUM)).toBe(true)
  })

  it("finds spoken digit words, alone or mixed with digits", () => {
    expect(numberIsInTranscript("call me at six five oh, five five five, zero one four seven", NUM)).toBe(true)
    expect(numberIsInTranscript("it's 650 five five five o one four seven", NUM)).toBe(true)
  })

  it("finds a number split by a comma or a line break", () => {
    expect(numberIsInTranscript("call me at 650 555, 0147", NUM)).toBe(true)
    expect(numberIsInTranscript("Caller: call me at 650 555\n0147 after six", NUM)).toBe(true)
  })

  it("does not count a number only Jackie said", () => {
    const t = [
      "[Call answered by Jackie, Ryan's AI receptionist. Not a voicemail.]",
      "Jackie: Is 650 555 0147 a good number for you?",
      "Caller: Yeah, sure.",
    ].join("\n")
    expect(numberIsInTranscript(t, NUM)).toBe(false)
  })

  it("counts the caller's wrapped turn and ignores Jackie's lines", () => {
    const t = [
      "[Call answered by Jackie, Ryan's AI receptionist. Not a voicemail.]",
      "Jackie: Hello?",
      "Caller: I'm calling about the letter on 12 Sample Ct.",
      "Jackie: Okay. What's the best number for Ryan to reach you?",
      "Caller: a person Just so you know He has my address",
      "and he can call me at 650 555 0147 as late as 9 o'clock. clock Thank you",
      "Jackie: Okay, sure.",
    ].join("\n")
    expect(numberIsInTranscript(t, NUM)).toBe(true)
  })

  it("does not stitch address digits onto the number", () => {
    const t = [
      "Jackie: What can I do for you?",
      "Caller: He has my address 574 Sample Way S A M P L E and he can call me at 650 555 0147 as late as 9 o'clock.",
    ].join("\n")
    expect(numberIsInTranscript(t, NUM)).toBe(true)
    // A model that ran the address into the number must fail.
    expect(numberIsInTranscript(t, "5746505550")).toBe(false)
    expect(numberIsInTranscript(t, "7465055501")).toBe(false)
    // Nor can the number continue into "9 o'clock".
    expect(numberIsInTranscript(t, "5055501479")).toBe(false)
  })

  it("does not stitch digits across words even with no gap in the digit run", () => {
    expect(numberIsInTranscript("574 Sample Way 6505550 is the gate code", "5746505550")).toBe(false)
  })

  it("fails on nine digits", () => {
    expect(numberIsInTranscript("call me at 650 555 014", NUM)).toBe(false)
    expect(numberIsInTranscript("call me at 650 555 0147", "650555014")).toBe(false)
  })

  it("fails on a number that isn't there", () => {
    expect(numberIsInTranscript("call me at 650 555 0147", "6505550174")).toBe(false)
  })

  it("uses the whole transcript when there are no speaker labels", () => {
    expect(numberIsInTranscript("Hi Ryan, it's Sam about the house on Elm, you can call me at 650 555 0147. Bye.", NUM)).toBe(true)
  })
})
