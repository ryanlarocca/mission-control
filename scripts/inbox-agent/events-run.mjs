// Inbox Agent — networking-event watcher, the IO half (briefs/BRIEF_EVENT_WATCHER_2026-10-15.md):
//   scanEvents           every pass: new mail on ryan@ (Gmail API) + ryanlarocca9@ (IMAP)
//                        → prefilter → Sonnet extraction → rules verdict → one inbox_events
//                        row per real event (reminders collapse onto it).
//   eventBrief           at brief time: "already on calendar" check, the brief section.
//   postEventCards       after the brief: one card per new event (✓ Done / 📅 Add / 🚫).
//   applyEventDecisions  every pass: Add-to-calendar taps → gog calendar create on info@.
// Read-only on both mailboxes. Never alerts at detection time (Ryan 2026-10-15).
import { spawn } from "node:child_process"
import { ImapFlow } from "imapflow"
import { MAILBOX, getSetting, log, ptParts, sb, setSetting, warn } from "./env.mjs"
import { getAttachmentBytes, getMessage, htmlToText, listMessageIds, parseAddress } from "./gmail.mjs"
import { SONNET, completeJson } from "./llm.mjs"
import { esc, tgSend } from "./telegram.mjs"
import {
  briefLines, calendarDescription, calendarMatches, calendarSummary, calendarWindow, cardButtons, cardText,
  detailsHash, eventPrompt, eventSystem, matchEvent, organizerFamily, prefilter, verdictFor,
} from "./events.mjs"

const PERSONAL_USER = process.env.PILE_GMAIL_IMAP_USER || ""
const PERSONAL_PASS = (process.env.PILE_GMAIL_IMAP_PASSWORD || "").replace(/\s+/g, "")
const GOG = process.env.GOG_BIN || "/opt/homebrew/bin/gog"
const CAL_ACCOUNT = process.env.EVENTS_CALENDAR_ACCOUNT || "info@lrghomes.com"
const SEEN_TTL_DAYS = 10
const MAX_CANDIDATES_PER_PASS = 40

function isoNow() {
  return new Date().toISOString()
}
function dayOf(iso) {
  return String(iso || "").slice(0, 10)
}
/** Meetup/Eventbrite HTML turns into pages of blank lines and zero-width joiners that
 *  crowd the real content out of the model's window — collapse it first. */
export function squeeze(text) {
  return String(text || "")
    .replace(/[\u200b-\u200f\u2060\ufeff\u00a0]/g, " ")
    // Click-tracking URLs run to 600+ chars and bury the content (Acquire'd, Postmark); keep real links.
    .replace(/\[?(https?:\/\/\S{120,})\]?/g, "[link]")
    .split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n")
}
/** Image-only marketing (a flyer and nothing else) gives the model nothing to read. */
export function unreadable(text) {
  return String(text || "").replace(/\[link\]/g, "").replace(/\s+/g, " ").trim().length < 120
}
function gmailLink(id) {
  return `https://mail.google.com/mail/u/0/#all/${id}`
}
function personalLink(messageId) {
  const mid = String(messageId || "").replace(/^<|>$/g, "")
  return mid ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(PERSONAL_USER)}#search/rfc822msgid%3A${encodeURIComponent(mid)}` : null
}

// ------------------------------------------------------------------ seen-set (inbox_settings.events)
async function loadSeen() {
  const s = await getSetting("events")
  const seen = s.seen || {}
  const cutoff = Date.now() - SEEN_TTL_DAYS * 86_400_000
  for (const [k, v] of Object.entries(seen)) if (new Date(v).getTime() < cutoff) delete seen[k]
  return { settings: s, seen }
}

// ------------------------------------------------------------------ one candidate → row
async function classifyCandidate(c) {
  // Flyer-only emails (Acquire'd): the body is one image — send it along and say so.
  const docs = (c.images || []).slice(0, 2).map((img) => ({ kind: "image", data: img.data, mime: img.mime, name: img.filename }))
  const text = docs.length && unreadable(c.text) ? `${c.text}\n\n(The email body is the attached image — read the event details from it.)` : c.text
  const out = await completeJson({ model: SONNET, thinking: false, maxTokens: 2048, tag: "[event]", system: eventSystem(c.receivedDate), prompt: eventPrompt({ ...c, text }), docs })
  const v = verdictFor(out, c.receivedDate)
  return { out, v }
}

