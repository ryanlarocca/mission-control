/* eslint-disable */
/**
 * Autopilot writer (Ryan 2026-11-13). On the day an autopilot text is due,
 * Claude Opus reads the person's whole card and acts as an EDITOR of that
 * slot's fixed text (scripts/autopilot.js renderTouch) — the smallest change
 * that makes it true for this person, or the text exactly as written. The
 * fixed texts assume Ryan never really talked to them ("Do you still own it,
 * and are you open to selling?"), which is wrong for people with history.
 *
 * The model can also decline (hold): they said don't contact me, Ryan passed
 * on the property, no honest text fits. The guardrails the prompt states are
 * enforced again in code (checkText): a text that breaks one gets one retry,
 * then it's blocked and nothing goes out.
 */

"use strict"

const WRITER_MODEL = "claude-opus-5-5"
const MAX_CHARS = 320            // hard stop in code; the prompt asks for < 240, never > 300
const NOTES_CAP = 1800
const HISTORY_EVENTS = 25

// 62 legacy lead rows were bulk-imported in this window (the evening of
// 2026-04-29, Pacific). Their created_at is the import moment, not when the
// contact happened, so the card must not present it as a real date — the
// first dry run told five people "you called me in April".
const IMPORT_WINDOW_START = Date.parse("2026-04-30T03:50:00Z")
const IMPORT_WINDOW_END = Date.parse("2026-04-30T04:30:00Z")

// Phrases that read like a company, not a person. Same list in the prompt and
// in checkText.
const BANNED_PHRASES = ["no pressure", "no rush", "just checking in", "check-in", "touch base", "glad", "reach out", "on your end", "on your side", "hope you're well", "hope you are doing well"]

// ─── the card ───────────────────────────────────────────────────────────────

function stamp(iso) {
  return new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric" })
}

function longDay(d) {
  return new Date(d).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "long", month: "long", day: "numeric", year: "numeric" })
}

function summaryOf(r) {
  return String(r.ai_summary || r.ai_notes || "").trim()
}

function isUndated(r) {
  const t = new Date(r.created_at).getTime()
  if (t >= IMPORT_WINDOW_START && t <= IMPORT_WINDOW_END) return true
  return !String(r.message || "").trim() && /^From your notes/i.test(summaryOf(r))
}

function label(r) {
  const t = String(r.lead_type || "")
  if (t.startsWith("drip_")) return "Automated check-in text sent as Ryan"
  if (!r.twilio_number) {
    // Outbound rows carry no line.
    if (t === "call") return "Ryan called (transcript; \"Lead:\" lines may be their voicemail screener)"
    if (t === "sms" || t === "imessage") return "Ryan texted"
    if (t === "email") return "Ryan emailed"
    return `Ryan (${t})`
  }
  if (t === "voicemail") return "They left a voicemail"
  if (t === "call") return "They called"
  if (/sms|imessage/.test(t)) return "They texted"
  if (/email/.test(t)) return "They emailed"
  return `They (${t})`
}

// Long call: keep the opening and the end (where "call me in January" lives).
function clip(body) {
  return body.length > 1500 ? body.slice(0, 600) + " …[cut]… " + body.slice(-900) : body
}

function cleanNotes(rows) {
  const parts = rows.map((r) => String(r.notes || "")
    .split("[Skip trace")[0]
    .replace(/\[autopilot[^\]]*\]/g, "")
    .replace(/\[edited:[^\]]*\]/g, "")
    .replace(/\[historic-sellers import[^\]]*\]/g, "")
    .replace(/#callblock[^\n]*/g, "")
    .trim())
  return [...new Set(parts.filter(Boolean))].join("\n").slice(0, NOTES_CAP)
}

/**
 * One person's card as the writer sees it. rows = the person's lead rows,
 * personal = texts from Ryan's own phone ({ created_at, inbound, text }),
 * verdict = their lead_verdicts row ({ state, reason }) or null.
 */
function buildCard({ lead, rows, personal, verdict }) {
  rows = rows || []
  const offer = [...rows].reverse().find((r) => r.offer_amount)
  const notes = cleanNotes(rows)

  const events = rows
    .filter((r) => String(r.message || "").trim() || summaryOf(r))
    .map((r) => {
      let body = clip(String(r.message || "").trim())
      if (!body) body = `(summary) ${summaryOf(r).slice(0, 500)}`
      const head = isUndated(r) ? "[date not recorded] Earlier contact" : `[${stamp(r.created_at)}] ${label(r)}`
      return { at: new Date(r.created_at).getTime(), line: `${head}\n  ${body.replace(/\n/g, " ")}` }
    })
    .concat((personal || [])
      .filter((p) => String(p.text || "").trim())
      .map((p) => ({
        at: new Date(p.created_at).getTime(),
        line: `[${stamp(p.created_at)}] ${p.inbound ? "They texted Ryan's personal phone" : "Ryan texted from his personal phone"}\n  ${clip(String(p.text).trim()).replace(/\n/g, " ")}`,
      })))
    .sort((a, b) => a.at - b.at)
    .slice(-HISTORY_EVENTS)

  return [
    `Name on the card: ${lead.name || "(none)"}`,
    `Property: ${lead.property_address || "(unknown)"}`,
    offer ? `Offer Ryan made: $${Number(offer.offer_amount).toLocaleString("en-US")}${offer.offer_verbalized_at ? ` on ${stamp(offer.offer_verbalized_at)}` : ""}` : "Offer Ryan made: none recorded",
    verdict && verdict.state ? `Where it stands (the judge): ${verdict.state}${verdict.reason ? ` — ${verdict.reason}` : ""}` : null,
    notes ? `Ryan's own notes:\n${notes}` : null,
    "",
    "HISTORY (oldest first):",
    ...events.map((e) => e.line),
  ].filter((x) => x !== null).join("\n")
}

