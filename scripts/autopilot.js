/* eslint-disable */
/**
 * Autopilot (Ryan 2026-11-05) — fixed-text check-ins for low-priority sellers
 * that send on their own and stay OFF the Follow Ups worklist until the person
 * replies. Pilot cohort: the historic sellers + four thin mailer callers.
 *
 * Rules Ryan agreed in chat:
 *   - 8 texts over ~19 months: #1 now, #2 +30 days, #3–#8 every 90 days.
 *     Then stop and tag (autopilot_done_at) — never thrown away.
 *   - Wording: fixed texts (renderTouch). Changed 2026-11-13 (was "fixed
 *     wording only, no AI writing the texts"): on the day a text is due, Opus
 *     reads the person's card and edits that slot's fixed text as little as
 *     possible so it fits them — or holds it (sends nothing). Guardrails are
 *     enforced in code (scripts/autopilot-writer.js); a text that breaks one
 *     twice is blocked and Ryan gets a Telegram. Two holds in a row stop
 *     autopilot for that person. AUTOPILOT_WRITER=fixed goes back to the
 *     fixed texts exactly.
 *   - #2–#7 swap to a seasonal version inside a holiday window (Thanksgiving
 *     week, Dec 15–31, early January, early July) — never "happy holidays" in
 *     March. #1 (the ownership question), the price #4 and #8 never swap.
 *   - People who gave a number get it quoted twice: in #1 and as #4.
 *   - Names that aren't real first names get no name; no address → "your
 *     property".
 *   - Weekday afternoons (12–5 PM Pacific), a few per hourly pass, spaced out.
 *   - Any reply stops the sequence:
 *       sold / wrong person      → dead, Telegram FYI
 *       not interested           → quiet for a year, then the check-ins resume
 *       stop / take me off       → handled by the DNC path (cluster goes dead)
 *       anything else            → off autopilot, onto Follow Ups (due today)
 *     A text from Ryan's own phone to them (chat.db) also takes them off
 *     autopilot — he's working them himself.
 *
 * State: drip_campaign_type='autopilot' on one row per person, plus
 * drip_touch_number (last text sent or held, 0 = none yet), last_drip_sent_at
 * (clock), autopilot_since / autopilot_hold_until / autopilot_done_at
 * (supabase/migrations/2026-11-05_autopilot.sql), autopilot_next_at (exact
 * due time when someone is put back on) / autopilot_holds (writer holds in a
 * row) (supabase/migrations/2026-11-13_autopilot_writer.sql).
 *
 * AUTOPILOT_LIVE=true in .env.local turns sending on. Anything else = the pass
 * only logs what it would send.
 *
 *   node scripts/autopilot.js --preview          # every enrolled person's next text
 *   node scripts/autopilot.js --preview --write [--until YYYY-MM-DD]
 *                                                # what Opus would send to everyone due
 *                                                # by then (real model calls; writes nothing)
 *   node scripts/autopilot.js --sequence <phone> # all 8 texts for one person
 * ENV_FILE=/path/.env.local overrides where the CLI reads its env.
 */

"use strict"

const { writeTouch, WRITER_MODEL } = require("./autopilot-writer.js")

const DAY = 86400000
// Touch → days after the previous text (touch 1 = on enrolment).
const SCHEDULE_DAYS = { 1: 0, 2: 30, 3: 90, 4: 90, 5: 90, 6: 90, 7: 90, 8: 90 }
const LAST_TOUCH = 8
const QUIET_AFTER_NO_DAYS = 365
const MAX_SENDS_PER_PASS = 6
// Opus calls per pass. Holds and blocks don't count as sends, so without this
// a pass with many people due could run dozens of slow model calls.
const MAX_WRITES_PER_PASS = 12
const SEND_GAP_MS = [25000, 45000]

// Per-person facts that can't be derived cleanly from the row (a name that
// isn't a name, an intersection for an address, the price they quoted). They
// identify real sellers, so they live outside the repo — in the local-only
// projects folder — keyed by caller_phone:
//   { "+1…": { "name": null | "First", "street": "…", "price": "$3M" } }
// Missing file = no overrides (names/streets derived from the row).
const OVERRIDES_PATH = process.env.AUTOPILOT_OVERRIDES
  || require("node:path").join(require("node:os").homedir(), "Projects/PROJECTS/lead-pipeline/autopilot-overrides.json")