function rowFrom(c, out, v) {
  const from = parseAddress(c.from)
  return {
    name: String(out.name || c.subject || "Event").slice(0, 200),
    organizer: out.organizer || from.name || from.email,
    organizer_family: organizerFamily({ fromEmail: from.email, fromName: from.name, organizer: out.organizer }),
    event_date: out.date,
    start_time: out.start_time || null,
    end_time: out.end_time || null,
    venue: out.venue || null,
    address: out.address || null,
    city: out.city || null,
    cost: out.cost || null,
    rsvp_url: out.rsvp_url || null,
    why: out.who_in_room || null,
    verdict: v.verdict,
    borderline_reason: v.verdict === "borderline" ? v.reason : null,
    source_mailbox: c.mailbox,
    source_ids: [c.key],
    source_link: c.link || null,
    email_count: 1,
    details: { ...out, from: c.from, subject: c.subject, received: c.receivedDate, rule: v.reason },
  }
}

/** Merge a reminder onto its row: fill blanks, count it, and flag real changes once. */
function mergeRow(existing, cand) {
  const patch = { last_seen_at: isoNow(), updated_at: isoNow(), email_count: (existing.email_count || 1) + 1, details: cand.details }
  if (!existing.source_ids?.includes(cand.source_ids[0])) patch.source_ids = [...(existing.source_ids || []), cand.source_ids[0]]
  for (const f of ["start_time", "end_time", "venue", "address", "city", "cost", "rsvp_url", "why", "organizer"]) if (!existing[f] && cand[f]) patch[f] = cand[f]
  // A later email that states a different time/venue is a real change; a longer name is not.
  for (const f of ["start_time", "venue", "address"]) if (existing[f] && cand[f] && String(existing[f]).toLowerCase() !== String(cand[f]).toLowerCase()) patch[f] = cand[f]
  const merged = { ...existing, ...patch }
  const hash = detailsHash(merged)
  if (hash !== existing.details_hash) {
    patch.details_hash = hash
    if (existing.status !== "new" && existing.details_hash) patch.details_changed = true
  }
  return patch
}

async function upsertEvent(c, out, v, dry) {
  const cand = rowFrom(c, out, v)
  if (dry) {
    console.log(`  WOULD RECORD [${v.verdict}] ${cand.event_date} ${cand.start_time || "??:??"} · ${cand.name} · ${cand.venue || "?"} (${cand.city || "?"}) · ${cand.organizer_family} · ${v.reason}`)
    return { action: "dry", cand }
  }
  const { data: sameDay, error } = await sb().from("inbox_events").select("*").eq("event_date", cand.event_date)
  if (error) throw new Error(`inbox_events read: ${error.message}`)
  const hit = matchEvent(sameDay || [], cand)
  if (hit) {
    const patch = mergeRow(hit, cand)
    const { error: e2 } = await sb().from("inbox_events").update(patch).eq("id", hit.id)
    if (e2) throw new Error(`inbox_events update: ${e2.message}`)
    log(`event: reminder #${patch.email_count} for “${hit.name}” (${hit.event_date}, ${hit.status})${patch.details_changed ? " — details changed" : ""}`)
    return { action: "merged", id: hit.id }
  }
  cand.details_hash = detailsHash(cand)
  const { data: ins, error: e3 } = await sb().from("inbox_events").insert(cand).select("id").single()
  if (e3) throw new Error(`inbox_events insert: ${e3.message}`)
  log(`event: NEW [${v.verdict}] ${cand.event_date} ${cand.start_time || "??:??"} “${cand.name}” · ${cand.venue || cand.city || "?"} · ${v.reason}`)
  return { action: "inserted", id: ins.id }
}

async function handleCandidate(c, dry) {
  if (unreadable(c.text) && !(c.images || []).length) {
    log(`event: skip (image-only email, nothing to read) · ${c.from.slice(0, 30)} · ${String(c.subject).slice(0, 50)}`)
    if (dry) console.log(`  skip (image-only email) ← ${c.receivedDate} ${c.from.slice(0, 35)} · ${String(c.subject).slice(0, 60)}`)
    return { skip: "image-only" }
  }
  const { out, v } = await classifyCandidate(c)
  if (v.verdict === "skip") {
    log(`event: skip (${v.reason}) · ${c.from.slice(0, 30)} · ${String(c.subject).slice(0, 50)}`)
    if (dry) console.log(`  skip (${v.reason}) ← ${c.receivedDate} ${c.from.slice(0, 35)} · ${String(c.subject).slice(0, 60)}`)
    return { skip: v.reason }
  }
  return upsertEvent(c, out, v, dry)
}

