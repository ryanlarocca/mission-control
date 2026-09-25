#!/usr/bin/env node
// Inbox Agent — the Mac mini worker (briefs/BRIEF_INBOX_AGENT_2026-09-24.md).
//
// Every pass (launchd, 5 min):
//   1. applyDecisions  — Ryan's taps/replies (recorded by the Vercel webhook via
//                        lib/inboxAgent.ts) → upload to Drive, learn rules,
//                        regenerate the convention doc.
//   2. pollInbox       — new mail on ryan@lrghomes.com → classify (Haiku) →
//                        attachment proposals / open loops / deal screens.
//   3. resolveLoops    — close loops Ryan answered (sent mail) or that expired.
//   4. interviewStep   — before any filing: ask Ryan one document at a time
//                        where it goes, then write + approve the convention.
//   5. maybeDigest     — 7:30am PT daily brief.
//
// Phase 1 is read-only on Gmail except adding an "MC/Filed" label. It never
// sends email.
//
//   node scripts/inbox-agent/index.mjs                # one pass
//   node scripts/inbox-agent/index.mjs --interview    # seed the Drive interview from the sample set
//   node scripts/inbox-agent/index.mjs --backfill=3d  # also look at the last 3 days on first run
//   node scripts/inbox-agent/index.mjs --digest-now   # force the daily digest
//   node scripts/inbox-agent/index.mjs --drive-check  # prove the Drive share + DWD scope
//   node scripts/inbox-agent/index.mjs --status       # counts
//   node scripts/inbox-agent/index.mjs --pause | --resume
//   flags: --dry-run (no Telegram, no Drive writes, no DB writes for new rows), --limit=N
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import {
  AUTO_THRESHOLD, MAILBOX, MAIN_CHECKOUT, MAX_ATTACHMENT_BYTES, REPO_ROOT,
  daysAgo, fetchAll, getSetting, keysMatch, log, propertyKey, ptDateLabel, ptParts, sanitizeFilename, sb, setSetting, warn,
} from "./env.mjs"
import { addLabel, getAttachmentBytes, getMessage, gmailClient, listMessageIds, sentThreadsSince } from "./gmail.mjs"
import { driveClient, findFileByName, findRoot, folderTree, moveFile, propertyFolders, resolvePath, uploadFile } from "./drive.mjs"
import { esc, tgClearButtons, tgSend, tgSendDocument } from "./telegram.mjs"
import {
  CLASSIFY_SYSTEM, FILING_SYSTEM, HAIKU, RULES_SYSTEM, SCREEN_SYSTEM, SONNET,
  changePrompt, classifyPrompt, complete, completeJson, filingPrompt, rulesPrompt, screenPrompt,
} from "./llm.mjs"

// ------------------------------------------------------------------ args
const argv = process.argv.slice(2)
const flag = (n) => argv.includes(`--${n}`)
const opt = (n, d) => {
  const a = argv.find((x) => x.startsWith(`--${n}=`))
  return a ? a.slice(n.length + 3) : d
}
const DRY = flag("dry-run")
const LIMIT = Number(opt("limit", 25))
const BACKFILL = opt("backfill", null) // e.g. "3d"

// The interview set — real emails from the 2026-09-24 survey of ryan@'s inbox,
// one per document type Ryan sees every week. Re-seeding is idempotent.
const INTERVIEW_SET = [
  "1a0bbf48f68a534d", // Victor Parra — "93 Ridgeview Ave Addendum A Signed" (signed addendum)
  "1a0caac66456956e", // Lisa Nunes / Chicago Title via Zix — "Seller revised net for Ridgeview Ave" (net sheet)
  "1a0d406b2d3a864c", // DocuSign — "Completed: 2116 Quito Rd - OFFER" (signed RPA)
  "1a0b0256b385eb55", // Obie — bound policy + invoice, 5764 Halleck (evidence of insurance)
  "1a05d91e8bc00a12", // Michelle Santiago — prelim title report, 5764 Halleck
  "1a082f6b0998128c", // Ricci Rios via Zix — Final Sellers Statement + 1099-S, 674 Kirkland
  "1a0d640b0830cd97", // Kirk Jackson / Wyrick — Reed Street OMs (direct lead)
  "1a0c7003293e7c14", // Chris Sabido — 1050 High Rd flyer (broker blast)
  "1a0b05bd0a00aa82", // Jim Morelan — cost estimate + sprinkler proposal (contractor bids)
]

// Last-known tree (2026-09-24 survey) so the interview can run before the
// Drive share/scope setup is done. Replaced by the live tree once Drive works.
const FALLBACK_TREE = `Business Operations/
  Finance/  (Chase statements: "Chase March2026.pdf")
  LLC Paperwork/  ("LRG Homes LLC - EIN Assigment Letter.pdf")
  Properties/
    2025/
      1958 Limewood Dr/  ("1958 Limewood Dr Sellers Statement.pdf", "1958 Limewood Buyers Statement.pdf")
      674 Kirkland Dr/
        Expenses/
        Purchase and Sale files/
        Tenants/
        Apartments.com Rental Rent Roll.pdf
    93 Ridgeview/  ("[RLA] Residential Listing Agreement.pdf", "[COL] Cancellation of Listing.pdf", "[CC] Cancellation of Contract, Release of Deposit and Cancellation of Escrow.pdf", "[MT-LA] Modification of Terms, Listing Agreement (1).pdf", "XO Staging Agreement 2024.pdf", Photos - Copy/)
    Halleck/  ("California Residential Purchase Agreement - 626.pdf")
    Old/
      2021/
      2022/  (1430 Jeffrey ave/, "722 Gleneagle Buyers Statement.pdf", "722 Gleneagle Sellers Statement.pdf")
      141 Sobrante Ct/
      1810 Ednamary/
      2355 Sunrise Drive/
      407-411 Lyon St/
      829 Wilmington Ave San Mateo/
  Taxes/
    2021/ 2022/ 2023/ 2024/ 2025/  ("2025 Tax Return Documents (LRG HOMES LLC).pdf")`

const AUTOMATED_RE = /(^|[.@-])(dmarc|mailer-daemon|postmaster|noreply-dmarc|calendar-notification|drive-shares-noreply|no-?reply@(google|accounts|youtube|linkedin|zillow|redfin)|notification\.intuit|quickbooks@)/i

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex")
}
function domainOf(email) {
  const d = String(email || "").split("@")[1] || ""
  return /^(gmail|yahoo|hotmail|outlook|icloud|aol|comcast|me)\.com$/i.test(d) ? String(email).toLowerCase() : d.toLowerCase()
}
function isoNow() {
  return new Date().toISOString()
}
function shortSubject(s, n = 70) {
  const t = String(s || "").replace(/\s+/g, " ").trim()
  return t.length > n ? t.slice(0, n - 1) + "…" : t
}
function extOf(name) {
  const m = /\.([a-z0-9]{1,6})$/i.exec(name || "")
  return m ? m[1].toLowerCase() : ""
}
// Quiet hours (default 9pm–7am PT): only high-priority loops and direct
// deals post; everything else is held as pending_post and released after 7.
let QUIET = { start: 21, end: 7 }
function isQuiet() {
  const { hour } = ptParts()
  return QUIET.start > QUIET.end ? hour >= QUIET.start || hour < QUIET.end : hour >= QUIET.start && hour < QUIET.end
}
// Broker-blast first cut: Santa Clara County, 2+ units, per-door not clearly
// above the ladder. Ryan's 👀/🚫 taps on past blasts calibrate the model.
const SCC_CITIES = /san jose|sunnyvale|milpitas|campbell|santa clara|cupertino|mountain view|los gatos|saratoga|morgan hill|gilroy|palo alto|los altos|willow glen|alum rock/i
const PER_DOOR_CEILING = { downtown: 230000, milpitas: 340000, sunnyvale: 400000, default: 400000 }
function blastPassesCut(out, cls) {
  const facts = out.facts || {}
  const addr = `${out.address || ""} ${cls.deal?.address || ""}`
  const units = Number(facts.units) || Number(cls.deal?.units) || 0
  if (!SCC_CITIES.test(addr)) return { ok: false, why: "outside Santa Clara County" }
  if (units && units < 2) return { ok: false, why: "single unit" }
  const ppd = Number(String(facts.price_per_door || "").replace(/[$,]/g, ""))
  const ceiling = /downtown|95112|95110|95113|95126|95116/i.test(addr) ? PER_DOOR_CEILING.downtown : /milpitas/i.test(addr) ? PER_DOOR_CEILING.milpitas : PER_DOOR_CEILING.default
  if (ppd && ppd > ceiling * 1.15) return { ok: false, why: `$${Math.round(ppd).toLocaleString()}/door is above the ladder` }
  if (out.verdict === "pass" && ppd && ppd > ceiling) return { ok: false, why: "model pass + above ladder" }
  return { ok: true, why: out.verdict === "look_further" ? "worth a look" : "under the ladder" }
}

