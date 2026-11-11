/* eslint-disable */
/**
 * The judge (Ryan 2026-11-06) — one verdict per person about what happens
 * next, decided from the WHOLE thread after it quiets down.
 *
 * Why: every event used to run its own analyzer and write its own
 * recommended_followup_date on its own row (voicemail → "+6 months", Jackie
 * hang-up → "today", owed rule → "tomorrow", Send → "+ nurture" …) and the
 * worklist showed whichever date was earliest. Bill said "call me in
 * January" on a real call and still landed in today's pile; Rita said "not
 * interested", Ryan closed politely, and the close knocked her off autopilot.
 *
 * Rules, top wins (Ryan 2026-11-06):
 *   1. stop / remove me                         → DNC
 *   2. sold / wrong person / not a seller       → dead
 *   3. an appointment got set                   → that date
 *   4. Ryan promised to send / do something     → Ryan, today
 *   5. the newest REAL conversation's instruction ("call me in January")
 *      beats everything before it; later hang-ups / voicemails / Jackie
 *      logs don't move it
 *   6. Ryan asked them something, no answer yet → wait 3 days, then re-judge
 *   7. they want a number / a call / an answer  → Ryan, today
 *   8. not interested, politely closed          → quiet a year, on autopilot
 *   9. no real conversation EVER               → call again next day, then
 *      day 3, 7, 14 after each attempt, then autopilot
 *  10. nothing new                              → leave the last verdict alone
 *
 * Above all of them (2026-11-09, lib/deals.ts): a signed contract. Under
 * contract → no chasing, no drips, no autopilot; one date, the close-by day.
 * If they reach out, the model still reads it, and "they want something
 * from Ryan" / "Ryan owes them" still come to Ryan today. Closed → nothing.
 *
 * The judge is the only thing meant to own the date / reason / autopilot
 * state. The old per-event writers still run but get overruled 20 minutes
 * later; they come out once this has proven itself.
 *
 *   node scripts/judge.js                         # sweep: judge whoever is due (writes when JUDGE_LIVE=true)
 *   node scripts/judge.js --preview [--days 30]   # before/after for everyone with activity, no writes
 *   node scripts/judge.js --phone +1408… [--apply]  # one person; --apply writes regardless of JUDGE_LIVE
 *
 * Also (2026-11-10): the judge hears a different number to reach them at
 * ("this is my daughter's office, my cell is…") and saves it as the card's
 * best number — lead_best_numbers, lib/leadPhones.ts. The Call button and
 * texts go there from then on. Only a clean 10-digit number is saved; a
 * garbled one is flagged for Ryan to check the recording. A number Ryan
 * typed in himself is never overwritten.
 *
 * State: lead_verdicts (supabase/migrations/2026-11-06_lead_verdicts.sql).
 * Schedule: infrastructure/launchd/com.lrghomes.judge.plist (every 15 min).
 */

"use strict"

const DAY = 86400000
const SETTLE_MS = 20 * 60000          // let transcription / Ryan's reply land before judging
const WAIT_ON_THEM_DAYS = 3
const QUIET_DAYS = 365
const CHASE_LADDER_DAYS = [1, 3, 7, 14] // after attempt 1, 2, 3, 4 — then autopilot
const LOOKBACK_DAYS = 3                 // sweep: who had activity recently
const MODEL = "claude-sonnet-5"
const APPLE_EPOCH_OFFSET_MS = 978307200000
const STATES = ["dnc", "dead", "under_contract", "closed", "appointment", "ryan_owes", "call_on", "waiting_on_them", "ryan_today", "quiet_until", "chase", "none"]

// ─── dates (Pacific days, like lib/pacificDate) ─────────────────────────────

