import { NextResponse } from "next/server"
import { waitUntil } from "@vercel/functions"
import { triggerTelegramDraft } from "@/lib/reply/telegram"
import {
  OFFICE_NUMBERS,
  OUTBOUND_TWILIO_NUMBER,
  RESET_TO_NEW_SUFFIX,
  SOURCE_OVERRIDE_NUMBERS,
  WEBSITE_NUMBER,
  resolveIntakeStatus,
  dedupeClusterStamps,
  getCampaignSource,
  getLeadsClient,
  isDncMessage,
  isMobileHome,
  isOwnedNumber,
  type LeadStatus,
  lookupLeadName,
  parseTwilioBody,
  sendTelegramAlert,
} from "@/lib/leads"
import { scoreLeadSpam, spamAlertLines, spamReviewColumns, type SpamScore } from "@/lib/lead-spam"
import { isAnonymousCaller } from "@/lib/anonymous"
import { describeContact, formatUsPhone, isOfficeLine, logInboundTextTouch, resolveOfficeCaller } from "@/lib/office-inbound"
import { escapeTelegramHtml, handleInboundVendorText } from "@/lib/vendorMarketing"
import { isKnownVendorPitch, screenVendorPitch, vendorPitchAlert, vendorPitchColumns, type VendorPitch } from "@/lib/vendorPitch"
import { correctOptOutAddress, explicitOptOutPhrase, inheritContactDnc, isCourtesyReply, isTwilioStopKeyword, markContactDnc, optOutAddressLine } from "@/lib/dnc"
import { callerHistory, isKnownCaller, type CallerHistory } from "@/lib/jackie"
import { contactAlertLines, type AlertContact } from "@/lib/contactAlert"

// Twilio fires this when a lead texts any of our lead-facing lines (the
// campaign lines, the ported mailer lines, the Google Ads line, the office
// lines or the outbound caller-ID number — see CAMPAIGN_MAP). We log it and
// alert Ryan; no auto-reply for now. Replies go back from the same line
// (resolveReplyLine).
//
// Phase 7C-may8 Bug 6: STOP / unsubscribe keywords flip is_dnc + status=dead
// on the matched intake row and skip the normal drip-eligible insert.
//
// Phase 7C-may8 Bug 1: inbound SMS to +16502043247 (the outbound caller-ID
// number) is treated as a callback against the existing lead, not a fresh
// intake — no drip-campaign stamp, no status reset.

// Inbound-text analysis + automatic status run in waitUntil after the TwiML.
export const maxDuration = 300

