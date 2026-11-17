// Lead email sync — the matching rules, shared by both halves
// (briefs/BRIEF_LEAD_EMAIL_SYNC_2026-11-17.md). Plain ESM, no deps: the Mac-mini
// inbox agent (leadmail.mjs) uses it to pick candidates and to know which senders
// are leads; Mission Control (lib/leadEmailSync.ts) uses the SAME functions to
// decide which card a message lands on, so the two can never disagree.
//
// A "cluster" is one card on the Leads tab: the rows groupLeads
// (components/widgets/LeadsTab.tsx) puts together — keyed by phone, else by the
// Gmail thread of an email row, else by email, else by row id.

export const LEAD_COLS =
  "id, created_at, lead_type, twilio_number, caller_phone, email, gmail_thread_id, gmail_message_id, name, property_address, source, source_type, status, is_junk, is_dnc"

/** More outside recipients than this on one send = a blast, not a conversation (same as the card sync). */
export const LEAD_BLAST_RECIPIENTS = 5
/** A hand-added / card-sent row this close to the email's own time is the same email. */
export const LEAD_STAMP_WINDOW_MS = 10 * 60_000
/** Row message cap (subject + body). */
export const LEAD_MESSAGE_MAX = 4000

const EMAIL_RE = /^[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/
const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"])
const ANONYMOUS = new Set(["anonymous", "restricted", "unavailable", "unknown", "private", "+266696687"])
/** Ryan's own sending domains (cards.mjs OWN_DOMAINS). */
export const OWN_LEAD_DOMAINS = ["lrghomes.com", "lrghomesbuys.com", "lrghomesoffers.com"]
// Ryan's personal Gmail sits on old lead rows (forwards he sent himself), and so
// do Google's no-reply senders — none of them is ever a lead.
const RYANS_OWN = new Set(["ryanlarocca9@gmail.com", "ryanlarocca@gmail.com"])
const MACHINE_LOCAL = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|bounces?)([+._-]|$)/

/**
 * The key two addresses match on: lower-cased, and for Gmail the dots and any
 * +tag in the local part dropped (david.levitt@ = davidlevitt@). "" when it
 * isn't an address.
 * @param {unknown} raw
 * @returns {string}
 */
export function leadEmailKey(raw) {
  if (typeof raw !== "string") return ""
  const angled = /<([^>]+)>/.exec(raw)
  const e = (angled ? angled[1] : raw).trim().replace(/^mailto:/i, "").toLowerCase()
  if (!EMAIL_RE.test(e)) return ""
  const at = e.lastIndexOf("@")
  let local = e.slice(0, at)
  let domain = e.slice(at + 1)
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.split("+")[0].replace(/\./g, "")
    domain = "gmail.com"
  }
  return local ? `${local}@${domain}` : ""
}

/**
 * An address that never identifies a lead: Ryan's own (domains + personal Gmail)
 * or a machine sender. Takes a raw address or a leadEmailKey.
 * @param {unknown} raw
 */