let overridesCache = null
function overrides() {
  if (overridesCache) return overridesCache
  try { overridesCache = JSON.parse(require("node:fs").readFileSync(OVERRIDES_PATH, "utf8")) }
  catch (e) { console.warn(`[autopilot] no overrides at ${OVERRIDES_PATH} (${e.code || e.message})`); overridesCache = {} }
  return overridesCache
}

const NOT_A_NAME = /'s\b|mother|father|unknown|lady|^\(|\d|\[|llc|trust|inc\b/i

function firstName(raw) {
  const s = String(raw || "").replace(/\s+/g, " ").trim()
  if (!s || NOT_A_NAME.test(s)) return null
  const nick = s.match(/\(([A-Za-z]+)\)/)
  if (nick) return nick[1]
  if (s.includes("/")) return s.split(" ")[0].split("/").filter(Boolean).join(" and ")
  const first = s.split(" ")[0]
  return /^[A-Za-z][A-Za-z'-]+$/.test(first) ? first : null
}

function streetPhrase(addr) {
  const s = String(addr || "").replace(/\([^)]*\)/g, "").split(",")[0].replace(/\s+/g, " ").trim()
  return s || null
}

function personFacts(lead) {
  const o = overrides()[lead.caller_phone] || {}
  const name = "name" in o ? o.name : firstName(lead.name)
  const street = o.street || streetPhrase(lead.property_address)
  return {
    name,
    street: street || "your property",
    hasAddress: !!street,
    price: o.price || null,
    historic: lead.source === "Historic Sellers",
  }
}

// ─── Pacific calendar helpers ───────────────────────────────────────────────

function pacificParts(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", hour12: false, weekday: "short",
  }).formatToParts(d).map((x) => [x.type, x.value]))
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, wd: p.weekday }
}

