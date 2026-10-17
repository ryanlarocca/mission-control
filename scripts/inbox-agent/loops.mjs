// Inbox Agent — open-loop rules shared by the worker and its tests.
//
// Ryan 2026-10-12: the 93 Ridgeview card he still sees came from loop
// 25a67d93… created BY the "Completed:" email (kind=docusign_completed, the
// classifier said needs_reply=true), so the agent nagged him to sign something
// he had already signed. A completion is an event that CLOSES a signature
// loop; it never opens one.
//
// Ryan 2026-10-17 (briefs/BRIEF_INBOX_LOOP_HYGIENE_2026-10-17.md): the morning
// brief listed 7 + 3 items of which one was really his. Everything here is
// pure so the worker (index.mjs), the Vercel webhook (lib/inboxAgent.ts) and
// the unit tests agree on every verdict:
//   A. a reply counts against the EMAIL's date (message_at), never the loop row's
//   B. a reply to the same person counts, on any thread
//   C. vendor completion events (HomeSentry paid / updated / report filed,
//      FreshBooks $0.00) close loops and dismiss loose ends
//   D. one ask = one loop (loopKey, 48 h window)
//   E. notification relays are never "human emails with no reply"
//   F. owed_by: "ryan" | "them" → "Waiting on them"
import { addressIn, extractUrls, tapinspectShareId } from "./fetch/providers.mjs"
import { keysMatch, propertyKey } from "./env.mjs"

// ---------------------------------------------------------------- completions never open loops
/** Message kinds that may never reach upsertLoop. */
export const COMPLETION_KINDS = new Set(["docusign_completed", "esign_completed"])
/** A completion kind, or an email that IS a vendor completion event (Part C), never opens a loop.
 * @param {string|null|undefined} kind
 * @param {{ from?: {email?: string}, sender?: string, subject?: string, text?: string }|null} [msg]
 * @param {any} [cls] */
export function loopEligible(kind, msg = null, cls = null) {
  if (COMPLETION_KINDS.has(String(kind || ""))) return false
  if (msg && completionEvent(msg, cls)) return false
  return true
}

const PREFIX_RE = /^(?:re|fw|fwd|completed|declined|reminder|final reminder|please sign|please docusign|signing complete|please review and sign|please review|action required)\b:?\s*/i

/** "Completed: Please Sign: 93 Ridgeview Ave - Disclosures" → "93ridgeviewavedisclosures".
 *  Every leading prefix is stripped, however many are stacked. */
