import { NextRequest, NextResponse } from "next/server"
import { waitUntil } from "@vercel/functions"
import { timingSafeEqual } from "node:crypto"
import {
  FORWARD_TO,
  WEBSITE_NUMBER,
  getLeadsClient,
  normalizeE164,
  sendTelegramAlert,
  sendTwilioSms,
} from "@/lib/leads"
import { autoLinkMailRecord, creditWebsiteFormToMailCampaign } from "@/lib/mailMatch"
import {
  FORM_ROW_COLUMNS,
  confirmationEmail,
  esc,
  firstText,
  isBusinessHours,
  ladderReason,
  pingTelegram,
  sendAutoEmail,
  sendAutoText,
  syncLadder,
  type FormRow,
} from "@/lib/websiteLead"
import { screenVendorPitch, vendorPitchAlert, vendorPitchColumns } from "@/lib/vendorPitch"

// lrghomes.com contact form → Mission Control (Ryan, 2026-11-02 — website
// leads are call-first; lib/websiteLead.ts has the whole flow). The site's
// api/submit-lead.js POSTs here first and only falls back to writing
// Supabase itself if this route is unreachable.
//
// Public route (listed in middleware.ts PUBLIC_PATHS) — auth is the shared
// WEBSITE_FORM_SECRET in the x-website-secret header, fail closed.
//
// The lead row is written before responding (the site falls back to its own
// Supabase write on any non-200); everything after — mail match, texts,
// email, Telegram — runs in waitUntil so the visitor isn't kept waiting on
// the site's 15-second function budget.
//
// Before this route the site texted its alert to the Office — Info line,
// which /api/leads/sms drops as one of our own numbers — so website leads
// reached nobody (Maryam Norton, 2026-11-02).

export const maxDuration = 60

const ABOUT_LABELS: Record<string, string> = {
  sell: "Sell a property",
  deal: "Bring a deal",
  other: "Something else",
}

function authorized(request: NextRequest): boolean {
  const expected = process.env.WEBSITE_FORM_SECRET?.trim()
  const got = request.headers.get("x-website-secret")?.trim()
  if (!expected || !got) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(got)
  return a.length === b.length && timingSafeEqual(a, b)
}

const str = (v: unknown, max = 500): string => (typeof v === "string" ? v.trim().slice(0, max) : "")