// YYYY-MM-DD, Pacific — the format recommended_followup_date holds.
function pacificDay(d = new Date()) {
  const { y, m, d: day } = pacificParts(d)
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}
function dayPlus(day, n) {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function thanksgivingDay(year) {
  // 4th Thursday of November.
  const first = new Date(Date.UTC(year, 10, 1)).getUTCDay() // 0=Sun
  const firstThu = 1 + ((4 - first + 7) % 7)
  return firstThu + 21
}

function season(d) {
  const { y, m, d: day } = pacificParts(d)
  if (m === 11) {
    const t = thanksgivingDay(y)
    if (day >= t - 3 && day <= t + 3) return "thanksgiving"
  }
  if (m === 12 && day >= 15) return "holidays"
  if (m === 1 && day <= 12) return "newyear"
  if ((m === 6 && day >= 28) || (m === 7 && day <= 10)) return "summer"
  return null
}

// No texts on the holiday itself, on weekends, or outside 12–5 PM Pacific.
function inSendWindow(d) {
  const { y, m, d: day, h, wd } = pacificParts(d)
  if (wd === "Sat" || wd === "Sun") return false
  if (h < 12 || h >= 17) return false
  if (m === 11 && day === thanksgivingDay(y)) return false
  if (m === 12 && (day === 24 || day === 25 || day === 31)) return false
  if ((m === 1 && day === 1) || (m === 7 && day === 4)) return false
  return true
}

// ─── the texts ──────────────────────────────────────────────────────────────

const SIGN = "– Ryan LaRocca"
const OPT = "If you've sold or have no interest in selling, just let me know."

function seasonalText(kind, f) {
  const n = f.name
  switch (kind) {
    case "thanksgiving":
      return `Happy Thanksgiving${n ? `, ${n}` : ""}. Hope you have a good one. If ${f.street} is ever on the table, I'm still buying. ${SIGN}`
    case "holidays":
      return `Happy holidays${n ? `, ${n}` : ""}! If selling ${f.street} is anywhere on the list for next year, I'd love to make you an offer. ${SIGN}`
    case "newyear":
      return `Happy New Year${n ? `, ${n}` : ""}. Starting the year buying again. Still holding ${f.street}? ${SIGN}`
    case "summer":
      return `Hope your summer's going well${n ? `, ${n}` : ""}. Still open to a cash offer on ${f.street} whenever the timing's right. ${SIGN}`
  }
  return null
}

function renderTouch(lead, touch, when = new Date()) {
  const f = personFacts(lead)
  const n = f.name
  const s = f.street
  const usePrice = !!f.price
  if (touch >= 2 && touch <= 7 && !(touch === 4 && usePrice)) {
    const kind = season(when)
    if (kind) return { text: seasonalText(kind, f), seasonal: kind }
  }
  let text
  switch (touch) {
    case 1: {
      const hi = n ? `Hi ${n}, this is Ryan LaRocca.` : "Hi, this is Ryan LaRocca."
      if (f.historic || f.hasAddress) {
        const intro = `You reached out to me a while back about ${s}${usePrice ? ` and mentioned ${f.price}` : ""}.`
        const ask = usePrice ? "Do you still own it, and is that still your number?" : "Do you still own it, and are you open to selling?"
        text = `${hi} ${intro} ${ask} ${OPT}`
      } else {
        // "in the spring" only when that's true — first contact Mar–Jun and
        // under 9 months ago; otherwise "a while back".
        const first = new Date(lead.created_at)
        const m = pacificParts(first).m
        const spring = m >= 3 && m <= 6 && when.getTime() - first.getTime() < 270 * DAY
        text = `${hi} You called me ${spring ? "back in the spring" : "a while back"} after one of my letters. Do you still own the property, and are you open to selling? ${OPT}`
      }
      break
    }
    case 2:
      text = `${n ? `${n}, checking` : "Checking"} back on ${s}. Still yours? If you ever want a cash number, just reply here. ${SIGN}`
      break
    case 3:
      text = `Still buying in your area and thought of ${s}. If it's ever on the table, I'd make you a cash offer, as-is, on your timeline. ${SIGN}`
      break
    case 4:
      text = usePrice
        ? `Quick one: last time we talked you mentioned ${f.price} for ${s}. Is that still about where you're at? ${SIGN}`
        : `Quick one: any chance you'd sell ${s} in the next year or so? A yes, no, or maybe is fine. – Ryan`
      break
    case 5:
      text = `Ever wonder what ${s} would get as-is? Happy to give you a number, no pressure either way. ${SIGN}`
      break
    case 6:
      text = `It's been a bit${n ? `, ${n}` : ""}. Still holding ${s}? If anything's changed on your end, I'm still buying. ${SIGN}`
      break
    case 7:
      text = `No repairs, no cleanout, no showings. If that ever makes selling ${s} easier, I'm a text away. ${SIGN}`
      break
    case 8:
      text = `${n ? `Hi ${n}, Ryan` : "Hi, Ryan"} LaRocca here. Do you still own ${s}? If you've sold or have no interest in selling, just let me know and I'll update my notes.`
      break
    default:
      return null
  }
  return { text, seasonal: null }
}

// When the person's next text is due (Date), or null when the sequence is over.
// autopilot_next_at (set when someone is put back on autopilot) is the exact
// due time and overrides the schedule; a sent or held text clears it.
function nextDue(lead) {
  const sent = lead.drip_touch_number ?? 0
  const next = sent + 1
  if (next > LAST_TOUCH) return null
  const anchor = new Date(lead.last_drip_sent_at || lead.autopilot_since || lead.created_at).getTime()
  let due = lead.autopilot_next_at ? new Date(lead.autopilot_next_at).getTime() : anchor + SCHEDULE_DAYS[next] * DAY
  if (lead.autopilot_hold_until) due = Math.max(due, new Date(lead.autopilot_hold_until).getTime())
  return { touch: next, due: new Date(due) }
}

// ─── reply handling ─────────────────────────────────────────────────────────

const REPLY_PROMPT = `A real-estate investor (Ryan) sent an automated check-in text to a homeowner asking whether they still own their property and are open to selling. Below is what the homeowner sent back (a text, or a voicemail / call summary). Classify it.

- "sold": they no longer own it (sold, transferred, lost it), or it's the wrong person / wrong number.
- "not_interested": they still own it but are not selling / not interested / "no thanks" — WITHOUT asking to be removed.
- "stop": they ask to be removed, to stop texting, or not to be contacted.
- "other": anything else — interest, a question, a price, a callback request, "maybe", unclear, or an empty / missed call.

When unsure, answer "other" (a person reads those). Respond with ONLY JSON: {"kind": "sold" | "not_interested" | "stop" | "other", "reason": "one short sentence"}`

async function classifyReply(anthropic, model, text) {
  const t = String(text || "").trim()
  if (!t) return { kind: "other", reason: "no message" }
  if (/^\s*(stop|unsubscribe|remove me|end|quit|cancel)\s*\.?\s*$/i.test(t)) return { kind: "stop", reason: "stop keyword" }
  try {
    const res = await anthropic.messages.create({
      model,
      max_tokens: 200,
      system: REPLY_PROMPT,
      messages: [{ role: "user", content: t.slice(0, 2000) }],
    })
    const out = (res.content || []).map((b) => b.text || "").join("")
    const json = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1))
    if (["sold", "not_interested", "stop", "other"].includes(json.kind)) return { kind: json.kind, reason: String(json.reason || "") }
  } catch (e) {
    console.warn(`[autopilot] reply classify failed: ${e.message}`)
  }
  return { kind: "other", reason: "classifier unavailable" }
}