function pacificDay(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d).map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}`
}
function dayPlus(day, n) {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
function fmtDay(day) {
  if (!day) return "—"
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
}
function pacificStamp(iso) {
  return new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
}

// ─── the thread ─────────────────────────────────────────────────────────────

const ROW_COLS = "id, created_at, lead_type, twilio_number, message, ai_summary, ai_notes, notes, status, is_dnc, is_junk, is_bad_number, name, property_address, source, recommended_followup_date, followup_reason, drip_campaign_type, drip_touch_number, last_drip_sent_at, autopilot_since, autopilot_hold_until, autopilot_done_at, appointment_at, pending_at, deal_closed_at, deal_details, jackie_call, call_duration_sec, email"

async function loadRows(sb, phone) {
  const { data, error } = await sb.from("leads").select(ROW_COLS).eq("caller_phone", phone).order("created_at", { ascending: true }).limit(500)
  if (error) throw new Error(`rows: ${error.message}`)
  return data || []
}

function isInbound(r) { return !!r.twilio_number && !String(r.lead_type || "").startsWith("drip_") }
function isRyanOut(r) { return !r.twilio_number && !String(r.lead_type || "").startsWith("drip_") }

// Ryan's own voicemail greeting captured on his outbound call rows — the
// transcript is the other person's greeting, not a conversation.
function looksLikeGreeting(text) {
  return /forwarded to voicemail|not available|record your message|at the tone|leave a message|can't take your call|is not available/i.test(String(text || "").slice(0, 300))
}

function labelFor(r) {
  const t = String(r.lead_type || "")
  if (t.startsWith("drip_")) return /\[autopilot #/.test(r.notes || "") ? "Auto check-in text from Ryan's system" : "Automated follow-up text from Ryan's system"
  if (isRyanOut(r)) {
    if (t === "call") return looksLikeGreeting(r.message) ? "Ryan called — reached their voicemail" : "Ryan called (transcript)"
    if (t === "sms" || t === "imessage") return "Ryan texted"
    if (t === "email") return "Ryan emailed"
    return `Ryan (${t})`
  }
  if (t === "voicemail") return r.jackie_call ? "They called; Jackie (AI receptionist) answered" : "They left a voicemail"
  if (t === "call") return r.jackie_call ? "They called; Jackie (AI receptionist) answered" : "They called (transcript)"
  if (t === "sms" || t === "imessage" || t === "imessage_inbound") return "They texted"
  if (t === "email" || t === "email_inbound") return "They emailed"
  return `They (${t})`
}

function renderRow(r) {
  const body = String(r.message || "").trim()
  const summary = String(r.ai_summary || r.ai_notes || "").trim()
  // Long call: keep the opening and the END — the end is where "call me in
  // January" / "I'll text you" live.
  let content = body.length > 6000 ? body.slice(0, 2500) + "\n  …[middle cut]…\n  " + body.slice(-3500) : body
  if (!content) content = summary ? `(no transcript; summary: ${summary.slice(0, 500)})` : "(nothing captured)"
  else if (summary && body.length > 600) content += `\n  summary: ${summary.slice(0, 400)}`
  const dur = r.call_duration_sec ? ` · ${Math.round(r.call_duration_sec)}s` : ""
  return `[${pacificStamp(r.created_at)}] ${labelFor(r)}${dur}\n  ${content.replace(/\n/g, "\n  ")}`
}

async function fetchPersonalTexts(phone, sinceIso) {
  const base = process.env.SIDECAR_URL || "http://localhost:5799"
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 8000)
    const res = await fetch(`${base}/sync-imessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone }), signal: ctl.signal })
    clearTimeout(t)
    if (!res.ok) return []
    const data = await res.json()
    const since = new Date(sinceIso).getTime() - APPLE_EPOCH_OFFSET_MS
    return (Array.isArray(data.messages) ? data.messages : [])
      .filter((m) => Number(m.timestamp) > since && (m.text || "").trim())
      .map((m) => ({
        created_at: new Date(Number(m.timestamp) + APPLE_EPOCH_OFFSET_MS).toISOString(),
        line: `[${pacificStamp(new Date(Number(m.timestamp) + APPLE_EPOCH_OFFSET_MS).toISOString())}] ${m.is_from_me ? "Ryan texted from his personal phone" : "They texted Ryan's personal phone"}\n  ${String(m.text).trim().slice(0, 1500)}`,
      }))
  } catch { return [] }
}

function buildThread(rows, personal) {
  const items = rows.map((r) => ({ created_at: r.created_at, line: renderRow(r) })).concat(personal)
  items.sort((a, b) => a.created_at.localeCompare(b.created_at))
  // Keep the newest 40 events; the old ones only matter as "there was history".
  const dropped = Math.max(0, items.length - 40)
  const kept = items.slice(dropped)
  return (dropped ? `(${dropped} older events omitted)\n\n` : "") + kept.map((i) => i.line).join("\n\n")
}

// ─── facts the code decides (no model needed) ───────────────────────────────

function facts(rows) {
  const newest = rows[rows.length - 1]
  const named = [...rows].reverse().find((r) => r.name) || {}
  const addr = [...rows].reverse().find((r) => r.property_address) || {}
  const appt = rows.map((r) => r.appointment_at).filter(Boolean).sort().pop()
  const autopilotRow = rows.find((r) => r.drip_campaign_type === "autopilot")
  const lastInbound = [...rows].reverse().find((r) => isInbound(r))
  const lastInboundIdx = lastInbound ? rows.indexOf(lastInbound) : -1
  // One callback often lands as two rows a minute apart (the call + its
  // voicemail transcript) — anything within 30 minutes is one try.
  const attemptsSince = rows.slice(lastInboundIdx + 1)
    // Imports / enrolments write empty outbound rows — not attempts.
    .filter((r) => isRyanOut(r) && /^(call|sms|imessage|email)$/.test(r.lead_type || "") && String(r.message || "").trim())
    .filter((r, i, arr) => i === 0 || new Date(r.created_at).getTime() - new Date(arr[i - 1].created_at).getTime() > 30 * 60000)
  const lastRyanOut = [...rows].reverse().find((r) => isRyanOut(r))
  const pendingRow = rows.find((r) => r.pending_at)
  const closedRow = rows.find((r) => r.deal_closed_at)
  const deal = (rows.find((r) => r.deal_details) || {}).deal_details || null
  // Something from them after the contract was signed — the only thing that
  // brings an under-contract seller back to Ryan's list before closing day.
  const signedAt = deal && deal.signed_at ? deal.signed_at : pendingRow ? pendingRow.pending_at : null
  const inboundSinceContract = !!signedAt && rows.some((r) => isInbound(r) && r.created_at > signedAt)
  const dated = rows.filter((r) => r.recommended_followup_date).sort((a, b) => a.recommended_followup_date.localeCompare(b.recommended_followup_date))[0]
  return {
    newest, name: named.name || null, address: addr.property_address || null,
    appointment: appt && new Date(appt).getTime() > Date.now() - DAY ? appt : null,
    autopilotRow, attempts: attemptsSince, lastRyanOut, lastInbound,
    isDnc: rows.some((r) => r.is_dnc), isJunk: rows.some((r) => r.is_junk),
    isDead: rows.length > 0 && rows.every((r) => String(r.status || "").toLowerCase() === "dead"),
    underContract: !!pendingRow && !closedRow, closedAt: closedRow ? closedRow.deal_closed_at : null,
    deal, signedAt, inboundSinceContract,
    before: dated ? { date: dated.recommended_followup_date, reason: dated.followup_reason } : null,
  }
}