// ------------------------------------------------------------------ sources
// Gmail searches the whole body; the metadata snippet is ~200 chars. Mail whose only hint
// is deep in the body (a newsletter with one mixer in it) is a candidate through this query.
const GMAIL_HINT_QUERY = `(mixer OR mixers OR "happy hour" OR networking OR soiree OR soirée OR rsvp OR "you're invited" OR "join us" OR meetup OR "save the date" OR "client appreciation" OR "holiday party")`

async function scanGmail(gmail, { days, seen, dry, budget, only = null }) {
  const base = `newer_than:${days}d -from:${MAILBOX} -in:sent -in:chats -in:drafts`
  const ids = only ? [only] : await listMessageIds(gmail, base, Math.min(3000, Math.max(800, days * 100)))
  const hinted = new Set(only ? [] : await listMessageIds(gmail, `${base} ${GMAIL_HINT_QUERY}`, 1000).catch(() => []))
  const fresh = ids.filter((id) => !seen[`g:${id}`]).reverse()
  const stats = { listed: ids.length, fresh: fresh.length, candidates: 0 }
  for (const id of fresh) {
    if (budget.left <= 0) break
    let meta
    try {
      const { data } = await gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "Subject"] })
      const h = (n) => (data.payload?.headers || []).find((x) => x.name?.toLowerCase() === n)?.value || ""
      meta = { from: h("from"), subject: h("subject"), snippet: data.snippet || "", internalDate: data.internalDate ? new Date(Number(data.internalDate)).toISOString() : isoNow() }
    } catch (e) {
      warn(`event: gmail meta ${id} failed:`, e.message)
      continue
    }
    const pf = only ? { candidate: true } : prefilter(meta)
    seen[`g:${id}`] = isoNow()
    if (!pf.candidate && !(hinted.has(id) && !pf.skip)) continue
    stats.candidates++
    budget.left--
    try {
      const m = await getMessage(gmail, id)
      const text = squeeze(m.text)
      const images = unreadable(text) ? await flyerImages(gmail, id, m) : []
      await handleCandidate({ mailbox: MAILBOX, key: `g:${id}`, from: `${m.from.name} <${m.from.email}>`, subject: m.subject, text, images, receivedDate: dayOf(m.internalDate), link: gmailLink(id) }, dry)
    } catch (e) {
      warn(`event: gmail ${id} failed:`, e.stack || e.message)
      delete seen[`g:${id}`] // try again next pass
    }
  }
  return stats
}