const EMPTY_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response></Response>`


// A swallowed write failure on an inbound text is exactly the kind of silent
// failure Ryan wants surfaced (2026-10-16: a DNC insert failed with only a
// console.error — the message never reached the timeline and nobody knew).
async function alertWriteFailure(what: string, from: string, source: string, error: { message?: string } | Error | string): Promise<void> {
  const msg = typeof error === "string" ? error : error?.message ?? String(error)
  const escaped = msg.replace(/[<>&]/g, c => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"))
  await sendTelegramAlert(`⚠️ Inbound text from ${from} to <b>${source}</b> — ${what} failed, Supabase said: ${escaped}`).catch(() => {})
}

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

  // Our own infrastructure texting itself is never a lead. The landing page
  // sends its "🔔 NEW LEAD" alert SMS from the Google Ads number to the
  // Office — Info line; without this check that alert was ingested as an
  // inbound lead whose caller_phone was our own number, and clicking Call
  // dialed us straight into our own voicemail (2026-09-03, Hannah Melotto).
  // The real lead row is created by the landing page's own form POST — this
  // SMS is only a notification, so dropping it loses nothing.
  if (isOwnedNumber(from)) {
    console.warn(`[sms] ignoring self-originated SMS from our own number ${from} -> ${to}`)
    return new NextResponse(EMPTY_TWIML, { status: 200, headers: { "Content-Type": "text/xml" } })
  }

  // Office lines (the business card): Relationships → Leads → new
  // Relationships contact (brief: BRIEF_OFFICE_LINE_INBOUND_2026-09-24). A
  // text from a contact lands on their card as an inbound touch, never as a
  // lead row. STOP keywords from a contact are just logged — they're not in
  // any drip to begin with.
  if (from && to && isOfficeLine(to) && !isAnonymousCaller(from)) {
    try {
      const sb = getLeadsClient()
      const who = await resolveOfficeCaller(sb, from, bodyText)
      if (who.kind === "relationship") {
        await logInboundTextTouch(sb, who, bodyText, to)
        const preview = bodyText.length > 300 ? bodyText.slice(0, 300) + "…" : bodyText
        const escaped = preview.replace(/[<>&]/g, c => c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;")
        // Matched by the number they signed with: that number leads the
        // alert (a reply goes to the first +1… in it), the bulk line after.
        const header = who.signedAs
          ? `${describeContact(who)} — ${who.signedAs}\n(texted from ${formatUsPhone(from)} — the number they signed with is on this card, so I added this one to it)`
          : `${describeContact(who)} — ${from}`
        await sendTelegramAlert(`💬 Office line text — ${header}\n"${escaped}"`)
        return new NextResponse(EMPTY_TWIML, { headers: { "Content-Type": "text/xml" } })
      }
    } catch (e) {
      console.error("[sms] office-line resolve threw; falling back to lead intake:", e)
    }
  }

  // Vendor texts (Thumbtack & co., 2026-10-16): a marketing blast gets a STOP
  // back from the line it hit + its own Telegram alert with the full message;
  // the vendor's opt-out confirmation gets a ✅; anything further from a
  // number we've STOPped is dropped. Nothing in `leads`. Runs before the
  // office-line and DNC paths so "Reply STOP to opt out" boilerplate never
  // reaches isDncMessage. See lib/vendorMarketing.
  if (from) {
    try {
      const outcome = await handleInboundVendorText(getLeadsClient(), { from, to, body: bodyText })
      if (outcome !== "not_vendor") {
        return new NextResponse(EMPTY_TWIML, { status: 200, headers: { "Content-Type": "text/xml" } })
      }
    } catch (e) {
      // Classification never throws; only the STOP/alert leg can. Don't let
      // a vendor-handling hiccup turn a vendor into a lead — alert + return.
      const msg = e instanceof Error ? e.message : String(e)
      console.error("[sms] vendor handler threw:", msg)
      await alertWriteFailure("vendor-text STOP/alert", from, getCampaignSource(to) || to, msg)
      return new NextResponse(EMPTY_TWIML, { status: 200, headers: { "Content-Type": "text/xml" } })
    }
  }

  const source = getCampaignSource(to)
  const isOffice = isOfficeLine(to)
  // Keyword STOP or an explicit remove request ("please take me off your
  // list for 765 N …") — Ryan's rule: only a request to stop contact is DNC.
  const isDnc = isDncMessage(bodyText) || !!explicitOptOutPhrase(bodyText)
  // The website line gets source_type=website and NO automatic drip — a
  // texter off lrghomes.com may be an agent or a curious visitor, not a
  // seller (Ryan, 2026-10-27). MFM-A/B + outbound callback stay on direct-mail.
  const isWebsite = to === WEBSITE_NUMBER
  // A text to the outbound caller-ID number is a callback against outreach
  // Ryan already started — treat it as a callback, not a fresh intake, and
  // never start a fresh drip on it. Office/admin lines (OFFICE_NUMBERS) get
  // the same treatment.
  const isOutboundCallback = to === OUTBOUND_TWILIO_NUMBER || OFFICE_NUMBERS.has(to)

  if (from) {
    // Fake-lead score — assigned in the non-DNC path below, read again at
    // the Telegram alert (outside the try), so declared at this scope.
    let spam: SpamScore | null = null
    // Lead name for the Telegram alert label — resolved inside the try once
    // we have a Supabase client. Null for a brand-new caller (no prior row
    // carries a name yet); the alert falls back to the phone number.
    let leadName: string | null = null
    // Who this is for the "Repeat text" alert — the same lookup the call
    // alert and Jackie use (lib/jackie callerHistory). Null on a lookup
    // failure; the alert then falls back to whether there's an earlier row.
    let history: CallerHistory | null = null
    let hasPriorRow = false
    let newLeadId: string | null = null
    // §6 (2026-10-21): a returning texter on a NOO Q4 line was reset to New —
    // read again at the Telegram alert below.
    let resetToNew = false
    // Set when the texter is already do-not-contact (see the non-DNC path).
    let dncReply: { kind: "corrected" | "courtesy" | "other"; line: string | null } | null = null
    try {
      const sb = getLeadsClient()

      if (isDnc) {
        // Timeline row for the opt-out itself (the UI groups events by
        // caller_phone), then markContactDnc flags EVERY row of the contact,
        // matches the mailed address, writes the do-not-contact entry and
        // halts queued outreach (lib/dnc.ts).
        const { data: optRow, error: insertErr } = await sb.from("leads").insert({
          source,
          source_type: "direct_mail",
          twilio_number: to || null,
          caller_phone: from,
          lead_type: "sms",
          message: bodyText,
          status: "dead",
          is_dnc: true,
        }).select("id").single()
        if (insertErr) {
          console.error("[sms] DNC insert failed:", insertErr)
          await alertWriteFailure("DNC timeline insert", from, source, insertErr)
        }
        const optId = (optRow?.id as string | undefined) ?? null
        let addressLine: string | null = null
        if (optId) {
          try {
            const { resolveCampaignId } = await import("@/lib/campaigns")
            const campaignId = await resolveCampaignId({ source, source_type: "direct_mail", created_at: new Date() })
            if (campaignId) await sb.from("leads").update({ campaign_id: campaignId, campaign_via: "line" }).eq("id", optId)
          } catch (e) {
            console.warn("[sms] campaign attribution failed:", e instanceof Error ? e.message : String(e))
          }
          const out = await markContactDnc(sb, optId, { addedBy: "system", heardAddress: bodyText })
          if (!out.ok) await alertWriteFailure("DNC flag", from, source, out.error || "unknown")
          addressLine = optOutAddressLine(out.record)
        }

        const dncName = await lookupLeadName(sb, from)
        const dncWho = dncName ? `${dncName} — ${from}` : from
        const preview = bodyText.length > 300 ? bodyText.slice(0, 300) + "…" : bodyText
        const esc = preview.replace(/[<>&]/g, c => c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;")
        await sendTelegramAlert([
          `🚫 Lead DNC'd — <b>${source}</b> — ${dncWho}`,
          `"${esc}"`,
          addressLine ? `🏠 Off the mailing list: ${addressLine}` : "⚠️ No mailed address matched — texts blocked, mail NOT blocked until we know the address",
        ].join("\n"))
        // Confirmation draft ("you're off my list") for Ryan's ✅ — except a
        // bare Twilio keyword (STOP/UNSUBSCRIBE…): Twilio already replied and
        // blocks the number.
        if (optId && !isTwilioStopKeyword(bodyText)) await triggerTelegramDraft(optId)

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
      hasPriorRow = !!existingRow
      history = await callerHistory(sb, from, null).catch((e) => {
        console.warn("[sms] caller history failed:", e instanceof Error ? e.message : String(e))
        return null
      })

      const isJunkAddr = isMobileHome(bodyText)

      // Vendor pitch on the website line (lib/vendorPitch, 2026-11-06): a
      // first-time texter selling LRG Homes a service is closed on arrival —
      // no planner draft, no analyzer, one quiet 🧹 line. A later text from a
      // number already closed that way gets the same quiet line.
      let pitch: VendorPitch | null = null
      let knownPitch = false
      if (isWebsite) {
        if (!existingRow) pitch = await screenVendorPitch({ channel: "text", message: bodyText })
        else knownPitch = await isKnownVendorPitch(sb, from)
      }

      // A text to a SOURCE_OVERRIDE_NUMBERS line (NOO Q4 2026) is a response to
      // that mailer even from a known caller — the new row takes the line's
      // label; the drip stamp still inherits from the cluster. Status: a
      // response to the new letter is a new lead (§6, 2026-10-21) — "new",
      // is_junk false, unless any row in the cluster is DNC (DNC wins and
      // today's inheritance applies). Legacy lines inherit as before. The
      // STOP path above never reaches here.
      const overrideSource = SOURCE_OVERRIDE_NUMBERS.has(to)
      const intake = resolveIntakeStatus({
        override: overrideSource,
        hasPriorRow: !!existingRow,
        inheritedStatus,
        priorSource: existingRow?.source ?? null,
        clusterDnc: overrideSource && existingRow ? history?.dnc ?? false : false,
      })
      resetToNew = intake.reset
      const insertRow: Record<string, unknown> = {
        source: overrideSource ? source : existingRow?.source || source,
        source_type: overrideSource
          ? "direct_mail"
          : existingRow?.source_type || (isWebsite ? "website" : isOffice ? "office" : "direct_mail"),
        twilio_number: to || null,
        caller_phone: from,
        lead_type: "sms",
        message: bodyText,
        status: intake.status,
      }
      // This text's own junk signal (mobile-home address) still wins.
      if (isJunkAddr) insertRow.is_junk = true
      else if (intake.isJunk === false) insertRow.is_junk = false

      if (!existingRow) {
        if (!isOutboundCallback) {
          // Fresh intake — stamp drip campaign for the engine to pick up.
          // Skipped for texts to the outbound caller-ID number: that's a
          // lead replying to outreach Ryan already started, not a new
          // direct-mail lead — a fresh drip would double up. The website
          // line gets no stamp at all (Ryan applies a cadence per lead);
          // MFM-A/B stays direct_mail_sms.
          if (!isWebsite) {
            insertRow.drip_campaign_type = "direct_mail_sms"
            insertRow.drip_touch_number = 0
            insertRow.last_drip_sent_at = new Date().toISOString()
          }
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
      if (isWebsite && !existingRow) {
        spam = scoreLeadSpam({ phone: from })
        if (spam.suspicious) Object.assign(insertRow, spamReviewColumns(spam))
      }

      if (pitch) Object.assign(insertRow, vendorPitchColumns(pitch))
      else if (knownPitch) Object.assign(insertRow, { status: "dead", is_junk: true })

      const { data: insertedRow, error } = await sb
        .from("leads")
        .insert(insertRow)
        .select("id")
        .single()
      if (error) {
        console.error("[sms] Supabase insert failed:", error)
        await alertWriteFailure("lead insert", from, source, error)
      }
      newLeadId = insertedRow?.id ?? null

      if (pitch || knownPitch) {
        await sendTelegramAlert(vendorPitchAlert({ where: "website line", who: from, pitch, message: bodyText, esc: escapeTelegramHtml }))
        return new NextResponse(EMPTY_TWIML, { headers: { "Content-Type": "text/xml" } })
      }

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
            source_type: (insertRow.source_type as string) ?? (isWebsite ? "website" : "direct_mail"),
            created_at: new Date(),
          })
          if (campaignId) {
            // "line" = the dialed number's own label; "inherited" = carried
            // over from the caller's earlier rows (lib/mailCredit).
            const via = insertRow.source === source ? "line" : "inherited"
            await sb.from("leads").update({ campaign_id: campaignId, campaign_via: via }).eq("id", insertedRow.id)
          }
        } catch (e) {
          console.warn("[sms] campaign attribution failed:", e instanceof Error ? e.message : String(e))
        }
      }
      if (insertedRow?.id) {
        // Mailed-record link (direct-mail tracking): a returning caller inherits
        // the cluster's record; a fresh row waits for triage to fill name/address.
        try {
          const { autoLinkMailRecord } = await import("@/lib/mailMatch")
          await autoLinkMailRecord(sb, insertedRow.id)
        } catch (e) {
          console.warn("[sms] mail-record link failed:", e instanceof Error ? e.message : String(e))
        }
      }

      // Already do-not-contact (asked off the list earlier): no card, no
      // draft, no analyzer. A new address is a correction → move the
      // do-not-contact entry; "thanks" is silent; anything else is an FYI.
      // (inheritContactDnc checks their other rows and the master list, and
      // flags this row is_dnc + dead.)
      if (insertedRow?.id && (await inheritContactDnc(sb, insertedRow.id, { phone: from })).dnc) {
        const corrected = await correctOptOutAddress(sb, insertedRow.id, bodyText).catch((e) => {
          console.warn("[sms] opt-out address correction failed:", e instanceof Error ? e.message : String(e))
          return null
        })
        dncReply = corrected ? { kind: "corrected", line: optOutAddressLine(corrected) } : isCourtesyReply(bodyText) ? { kind: "courtesy", line: null } : { kind: "other", line: null }
        newLeadId = null
      }

      // Reply Planner (2026-09-24): inbound texts had no AI at all, so the
      // card had no moment to plan from. Propose the plan over the Supabase
      // cluster (no sidecar hop — this is a Twilio webhook) and stamp
      // leads.moment. Best-effort; the alert below goes out regardless.
      if (insertedRow?.id && !dncReply) {
        try {
          const { buildLeadContext, proposePlan, stampLeadMoment } = await import("@/lib/reply")
          const ctx = await buildLeadContext(insertedRow.id, { live: false })
          const plan = ctx ? await proposePlan(ctx) : null
          if (ctx && plan) await stampLeadMoment(ctx.clusterIds, plan.moment)
        } catch (e) {
          console.warn("[sms] reply plan failed:", e instanceof Error ? e.message : String(e))
        }
      }
    } catch (e) {
      console.error("[sms] Supabase threw:", e)
    }

    const preview = bodyText.length > 300 ? bodyText.slice(0, 300) + "…" : bodyText
    const escaped = preview.replace(/[<>&]/g, c => c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;")
    const alertContact: AlertContact = history
      ? {
          known: isKnownCaller(history),
          name: history.prior?.name ?? history.relationshipName ?? leadName,
          address: history.prior?.property_address ?? null,
          dnc: history.dnc || !!dncReply,
          dncSince: history.dncSince ?? null,
          iphoneOnly: !history.prior && !history.relationship && history.iphone,
        }
      : { known: hasPriorRow, name: leadName, address: null, dnc: !!dncReply, dncSince: null }
    if (dncReply) {
      if (dncReply.kind === "corrected") {
        await sendTelegramAlert(`📍 Do-not-contact address corrected — ${from}\n"${escaped}"\n🏠 Now off the mailing list: ${dncReply.line ?? "(address updated)"}`)
      } else if (dncReply.kind === "other") {
        const head = contactAlertLines({ kind: "text", source, phone: from, contact: { ...alertContact, known: true, dnc: true } })
        await sendTelegramAlert([...head.slice(0, -1), `${head[head.length - 1]} · no reply drafted`, `"${escaped}"`].join("\n"))
      }
      return new NextResponse(EMPTY_TWIML, { headers: { "Content-Type": "text/xml" } })
    }
    // Label with the lead's name when we know it, falling back to the phone.
    // The phone stays in the alert regardless — the Telegram reply handler
    // parses it out of this text to know who to SMS back.
    const smsAlert = [
      ...contactAlertLines({ kind: "text", source, phone: from, contact: alertContact, suffix: resetToNew ? RESET_TO_NEW_SUFFIX : "" }),
      `"${escaped}"`,
    ]
    // Append the fake-lead warning to the same note — no-op when clean.
    if (spam) smsAlert.push(...spamAlertLines(spam))
    await sendTelegramAlert(smsAlert.join("\n"))
    // Reply Planner: plan + draft as a second message (non-blocking).
    if (newLeadId && !(spam && spam.suspicious)) await triggerTelegramDraft(newLeadId)
    // Read the text like a call (name / address / follow-up / offer → card,
    // mailed-record link) and run automatic status (2026-10-24). In
    // waitUntil: two model calls would push Twilio's 15 s webhook budget.
    if (newLeadId && !(spam && spam.suspicious)) {
      const { processInboundTextBackground } = await import("@/lib/leads")
      waitUntil(processInboundTextBackground(newLeadId, from, bodyText))
    }
  }

  return new NextResponse(EMPTY_TWIML, {
    headers: { "Content-Type": "text/xml" },
  })
}