// ─── the prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Ryan LaRocca buys houses and small apartment buildings in the Bay Area for cash, as-is. He is the buyer himself — not a real estate agent or broker today (he held a license years ago and now only buys for himself). Owners call or text him after his letters, and he follows up for months or years with a fixed set of check-in texts he wrote and approved himself.

Below you get ONE owner's card and the check-in text that is scheduled for them today. That text was written for someone Ryan has never really talked to. Your job is to be Ryan's editor: make the SMALLEST change that makes the scheduled text true and natural for THIS person. Keep his words, his rhythm and his length wherever you can.

When to leave it alone:
- If they have never replied to Ryan and the card holds nothing specific they said (only a missed call, an empty voicemail, a letter), return the scheduled text EXACTLY as written.
- Change the text only when the card gives you a reason: it asks something they already told Ryan, or it ignores something real between the two of them (a conversation, a number Ryan gave them, a number or a request they gave him). When the scheduled text's short question still fits, keep it.

When you do change it, the text has to do three jobs in plain words:
  (a) They may have forgotten who Ryan is. Anchor it in one concrete thing from THEIR history (the property, what the two of them talked about, the number that was discussed — described, not quoted).
  (b) Say why he's texting.
  (c) Be easy to answer in a word, or to ignore.
Do not add "I'm still buying and still interested" by reflex. Never repeat a sentence from an earlier check-in text on the card.
Add at most one sentence. Aim for under 240 characters; never go over 300.

Hard rules:
- Never ask something the card already answers (still own it? open to selling? what price?).
- If Ryan personally asked them for something and they never answered (details on the house, a time to talk), do NOT ask for it again in any form, and never mention that they didn't answer. A question from an earlier automated check-in text that got no reply is NOT that kind of request.
- Only facts from the card. A detail that comes from a garbled call transcript is not a fact — leave it out.
- About Ryan, say only what this prompt or the card says. Never say he did something (worked up a number, drove by, kept away from a tenant) unless the card shows he did.
- Never promise or hint at a price: don't say his number will match, beat or land near theirs.
- Name Ryan once. If the text ends with his sign-off, don't also open with "it's Ryan LaRocca".
- A contact marked "date not recorded" has no known date. Never give it a month or a year — say "a while back".
- Plans they mentioned more than six months before today (listing in the spring, moving next year) may already have happened. Never write as if they are still ahead.
- Never write a dollar amount, cap rate or percentage unless it appears in the scheduled text — then keep it exactly as it is written there.
- Never write a phone number, a link, an emoji or an exclamation point.
- Write the way a person texts, not the way a company does. Do not use any of these: ${BANNED_PHRASES.map((p) => `"${p}"`).join(", ")}. If the scheduled text has one of them and you change the text, take it out.
- Do not mention a season, a holiday or the new year unless today is within a week of it.
- Return null (send nothing) when they told Ryan not to contact them, when Ryan was the one who passed on the property, or when no honest text makes sense for this person. Sending nothing is a good answer.