function isInbound(row) {
  if (!row.lead_type || String(row.lead_type).startsWith("drip_")) return false
  if (!row.twilio_number) return false // outbound rows carry no line
  return /^(sms|imessage|imessage_inbound|call|voicemail|email|email_inbound)$/.test(row.lead_type)
}

async function clusterRows(sb, lead) {
  const { data, error } = await sb
    .from("leads")
    .select("id, created_at, lead_type, twilio_number, message, ai_summary, ai_notes, notes, status, is_dnc, is_junk, is_bad_number, recommended_followup_date, name, caller_phone, property_address, source, offer_amount, offer_verbalized_at, pending_at, deal_closed_at")
    .eq("caller_phone", lead.caller_phone)
    .order("created_at", { ascending: true })
  if (error) throw new Error(error.message)
  return data || []
}

// ─── the pass ───────────────────────────────────────────────────────────────

async function fetchAutopilotLeads(sb) {
  const { data, error } = await sb
    .from("leads")
    .select("*")
    .eq("drip_campaign_type", "autopilot")
    .is("autopilot_done_at", null)
    .order("last_drip_sent_at", { ascending: true, nullsFirst: true })
    .limit(1000)
  if (error) throw new Error(`autopilot query failed: ${error.message}`)
  return data || []
}

async function stopAutopilot(sb, lead, patch = {}) {
  // A pinned next-text date dies with the enrolment — left behind, it would
  // make the next enrolment's first text due at once.
  const { error } = await sb.from("leads").update({ drip_campaign_type: null, autopilot_next_at: null, ...patch }).eq("id", lead.id)
  if (error) throw new Error(`stop failed for ${lead.id}: ${error.message}`)
}

// "Pat Smith (12 Elm St)" — who an alert is about.
function who(lead) {
  return `${lead.name || lead.caller_phone}${lead.property_address ? ` (${lead.property_address})` : ""}`
}

// Some row already carries a follow-up date of today or later.
function hasFollowupAhead(rows) {
  const today = pacificDay()
  return rows.some((r) => r.recommended_followup_date && r.recommended_followup_date >= today)
}

// Texts with Ryan's own phone (chat.db via the sidecar), converted the way
// scripts/judge.js fetchPersonalTexts does. That sidecar call can hang, so a
// failure or 8 s without an answer is [] — the writer just sees less history.
async function personalTexts(deps, phone, appleEpochMs = deps.appleEpochMs) {
  if (!deps.fetchIMessageHistory || !phone) return []
  let timer
  const timeout = new Promise((ok) => { timer = setTimeout(() => ok([]), 8000) })
  const msgs = await Promise.race([Promise.resolve().then(() => deps.fetchIMessageHistory(phone)).catch(() => []), timeout])
  clearTimeout(timer)
  return (Array.isArray(msgs) ? msgs : [])
    .filter((m) => String(m.text || "").trim())
    .map((m) => ({
      created_at: new Date(Number(m.timestamp) + appleEpochMs).toISOString(),
      inbound: !m.is_from_me,
      text: String(m.text).trim(),
    }))
}

async function loadVerdict(sb, phone) {
  const { data } = await sb.from("lead_verdicts").select("state, reason").eq("phone", phone).maybeSingle()
  return data || null
}

// The writer's note, safe inside the history row's notes (no brackets or "·"
// that the [autopilot #N · … · SMsid] matchers could trip on).
function editedTag(changed) {
  return ` [edited: ${String(changed || "edited").replace(/[\[\]·]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)}]`
}

/**
 * deps: { live, dryRun, sendSms, messageStatus, resolveReplyLine, fetchIMessageHistory,
 *         contactIsDnc, anthropic, model, telegram, appleEpochMs,
 *         writer: "opus" (default — Opus edits the text) | "fixed" (the fixed texts) }
 */