export async function POST(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const fullName = str(body.fullName, 120)
  const email = str(body.email, 200).toLowerCase() || null
  const address = str(body.address, 300) || null
  const about = ABOUT_LABELS[str(body.about)] ? str(body.about) : "sell"
  const note = str(body.message, 1000)
  const smsConsent = body.smsConsent === true
  const phone = normalizeE164(str(body.phone, 40))
  if (!fullName) return NextResponse.json({ error: "fullName is required" }, { status: 400 })
  if (!phone) return NextResponse.json({ error: `Invalid phone: ${str(body.phone, 40)}` }, { status: 400 })

  const isSeller = about === "sell"
  const message = [`[Website form · ${ABOUT_LABELS[about]}]`, note].filter(Boolean).join(" ")
  const sb = getLeadsClient()
  const now = new Date()

  // Double-submit guard: the same form from the same phone in the last 10
  // minutes is one lead, not two alerts.
  const { data: dup } = await sb
    .from("leads")
    .select("id")
    .eq("caller_phone", phone)
    .eq("lead_type", "form")
    .eq("message", message)
    .gte("created_at", new Date(now.getTime() - 10 * 60 * 1000).toISOString())
    .limit(1)
  if (dup?.length) return NextResponse.json({ ok: true, leadId: dup[0].id, duplicate: true })

  // A returning contact keeps the card's lifecycle status (the form joins
  // their existing card — cards group by phone); a new one starts at New.
  const { data: prior } = await sb
    .from("leads")
    .select("status")
    .eq("caller_phone", phone)
    .not("twilio_number", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
  const status = (prior?.[0]?.status as string | undefined) || "new"
  const returning = !!prior?.length

  // twilio_number = the Website line: the form is an INBOUND event (the card
  // showed it as "YOU" while it was null), and the card's Call button and
  // texts resolve to the line the lead knows.
  const { data: inserted, error: insErr } = await sb
    .from("leads")
    .insert({
      source: "Website",
      source_type: "website",
      lead_type: "form",
      twilio_number: WEBSITE_NUMBER,
      caller_phone: phone,
      name: fullName,
      email,
      property_address: address,
      message,
      status,
      sms_consent: smsConsent,
      website_ladder: isSeller ? "calling" : null,
    })
    .select(FORM_ROW_COLUMNS)
    .single()
  if (insErr || !inserted) {
    console.error("[website-form] insert failed:", insErr?.message)
    return NextResponse.json({ error: insErr?.message || "insert failed" }, { status: 500 })
  }
  const form = inserted as unknown as FormRow
  waitUntil(afterIntake({ form, fullName, email, address, about, note, smsConsent, phone, isSeller, returning, now }))
  return NextResponse.json({ ok: true, leadId: form.id })
}

interface IntakeArgs {
  form: FormRow; fullName: string; email: string | null; address: string | null; about: string; note: string
  smsConsent: boolean; phone: string; isSeller: boolean; returning: boolean; now: Date
}

// Anything unexpected after the row is saved must still reach Ryan.
async function afterIntake(a: IntakeArgs): Promise<void> {
  try {
    await runIntake(a)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[website-form] intake follow-up threw:", msg)
    const ok = await pingTelegram(`🌐 <b>New website lead</b> — ${esc(a.fullName)} · ${a.phone}\n⚠️ The rest of the intake failed (${esc(msg)}) — call them and check the card.`, a.phone)
    if (!ok) {
      await sendTwilioSms({ to: FORWARD_TO, preferredFrom: WEBSITE_NUMBER, body: `WEBSITE LEAD (alert failed): ${a.fullName} ${a.phone}` }).catch(() => {})
    }
  }
}

async function runIntake(a: IntakeArgs): Promise<void> {
  const { form, fullName, email, address, about, note, smsConsent, phone, isSeller, returning, now } = a
  const sb = getLeadsClient()

  // Vendor pitch (lib/vendorPitch, 2026-11-06): a first-time sender selling
  // LRG Homes a service gets nothing — no text, email or call reminders — and
  // Ryan one quiet line. Someone already on the list is never screened.
  if (!returning) {
    const pitch = await screenVendorPitch({ channel: "form", message: note, name: fullName, topic: ABOUT_LABELS[about] })
    if (pitch) {
      const { error } = await sb.from("leads").update({ ...vendorPitchColumns(pitch), website_ladder: null }).eq("id", form.id)
      if (error) console.error("[website-form] vendor-pitch close failed:", error.message)
      await sendTelegramAlert(
        vendorPitchAlert({ where: "website form", who: `${esc(fullName)} · ${phone}`, pitch, message: note, esc }) +
          (error ? `\n⚠️ Couldn't close the card (${esc(error.message)}) — it may show in Leads.` : "")
      )
      return
    }
  }

  // Mailed-record match — same matcher as callers (address → mailing
  // address → surname). Never blocks the alert.
  let mailLine = "📬 Not on a mailing list"
  try {
    const m = await autoLinkMailRecord(sb, form.id)
    const { data: linked } = await sb.from("leads").select("mail_record_id, mail_match_candidates").eq("id", form.id).maybeSingle()
    const recordId = (linked?.mail_record_id as string | null) ?? m?.record?.id ?? null
    if (recordId) {
      const { data: rec } = await sb.from("mail_records").select("owner_name, campaign_id").eq("id", recordId).maybeSingle()
      // Count this lead under the mailer in Campaign Performance (A/B child
      // by the record's piece) — the alert names the same campaign.
      const credited = await creditWebsiteFormToMailCampaign(sb, form, recordId)
      let campaignName = ""
      const nameId = credited ?? (rec?.campaign_id as string | undefined)
      if (nameId) {
        const { data: c } = await sb.from("campaigns").select("name").eq("id", nameId).maybeSingle()
        campaignName = (c?.name as string | undefined) || ""
      }
      const owner = (rec?.owner_name as string | undefined) || ""
      const surname = fullName.split(/\s+/).pop()?.toUpperCase() || ""
      const ownerMatches = !owner || (surname.length >= 2 && owner.toUpperCase().includes(surname))
      mailLine = `📬 Mailed${campaignName ? `: ${esc(campaignName)}` : ""}${owner ? ` · owner ${esc(owner)}` : ""}` +
        (ownerMatches ? "" : `\n⚠️ The owner on title isn't ${esc(fullName)} — ask how they're connected to the property.`)
    } else if (Array.isArray(linked?.mail_match_candidates) && linked.mail_match_candidates.length) {
      mailLine = `📬 ${linked.mail_match_candidates.length} possible mailing-list matches — pick one on the card`
    }
  } catch (e) {
    console.error("[website-form] mail match failed:", e instanceof Error ? e.message : String(e))
    mailLine = "📬 Mailing-list check failed — link it on the card"
  }

  const inHours = isBusinessHours(now)

  let textLine = smsConsent ? "" : "🚫 No text consent — call only"
  if (isSeller && smsConsent) {
    const out = await sendAutoText(sb, { phone, body: firstText({ name: fullName, address, inHours }), source: "Website" })
    textLine = out.ok
      ? `💬 Texted: "${inHours ? "I'll call you in the next few minutes" : "I'll call you first thing tomorrow morning"}"`
      : `⚠️ First text failed — ${esc(out.error || "unknown")}`
  }

  let emailLine = ""
  if (email) {
    const m = confirmationEmail({ name: fullName, address, inHours, isSeller })
    const out = await sendAutoEmail(sb, { to: email, phone, name: fullName, address, subject: m.subject, body: m.body, source: "Website" })
    emailLine = out.ok ? "✉️ Confirmation email sent" : `⚠️ Confirmation email failed — ${esc(out.error || "unknown")}`
  }

  if (isSeller) {
    try {
      await syncLadder(sb, form, now)
    } catch (e) {
      console.error("[website-form] ladder sync failed:", e instanceof Error ? e.message : String(e))
    }
  }

  const header = `🌐 <b>New website lead</b> — ${esc(ABOUT_LABELS[about])}${returning ? " (already on your list)" : ""}`
  const lines = [
    header,
    `${esc(fullName)} · ${phone}`,
    address ? `📍 ${esc(address)}` : null,
    email ? `✉️ ${esc(email)}` : null,
    note ? `💬 "${esc(note)}"` : null,
    "",
    mailLine,
    textLine || null,
    emailLine || null,
    isSeller
      ? inHours
        ? `📞 <b>${ladderReason(1)}</b> — call now`
        : "🌙 After hours — they were told you'll call first thing tomorrow. I'll remind you at 8am."
      : null,
  ].filter((l): l is string => l !== null)
  const alerted = await pingTelegram(lines.join("\n"), phone)

  // Telegram is the alert. If it fails, a text to Ryan's cell is the only
  // other channel that reaches him — never the office line (which drops it).
  if (!alerted) {
    try {
      await sendTwilioSms({
        to: FORWARD_TO,
        preferredFrom: WEBSITE_NUMBER,
        body: `WEBSITE LEAD (Telegram alert failed): ${fullName} ${phone}${address ? ` · ${address}` : ""}${note ? ` · "${note.slice(0, 160)}"` : ""}`,
      })
    } catch (e) {
      console.error("[website-form] fallback SMS failed:", e instanceof Error ? e.message : String(e))
    }
  }
  if (isSeller && inHours && alerted) {
    const { error } = await sb.from("leads").update({ ladder_pings: { "1": now.toISOString() } }).eq("id", form.id)
    if (error) console.error("[website-form] ladder_pings write failed:", error.message)
  }

}
