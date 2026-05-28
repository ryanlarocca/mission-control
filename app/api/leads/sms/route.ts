import { NextResponse } from "next/server"
import {
  OUTBOUND_TWILIO_NUMBER,
  dedupeClusterStamps,
  getCampaignSource,
  getLeadsClient,
  isDncMessage,
  isMobileHome,
  type LeadStatus,
  lookupLeadName,
  parseTwilioBody,
  sendTelegramAlert,
} from "@/lib/leads"
import { scoreLeadSpam, spamAlertLines, spamReviewColumns, type SpamScore } from "@/lib/lead-spam"

// Twilio fires this when a lead texts MFM-A, MFM-B, or the outbound caller-ID
// number. We log it and alert Ryan; no auto-reply for now.
//
// Phase 7C-may8 Bug 6: STOP / unsubscribe keywords flip is_dnc + status=dead
// on the matched intake row and skip the normal drip-eligible insert.
//
// Phase 7C-may8 Bug 1: inbound SMS to +16502043247 (the outbound caller-ID
// number) is treated as a callback against the existing lead, not a fresh
// intake — no drip-campaign stamp, no status reset.

const EMPTY_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response></Response>`

const DNC_LOOKBACK_DAYS = 90

export async function POST(request: Request) {
  let from = ""
  let to = ""
  let bodyText = ""
  try {
    const raw = await request.text()
    const params = parseTwilioBody(raw)
    from = params.get("From") || ""
    to = params.get("To") || ""
    bodyText = params.get("Body") || ""
  } catch (e) {
    console.error("[sms] Failed to parse Twilio body:", e)
  }

  const source = getCampaignSource(to)
  const isDnc = isDncMessage(bodyText)
  // Landing-page Google Ads number gets google_ads source_type + the
  // google_ads_form drip path; MFM-A/B + outbound callback stay on direct-mail.
  const isGoogleAds = to === "+16506703914"
  // A text to the outbound caller-ID number is a callback against outreach
  // Ryan already started — treat it as a callback, not a fresh intake, and
  // never start a fresh drip on it.
  const isOutboundCallback = to === OUTBOUND_TWILIO_NUMBER

  if (from) {
    // Fake-lead score — assigned in the non-DNC path below, read again at
    // the Telegram alert (outside the try), so declared at this scope.
    let spam: SpamScore | null = null
    // Lead name for the Telegram alert label — resolved inside the try once
    // we have a Supabase client. Null for a brand-new caller (no prior row
    // carries a name yet); the alert falls back to the phone number.
    let leadName: string | null = null
    try {
      const sb = getLeadsClient()

      if (isDnc) {
        // Find the most recent intake row for this number and flag it.
        // Search broadly (twilio_number IS NOT NULL) so we hit the original
        // intake regardless of which campaign delivered it.
        const since = new Date(Date.now() - DNC_LOOKBACK_DAYS * 86_400_000).toISOString()
        const { data: existing } = await sb
          .from("leads")
          .select("id")
          .eq("caller_phone", from)
          .not("twilio_number", "is", null)
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(1)
        const existingId = existing?.[0]?.id ?? null

        if (existingId) {
          const { error } = await sb
            .from("leads")
            .update({ is_dnc: true, status: "dead" })
            .eq("id", existingId)
          if (error) console.error("[sms] DNC update failed:", error)
        }

        // Still insert the inbound STOP row so the message shows up in the
        // timeline (the UI groups events by caller_phone). Mark it dead +
        // is_dnc and skip drip fields so the engine never picks it back up.
        const { error: insertErr } = await sb.from("leads").insert({
          source,
          source_type: "direct_mail",
          twilio_number: to || null,
          caller_phone: from,
          lead_type: "sms",
          message: bodyText,
          status: "dead",
          is_dnc: true,
        })
        if (insertErr) console.error("[sms] DNC insert failed:", insertErr)

        const dncName = await lookupLeadName(sb, from)
        const dncWho = dncName ? `${dncName} — ${from}` : from
        void sendTelegramAlert(`🚫 Lead DNC'd — <b>${source}</b> — ${dncWho}`)

        return new NextResponse(EMPTY_TWIML, {
          headers: { "Content-Type": "text/xml" },
        })
      }

      // Non-DNC path. Always look up the most recent inbound row for this
      // caller (no time window) so the new event row inherits the cluster's
      // identity: lifecycle status (so a parked nurture lead replying stays
      // nurture), source / source_type (so the lead stays in its original
      // campaign bucket — without this, groupLeads' "most recent inbound"
      // rule would flip the cluster's source to whichever number they last
      // texted), and drip_campaign_type (so the drip engine doesn't see a
      // second `drip_campaign_type IS NOT NULL` row for the same lead and
      // double-fire touches).
      //
      // A fresh drip stamp (with touch_number=0 + last_drip_sent_at=now)
      // fires ONLY when this is a genuinely new caller (no prior row).
      // Re-engagements carry the campaign type forward without resetting
      // the drip clock — the original intake row owns the cadence.
      const { data: existingRows } = await sb
        .from("leads")
        .select("id, source, source_type, drip_campaign_type, status")
        .eq("caller_phone", from)
        .not("twilio_number", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
      const existingRow = existingRows?.[0] ?? null
      const inheritedStatus: LeadStatus =
        (existingRow?.status as LeadStatus | undefined) ?? "new"

      // Resolve a name for the Telegram alert label (best-effort; null for a
      // genuinely new caller). Runs only when there's a prior row — a fresh
      // intake never has a name yet, so skip the query.
      if (existingRow) leadName = await lookupLeadName(sb, from)

      const isJunkAddr = isMobileHome(bodyText)

      const insertRow: Record<string, unknown> = {
        source: existingRow?.source || source,
        source_type:
          existingRow?.source_type || (isGoogleAds ? "google_ads" : "direct_mail"),
        twilio_number: to || null,
        caller_phone: from,
        lead_type: "sms",
        message: bodyText,
        status: inheritedStatus,
      }
      if (isJunkAddr) insertRow.is_junk = true

      if (!existingRow) {
        if (!isOutboundCallback) {
          // Fresh intake — stamp drip campaign for the engine to pick up.
          // Skipped for texts to the outbound caller-ID number: that's a
          // lead replying to outreach Ryan already started, not a new
          // direct-mail lead — a fresh drip would double up. Google Ads
          // landing number runs google_ads_form; MFM-A/B stays direct_mail_sms.
          insertRow.drip_campaign_type = isGoogleAds ? "google_ads_form" : "direct_mail_sms"
          insertRow.drip_touch_number = 0
          insertRow.last_drip_sent_at = new Date().toISOString()
        }
      } else if (existingRow.drip_campaign_type) {
        // Carry the cluster's drip campaign forward without resetting the
        // clock — the original intake row owns drip_touch_number /
        // last_drip_sent_at; this row is event history only. The cluster
        // is de-duped after insert so the engine sees ONE driver row.
        insertRow.drip_campaign_type = existingRow.drip_campaign_type
      }

      // Score the sender's number for fake-lead red flags — Google Ads
      // leads only for now, fresh leads only (a known returning texter
      // must not be re-flagged). A text carries only a phone at intake.
      if (isGoogleAds && !existingRow) {
        spam = scoreLeadSpam({ phone: from })
        if (spam.suspicious) Object.assign(insertRow, spamReviewColumns(spam))
      }

      const { data: insertedRow, error } = await sb
        .from("leads")
        .insert(insertRow)
        .select("id")
        .single()
      if (error) console.error("[sms] Supabase insert failed:", error)

      // Re-engagement carried the cluster's drip stamp onto this new event
      // row. Sweep the cluster so exactly ONE row drives the drip engine —
      // N stamped rows would queue N parallel touches. No-op for a
      // single-stamp cluster.
      if (existingRow?.drip_campaign_type) {
        try {
          await dedupeClusterStamps(sb, { caller_phone: from, email: null })
        } catch (e) {
          console.warn("[sms] cluster dedupe failed:", e instanceof Error ? e.message : String(e))
        }
      }

      // Campaign attribution — best-effort.
      if (insertedRow?.id) {
        try {
          const { resolveCampaignId } = await import("@/lib/campaigns")
          const campaignId = await resolveCampaignId({
            source: (insertRow.source as string) ?? source,
            source_type: (insertRow.source_type as string) ?? (isGoogleAds ? "google_ads" : "direct_mail"),
            created_at: new Date(),
          })
          if (campaignId) {
            await sb.from("leads").update({ campaign_id: campaignId }).eq("id", insertedRow.id)
          }
        } catch (e) {
          console.warn("[sms] campaign attribution failed:", e instanceof Error ? e.message : String(e))
        }
      }
    } catch (e) {
      console.error("[sms] Supabase threw:", e)
    }

    const preview = bodyText.length > 300 ? bodyText.slice(0, 300) + "…" : bodyText
    const escaped = preview.replace(/[<>&]/g, c => c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;")
    // Label with the lead's name when we know it, falling back to the phone.
    // The phone stays in the alert regardless — the Telegram reply handler
    // parses it out of this text to know who to SMS back.
    const who = leadName ? `<b>${leadName}</b> — ${from}` : from
    const smsAlert = [`💬 New lead text — <b>${source}</b> — ${who}\n"${escaped}"`]
    // Append the fake-lead warning to the same note — no-op when clean.
    if (spam) smsAlert.push(...spamAlertLines(spam))
    void sendTelegramAlert(smsAlert.join("\n"))
  }

  return new NextResponse(EMPTY_TWIML, {
    headers: { "Content-Type": "text/xml" },
  })
}
