// Herb-shaped thread fixture (briefs/BRIEF_COACHED_DRAFT_2026-10-15.md).
// Synthetic text in the shape of the real rows: one ~7,600-char OUTBOUND
// call transcript (Ryan placed it, so twilio_number is null) whose two
// load-bearing sentences sit past the old 4,000-char clip, one
// Twilio-inbound voicemail, one inbound "Yes" text. Nothing here is a real
// transcript; names and figures come from the brief.

import type { LeadThreadRow } from "@/lib/reply/context"
import type { LeadContext } from "@/lib/reply/context"

export const FLOOR_SENTENCE = "it was appraised a couple years ago at 1.6 million"
export const PROMISE_SENTENCE = "I can text you a, like a, an offer"

// Filler that reads like call chatter so the positions are realistic.
const FILLER_LINES = [
  "Ryan: Yeah, no, that makes sense. So how long have you had the place?",
  "Herb: Oh, gosh, we bought it back in, uh, it must have been the early nineties.",
  "Ryan: Okay. And it's three units, all occupied right now?",
  "Herb: Two are rented, the front one my nephew was in for a while, it's empty now.",
  "Ryan: Got it. And the roof, when was that last done, do you remember?",
  "Herb: I'd have to look. It doesn't leak, I'll tell you that much.",
  "Ryan: Ha, that's the main thing. Kitchens and baths, pretty much original?",
  "Herb: Pretty much, yeah. We redid one bathroom maybe fifteen years ago.",
  "Ryan: Sure. Okay. And rents, roughly, what are the two tenants paying?",
  "Herb: One's at fourteen hundred and the other's at, uh, sixteen fifty, I think.",
]

function filler(targetChars: number): string {
  const out: string[] = []
  let n = 0
  let i = 0
  while (n < targetChars) {
    const line = FILLER_LINES[i % FILLER_LINES.length]
    out.push(line)
    n += line.length + 1
    i++
  }
  return out.join("\n")
}

/** Builds the ~7,600-char two-voice transcript. The floor sentence lands
 *  near 4,300 chars and the promise near 6,200, like the real row. */
export function buildHerbTranscript(): string {
  const head = "Ryan: Hey Herb, it's Ryan LaRocca, I sent you the letter about 409 Center Street.\nHerb: Oh yeah, yeah, I got that. The triplex.\n"
  const part1 = filler(4300 - head.length - 20)
  const floor = `\nHerb: Well, ${FLOOR_SENTENCE} and honestly I wouldn't go lower than that.\n`
  const part2 = filler(6200 - (head.length + part1.length + floor.length) - 20)
  const promise = `\nRyan: Okay, let me run my numbers on it and ${PROMISE_SENTENCE}, a ballpark, in the next couple of days.\nHerb: Sure, that's fine, text is fine.\n`
  const rest = filler(7600 - (head.length + part1.length + floor.length + part2.length + promise.length))
  return head + part1 + floor + part2 + promise + rest
}

export function herbRows(): LeadThreadRow[] {
  return [
    {
      created_at: "2026-10-12T18:02:00.000Z",
      lead_type: "call",
      twilio_number: null,            // Ryan placed this call from the card
      message: buildHerbTranscript(),
    },
    {
      created_at: "2026-10-13T16:40:00.000Z",
      lead_type: "voicemail",
      twilio_number: "+16502043247",  // Twilio inbound
      message: "Hi Ryan, it's Herb, about Center Street. Just checking whether you had a number for me yet. Call me back when you can.",
    },
    {
      created_at: "2026-10-14T20:11:00.000Z",
      lead_type: "sms",
      twilio_number: "+16502043247",
      message: "Yes",
    },
  ]
}

export function herbContext(thread: LeadContext["thread"]): LeadContext {
  return {
    kind: "lead",
    leadId: "b6a07bb7-d478-4646-9090-19794e821cd4",
    clusterIds: ["b6a07bb7-d478-4646-9090-19794e821cd4"],
    name: "Herb",
    email: null,
    phone: "+18315550123",
    property_address: "409 Center St, Santa Cruz, CA",
    property_details: [{ label: "Type", value: "Triplex" }, { label: "Condition", value: "Mostly original" }],
    status: "active",
    temperature: "warm",
    moment: "offer_requested",
    source: "Santa Cruz multifamily",
    campaign_label: "Santa Cruz multifamily",
    ai_summary: "Owner of a triplex at 409 Center St; appraised at $1.6M two years ago; Ryan promised a ballpark number by text.",
    notes: "Offer 1.1\nCalled 10/12, long talk, he is firm on 1.6 but listened.",
    offer_amount: 1100000,
    offer_verbalized_at: "2026-10-12T18:40:00.000Z",
    drip_campaign_type: null,
    recommended_followup_date: "2026-10-15",
    followup_reason: "Owed: text Herb a ballpark number",
    gmail_thread_id: null,
    inboundChannel: "sms",
    thread,
    lastInbound: [...thread].reverse().find((t) => t.from === "them") ?? null,
  }
}