// ─── the model ──────────────────────────────────────────────────────────────

function systemPrompt(today) {
  return `You are the judge for Ryan LaRocca's seller leads. Ryan runs LRG Homes, a cash home buyer in the San Jose / Bay Area. He mails owners, they call or text, he talks to them. You read ONE person's whole thread and decide what should happen next. You decide once, for the whole thread — not per message.

Pick exactly one state. Highest rule that fits wins:

1. "dnc" — they asked to be removed, to stop contact, or were hostile about being contacted.
2. "dead" — they sold it, don't own it, wrong number / wrong person, or it isn't a seller at all (a vendor or agent pitching Ryan).
3. "appointment" — a specific meeting, walkthrough or visit was agreed. date = that day.
4. "ryan_owes" — in the newest real conversation Ryan promised to send or do something specific (a number / an offer, a text with his info, a document, a call back "later today") and there's no sign he did it yet. Ryan's turn, now.
5. "call_on" — in the newest REAL conversation, they or Ryan set a time to reconnect ("call me in January", "after the holidays", "end of March", "give me a couple of weeks"). date = that day (a month alone → the 15th; "after X" → about a week after X; "a couple of weeks" → 14 days). This stands even if later there were hang-ups, voicemails, Jackie logs or auto-texts — those don't move it. If a real conversation happened and nothing was promised or scheduled, this is still the state: pick a sensible date from what was said (a week for an open thread; "nothing moves for two months" → two months).
6. "waiting_on_them" — the last substantive message is a QUESTION FROM RYAN they have not answered yet (e.g. they texted "No", Ryan asked "not the owner anymore, or not for sale?").
7. "ryan_today" — their newest message asks Ryan for something (a number / an offer, a call, an answer) or they clearly want to talk now.
8. "quiet_until" — they said not interested / not selling / not now, with no date, without asking to be removed. Ryan may have closed politely ("no problem, you have my number") and they may have acknowledged (👍, "thanks") — that is still quiet_until.
9. "chase" — NO real conversation has EVER happened in this thread: only Ryan's calls that hit voicemail, their hang-ups or empty voicemails, Jackie answering, auto-texts with no reply, phone tag. Ryan is still trying to reach them for the first time. If they ever actually talked, this is never the answer.
10. "none" — nothing in the thread calls for a change from the standing verdict. Only valid when a standing verdict is given; with none, pick the state that fits.

A REAL conversation means Ryan and the person actually exchanged words: a live call where both talk (not Ryan reaching a voicemail greeting, not a hang-up with Jackie), or the person replied to Ryan by text with substance.

Today is ${today}. If a standing verdict or a date Ryan set by hand is given and nothing from THEM is newer than it, answer "none".

Separately from the state: does Ryan OWE them something from the newest real conversation — anything he said he'd send or do ("I'll shoot you a text", "I'll send you my info", "let me get you a number", "I'll call you back this afternoon") with no later message from Ryan showing he did it? Look at how the conversation ENDED; a promise at the end of a call counts even if a longer timeline was discussed earlier. If so, put it in "owed" in a few words, written TO Ryan ("text her your name and number…"); otherwise null.

Also separately: did THEY give a different phone number to reach them at than the one they are calling / texting from ("this is my daughter's office, my cell is…", "call me back at…", "my real number is…")? Only a number that is theirs to be reached at — never Ryan's or LRG Homes' numbers, never a number Jackie or Ryan read out, never the number they are already calling from, never somebody else's number they merely mention. If they gave more than one, the newest. Put its 10 digits in "callback_number" only if all ten digits are clear in the transcript; if they gave one but the digits are incomplete or unclear, leave "callback_number" null and set "callback_unclear" true. "callback_note" = a few words on whose number it is and where it came from ("her own cell — the number she called from is her daughter's office"). Nothing given → null, false, null.

Respond with ONLY JSON:
{"state": "<one of the states>", "date": "YYYY-MM-DD" or null, "owed": "<what Ryan promised, e.g. text her his name/number with Vine Street on it for her attorney>" or null, "reason": "<one plain sentence for Ryan's screen, under 140 characters, naming the fact — e.g. Bill said call in January ahead of his end-of-March sale>", "connected": true|false, "callback_number": "<10 digits>" or null, "callback_unclear": true|false, "callback_note": "<a few words>" or null}`
}

