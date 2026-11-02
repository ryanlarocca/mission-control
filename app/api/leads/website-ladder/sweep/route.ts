import { NextResponse } from "next/server"
import { WEBSITE_NUMBER, getLeadsClient, isOwnedNumber } from "@/lib/leads"
import {
  FORM_ROW_COLUMNS,
  LADDER_ATTEMPTS,
  REMINDER_AFTER_MS,
  esc,
  firstName,
  isBusinessHours,
  pingTelegram,
  sendAutoText,
  syncLadder,
  type FormRow,
} from "@/lib/websiteLead"

// Website call-ladder sweep (lib/websiteLead.ts), every 5 minutes from the
// Mac mini (launchd com.lrghomes.website-ladder → scripts/website-ladder-
// sweep.mjs, cookie login). Auth-gated by middleware. Each pass:
//   1. Resyncs every laddered website lead (Follow Ups reminder for the next
//      attempt; ends the ladder when a call connected / they reached back /
//      3 calls went unanswered → website_followup drip).
//   2. Telegram pings, each once (ladder_pings), business hours only:
//      "1"  attempt 1 due (after-hours leads, at 8am)
//      "1r" attempt 1 still not made 15 min after the alert
//      "2"/"3" the next attempt is due
//   3. Missed callbacks on the Website line: a voicemail-or-missed call Ryan
//      hasn't answered within 15 minutes gets "sorry I missed you, calling
//      right back" + a 📞 ping (once per call row, marked in ladder_pings).
export const dynamic = "force-dynamic"
export const maxDuration = 120

const MISSED_BUFFER_MS = 15 * 60 * 1000
const MISSED_WINDOW_MS = 3 * 60 * 60 * 1000

function fmtTime(d: Date): string {
  return d.toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" })
}

export async function POST() {
  const sb = getLeadsClient()
  const now = new Date()
  const inHours = isBusinessHours(now)
  const summary = { laddered: 0, finished: 0, pings: 0, missedTexts: 0, errors: [] as string[] }

  const { data: rows, error } = await sb
    .from("leads")
    .select(FORM_ROW_COLUMNS)
    .eq("website_ladder", "calling")
    .limit(200)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  for (const form of (rows ?? []) as unknown as FormRow[]) {
    summary.laddered++
    try {
      const r = await syncLadder(sb, form, now)
      if (r.finished) { summary.finished++; continue }
      if (r.state.phase !== "calling" || !inHours) continue
      if (form.is_dnc || form.is_junk || form.status === "dead") continue
      const st = r.state
      if (now.getTime() < st.dueAt.getTime()) continue

      const pings = { ...(form.ladder_pings ?? {}) }
      const who = esc(form.name || form.caller_phone || "Website lead")
      const where = form.property_address ? ` · ${esc(form.property_address)}` : ""
      let key: string | null = null
      let text = ""
      if (st.attempt === 1 && !pings["1"]) {
        key = "1"
        text = `⏰ <b>Call attempt 1 of ${LADDER_ATTEMPTS}</b> — ${who}${where}\nCame in from the website after hours; they were told you'd call this morning.`
      } else if (st.attempt === 1 && !pings["1r"] && now.getTime() - Date.parse(pings["1"]) >= REMINDER_AFTER_MS) {
        key = "1r"
        text = `⏰ ${who} still hasn't been called — the website lead came in ${Math.round((now.getTime() - Date.parse(form.created_at)) / 60000)} min ago${where}.`
      } else if (st.attempt > 1 && !pings[String(st.attempt)]) {
        key = String(st.attempt)
        const last = st.lastCallAt ? ` Last try ${fmtTime(st.lastCallAt)}, no answer.` : ""
        text = `📞 <b>Time for call attempt ${st.attempt} of ${LADDER_ATTEMPTS}</b> — ${who}${where}.${last}`
      }
      if (!key) continue
      const ok = await pingTelegram(text, form.caller_phone)
      if (!ok) { summary.errors.push(`ping ${key} for ${form.id} failed`); continue }
      pings[key] = now.toISOString()
      const { error: pErr } = await sb.from("leads").update({ ladder_pings: pings }).eq("id", form.id)
      if (pErr) summary.errors.push(`ladder_pings ${form.id}: ${pErr.message}`)
      summary.pings++
    } catch (e) {
      summary.errors.push(`${form.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Missed callbacks on the Website line.
  const { data: missed, error: mErr } = await sb
    .from("leads")
    .select("id, created_at, caller_phone, name, ladder_pings, is_dnc, is_junk")
    .eq("twilio_number", WEBSITE_NUMBER)
    .eq("lead_type", "voicemail")
    .gte("created_at", new Date(now.getTime() - MISSED_WINDOW_MS).toISOString())
    .lte("created_at", new Date(now.getTime() - MISSED_BUFFER_MS).toISOString())
    .limit(50)
  if (mErr) summary.errors.push(`missed lookup: ${mErr.message}`)
  for (const row of missed ?? []) {
    const pings = (row.ladder_pings ?? {}) as Record<string, string>
    const phone = row.caller_phone as string | null
    if (pings.missed || !phone || isOwnedNumber(phone) || row.is_dnc || row.is_junk) continue
    try {
      // Ryan already called or texted back since → nothing to do.
      const { data: since } = await sb
        .from("leads")
        .select("id")
        .eq("caller_phone", phone)
        .is("twilio_number", null)
        .gt("created_at", row.created_at as string)
        .limit(1)
      const mark = async () => {
        const { error: e } = await sb.from("leads").update({ ladder_pings: { ...pings, missed: now.toISOString() } }).eq("id", row.id)
        if (e) summary.errors.push(`missed mark ${row.id}: ${e.message}`)
      }
      if (since?.length) { await mark(); continue }
      // No text outside business hours — the voicemail alert already reached
      // Telegram, and a 9pm "calling you right back" would be a broken promise.
      if (!inHours) continue
      const f = firstName(row.name as string | null)
      const out = await sendAutoText(sb, {
        phone,
        body: `${f ? `Hi ${f}, ` : "Hi, "}it's Ryan with LRG Homes. Sorry I missed your call. I'll call you right back.`,
        source: "Website",
      })
      if (!out.ok && out.error !== "DNC") { summary.errors.push(`missed text ${row.id}: ${out.error}`); continue }
      await pingTelegram(`📵 ${esc((row.name as string | null) || phone)} called the Website line and you missed it. They were texted that you'll call right back.`, phone)
      await mark()
      summary.missedTexts++
    } catch (e) {
      summary.errors.push(`missed ${row.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return NextResponse.json(summary, { status: summary.errors.length ? 207 : 200 })
}