export function isNeverLeadAddress(raw) {
  const key = leadEmailKey(raw)
  if (!key) return true
  const [local, domain] = key.split("@")
  if (OWN_LEAD_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return true
  if (RYANS_OWN.has(key)) return true
  return MACHINE_LOCAL.test(local)
}

/** @param {string | null | undefined} phone */
export function isAnonymousCaller(phone) {
  return !!phone && ANONYMOUS.has(String(phone).trim().toLowerCase())
}

/** The lead talking (not Ryan): an inbound line, or a website form row (LeadsTab isOutbound). */
export function isInboundRow(r) {
  return !!r?.twilio_number || r?.lead_type === "form"
}

/** Ryan writing (scripts/judge.js isRyanOut): no line, not a drip. */
export function isRyanOutRow(r) {
  return !r?.twilio_number && !String(r?.lead_type || "").startsWith("drip_") && r?.lead_type !== "form"
}

/**
 * The card a row belongs to — groupLeads' key, exactly.
 * @param {{ id: string, caller_phone?: string | null, lead_type?: string | null, gmail_thread_id?: string | null, email?: string | null }} r
 * @returns {string}
 */
export function cardKeyOf(r) {
  if (r.caller_phone && !isAnonymousCaller(r.caller_phone)) return `phone:${r.caller_phone}`
  if (r.lead_type === "email" && r.gmail_thread_id) return `thread:${r.gmail_thread_id}`
  if (r.email) return `email:${String(r.email).toLowerCase()}`
  return `id:${r.id}`
}

const time = (r) => {
  const t = Date.parse(r?.created_at ?? "")
  return Number.isFinite(t) ? t : 0
}

/**
 * Lead rows → the index both halves match against.
 *   clusters  key → rows, newest first
 *   byEmail   leadEmailKey → [cluster key]   (every row's email)
 *   byThread  gmail thread id → [cluster key]
 * @param {Array<Record<string, any>>} rows
 */
export function buildLeadIndex(rows) {
  /** @type {Map<string, Array<Record<string, any>>>} */
  const clusters = new Map()
  for (const r of rows || []) {
    if (!r?.id) continue
    const key = cardKeyOf(r)
    const list = clusters.get(key) ?? []
    list.push(r)
    clusters.set(key, list)
  }
  for (const list of clusters.values()) list.sort((a, b) => time(b) - time(a))
  /** @type {Map<string, string[]>} */
  const byEmail = new Map()
  /** @type {Map<string, string[]>} */
  const byThread = new Map()
  const add = (map, k, key) => {
    if (!k) return
    const list = map.get(k) ?? []
    if (!list.includes(key)) list.push(key)
    map.set(k, list)
  }
  for (const [key, list] of clusters) {
    for (const r of list) {
      if (!isNeverLeadAddress(r.email)) add(byEmail, leadEmailKey(r.email), key)
      add(byThread, r.gmail_thread_id || "", key)
    }
  }
  return { clusters, byEmail, byThread }
}

/**
 * What the card shows for a cluster (groupLeads' rules): the status row is the
 * newest inbound row (else the newest row); name / address / source come from
 * it first, then the newest row that has one. junk = the card's Junk badge.
 * @param {Array<Record<string, any>>} rows newest first
 */
export function clusterProfile(rows) {
  const list = rows || []
  const mostRecentInbound = list.find(isInboundRow) || null
  const statusSource = mostRecentInbound || list[0] || null
  const pick = (field) => {
    const own = statusSource?.[field]
    if (typeof own === "string" && own.trim()) return own
    const any = list.map((r) => r[field]).find((v) => typeof v === "string" && v.trim())
    return any || null
  }
  const phoneRow = list.find((r) => r.caller_phone && !isAnonymousCaller(r.caller_phone))
  return {
    statusSource,
    mostRecentInbound,
    phone: phoneRow ? phoneRow.caller_phone : null,
    name: pick("name"),
    email: pick("email"),
    property_address: pick("property_address"),
    source: pick("source"),
    source_type: pick("source_type"),
    inheritedStatus: mostRecentInbound?.status || statusSource?.status || "new",
    junk: statusSource?.is_junk === true,
    dnc: list.some((r) => r.is_dnc === true),
    lastAt: list[0]?.created_at || null,
  }
}

function newestFirst(index, keys) {
  return [...keys].sort((a, b) => time(index.clusters.get(b)?.[0]) - time(index.clusters.get(a)?.[0]))
}

/**
 * Which cards a message belongs to.
 *   inbound  the sender's card; when the sender's address is on no lead, the card
 *            whose Gmail thread this is — unless that card's own address is in
 *            To/Cc (then the sender is a third party replying all). One card.
 *   sent     every To/Cc address's card (header order, a card already on this
 *            thread first). The thread alone is never enough — a forward of the
 *            lead's thread to someone else is not an email to the lead. More
 *            than LEAD_BLAST_RECIPIENTS outside people = a blast, skipped.
 * Junk cards are left out (reported in `skipped`). Each match carries the
 * address that matched (as written in the message) — the row's `email`.
 * @param {{ clusters: Map<string, any[]>, byEmail: Map<string, string[]>, byThread: Map<string, string[]> }} index
 * @param {{ direction: string, from?: string | null, to?: string[] | null, threadId?: string | null }} msg
 * @returns {{ matches: Array<{ key: string, address: string, via: "address" | "thread" }>, skipped: Array<{ key: string, reason: string }>, blast: number | null }}
 */
export function matchLeadClusters(index, msg, { blastLimit = LEAD_BLAST_RECIPIENTS } = {}) {
  const threadKeys = msg.threadId ? index.byThread.get(msg.threadId) ?? [] : []
  const skipped = []
  const usable = (key) => {
    if (!index.clusters.has(key)) return false
    if (clusterProfile(index.clusters.get(key)).junk) {
      if (!skipped.some((s) => s.key === key)) skipped.push({ key, reason: "junk" })
      return false
    }
    return true
  }
  const to = (msg.to || []).map((e) => String(e || "").toLowerCase()).filter((e) => e && !isNeverLeadAddress(e))

  if (msg.direction === "inbound") {
    const from = String(msg.from || "").toLowerCase()
    if (isNeverLeadAddress(from)) return { matches: [], skipped, blast: null }
    const byAddr = (index.byEmail.get(leadEmailKey(from)) ?? []).filter(usable)
    if (byAddr.length) {
      const onThread = byAddr.filter((k) => threadKeys.includes(k))
      const key = (onThread.length ? newestFirst(index, onThread) : newestFirst(index, byAddr))[0]
      return { matches: [{ key, address: from, via: "address" }], skipped, blast: null }
    }
    const toKeys = new Set(to.flatMap((e) => index.byEmail.get(leadEmailKey(e)) ?? []))
    const byThread = threadKeys.filter((k) => !toKeys.has(k)).filter(usable)
    if (from && byThread.length) return { matches: [{ key: newestFirst(index, byThread)[0], address: from, via: "thread" }], skipped, blast: null }
    return { matches: [], skipped, blast: null }
  }

  if (msg.direction !== "sent") return { matches: [], skipped, blast: null }
  const matches = []
  for (const address of to) {
    for (const key of newestFirst(index, index.byEmail.get(leadEmailKey(address)) ?? [])) {
      if (matches.some((m) => m.key === key) || !usable(key)) continue
      matches.push({ key, address, via: threadKeys.includes(key) ? "thread" : "address" })
    }
  }
  matches.sort((a, b) => Number(b.via === "thread") - Number(a.via === "thread"))
  if (to.length > blastLimit) return { matches, skipped, blast: to.length }
  return { matches, skipped, blast: null }
}

/** True when the message would land on a lead card (the mini's gate: candidates, the deal-card skip, the Relationships alert hand-off). */
export function isLeadMessage(index, msg) {
  if (!index) return false
  const m = matchLeadClusters(index, msg)
  return m.matches.length > 0
}

/**
 * The gmail_message_id a row carries. The unique index on leads.gmail_message_id
 * allows one row per value, so the first card a send matched carries the Gmail id
 * itself and any further card `<id>:<card key>` (stable across retries).
 * @param {string} gmailId
 * @param {number} i
 * @param {string} key
 */
export function leadRowMessageId(gmailId, i, key) {
  return i === 0 ? gmailId : `${gmailId}:${key}`
}

/**
 * Already on the card? A row with this message id = duplicate. Otherwise a row on
 * the card with no Gmail id, the same direction, within LEAD_STAMP_WINDOW_MS of
 * the email and on the same thread (or none) = the same email added by hand / by
 * the card's own send → stamp the id onto it (closest wins).
 *   sent    Ryan-out email rows (lead_type email | drip_email, no line)
 *   inbound email rows on this mailbox's line
 * @param {{ direction: string, at: string, threadId?: string | null }} msg
 * @param {string} rowMessageId
 * @param {Array<Record<string, any>>} rows the card's rows
 * @param {{ mailboxLine: string, windowMs?: number }} opts
 * @returns {{ kind: "duplicate" | "stamp", leadId: string } | { kind: "insert" }}
 */
export function planLeadWrite(msg, rowMessageId, rows, { mailboxLine, windowMs = LEAD_STAMP_WINDOW_MS }) {
  const dup = (rows || []).find((r) => r.gmail_message_id === rowMessageId)
  if (dup) return { kind: "duplicate", leadId: dup.id }
  const at = Date.parse(msg.at)
  let best = null
  for (const r of rows || []) {
    if (r.gmail_message_id) continue
    if (r.gmail_thread_id && r.gmail_thread_id !== msg.threadId) continue
    const sameDirection =
      msg.direction === "sent"
        ? !r.twilio_number && (r.lead_type === "email" || r.lead_type === "drip_email")
        : r.lead_type === "email" && String(r.twilio_number || "").toLowerCase() === mailboxLine.toLowerCase()
    if (!sameDirection) continue
    const gap = Math.abs(time(r) - at)
    if (!Number.isFinite(gap) || gap > windowMs) continue
    if (!best || gap < best.gap) best = { id: r.id, gap }
  }
  return best ? { kind: "stamp", leadId: best.id } : { kind: "insert" }
}

/** `subject\n\nbody`, capped — the row's message (same shape as the card's send). */
export function leadMessageText(subject, body, max = LEAD_MESSAGE_MAX) {
  const s = String(subject || "").trim() || "(no subject)"
  const b = String(body || "").trim()
  return (b ? `${s}\n\n${b}` : s).slice(0, max)
}