Respond with ONLY JSON: {"text": "<the message>" or null, "changed": "<in a few words, what you changed from the scheduled text and why — or 'nothing'>"}`

// ─── the guardrails, in code ────────────────────────────────────────────────

const EMOJI = /\p{Extended_Pictographic}/u
const MONEY = /\$\s*\d[\d,]*(?:\.\d+)?(?:\s*(?:[kKmMbB]\b|million\b|mil\b|thousand\b))?|\b\d[\d,]*(?:\.\d+)?\s*(?:million|mil|thousand)\b/gi
const PERCENT = /\b\d+(?:\.\d+)?\s*(?:%|percent\b|cap\b)/gi
const PHONE_10 = /(?<!\d)(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/
const PHONE_7 = /(?<!\d)\d{3}[\s.-]\d{4}(?!\d)/

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") }

/** Problems with a text the writer produced ([] = fine to send). */
function checkText(text, { base, lead } = {}) {
  const t = String(text || "").replace(/[‘’]/g, "'").trim()
  const b = String(base || "")
  if (!t) return ["empty text"]
  const problems = []
  if (t.length > MAX_CHARS) problems.push(`too long (${t.length} characters, max ${MAX_CHARS})`)
  if (t.includes("!")) problems.push("has an exclamation point")
  if (EMOJI.test(t)) problems.push("has an emoji")
  if (/http|www\.|\.com/i.test(t)) problems.push("has a link")
  // "it's Ryan LaRocca … – Ryan LaRocca". (An owner who is also a Ryan gets one more.)
  const ryans = (t.match(/\bRyan\b/g) || []).length - (/^ryan\b/i.test(String((lead && lead.name) || "").trim()) ? 1 : 0)
  if (ryans > 1) problems.push("names Ryan more than once")
  const banned = BANNED_PHRASES.filter((p) => new RegExp(p === "glad" ? "\\bglad\\b" : escapeRe(p), "i").test(t))
  if (banned.length) problems.push(`uses a banned phrase: ${banned.map((p) => `"${p}"`).join(", ")}`)
  const money = [...(t.match(MONEY) || []), ...(t.match(PERCENT) || [])].filter((m) => !b.includes(m.trim()))
  if (money.length) problems.push(`has a dollar amount or percentage that isn't in the scheduled text: ${money.map((m) => m.trim()).join(", ")}`)
  else if (t.includes("$") && !b.includes("$")) problems.push("has a dollar sign that isn't in the scheduled text")
  // Street numbers ("1402-1404 Elm Dr", "210/212 Oak St") look like
  // phone numbers. Drop every digit run the scheduled text or the address
  // already has before looking for phone shapes.
  const known = new Set(`${b} ${(lead && lead.property_address) || ""}`.match(/\d+/g) || [])
  const digitsLeft = t.replace(/\d+/g, (d) => (known.has(d) ? "" : d))
  if (PHONE_10.test(digitsLeft) || PHONE_7.test(digitsLeft)) problems.push("has a phone number")
  return problems
}

// ─── the call ───────────────────────────────────────────────────────────────

// Same text apart from quote / dash style and spacing — the model returning
// the scheduled text "unchanged" often swaps a curly quote or the en dash.
function sameText(a, b) {
  const norm = (x) => String(x || "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/\s+/g, " ").trim()
  return norm(a) === norm(b)
}

function parseReply(out) {
  const a = out.indexOf("{")
  const b = out.lastIndexOf("}")
  if (a < 0 || b <= a) throw new Error(`writer reply has no JSON: ${out.slice(0, 200)}`)
  const j = JSON.parse(out.slice(a, b + 1))
  if (j.text !== null && typeof j.text !== "string") throw new Error(`writer reply has no text: ${out.slice(0, 200)}`)
  return { text: j.text === null ? null : j.text.trim(), changed: String(j.changed || "").trim() }
}

/**
 * Write one autopilot text. Returns
 *   { action: "send", text, changed, edited }
 *   { action: "hold", reason }              the writer chose to send nothing
 *   { action: "blocked", text, problems }   broke a rule twice — nothing goes out
 * An API or JSON failure throws (the caller counts it as an error, sends nothing).
 * tag = the llm_usage tag ("[autopilot/preview]" from the CLI).
 */
async function writeTouch({ anthropic, model = WRITER_MODEL, lead, rows, personal, verdict, touch, base, today = new Date(), tag = "[autopilot/write]" }) {
  const baseText = String(base || "").trim()
  const card = buildCard({ lead, rows, personal, verdict })
  const messages = [{
    role: "user",
    content: [`Today is ${longDay(today)}.`, "", `SCHEDULED TEXT (Ryan's approved wording):\n${baseText}`, "", "THE CARD:", card].join("\n"),
  }]
  const ask = async () => {
    // No temperature / top_p (the model rejects them). It thinks first, so
    // only the text blocks are the answer.
    const res = await anthropic.messages.create({ model, max_tokens: 6000, system: SYSTEM_PROMPT, messages, __tag: tag })
    const out = (res.content || []).filter((c) => c.type === "text").map((c) => c.text || "").join("")
    return { out, reply: parseReply(out) }
  }
  // null → hold; the scheduled text untouched → send; otherwise the problems.
  const judge = (reply) => {
    if (reply.text === null) return { done: { action: "hold", reason: reply.changed || "the writer chose to send nothing" } }
    if (sameText(reply.text, baseText)) return { done: { action: "send", text: baseText, changed: "nothing", edited: false } }
    const problems = checkText(reply.text, { base: baseText, lead })
    if (!problems.length) return { done: { action: "send", text: reply.text, changed: reply.changed || "edited", edited: true } }
    return { problems }
  }

  const first = await ask()
  const r1 = judge(first.reply)
  if (r1.done) return r1.done
  console.warn(`[autopilot/write] #${touch} ${lead.caller_phone || ""}: retrying — ${r1.problems.join("; ")}`)
  messages.push({ role: "assistant", content: first.out })
  messages.push({ role: "user", content: `That text breaks these rules:\n- ${r1.problems.join("\n- ")}\nFix them and reply with ONLY the corrected JSON, in the same format.` })
  const second = await ask()
  const r2 = judge(second.reply)
  if (r2.done) return r2.done
  return { action: "blocked", text: second.reply.text, problems: r2.problems }
}

module.exports = { buildCard, checkText, writeTouch, SYSTEM_PROMPT, WRITER_MODEL, BANNED_PHRASES, IMPORT_WINDOW_START, IMPORT_WINDOW_END, isUndated }
