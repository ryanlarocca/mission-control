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
  | "long_term_nurture"

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

// Long-term nurture — for leads who say "not now, maybe in 1-2 years".
// Stops the aggressive direct_mail_call cadence; soft check-ins every
// ~60d in year 1, then half-yearly in year 2. Total: 60 / 120 / 180 /
// 240 / 365 / 540 days from apply time. Channel alternates email →
// iMessage starting with email so the first touch (60d out) is the
// least intrusive. delayHours are INTERVALS between touches, not
// cumulative-from-start: 1440h = 60d, 3000h = 125d, 4200h = 175d.
// Applied via POST /api/leads/[id]/long-term-nurture (also stamps a
// 6-month follow-up callback on the lead).
const LONG_TERM_NURTURE_TOUCHES: DripTouch[] = [
  { touchNumber: 1, delayHours: 1440, channel: "email" },     // 60d
  { touchNumber: 2, delayHours: 1440, channel: "imessage" },  // +60d → 120d
  { touchNumber: 3, delayHours: 1440, channel: "email" },     // +60d → 180d
  { touchNumber: 4, delayHours: 1440, channel: "imessage" },  // +60d → 240d
  { touchNumber: 5, delayHours: 3000, channel: "email" },     // +125d → 365d (anniversary)
  { touchNumber: 6, delayHours: 4200, channel: "imessage" },  // +175d → 540d
]

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
  long_term_nurture: {
    type: "long_term_nurture",
    entryDelayHours: 0,
    touches: LONG_TERM_NURTURE_TOUCHES,
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
  // Long-term nurture: defined channels alternate email/iMessage but when
  // the lead has no phone, downgrade iMessage touches to email so they
  // don't silently no-op.
  if (campaign.type === "long_term_nurture" && !hasPhone) {
    return "email"
  }
  return defined?.channel ?? "imessage"
}

// Lifecycle statuses that disqualify a lead from drip processing. Active
// leads are being personally worked by Ryan; dead is terminal. The DNC and
// Junk *flags* (is_dnc / is_junk on the lead row) are checked separately
// in the drip engine's WHERE clause.
export const DRIP_STOP_STATUSES = ["active", "dead"] as const

// Source-aware campaign selection for Apply Drip. Google Ads form leads
// get the AI-drafted google_ads_* campaigns; legacy direct-mail leads stay
// on direct_mail_*. Falling all the way through to direct_mail_call for an
// unknown-source phone lead is the legacy behavior — kept so we don't
// regress on outbound number callbacks or unmapped sources.
export function pickCampaignType(lead: {
  caller_phone: string | null
  email: string | null
  source: string | null
}): DripCampaignType | null {
  const src = (lead.source || "").toLowerCase()
  if (src === "google ads") {
    if (lead.caller_phone) return "google_ads_form"
    if (lead.email) return "google_ads_email_only"
    return null
  }
  if (lead.caller_phone) return "direct_mail_call"
  if (lead.email) return "direct_mail_email"
  return null
}