// "(408) 555-0142" / "4085550142" / "1-408-555-0142" → +14085550142; anything
// that isn't a real 10-digit US number → null (a misheard digit must not
// become the number the Call button rings).
function cleanCallback(raw) {
  let d = String(raw || "").replace(/\D/g, "")
  if (d.length === 11 && d[0] === "1") d = d.slice(1)
  if (d.length !== 10 || /^[01]/.test(d) || /^...[01]/.test(d)) return null
  return `+1${d}`
}
function prettyPhone(e164) {
  const d = String(e164 || "").replace(/\D/g, "").slice(-10)
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(e164 || "")
}

async function askModel(anthropic, ctx) {
  const user = [
    `Person: ${ctx.name || "(no name)"}${ctx.address ? ` · ${ctx.address}` : ""}${ctx.source ? ` · source: ${ctx.source}` : ""}${ctx.phone ? ` · calling / texting from ${ctx.phone}` : ""}`,
    ctx.standing ? `Standing verdict (${ctx.standing.source === "ryan" ? "set by Ryan by hand" : "the judge"}, ${pacificStamp(ctx.standing.judged_at)}): ${ctx.standing.state}${ctx.standing.due_date ? ` on ${ctx.standing.due_date}` : ""} — ${ctx.standing.reason || ""}` : "Standing verdict: none",
    ctx.hint ? `Note: ${ctx.hint}` : null,
    "",
    "THREAD (oldest first):",
    ctx.thread,
  ].filter((x) => x !== null).join("\n")
  let lastErr = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4000, // the model thinks first; the JSON itself is ~100 tokens
      // Same all day and sent ~8 times a run, so cached (reads bill at 10%).
      system: [{ type: "text", text: systemPrompt(ctx.today), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    })
    const out = (res.content || []).map((b) => b.text || "").join("")
    try {
      const json = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1))
      if (!STATES.includes(json.state)) throw new Error(`bad state ${json.state}`)
      return { state: json.state, date: /^\d{4}-\d{2}-\d{2}$/.test(json.date || "") ? json.date : null, owed: typeof json.owed === "string" && json.owed.trim() ? json.owed.trim().slice(0, 120) : null, reason: String(json.reason || "").slice(0, 160), connected: !!json.connected, callback: cleanCallback(json.callback_number), callbackUnclear: json.callback_unclear === true, callbackNote: typeof json.callback_note === "string" && json.callback_note.trim() ? json.callback_note.trim().slice(0, 200) : null, usage: res.usage }
    } catch (e) {
      lastErr = new Error(`${e.message} — stop=${res.stop_reason} blocks=${(res.content || []).map((b) => b.type).join(",") || "none"} said: ${out.slice(0, 200).replace(/\s+/g, " ")}`)
    }
  }
  throw lastErr
}

// ─── the verdict (state → one date + what to write) ────────────────────────

function money(n) { return `$${Number(n).toLocaleString("en-US")}` }

/** "Under contract at $900,000 (signed Nov 7, 2026) — closes by Nov 17, 2026 — …" (same line as lib/deals). */
function underContractReason(f) {
  const d = f.deal || {}
  const signed = f.signedAt ? fmtDay(pacificDay(new Date(f.signedAt))) : null
  const parts = [`Under contract${d.price ? ` at ${money(d.price)}` : ""}${signed ? ` (signed ${signed})` : ""}`]
  if (d.close_by) parts.push(`closes by ${fmtDay(d.close_by)} — tap Closed once it records`)
  return parts.join(" — ")
}