/** A flyer-only email: the content is in an attached or hosted image. Up to 2 images, >20 KB, ≤5 MB. */
async function flyerImages(gmail, id, m) {
  const images = []
  for (const a of (m.attachments || []).filter((x) => /^image\/(png|jpe?g|webp|gif)$/i.test(x.mime) && x.size > 20_000).slice(0, 2)) {
    try {
      images.push({ data: await getAttachmentBytes(gmail, id, a.attachmentId), mime: a.mime, filename: a.filename })
    } catch (e) {
      warn(`event: image ${a.filename} on ${id} failed:`, e.message)
    }
  }
  if (images.length) return images
  const tags = [...String(m.html || "").matchAll(/<img\b[^>]*>/gi)].map((x) => x[0]).filter((t) => !/\b(width|height)=["']?1["']?/i.test(t))
  for (const t of tags) {
    const src = /\bsrc=["']([^"']+)["']/i.exec(t)?.[1]
    if (!src || !/^https?:\/\//i.test(src)) continue
    try {
      const res = await fetch(src, { signal: AbortSignal.timeout(10_000), redirect: "follow" })
      const mime = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase()
      if (!res.ok || !/^image\/(png|jpe?g|webp|gif)$/.test(mime)) continue
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 20_000 || buf.length > 5 * 1024 * 1024) continue
      images.push({ data: buf, mime, filename: src.split("/").pop() })
      if (images.length >= 2) break
    } catch (e) {
      warn(`event: hosted image on ${id} failed:`, e.message)
    }
  }
  return images
}

function findTextPart(node) {
  const parts = []
  ;(function walk(n) {
    if (!n) return
    if (n.type && /^text\/(plain|html)$/i.test(n.type)) parts.push(n)
    for (const c of n.childNodes || []) walk(c)
  })(node)
  return parts.find((p) => /html/i.test(p.type)) || parts[0] || null
}
async function imapText(client, uid) {
  const msg = await client.fetchOne(String(uid), { bodyStructure: true }, { uid: true })
  const part = findTextPart(msg?.bodyStructure)
  const { content } = await client.download(String(uid), part?.part || undefined, { uid: true })
  const chunks = []
  for await (const ch of content) chunks.push(ch)
  const raw = Buffer.concat(chunks).toString("utf-8")
  return squeeze(part && /html/i.test(part.type) ? htmlToText(raw) : raw)
}

async function scanPersonal({ days, seen, dry, budget }) {
  if (!PERSONAL_USER || !PERSONAL_PASS) return { skipped: "no PILE_GMAIL_IMAP_* creds" }
  const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user: PERSONAL_USER, pass: PERSONAL_PASS }, logger: false })
  const stats = { listed: 0, fresh: 0, candidates: 0 }
  await client.connect()
  const lock = await client.getMailboxLock("[Gmail]/All Mail")
  try {
    const since = new Date(Date.now() - days * 86_400_000)
    const uids = await client.search({ since }, { uid: true })
    stats.listed = uids.length
    const fresh = uids.filter((u) => !seen[`p:${u}`]).sort((a, b) => a - b)
    stats.fresh = fresh.length
    if (!fresh.length) return stats
    const envelopes = []
    for await (const m of client.fetch(fresh, { envelope: true, uid: true }, { uid: true })) envelopes.push(m)
    for (const m of envelopes) {
      const fromAddr = m.envelope?.from?.[0]
      if (!fromAddr || String(fromAddr.address).toLowerCase() === PERSONAL_USER.toLowerCase()) {
        seen[`p:${m.uid}`] = isoNow()
        continue
      }
      const from = `${fromAddr.name || ""} <${fromAddr.address || ""}>`
      const subject = m.envelope?.subject || ""
      const pf = prefilter({ from, subject })
      seen[`p:${m.uid}`] = isoNow()
      if (!pf.candidate) continue
      if (budget.left <= 0) {
        delete seen[`p:${m.uid}`]
        continue
      }
      stats.candidates++
      budget.left--
      try {
        const text = await imapText(client, m.uid)
        await handleCandidate({ mailbox: PERSONAL_USER, key: `p:${m.uid}`, from, subject, text, receivedDate: dayOf(m.envelope?.date?.toISOString?.() || isoNow()), link: personalLink(m.envelope?.messageId) }, dry)
      } catch (e) {
        warn(`event: imap ${m.uid} failed:`, e.stack || e.message)
        delete seen[`p:${m.uid}`]
      }
    }
  } finally {
    lock.release()
    await client.logout().catch(() => {})
  }
  return stats
}