export function normalizeEnvelope(subject) {
  let s = String(subject || "").trim()
  for (let i = 0; i < 6; i++) {
    const next = s.replace(PREFIX_RE, "")
    if (next === s) break
    s = next.trim()
  }
  return s.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/** Does a completion email close this signature loop? */
export function envelopeMatches(loopSubject, messageSubject) {
  const a = normalizeEnvelope(loopSubject)
  const b = normalizeEnvelope(messageSubject)
  return !!a && !!b && a === b
}

// ---------------------------------------------------------------- Part A: the email's date, not the row's
/** How far back sent mail is read, for resolveLoops AND the digest's loose ends (one window). */
export const SENT_LOOKBACK_DAYS = 8

const ms = (iso) => {
  const t = iso ? new Date(iso).getTime() : NaN
  return Number.isFinite(t) ? t : null
}
/** The instant an item became something to answer: the email's internalDate (message_at), else the row date. */
export function itemSince(item) {
  return item?.message_at || item?.internal_date || item?.created_at || null
}
/** A sent message resolves a loop when it is NEWER than the email that opened/refreshed the loop
 *  (loop.message_at), falling back to created_at for rows from before the column existed.
 *  Live 2026-10-16: a replay minted the Halleck loop at 23:50 UTC; Ryan's "Paid" went out at 20:40 → resolves. */
export function replyResolves(loop, sentAt) {
  const since = ms(itemSince(loop))
  const sent = ms(sentAt)
  if (since === null || sent === null) return false
  return sent > since
}

// ---------------------------------------------------------------- Part B: the same person, any thread
const EMAIL_RE = /[a-z0-9._%+\-'=/]+@[a-z0-9.\-]+\.[a-z]{2,}/gi

/** Every address in a To/Cc header, lower-cased, deduped, in order:
 *  `"Muniz, Juan" <Juan@LetterPrinting.net>, alan@letterprinting.net` → ["juan@letterprinting.net", "alan@letterprinting.net"]. */
export function parseAddressList(header) {
  const out = []
  const seen = new Set()
  for (const raw of String(header || "").match(EMAIL_RE) || []) {
    const e = raw.replace(/^[.'-]+|[.'-]+$/g, "").toLowerCase()
    if (!e || seen.has(e)) continue
    seen.add(e)
    out.push(e)
  }
  return out
}

function bump(map, key, when) {
  if (!key || !when) return
  const prev = map.get(key)
  if (!prev || ms(when) > ms(prev)) map.set(key, when)
}

/**
 * Fold sent messages into the two lookups resolution uses.
 * @param {Array<{ threadId?: string|null, internalDate?: string|null, to?: string|null, cc?: string|null }>} messages
 * @param {{ self?: string|null }} [opts] Ryan's own address, never a recipient
 * @returns {{ byThread: Map<string,string>, byRecipient: Map<string,string> }} threadId → latest sent ISO; recipient email → latest sent ISO
 */
export function foldSent(messages, { self = null } = {}) {
  const byThread = new Map()
  const byRecipient = new Map()
  const me = String(self || "").toLowerCase()
  for (const m of messages || []) {
    bump(byThread, m.threadId, m.internalDate)
    for (const e of parseAddressList(`${m.to || ""}, ${m.cc || ""}`)) if (e !== me) bump(byRecipient, e, m.internalDate)
  }
  return { byThread, byRecipient }
}

/**
 * Has Ryan answered this item? "thread" when he sent on its thread after the
 * email, "recipient" when he wrote its counterparty on ANY thread after the
 * email (Juan's "Soft quote" thread is answered by the three sends on "NOO
 * Absentee Q4"), else null. Item = a loop (counterparty_email) or an
 * inbox_messages row (sender). For a forward the counterparty is the
 * forwarder — Amanda's forward is answered when Ryan writes Amanda.
 * @param {{ thread_id?: string|null, counterparty_email?: string|null, sender?: string|null, message_at?: string|null, internal_date?: string|null, created_at?: string|null }} item
 * @param {{ byThread?: Map<string,string>, byRecipient?: Map<string,string> } | Map<string,string> | null | undefined} sent
 * @returns {"thread"|"recipient"|null}
 */
export function answeredBy(item, sent) {
  const byThread = sent instanceof Map ? sent : sent?.byThread
  const byRecipient = sent instanceof Map ? null : sent?.byRecipient
  if (item?.thread_id && byThread?.has(item.thread_id) && replyResolves(item, byThread.get(item.thread_id))) return "thread"
  const who = String(item?.counterparty_email || item?.sender || "").trim().toLowerCase()
  if (who && byRecipient?.has(who) && replyResolves(item, byRecipient.get(who))) return "recipient"
  return null
}

// ---------------------------------------------------------------- Part E: relays are never loose ends
/** Senders that are notification relays: a reply goes nowhere, so a thread from them is never "Unanswered". */
export const RELAY_SENDER_RE = /noreply|no-reply|notification|docusign|authentisign|freshbooks\.com|tapinspect\.com|pandadoc|quickbooks|intuit\.com|bill\.com|invoicing|statements?@/i

/**
 * The digest's loose-end rule for one inbox_messages row: a human email from
 * the last week, ≥ 2 days old, not a loop's thread, not dismissed, not a relay,
 * not FYI / marketing, and not answered (same thread or same person).
 * @param {{ thread_id?: string|null, sender?: string|null, internal_date?: string|null, classification?: any }} m
 * @param {{ sent?: any, openThreads?: Set<string>, dismissed?: Record<string, any>, now?: number, minAgeDays?: number }} opts
 */
export function isLooseEnd(m, { sent = null, openThreads = new Set(), dismissed = {}, now = Date.now(), minAgeDays = 2 } = {}) {
  if (!m?.thread_id) return false
  if (openThreads.has(m.thread_id)) return false
  if (dismissed && dismissed[m.thread_id]) return false
  const c = m.classification || {}
  if (c.is_human === false || RELAY_SENDER_RE.test(String(m.sender || ""))) return false
  if (c.needs_reply === false) return false // FYI mail (a signed copy, a "thanks") is not a loose end
  if (c.solicitation === true || c.deal?.tier === "blast") return false // marketing is never a loose end (Ryan 2026-10-03)
  if (answeredBy(m, sent)) return false
  const t = ms(m.internal_date)
  if (t === null || now - t < minAgeDays * 86_400_000) return false
  return true
}

// ---------------------------------------------------------------- Part C: completion events
/** Vendor families that emit completion events, by sender domain and by the names they go by in subjects/asks. */
export const VENDOR_DOMAINS = { tapinspect: /(^|[.@])tapinspect\.com$/i, freshbooks: /(^|[.@])freshbooks\.com$/i }
const VENDOR_NAMES = { tapinspect: /homesentry|tap ?inspect/i, freshbooks: /freshbooks/i }
const TAP_PAID_SUBJECT_RE = /^(?:re:\s*)*thank you for your payment/i
const TAP_UPDATED_SUBJECT_RE = /inspection results\b.*\bhave been updated/i
const FB_PAID_SUBJECT_RE = /commented on invoice\s+(\S+)\s+\(\$0\.00\)/i
const FB_INVOICE_RE = /invoice\s*#?\s*([A-Z0-9][A-Z0-9-]{2,})/i
const PAID_BODY_RE = /thank you for your payment/i
// A termite / WDO / pest inspection is another inspector's trade, and an
// inspection CONTINGENCY is the buyer's decision — a HomeSentry event never
// closes South Bay Termite's ask or a "remove the inspection contingency" on
// the same house. Nor does it close an e-sign envelope that merely mentions
// the inspection (the DocuSign "Completed" path owns those).
const OTHER_INSPECTOR_RE = /termite|\bWDO\b|\bpest\b|contingenc/i
const ESIGN_RELAY_RE = /docusign|authentisign|esign|dotloop|glide|pandadoc/i

function senderOf(msg) {
  return String(msg?.from?.email || msg?.sender || "").trim().toLowerCase()
}
function shareIdsIn(text, extra = []) {
  const ids = new Set()
  for (const u of [...extractUrls(text), ...(Array.isArray(extra) ? extra : [])]) {
    const id = tapinspectShareId(u)
    if (id) ids.add(id)
  }
  return [...ids]
}

/**
 * @typedef {{ kind: "paid"|"updated"|"report_filed", vendor: "tapinspect"|"freshbooks", property: string|null, invoice: string|null, shareId: string|null }} CompletionEvent
 */

/**
 * Is this email a vendor completion — something that CLOSES a loop and never opens one?
 *   HomeSentry (`@tapinspect.com`): "Thank you for your payment" → paid (property from the body:
 *   "payment for the inspection of <address>."); "Inspection results for <address> have been updated" → updated.
 *   FreshBooks (`@freshbooks.com`): "… commented on invoice <no> ($0.00)" or a "thank you for your payment" body → paid.
 * @param {{ from?: {email?: string}, sender?: string, subject?: string, text?: string }} msg
 * @param {any} [cls] the classification ({ property, document_links, … })
 * @returns {CompletionEvent|null}
 */
export function completionEvent(msg, cls = null) {
  const sender = senderOf(msg)
  if (!sender) return null
  const subject = String(msg?.subject || "")
  const text = String(msg?.text || "")
  if (VENDOR_DOMAINS.tapinspect.test(sender)) {
    let kind = null
    let property = null
    if (TAP_PAID_SUBJECT_RE.test(subject)) {
      kind = "paid"
      property = addressIn((/payment for the inspection (?:of|at)\s+([^\n]+)/i.exec(text) || [])[1]) || addressIn(text) || addressIn(subject) || cls?.property?.label || null
    } else if (TAP_UPDATED_SUBJECT_RE.test(subject)) {
      kind = "updated"
      property = addressIn(subject) || cls?.property?.label || addressIn(text) || null
    }
    if (!kind) return null
    return { kind, vendor: "tapinspect", property, invoice: null, shareId: shareIdsIn(text, cls?.document_links)[0] || null }
  }
  if (VENDOR_DOMAINS.freshbooks.test(sender)) {
    const m = FB_PAID_SUBJECT_RE.exec(subject)
    if (!m && !PAID_BODY_RE.test(text)) return null
    const invoice = m?.[1] || (FB_INVOICE_RE.exec(subject) || [])[1] || (FB_INVOICE_RE.exec(text) || [])[1] || null
    // No property on a FreshBooks receipt: it closes by invoice number only, never a property loop.
    return { kind: "paid", vendor: "freshbooks", property: null, invoice, shareId: null }
  }
  return null
}

/** A FILED inspection report is also a completion (the agent itself put the HomeSentry PDF in Drive).
 * @param {string|null|undefined} property
 * @returns {CompletionEvent|null} */
export function reportFiledEvent(property) {
  return property ? { kind: "report_filed", vendor: "tapinspect", property: String(property), invoice: null, shareId: null } : null
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * The core comparison. `t` is the target — a loop or a message — with whatever
 * context the caller could gather: { senderEmail, vendorFamily, propertyKey,
 * subject, ask, text, propertyLabel, shareIds }. Returns why it matches:
 *   "invoice"             the event's invoice number appears in the target
 *   "share"               the same tapinspect share uuid (body, links, or inbox_fetches.url)
 *   "vendor+property"     same vendor family (sender/forward-origin domain or the vendor's name) AND the same property
 *   "inspection+property" (tapinspect only) an inspection ask for that property that isn't another inspector's trade
 * or null.
 * @param {CompletionEvent|null|undefined} event
 * @param {{ senderEmail?: string|null, vendorFamily?: string|null, propertyKey?: string|null, subject?: string|null, ask?: string|null, text?: string|null, propertyLabel?: string|null, shareIds?: string[]|null }|null} t
 * @returns {"invoice"|"share"|"vendor+property"|"inspection+property"|null}
 */
export function completionMatch(event, t) {
  if (!event) return null
  const head = `${t?.subject || ""}\n${t?.ask || ""}`
  const hay = `${head}\n${t?.text || ""}`
  if (event.invoice && new RegExp(`(^|[^a-z0-9])${escapeRe(event.invoice)}([^a-z0-9]|$)`, "i").test(hay)) return "invoice"
  if (event.shareId) {
    const want = String(event.shareId).toLowerCase()
    const ids = new Set([...(t?.shareIds || []).map((s) => String(s).toLowerCase()), ...shareIdsIn(hay)])
    if (ids.has(want) || hay.toLowerCase().includes(want)) return "share"
  }
  const eKey = propertyKey(event.property)
  if (!eKey) return null
  const keys = [propertyKey(addressIn(head)), propertyKey(t?.propertyLabel), t?.propertyKey || null].filter(Boolean)
  if (!keys.some((k) => keysMatch(k, eKey))) return null
  const domainRe = VENDOR_DOMAINS[event.vendor]
  const sameVendor = (domainRe && (domainRe.test(String(t?.senderEmail || "")) || domainRe.test(String(t?.vendorFamily || "")))) || VENDOR_NAMES[event.vendor]?.test(hay)
  if (sameVendor) return "vendor+property"
  if (event.vendor === "tapinspect" && /inspection/i.test(head) && !OTHER_INSPECTOR_RE.test(head) && !ESIGN_RELAY_RE.test(`${t?.senderEmail || ""} ${t?.vendorFamily || ""}`)) return "inspection+property"
  return null
}

/**
 * Does a completion close this loop? `extra` = the loop's message context the
 * worker looks up: { text (the gmail_id's body), propertyLabel (its
 * classification), shareIds (tapinspect uuids from inbox_fetches on its thread) }.
 * Closes every open/snoozed/acknowledged loop for that property whose vendor
 * family is the event's (counterparty, forward origin via loop_key, or the
 * vendor's name in the ask), or whose ask is an inspection ask on that
 * property — Amanda's forward of the HomeSentry booking included.
 * @param {CompletionEvent|null|undefined} event
 * @param {any} loop an inbox_loops row
 * @param {{ text?: string|null, propertyLabel?: string|null, shareIds?: string[]|null }} [extra]
 */
export function completionCloses(event, loop, extra = {}) {
  if (!loop) return false
  const parsed = parseLoopKey(loop.loop_key)
  return !!completionMatch(event, {
    senderEmail: loop.counterparty_email,
    vendorFamily: parsed?.family || null,
    propertyKey: parsed?.propertyKey || null,
    subject: loop.subject,
    ask: loop.ask,
    text: extra.text,
    propertyLabel: extra.propertyLabel,
    shareIds: extra.shareIds,
  })
}

/**
 * Does a completion dismiss this Unanswered thread? Stricter than a loop: the
 * message must come from the same vendor domain (or forward it) and match the
 * property / share uuid, or carry the invoice number — the brief's rule for
 * writing agent.unanswered_dismissed.
 * @param {CompletionEvent|null|undefined} event
 * @param {{ sender?: string|null, subject?: string|null, classification?: any }|null|undefined} row inbox_messages row
 * @param {{ text?: string|null, shareIds?: string[]|null, vendorFamily?: string|null }} [extra]
 */
export function completionDismisses(event, row, extra = {}) {
  if (!row) return false
  const why = completionMatch(event, {
    senderEmail: row.sender,
    vendorFamily: extra.vendorFamily || null,
    subject: row.subject,
    ask: row.classification?.ask,
    text: extra.text,
    propertyLabel: row.classification?.property?.label,
    shareIds: extra.shareIds,
  })
  return why === "invoice" || why === "share" || why === "vendor+property"
}

// ---------------------------------------------------------------- Part D: one ask, one loop
/** A second email for the same ask within this window refreshes the loop instead of opening another. */
export const LOOP_KEY_WINDOW_MS = 48 * 60 * 60_000
export const FORWARD_SUBJECT_RE = /^\s*(?:fwd?|fw)\s*:/i
const QUOTED_FROM_RE = /^[\s>*_]*from\s*:[\s*_]*(.+)$/im
const FREE_MAIL_RE = /^(gmail|yahoo|hotmail|outlook|icloud|aol|comcast|me|live|msn)\.com$/i

/** Sender domain, or the whole address on a free-mail domain ("southbaytermite@yahoo.com" is its own family). */
export function vendorFamilyOf(email) {
  const e = String(email || "").trim().toLowerCase()
  const d = e.split("@")[1] || ""
  if (!d) return e
  return FREE_MAIL_RE.test(d) ? e : d
}

/** On a forward ("Fwd: …"), the original sender found in the quoted header (`From: HomeSentry <inspections@tapinspect.com>`), else null. */
export function forwardOrigin(msg) {
  if (!FORWARD_SUBJECT_RE.test(String(msg?.subject || ""))) return null
  const m = QUOTED_FROM_RE.exec(String(msg?.text || ""))
  if (!m) return null
  const self = senderOf(msg)
  return parseAddressList(m[1]).find((e) => e !== self) || null
}

/** signature | payment | agreement | other — from the ask text, then the subject. */
export function askKind(text) {
  const t = String(text || "")
  if (/\bsign/i.test(t)) return "signature"
  if (/\bagreement\b/i.test(t)) return "agreement"
  if (/\bpay(?:ment|ing|able)?\b|\binvoice\b/i.test(t)) return "payment"
  return "other"
}

/**
 * `${vendorFamily}|${propertyKey}|${askKind}` — the identity of an ask. The
 * three Quito emails (HomeSentry booking, HomeSentry "Please sign agreement",
 * Amanda's forward of the booking) all key to `tapinspect.com|2116quito|signature`.
 * @param {{ from?: {email?: string}, subject?: string, text?: string }} msg
 * @param {{ ask?: string|null, property?: {label?: string}|null }|null} [cls]
 */
export function loopKey(msg, cls = null) {
  const family = vendorFamilyOf(forwardOrigin(msg) || senderOf(msg))
  const prop = propertyKey(addressIn(msg?.subject) || cls?.property?.label || addressIn(msg?.text)) || ""
  let kind = askKind(cls?.ask)
  if (kind === "other") kind = askKind(msg?.subject)
  return `${family}|${prop}|${kind}`
}
export function parseLoopKey(key) {
  if (!key) return null
  const [family = "", propertyKey = "", askKind = ""] = String(key).split("|")
  return { family, propertyKey, askKind }
}

/**
 * The open/snoozed loop opened in the last 48 h for the same ask, else null.
 * A key with no property segment never matches (two property-less asks from
 * one vendor are two asks). An `asked` loop (Part H) matches at any age — a
 * vendor reminder for the same ask reopens it rather than opening a new one.
 */
export function loopKeyMatch(loops, key, now = Date.now()) {
  const parsed = parseLoopKey(key)
  if (!parsed?.propertyKey) return null
  const rows = (loops || []).filter((l) => l.loop_key === key)
  return rows.find((l) => (l.status === "open" || l.status === "snoozed") && ms(l.created_at) !== null && now - ms(l.created_at) <= LOOP_KEY_WINDOW_MS) || rows.find((l) => l.status === "asked") || null
}

/**
 * The patch that refreshes an existing loop with a newer email for the same ask:
 * newest gmail_id / message_at, earliest created_at kept (not in the patch),
 * due_on kept unless the new one is set, priority high wins, reopened. The ask
 * follows the newest email only on the same thread (a reply moved the ask); a
 * forward or a sibling email never overwrites the vendor's own wording.
 * @param {any} existing the inbox_loops row
 * @param {{ gmail_id: string, message_at?: string|null, due_on?: string|null, priority?: string|null, ask?: string|null, loop_key?: string|null, owed_by?: string|null }} incoming
 * @param {{ sameThread?: boolean }} [opts]
 * @returns {{ gmail_id: string, message_at: string|null, due_on: string|null, priority: string, status: "open", snooze_until: null, ask?: string, loop_key?: string, owed_by?: string }}
 */
export function mergeLoop(existing, incoming, { sameThread = false } = {}) {
  /** @type {{ gmail_id: string, message_at: string|null, due_on: string|null, priority: string, status: "open", snooze_until: null, ask?: string, loop_key?: string, owed_by?: string }} */
  const patch = {
    gmail_id: incoming.gmail_id,
    message_at: incoming.message_at || existing.message_at || null,
    due_on: incoming.due_on || existing.due_on || null,
    priority: incoming.priority === "high" || existing.priority === "high" ? "high" : existing.priority || incoming.priority || "normal",
    status: "open",
    snooze_until: null,
  }
  if (sameThread && incoming.ask) patch.ask = incoming.ask
  if (incoming.loop_key && !existing.loop_key) patch.loop_key = incoming.loop_key
  if (incoming.owed_by) patch.owed_by = incoming.owed_by
  return patch
}

// ---------------------------------------------------------------- Part H: ask once when the mailbox can't know
// Ryan 2026-10-17: "It may be hard for the system to deduce that I signed the
// HomeSentry inspection. When in doubt it can ask me, but some of these from
// this morning were ridiculous." Evidence (Parts A–C) always beats asking; an
// ask that can only be completed outside email (the tapinspect portal, a
// vendor's e-sign page, a FreshBooks pay link) is asked about ONCE in the
// brief, then parked as status `asked`: not re-listed, not counted, still
// closed by a completion or a reply, reopened only by a vendor reminder on the
// same loop_key.
/** Loop statuses that are still live for resolution, completion and dedupe. */
export const LOOP_ACTIVE_STATUSES = ["open", "snoozed", "acknowledged", "asked"]
const PORTAL_SUBJECT_RE = /please sign|agreement|invoice/i
const PORTAL_ASK_RE = /\bsign|\bpay/i
const NOISE_LINK_RE = /unsubscribe|optout|opt-out|preferences|privacy|terms|mailto:|facebook\.com|instagram\.com|linkedin\.com|twitter\.com|x\.com\/|youtube\.com|yelp\.com|google\.com\/maps|zillow\.com|redfin\.com/i
const DOCUSIGN_LINK_RE = /docusign\.(net|com)/i

/**
 * How this ask gets resolved: "portal" when it can only be completed outside
 * email, else "email". tapinspect "please sign / agreement / invoice" and any
 * FreshBooks notice are portal asks; so is any sign/pay ask whose body carries a
 * non-DocuSign action link. A DocuSign request stays "email" — its Completed
 * email closes it.
 * @param {{ from?: {email?: string}, sender?: string, subject?: string, text?: string }} msg
 * @param {any} [cls]
 * @param {string|null} [kind] the classifier kind (docusign_request never becomes portal)
 * @returns {"portal"|"email"}
 */
export function resolutionKind(msg, cls = null, kind = null) {
  if (kind === "docusign_request") return "email"
  const sender = senderOf(msg)
  const subject = String(msg?.subject || "")
  const ask = String(cls?.ask || "")
  if (VENDOR_DOMAINS.tapinspect.test(sender) && (PORTAL_SUBJECT_RE.test(subject) || PORTAL_SUBJECT_RE.test(ask))) return "portal"
  if (VENDOR_DOMAINS.freshbooks.test(sender)) return "portal"
  if (PORTAL_ASK_RE.test(ask)) {
    const links = extractUrls(msg?.text).filter((u) => !DOCUSIGN_LINK_RE.test(u) && !NOISE_LINK_RE.test(u))
    if (links.length) return "portal"
  }
  return "email"
}

/** Is this open portal loop due to be asked about at this brief? Every open portal
 *  ask is asked at the first brief after it opens (or when due_on is tomorrow or
 *  sooner); an `asked` loop is never asked twice. */
export function shouldAskPortal(loop, now = Date.now()) {
  if (!loop || loop.status !== "open" || loop.resolution !== "portal") return false
  if (loop.owed_by === "them") return false
  const opened = ms(loop.message_at || loop.created_at)
  if (opened !== null && opened <= now) return true
  const due = loop.due_on ? ms(`${loop.due_on}T23:59:59-07:00`) : null
  return due !== null && due - now <= 86_400_000
}

// ---------------------------------------------------------------- Part F: waiting on them
/** Who holds the next action after this email: the classifier's owed_by, default "ryan". */
export function owedBy(cls) {
  return cls?.owed_by === "them" ? "them" : "ryan"
}
/**
 * Live loops → the brief's buckets: `asked` (status asked — listed only by the
 * `open` command), `theirs` (owed_by 'them'), `ask` (open portal asks to ask about
 * ONCE, Part H), `mine` (everything else: "Waiting on you").
 * @param {any[]|null|undefined} loops
 * @param {{ now?: number }} [opts]
 */
export function splitLoops(loops, { now = Date.now() } = {}) {
  const mine = []
  const theirs = []
  const ask = []
  const asked = []
  for (const l of loops || []) {
    if (!l) continue
    if (l.status === "asked") asked.push(l)
    else if (l.owed_by === "them") theirs.push(l)
    else if (shouldAskPortal(l, now)) ask.push(l)
    else mine.push(l)
  }
  return { mine, theirs, ask, asked }
}
/** A reply on a loop card that flips owed_by: "theirs" / "them" → them, "mine" / "me" → ryan, else null. */
export function owedByFromReply(text) {
  const t = String(text || "").trim().toLowerCase()
  if (/^(theirs|them|their (?:ball|move|turn)|waiting on them|on them)\b/.test(t)) return "them"
  if (/^(mine|me|my (?:ball|move|turn)|on me)\b/.test(t)) return "ryan"
  return null
}
