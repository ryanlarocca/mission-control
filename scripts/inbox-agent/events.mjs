// Inbox Agent — networking-event watcher, the pure pieces (unit-tested):
// prefilter, organizer family + dedupe, the verdict rules, calendar helpers and
// card/brief text. IO (Gmail, IMAP, Supabase, gog, Telegram) is in events-run.mjs.
// Spec: briefs/BRIEF_EVENT_WATCHER_2026-10-15.md.
//
// Ryan 2026-10-15: "I really like mixers, meetups at bars, nighttime events …
// lunch and learns, tax meetings — these are trash." Rules decide the verdict;
// the model only extracts fields.
import crypto from "node:crypto"
import { ON_MARKET_RE } from "./llm.mjs"

// ------------------------------------------------------------------ stage 0: prefilter (free)
export const EVENT_HINT_RE = /\b(mixers?|happy hour|socials?|soir[ée]e|part(?:y|ies)|networking|meet-?ups?|meet up|rsvp|you'?re invited|invitation|invites? you|join us|save the date|appreciation|celebration|gala|cocktails?|reception|gathering|open bar|holiday party|just scheduled|new event|events?)\b/i
export const EVENT_SENDER_RE = /@(?:[a-z0-9-]+\.)*(meetup\.com|eventbrite\.com|evite\.com|lu\.ma|luma\.com|splashthat\.com|partiful\.com)$/i
export const VIRTUAL_RE = /\b(webinars?|zoom|livestream|live stream|virtual|online event|on-demand|google meet|teams meeting)\b/i
export const VENDOR_DOMAIN_RE = /(^|\.)(cloudflare|zapier|openrouter|resend|twilio|supabase|vercel|github|google|hubspot|notion|slack|stripe|anthropic|openai|amazon|aws|microsoft|linkedin|inspectify|intuit|quickbooks|zillow|redfin|ticketweb|ticketmaster|stubhub|seatgeek|vividseats|axs|gametime|livenation|costco|nextdoor|skool|capitalone|proxyvote)\.(com|io|ai|dev|net|co)$/i
export const MEETUP_DIGEST_RE = /\b(posted in|commented on|replied to|new members?|welcome to|photos? from|how was|rate your|thanks for coming|see you next|is now full|updated the|changed the|cancell?ed|a warm welcome)\b/i
export const LOCAL_RE = /\b(san jose|santa clara|sunnyvale|milpitas|campbell|cupertino|mountain view|los gatos|saratoga|morgan hill|gilroy|palo alto|east palo alto|los altos|menlo park|redwood city|san carlos|belmont|san mateo|foster city|burlingame|millbrae|san bruno|south san francisco|daly city|pacifica|half moon bay|san francisco|sf|santa cruz|capitola|scotts valley|aptos|watsonville|soquel|willow glen|south bay|the peninsula|silicon valley|santa clara county|san mateo county|santa cruz county)\b/i
export const SOCIAL_RE = /\b(mixers?|happy hour|socials?|soir[ée]e|part(?:y|ies)|appreciation|celebration|cocktails?|reception|gathering|meet-?ups?|open bar|bbq|barbecue|holiday|night out|drinks|pickleball|golf|bowling|wine)\b/i
export const DAYTIME_FORMAT_RE = /\b(lunch(?:eon)?|lunch[- ]and[- ]learn|breakfast|brunch|seminar|training|class|workshop|panel|general meeting|board|election|summit|conference|tour|case study|tax)\b/i

export function domainOf(email) {
  return String(email || "").toLowerCase().split("@")[1] || ""
}

/** Cheap first cut on headers + snippet. `{ candidate, skip }` — skip is the hard-rule reason. */
export function prefilter({ from = "", subject = "", snippet = "" }) {
  const email = (/<([^>]+)>/.exec(from) || [, from])[1].trim().toLowerCase()
  const domain = domainOf(email)
  const subj = String(subject || "")
  if (VENDOR_DOMAIN_RE.test(domain)) return { candidate: false, skip: "vendor" }
  if (VIRTUAL_RE.test(subj)) return { candidate: false, skip: "virtual" }
  if (ON_MARKET_RE.test(subj) && !SOCIAL_RE.test(subj)) return { candidate: false, skip: "listing" }
  const platform = EVENT_SENDER_RE.test(email)
  if (platform && /meetup\.com$/.test(domain) && MEETUP_DIGEST_RE.test(subj)) return { candidate: false, skip: "digest" }
  if (platform && /eventbrite\.com$/.test(domain) && /^marketing@|plans\.eventbrite/.test(email)) return { candidate: false, skip: "platform marketing" }
  const text = `${subj}\n${snippet || ""}`
  return { candidate: platform || EVENT_HINT_RE.test(text) }
}

// ------------------------------------------------------------------ organizer family + dedupe
const ALIASES = [
  { re: /conventus|cv ?lending/i, family: "conventus" },
  { re: /sjrenc|san jose real estate networking/i, family: "sjrenc" },
  { re: /areaa/i, family: "areaa" },
]
const STOP = new Set(["the", "a", "an", "and", "of", "for", "at", "in", "on", "with", "team", "marketing", "events", "event", "lending", "group", "inc", "llc", "club", "co", "company", "capital", "realty", "real", "estate", "homes", "network", "networking", "meetup", "via", "from", "noreply", "no-reply", "info", "hello", "news", "newsletter", "community", "announce", "reminder", "order", "campaign", "mail", "email", "updates", "monthly", "october", "november", "december", "january", "september"])
const PLATFORM_DOMAIN_RE = /(eventbrite|evite|lu\.ma|luma|splashthat|partiful|mailchimp|mcsv|constantcontact|hubspot|sendgrid|campaign-?monitor|gmail|yahoo|hotmail|outlook|icloud)\./i

export function tokens(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/).filter((w) => w.length >= 3 && !STOP.has(w))
}
export function slug(s) {
  return tokens(s).join("")
}

