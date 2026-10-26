import { describe, it, expect } from "vitest"
import { toHistoryItem, type HistoryRow } from "@/lib/lead-history"

function row(p: Partial<HistoryRow>): HistoryRow {
  const message = p.message_head ?? null
  return {
    id: "x", created_at: "2026-10-26T18:00:00Z", lead_type: "sms", twilio_number: null,
    caller_phone: "+14085550100", email: null, gmail_thread_id: null,
    message_head: message, message_len: message?.length ?? 0,
    ai_notes_head: null, history_line: null, has_recording: false,
    ...p,
  }
}

describe("lead history lines", () => {
  it("texts show as written; drips are flagged auto", () => {
    const t = toHistoryItem(row({ message_head: "Hey Dick,  following up\non 176 N Morrison" }))!
    expect(t).toMatchObject({ kind: "text", dir: "out", auto: false, line: "Hey Dick, following up on 176 N Morrison", more: false })
    expect(toHistoryItem(row({ lead_type: "drip_imessage", message_head: "hi" }))!.auto).toBe(true)
    expect(toHistoryItem(row({ lead_type: "sms", twilio_number: "+14085550199", message_head: "yes" }))!.dir).toBe("in")
  })

  it("a short voicemail is quoted in full, no summary needed", () => {
    const v = toHistoryItem(row({ lead_type: "voicemail", twilio_number: "+1408", message_head: "Got your letter, call me back." }))!
    expect(v).toMatchObject({ kind: "voicemail", line: "“Got your letter, call me back.”", more: false, needsLine: false })
  })

  it("a long call uses the saved one-liner, else asks for one", () => {
    const long = "word ".repeat(120)
    const saved = toHistoryItem(row({ lead_type: "call", message_head: long, history_line: "Not selling at a regular price; door left open" }))!
    expect(saved).toMatchObject({ kind: "call", line: "Not selling at a regular price; door left open", more: true, needsLine: false })
    const pending = toHistoryItem(row({ lead_type: "call", message_head: long, ai_notes_head: "Ryan spoke with Dick. He is not selling." }))!
    expect(pending).toMatchObject({ line: "Ryan spoke with Dick.", more: true, needsLine: true })
  })

  it("a status the call handler wrote is not quoted", () => {
    expect(toHistoryItem(row({ lead_type: "call", message_head: "📵 No answer — rang out" }))!.line).toBe("📵 No answer — rang out")
  })

  it("a call with no transcript says what happened", () => {
    expect(toHistoryItem(row({ lead_type: "call" }))!.line).toBe("No answer / not recorded")
    expect(toHistoryItem(row({ lead_type: "call", twilio_number: "+1408" }))!.line).toBe("Missed call — no message")
  })

  it("a text cut by the view is marked as having more", () => {
    const t = toHistoryItem(row({ message_head: "short head", message_len: 900 }))!
    expect(t.more).toBe(true)
  })

  it("unknown or empty rows are skipped", () => {
    expect(toHistoryItem(row({ lead_type: "sms", message_head: null }))).toBeNull()
    expect(toHistoryItem(row({ lead_type: null }))).toBeNull()
  })
})
