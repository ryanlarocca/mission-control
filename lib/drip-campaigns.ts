// Drip campaign definitions for Phase 7B. The drip engine
// (scripts/drip-engine.js) duplicates the same constants in plain JS
// because the engine runs under bare `node` without a TS toolchain — keep
// the two in sync when editing cadences.
//
// Channel mapping for the email_only/direct_mail_email path: when a phone
// number lands on the lead mid-cycle, the engine treats touches with even
// touch_number as email and odd as iMessage to mirror the google_ads_form
// alternation. See `effectiveChannelForTouch` below.

export type DripCampaignType =
  | "google_ads_form"
  | "google_ads_email_only"
  | "direct_mail_call"
  | "direct_mail_sms"
  | "direct_mail_email"

export type DripChannel = "imessage" | "email"

export interface DripTouch {
  touchNumber: number
  delayHours: number // hours since last contact (last_drip_sent_at)
  channel: DripChannel
}

export interface DripCampaign {
  type: DripCampaignType
  entryDelayHours: number // grace period before drip starts
  touches: DripTouch[]
}

// Google Ads form: touch 0 already fires from /api/submit-lead (confirm
// email + SMS to lead), engine starts at touch 1.
const GOOGLE_ADS_FORM_TOUCHES: DripTouch[] = [
  { touchNumber: 1,  delayHours: 30,   channel: "imessage" },
  { touchNumber: 2,  delayHours: 48,   channel: "email" },
  { touchNumber: 3,  delayHours: 72,   channel: "imessage" },
  { touchNumber: 4,  delayHours: 168,  channel: "email" },
  { touchNumber: 5,  delayHours: 336,  channel: "imessage" },
  { touchNumber: 6,  delayHours: 720,  channel: "email" },
  { touchNumber: 7,  delayHours: 1440, channel: "imessage" },
  { touchNumber: 8,  delayHours: 2160, channel: "email" },
  { touchNumber: 9,  delayHours: 2160, channel: "imessage" },
  { touchNumber: 10, delayHours: 2160, channel: "email" },
  { touchNumber: 11, delayHours: 2160, channel: "imessage" },
  { touchNumber: 12, delayHours: 2160, channel: "email" },
  { touchNumber: 13, delayHours: 2160, channel: "imessage" },
]

// Email-only mirror — same timing, all email. Engine upgrades to
// google_ads_form when caller_phone arrives.
const GOOGLE_ADS_EMAIL_ONLY_TOUCHES: DripTouch[] = GOOGLE_ADS_FORM_TOUCHES.map(
  (t) => ({ ...t, channel: "email" })
)

// Direct mail missed-call / voicemail: touch 0 is the 15-min "I see I
// missed your call" follow-up handled inside the engine. Voicemail leads
// skip touch 0 (entry delay 48h handles the gap).
const DIRECT_MAIL_CALL_TOUCHES: DripTouch[] = [
  { touchNumber: 0,  delayHours: 0.25, channel: "imessage" }, // missed-call only — handled in engine
  { touchNumber: 1,  delayHours: 48,   channel: "imessage" },
  { touchNumber: 2,  delayHours: 72,   channel: "imessage" },
  { touchNumber: 3,  delayHours: 168,  channel: "imessage" },
  { touchNumber: 4,  delayHours: 336,  channel: "imessage" },
  { touchNumber: 5,  delayHours: 720,  channel: "imessage" },
  { touchNumber: 6,  delayHours: 1440, channel: "imessage" },
  { touchNumber: 7,  delayHours: 2160, channel: "imessage" },
  { touchNumber: 8,  delayHours: 2160, channel: "imessage" },
  { touchNumber: 9,  delayHours: 2160, channel: "imessage" },
  { touchNumber: 10, delayHours: 2160, channel: "imessage" },
  { touchNumber: 11, delayHours: 2160, channel: "imessage" },
  { touchNumber: 12, delayHours: 2160, channel: "imessage" },
  { touchNumber: 13, delayHours: 2160, channel: "imessage" },
]

// Direct mail inbound SMS — same as call but starts at touch 1 (no
// missed-call touch 0).
const DIRECT_MAIL_SMS_TOUCHES: DripTouch[] = DIRECT_MAIL_CALL_TOUCHES.filter(
  (t) => t.touchNumber > 0
)

// Direct mail inbound email — same timing as google_ads_email_only,
// upgrades to mixed channels (alternating per touch parity) when phone
// found. Same touch numbers — no restart on upgrade.
const DIRECT_MAIL_EMAIL_TOUCHES: DripTouch[] = GOOGLE_ADS_EMAIL_ONLY_TOUCHES

export const DRIP_CAMPAIGNS: Record<DripCampaignType, DripCampaign> = {
  google_ads_form: {
    type: "google_ads_form",
    entryDelayHours: 0,
    touches: GOOGLE_ADS_FORM_TOUCHES,
  },
  google_ads_email_only: {
    type: "google_ads_email_only",
    entryDelayHours: 0,
    touches: GOOGLE_ADS_EMAIL_ONLY_TOUCHES,
  },
  direct_mail_call: {
    type: "direct_mail_call",
    entryDelayHours: 0,
    touches: DIRECT_MAIL_CALL_TOUCHES,
  },
  direct_mail_sms: {
    type: "direct_mail_sms",
    entryDelayHours: 48,
    touches: DIRECT_MAIL_SMS_TOUCHES,
  },
  direct_mail_email: {
    type: "direct_mail_email",
    entryDelayHours: 48,
    touches: DIRECT_MAIL_EMAIL_TOUCHES,
  },
}

export function getCampaign(type: string | null | undefined): DripCampaign | null {
  if (!type) return null
  return DRIP_CAMPAIGNS[type as DripCampaignType] ?? null
}

export function getNextTouch(
  campaign: DripCampaign,
  currentTouchNumber: number | null | undefined
): DripTouch | null {
  const current = currentTouchNumber ?? 0
  return campaign.touches.find((t) => t.touchNumber > current) ?? null
}

// When an email-only campaign acquires a phone mid-cycle, the engine
// alternates channels by parity. Even touches → email; odd → iMessage.
// google_ads_form alternates the same way and starts at iMessage on touch 1.
export function effectiveChannelForTouch(
  campaign: DripCampaign,
  touchNumber: number,
  hasPhone: boolean
): DripChannel {
  const defined = campaign.touches.find((t) => t.touchNumber === touchNumber)
  if (campaign.type === "direct_mail_email" && hasPhone) {
    return touchNumber % 2 === 1 ? "imessage" : "email"
  }
  if (campaign.type === "google_ads_email_only" && hasPhone) {
    return touchNumber % 2 === 1 ? "imessage" : "email"
  }
  return defined?.channel ?? "imessage"
}

// Statuses that disqualify a lead from drip processing. Active leads are
// being personally worked by Ryan; junk/do_not_contact are terminal stops.
export const DRIP_STOP_STATUSES = ["active", "junk", "do_not_contact"] as const