/** Stable per-organizer slug so reminders from the lender, its Eventbrite campaign and
 *  its Eventbrite order receipt all land on one row. Venue is deliberately NOT part of it. */
export function organizerFamily({ fromEmail = "", fromName = "", organizer = "" }) {
  const email = String(fromEmail || "").toLowerCase()
  const [local = "", domain = ""] = email.split("@")
  const hay = `${domain} ${local.replace(/[-_.]+/g, " ")} ${fromName} ${organizer}`
  for (const a of ALIASES) if (a.re.test(hay)) return a.family
  if (/meetup\.com$/.test(domain)) {
    // group mail comes from <Group-Name-announce@meetup.com>; "just scheduled" notices from
    // info@email.meetup.com with the group as the display name
    const words = tokens(local.replace(/-announce|-reminder|-mailer/g, " "))
    if (words.length) return words.slice(0, 3).join("")
    const w = tokens(organizer)[0] || tokens(fromName)[0]
    if (w) return w
  }
  if (PLATFORM_DOMAIN_RE.test(domain) || !domain) {
    const w = tokens(organizer)[0] || tokens(fromName)[0]
    if (w) return w
  }
  const bare = domain.replace(/\.(com|org|net|io|co|us|ai|info|biz)(\.[a-z]{2})?$/, "").split(".").pop()
  return bare || tokens(fromName)[0] || "unknown"
}

export function citySlug(city) {
  return slug(city).replace(/ca$/, "")
}

function shareToken(a, b) {
  const A = new Set(tokens(a))
  for (const t of tokens(b)) if (A.has(t)) return true
  return false
}

