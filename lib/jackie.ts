// Jackie (AI receptionist) — how a live Twilio call reaches her.
//
// Until 10-27 the test line sat on an Elastic SIP trunk wired straight to
// OpenAI, so Jackie answered before anything else could happen. The mailer
// lines need Ryan's cell to ring first, so Jackie is reached mid-call
// instead: the no-answer step returns <Dial><Sip> to OpenAI's SIP address.
// OpenAI then POSTs live.transport.incoming to /api/voice-test/incoming,
// which reads the x-lrg-* headers below to know which line and lead the
// call belongs to. Twilio records the leg and enforces the 11-minute cap.
//
// sip_headers are caller-supplied metadata as far as OpenAI is concerned
// (anyone who knows the project's SIP address can put anything there), so
// they only label a call — they never unlock coach mode or anything else.

import { twimlAttr } from "@/lib/relationship-calls"

const OPENAI_SIP_PROJECT = "proj_cdGIRfYygFHgxVOhoeq1nUJe"

// Hard cap on Twilio's side (Ryan, 10-25: 11 minutes). The sideband watcher
// wraps her at 10 min and hangs up at 11; this catches the case where the
// watcher itself died.
export const JACKIE_TIME_LIMIT_SEC = 11 * 60 + 15

export type JackieCallTags = {
  /** Which line the caller dialed — "test" or a CAMPAIGN_MAP label. */
  line: string
  /** Lead row the call belongs to (production lines). */
  leadId?: string | null
}

export function jackieSipUri(tags: JackieCallTags): string {
  const headers = new URLSearchParams({ "x-lrg-line": tags.line })
  if (tags.leadId) headers.set("x-lrg-lead", tags.leadId)
  // secure=true = SRTP. TLS alone only encrypts signaling, and OpenAI
  // answers plain RTP with 488 Not Acceptable Here (measured 10-27).
  return `sip:${OPENAI_SIP_PROJECT}@sip.api.openai.com;transport=tls;secure=true?${headers.toString()}`
}

/**
 * TwiML that hands the live call to Jackie. `action` gets Twilio's
 * DialCallStatus when her leg ends (or fails to connect — that's where the
 * voicemail fallback lives); `recordingCallback`, if given, receives the
 * dual-channel recording of her conversation.
 */
export function jackieDialTwiml(opts: {
  tags: JackieCallTags
  action: string
  recordingCallback?: string
}): string {
  const record = opts.recordingCallback
    ? ` record="record-from-answer-dual" recordingStatusCallback="${twimlAttr(opts.recordingCallback)}" recordingStatusCallbackMethod="POST"`
    : ` record="record-from-answer-dual"`
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="15" timeLimit="${JACKIE_TIME_LIMIT_SEC}" action="${twimlAttr(opts.action)}" method="POST"${record}>
    <Sip>${twimlAttr(jackieSipUri(opts.tags))}</Sip>
  </Dial>
</Response>`
}

/** The x-lrg-* labels (and Twilio's own call sid) from OpenAI's sip_headers. */
export function jackieTagsFromSipHeaders(sipHeaders: unknown): {
  line: string | null
  leadId: string | null
  twilioCallSid: string | null
} {
  const get = (name: string): string | null => {
    if (!Array.isArray(sipHeaders)) return null
    const h = sipHeaders.find((x) => typeof x?.name === "string" && x.name.toLowerCase() === name)
    return typeof h?.value === "string" && h.value.trim() ? h.value.trim() : null
  }
  const leadId = get("x-lrg-lead")
  return {
    line: get("x-lrg-line"),
    leadId: leadId && /^[0-9a-f-]{36}$/i.test(leadId) ? leadId : null,
    twilioCallSid: get("x-twilio-callsid"),
  }
}