// ------------------------------------------------------------------ context
async function buildContext() {
  const ctx = { gmail: null, drive: null, rootId: null, driveErr: null, tree: null, propFolders: [], rules: null, rulesMd: null }
  ctx.gmail = await gmailClient()
  try {
    ctx.drive = await driveClient()
    ctx.rootId = await findRoot(ctx.drive)
  } catch (e) {
    ctx.driveErr = e?.response?.data?.error_description || e?.response?.data?.error?.message || e.message
    warn("drive unavailable:", ctx.driveErr)
  }
  return ctx
}

async function loadTree(ctx) {
  if (ctx.tree) return ctx.tree
  if (ctx.drive && ctx.rootId) {
    try {
      ctx.tree = await folderTree(ctx.drive, ctx.rootId)
      ctx.propFolders = await propertyFolders(ctx.drive, ctx.rootId)
      await setSetting("drive", { tree_cache: ctx.tree, tree_at: isoNow() })
      return ctx.tree
    } catch (e) {
      warn("folderTree failed:", e.message)
    }
  }
  const s = await getSetting("drive")
  ctx.tree = s.tree_cache || FALLBACK_TREE
  ctx.propFolders = parseFoldersFromTree(ctx.tree)
  return ctx.tree
}
function parseFoldersFromTree(tree) {
  const out = []
  let inProps = false
  let bucket = null
  for (const raw of tree.split("\n")) {
    const indent = raw.search(/\S/)
    const line = raw.trim()
    if (/^Properties\/$/.test(line)) {
      inProps = true
      continue
    }
    if (!inProps) continue
    if (indent <= 2 && !/^Properties/.test(line)) break
    const m = /^([^/(]+?)\/(\s|$)/.exec(line)
    if (!m) continue
    const name = m[1].trim()
    if (indent === 4) {
      bucket = /^(19|20)\d{2}$|^old$/i.test(name) ? name : null
      out.push({ id: null, name, path: `Properties/${name}` })
    } else if (indent === 6 && bucket) {
      out.push({ id: null, name, path: `Properties/${bucket}/${name}` })
    }
  }
  return out
}
function propertyFolderFor(ctx, label) {
  const key = propertyKey(label)
  if (!key) return null
  const cands = ctx.propFolders.filter((f) => !/^(19|20)\d{2}$|^old$/i.test(f.name))
  return cands.find((f) => keysMatch(propertyKey(f.name), key)) || null
}

async function loadRules(ctx) {
  if (!ctx.rules) {
    ctx.rules = await fetchAll("inbox_rules", "*")
    const r = await getSetting("rules")
    ctx.rulesMd = r.status === "approved" ? r.md : null
    ctx.rulesStatus = r.status || "none"
  }
  return ctx.rules
}

async function hintsFor(ctx, senderEmail) {
  const { data: mine } = await sb().from("inbox_files").select("property_label").eq("sender", senderEmail).not("property_label", "is", null).limit(50)
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString()
  const { data: recent } = await sb().from("inbox_files").select("property_label").gte("created_at", since).not("property_label", "is", null).limit(200)
  await loadTree(ctx)
  return {
    senderProperties: [...new Set((mine || []).map((x) => x.property_label))],
    activeProperties: [...new Set((recent || []).map((x) => x.property_label))].slice(0, 12),
    propertyFolders: ctx.propFolders.map((f) => f.name),
  }
}

// ------------------------------------------------------------------ classify + record
async function classify(ctx, msg) {
  const attachments = msg.attachments.filter((a) => !a.inline || !/^image\//.test(a.mime))
  const hints = await hintsFor(ctx, msg.from.email)
  const out = await completeJson({ model: HAIKU, system: CLASSIFY_SYSTEM, prompt: classifyPrompt({ msg, attachments, hints }), maxTokens: 1800, tag: "[classify]" })
  return out
}

async function insertMessage(msg, kind, cls) {
  if (DRY) return
  const row = {
    gmail_id: msg.id,
    thread_id: msg.threadId,
    mailbox: MAILBOX,
    internal_date: msg.internalDate,
    sender: msg.from.email,
    sender_name: msg.from.name || null,
    subject: msg.subject,
    kind,
    classification: cls || null,
    attachment_count: msg.attachments.filter((a) => !a.inline).length,
  }
  const { error } = await sb().from("inbox_messages").upsert(row, { onConflict: "gmail_id" })
  if (error) throw new Error(`inbox_messages upsert: ${error.message}`)
}

function relevantAttachments(msg, cls) {
  const byName = new Map((cls?.attachments || []).map((a) => [a.filename, a]))
  const out = []
  for (const a of msg.attachments) {
    if (a.inline && /^image\//.test(a.mime)) continue
    if (/^image\//.test(a.mime) && (a.size || 0) < 40 * 1024) continue // signature logos
    if (/^(image\d{3}|~WRD\d+|front-composer-)/i.test(a.filename)) continue
    if ((a.size || 0) > MAX_ATTACHMENT_BYTES) continue
    const c = byName.get(a.filename)
    if (c && c.relevant === false) continue
    if (!c && !/\.(pdf|docx?|xlsx?|csv|zip|jpe?g|png)$/i.test(a.filename)) continue
    out.push({ ...a, doc_type: c?.doc_type || (/\.pdf$/i.test(a.filename) ? "other" : "photos"), description: c?.description || "", signed: c?.signed ?? null, property_label: c?.property_label || cls?.property?.label || null })
  }
  return out
}

/** Download, hash, dedupe, insert an inbox_files row. Returns {row, bytes} or null. */
async function recordAttachment(ctx, msg, att, cls, status) {
  const bytes = await getAttachmentBytes(ctx.gmail, msg.id, att.attachmentId)
  const hash = sha256(bytes)
  const { data: dup } = await sb().from("inbox_files").select("id, status, final_folder, final_name, proposed_folder, proposed_name").eq("sha256", hash).in("status", ["filed", "pending", "approved", "waiting", "interview", "changed", "change_requested"]).limit(1)
  const label = att.property_label || cls?.property?.label || null
  const row = {
    gmail_id: msg.id,
    thread_id: msg.threadId,
    attachment_id: att.attachmentId,
    part_id: att.partId,
    filename: att.filename,
    mime: att.mime,
    size_bytes: bytes.length,
    sha256: hash,
    sender: msg.from.email,
    subject: msg.subject,
    received_at: msg.internalDate,
    property_key: propertyKey(label),
    property_label: label,
    doc_type: att.doc_type,
    status: dup?.length ? "duplicate" : status,
  }
  if (DRY) return { row: { ...row, id: "dry-run" }, bytes, dup: dup?.[0] || null }
  const { data, error } = await sb().from("inbox_files").insert(row).select("*").single()
  if (error) throw new Error(`inbox_files insert: ${error.message}`)
  return { row: data, bytes, dup: dup?.[0] || null }
}

// ------------------------------------------------------------------ filing proposals
async function proposeFor(ctx, row, bytes, cls) {
  await loadRules(ctx)
  await loadTree(ctx)
  const pf = propertyFolderFor(ctx, row.property_label)
  const docs = []
  if (!row.property_label && bytes && /^application\/pdf$/.test(row.mime || "")) docs.push({ kind: "pdf", data: bytes, mime: row.mime, name: row.filename })
  const file = { ...row, description: cls?.attachments?.find((a) => a.filename === row.filename)?.description, property_address: cls?.property?.address }
  const out = await completeJson({ model: HAIKU, system: FILING_SYSTEM, prompt: filingPrompt({ rulesMd: ctx.rulesMd, rules: ctx.rules, tree: ctx.tree, file, propertyFolder: pf }), docs, maxTokens: 500, tag: "[propose]" })
  if (!out?.folder || !out?.name) return null
  const rule = out.rule_id ? ctx.rules.find((r) => r.id.startsWith(String(out.rule_id).slice(0, 8))) : null
  let name = sanitizeFilename(out.name)
  if (!extOf(name) && extOf(row.filename)) name += `.${extOf(row.filename)}`
  return { folder: String(out.folder).replace(/^\/+|\/+$/g, ""), name, rule, confidence: Number(out.confidence) || null, reason: out.reason || "" }
}

function proposalText(row, p, { auto = false } = {}) {
  const who = row.sender_name ? `${row.sender_name}` : row.sender
  const ruleNote = p.rule ? ` · rule ${p.rule.approvals_in_row}/${AUTO_THRESHOLD}` : ""
  return [
    `${auto ? "🤖 <b>Filed automatically</b>" : "📎"} <b>${esc(row.filename)}</b>`,
    `From ${esc(who)} · ${ptDateLabel(row.received_at)} · “${esc(shortSubject(row.subject))}”`,
    `${esc(row.doc_type?.replace(/_/g, " ") || "document")}${row.property_label ? ` · ${esc(row.property_label)}` : " · property unknown"}`,
    `→ <b>${esc(p.folder)}/</b>${esc(p.name)}${ruleNote}`,
    p.reason && !auto ? `<i>${esc(p.reason)}</i>` : "",
  ].filter(Boolean).join("\n")
}

async function postProposal(ctx, row, p) {
  if (isQuiet()) {
    if (!DRY) await sb().from("inbox_files").update({ proposed_folder: p.folder, proposed_name: p.name, rule_id: p.rule?.id || null, confidence: p.confidence, status: "pending_post", mode: "training" }).eq("id", row.id)
    return
  }
  const rows = [[{ text: "✅ Approve", data: `ix:fa:${row.id}` }, { text: "✏️ Change", data: `ix:fc:${row.id}` }, { text: "⏭ Skip", data: `ix:fs:${row.id}` }]]
  const mid = await tgSend(proposalText(row, p), { rows, dryRun: DRY })
  if (!DRY) {
    await sb().from("inbox_files").update({ proposed_folder: p.folder, proposed_name: p.name, rule_id: p.rule?.id || null, confidence: p.confidence, status: "pending", tg_message_id: mid, mode: "training" }).eq("id", row.id)
  }
}

/** Several attachments on one email → one card. Rows keep status "batch" and share the card's message id. */
async function postBatch(ctx, msg, items) {
  if (isQuiet()) {
    if (!DRY) for (const it of items) await sb().from("inbox_files").update({ proposed_folder: it.p.folder, proposed_name: it.p.name, rule_id: it.p.rule?.id || null, confidence: it.p.confidence, status: "pending_post" }).eq("id", it.row.id)
    return
  }
  const who = msg.from.name || msg.from.email
  const lines = [`📎 <b>${items.length} attachments</b> from ${esc(who)} · ${ptDateLabel(msg.internalDate)} · “${esc(shortSubject(msg.subject))}”`]
  for (const it of items) lines.push(`• ${esc(it.row.filename)} → <b>${esc(it.p.folder)}/</b>${esc(it.p.name)}`)
  lines.push("Reply to this card with a correction to apply it to all of them.")
  const rows = [[{ text: `✅ Approve all ${items.length}`, data: `ix:ba:${msg.id}` }], [{ text: "🗂 Pick individually", data: `ix:bp:${msg.id}` }, { text: "⏭ Skip all", data: `ix:bs:${msg.id}` }]]
  const mid = await tgSend(lines.join("\n"), { rows, dryRun: DRY })
  if (!DRY) for (const it of items) await sb().from("inbox_files").update({ proposed_folder: it.p.folder, proposed_name: it.p.name, rule_id: it.p.rule?.id || null, confidence: it.p.confidence, status: "batch", tg_message_id: mid, mode: "training" }).eq("id", it.row.id)
}

/** Release cards held by quiet hours or split out of a batch. */
async function postDeferred(ctx) {
  if (isQuiet()) return
  const { data: files } = await sb().from("inbox_files").select("*").eq("status", "pending_post").order("received_at").limit(15)
  for (const row of files || []) {
    if (row.proposed_folder && row.proposed_name) {
      const rows = [[{ text: "✅ Approve", data: `ix:fa:${row.id}` }, { text: "✏️ Change", data: `ix:fc:${row.id}` }, { text: "⏭ Skip", data: `ix:fs:${row.id}` }]]
      const mid = await tgSend(proposalText(row, { folder: row.proposed_folder, name: row.proposed_name, rule: null, reason: "" }), { rows, dryRun: DRY })
      if (!DRY) await sb().from("inbox_files").update({ status: "pending", tg_message_id: mid }).eq("id", row.id)
    } else {
      const { data: m } = await sb().from("inbox_messages").select("classification").eq("gmail_id", row.gmail_id).maybeSingle()
      const p = await proposeFor(ctx, row, null, m?.classification)
      if (p) await postProposal(ctx, row, p)
    }
  }
  const { data: screens } = await sb().from("inbox_deal_screens").select("*").is("tg_message_id", null).filter("facts->>post_pending", "eq", "true").limit(10)
  for (const scr of screens || []) {
    const lines = scr.facts?.card_lines || []
    if (!lines.length) continue
    const mid = await tgSend(lines.join("\n"), { rows: [[{ text: "👀 Look further", data: `ix:sl:${scr.id}` }, { text: "🚫 Pass", data: `ix:sp:${scr.id}` }]], dryRun: DRY })
    if (!DRY) await sb().from("inbox_deal_screens").update({ tg_message_id: mid, facts: { ...scr.facts, post_pending: false } }).eq("id", scr.id)
  }
}

/** Upload one file (bytes re-fetched from Gmail). Returns {ok, url, error}. */
async function fileToDrive(ctx, row, folder, name) {
  if (!ctx.drive || !ctx.rootId) return { ok: false, error: `Drive not available — ${ctx.driveErr || "setup incomplete"}` }
  try {
    const bytes = await getAttachmentBytes(ctx.gmail, row.gmail_id, row.attachment_id)
    if (sha256(bytes) !== row.sha256) warn(`hash changed for ${row.filename}`)
    const { id: folderId, created } = await resolvePath(ctx.drive, ctx.rootId, folder, { create: !DRY })
    if (!folderId) return { ok: false, error: `folder ${folder} missing (dry run)` }
    const existing = await findFileByName(ctx.drive, folderId, name)
    if (existing) {
      if (!DRY) await sb().from("inbox_files").update({ status: "duplicate", final_folder: folder, final_name: name, drive_file_id: existing.id, drive_url: existing.webViewLink, resolved_at: isoNow() }).eq("id", row.id)
      return { ok: false, duplicate: true, url: existing.webViewLink, error: `“${name}” already exists in ${folder}` }
    }
    if (DRY) return { ok: true, url: "(dry run)", created }
    const up = await uploadFile(ctx.drive, folderId, name, row.mime, bytes)
    await sb().from("inbox_files").update({ status: "filed", final_folder: folder, final_name: name, drive_file_id: up.id, drive_folder_id: folderId, drive_url: up.webViewLink, filed_at: isoNow(), resolved_at: isoNow(), error: null }).eq("id", row.id)
    await addLabel(ctx.gmail, row.gmail_id, "MC/Filed")
    return { ok: true, url: up.webViewLink, created }
  } catch (e) {
    const error = e?.response?.data?.error?.message || e.message
    if (!DRY) await sb().from("inbox_files").update({ status: "error", error }).eq("id", row.id)
    return { ok: false, error }
  }
}

// ---- rules learned from approvals / corrections
function generalize(str, row, pf) {
  let s = String(str || "")
  const names = [pf?.name, row.property_label].filter(Boolean).sort((a, b) => b.length - a.length)
  for (const n of names) s = s.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), "{property}")
  s = s.replace(/\b20\d{2}-\d{2}-\d{2}\b/g, "{date}").replace(/\b\d{1,2}[-.]\d{1,2}[-.]\d{2,4}\b/g, "{date}")
  return s
}
async function learnRule(ctx, row, folder, name, { source, note }) {
  await loadRules(ctx)
  const pf = propertyFolderFor(ctx, row.property_label)
  const sender_domain = domainOf(row.sender)
  const folder_template = generalize(folder, row, pf)
  const filename_template = generalize(name, row, pf)
  const key = (r) => `${r.sender_domain}|${r.doc_type}|${r.property_key || ""}`
  const propertySpecific = !folder_template.includes("{property}")
  const candidate = { sender_domain, doc_type: row.doc_type, property_key: propertySpecific ? row.property_key : null }
  let rule = ctx.rules.find((r) => key(r) === key(candidate))
  const now = isoNow()
  if (DRY) return { rule, changed: false }
  if (rule) {
    const same = rule.folder_template === folder_template && rule.filename_template === filename_template
    const approvals = source === "approval" && same ? rule.approvals_in_row + 1 : 1
    const mode = approvals >= AUTO_THRESHOLD ? "auto" : rule.mode === "auto" && !same ? "manual" : rule.mode
    const patch = { folder_template, filename_template, approvals_in_row: approvals, mode, updated_at: now, last_used_at: now, note: note || rule.note, source: same ? rule.source : source }
    await sb().from("inbox_rules").update(patch).eq("id", rule.id)
    Object.assign(rule, patch)
    return { rule, becameAuto: mode === "auto" && approvals === AUTO_THRESHOLD }
  }
  const { data } = await sb().from("inbox_rules").insert({ ...candidate, folder_template, filename_template, approvals_in_row: 1, mode: "manual", source, note: note || null, last_used_at: now }).select("*").single()
  if (data) ctx.rules.push(data)
  return { rule: data, becameAuto: false }
}
function applyRule(rule, row, pf) {
  const prop = pf?.name || row.property_label || "_Unsorted"
  const date = (row.received_at || isoNow()).slice(0, 10)
  const fill = (t) => String(t).replace(/\{property\}/g, prop).replace(/\{date\}/g, date).replace(/\{doc_type\}/g, String(row.doc_type || "").replace(/_/g, " ")).replace(/\{original\}/g, row.filename)
  let name = sanitizeFilename(fill(rule.filename_template))
  if (!extOf(name) && extOf(row.filename)) name += `.${extOf(row.filename)}`
  return { folder: fill(rule.folder_template), name }
}

// ------------------------------------------------------------------ 1. decisions
async function applyDecisions(ctx) {
  const { data: approved } = await sb().from("inbox_files").select("*").eq("status", "approved").order("resolved_at").limit(20)
  for (const row of approved || []) {
    const folder = row.proposed_folder, name = row.proposed_name
    const r = await fileToDrive(ctx, row, folder, name)
    if (r.ok) {
      const learned = await learnRule(ctx, row, folder, name, { source: "approval" })
      const extra = learned.becameAuto ? `\n🤖 That pattern has ${AUTO_THRESHOLD} approvals in a row — I'll file it automatically from now on (tap ↩️ on any auto-filed one to go back to asking).` : ""
      await tgSend(`✅ Filed → <b>${esc(folder)}/</b>${esc(name)}${r.created?.length ? ` (new folder: ${esc(r.created.join("/"))})` : ""}\n<a href="${r.url}">open in Drive</a>${extra}`, { replyTo: row.tg_message_id, rows: [[{ text: "↩️ Undo", data: `ix:fu:${row.id}` }]], dryRun: DRY })
    } else {
      await tgSend(`⚠️ Couldn't file <b>${esc(name)}</b> — ${esc(r.error)}${r.duplicate ? ` · <a href="${r.url}">existing file</a>` : ""}`, { replyTo: row.tg_message_id, dryRun: DRY })
      if (!DRY && !r.duplicate) await sb().from("inbox_files").update({ status: ctx.drive ? "error" : "approved" }).eq("id", row.id)
    }
  }

  const { data: changed } = await sb().from("inbox_files").select("*").eq("status", "changed").order("resolved_at").limit(20)
  for (const row of changed || []) {
    await loadTree(ctx)
    const out = await completeJson({ model: HAIKU, prompt: changePrompt({ changeText: row.change_text, proposedFolder: row.proposed_folder, proposedName: row.proposed_name, tree: ctx.tree, filename: row.filename }), maxTokens: 400, tag: "[change]" })
    if (!out?.folder || !out?.name) {
      await tgSend(`⚠️ I couldn't turn “${esc(row.change_text)}” into a folder + name. Reply again with e.g. “Properties/Halleck/Prelim 5764 Halleck.pdf”.`, { replyTo: row.tg_message_id, dryRun: DRY })
      if (!DRY) await sb().from("inbox_files").update({ status: "change_requested" }).eq("id", row.id)
      continue
    }
    let name = sanitizeFilename(out.name)
    if (!extOf(name) && extOf(row.filename)) name += `.${extOf(row.filename)}`
    const folder = String(out.folder).replace(/^\/+|\/+$/g, "")
    const r = await fileToDrive(ctx, row, folder, name)
    if (r.ok) {
      await learnRule(ctx, row, folder, name, { source: "correction", note: out.generalize || row.change_text })
      await tgSend(`✅ Filed → <b>${esc(folder)}/</b>${esc(name)}\n<a href="${r.url}">open in Drive</a>\n<i>Remembered: ${esc(out.generalize || "this destination for that sender + doc type")}</i>`, { replyTo: row.tg_message_id, rows: [[{ text: "↩️ Undo", data: `ix:fu:${row.id}` }]], dryRun: DRY })
    } else {
      await tgSend(`⚠️ Couldn't file <b>${esc(name)}</b> — ${esc(r.error)}`, { replyTo: row.tg_message_id, dryRun: DRY })
      if (!DRY && !r.duplicate) await sb().from("inbox_files").update({ status: ctx.drive ? "error" : "changed" }).eq("id", row.id)
    }
  }

  // Undo (24h window enforced on the Vercel side): move to _Unsorted, unlearn.
  const { data: undos } = await sb().from("inbox_files").select("*").eq("status", "undo_requested").limit(10)
  for (const row of undos || []) {
    try {
      if (!ctx.drive || !ctx.rootId) throw new Error("Drive not available")
      const { id: unsorted } = await resolvePath(ctx.drive, ctx.rootId, "Properties/_Unsorted", { create: true })
      if (row.drive_file_id) await moveFile(ctx.drive, row.drive_file_id, unsorted)
      if (row.rule_id) {
        const { data: rule } = await sb().from("inbox_rules").select("*").eq("id", row.rule_id).maybeSingle()
        if (rule) {
          if (rule.approvals_in_row <= 1) await sb().from("inbox_rules").delete().eq("id", rule.id)
          else await sb().from("inbox_rules").update({ approvals_in_row: rule.approvals_in_row - 1, mode: "manual", updated_at: isoNow() }).eq("id", rule.id)
        }
      }
      await sb().from("inbox_files").update({ status: "undone", final_folder: "Properties/_Unsorted", resolved_at: isoNow() }).eq("id", row.id)
      await tgSend(`↩️ Moved <b>${esc(row.final_name)}</b> to Properties/_Unsorted and forgot the rule it taught. Reply to the original proposal with the right place if you want it filed.`, { replyTo: row.tg_message_id, dryRun: DRY })
    } catch (e) {
      await sb().from("inbox_files").update({ status: "filed", error: `undo failed: ${e.message}` }).eq("id", row.id)
      await tgSend(`⚠️ Couldn't undo ${esc(row.final_name)} — ${esc(e.message)}`, { replyTo: row.tg_message_id, dryRun: DRY })
    }
  }

  // Convention feedback → rewrite.
  const rules = await getSetting("rules")
  if (rules.status === "revise" && rules.feedback) await publishRules(ctx, { feedback: rules.feedback, previous: rules.md })

  // Files that waited for the convention: propose them once it's approved.
  if (rules.status === "approved") {
    const { data: waiting } = await sb().from("inbox_files").select("*").eq("status", "waiting").order("received_at").limit(10)
    for (const row of waiting || []) {
      const { data: m } = await sb().from("inbox_messages").select("classification").eq("gmail_id", row.gmail_id).maybeSingle()
      const p = await proposeFor(ctx, row, null, m?.classification)
      if (p) await routeProposal(ctx, row, p)
    }
  }
}

async function routeProposal(ctx, row, p) {
  const pf = propertyFolderFor(ctx, row.property_label)
  if (p.rule && p.rule.mode === "auto") {
    const dest = applyRule(p.rule, row, pf)
    const r = await fileToDrive(ctx, row, dest.folder, dest.name)
    if (r.ok) {
      if (!DRY) await sb().from("inbox_files").update({ proposed_folder: dest.folder, proposed_name: dest.name, rule_id: p.rule.id, mode: "auto" }).eq("id", row.id)
      await tgSend(proposalText({ ...row, proposed_folder: dest.folder }, { ...p, folder: dest.folder, name: dest.name }, { auto: true }) + `\n<a href="${r.url}">open in Drive</a>`, { rows: [[{ text: "↩️ Ask me next time", data: `ix:fm:${row.id}` }]], dryRun: DRY })
      return
    }
    warn("auto-file failed, falling back to proposal:", r.error)
  }
  await postProposal(ctx, row, p)
}

// ------------------------------------------------------------------ 2. poll
async function pollInbox(ctx) {
  const agent = await getSetting("agent")
  let watermark = agent.watermark
  if (!watermark) {
    watermark = BACKFILL ? new Date(Date.now() - parseDays(BACKFILL) * 86_400_000).toISOString() : isoNow()
    if (!DRY) await setSetting("agent", { watermark, started_at: isoNow() })
    log(`first run — watermark ${watermark}`)
  } else if (BACKFILL) {
    const back = new Date(Date.now() - parseDays(BACKFILL) * 86_400_000).toISOString()
    if (back < watermark) watermark = back
  }
  const windowDays = Math.max(2, BACKFILL ? parseDays(BACKFILL) : 2)
  const ids = await listMessageIds(ctx.gmail, `in:inbox newer_than:${windowDays}d -from:${MAILBOX}`, 300)
  const known = new Set()
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb().from("inbox_messages").select("gmail_id").in("gmail_id", ids.slice(i, i + 200))
    for (const r of data || []) known.add(r.gmail_id)
  }
  const fresh = ids.filter((id) => !known.has(id)).reverse() // oldest first
  log(`poll: ${ids.length} in window, ${fresh.length} new`)
  let handled = 0
  for (const id of fresh) {
    if (handled >= LIMIT) break
    let msg
    try {
      msg = await getMessage(ctx.gmail, id)
    } catch (e) {
      warn(`get ${id} failed:`, e.message)
      continue
    }
    if (msg.internalDate && msg.internalDate < watermark) {
      await insertMessage(msg, "skip", { reason: "before watermark" })
      continue
    }
    if (msg.from.email === MAILBOX || AUTOMATED_RE.test(msg.from.email) || AUTOMATED_RE.test(msg.subject)) {
      await insertMessage(msg, "automated", null)
      continue
    }
    handled++
    try {
      await handleMessage(ctx, msg)
    } catch (e) {
      warn(`handle ${id} failed:`, e.stack || e.message)
      await insertMessage(msg, "error", { error: e.message })
      await tgSend(`⚠️ Inbox agent choked on “${esc(shortSubject(msg.subject))}” from ${esc(msg.from.email)}: ${esc(e.message)}`, { dryRun: DRY })
    }
  }
}
function parseDays(s) {
  const m = /^(\d+)\s*(d|h)?$/i.exec(String(s))
  if (!m) return 2
  return m[2]?.toLowerCase() === "h" ? Number(m[1]) / 24 : Number(m[1])
}

async function handleMessage(ctx, msg) {
  const cls = await classify(ctx, msg)
  const kind = cls?.kind || "human"
  await insertMessage(msg, kind, cls)
  if (!cls) return
  log(`${msg.from.email} · ${shortSubject(msg.subject, 50)} → ${kind}${cls.property?.label ? ` · ${cls.property.label}` : ""}${cls.needs_reply ? " · needs reply" : ""}`)
  if (kind === "automated" || kind === "newsletter" || kind === "skip") return

  const rules = await getSetting("rules")
  const rulesApproved = rules.status === "approved"

  // --- attachments (3+ on one email → one batch card)
  const atts = relevantAttachments(msg, cls)
  const pdfDocs = []
  const batch = []
  for (const att of atts) {
    const rec = await recordAttachment(ctx, msg, att, cls, rulesApproved ? "pending" : "waiting")
    if (!rec) continue
    if (/^application\/pdf$/.test(att.mime)) pdfDocs.push({ kind: "pdf", data: rec.bytes, mime: att.mime, name: att.filename })
    if (rec.dup) {
      log(`duplicate: ${att.filename} (matches ${rec.dup.id})`)
      continue
    }
    if (!rulesApproved) continue
    const p = await proposeFor(ctx, rec.row, rec.bytes, cls)
    if (!p) {
      await tgSend(`⚠️ No filing proposal for <b>${esc(att.filename)}</b> (from ${esc(msg.from.email)}) — reply to this with folder + name if you want it filed.`, { dryRun: DRY })
      continue
    }
    if (atts.length >= 3 && !(p.rule && p.rule.mode === "auto")) batch.push({ row: rec.row, p })
    else await routeProposal(ctx, rec.row, p)
  }
  if (batch.length >= 2) await postBatch(ctx, msg, batch)
  else for (const it of batch) await routeProposal(ctx, it.row, it.p)

  // --- secure-portal notices with nothing attached
  if (kind === "zix" && !atts.length && /portal|secure message center|view message|retrieve/i.test(msg.text)) {
    await tgSend(`🔐 Zix secure message from ${esc(msg.from.name || msg.from.email)} — “${esc(shortSubject(msg.subject))}” — no attachment came through; it's waiting in the Zix portal.`, { dryRun: DRY })
  }
  if (kind === "docusign_completed" && !atts.length) {
    await tgSend(`🖊 DocuSign completed — “${esc(shortSubject(msg.subject))}” — but the signed PDF wasn't attached; grab it from the DocuSign link in the email.`, { dryRun: DRY })
  }

  // --- open loops (things Ryan owes someone)
  if (kind === "docusign_completed" || kind === "esign_completed") await resolveSignatureLoops(msg)
  if (cls.needs_reply || kind === "docusign_request") await upsertLoop(ctx, msg, cls, kind)

  // --- deals
  if (cls.deal && (kind === "deal_lead" || kind === "broker_blast" || cls.deal.tier)) await screenDeal(ctx, msg, cls, pdfDocs)
}

// ------------------------------------------------------------------ loops
function normalizeEnvelope(subject) {
  return String(subject || "").replace(/^(re|fw|fwd):\s*/gi, "").replace(/^(completed|declined|reminder|please sign|please docusign|signing complete):?\s*/gi, "").replace(/^please sign:?\s*/i, "").toLowerCase().replace(/[^a-z0-9]/g, "")
}
async function upsertLoop(ctx, msg, cls, kind) {
  const isSig = kind === "docusign_request"
  const category = isSig ? "signature" : cls.category || "other"
  const ask = isSig ? `Sign: ${shortSubject(msg.subject.replace(/^(reminder:\s*)?(please sign:?\s*)?/i, ""))}` : cls.ask || cls.summary
  const priority = isSig ? "high" : cls.priority || "normal"
  const { data: open } = await sb().from("inbox_loops").select("*").eq("thread_id", msg.threadId).in("status", ["open", "snoozed"]).limit(1)
  let loop = open?.[0] || null
  if (isSig) {
    const { data: sig } = await sb().from("inbox_loops").select("*").eq("category", "signature").in("status", ["open", "snoozed"]).limit(50)
    loop = (sig || []).find((l) => normalizeEnvelope(l.subject) === normalizeEnvelope(msg.subject)) || loop
  }
  const now = isoNow()
  if (DRY) {
    log(`loop: ${ask} (${priority})`)
    return
  }
  if (loop) {
    await sb().from("inbox_loops").update({ ask, due_on: cls.due_on || loop.due_on, priority: priority === "high" ? "high" : loop.priority, gmail_id: msg.id, status: "open", snooze_until: null }).eq("id", loop.id)
    return
  }
  const { data } = await sb().from("inbox_loops").insert({
    thread_id: msg.threadId, gmail_id: msg.id, subject: msg.subject, counterparty: cls.counterparty || msg.from.name || msg.from.email, counterparty_email: msg.from.email,
    category, ask, due_on: cls.due_on || null, priority, status: "open",
  }).select("*").single()
  if (data && priority === "high") {
    const text = [
      `🔔 <b>${esc(data.counterparty)}</b> needs something${data.due_on ? ` by <b>${esc(data.due_on)}</b>` : ""}`,
      esc(ask),
      `“${esc(shortSubject(msg.subject))}”${cls.property?.label ? ` · ${esc(cls.property.label)}` : ""}`,
    ].join("\n")
    const mid = await tgSend(text, { rows: [[{ text: "✓ Done", data: `ix:ld:${data.id}` }, { text: "⏰ Snooze 2d", data: `ix:lz:${data.id}` }]] })
    await sb().from("inbox_loops").update({ tg_message_id: mid, alerted_at: now }).eq("id", data.id)
  }
}
async function resolveSignatureLoops(msg) {
  if (DRY) return
  const { data: sig } = await sb().from("inbox_loops").select("id, subject, tg_message_id").eq("category", "signature").in("status", ["open", "snoozed"]).limit(50)
  const key = normalizeEnvelope(msg.subject)
  for (const l of sig || []) {
    if (normalizeEnvelope(l.subject) === key) {
      await sb().from("inbox_loops").update({ status: "resolved_by_event", resolved_at: isoNow() }).eq("id", l.id)
      await tgClearButtons(l.tg_message_id)
    }
  }
}
async function resolveLoops(ctx) {
  const { data: open } = await sb().from("inbox_loops").select("id, thread_id, created_at, tg_message_id, status, snooze_until").in("status", ["open", "snoozed"]).limit(500)
  if (!open?.length) return
  const sent = await sentThreadsSince(ctx.gmail, 4)
  const now = isoNow()
  for (const l of open) {
    if (l.status === "snoozed" && l.snooze_until && l.snooze_until <= now) {
      if (!DRY) await sb().from("inbox_loops").update({ status: "open", snooze_until: null }).eq("id", l.id)
    }
    const when = sent.get(l.thread_id)
    if (when && when > l.created_at) {
      if (!DRY) {
        await sb().from("inbox_loops").update({ status: "resolved_by_reply", resolved_at: now }).eq("id", l.id)
        await tgClearButtons(l.tg_message_id)
      }
      log(`loop resolved by reply: ${l.id}`)
    }
  }
}

// ------------------------------------------------------------------ deals
async function screenDeal(ctx, msg, cls, pdfDocs) {
  const tier = cls.deal.tier || (cls.kind === "deal_lead" ? "direct" : "blast")
  const docs = tier === "direct" ? pdfDocs.slice(0, 2) : pdfDocs.slice(0, 1)
  const { data: past } = await sb().from("inbox_deal_screens").select("address, verdict, ryan_verdict, summary").not("ryan_verdict", "is", null).order("created_at", { ascending: false }).limit(20)
  const calibration = (past || []).map((p) => `- ${p.address || "?"}: model said ${p.verdict}, Ryan said ${p.ryan_verdict}${p.summary ? ` (${p.summary})` : ""}`).join("\n")
  const out = await completeJson({
    model: tier === "direct" ? SONNET : HAIKU, system: SCREEN_SYSTEM + (calibration ? `\n\nCALIBRATION — Ryan's own verdicts on recent screens (match his taste, not the model's):\n${calibration}` : ""),
    prompt: screenPrompt({ tier, msg, deal: cls.deal, attachmentsText: (cls.attachments || []).map((a) => a.description).filter(Boolean).join("; ") }),
    docs, maxTokens: 2500, tag: "[screen]", thinking: true,
  })
  if (!out) return
  const facts = out.facts || {}
  const units = Number(facts.units) || Number(cls.deal.units) || null
  let post = tier === "direct"
  let cut = null
  if (tier !== "direct") {
    cut = blastPassesCut(out, cls)
    post = cut.ok
    log(`blast ${out.address || "?"}: ${cut.ok ? "SHOW" : "hold"} — ${cut.why}`)
  }
  const money = (n) => {
    if (n === null || n === undefined || n === "") return "not stated"
    const num = typeof n === "number" ? n : Number(String(n).replace(/[$,]/g, ""))
    return Number.isFinite(num) ? `$${Math.round(num).toLocaleString()}` : esc(String(n))
  }
  const unitsLabel = units ?? (facts.units ? esc(String(facts.units)) : "?")
  const lines = [
    `${tier === "direct" ? "🏢 <b>Direct lead</b>" : "📣 <b>Broker blast</b>"} — <b>${esc(out.address || cls.deal.address || "address?")}</b>`,
    `From ${esc(msg.from.name || msg.from.email)}`,
    `Units ${unitsLabel}${facts.unit_mix ? ` (${esc(facts.unit_mix)})` : ""} · Asking ${money(facts.asking)} · ${facts.price_per_door ? `${money(facts.price_per_door)}/door` : "per-door n/a"}${facts.grm ? ` · GRM ${facts.grm}` : ""}${facts.gross_rent_mo ? ` · gross ${money(facts.gross_rent_mo)}/mo` : ""}`,
    `<b>${out.verdict === "pass" ? "PASS" : out.verdict === "look_further" ? "LOOK FURTHER" : "UNCLEAR"}</b> — ${esc(out.one_liner || "")}`,
    ...(out.reasons || []).slice(0, 4).map((r) => `• ${esc(r)}`),
    ...(out.questions_for_seller?.length ? ["Ask: " + out.questions_for_seller.slice(0, 3).map(esc).join(" / ")] : []),
  ]
  if (DRY) {
    if (post) await tgSend(lines.join("\n"), { dryRun: true })
    return
  }
  const hold = post && tier !== "direct" && isQuiet()
  const { data } = await sb().from("inbox_deal_screens").insert({ gmail_id: msg.id, address: out.address || cls.deal.address || null, tier, facts: { ...facts, reasons: out.reasons, questions: out.questions_for_seller, cut: cut?.why || null, shown: post, post_pending: hold, card_lines: hold ? lines : undefined }, verdict: out.verdict || "unknown", summary: out.one_liner || null }).select("id").single()
  if (post && data && !hold) {
    const mid = await tgSend(lines.join("\n"), { rows: [[{ text: "👀 Look further", data: `ix:sl:${data.id}` }, { text: "🚫 Pass", data: `ix:sp:${data.id}` }]] })
    await sb().from("inbox_deal_screens").update({ tg_message_id: mid }).eq("id", data.id)
  }
}

// ------------------------------------------------------------------ 4. interview
async function seedInterview(ctx) {
  await loadTree(ctx)
  const { data: existing } = await sb().from("inbox_interview").select("seq").order("seq", { ascending: false }).limit(1)
  let seq = existing?.[0]?.seq || 0
  for (const id of INTERVIEW_SET) {
    const { data: done } = await sb().from("inbox_messages").select("gmail_id").eq("gmail_id", id).maybeSingle()
    if (done) continue
    let msg
    try {
      msg = await getMessage(ctx.gmail, id)
    } catch (e) {
      warn(`interview: message ${id} not readable (${e.message})`)
      continue
    }
    const cls = await classify(ctx, msg)
    await insertMessage(msg, cls?.kind || "human", cls)
    for (const att of relevantAttachments(msg, cls)) {
      const rec = await recordAttachment(ctx, msg, att, cls, "interview")
      if (!rec || rec.dup) continue
      const p = await proposeFor(ctx, rec.row, rec.bytes, cls)
      const description = cls?.attachments?.find((a) => a.filename === att.filename)?.description || att.doc_type
      seq++
      if (DRY) continue
      await sb().from("inbox_interview").insert({
        file_id: rec.row.id, seq, question: description,
        guess_folder: p?.folder || "Properties/_Unsorted", guess_name: p?.name || att.filename,
      })
    }
    // Direct leads also get their screen during the interview, as a preview.
    if (cls?.deal && cls.deal.tier === "direct") {
      const pdfs = []
      for (const att of relevantAttachments(msg, cls).filter((a) => /pdf$/i.test(a.mime))) pdfs.push({ kind: "pdf", data: await getAttachmentBytes(ctx.gmail, msg.id, att.attachmentId), mime: att.mime, name: att.filename })
      await screenDeal(ctx, msg, cls, pdfs)
    }
  }
  const rules = await getSetting("rules")
  if (rules.status !== "approved" && !DRY) await setSetting("rules", { status: "interview" })
  log(`interview seeded through seq ${seq}`)
}

async function interviewStep(ctx) {
  const rules = await getSetting("rules")
  if (["approved", "draft", "revise", "generating"].includes(rules.status)) return
  const { data: asked } = await sb().from("inbox_interview").select("id, asked_at").eq("status", "asked").limit(1)
  if (asked?.length) {
    if (daysAgo(asked[0].asked_at) >= 3) log("interview: waiting on Ryan (3+ days)")
    return
  }
  const { data: next } = await sb().from("inbox_interview").select("*, inbox_files(*)").eq("status", "pending").order("seq").limit(1)
  const { count: total } = await sb().from("inbox_interview").select("id", { count: "exact", head: true })
  if (next?.length) {
    const iv = next[0]
    const f = iv.inbox_files
    const who = f.sender
    const text = [
      `🗂 <b>Setup question ${iv.seq}/${total}</b> — teaching me your filing`,
      `<b>${esc(f.filename)}</b> — ${esc(iv.question || f.doc_type)}`,
      `From ${esc(who)} · ${ptDateLabel(f.received_at)} · “${esc(shortSubject(f.subject))}”`,
      `My guess: <b>${esc(iv.guess_folder)}/</b>${esc(iv.guess_name)}`,
      `Where would you put it and what would you call it? Tap ✅ if my guess is right, or reply to this message with the folder + name.`,
    ].join("\n")
    const mid = await tgSend(text, { rows: [[{ text: "✅ Use my guess", data: `ix:io:${iv.id}` }, { text: "⏭ Skip", data: `ix:is:${iv.id}` }]], dryRun: DRY })
    if (!DRY) await sb().from("inbox_interview").update({ status: "asked", asked_at: isoNow(), tg_message_id: mid }).eq("id", iv.id)
    return
  }
  const { count: answered } = await sb().from("inbox_interview").select("id", { count: "exact", head: true }).in("status", ["answered", "skipped"])
  if (rules.status === "interview" && answered > 0) await publishRules(ctx, {})
}

async function publishRules(ctx, { feedback, previous }) {
  await loadTree(ctx)
  const { data: ivs } = await sb().from("inbox_interview").select("*, inbox_files(filename, sender, subject, doc_type, property_label)").in("status", ["answered", "skipped"]).order("seq")
  const qa = (ivs || []).map((iv) => ({
    doc: `${iv.inbox_files?.filename} (${iv.question || iv.inbox_files?.doc_type}; from ${iv.inbox_files?.sender}; property ${iv.inbox_files?.property_label || "unknown"})`,
    guess: `${iv.guess_folder}/${iv.guess_name}`,
    answer: iv.answer_kind === "accepted" ? "accepted my guess" : iv.answer_kind === "skipped" ? "skipped (don't file this kind)" : iv.answer_text,
  }))
  const corrections = (await fetchAll("inbox_rules", "*")).filter((r) => r.source === "correction").map((r) => `${r.sender_domain} ${r.doc_type} → ${r.folder_template}/${r.filename_template}${r.note ? ` (${r.note})` : ""}`)
  const md = await complete({ model: SONNET, system: RULES_SYSTEM, prompt: rulesPrompt({ tree: ctx.tree, qa, corrections, feedback, previous }), maxTokens: 3000, tag: "[rules]", thinking: true })
  if (!md) {
    warn("rules doc came back empty")
    return
  }
  const header = `<!-- Generated by scripts/inbox-agent (Inbox Agent). Edit via Telegram feedback or by hand; the agent reads the approved copy from inbox_settings.rules.md. ${isoNow()} -->\n\n`
  for (const root of new Set([MAIN_CHECKOUT, REPO_ROOT])) {
    try {
      fs.writeFileSync(path.join(root, "briefs", "INBOX_FILING_RULES.md"), header + md)
    } catch (e) {
      warn(`write rules file in ${root}:`, e.message)
    }
  }
  if (DRY) {
    console.log(md)
    return
  }
  const caption = `📐 ${previous ? "Revised" : "Here's"} the filing convention I learned from your answers. Tap 👍 if it's right, or reply to this message with changes.`
  const mid = await tgSendDocument("INBOX_FILING_RULES.md", md, caption, { rows: [[{ text: "👍 That's right", data: "ix:ro" }, { text: "✏️ Needs changes", data: "ix:rn" }]] })
  await setSetting("rules", { md, status: "draft", tg_message_id: mid, published_at: isoNow(), feedback: null, version: (await getSetting("rules")).version ? (await getSetting("rules")).version + 1 : 1 })
}

// ------------------------------------------------------------------ 5. digest
async function maybeDigest(ctx, force = false) {
  const { date, hour, minute } = ptParts()
  const agent = await getSetting("agent")
  if (!force) {
    if (agent.last_digest_date === date) return
    if (hour < 7 || (hour === 7 && minute < 30)) return
  }
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString()
  const [loops, filed, pending, waiting, dups, screens, interview, rules] = await Promise.all([
    sb().from("inbox_loops").select("*").in("status", ["open"]).order("priority").order("created_at"),
    sb().from("inbox_files").select("final_folder, final_name, drive_url").eq("status", "filed").gte("filed_at", dayAgo),
    sb().from("inbox_files").select("filename, property_label").in("status", ["pending", "change_requested"]),
    sb().from("inbox_files").select("id", { count: "exact", head: true }).eq("status", "waiting"),
    sb().from("inbox_files").select("filename").eq("status", "duplicate").gte("created_at", dayAgo),
    sb().from("inbox_deal_screens").select("address, verdict, summary, tier, facts").gte("created_at", dayAgo),
    sb().from("inbox_interview").select("id", { count: "exact", head: true }).eq("status", "asked"),
    getSetting("rules"),
  ])
  const lines = [`☀️ <b>Inbox brief · ${date}</b>`]
  const open = loops.data || []
  if (open.length) {
    lines.push(`\n<b>Waiting on you (${open.length})</b>`)
    for (const l of open.slice(0, 12)) {
      const age = daysAgo(l.created_at)
      lines.push(`${l.priority === "high" ? "🔴" : "•"} ${esc(l.counterparty)} — ${esc(l.ask)}${l.due_on ? ` · due ${esc(l.due_on)}` : ""}${age >= 2 ? ` · ${age}d` : ""}`)
    }
    if (open.length > 12) lines.push(`… +${open.length - 12} more`)
  } else lines.push("\n✅ Nothing waiting on you.")
  if (pending.data?.length) lines.push(`\n<b>Filing proposals waiting for a tap:</b> ${pending.data.length} (${pending.data.slice(0, 4).map((p) => esc(p.filename)).join(", ")}${pending.data.length > 4 ? "…" : ""})`)
  if (filed.data?.length) lines.push(`\n<b>Filed in the last day:</b> ${filed.data.length}\n` + filed.data.slice(0, 8).map((f) => `• ${esc(f.final_folder)}/${esc(f.final_name)}`).join("\n"))
  if (dups.data?.length) lines.push(`\nSkipped as duplicates: ${dups.data.map((d) => esc(d.filename)).join(", ")}`)
  if (screens.data?.length) {
    const shown = screens.data.filter((s) => s.tier === "direct" || s.facts?.shown)
    const held = screens.data.length - shown.length
    if (shown.length) lines.push(`\n<b>Deals screened:</b>\n` + shown.map((s) => `• ${esc(s.address || "?")} — ${s.verdict === "pass" ? "pass" : s.verdict === "look_further" ? "look further" : "unclear"}${s.summary ? `: ${esc(s.summary)}` : ""}`).join("\n"))
    if (held) lines.push(`${held} broker blast${held === 1 ? "" : "s"} screened and held (outside the box).`)
  }
  if (rules.status !== "approved") {
    if (interview.count) lines.push(`\n🗂 A filing setup question is waiting on your answer above.`)
    else if (rules.status === "draft") lines.push(`\n📐 The filing convention is waiting for your 👍 (or changes).`)
    if (waiting.count) lines.push(`${waiting.count} attachment${waiting.count === 1 ? "" : "s"} queued until the convention is approved.`)
  }
  if (ctx.driveErr) lines.push(`\n⚠️ Drive isn't reachable yet: ${esc(ctx.driveErr)}`)
  await tgSend(lines.join("\n"), { dryRun: DRY })
  if (!DRY) await setSetting("agent", { last_digest_date: date })
}

// ------------------------------------------------------------------ weekly teach-back (Sunday 6pm PT)
async function maybeTeachback(ctx, force = false) {
  const { date, hour, weekday } = ptParts()
  const agent = await getSetting("agent")
  if (!force && (weekday !== "Sun" || hour < 18 || agent.last_teachback_date === date)) return
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const [rules, autoFiled, filed, corrected, undone] = await Promise.all([
    sb().from("inbox_rules").select("*").gte("updated_at", weekAgo).order("updated_at", { ascending: false }),
    sb().from("inbox_files").select("id", { count: "exact", head: true }).eq("status", "filed").eq("mode", "auto").gte("filed_at", weekAgo),
    sb().from("inbox_files").select("id", { count: "exact", head: true }).eq("status", "filed").gte("filed_at", weekAgo),
    sb().from("inbox_files").select("id", { count: "exact", head: true }).not("change_text", "is", null).gte("resolved_at", weekAgo),
    sb().from("inbox_files").select("id", { count: "exact", head: true }).eq("status", "undone").gte("resolved_at", weekAgo),
  ])
  const rs = rules.data || []
  if (!rs.length && !filed.count) {
    if (!DRY) await setSetting("agent", { last_teachback_date: date })
    return
  }
  const lines = [`🧠 <b>This week</b> — filed ${filed.count || 0} (${autoFiled.count || 0} automatically), ${corrected.count || 0} correction${corrected.count === 1 ? "" : "s"}, ${undone.count || 0} undo${undone.count === 1 ? "" : "s"}.`]
  if (rs.length) lines.push(`Rules touched (${rs.length}):`)
  for (const r of rs.slice(0, 8)) lines.push(`• ${r.mode === "auto" ? "🤖" : "✋"} ${esc(r.sender_domain || "any")} · ${esc(r.doc_type || "any")}${r.property_key ? ` · ${esc(r.property_key)}` : ""} → ${esc(r.folder_template)}/${esc(r.filename_template)} (${r.approvals_in_row}/${AUTO_THRESHOLD})`)
  const buttons = rs.filter((r) => r.mode === "auto").slice(0, 6).map((r) => [{ text: `✋ Make manual: ${(r.sender_domain || "any").slice(0, 18)} · ${(r.doc_type || "any").replace(/_/g, " ").slice(0, 16)}`, data: `ix:rm:${r.id}` }])
  const mid = await tgSend(lines.join("\n"), { rows: buttons, dryRun: DRY })
  if (!DRY) await setSetting("agent", { last_teachback_date: date, teachback_tg_message_id: mid })
}

async function noteDriveConnected(ctx) {
  if (!ctx.drive || !ctx.rootId) return
  const s = await getSetting("drive")
  if (s.connected_at) return
  await tgSend(`✅ Drive connected — I can see <b>Business Operations</b> (${esc(s.root_owner || "shared folder")}). Filing starts once the convention is approved.`, { dryRun: DRY })
  if (!DRY) await setSetting("drive", { connected_at: isoNow(), alerted_date: null })
}

// ------------------------------------------------------------------ misc commands
async function driveCheck(ctx) {
  if (!ctx.drive || !ctx.rootId) {
    console.log(`✗ Drive: ${ctx.driveErr}`)
    console.log("Setup (Ryan):")
    console.log("  1. In the personal Drive, share “Business Operations” with ryan@lrghomes.com as Editor.")
    console.log("  2. admin.google.com → Security → API controls → Domain-wide delegation → client 118033894408819500850 → add https://www.googleapis.com/auth/drive")
    console.log("  3. Enable the Drive API on the GCP project: https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=lrg-mission-control")
    return false
  }
  const tree = await loadTree(ctx)
  console.log(`✓ Drive root ${ctx.rootId} (${(await getSetting("drive")).root_owner || "?"})`)
  console.log(tree)
  return true
}
async function status() {
  const counts = {}
  for (const [t, col] of [["inbox_messages", "kind"], ["inbox_files", "status"], ["inbox_loops", "status"], ["inbox_interview", "status"], ["inbox_rules", "mode"], ["inbox_deal_screens", "verdict"]]) {
    const rows = await fetchAll(t, col)
    counts[t] = rows.reduce((m, r) => ((m[r[col] || "null"] = (m[r[col] || "null"] || 0) + 1), m), {})
  }
  console.log(JSON.stringify({ agent: await getSetting("agent"), rules: { ...(await getSetting("rules")), md: undefined }, drive: { ...(await getSetting("drive")), tree_cache: undefined }, counts }, null, 2))
}

async function alertDriveOnce(ctx) {
  if (!ctx.driveErr) return
  const s = await getSetting("drive")
  const { date } = ptParts()
  if (s.alerted_date === date && s.alerted_error === ctx.driveErr) return
  await tgSend(`⚠️ Inbox agent can't reach your Drive yet (${esc(ctx.driveErr)}).\nTwo one-time steps:\n1. Share <b>Business Operations</b> (personal Drive) with ryan@lrghomes.com as Editor.\n2. Admin console → Security → API controls → Domain-wide delegation → client 118033894408819500850 → add scope https://www.googleapis.com/auth/drive\n3. Enable the Drive API on the GCP project (one click, signed in as the Workspace admin): https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=lrg-mission-control\nI'll keep classifying and asking setup questions meanwhile; uploads wait.`, { dryRun: DRY })
  if (!DRY) await setSetting("drive", { alerted_date: date, alerted_error: ctx.driveErr })
}

// ------------------------------------------------------------------ main
async function main() {
  if (flag("status")) return status()
  if (flag("pause")) {
    await setSetting("agent", { paused: true, paused_at: isoNow() })
    return log("paused")
  }
  if (flag("resume")) {
    await setSetting("agent", { paused: false })
    return log("resumed")
  }
  const agent = await getSetting("agent")
  if (agent.paused) return log("paused — skipping pass")
  const ctx = await buildContext()
  if (flag("drive-check")) return driveCheck(ctx)
  const t0 = Date.now()
  QUIET = { ...QUIET, ...((agent.quiet_hours && typeof agent.quiet_hours === "object") ? agent.quiet_hours : {}) }
  await alertDriveOnce(ctx)
  await noteDriveConnected(ctx)
  await applyDecisions(ctx)
  await postDeferred(ctx)
  if (flag("interview")) await seedInterview(ctx)
  if (!flag("no-poll")) await pollInbox(ctx)
  await resolveLoops(ctx)
  await interviewStep(ctx)
  await maybeDigest(ctx, flag("digest-now"))
  await maybeTeachback(ctx, flag("teachback-now"))
  log(`pass done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

main().catch(async (e) => {
  warn("fatal:", e.stack || e.message)
  await tgSend(`⚠️ Inbox agent pass failed: ${esc(e.message)}`, { dryRun: DRY }).catch(() => {})
  process.exit(1)
})