/** Same date and (same family, or same city with a shared name/venue token). */
export function matchEvent(existing, cand) {
  for (const e of existing || []) {
    if (e.event_date !== cand.event_date) continue
    if (e.organizer_family && e.organizer_family === cand.organizer_family) return e
    const sameCity = citySlug(e.city) && citySlug(e.city) === citySlug(cand.city)
    if (sameCity && (shareToken(`${e.name} ${e.organizer}`, `${cand.name} ${cand.organizer}`) || shareToken(e.venue, cand.venue))) return e
    if (!e.city || !cand.city) if (shareToken(e.name, cand.name) && shareToken(e.venue, cand.venue)) return e
  }
  return null
}

export function detailsHash(ev) {
  return crypto.createHash("sha256").update([ev.name, ev.event_date, ev.start_time, ev.venue, ev.address, ev.cost].map((x) => String(x || "").trim().toLowerCase()).join("|")).digest("hex").slice(0, 16)
}

// ------------------------------------------------------------------ the verdict (rules, not the model)
function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ""))
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** `x` = model extraction; `receivedDate` = YYYY-MM-DD the email arrived. */
export function verdictFor(x, receivedDate) {
  if (!x || x.is_event !== true) return { verdict: "skip", reason: "not an event" }
  const name = String(x.name || "")
  const format = String(x.format || "other")
  if (x.is_virtual === true || format === "virtual" || VIRTUAL_RE.test(name)) return { verdict: "skip", reason: "virtual" }
  if (x.is_listing_or_tour === true || format === "listing_or_tour") return { verdict: "skip", reason: "listing / property tour" }
  // The model called Conventus (a lender) a "vendor event" on three reminders — the flag only
  // counts when the room is not a real-estate crowd; real tech vendors are also caught by domain in prefilter.
  if (x.is_vendor_event === true && x.audience !== "real_estate") return { verdict: "skip", reason: "tech / vendor event" }
  if (!x.date) return { verdict: "skip", reason: "no date" }
  if (receivedDate && x.date < receivedDate) return { verdict: "skip", reason: "already past when the email arrived" }
  if (x.is_spectator_or_consumer === true) return { verdict: "skip", reason: "ticketed game / show / sale, not a networking crowd" }
  const social = x.format === "social" || SOCIAL_RE.test(name)
  const networking = x.has_networking_component === true || format === "talk_plus_networking" || /networking|mixer/i.test(name)
  // Ryan wants rooms with agents, attorneys, lenders, investors — a rec-league happy hour is not that.
  if (x.audience === "general" && !/networking|mixer|business|investor|real estate/i.test(name)) return { verdict: "skip", reason: "general-public social, not a business crowd" }
  const where = [x.city, x.address, x.venue].filter(Boolean).join(" ")
  if (where && !LOCAL_RE.test(where)) return { verdict: "skip", reason: `out of area (${String(x.city || x.venue || "").slice(0, 30)})` }
  const mins = minutesOf(x.start_time)
  if (mins !== null && mins < 17 * 60 && !social) return { verdict: "skip", reason: "daytime luncheon / seminar / meeting" }
  if (!where) return { verdict: "borderline", reason: "location not stated" }
  if (mins === null) return { verdict: "borderline", reason: "no start time listed" }
  if (mins >= 17 * 60) {
    if (!social && !networking && (["seminar_or_class", "meeting", "conference"].includes(format) || DAYTIME_FORMAT_RE.test(name))) return { verdict: "borderline", reason: "evening, but reads as a seminar / meeting" }
    return { verdict: "include", reason: social ? "evening social" : "evening networking" }
  }
  return { verdict: "borderline", reason: "daytime, but a social" }
}

