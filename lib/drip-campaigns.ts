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
  | "website_followup"
  | "website_followup_email"

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

// Cadences live in lib/drip-cadences.json — the one copy the drip engine
// (scripts/drip-engine.js, plain node) reads too. Edit timings there.
//
//   google_ads_form       touch 0 fires from /api/submit-lead; 30h → 48h →
//                         72h → 7d → 14d → 30d → 60d → every 90d, alternating
//                         iMessage / email
//   google_ads_email_only same timing, all email (upgrades on a phone)
//   direct_mail_call      15-min missed-call text (touch 0, engine-only) then
//                         48h → 72h → 7d → 14d → 30d → 60d → every 90d
//   direct_mail_sms       google_ads_form timing, all iMessage, 48h entry
//   direct_mail_email     google_ads_form timing, all email, 48h entry
//   long_term_nurture     60 / 120 / 180 / 240 / 365 / 540 days, email first
//   website_followup(_email) day 1 / 3 / 7 / 14 after the last call, then
//                         the engine hands off to long_term_nurture
import cadences from "./drip-cadences.json"

export const DRIP_CAMPAIGNS = cadences.campaigns as unknown as Record<DripCampaignType, DripCampaign>

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

// Lifecycle statuses that disqualify a lead from drip processing. Only dead
// (terminal) since 2026-10-24 — Ryan retired "Active pauses the drip":
// status is now set automatically and must not start / stop drips (every
// drip is approval-gated anyway). The DNC and
// Junk *flags* (is_dnc / is_junk on the lead row) are checked separately
// in the drip engine's WHERE clause.
export const DRIP_STOP_STATUSES = ["dead"] as const

// Source-aware campaign selection for Apply Drip. Website leads get the
// short website_followup cadence (2026-11-02); Google Ads form leads
// (historical) get the AI-drafted google_ads_* campaigns
// — the cadence is named for its first source, not tied to it; legacy
// direct-mail leads stay on direct_mail_*. Falling all the way through to
// direct_mail_call for an unknown-source phone lead is the legacy behavior
// — kept so we don't regress on outbound number callbacks or unmapped
// sources.
export function pickCampaignType(lead: {
  caller_phone: string | null
  email: string | null
  source: string | null
}): DripCampaignType | null {
  const src = (lead.source || "").toLowerCase()
  if (src === "website") {
    if (lead.caller_phone) return "website_followup"
    if (lead.email) return "website_followup_email"
    return null
  }
  if (src === "google ads") {
    if (lead.caller_phone) return "google_ads_form"
    if (lead.email) return "google_ads_email_only"
    return null
  }
  if (lead.caller_phone) return "direct_mail_call"
  if (lead.email) return "direct_mail_email"
  return null
}