/** Every pass. `backfillDays` widens the window (first run / testing). */
export async function scanEvents(ctx, { dry = false, backfillDays = null, sources = "all", only = null } = {}) {
  const { seen } = await loadSeen()
  const days = Math.max(2, backfillDays || 2)
  const budget = { left: dry ? 400 : MAX_CANDIDATES_PER_PASS }
  const t0 = Date.now()
  const g = sources === "personal" ? { skipped: "sources=personal" } : await scanGmail(ctx.gmail, { days, seen, dry, budget, only }).catch((e) => (warn("event: gmail scan failed:", e.message), { error: e.message }))
  const p = sources === "gmail" || only ? { skipped: only ? "single message" : "sources=gmail" } : await scanPersonal({ days, seen, dry, budget }).catch((e) => (warn("event: personal scan failed:", e.message), { error: e.message }))
  if (!dry) await setSetting("events", { seen, last_scan_at: isoNow() })
  log(`events: ryan@ ${JSON.stringify(g)} · personal ${JSON.stringify(p)} · ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  return { gmail: g, personal: p }
}

// ------------------------------------------------------------------ gog (calendar on the mini)
function gog(args) {
  return new Promise((resolve) => {
    const child = spawn(GOG, ["-a", CAL_ACCOUNT, ...args], { env: { ...process.env, HOME: process.env.HOME || "/Users/ryanlarocca" } })
    let stdout = "", stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("close", (code) => resolve({ code, stdout, stderr }))
    child.on("error", (e) => resolve({ code: -1, stdout, stderr: String(e.message) }))
  })
}
export async function listCalendar(fromDate, toDate) {
  const out = await gog(["calendar", "events", "primary", "--from", fromDate, "--to", toDate, "--all-pages", "--json"])
  if (out.code !== 0) throw new Error(`gog events: ${(out.stderr || out.stdout).trim().slice(0, 200)}`)
  const j = JSON.parse(out.stdout || "{}")
  return j.events || (Array.isArray(j) ? j : [])
}
export async function createCalendarEvent(ev) {
  const w = calendarWindow(ev)
  const args = ["calendar", "create", "primary", "--summary", calendarSummary(ev), "--from", w.from, "--to", w.to, "--description", calendarDescription(ev) + (w.assumedTime ? "\n(Time not in the email — 6 PM assumed, check the RSVP page.)" : ""), "--reminder", "popup:60m", "--json"]
  if (ev.venue || ev.address) args.push("--location", [ev.venue, ev.address, !ev.address ? ev.city : null].filter(Boolean).join(", "))
  if (ev.rsvp_url) args.push("--source-url", ev.rsvp_url, "--source-title", "RSVP")
  const out = await gog(args)
  if (out.code !== 0) throw new Error((out.stderr || out.stdout || "gog failed").trim().slice(0, 300))
  let j = {}
  try {
    j = JSON.parse(out.stdout)
  } catch {}
  const e = j.event || j
  return { id: e.id || null, htmlLink: e.htmlLink || null, assumedTime: w.assumedTime }
}

/** Every pass: Ryan tapped 📅 → create it, confirm on the card's thread. */
export async function applyEventDecisions({ dry = false } = {}) {
  const { data: rows } = await sb().from("inbox_events").select("*").eq("status", "add_requested").order("updated_at").limit(10)
  for (const ev of rows || []) {
    try {
      const r = await createCalendarEvent(ev)
      if (!dry) await sb().from("inbox_events").update({ status: "added", calendar_event_id: r.id, calendar_link: r.htmlLink, resolved_at: isoNow(), updated_at: isoNow() }).eq("id", ev.id)
      await tgSend(`📅 Added <b>${esc(ev.name)}</b> — ${esc(fmtWhenSafe(ev))}${r.assumedTime ? " (no time in the email, 6 PM assumed)" : ""}${r.htmlLink ? `\n<a href="${r.htmlLink}">open in Calendar</a>` : ""}`, { replyTo: ev.tg_message_id, dryRun: dry })
    } catch (e) {
      warn(`event: calendar add ${ev.id} failed:`, e.message)
      if (!dry) await sb().from("inbox_events").update({ status: "alerted", updated_at: isoNow() }).eq("id", ev.id)
      await tgSend(`⚠️ Couldn't add <b>${esc(ev.name)}</b> to the calendar — ${esc(e.message)}. Tap 📅 again to retry.`, { replyTo: ev.tg_message_id, dryRun: dry })
    }
  }
}
function fmtWhenSafe(ev) {
  try {
    return cardText(ev).split("\n")[1] || ev.event_date
  } catch {
    return ev.event_date
  }
}

// ------------------------------------------------------------------ the brief
/** Builds the section + decides which rows get cards. Marks already-on-calendar rows. */
export async function eventBrief({ dry = false } = {}) {
  const today = ptParts().date
  const { data: fresh } = await sb().from("inbox_events").select("*").eq("status", "new").gte("event_date", today).order("event_date").order("start_time")
  const { data: changed } = await sb().from("inbox_events").select("*").eq("details_changed", true).in("status", ["alerted", "acknowledged", "added"]).gte("event_date", today)
  // Events that slipped into the past before ever being shown: close them quietly.
  if (!dry) await sb().from("inbox_events").update({ status: "acknowledged", resolved_at: isoNow(), updated_at: isoNow() }).eq("status", "new").lt("event_date", today)
  const newRows = [], onCalendar = []
  if (fresh?.length) {
    let cal = []
    try {
      const to = new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10)
      cal = await listCalendar(today, to)
    } catch (e) {
      warn("event: calendar check skipped:", e.message)
    }
    for (const ev of fresh) {
      const hit = calendarMatches(ev, cal)
      if (hit) {
        onCalendar.push(ev)
        if (!dry) await sb().from("inbox_events").update({ status: "acknowledged", on_calendar: true, calendar_event_id: hit.id || null, calendar_link: hit.htmlLink || null, resolved_at: isoNow(), updated_at: isoNow() }).eq("id", ev.id)
      } else newRows.push(ev)
    }
  }
  if (changed?.length && !dry) await sb().from("inbox_events").update({ details_changed: false, updated_at: isoNow() }).in("id", changed.map((c) => c.id))
  return { lines: briefLines({ fresh: newRows, onCalendar, changed: changed || [] }), newRows }
}

/** After the brief: one card per new event. */
export async function postEventCards(rows, dry = false) {
  for (const ev of rows || []) {
    const mid = await tgSend(cardText(ev), { rows: cardButtons(ev), dryRun: dry })
    if (!dry) await sb().from("inbox_events").update({ status: "alerted", tg_message_id: mid, alerted_at: isoNow(), updated_at: isoNow() }).eq("id", ev.id)
  }
}