// ------------------------------------------------------------------ model prompt
export function eventSystem(receivedDate) {
  return `You extract in-person event details from an email for Ryan LaRocca, a real-estate investor in San Jose, CA. The email arrived on ${receivedDate}; treat that as TODAY when resolving relative dates ("tomorrow", "this Thursday", "next week"). Never invent a date, time or place the email does not support. Output strict JSON only — no prose, no markdown.`
}
export function eventPrompt({ from, subject, receivedDate, text }) {
  return `FROM: ${from}
SUBJECT: ${subject}
RECEIVED: ${receivedDate}

${String(text || "").slice(0, 9000)}

----
Does this email announce, invite to, or remind about ONE specific gathering of people at a physical place on a specific date? A Meetup "just scheduled" notice counts. A newsletter that merely mentions events counts only if one event has a date and place — pick the one most like an evening networking mixer. Return JSON:
{
 "is_event": boolean,
 "name": string|null,                 // the event's name as the organizer calls it
 "organizer": string|null,            // organisation or host (e.g. "Conventus Lending", "SJRENC / Sid Bobba")
 "date": "YYYY-MM-DD"|null,
 "start_time": "HH:MM"|null,          // 24h local; null if not stated
 "end_time": "HH:MM"|null,
 "venue": string|null,                // place name
 "address": string|null,              // street address if given
 "city": string|null,
 "cost": string|null,                 // "free", "$10", "members free / $40"…
 "rsvp_url": string|null,             // the registration / RSVP / tickets link
 "format": "social"|"talk_plus_networking"|"seminar_or_class"|"meeting"|"conference"|"listing_or_tour"|"virtual"|"other",
 "has_networking_component": boolean, // drinks / mingling / networking time is part of it
 "is_virtual": boolean,               // Zoom, webinar, livestream, online
 "is_listing_or_tour": boolean,       // property marketing, open house, broker tour, showing
 "is_vendor_event": boolean,          // a software / SaaS / tech vendor's conference or launch
 "is_spectator_or_consumer": boolean, // a ticketed game, concert, show, sale, store promotion or similar — people attend, they don't mingle to meet each other
 "audience": "real_estate"|"business"|"general", // who it is for: real-estate people; business / professional / investor crowd; the general public (rec leagues, neighborhood, hobby, dating)
 "who_in_room": string|null,          // one line: who is likely there (agents, attorneys, lenders, investors, contractors…) inferred from the host and audience
 "is_reminder": boolean               // a reminder / re-send rather than the first announcement
}`
}

// ------------------------------------------------------------------ dates + calendar
/** PT offset for a calendar date — "-07:00" in PDT, "-08:00" in PST. */
export function ptOffsetFor(date) {
  const probe = new Date(`${date}T12:00:00Z`)
  const name = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "short" }).formatToParts(probe).find((p) => p.type === "timeZoneName")?.value || "PST"
  return name === "PDT" ? "-07:00" : "-08:00"
}
export function toRfc3339(date, hhmm) {
  const t = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ""))
  if (!date || !t) return null
  return `${date}T${String(t[1]).padStart(2, "0")}:${t[2]}:00${ptOffsetFor(date)}`
}
/** Start/end for the calendar: given end, else start + 2h; no start → 6–8 PM with a note. */
export function calendarWindow(ev) {
  const start = ev.start_time || "18:00"
  let end = ev.end_time
  if (!end) {
    const m = minutesOf(start) + 120
    end = `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`
  }
  return { from: toRfc3339(ev.event_date, start), to: toRfc3339(ev.event_date, end), assumedTime: !ev.start_time }
}
export function calendarSummary(ev) {
  const place = ev.venue || ev.city
  return `${ev.name}${place ? ` - ${place}` : ""}`.slice(0, 120)
}
export function calendarDescription(ev) {
  return [ev.organizer ? `Host: ${ev.organizer}` : null, ev.cost ? `Cost: ${ev.cost}` : null, ev.why ? ev.why : null, ev.rsvp_url ? `RSVP: ${ev.rsvp_url}` : null, ev.source_link ? `Email: ${ev.source_link}` : null, "Added by the inbox agent's event watcher."].filter(Boolean).join("\n")
}

/** gog `calendar events --json` rows → does one of them look like this event? */
export function calendarMatches(ev, calEvents) {
  for (const c of calEvents || []) {
    const start = c?.start?.dateTime || c?.start?.date || ""
    if (!start.startsWith(ev.event_date)) continue
    const hay = `${c.summary || ""} ${c.location || ""} ${c.description || ""}`
    if (shareToken(hay, `${ev.name} ${ev.organizer || ""} ${ev.organizer_family || ""}`) || (ev.venue && shareToken(c.location || c.summary, ev.venue))) return c
  }
  return null
}