async function runAutopilot(sb, deps) {
  const live = deps.live && !deps.dryRun
  const writer = deps.writer === "fixed" ? "fixed" : "opus"
  const leads = await fetchAutopilotLeads(sb)
  console.log(`[autopilot] ${leads.length} on autopilot (${live ? "LIVE" : "preview only — AUTOPILOT_LIVE is off"}, writer: ${writer})`)
  const now = new Date()
  const sendable = inSendWindow(now)
  let sent = 0
  let writes = 0
  const stats = {}
  const bump = (k) => { stats[k] = (stats[k] || 0) + 1 }

  for (const lead of leads) {
    try {
      const rows = await clusterRows(sb, lead)
      const label = `${lead.name || lead.caller_phone} (${lead.caller_phone})`

      // 1. Killed elsewhere (dead / DNC / junk on any row) → off autopilot.
      if (rows.some((r) => r.is_dnc || r.is_junk || String(r.status || "").toLowerCase() === "dead")) {
        if (live) await stopAutopilot(sb, lead)
        bump("stopped_dead"); continue
      }
      // 1a. Under contract or closed (2026-11-09, lib/deals) → off autopilot.
      if (rows.some((r) => r.pending_at || r.deal_closed_at)) {
        if (live) await stopAutopilot(sb, lead)
        bump("stopped_deal"); continue
      }

      // 1c. Number already known not to take texts (flagged by 1b earlier).
      // The judge can re-park someone on autopilot after that — without this
      // the engine texts the landline again, it bounces, and they loop. Off
      // autopilot, onto Follow Ups to call in 90 days (unless a date is set).
      if (rows.some((r) => r.is_bad_number)) {
        console.log(`[autopilot] ${label}: number flagged as unable to take texts — off autopilot`)
        if (live) {
          await stopAutopilot(sb, lead, hasFollowupAhead(rows) ? {} : {
            recommended_followup_date: dayPlus(pacificDay(), 90),
            followup_reason: "Landline or unreachable number — can't be texted. Call instead.",
            followup_generated_at: new Date().toISOString(),
          })
        }
        bump("bad_number"); continue
      }

      // 1b. Last text didn't land on a phone (landline / unreachable):
      // 30003 unreachable, 30005 unknown number, 30006 landline. Stop and flag
      // the number so nothing keeps texting it, and put them on Follow Ups to
      // call today — otherwise they'd be on no list at all.
      if (deps.messageStatus) {
        const lastSent = [...rows].reverse().find((r) => r.lead_type === "drip_imessage" && /\[autopilot #\d.*· (SM\w+)\]/.test(r.notes || ""))
        const sid = lastSent && (lastSent.notes.match(/· (SM\w+)\]/) || [])[1]
        if (sid && Date.now() - new Date(lastSent.created_at).getTime() < 7 * DAY) {
          const st = await deps.messageStatus(sid)
          if (st && st.status === "undelivered" && [30003, 30005, 30006].includes(Number(st.errorCode))) {
            console.log(`[autopilot] ${label}: text undelivered (${st.errorCode}) — stopping, number flagged`)
            if (live) {
              await stopAutopilot(sb, lead, {
                is_bad_number: true,
                recommended_followup_date: pacificDay(),
                followup_reason: "Text didn't deliver (landline or unreachable number) — call instead.",
                followup_generated_at: new Date().toISOString(),
              })
              await deps.telegram(`Autopilot FYI: ${lead.name || lead.caller_phone}${lead.property_address ? ` (${lead.property_address})` : ""} — the text didn't deliver (${st.errorCode === 30006 ? "landline" : "unreachable number"}). Taken off autopilot and on Follow Ups to call today.`)
            }
            bump("undeliverable"); continue
          }
        }
      }

      // 2. A reply since autopilot_since?
      const since = new Date(lead.autopilot_since || lead.created_at).getTime()
      const replies = rows.filter((r) => isInbound(r) && new Date(r.created_at).getTime() > since)
      if (replies.length) {
        // The judge (scripts/judge.js, 2026-11-06) rules on replies from the
        // whole thread: it either holds them here (quiet / waiting on them,
        // moving autopilot_since past the reply) or takes them off autopilot.
        // Until it has, don't text them and don't second-guess it.
        if ((process.env.JUDGE_LIVE || "").trim().toLowerCase() === "true") { bump("reply_for_judge"); continue }
        const last = replies[replies.length - 1]
        // Let the voicemail / call transcription land before judging it.
        if (Date.now() - new Date(last.created_at).getTime() < 20 * 60000) { bump("reply_settling"); continue }
        const text = replies.map((r) => r.message || r.ai_summary || "").filter(Boolean).join("\n")
        const verdict = await classifyReply(deps.anthropic, deps.model, text)
        console.log(`[autopilot] reply from ${label}: ${verdict.kind} — ${verdict.reason}`)
        if (!live) { bump(`reply_${verdict.kind}`); continue }
        if (verdict.kind === "sold") {
          const ids = rows.map((r) => r.id)
          await sb.from("leads").update({ status: "dead", status_set_by: "auto", status_set_at: new Date().toISOString(), recommended_followup_date: null, followup_reason: null }).in("id", ids)
          await stopAutopilot(sb, lead)
          await deps.telegram(`Autopilot FYI: ${lead.name || lead.caller_phone}${lead.property_address ? ` (${lead.property_address})` : ""} says they no longer own it — marked dead.\n“${String(text).slice(0, 200)}”`)
        } else if (verdict.kind === "not_interested") {
          const hold = new Date(Date.now() + QUIET_AFTER_NO_DAYS * DAY).toISOString()
          await sb.from("leads").update({ autopilot_since: new Date().toISOString(), autopilot_hold_until: hold }).eq("id", lead.id)
          await deps.telegram(`Autopilot FYI: ${lead.name || lead.caller_phone}${lead.property_address ? ` (${lead.property_address})` : ""} isn't interested — quiet for a year, then the check-ins resume.\n“${String(text).slice(0, 200)}”`)
        } else if (verdict.kind === "stop") {
          // The inbound path DNCs explicit opt-outs; this is the backstop.
          await stopAutopilot(sb, lead)
          await deps.telegram(`Autopilot: ${lead.name || lead.caller_phone} asked to stop — autopilot stopped. Check they're on DNC.\n“${String(text).slice(0, 200)}”`)
        } else {
          // Ryan's now. Keep the AI analyzer's date if it already set one.
          const today = new Date().toISOString().slice(0, 10)
          const hasDate = rows.some((r) => r.recommended_followup_date && r.recommended_followup_date >= today)
          await stopAutopilot(sb, lead, hasDate ? {} : {
            recommended_followup_date: today,
            followup_reason: `Replied to your autopilot text: “${String(text).replace(/\s+/g, " ").slice(0, 160)}”`,
            followup_generated_at: new Date().toISOString(),
          })
        }
        bump(`reply_${verdict.kind}`); continue
      }

      // 3. Ryan texting them from his own phone → they're his.
      if (deps.fetchIMessageHistory) {
        const msgs = await deps.fetchIMessageHistory(lead.caller_phone).catch(() => [])
        const sinceApple = since - deps.appleEpochMs
        if ((msgs || []).some((m) => Number(m.timestamp) > sinceApple)) {
          console.log(`[autopilot] ${label}: personal-phone texts since enrolment — handing to Ryan`)
          // A follow-up a week out so they land on a list (unless one's set).
          if (live) await stopAutopilot(sb, lead, hasFollowupAhead(rows) ? {} : {
            recommended_followup_date: dayPlus(pacificDay(), 7),
            followup_reason: "You've been texting them from your own phone — check where it stands.",
            followup_generated_at: new Date().toISOString(),
          })
          bump("personal_phone"); continue
        }
      }

      // 4. Next text.
      const nd = nextDue(lead)
      if (!nd) {
        // All 8 sent. Tag once 30 days pass without a reply.
        const lastAt = new Date(lead.last_drip_sent_at || 0).getTime()
        if (Date.now() - lastAt > 30 * DAY) {
          if (live) await stopAutopilot(sb, lead, { autopilot_done_at: new Date().toISOString() })
          bump("finished")
        } else bump("waiting_after_last")
        continue
      }
      if (nd.due.getTime() > Date.now()) { bump("not_due"); continue }
      if (!sendable) { bump("due_outside_window"); continue }
      if (sent >= MAX_SENDS_PER_PASS) { bump("due_next_pass"); continue }
      if (await deps.contactIsDnc(sb, lead, "sms")) {
        if (live) await stopAutopilot(sb, lead)
        bump("dnc"); continue
      }
      const r = renderTouch(lead, nd.touch, now)
      if (!r || !r.text) { bump("no_text"); continue }
      if (!live) {
        // Preview: no model call on the hourly pass — the fixed text is logged.
        console.log(`[autopilot] would send #${nd.touch}${r.seasonal ? ` (${r.seasonal})` : ""} → ${label}: ${r.text}`)
        bump("would_send"); continue
      }

      // The writer (2026-11-13): Opus edits the fixed text to fit the card,
      // or holds it. Guardrails in scripts/autopilot-writer.js.
      let text = r.text
      let edited = false
      let changed = null
      if (writer === "opus") {
        if (writes >= MAX_WRITES_PER_PASS) { bump("due_next_pass"); continue }
        writes++
        const personal = await personalTexts(deps, lead.caller_phone)
        const verdict = await loadVerdict(sb, lead.caller_phone)
        const w = await writeTouch({ anthropic: deps.anthropic, model: WRITER_MODEL, lead, rows, personal, verdict, touch: nd.touch, base: r.text, today: now })
        if (w.action === "hold") {
          // Nothing goes out; the slot is used up and the clock restarts.
          const holds = (lead.autopilot_holds || 0) + 1
          const at = new Date().toISOString()
          const patch = { drip_touch_number: nd.touch, last_drip_sent_at: at, autopilot_next_at: null, autopilot_holds: holds }
          console.log(`[autopilot] HELD #${nd.touch} → ${label} (${holds} in a row): ${w.reason}`)
          if (holds >= 2) {
            await stopAutopilot(sb, lead, { ...patch, autopilot_done_at: at })
            await deps.telegram(`Autopilot stopped texting ${who(lead)}: ${w.reason}`)
          } else {
            const { error } = await sb.from("leads").update(patch).eq("id", lead.id)
            if (error) throw new Error(`hold update failed: ${error.message}`)
          }
          bump("held"); continue
        }
        if (w.action === "blocked") {
          // Broke a rule twice. Counter untouched; try again tomorrow, not hourly.
          console.log(`[autopilot] BLOCKED #${nd.touch} → ${label}: ${w.problems.join("; ")} — ${w.text}`)
          const { error } = await sb.from("leads").update({ autopilot_hold_until: new Date(Date.now() + DAY).toISOString() }).eq("id", lead.id)
          if (error) throw new Error(`block update failed: ${error.message}`)
          await deps.telegram(`Autopilot didn't send text #${nd.touch} to ${who(lead)} — it broke a rule: ${w.problems.join("; ")}. Trying again tomorrow.\n“${String(w.text || "").slice(0, 400)}”`)
          bump("blocked"); continue
        }
        text = w.text
        edited = w.edited
        changed = w.changed
      }

      const from = await deps.resolveReplyLine(sb, lead.caller_phone).catch(() => null)
      const res = await deps.sendSms(lead.caller_phone, text, from)
      const at = new Date().toISOString()
      await sb.from("leads").update({ drip_touch_number: nd.touch, last_drip_sent_at: at, autopilot_next_at: null, autopilot_holds: 0 }).eq("id", lead.id)
      await sb.from("leads").insert({
        source: lead.source,
        source_type: lead.source_type,
        twilio_number: null,
        caller_phone: lead.caller_phone,
        lead_type: "drip_imessage",
        message: text,
        status: lead.status,
        name: lead.name,
        property_address: lead.property_address,
        // The bracket must stay first and intact — /\[autopilot #\d/ and
        // /\[autopilot #\d.*· (SM\w+)\]/ elsewhere read it.
        notes: `[autopilot #${nd.touch}${r.seasonal ? ` · ${r.seasonal}` : ""}${res.sid ? ` · ${res.sid}` : ""}]${edited ? editedTag(changed) : ""}`,
      })
      console.log(`[autopilot] SENT #${nd.touch}${edited ? ` (edited: ${changed})` : ""} → ${label} from ${res.from}`)
      sent++
      bump("sent")
      if (sent < MAX_SENDS_PER_PASS) {
        const gap = SEND_GAP_MS[0] + Math.random() * (SEND_GAP_MS[1] - SEND_GAP_MS[0])
        await new Promise((ok) => setTimeout(ok, gap))
      }
    } catch (e) {
      console.error(`[autopilot] ${lead.id} failed: ${e.message}`)
      bump("error")
    }
  }
  console.log(`[autopilot] pass done:`, stats)
  return stats
}

module.exports = { runAutopilot, renderTouch, nextDue, personFacts, season, inSendWindow, firstName, streetPhrase, pacificDay, personalTexts, editedTag, LAST_TOUCH, SCHEDULE_DAYS, MAX_WRITES_PER_PASS }

// ─── CLI: preview ───────────────────────────────────────────────────────────

if (require.main === module) {
  const fs = require("node:fs")
  const path = require("node:path")
  const envPath = process.env.ENV_FILE || path.join(__dirname, "..", ".env.local")
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2")
    }
  }
  const { createClient } = require("@supabase/supabase-js")
  const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY)
  const args = process.argv.slice(2)
  const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null }
  const fmt = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" })
  ;(async () => {
    if (args[0] === "--sequence") {
      const { data } = await sb.from("leads").select("*").eq("caller_phone", args[1]).eq("drip_campaign_type", "autopilot").limit(1)
      const lead = data && data[0]
      if (!lead) return console.log("not on autopilot")
      const first = nextDue(lead)
      if (!first) return console.log("sequence finished")
      let at = first.due
      for (let t = first.touch; t <= LAST_TOUCH; t++) {
        if (t > first.touch) at = new Date(at.getTime() + SCHEDULE_DAYS[t] * DAY)
        const r = renderTouch(lead, t, at)
        console.log(`#${t} ~${fmt(at)}${r.seasonal ? ` (${r.seasonal})` : ""}\n  ${r.text}\n`)
      }
      return
    }
    const leads = await fetchAutopilotLeads(sb)
    leads.sort((a, b) => (nextDue(a)?.due ?? 0) - (nextDue(b)?.due ?? 0))

    if (args.includes("--write")) {
      // What Opus would send to everyone due by --until (default today). Real
      // model calls; nothing written to the leads, nothing sent. (The
      // cost-tracked client still logs one llm_usage row per call.)
      const until = flag("--until") || pacificDay()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new Error(`--until wants YYYY-MM-DD, got ${until}`)
      const anthropic = require("./llm-usage.cjs").anthropicClient({ tag: "[autopilot/preview]" })
      const sidecar = process.env.SIDECAR_URL || "http://localhost:5799"
      const deps = {
        appleEpochMs: 978307200000,
        fetchIMessageHistory: async (phone) => {
          const res = await fetch(`${sidecar}/sync-imessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone }), signal: AbortSignal.timeout(8000) })
          if (!res.ok) return []
          const data = await res.json()
          return Array.isArray(data.messages) ? data.messages : []
        },
      }
      const due = leads.map((lead) => ({ lead, nd: nextDue(lead) })).filter((x) => x.nd && pacificDay(x.nd.due) <= until)
      console.log(`${due.length} due by ${until} — writing with ${WRITER_MODEL} (preview: nothing saved, nothing sent)\n`)
      const out = new Array(due.length)
      let next = 0
      const worker = async () => {
        while (next < due.length) {
          const i = next++
          const { lead, nd } = due[i]
          const when = nd.due.getTime() > Date.now() ? nd.due : new Date()
          const base = renderTouch(lead, nd.touch, when).text
          const head = `## ${lead.name || "(no name)"} · ${lead.caller_phone} · #${nd.touch} due ${fmt(nd.due)}\n  BASE:    ${base}`
          try {
            const rows = await clusterRows(sb, lead)
            const skip = rows.some((r) => r.is_dnc || r.is_junk || String(r.status || "").toLowerCase() === "dead") ? "dead / DNC / junk"
              : rows.some((r) => r.pending_at || r.deal_closed_at) ? "under contract or closed"
              : rows.some((r) => r.is_bad_number) ? "number can't take texts" : null
            if (skip) { out[i] = `${head}\n  SKIP:    ${skip} — the hourly pass takes them off autopilot`; continue }
            const personal = await personalTexts(deps, lead.caller_phone)
            const verdict = await loadVerdict(sb, lead.caller_phone)
            const w = await writeTouch({ anthropic, model: WRITER_MODEL, lead, rows, personal, verdict, touch: nd.touch, base, today: when, tag: "[autopilot/preview]" })
            out[i] = w.action === "send" ? `${head}\n  SEND${w.edited ? " (edited)" : " (unchanged)"}: ${w.text}${w.edited ? `\n           ${w.changed}` : ""}`
              : w.action === "hold" ? `${head}\n  HOLD:    ${w.reason}`
              : `${head}\n  BLOCKED: ${w.problems.join("; ")}\n           ${w.text}`
          } catch (e) {
            out[i] = `${head}\n  ERROR:   ${e.message}`
          }
        }
      }
      await Promise.all([worker(), worker(), worker(), worker(), worker()])
      for (const line of out) console.log(`${line}\n`)
      return
    }

    for (const lead of leads) {
      const nd = nextDue(lead)
      if (!nd) { console.log(`${lead.name || lead.caller_phone}: sequence finished`); continue }
      const when = nd.due.getTime() > Date.now() ? nd.due : new Date()
      const r = renderTouch(lead, nd.touch, when)
      console.log(`#${nd.touch} ${nd.due.getTime() > Date.now() ? `due ${fmt(nd.due)}` : "due now"} · ${lead.name || "(no name)"} · ${lead.caller_phone}\n  ${r.text}\n`)
    }
  })().catch((e) => { console.error(e); process.exit(1) })
}