function decide(llm, f, today) {
  let state = llm.state
  let date = null
  let reason = llm.reason
  if (f.closedAt && !f.isDnc) {
    return { state: "closed", date: null, reason: `Closed ${fmtDay(pacificDay(new Date(f.closedAt)))}.`, enrolAutopilot: false }
  }
  if (f.underContract && !f.isDnc) {
    // They asked for something / Ryan owes them → Ryan's turn today, with the
    // deal in the line. Anything else → wait for the close-by day.
    if (llm.owed) {
      const owed = llm.owed.replace(/\bRyan's\b/g, "your").replace(/\bRyan\b/g, "you").replace(/\bhis\b/g, "your").replace(/\bhim\b/g, "you")
      return { state: "ryan_owes", date: today, reason: `You owe them: ${owed} (under contract)`.slice(0, 200), enrolAutopilot: false }
    }
    if (llm.state === "ryan_today") return { state: "ryan_today", date: today, reason: `${llm.reason} (under contract)`.slice(0, 200), enrolAutopilot: false }
    const closeBy = f.deal && f.deal.close_by ? f.deal.close_by : null
    return { state: "under_contract", date: closeBy ? (closeBy < today ? today : closeBy) : null, reason: underContractReason(f).slice(0, 200), enrolAutopilot: false }
  }
  if (f.isDnc) { state = "dnc"; reason = reason || "On the do-not-contact list." }
  else if (f.appointment) {
    state = "appointment"
    date = pacificDay(new Date(f.appointment))
    // appointment_at's clock time isn't reliable; the model's line carries the time.
    reason = `Appointment ${fmtDay(date)}${llm.reason ? ` — ${llm.reason}` : ""}`
  }
  else if (llm.owed && !["dead", "none"].includes(state)) {
    // Something Ryan promised comes before any timeline they discussed.
    state = "ryan_owes"
    // The card talks to Ryan — "text her your number", not "his".
    const owed = llm.owed.replace(/\bRyan's\b/g, "your").replace(/\bRyan\b/g, "you").replace(/\bhis\b/g, "your").replace(/\bhim\b/g, "you")
    reason = `You owe them: ${owed}${llm.state === "call_on" && llm.date ? ` — then ${fmtDay(llm.date)}` : ""}`
  }

  // A meeting that was set for a day already gone isn't a plan — it's history.
  if (state === "appointment" && !date && !(llm.date && llm.date >= today)) state = "chase"

  switch (state) {
    case "appointment":
      if (!date) date = llm.date
      break
    case "call_on":
      date = llm.date && llm.date > today ? llm.date : today
      break
    case "ryan_today":
    case "ryan_owes":
      date = today
      break
    case "waiting_on_them": {
      const asked = f.lastRyanOut ? pacificDay(new Date(f.lastRyanOut.created_at)) : today
      date = dayPlus(asked, WAIT_ON_THEM_DAYS)
      if (date <= today) date = today
      break
    }
    case "quiet_until": {
      const said = f.lastInbound ? pacificDay(new Date(f.lastInbound.created_at)) : today
      date = dayPlus(said, QUIET_DAYS)
      break
    }
    case "chase": {
      const n = f.attempts.length
      const last = n ? pacificDay(new Date(f.attempts[n - 1].created_at)) : null
      // Nothing from either side in over two weeks: the chase went cold.
      const lastTouch = [last, f.lastInbound ? pacificDay(new Date(f.lastInbound.created_at)) : null].filter(Boolean).sort().pop() || today
      const stale = dayPlus(lastTouch, CHASE_LADDER_DAYS[CHASE_LADDER_DAYS.length - 1]) < today
      if (n === 0 && !stale) { date = today; reason = reason || "They reached out and you haven't called back yet." }
      else if (n > CHASE_LADDER_DAYS.length || stale) {
        // Ladder exhausted, or the chase went cold weeks ago — autopilot's job now.
        date = null
        reason = n
          ? `${n} tr${n === 1 ? "y" : "ies"} with no real conversation${stale ? `, nothing since ${fmtDay(lastTouch)}` : ""} — parked on autopilot.`
          : `Never a real conversation; nothing from either side since ${fmtDay(lastTouch)} — parked on autopilot.`
      } else {
        date = dayPlus(last, CHASE_LADDER_DAYS[n - 1])
        if (date < today) date = today
        reason = `${reason} (try ${n + 1}: ${CHASE_LADDER_DAYS[n - 1]} day${CHASE_LADDER_DAYS[n - 1] > 1 ? "s" : ""} after the last one)`
      }
      break
    }
    default:
      date = null
  }
  return { state, date, reason: reason.slice(0, 200), enrolAutopilot: state === "chase" && date === null }
}

// ─── writes ─────────────────────────────────────────────────────────────────

async function apply(sb, phone, rows, f, v, deps) {
  const ids = rows.map((r) => r.id)
  const now = new Date().toISOString()
  const upd = async (patch, filterIds = ids) => {
    const { error } = await sb.from("leads").update(patch).in("id", filterIds)
    if (error) throw new Error(`write: ${error.message}`)
  }
  const label = `${f.name || phone}${f.address ? ` (${f.address})` : ""}`

  if (v.state === "none") return
  if (v.state === "dnc") {
    if (!f.isDnc) {
      await upd({ is_dnc: true, status: "dead", recommended_followup_date: null, followup_reason: null, drip_campaign_type: null })
      await deps.telegram(`Judge: ${label} asked to be left alone — marked DNC. Check the do-not-contact list has their address.\n${v.reason}`)
    }
    return
  }
  if (v.state === "dead") {
    await upd({ status: "dead", status_set_by: "auto", status_set_at: now, recommended_followup_date: null, followup_reason: null, drip_campaign_type: null })
    await deps.telegram(`Judge: ${label} — marked dead.\n${v.reason}`)
    return
  }

  // Everyone else: one date on the newest row, none anywhere else.
  await upd({ recommended_followup_date: null, followup_reason: null })

  if (v.state === "under_contract" || v.state === "closed") {
    // Nobody texts a seller who signed: every drip / autopilot stamp off.
    if (rows.some((r) => r.drip_campaign_type)) await upd({ drip_campaign_type: null }, rows.filter((r) => r.drip_campaign_type).map((r) => r.id))
    await sb.from("drip_queue").update({ status: "skipped", error: "under_contract" }).in("lead_id", ids).in("status", ["pending", "approved"])
    if (v.date) await upd({ recommended_followup_date: v.date, followup_reason: v.reason, followup_generated_at: now }, [f.newest.id])
    return
  }
  const host = f.autopilotRow || [...rows].reverse().find((r) => r.name && r.property_address) || [...rows].reverse().find((r) => r.property_address) || f.newest

  if (v.state === "quiet_until" || v.enrolAutopilot) {
    // On autopilot, holding. The text counter = how many autopilot texts
    // they've actually received (a polite close may have un-stamped them).
    const hold = v.state === "quiet_until" ? `${v.date}T20:00:00Z` : null
    const sent = rows.filter((r) => /\[autopilot #\d/.test(r.notes || "")).length
    const lastSent = [...rows].reverse().find((r) => /\[autopilot #\d/.test(r.notes || ""))
    await upd({ drip_campaign_type: null }, ids.filter((id) => id !== host.id))
    await sb.from("drip_queue").update({ status: "skipped", error: "judge_ruled" }).in("lead_id", ids).in("status", ["pending", "approved"])
    await upd({
      drip_campaign_type: "autopilot",
      drip_touch_number: Math.max(sent, f.autopilotRow ? (host.drip_touch_number ?? 0) : 0),
      last_drip_sent_at: lastSent ? lastSent.created_at : now,
      autopilot_since: now,
      autopilot_hold_until: hold,
      autopilot_done_at: null,
      name: host.name || f.name, property_address: host.property_address || f.address,
      followup_reason: v.reason, followup_generated_at: now,
    }, [host.id])
    return
  }

  if (v.state === "waiting_on_them" && f.autopilotRow) {
    // Stay on autopilot but don't text them while Ryan's question is open.
    await upd({ autopilot_since: now, autopilot_hold_until: `${v.date}T20:00:00Z` }, [f.autopilotRow.id])
    await upd({ recommended_followup_date: v.date, followup_reason: v.reason, followup_generated_at: now }, [f.newest.id])
    return
  }

  // appointment / call_on / ryan_today / waiting_on_them / chase (ladder): Ryan's now.
  if (f.autopilotRow) await upd({ drip_campaign_type: null }, [f.autopilotRow.id])
  // A real conversation ended the chase — no automated drip texts on top of
  // "call them in January" or "send them a number". The chase ladder keeps
  // its drips (they're part of trying to reach the person).
  if (v.state !== "chase" && v.state !== "waiting_on_them") {
    const stamped = rows.filter((r) => r.drip_campaign_type && r.drip_campaign_type !== "autopilot").map((r) => r.id)
    if (stamped.length) {
      await upd({ drip_campaign_type: null }, stamped)
      await sb.from("drip_queue").update({ status: "skipped", error: "judge_ruled" }).in("lead_id", ids).in("status", ["pending", "approved"])
    }
  }
  await upd({ recommended_followup_date: v.date, followup_reason: v.reason, followup_generated_at: now }, [f.newest.id])
}

async function saveVerdict(sb, phone, rows, v, llm) {
  const { error } = await sb.from("lead_verdicts").upsert({
    phone, state: v.state, due_date: v.date, reason: v.reason,
    through_at: rows[rows.length - 1].created_at, judged_at: new Date().toISOString(),
    source: "judge", model: MODEL, raw: llm ? { state: llm.state, date: llm.date, reason: llm.reason, connected: llm.connected, callback: llm.callback || null, callback_unclear: !!llm.callbackUnclear, usage: llm.usage } : null,
  })
  if (error) throw new Error(`verdict: ${error.message}`)
}

// A number they asked to be reached at → the card's best number
// (lead_best_numbers, lib/leadPhones.ts). Returns what happened, for the log.
async function saveCallback(sb, phone, rows, f, llm, deps) {
  if (!llm || (!llm.callback && !llm.callbackUnclear)) return null
  const label = `${f.name || phone}${f.address ? ` (${f.address})` : ""}`
  const { data: standing } = await sb.from("lead_best_numbers").select("best_phone, source").eq("person_phone", phone).maybeSingle()
  if (!llm.callback) {
    // Heard one, couldn't make out the digits: don't touch the button.
    if (!standing) await deps.telegram(`Judge: ${label} gave a different number to reach them at, but I couldn't make out all the digits — check the recording and add it on their card.${llm.callbackNote ? `\n${llm.callbackNote}` : ""}`)
    return "unclear"
  }
  // Our own lines (the ones on the thread) and the number already on the card are not news.
  const ours = new Set(rows.map((r) => String(r.twilio_number || "").replace(/\D/g, "").slice(-10)).filter((d) => d.length === 10))
  if (llm.callback === phone || ours.has(llm.callback.slice(-10))) return null
  if (standing && (standing.source === "ryan" || standing.best_phone === llm.callback)) return null
  const { data: taken } = await sb.from("lead_best_numbers").select("person_phone").eq("best_phone", llm.callback).neq("person_phone", phone).maybeSingle()
  if (taken) return null
  const { error } = await sb.from("lead_best_numbers").upsert({ person_phone: phone, best_phone: llm.callback, source: "judge", heard: llm.callbackNote, created_at: new Date().toISOString() })
  if (error) throw new Error(`best number: ${error.message}`)
  await deps.telegram(`Judge: ${label} gave a different number to reach them at: ${prettyPhone(llm.callback)}. The Call button and texts on their card now go there (they called from ${prettyPhone(phone)}).${llm.callbackNote ? `\n${llm.callbackNote}` : ""}`)
  return llm.callback
}

// ─── one person ─────────────────────────────────────────────────────────────

async function judgePhone(sb, deps, phone, opts = {}) {
  const rows = await loadRows(sb, phone)
  if (!rows.length) return { phone, skipped: "no rows" }
  const f = facts(rows)
  f.source = [...rows].reverse().find((r) => r.source)?.source || null
  if (f.isJunk) return { phone, skipped: "junk" }
  if (f.isDead && !opts.force) return { phone, skipped: "dead" }
  const today = pacificDay()
  const { data: standingRow } = await sb.from("lead_verdicts").select("*").eq("phone", phone).maybeSingle()
  const standing = opts.fresh ? null : standingRow // --fresh: rule again from scratch

  let llm = null
  if (f.isDnc) llm = { state: "dnc", date: null, reason: "On the do-not-contact list.", connected: false }
  else if (f.closedAt || (f.underContract && !f.inboundSinceContract)) {
    // Signed (or closed) and nothing from them since: the deal is the plan.
    llm = { state: "none", date: null, reason: "", connected: true, usage: null }
  }
  else if (f.autopilotRow && !rows.some((r) => isInbound(r) && r.created_at > (f.autopilotRow.autopilot_since || f.autopilotRow.created_at)) && !opts.fresh) {
    // On autopilot and they haven't replied: autopilot owns them. Nothing to rule on.
    llm = { state: "none", date: null, reason: "On autopilot, no reply yet.", connected: false, usage: null }
  } else {
    let personal = await fetchPersonalTexts(phone, rows[0].created_at)
    // Texts with their best number (lib/leadPhones) are the same conversation.
    const { data: bestRow } = await sb.from("lead_best_numbers").select("best_phone").eq("person_phone", phone).maybeSingle()
    if (bestRow && bestRow.best_phone) personal = personal.concat(await fetchPersonalTexts(bestRow.best_phone, rows[0].created_at))
    const dealHint = f.underContract ? `They are UNDER CONTRACT with Ryan — ${underContractReason(f)}. Only decide whether their newest message asks Ryan for something (ryan_today) or he owes them something (owed); don't chase a decision they already made.` : null
    const ctx = { name: f.name, address: f.address, source: f.source, phone, standing, hint: [opts.hint, dealHint].filter(Boolean).join(" ") || null, today, thread: buildThread(rows, personal) }
    llm = await askModel(deps.anthropic, ctx)
  }
  const v = decide(llm, f, today)
  const result = { phone, name: f.name, address: f.address, before: f.before, autopilotBefore: !!f.autopilotRow, llm, verdict: v, attempts: f.attempts.length }

  if (opts.write) {
    await apply(sb, phone, rows, f, v, deps)
    await saveVerdict(sb, phone, rows, v, llm)
    // After the verdict, and never able to undo it: a best-number hiccup is an alert, not a failed ruling.
    if (v.state !== "dnc" && v.state !== "dead") {
      try { result.bestNumber = await saveCallback(sb, phone, rows, f, llm, deps) }
      catch (e) { await deps.telegram(`Judge: couldn't save the number ${f.name || phone} asked to be reached at — ${e.message}`).catch(() => {}) }
    }
  }
  return result
}

// ─── the sweep: who is due ──────────────────────────────────────────────────

async function dueNow(sb) {
  const since = new Date(Date.now() - LOOKBACK_DAYS * DAY).toISOString()
  const { data: recent, error } = await sb.from("leads").select("caller_phone, created_at, lead_type").gte("created_at", since).not("caller_phone", "is", null).order("created_at", { ascending: false }).limit(1000)
  if (error) throw new Error(`recent: ${error.message}`)
  const latest = new Map()
  for (const r of recent || []) {
    if (!r.caller_phone || /anonymous/i.test(r.caller_phone) || !/^\+\d{8,}$/.test(r.caller_phone)) continue
    if (String(r.lead_type || "").startsWith("drip_")) continue // an auto-text going out is not news about the person
    if (!latest.has(r.caller_phone)) latest.set(r.caller_phone, r.created_at)
  }
  const phones = [...latest.keys()]
  const verdicts = new Map()
  for (let i = 0; i < phones.length; i += 200) {
    const { data } = await sb.from("lead_verdicts").select("phone, state, due_date, through_at, source").in("phone", phones.slice(i, i + 200))
    for (const vr of data || []) verdicts.set(vr.phone, vr)
  }
  const cutoff = Date.now() - SETTLE_MS
  const due = []
  for (const [phone, newest] of latest) {
    const vr = verdicts.get(phone)
    if (new Date(newest).getTime() > cutoff) continue              // still settling
    if (vr && newest <= vr.through_at) continue                    // nothing new since the last ruling
    due.push({ phone })
  }
  // Open questions that ran out the clock: re-judge with the fact that they never answered.
  const today = pacificDay()
  const { data: waiting } = await sb.from("lead_verdicts").select("phone, through_at").eq("state", "waiting_on_them").lte("due_date", today)
  for (const w of waiting || []) {
    const newest = latest.get(w.phone)
    if (newest && newest > w.through_at) continue // already queued above
    due.push({ phone: w.phone, hint: "Ryan's question went unanswered for 3 days — treat it as no answer." })
  }
  return due
}

async function runJudge(sb, deps, { live }) {
  const due = await dueNow(sb)
  console.log(`[judge] ${due.length} due (${live ? "LIVE" : "preview — JUDGE_LIVE is off"})`)
  const stats = {}
  for (const d of due) {
    try {
      const r = await judgePhone(sb, deps, d.phone, { write: live, hint: d.hint })
      const key = r.skipped ? `skipped_${r.skipped}` : r.verdict.state
      stats[key] = (stats[key] || 0) + 1
      if (!r.skipped) console.log(`[judge] ${r.name || r.phone}: ${r.verdict.state}${r.verdict.date ? ` ${r.verdict.date}` : ""} — ${r.verdict.reason}`)
    } catch (e) {
      stats.error = (stats.error || 0) + 1
      console.error(`[judge] ${d.phone} failed: ${e.message}`)
      await deps.telegram(`Judge couldn't rule on ${d.phone}: ${e.message}`).catch(() => {})
    }
  }
  console.log(`[judge] done ${JSON.stringify(stats)}`)
  return stats
}

module.exports = { runJudge, judgePhone, dueNow, decide, facts }

// ─── CLI ────────────────────────────────────────────────────────────────────

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
  // Background-lane key + one llm_usage row per verdict (scripts/llm-usage.cjs).
  const anthropic = require("./llm-usage.cjs").anthropicClient({ tag: "[judge]" })
  const args = process.argv.slice(2)
  const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null }
  const live = (process.env.JUDGE_LIVE || "").trim().toLowerCase() === "true"
  const telegram = async (text) => {
    const token = process.env.CAMPAIGN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN
    const chat = process.env.TELEGRAM_CHAT_ID
    if (!token || !chat) return
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat, text }) }).catch(() => {})
  }
  const deps = { anthropic, telegram }

  const show = (r) => {
    if (r.skipped) { console.log(`\n## ${r.phone} — skipped (${r.skipped})`); return }
    console.log(`\n## ${r.name || "(no name)"} ${r.phone}${r.address ? ` · ${r.address}` : ""}`)
    console.log(`  before: ${r.before ? `${fmtDay(r.before.date)} — ${r.before.reason || ""}` : "no date"}${r.autopilotBefore ? " · on autopilot" : ""}`)
    console.log(`  after:  ${r.verdict.state}${r.verdict.date ? ` ${fmtDay(r.verdict.date)}` : ""} — ${r.verdict.reason}${r.verdict.enrolAutopilot ? " · → autopilot" : ""}`)
    if (r.llm && (r.llm.callback || r.llm.callbackUnclear)) console.log(`  number: ${r.llm.callback ? prettyPhone(r.llm.callback) : "gave one, digits unclear"}${r.llm.callbackNote ? ` — ${r.llm.callbackNote}` : ""}`)
  }

  ;(async () => {
    const phoneList = args.flatMap((a, i) => (a === "--phone" ? [args[i + 1]] : []))
    if (phoneList.length) {
      const write = args.includes("--apply")
      for (const p of phoneList) show(await judgePhone(sb, deps, p, { write, force: true, fresh: args.includes("--fresh") }))
      if (write) console.log("\n(applied)")
    } else if (args.includes("--preview")) {
      const days = Number(flag("--days") || 30)
      const since = new Date(Date.now() - days * DAY).toISOString()
      const { data } = await sb.from("leads").select("caller_phone").gte("created_at", since).not("caller_phone", "is", null).order("created_at", { ascending: false }).limit(1000)
      const seen = new Set()
      for (const r of data || []) if (/^\+\d{8,}$/.test(r.caller_phone || "")) seen.add(r.caller_phone)
      console.log(`${seen.size} people with activity in the last ${days} days`)
      const tally = {}
      const write = args.includes("--apply") // one-time catch-up: rule on everyone and write it
      for (const p of seen) {
        try { const r = await judgePhone(sb, deps, p, { write }); show(r); tally[r.skipped ? `skipped_${r.skipped}` : r.verdict.state] = (tally[r.skipped ? `skipped_${r.skipped}` : r.verdict.state] || 0) + 1 }
        catch (e) { console.log(`\n## ${p} — error: ${e.message}`) }
      }
      console.log("\n", JSON.stringify(tally))
    } else {
      await runJudge(sb, deps, { live })
    }
  })().catch((e) => { console.error(e); process.exit(1) })
}