// ------------------------------------------------------------------ text
export function fmtDate(date) {
  if (!date) return "?"
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" })
}
export function fmtTime(hhmm) {
  const m = minutesOf(hhmm)
  if (m === null) return null
  const h = Math.floor(m / 60), min = m % 60
  const ap = h >= 12 ? "PM" : "AM"
  const hh = h % 12 === 0 ? 12 : h % 12
  return min ? `${hh}:${String(min).padStart(2, "0")} ${ap}` : `${hh} ${ap}`
}
export function fmtWhen(ev) {
  const s = fmtTime(ev.start_time), e = fmtTime(ev.end_time)
  return `${fmtDate(ev.event_date)} · ${s ? (e ? `${s}–${e}` : s) : "time not listed"}`
}
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** One Telegram card (HTML). Buttons are added by the caller. */
export function cardText(ev) {
  const place = [ev.venue, ev.address ? null : ev.city].filter(Boolean).join(", ") + (ev.address ? ` — ${ev.address}` : "")
  const links = [ev.rsvp_url ? `<a href="${esc(ev.rsvp_url)}">RSVP</a>` : null, ev.source_link ? `<a href="${esc(ev.source_link)}">email</a>` : null].filter(Boolean).join(" · ")
  const lines = [
    `🍸 <b>${esc(ev.name)}</b>${ev.verdict === "borderline" ? ` ⚠️ <i>${esc(ev.borderline_reason || "borderline")}</i>` : ""}`,
    `${esc(fmtWhen(ev))}${place ? ` · ${esc(place)}` : ""}`,
    [ev.organizer ? esc(ev.organizer) : null, ev.cost ? esc(ev.cost) : null, links || null].filter(Boolean).join(" · "),
    ev.why ? `<i>${esc(ev.why)}</i>` : null,
    ev.email_count > 1 ? `<i>${ev.email_count} emails about this one</i>` : null,
  ]
  return lines.filter(Boolean).join("\n")
}

/** Brief section lines (HTML).
 *  @param {{ fresh?: any[], onCalendar?: any[], changed?: any[] }} groups */
export function briefLines({ fresh = [], onCalendar = [], changed = [] }) {
  const lines = []
  if (!fresh.length && !onCalendar.length && !changed.length) return lines
  lines.push(`<b>📅 Networking events${fresh.length ? ` (${fresh.length} new)` : ""}</b>`)
  for (const ev of fresh) lines.push(`• ${esc(fmtWhen(ev))} — <b>${esc(ev.name)}</b>${ev.venue || ev.city ? ` · ${esc(ev.venue || ev.city)}` : ""}${ev.cost ? ` · ${esc(ev.cost)}` : ""}${ev.verdict === "borderline" ? ` ⚠️ ${esc(ev.borderline_reason || "borderline")}` : ""}`)
  if (!fresh.length) lines.push("No new events.")
  for (const ev of onCalendar) lines.push(`• already on your calendar: ${esc(ev.name)} · ${esc(fmtDate(ev.event_date))}`)
  for (const ev of changed) lines.push(`• updated: ${esc(ev.name)} · now ${esc(fmtWhen(ev))}${ev.venue ? ` · ${esc(ev.venue)}` : ""}`)
  if (fresh.length) lines.push("Cards for each new one follow — ✓ Done clears it.")
  return lines
}

export const CB = { done: "ix:ed", add: "ix:ec", dismiss: "ix:en" }
export function cardButtons(ev) {
  return [[
    { text: "✓ Done", data: `${CB.done}:${ev.id}` },
    { text: "📅 Add to calendar", data: `${CB.add}:${ev.id}` },
    { text: "🚫 Not interested", data: `${CB.dismiss}:${ev.id}` },
  ]]
}
