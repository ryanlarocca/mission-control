#!/usr/bin/env node
// Inbox Agent — the Mac mini worker (briefs/BRIEF_INBOX_AGENT_2026-09-24.md).
//
// Every pass (launchd, 5 min):
//   1. applyDecisions  — Ryan's taps/replies (recorded by the Vercel webhook via
//                        lib/inboxAgent.ts) → upload to Drive, learn rules,
//                        regenerate the convention doc.
//   2. pollInbox       — new mail on ryan@lrghomes.com → classify (Haiku) →
//                        attachment proposals / open loops / deal screens;
//                        document links (DocuSign) are queued in inbox_fetches.
//   2a. vendor filing  — ITI Direct Mail's invoices / signed proofs / quotes /
//                        tax form go to the campaign's Drive folder, 💸 Paid
//                        sets campaigns.total_cost (vendors.mjs;
//                        briefs/BRIEF_INBOX_VENDOR_FILING_TAPINSPECT_2026-10-16.md).
//   2b. runFetches     — open queued links in headless Chrome, pull the PDFs
//                        and run them through the same filing pipeline
//                        (briefs/BRIEF_INBOX_LINK_FETCH_2026-10-12.md); photo
//                        deliveries (f8) are pulled with plain fetch and filed
//                        into Properties/<address>/Photos/{MLS,Print}
//                        (briefs/BRIEF_INBOX_MEDIA_DELIVERY_2026-10-15.md);
//                        HomeSentry inspection reports behind a tapinspect
//                        share link park as awaiting_payment until released.
//   2c. scanEvents     — networking-event watcher: new mail on ryan@ + the personal
//                        Gmail (IMAP) → one inbox_events row per real event; surfaced
//                        only in the brief + cards (briefs/BRIEF_EVENT_WATCHER_2026-10-15.md).
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
//   node scripts/inbox-agent/index.mjs --events-only --events-backfill=60d --dry-run  # event watcher preview, writes nothing
//   flags: --dry-run (no Telegram, no Drive writes, no DB writes for new rows; link fetches
//          still run in the browser and land in /tmp/inbox-fetch), --limit=N, --message=<gmail id>
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import {
  AUTO_THRESHOLD, MAILBOX, MAIN_CHECKOUT, MAX_ATTACHMENT_BYTES, REPO_ROOT,
  daysAgo, fetchAll, getSetting, keysMatch, log, propertyKey, ptDate, ptDateLabel, ptParts, sanitizeFilename, sb, setSetting, warn,
} from "./env.mjs"
import { addLabel, getAttachmentBytes, getMessage, gmailClient, listMessageIds, sentSince } from "./gmail.mjs"
import { childFolderByPrefix, downloadFile, driveClient, findExtraRoots, findFileByName, findRoot, folderPathOf, folderTree, getFile, listChildren, moveFile, propertyFolders, renameFile, resolvePath, uploadFile, walkFolder } from "./drive.mjs"
import { esc, tgClearButtons, tgEditText, tgSend, tgSendDocument } from "./telegram.mjs"
import { advisorSummary, fixRlsDisabled, isSupabaseSecurityAlert } from "./supabase-advisor.mjs"
import {
  CLASSIFY_SYSTEM, FILING_SYSTEM, HAIKU, RULES_SYSTEM, SCREEN_SYSTEM, SONNET, VERIFY_SYSTEM,
  BAY_AREA_RE, CONDO_RE, blastSignalsPass,
  changePrompt, classifyPrompt, complete, completeJson, filingPrompt, rulesPrompt, screenPrompt, verifyPrompt, WHITELIST } from "./llm.mjs"
import { destinationFor, driveDuplicateOf, filingDecision, isPurchaseDoc, nextSequence, refineDocType, stageOf, vendorFilename, withTimeSuffix } from "./filing.mjs"
import { AWAITING_PAYMENT_MAX_TRIES, MAX_FETCH_ATTEMPTS, NEW_LINK_ERROR, NEW_LINK_GUARD_MS, awaitingPaymentNext, documentLinks, fetchDocuments, newLinkGuard, nextTryAt, paymentWakeTargets, propertyWebsiteLinks, providerKind, providerLabel, queuesOnSystemEmail, readFetchedBytes, requeueDecision, saveFetchedBytes, tapinspectShareId, waitsClosedBy, waitsTimedOut } from "./fetch/index.mjs"
import { invoiceDiffLines, matchVendor, money, paidName, parentCampaignOf, pickCampaign, supersedeRenames, vendorFilingDecision, vendorRules } from "./vendors.mjs"
import { DUP_STATUSES, gmailLink, photoDedupeVerdict, propertyFolderFromReply, propertyLabelFromSubject, suffixedFilename } from "./photos.mjs"
import { LOOP_ACTIVE_STATUSES, LOOP_KEY_WINDOW_MS, SENT_LOOKBACK_DAYS, answeredBy, completionCloses, completionDismisses, completionEvent, envelopeMatches, isLooseEnd, loopEligible, loopKey, loopKeyMatch, mergeLoop, normalizeEnvelope, owedBy, reportFiledEvent, resolutionKind, splitLoops } from "./loops.mjs"
import { applyEventDecisions, eventBrief, postEventCards, scanEvents } from "./events-run.mjs"

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
const MESSAGE = opt("message", null) // one gmail id, for testing
const EVENTS_BACKFILL = opt("events-backfill", null) // e.g. "30d" — widen the event watcher's window (first run / testing)
const EVENTS_SOURCES = opt("events-source", "all") // all | gmail | personal (testing)
const EVENTS_MESSAGE = opt("events-message", null) // one ryan@ gmail id through the event watcher (pair with --dry-run)

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
/** Drive reports md5Checksum on uploaded (non-Google-native) files — the key for the Part G dedupe. */
function md5(buf) {
  return crypto.createHash("md5").update(buf).digest("hex")
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
// Ryan 2026-09-24: "we buy single family too. Always show anything off-market
// with a motivated seller, anything from a person I've done business with.
// Not retail listings or mass open houses."
// Ryan 2026-10-02 superseded the angle-based cut: "if an agent sends me a deal
// directly, that's different … if I'm getting some random market deal that's
// getting blasted out, I don't want these. If it's someone I've done business
// with, sure, you can show it." Blasts from unknown senders are never screened
// or shown; known senders still get the card.
// …and 2026-10-03: "look for keywords like TLC, contractor special, motivated
// seller … let me be the judge." A keyword hit pierces the unknown-sender filter.
function blastPassesCut(out, cls, knownSender, signals = [], pre = null) {
  if (knownSender) return { ok: true, why: "sender you've done business with" }
  const all = [...new Set([...signals, ...((out?.facts?.signals || []).map((s) => String(s).toLowerCase()))])]
  if (!all.length) return { ok: false, why: "mass blast from an unknown sender, no opportunity signals (hidden per 2026-10-02)" }
  // Ryan 2026-10-03: out of area and condo/townhome are hard filters, keywords or not.
  const addr = `${out?.address || ""} ${cls.deal?.address || ""}`
  if (addr.trim() && !BAY_AREA_RE.test(addr)) return { ok: false, why: `signals but out of area (${addr.trim().slice(0, 40)})` }
  const type = out?.property_type || cls.deal?.property_type || ""
  if (type === "condo_townhome" || CONDO_RE.test(addr)) return { ok: false, why: "signals but condo/townhome" }
  if (pre?.onMarket || (cls.deal?.is_retail_listing === true && !cls.deal?.off_market && !pre?.offMarket)) return { ok: false, why: "signals but an on-market retail listing" }
  return { ok: true, why: `signals: ${all.slice(0, 4).join(", ")}` }
}
/** inbox_settings.agent.muted_senders: emails or domains Ryan muted from a blast card (🔇). */
async function isMutedSender(email) {
  const list = (await getSetting("agent")).muted_senders || []
  const e = String(email || "").toLowerCase()
  const d = e.split("@")[1] || ""
  return list.some((m) => m === e || m === d || e.endsWith(`@${m}`) || d.endsWith(`.${m}`))
}

// ------------------------------------------------------------------ context
async function buildContext() {
  const ctx = { gmail: null, drive: null, rootId: null, driveErr: null, tree: null, propFolders: [], rules: null, rulesMd: null }
  ctx.gmail = await gmailClient()
  try {
    ctx.drive = await driveClient()
    ctx.rootId = await findRoot(ctx.drive)
    ctx.extraRoots = await findExtraRoots(ctx.drive).catch((e) => (warn("extra roots:", e.message), {}))
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
  const knownSender = await isKnownSender(senderEmail)
  const knowledge = await knowledgeText()
  return {
    knownSender,
    knowledge,
    senderProperties: [...new Set((mine || []).map((x) => x.property_label))],
    activeProperties: [...new Set((recent || []).map((x) => x.property_label))].slice(0, 12),
    propertyFolders: ctx.propFolders.map((f) => f.name),
  }
}

// ------------------------------------------------------------------ knowledge + known senders
// "Always be able to ask me questions when it doesn't know" (Ryan 2026-09-24):
// ❓ cards are inbox_interview rows with seq = null. Answers land in
// inbox_settings.knowledge and are fed into every prompt from then on.
async function knowledgeText() {
  const k = await getSetting("knowledge")
  const items = Array.isArray(k.items) ? k.items.slice(-40) : []
  return items.map((x) => `- Q: ${x.q} → Ryan: ${x.a}`).join("\n")
}
async function rememberAnswer(q, a) {
  const k = await getSetting("knowledge")
  const items = Array.isArray(k.items) ? k.items : []
  items.push({ q, a, at: isoNow() })
  if (!DRY) await setSetting("knowledge", { items: items.slice(-200) })
}
async function isKnownSender(email) {
  if (!email) return false
  const e = email.toLowerCase()
  const [rel, lead, filed] = await Promise.all([
    sb().from("relationships").select("id").ilike("email", e).limit(1),
    sb().from("leads").select("id").ilike("email", e).limit(1),
    sb().from("inbox_files").select("id").eq("sender", e).eq("status", "filed").limit(1),
  ])
  return !!(rel.data?.length || lead.data?.length || filed.data?.length)
}
async function postAskCard(ctx, row, question, guess) {
  const text = [
    `❓ <b>Not sure where this goes</b> — ${esc(row.filename)}`,
    `From ${esc(row.sender)} · ${ptDateLabel(row.received_at)} · “${esc(shortSubject(row.subject))}”`,
    esc(question),
    guess ? `Best guess: <b>${esc(guess.folder)}/</b>${esc(guess.name)}` : "",
    "✏️ Reply to this card with the folder (e.g. “Marketing/2026/NOO October2026”) and I'll file it there and remember the rule.",
  ].filter(Boolean).join("\n")
  // Ryan 2026-10-02: "it only gives me the option to use the guess or skip —
  // neither acceptable." Third button spells out the reply path.
  const tell = { text: "✏️ Tell me where", data: "ix:qw:PENDING" }
  const rows = guess ? [[{ text: "✅ Use the guess", data: "ix:io:PENDING" }, tell], [{ text: "⏭ Skip this file", data: `ix:fs:${row.id}` }]] : [[tell, { text: "⏭ Skip this file", data: `ix:fs:${row.id}` }]]
  if (DRY) {
    await tgSend(text, { rows, dryRun: true })
    return
  }
  const { data: iv } = await sb().from("inbox_interview").insert({ file_id: row.id, seq: null, question, guess_folder: guess?.folder || null, guess_name: guess?.name || null, status: "asked", asked_at: isoNow() }).select("id").single()
  const fixed = rows.map((r) => r.map((b) => ({ ...b, data: b.data.replace("PENDING", iv.id) })))
  const mid = await tgSend(text, { rows: fixed })
  await sb().from("inbox_interview").update({ tg_message_id: mid }).eq("id", iv.id)
  await sb().from("inbox_files").update({ status: "asked", proposed_folder: guess?.folder || null, proposed_name: guess?.name || null }).eq("id", row.id)
}
/** Answered ❓ cards → remember + file. */
async function applyAskAnswers(ctx) {
  const { data: rows } = await sb().from("inbox_interview").select("*, inbox_files(*)").is("seq", null).in("status", ["answered", "skipped"]).limit(20)
  for (const iv of rows || []) {
    const f = iv.inbox_files
    if (f?.fetch_id && providerKind(f.source) === "media") {
      await applyPhotoPropertyAnswer(iv, f)
      continue
    }
    if (iv.status === "skipped") {
      if (!DRY) await sb().from("inbox_interview").update({ status: "applied" }).eq("id", iv.id)
      continue
    }
    if (iv.answer_kind === "accepted" && iv.guess_folder) {
      await rememberAnswer(iv.question, `use ${iv.guess_folder}/${iv.guess_name}`)
      if (!DRY && f) await sb().from("inbox_files").update({ status: "approved", resolved_at: isoNow() }).eq("id", f.id).in("status", ["asked", "pending", "waiting"])
    } else if (iv.answer_text) {
      await rememberAnswer(iv.question, iv.answer_text)
      if (!DRY && f) await sb().from("inbox_files").update({ status: "changed", change_text: iv.answer_text, resolved_at: isoNow() }).eq("id", f.id).in("status", ["asked", "pending", "waiting"])
    }
    if (!DRY) await sb().from("inbox_interview").update({ status: "applied" }).eq("id", iv.id)
  }
}

/** Ryan's answer to a photo batch's "New property?" card: the folder rides on the
 *  ask row (proposed_folder) and the parked job goes back on the queue; `skip`
 *  (or the ⏭ button) ends the job. filePhotos reads proposed_folder on the re-run. */
async function applyPhotoPropertyAnswer(iv, f) {
  const folder = iv.status === "skipped" ? null : propertyFolderFromReply(iv.answer_text)
  if (DRY) return log(`photos ${f.fetch_id}: Ryan answered "${iv.answer_text || "skip"}" → ${folder || "skip"}`)
  if (!folder) {
    await sb().from("inbox_fetches").update({ status: "skipped", error: "Ryan skipped the batch", resolved_at: isoNow() }).eq("id", f.fetch_id)
    await sb().from("inbox_files").update({ status: "skipped", resolved_at: isoNow() }).eq("id", f.id)
  } else {
    await sb().from("inbox_files").update({ status: "answered", proposed_folder: folder, resolved_at: isoNow() }).eq("id", f.id)
    await sb().from("inbox_fetches").update({ status: "queued", attempts: 0, next_try_at: null, error: null }).eq("id", f.fetch_id)
    log(`photos ${f.fetch_id}: Ryan says ${folder} — requeued`)
  }
  await sb().from("inbox_interview").update({ status: "applied" }).eq("id", iv.id)
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

function relevantAttachments(msg, cls, { ignoreRelevance = false } = {}) {
  const byName = new Map((cls?.attachments || []).map((a) => [a.filename, a]))
  const out = []
  for (const a of msg.attachments) {
    if (a.inline && /^image\//.test(a.mime)) continue
    if (/^image\//.test(a.mime) && (a.size || 0) < 40 * 1024) continue // signature logos
    if (/^(image\d{3}|~WRD\d+|front-composer-)/i.test(a.filename)) continue
    if ((a.size || 0) > MAX_ATTACHMENT_BYTES) continue
    const c = byName.get(a.filename)
    if (!ignoreRelevance && c && c.relevant === false) continue
    if (!c && !/\.(pdf|docx?|xlsx?|csv|zip|jpe?g|png)$/i.test(a.filename)) continue
    const cleanName = a.filename.replace(/^\.+/, "")
    const docType = refineDocType(cleanName, c?.doc_type || (/\.pdf$/i.test(a.filename) ? "other" : /\.(csv|xlsx?)$/i.test(a.filename) ? "marketing_list" : "photos"), msg.from.email, msg.subject)
    out.push({ ...a, cleanName, doc_type: docType, stage: c?.stage || null, description: c?.description || "", signed: c?.signed ?? null, property_label: c?.property_label || cls?.property?.label || null })
  }
  return out
}

/** Documents pulled from behind a link → the shape relevantAttachments produces.
 *  Same logo/size filters; the "classifier said irrelevant" skip does not apply
 *  (Ryan asked for these documents by following the link), but every file still
 *  goes through refineDocType → filingDecision → verifyProperty like an attachment. */
function fetchedDocs(files, msg, cls, provider = null) {
  const byName = new Map((cls?.attachments || []).map((a) => [a.filename, a]))
  const out = []
  for (const f of files) {
    const size = f.bytes?.length || 0
    if (!size || size > MAX_ATTACHMENT_BYTES) continue
    if (f.mime === "application/zip") continue // unzip failed — nothing to file
    if (/^image\//.test(f.mime) && size < 40 * 1024) continue
    const c = byName.get(f.filename)
    const cleanName = f.filename.replace(/^\.+/, "")
    // A tapinspect share page only ever yields the inspection report (the agent never pulls the invoice / agreement / manual).
    const docType = provider === "tapinspect" ? "inspection" : refineDocType(cleanName, c?.doc_type || (/\.pdf$/i.test(f.filename) ? "other" : /\.(csv|xlsx?)$/i.test(f.filename) ? "marketing_list" : "photos"), msg.from.email, msg.subject)
    out.push({ filename: f.filename, mime: f.mime, size, bytes: f.bytes, attachmentId: null, partId: null, inline: false, cleanName, doc_type: docType, stage: c?.stage || null, description: c?.description || "", signed: c?.signed ?? null, property_label: c?.property_label || cls?.property?.label || null })
  }
  return out
}

/** Not a transaction document → remembered (so `find` and the teach-back can see it) but never filed, never a card. */
async function recordIgnored(msg, att, why, { source = "attachment", fetchId = null } = {}) {
  if (DRY) return log(`ignore ${att.filename}: ${why}`)
  await sb().from("inbox_files").insert({
    gmail_id: msg.id, thread_id: msg.threadId, attachment_id: att.attachmentId || null, part_id: att.partId || null, filename: att.filename, mime: att.mime, size_bytes: att.size || 0, sha256: null,
    sender: msg.from.email, subject: msg.subject, received_at: msg.internalDate, property_key: propertyKey(att.property_label), property_label: att.property_label, doc_type: att.doc_type,
    status: "ignored", error: why, resolved_at: isoNow(), source, fetch_id: fetchId,
  })
}

/** Ryan 2026-10-02: "read the top of the PDF to see what property that's for." */
async function verifyProperty(ctx, bytes, filename) {
  await loadTree(ctx)
  const candidates = ctx.propFolders.filter((f) => !/^(19|20)\d{2}$|^old$|^_unsorted$|^pitched/i.test(f.name)).map((f) => f.name)
  return completeJson({ model: HAIKU, system: VERIFY_SYSTEM, prompt: verifyPrompt({ filename, candidates }), docs: [{ kind: "pdf", data: bytes, mime: "application/pdf", name: filename }], maxTokens: 300, tag: "[verify]" })
}
function labelFromVerify(v) {
  if (!v) return null
  if (v.matches) return v.matches
  if (v.address) return String(v.address).split(",")[0].trim()
  return v.label || null
}

/** One line on what changed vs the previous settlement statement in the same folder (Ryan: "review these and update"). */
async function statementDiff(ctx, folderId, newBytes, newName, property) {
  try {
    const kids = (await listChildren(ctx.drive, folderId)).filter((k) => k.mimeType !== "application/vnd.google-apps.folder" && /statement/i.test(k.name) && k.name !== newName)
    if (!kids.length) return null
    const prev = kids.sort((a, b) => a.name.localeCompare(b.name)).at(-1)
    const prevBytes = await downloadFile(ctx.drive, prev.id)
    const text = await complete({
      model: SONNET, thinking: false, maxTokens: 300, tag: "[stmt-diff]",
      system: "You compare two versions of an escrow settlement statement for the same real-estate transaction and report what changed. Plain text, one or two short lines, ≤ 40 words total, lead with the bottom line (cash to close / proceeds) then the line items that moved. If nothing material changed say 'No material change'.",
      prompt: `Property: ${property}\nPREVIOUS version: "${prev.name}" (first document). NEW version: "${newName}" (second document). What changed?`,
      docs: [{ kind: "pdf", data: prevBytes, mime: "application/pdf", name: prev.name }, { kind: "pdf", data: newBytes, mime: "application/pdf", name: newName }],
    })
    return text ? `vs ${prev.name}: ${text.trim()}` : null
  } catch (e) {
    warn("statement diff failed:", e.message)
    return null
  }
}

/** Deterministic filing for a whitelisted doc on a known property. Returns {folder, name, folderId, seq}. */
async function deterministicDest(ctx, pf, att, msg, stage, source = "attachment") {
  const side = (await getSetting("agent")).sides?.[propertyKey(pf.name)] || "buyer"
  let seq = 1
  if (isPurchaseDoc(att.doc_type)) {
    const { id } = await resolvePath(ctx.drive, ctx.rootId, `${pf.path}/Purchase & Sale`, { create: !DRY })
    if (id) seq = nextSequence((await listChildren(ctx.drive, id)).map((k) => k.name))
  }
  const dest = destinationFor({ property: pf.name, docType: att.doc_type, filename: att.cleanName || att.filename, subject: msg.subject, receivedAt: msg.internalDate, stage, seq, side, source })
  return dest ? { ...dest, folder: dest.folder.replace(/^Properties\/[^/]+/, pf.path) } : null
}

/** The per-document lines of a filed-confirmation card (shared with the link-fetch card). */
function filedLines(filed) {
  const lines = []
  for (const f of filed) {
    lines.push(`• <a href="${f.url}">${esc(f.folder.replace(/^Properties\//, ""))}/${esc(f.name)}</a>`)
    if (f.diff) lines.push(`  <i>${esc(f.diff)}</i>`)
  }
  return lines
}
function undoRows(filed) {
  return filed.length && filed.length <= 3 ? filed.map((f) => [{ text: `↩️ Undo ${f.name.slice(0, 28)}`, data: `ix:fu:${f.row.id}` }]) : []
}

/** One confirmation per email for everything filed straight in (no approval card). */
async function postFiledConfirmation(ctx, msg, filed) {
  if (!filed.length) return
  const who = msg.from.name || msg.from.email
  const lines = [`🗂 <b>Filed ${filed.length === 1 ? "1 document" : `${filed.length} documents`}</b> from ${esc(who)} · ${ptDateLabel(msg.internalDate)} · “${esc(shortSubject(msg.subject))}”`, ...filedLines(filed)]
  lines.push(`Reply to this card to move or rename any of them.`)
  const mid = await tgSend(lines.join("\n"), { rows: undoRows(filed), dryRun: DRY })
  if (!DRY && mid) await sb().from("inbox_files").update({ tg_message_id: mid }).in("id", filed.map((f) => f.row.id))
}

// Part G (briefs/BRIEF_INBOX_LOOP_HYGIENE_2026-10-17.md): Dominic's re-scrubbed
// CSVs sat as proposals for days while Ryan had uploaded the same bytes by hand
// as "v2 2026-10-14 - <name>.csv". The sha dedupe only sees files the agent
// filed; before an attachment becomes a proposal, Drive itself is consulted —
// one walk per root per pass, cached on ctx.
const DRIVE_DEDUPE_STATUSES = new Set(["pending", "interview", "waiting", "approved"])

/** The Drive subtree an attachment could already live in: Marketing/<year> for marketing lists, the property's own folder for property documents; null when there is nothing to check. */
async function driveFilesFor(ctx, att, msg, label) {
  if (!ctx.drive || !ctx.rootId) return null
  ctx.driveWalks = ctx.driveWalks || new Map()
  if (att.doc_type === "marketing_list") {
    const year = ptDate(msg.internalDate).slice(0, 4)
    const key = `marketing:${year}`
    if (!ctx.driveWalks.has(key)) {
      const r = await resolvePath(ctx.drive, ctx.rootId, `Marketing/${year}`)
      ctx.driveWalks.set(key, r.id ? await walkFolder(ctx.drive, r.id, { maxDepth: 4, pathPrefix: `Marketing/${year}` }) : [])
    }
    return ctx.driveWalks.get(key)
  }
  await loadTree(ctx)
  const pf = propertyFolderFor(ctx, label)
  if (!pf?.id) return null
  const key = `folder:${pf.id}`
  if (!ctx.driveWalks.has(key)) ctx.driveWalks.set(key, await walkFolder(ctx.drive, pf.id, { maxDepth: 3, pathPrefix: pf.path }))
  return ctx.driveWalks.get(key)
}

/** Download (or take att.bytes for a fetched document), hash, dedupe, insert an inbox_files row. Returns {row, bytes} or null. */
async function recordAttachment(ctx, msg, att, cls, status, { source = "attachment", fetchId = null } = {}) {
  const bytes = att.bytes || (await getAttachmentBytes(ctx.gmail, msg.id, att.attachmentId))
  const hash = sha256(bytes)
  const { data: dup } = await sb().from("inbox_files").select("id, status, final_folder, final_name, proposed_folder, proposed_name").eq("sha256", hash).in("status", ["filed", "pending", "approved", "waiting", "interview", "changed", "change_requested"]).limit(1)
  const label = att.property_label || cls?.property?.label || null
  let dupRow = dup?.[0] || null
  // Part G: the sha lookup missed → is the file already in Drive under another name? Size first, then md5.
  if (!dupRow && DRIVE_DEDUPE_STATUSES.has(status)) {
    try {
      const files = await driveFilesFor(ctx, att, msg, label)
      const hit = files?.length ? driveDuplicateOf({ size: bytes.length, md5: md5(bytes) }, files) : null
      if (hit) {
        log(`duplicate (drive): ${att.filename} = ${hit.path}`)
        dupRow = { id: hit.id, status: "filed", final_folder: hit.path.replace(/\/[^/]*$/, ""), final_name: hit.name, drive_file_id: hit.id, drive_url: hit.webViewLink, drive: true }
      }
    } catch (e) {
      warn(`drive dedupe for ${att.filename} failed:`, e.message)
    }
  }
  const row = {
    gmail_id: msg.id,
    thread_id: msg.threadId,
    attachment_id: att.attachmentId || null,
    part_id: att.partId || null,
    filename: att.filename,
    mime: att.mime,
    size_bytes: bytes.length,
    sha256: hash,
    source,
    fetch_id: fetchId,
    sender: msg.from.email,
    subject: msg.subject,
    received_at: msg.internalDate,
    property_key: propertyKey(label),
    property_label: label,
    doc_type: att.doc_type,
    status: dupRow ? "duplicate" : status,
    // A Drive hit records where the existing copy lives (the brief's "Skipped as duplicates" line shows the name; no card).
    ...(dupRow?.drive ? { final_folder: dupRow.final_folder, final_name: dupRow.final_name, drive_file_id: dupRow.drive_file_id, drive_url: dupRow.drive_url, resolved_at: isoNow() } : {}),
  }
  if (DRY) return { row: { ...row, id: "dry-run" }, bytes, dup: dupRow }
  const { data, error } = await sb().from("inbox_files").insert(row).select("*").single()
  if (error) throw new Error(`inbox_files insert: ${error.message}`)
  return { row: data, bytes, dup: dupRow }
}

// ------------------------------------------------------------------ filing proposals
async function proposeFor(ctx, row, bytes, cls) {
  await loadRules(ctx)
  await loadTree(ctx)
  const pf = propertyFolderFor(ctx, row.property_label)
  const docs = []
  if (!row.property_label && bytes && /^application\/pdf$/.test(row.mime || "")) docs.push({ kind: "pdf", data: bytes, mime: row.mime, name: row.filename })
  const file = { ...row, description: cls?.attachments?.find((a) => a.filename === row.filename)?.description, property_address: cls?.property?.address, knowledge: await knowledgeText() }
  const out = await completeJson({ model: HAIKU, system: FILING_SYSTEM, prompt: filingPrompt({ rulesMd: ctx.rulesMd, rules: ctx.rules, tree: ctx.tree, file, propertyFolder: pf }), docs, maxTokens: 600, tag: "[propose]" })
  if (!out?.folder || !out?.name) return out?.question ? { question: out.question, folder: null, name: null } : null
  const rule = out.rule_id ? ctx.rules.find((r) => r.id.startsWith(String(out.rule_id).slice(0, 8))) : null
  let name = sanitizeFilename(out.name)
  if (!extOf(name) && extOf(row.filename)) name += `.${extOf(row.filename)}`
  return { folder: String(out.folder).replace(/^\/+|\/+$/g, ""), name, rule, confidence: Number(out.confidence) || null, reason: out.reason || "", question: out.question || null }
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
    const mid = await tgSend(lines.join("\n"), { rows: [[{ text: "👀 Look further", data: `ix:sl:${scr.id}` }, { text: "🚫 Pass", data: `ix:sp:${scr.id}` }, { text: "✉️ Reply", data: `ix:sr:${scr.id}` }]], dryRun: DRY })
    if (!DRY) await sb().from("inbox_deal_screens").update({ tg_message_id: mid, facts: { ...scr.facts, post_pending: false } }).eq("id", scr.id)
  }
}

/** Bytes for an inbox_files row: Gmail for an attachment, the on-disk fetch store for a document pulled from a link. */
async function bytesForRow(ctx, row) {
  if (row.attachment_id) return getAttachmentBytes(ctx.gmail, row.gmail_id, row.attachment_id)
  if (row.fetch_id && row.sha256) return readFetchedBytes(row.fetch_id, row.sha256)
  throw new Error(`no bytes for ${row.filename}: no Gmail attachment and no fetch on file`)
}

/** Upload one file (bytes re-fetched from Gmail / the fetch store unless passed in). Returns {ok, url, error}. */
async function fileToDrive(ctx, row, folder, name, { suffixOnExisting = false, bytes: given = null, folderId: pinned = null } = {}) {
  if (!ctx.drive || !ctx.rootId) return { ok: false, error: `Drive not available — ${ctx.driveErr || "setup incomplete"}` }
  try {
    const bytes = given || (await bytesForRow(ctx, row))
    if (sha256(bytes) !== row.sha256) warn(`hash changed for ${row.filename}`)
    // A campaign folder is pinned by id (vendor filing); `folder` is then only the recorded path.
    const { id: folderId, created } = pinned ? { id: pinned, created: [] } : await resolvePath(ctx.drive, ctx.rootId, folder, { create: !DRY })
    if (!folderId) return { ok: false, error: `folder ${folder} missing (dry run)` }
    const existing = await findFileByName(ctx.drive, folderId, name)
    if (existing && suffixOnExisting) name = withTimeSuffix(name, row.received_at) // settlement statements: every version kept, never overwritten
    else if (existing) {
      if (!DRY) await sb().from("inbox_files").update({ status: "duplicate", final_folder: folder, final_name: name, drive_file_id: existing.id, drive_url: existing.webViewLink, resolved_at: isoNow() }).eq("id", row.id)
      return { ok: false, duplicate: true, url: existing.webViewLink, error: `“${name}” already exists in ${folder}` }
    }
    if (DRY) return { ok: true, url: "(dry run)", created, name, folderId }
    const up = await uploadFile(ctx.drive, folderId, name, row.mime, bytes)
    await sb().from("inbox_files").update({ status: "filed", final_folder: folder, final_name: name, drive_file_id: up.id, drive_folder_id: folderId, drive_url: up.webViewLink, filed_at: isoNow(), resolved_at: isoNow(), error: null }).eq("id", row.id)
    await addLabel(ctx.gmail, row.gmail_id, "MC/Filed")
    return { ok: true, url: up.webViewLink, created, name, folderId }
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
  const when = new Date(row.received_at || isoNow())
  const monthYear = `${when.toLocaleString("en-US", { month: "long", timeZone: "America/Los_Angeles" })}${when.getFullYear()}` // "October2026" — Ryan's own folder style
  const fill = (t) => String(t).replace(/\{property\}/g, prop).replace(/\{date\}/g, date).replace(/\{year\}/g, date.slice(0, 4)).replace(/\{monthyear\}/g, monthYear).replace(/\{doc_type\}/g, String(row.doc_type || "").replace(/_/g, " ")).replace(/\{original\}/g, row.filename)
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

  // 💸 Paid on an ITI invoice card (vendor filing, Part A4).
  await applyPaidRequests(ctx)

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
  if (p.question && (!p.folder || (p.confidence !== null && p.confidence < 0.6))) {
    await postAskCard(ctx, row, p.question, p.folder ? { folder: p.folder, name: p.name } : null)
    return
  }
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
  // --message=<gmail id> re-runs one email through the pipeline (pair with --dry-run to test).
  const ids = MESSAGE ? [MESSAGE] : await listMessageIds(ctx.gmail, `in:inbox newer_than:${windowDays}d -from:${MAILBOX}`, 300)
  const known = new Set()
  for (let i = 0; i < ids.length && !MESSAGE; i += 200) {
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
    if (msg.internalDate && msg.internalDate < watermark && !MESSAGE) {
      await insertMessage(msg, "skip", { reason: "before watermark" })
      continue
    }
    if (msg.from.email === MAILBOX || AUTOMATED_RE.test(msg.from.email) || AUTOMATED_RE.test(msg.subject)) {
      await insertMessage(msg, "automated", null)
      continue
    }
    // Ryan 2026-10-11: Supabase's weekly "security vulnerabilities detected"
    // email used to land as a "Waiting on you" loop. It is always the same
    // thing — a new table with RLS off — so the agent fixes it itself and
    // posts a confirmation card instead of asking. Deterministic match, no
    // classifier call.
    if (isSupabaseSecurityAlert(msg)) {
      handled++
      try {
        await handleSupabaseAlert(ctx, msg)
      } catch (e) {
        warn(`supabase advisor ${id} failed:`, e.stack || e.message)
        await insertMessage(msg, "error", { error: e.message })
        await tgSend(`⚠️ Supabase security email arrived but the auto-fix failed: ${esc(e.message)}\nOpen the advisor: https://supabase.com/dashboard/project/${process.env.SUPABASE_PROJECT_REF || ""}/advisors/security`, { dryRun: DRY })
      }
      continue
    }
    // Ryan 2026-10-02: "agent flyer trash … these go into promotions … I don't
    // even want them to show up." Anything Gmail files under Promotions is
    // dropped at the poll unless it comes from someone he's done business with.
    // …unless it carries an opportunity keyword (Ryan 2026-10-03: TLC, contractor
    // special, motivated seller… "let me be the judge") — then it is classified
    // and screened like anything else.
    if (msg.labelIds.includes("CATEGORY_PROMOTIONS") && !blastSignalsPass(`${msg.subject}\n${msg.text}`).ok && !(await isKnownSender(msg.from.email))) {
      await insertMessage(msg, "promotions", { reason: "Gmail Promotions category, unknown sender, no opportunity signals" })
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

// Supabase advisor email → enable RLS on every flagged table, close any open
// loop this email (or an earlier copy of it) created, and post one card.
async function handleSupabaseAlert(ctx, msg) {
  const r = await fixRlsDisabled({ dryRun: DRY, log })
  log(`supabase advisor: fixed ${r.fixed.length}, still flagged ${r.stillFlagged.length}, other errors ${r.remaining.length}, alter errors ${r.errors.length}`)
  const needsRyan = r.stillFlagged.length > 0 || r.errors.length > 0 || r.remaining.length > 0
  await insertMessage(msg, "automated", {
    kind: "automated", is_human: false, counterparty: "Supabase", category: "other", needs_reply: needsRyan,
    summary: `Supabase security advisor: RLS enabled on ${r.fixed.length} table(s)`,
    ask: needsRyan ? "Supabase advisor still has errors the agent couldn't fix" : null,
    advisor: r,
  })
  if (DRY) {
    log(advisorSummary(r, esc))
    return
  }
  // Earlier copies of this email became loops before the auto-fix existed;
  // retire them all once the advisor is clean.
  const { data: loops } = await sb().from("inbox_loops").select("id, tg_message_id").eq("counterparty_email", msg.from.email).in("status", ["open", "snoozed", "acknowledged"]).limit(20)
  if (!needsRyan) {
    for (const l of loops || []) {
      await sb().from("inbox_loops").update({ status: "resolved_by_event", resolved_at: isoNow() }).eq("id", l.id)
      if (l.tg_message_id) await tgClearButtons(l.tg_message_id)
    }
  } else if (!(loops || []).length) {
    await sb().from("inbox_loops").insert({
      thread_id: msg.threadId, gmail_id: msg.id, subject: msg.subject, counterparty: "Supabase", counterparty_email: msg.from.email,
      category: "other", ask: `Supabase advisor: ${[...r.stillFlagged, ...r.errors, ...r.remaining].join("; ")}`.slice(0, 500), priority: "normal", status: "open",
    })
  }
  await tgSend(advisorSummary(r, esc), { dryRun: DRY })
}

/**
 * The filing pipeline for one email's documents — attachments (`docs` from
 * relevantAttachments) or documents pulled from behind a link (`docs` from
 * fetchedDocs, each carrying `bytes`). Ryan 2026-10-02: only the transaction
 * whitelist is filed; the property comes from the PDF, one email = one
 * property; whitelisted docs on a known property file straight in with a
 * confirmation (no approval card); questions only when the property is new or
 * unclear. Both paths produce identical inbox_files rows apart from source.
 * Returns { filed, pdfDocs, outcomes }.
 */
async function fileDocuments(ctx, msg, cls, docs, { source = "attachment", fetchId = null } = {}) {
  const kind = cls?.kind || "human"
  const rules = await getSetting("rules")
  const rulesApproved = rules.status === "approved"
  const recOpts = { source, fetchId }
  const pdfDocs = []
  const batch = []
  const filed = []
  const outcomes = [] // [{filename, outcome, why}] — the link-fetch card lists what happened to every file
  const note = (att, outcome, why = "") => outcomes.push({ filename: att.cleanName || att.filename, outcome, why })
  let property = cls?.property?.label || null // the email's property; refined by the first verified PDF
  for (const att of docs) {
    const isDeal = cls?.deal && (kind === "deal_lead" || kind === "broker_blast")
    const stage0 = stageOf({ filename: att.cleanName, subject: msg.subject, modelStage: att.stage })
    const pre = filingDecision(att.doc_type, stage0)
    if (!pre.file && !/^(evidence_of_insurance|insurance_policy|loan_docs)$/.test(att.doc_type) && !(isDeal && /^application\/pdf$/.test(att.mime))) {
      await recordIgnored(msg, att, pre.why, recOpts)
      note(att, "ignored", pre.why)
      continue
    }
    const rec = await recordAttachment(ctx, msg, att, cls, rulesApproved ? "pending" : "waiting", recOpts)
    if (!rec) continue
    if (/^application\/pdf$/.test(att.mime)) pdfDocs.push({ kind: "pdf", data: rec.bytes, mime: att.mime, name: att.filename })
    if (rec.dup) {
      log(`duplicate: ${att.filename} (matches ${rec.dup.id})`)
      note(att, "duplicate", rec.dup.final_name ? `already filed as ${rec.dup.final_name}` : "already on file")
      continue
    }
    if (!pre.file && !/^(evidence_of_insurance|insurance_policy|loan_docs)$/.test(att.doc_type)) {
      // OM / flyer on a deal email: kept for the screen, never filed.
      if (!DRY) await sb().from("inbox_files").update({ status: "ignored", error: pre.why, resolved_at: isoNow() }).eq("id", rec.row.id)
      note(att, "ignored", pre.why)
      continue
    }
    if (!rulesApproved) {
      note(att, "waiting", "queued until the filing convention is approved")
      continue
    }

    // Property from the document itself.
    let verify = null
    if (/^application\/pdf$/.test(att.mime) && att.doc_type !== "marketing_list") verify = await verifyProperty(ctx, rec.bytes, att.cleanName)
    const vLabel = labelFromVerify(verify)
    const stage = stageOf({ filename: att.cleanName, subject: msg.subject, modelStage: att.stage, verifyStage: verify?.stage })
    const decision = filingDecision(att.doc_type, stage)
    if (!decision.file) {
      if (!DRY) await sb().from("inbox_files").update({ status: "ignored", error: decision.why, resolved_at: isoNow() }).eq("id", rec.row.id)
      log(`ignore ${att.filename}: ${decision.why}`)
      note(att, "ignored", decision.why)
      continue
    }
    if (vLabel && property && !keysMatch(propertyKey(vLabel), propertyKey(property)) && (verify?.confidence ?? 1) >= 0.6) {
      await postAskCard(ctx, rec.row, `The PDF says ${vLabel} but the email looks like ${property}. Which property does “${att.cleanName}” belong to?`, null)
      note(att, "asked", `PDF says ${vLabel}, email says ${property}`)
      continue
    }
    if (!property && vLabel) property = vLabel
    if (property && !DRY) await sb().from("inbox_files").update({ property_label: property, property_key: propertyKey(property), doc_type: att.doc_type }).eq("id", rec.row.id)
    const rowNow = { ...rec.row, property_label: property, property_key: propertyKey(property), doc_type: att.doc_type }

    if (att.doc_type === "marketing_list" || !property) {
      // Not a property document, or no property anywhere → the learned-rules path (card or question).
      const p = await proposeFor(ctx, rowNow, rec.bytes, cls)
      if (!p) await postAskCard(ctx, rowNow, `Which property (or folder) is “${att.cleanName}” for?`, null)
      else if (!property && att.doc_type !== "marketing_list" && !p.question) await postAskCard(ctx, rowNow, `Which property is “${att.cleanName}” for?`, { folder: p.folder, name: p.name })
      else if (docs.length >= 3 && !(p.rule && p.rule.mode === "auto") && !p.question && p.folder) batch.push({ row: rowNow, p })
      else await routeProposal(ctx, rowNow, p)
      note(att, "asked", property ? "proposal card" : "property unknown")
      continue
    }
    const pf = propertyFolderFor(ctx, property)
    if (!pf) {
      const guessFolder = `Properties/${property}`
      await postAskCard(ctx, rowNow, `New property? I don't have a folder for ${property}. Create Properties/${property}/ with the standard subfolders?`, { folder: `${guessFolder}/${decision.sub}`, name: att.cleanName })
      note(att, "asked", `no folder for ${property}`)
      continue
    }
    const dest = await deterministicDest(ctx, pf, att, msg, stage, source)
    if (!dest) continue
    const r = await fileToDrive(ctx, rowNow, dest.folder, dest.name, { suffixOnExisting: true, bytes: rec.bytes })
    if (!r.ok) {
      await tgSend(`⚠️ Couldn't file <b>${esc(dest.name)}</b> → ${esc(dest.folder)} — ${esc(r.error)}`, { dryRun: DRY })
      note(att, "error", r.error)
      continue
    }
    let diff = null
    if (/^(closing_statement|net_sheet)$/.test(att.doc_type) && r.folderId && !DRY) diff = await statementDiff(ctx, r.folderId, rec.bytes, r.name || dest.name, pf.name)
    filed.push({ row: rowNow, folder: dest.folder, name: r.name || dest.name, url: r.url, diff })
    note(att, "filed", `${dest.folder}/${r.name || dest.name}`)
  }
  if (batch.length >= 2) await postBatch(ctx, msg, batch)
  else for (const it of batch) await routeProposal(ctx, it.row, it.p)
  return { filed, pdfDocs, outcomes }
}

// ------------------------------------------------------------------ 2a. vendor filing (ITI Direct Mail → campaign folder)
// briefs/BRIEF_INBOX_VENDOR_FILING_TAPINSPECT_2026-10-16.md Part A. Ryan: invoices
// on deal threads stay ignored, but the mail house's paper trail (invoice,
// signed proof, quote, tax exemption form) lives in Marketing/<year>/<campaign>/
// "3 - MAIL HOUSE (…)". Every invoice version is kept: a new one supersedes the
// unpaid ones in the folder (rename, never overwrite); 💸 Paid renames it PAID
// and sets campaigns.total_cost on the parent campaign.
const CAMPAIGN_COLS = "id, name, drive_folder_id, parent_campaign_id, drop_date, total_cost"

/** The campaign (and its parent) a vendor document goes to, plus the Drive folder for the rule's subfolder. */
async function vendorDestination(ctx, rule) {
  const { data: campaigns, error } = await sb().from("campaigns").select(CAMPAIGN_COLS)
  if (error) throw new Error(`campaigns read: ${error.message}`)
  const pick = pickCampaign(rule, campaigns || [])
  if (!pick.campaign) return { ...pick, campaigns: campaigns || [] }
  const campaign = pick.campaign
  const parent = parentCampaignOf(campaign, campaigns || [])
  if (!ctx.drive || !ctx.rootId) return { ...pick, parent, campaigns, folderId: null, folderPath: null, error: `Drive not available — ${ctx.driveErr || "setup incomplete"}` }
  const root = await getFile(ctx.drive, campaign.drive_folder_id)
  if (!root) return { ...pick, parent, campaigns, folderId: null, folderPath: null, error: `campaign folder ${campaign.drive_folder_id} is not visible to the agent (share it with ${MAILBOX})` }
  const sub = await childFolderByPrefix(ctx.drive, campaign.drive_folder_id, rule.subfolder || "", { create: !DRY })
  const folderPath = `${await folderPathOf(ctx.drive, campaign.drive_folder_id, ctx.rootId)}/${sub.name || rule.subfolder}`
  if (sub.created) log(`vendor ${rule.name}: created "${rule.subfolder}" under ${folderPath.replace(/\/[^/]+$/, "")}`)
  return { ...pick, parent, campaigns, folderId: sub.id, folderPath, created: sub.created }
}

/** The most recent previous invoice filed into the same folder (for the diff lines), by its stored amounts. */
async function previousInvoiceMeta(folderId, exceptRowId) {
  if (DRY && !folderId) return null
  const q = sb().from("inbox_files").select("id, meta, received_at").eq("drive_folder_id", folderId).eq("doc_type", "invoice").eq("status", "filed").not("meta", "is", null).order("received_at", { ascending: false }).limit(5)
  const { data } = await q
  return (data || []).find((r) => r.id !== exceptRowId && r.meta?.invoice_no)?.meta || null
}

/**
 * File one vendor email's documents. Returns the set of attachment filenames
 * the vendor path took (filed or ignored) so the normal pipeline skips them.
 */
async function fileVendorDocuments(ctx, msg, cls, rule) {
  const handled = new Set()
  const rules = await getSetting("rules")
  const atts = relevantAttachments(msg, cls, { ignoreRelevance: true }) // an ITI invoice Haiku calls irrelevant is still the invoice
  const filed = []
  let dest = null
  for (const att of atts) {
    const decision = vendorFilingDecision(rule, att, msg)
    if (!decision.docType) continue // not a vendor doc type — the normal pipeline takes it
    handled.add(att.filename)
    const vAtt = { ...att, doc_type: decision.docType }
    if (!decision.file) {
      await recordIgnored(msg, vAtt, decision.why)
      log(`vendor ${rule.name}: ${att.filename} ignored (${decision.why})`)
      continue
    }
    const rec = await recordAttachment(ctx, msg, vAtt, cls, rules.status === "approved" ? "pending" : "waiting")
    if (!rec) continue
    if (rec.dup) {
      log(`vendor ${rule.name}: duplicate ${att.filename} (matches ${rec.dup.id})`)
      continue
    }
    if (rules.status !== "approved") continue
    dest = dest || (await vendorDestination(ctx, rule))
    const named = vendorFilename({ rule, docType: decision.docType, filename: att.cleanName, subject: msg.subject, receivedAt: msg.internalDate, bodyText: msg.text, signed: att.signed })
    const meta = decision.docType === "invoice" ? { ...named.amounts, invoice_no: named.invoice_no, campaign_id: dest.parent?.id || dest.campaign?.id || null, vendor: rule.id } : { vendor: rule.id, campaign_id: dest.parent?.id || dest.campaign?.id || null }
    if (!DRY) await sb().from("inbox_files").update({ meta, doc_type: decision.docType }).eq("id", rec.row.id)
    const rowNow = { ...rec.row, doc_type: decision.docType, meta }
    if (!dest.campaign) {
      // (3) no campaign to file into → the ❓ card (✅ guess / ✏️ tell me / ⏭ skip); nothing is filed.
      const guess = dest.candidates?.[0] ? { folder: `Marketing/<campaign "${dest.candidates[0].name}">/${rule.subfolder}`, name: named.name } : null
      await postAskCard(ctx, rowNow, `Which campaign folder is this ${rule.name} ${decision.docType.replace(/_/g, " ")} for? (${dest.why})`, guess)
      log(`vendor ${rule.name}: ${att.filename} — asked (${dest.why})`)
      continue
    }
    if (!dest.folderId && !DRY) {
      await tgSend(`⚠️ Couldn't file <b>${esc(named.name)}</b> for ${esc(rule.name)} — ${esc(dest.error || "campaign folder not resolved")}`, { dryRun: DRY })
      continue
    }
    // A4: a new invoice supersedes every unpaid, unsuperseded ITI invoice already in the folder (rename, never overwrite).
    let diff = []
    if (decision.docType === "invoice") {
      const prev = dest.folderId ? await previousInvoiceMeta(dest.folderId, rec.row.id) : null
      diff = invoiceDiffLines(prev, meta)
      const kids = dest.folderId ? (await listChildren(ctx.drive, dest.folderId)).filter((k) => k.mimeType !== "application/vnd.google-apps.folder") : []
      for (const r of supersedeRenames(kids, { exclude: named.name })) {
        if (DRY) log(`vendor ${rule.name}: would rename "${r.from}" → "${r.to}"`)
        else {
          await renameFile(ctx.drive, r.id, r.to)
          await sb().from("inbox_files").update({ final_name: r.to }).eq("drive_file_id", r.id)
          log(`vendor ${rule.name}: superseded "${r.from}" → "${r.to}"`)
        }
      }
    }
    const folderPath = dest.folderPath || `Marketing/<${dest.campaign.name}>/${rule.subfolder}`
    const r = DRY && !dest.folderId ? { ok: true, url: "(dry run)", name: named.name } : await fileToDrive(ctx, rowNow, folderPath, named.name, { suffixOnExisting: true, bytes: rec.bytes, folderId: dest.folderId })
    if (!r.ok) {
      await tgSend(`⚠️ Couldn't file <b>${esc(named.name)}</b> → ${esc(folderPath)} — ${esc(r.error)}`, { dryRun: DRY })
      continue
    }
    filed.push({ row: rowNow, folder: folderPath, name: r.name || named.name, url: r.url, diff: null, diffLines: diff, docType: decision.docType })
    log(`vendor ${rule.name}: filed ${att.filename} → ${folderPath}/${r.name || named.name}${meta.total != null ? ` (${money(meta.total)})` : ""}`)
  }
  await postVendorConfirmation(ctx, msg, rule, dest, filed)
  return handled
}

/** One confirmation per vendor email — the campaign name where a property filing shows the property; 💸 Paid on invoices. */
async function postVendorConfirmation(ctx, msg, rule, dest, filed) {
  if (!filed.length) return
  const who = rule.name || msg.from.name || msg.from.email
  const lines = [`🗂 <b>Filed ${filed.length === 1 ? "1 document" : `${filed.length} documents`}</b> from ${esc(who)} · ${ptDateLabel(msg.internalDate)} · “${esc(shortSubject(msg.subject))}”`]
  if (dest?.campaign) lines.push(`📣 ${esc(dest.parent?.name || dest.campaign.name)}`)
  for (const f of filed) {
    lines.push(`• <a href="${f.url}">${esc(f.folder.replace(/^Marketing\//, ""))}/${esc(f.name)}</a>`)
    for (const d of f.diffLines || []) lines.push(`  <i>${esc(d)}</i>`)
  }
  lines.push(`Reply to this card to move or rename any of them.`)
  const rows = filed.length <= 3 ? filed.map((f) => [{ text: `↩️ Undo ${f.name.slice(0, 24)}`, data: `ix:fu:${f.row.id}` }, ...(f.docType === "invoice" ? [{ text: "💸 Paid", data: `ix:vp:${f.row.id}` }] : [])]) : []
  const mid = await tgSend(lines.join("\n"), { rows, dryRun: DRY })
  if (!DRY && mid) await sb().from("inbox_files").update({ tg_message_id: mid }).in("id", filed.map((f) => f.row.id))
}

/** 💸 Paid (recorded by the webhook as paid_requested): rename … PAID in Drive, set the parent campaign's total_cost, rewrite the card. */
async function applyPaidRequests(ctx) {
  if (DRY) return // renames + total_cost are live writes; a dry run never applies them
  const { data: rows } = await sb().from("inbox_files").select("*").eq("status", "paid_requested").limit(10)
  for (const row of rows || []) {
    try {
      if (!ctx.drive || !ctx.rootId) throw new Error("Drive not available")
      const meta = row.meta || {}
      const newName = paidName(row.final_name)
      if (row.drive_file_id) await renameFile(ctx.drive, row.drive_file_id, newName)
      let campaignLine = ""
      if (meta.campaign_id && meta.total != null) {
        const { data: c, error } = await sb().from("campaigns").update({ total_cost: meta.total }).eq("id", meta.campaign_id).select("name").maybeSingle()
        if (error) throw new Error(`campaigns.total_cost: ${error.message}`)
        campaignLine = ` · ${esc(c?.name || "campaign")} total cost set to ${money(meta.total)}`
      }
      await sb().from("inbox_files").update({ status: "filed", final_name: newName, meta: { ...meta, paid_at: isoNow() } }).eq("id", row.id)
      log(`vendor paid: ${row.final_name} → ${newName}${campaignLine ? ` (${campaignLine.replace(/<[^>]+>/g, "").trim()})` : ""}`)
      // Rewrite the card: every file that shared it, then the paid line; the Paid button is gone, Undo stays within its window.
      const { data: siblings } = row.tg_message_id ? await sb().from("inbox_files").select("id, final_folder, final_name, drive_url, doc_type").eq("tg_message_id", row.tg_message_id).eq("status", "filed") : { data: [row] }
      const lines = [`🗂 <b>Filed</b> from ${esc(row.sender)} · ${ptDateLabel(row.received_at)} · “${esc(shortSubject(row.subject))}”`]
      for (const s of siblings || []) lines.push(`• <a href="${s.drive_url}">${esc(String(s.final_folder || "").replace(/^Marketing\//, ""))}/${esc(s.final_name)}</a>`)
      lines.push(`💸 <b>Paid</b> — ${esc(newName)}${campaignLine}`)
      const rowsKb = (siblings || []).slice(0, 3).map((s) => [{ text: `↩️ Undo ${String(s.final_name).slice(0, 24)}`, data: `ix:fu:${s.id}` }])
      if (row.tg_message_id) await tgEditText(row.tg_message_id, lines.join("\n"), { rows: rowsKb })
      else await tgSend(lines.join("\n"), { rows: rowsKb })
    } catch (e) {
      warn(`vendor paid ${row.id} failed:`, e.message)
      await sb().from("inbox_files").update({ status: "filed", error: `paid failed: ${e.message}` }).eq("id", row.id)
      await tgSend(`⚠️ Couldn't mark <b>${esc(row.final_name)}</b> paid — ${esc(e.message)}`, { replyTo: row.tg_message_id })
    }
  }
}

// ------------------------------------------------------------------ 2b. documents behind links
// Ryan 2026-10-12: the DocuSign link is "an ongoing friction point" — the
// Completed email often arrives without the PDF, so the agent used to post
// "grab it from the DocuSign link" and Ryan did it by hand. Now the link is
// queued (inbox_fetches, one row per distinct URL) and runFetches opens it in
// headless Chrome on the mini. The old notice is the failure card.
const FETCH_KINDS = new Set(["docusign_request", "docusign_completed", "esign_completed", "media_delivery"])

/** The links that queue even on a system email (f8 photos, HomeSentry reports) — the provider match is the gate, never the classifier. */
function systemLinks(msg, cls) {
  return documentLinks(msg, Array.isArray(cls?.document_links) ? cls.document_links : []).filter((l) => queuesOnSystemEmail(l.provider))
}

async function enqueueFetches(ctx, msg, cls, kind, atts = []) {
  const reported = Array.isArray(cls?.document_links) ? cls.document_links : []
  const links = documentLinks(msg, reported)
  // Ryan 2026-10-15: the f8 delivery email classifies as "automated" and the
  // classifier may not report the link — a media provider link queues regardless
  // (2026-10-16: HomeSentry's tapinspect share link likewise).
  if (!FETCH_KINDS.has(kind) && !reported.length && !links.some((l) => queuesOnSystemEmail(l.provider))) return
  if (!links.length) {
    if (kind === "docusign_completed" && !atts.length) await tgSend(`🖊 DocuSign completed — “${esc(shortSubject(msg.subject))}” — no signed PDF attached and no envelope link I can open; grab it from the email.`, { dryRun: DRY })
    return
  }
  for (const link of links) {
    const linkKind = providerKind(link.provider) === "media" ? "media_delivery" : kind
    if (DRY) {
      // --dry-run: the fetch runs right here (browser and all) with no DB
      // writes and no Drive upload; files land in /tmp/inbox-fetch/<job>/files
      // (photos: /tmp/inbox-fetch/<job>/MLS|Print).
      await runFetchJob(ctx, { id: `dry-${msg.id}`, url: link.url, provider: link.provider, gmail_id: msg.id, thread_id: msg.threadId, kind: linkKind, attempts: 0, access_code: null }, msg, cls)
      continue
    }
    const url_sha256 = sha256(link.url)
    const { data: existing } = await sb().from("inbox_fetches").select("id, status").eq("url_sha256", url_sha256).maybeSingle()
    if (existing) {
      // Part B5: HomeSentry reuses the same share URL for "results updated" — a
      // finished or parked tapinspect job goes back on the queue under the new
      // email; a queued/running one is left alone. Everything else stays a duplicate.
      if (requeueDecision(existing, link.provider, msg.subject) === "requeue") {
        await sb().from("inbox_fetches").update({ status: "queued", attempts: 0, next_try_at: null, error: null, resolved_at: null, gmail_id: msg.id, thread_id: msg.threadId, kind: linkKind }).eq("id", existing.id)
        log(`fetch requeued: ${link.provider} · was ${existing.status} · ${shortSubject(msg.subject, 50)} · ${link.url.slice(0, 70)}`)
        continue
      }
      log(`fetch: duplicate link (${existing.status} · ${existing.id}) ${link.url.slice(0, 70)}`)
      continue
    }
    const { error } = await sb().from("inbox_fetches").insert({ gmail_id: msg.id, thread_id: msg.threadId, url: link.url, url_sha256, provider: link.provider, kind: linkKind, status: "queued" })
    if (error) throw new Error(`inbox_fetches insert: ${error.message}`)
    log(`fetch queued: ${link.provider} · ${shortSubject(msg.subject, 50)} · ${link.url.slice(0, 70)}`)
  }
}

/** The email behind a fetch row — or a synthetic one for `fetch <url>` typed in Telegram. */
async function messageForFetch(ctx, job) {
  if (/^manual:/.test(job.gmail_id || "")) {
    const { data: m } = await sb().from("inbox_messages").select("subject, internal_date, classification").eq("gmail_id", job.gmail_id).maybeSingle()
    let host = "link"
    try {
      host = new URL(job.url).hostname
    } catch {}
    const msg = { id: job.gmail_id, threadId: job.thread_id || null, labelIds: [], internalDate: m?.internal_date || job.created_at || isoNow(), from: { email: MAILBOX, name: "Ryan" }, to: MAILBOX, cc: "", subject: m?.subject || `fetch ${host}`, text: job.url, attachments: [] }
    return { msg, cls: m?.classification || { kind: "manual", property: null } }
  }
  const msg = await getMessage(ctx.gmail, job.gmail_id)
  const { data: m } = await sb().from("inbox_messages").select("classification").eq("gmail_id", job.gmail_id).maybeSingle()
  return { msg, cls: m?.classification || null }
}

/** Up to 3 due jobs per pass; each one opens a browser, so this stays small.
 *  At most 1 media job per pass (a photo batch is ~255 MB and up to 10 min) so
 *  DocuSign jobs are never starved behind photo deliveries. */
async function runFetches(ctx) {
  if (DRY) return // dry runs fetch inline from enqueueFetches (nothing is queued)
  // `awaiting_payment` rows (HomeSentry, Part B4) carry a next_try_at a day out — the daily retry rides the same select.
  const { data: due, error } = await sb().from("inbox_fetches").select("*").in("status", ["queued", "awaiting_payment"]).or(`next_try_at.is.null,next_try_at.lte.${isoNow()}`).order("created_at").limit(6)
  if (error) {
    warn("inbox_fetches read:", error.message)
    return
  }
  const jobs = []
  let media = 0
  for (const job of due || []) {
    if (jobs.length >= 3) break
    if (providerKind(job.provider) === "media" && media++ >= 1) continue
    jobs.push(job)
  }
  for (const job of jobs) {
    try {
      const { msg, cls } = await messageForFetch(ctx, job)
      await runFetchJob(ctx, job, msg, cls)
    } catch (e) {
      // Ryan's rule: no silent failures on things he initiated.
      warn(`fetch ${job.id} crashed:`, e.stack || e.message)
      await failAttempt(job, (job.attempts || 0) + 1, { error: e.message, screenshot: null }, `🧨 ${e.message}`)
    }
  }
  await expireNewLinkWaits()
}

// ---- Phase 1b: expired email links (briefs/BRIEF_INBOX_LINK_FETCH_2026-10-12.md "Phase 1b")
// The flow clicks SEND NEW LINK on DocuSign's expired page; the fresh link
// lands in ryan@ and is queued like any other. The parked job waits — no card —
// until that later job for the same envelope is done (resolved_by_new_link),
// or 2 h pass (one ⚠️ card, then failed).
/** inbox_fetches rows with the email's subject folded in, the shape the pure helpers in fetch/index.mjs take. */
function withSubject(rows) {
  return (rows || []).map((r) => ({ ...r, subject: (Array.isArray(r.inbox_messages) ? r.inbox_messages[0] : r.inbox_messages)?.subject || null }))
}
/** The row that already asked DocuSign for this envelope's fresh link in the last 24 h — the "never click twice" guard. */
async function newLinkGuardFor(job, msg) {
  const since = new Date(Date.now() - NEW_LINK_GUARD_MS).toISOString()
  const { data, error } = await sb().from("inbox_fetches").select("id, status, thread_id, started_at, error, inbox_messages(subject)").like("error", `${NEW_LINK_ERROR}%`).gte("started_at", since).limit(50)
  if (error) {
    warn("inbox_fetches guard read:", error.message)
    return null
  }
  return newLinkGuard({ ...job, subject: msg.subject }, withSubject(data))
}
/** The ⚠️ card for a dead link: no Open button (it is the expired one), Retry only. */
async function expiredCard(job, reason) {
  const what = providerKind(job.provider) === "media" ? "photos" : "documents"
  const hint = job.provider === "docusign" ? ", or log the agent into DocuSign (<code>node scripts/inbox-agent/fetch/cli.mjs --login --headed</code> on the mini)" : ""
  return tgSend(`⚠️ Couldn't pull the ${what} from ${providerLabel(job.provider)} (${esc(reason)}) — ask the sender to resend${hint}.`, { rows: [[{ text: "🔁 Retry", data: `ix:fr:${job.id}` }]], dryRun: DRY })
}
/** A job for the same envelope is done → the parked awaiting_new_link rows are resolved. */
async function resolveNewLinkWaits(job, msg) {
  const { data } = await sb().from("inbox_fetches").select("id, status, thread_id, inbox_messages(subject)").eq("status", "awaiting_new_link").limit(50)
  for (const w of waitsClosedBy({ ...job, subject: msg.subject }, withSubject(data))) {
    await sb().from("inbox_fetches").update({ status: "resolved_by_new_link", resolved_at: isoNow() }).eq("id", w.id)
    log(`fetch ${w.id}: resolved by the fresh link (${job.id})`)
  }
}
/** Part B4 wake rule (a): a HomeSentry email (same share uuid, or payment/updated/results for the same property) requeues the parked report. */
async function wakePaymentWaits(msg, cls) {
  if (!/@tapinspect\.com$/i.test(msg.from.email || "")) return
  const { data, error } = await sb().from("inbox_fetches").select("id, status, provider, url, inbox_messages(subject, classification)").eq("status", "awaiting_payment").limit(50)
  if (error) return warn("inbox_fetches payment waits read:", error.message)
  const rows = (data || []).map((r) => {
    const m = Array.isArray(r.inbox_messages) ? r.inbox_messages[0] : r.inbox_messages
    return { ...r, subject: m?.subject || null, property_label: m?.classification?.property?.label || null }
  })
  for (const w of paymentWakeTargets(msg, cls, rows)) {
    if (DRY) {
      log(`fetch ${w.id}: would requeue (HomeSentry email “${shortSubject(msg.subject, 50)}”)`)
      continue
    }
    await sb().from("inbox_fetches").update({ status: "queued", attempts: 0, next_try_at: null, error: null, resolved_at: null, gmail_id: msg.id, thread_id: msg.threadId }).eq("id", w.id)
    log(`fetch ${w.id}: requeued — HomeSentry says “${shortSubject(msg.subject, 50)}”`)
  }
}
/** awaiting_new_link for more than 2 h → one ⚠️ card, then failed. */
async function expireNewLinkWaits() {
  const { data, error } = await sb().from("inbox_fetches").select("id, status, provider, url, started_at, inbox_messages(subject)").eq("status", "awaiting_new_link").limit(50)
  if (error) return warn("inbox_fetches waits read:", error.message)
  for (const w of waitsTimedOut(withSubject(data))) {
    const mid = await expiredCard(w, `the link had expired and no fresh one arrived in 2 h${w.subject ? ` for “${shortSubject(w.subject)}”` : ""}`)
    await sb().from("inbox_fetches").update({ status: "failed", error: `${NEW_LINK_ERROR} — nothing arrived in 2 h`, tg_message_id: mid, resolved_at: isoNow() }).eq("id", w.id)
    warn(`fetch ${w.id}: no fresh link in 2 h — failed`)
  }
}

/** Retry with backoff (5 min, 30 min), then give up with a card. */
async function failAttempt(job, attempts, r, reason) {
  const label = providerLabel(job.provider)
  const shot = r.screenshots?.at(-1) || r.screenshot || null
  const next = attempts < MAX_FETCH_ATTEMPTS ? nextTryAt(attempts) : null
  if (next) {
    log(`fetch ${job.id}: attempt ${attempts} failed (${r.error}) — retry at ${next}${shot ? ` · ${shot}` : ""}`)
    if (!DRY) await sb().from("inbox_fetches").update({ status: "queued", attempts, error: r.error, screenshot: shot, next_try_at: next }).eq("id", job.id)
    return
  }
  // The final card for a photo batch carries the email and the Download Center (no Undo, no Send-New-Link for f8).
  const media = providerKind(job.provider) === "media"
  const emailBtn = media && job.gmail_id && !/^manual:/.test(job.gmail_id) ? [{ text: "✉️ Email", url: gmailLink(job.gmail_id, MAILBOX) }] : []
  const text = media ? `⚠️ Couldn't file the photos from ${label} — ${esc(reason)}. Nothing was filed; open the Download Center to grab them by hand.` : `⚠️ Couldn't pull the documents from ${label} (${esc(reason)}) — open the link.`
  const mid = await tgSend(text, { rows: [[{ text: media ? "Open Download Center" : "Open", url: job.url }, ...emailBtn, { text: "🔁 Retry", data: `ix:fr:${job.id}` }]], dryRun: DRY })
  if (!DRY) await sb().from("inbox_fetches").update({ status: "failed", attempts, error: r.error, screenshot: shot, tg_message_id: mid, resolved_at: isoNow() }).eq("id", job.id)
  warn(`fetch ${job.id}: failed after ${attempts} attempts — ${r.error}${shot ? ` · screenshot ${shot}` : ""}`)
}

async function runFetchJob(ctx, job, msg, cls) {
  const label = providerLabel(job.provider)
  const subj = shortSubject(msg.subject)
  const attempts = (job.attempts || 0) + 1
  if (!DRY) await sb().from("inbox_fetches").update({ status: "running", started_at: isoNow(), attempts }).eq("id", job.id)
  log(`fetch ${job.id}: ${label} attempt ${attempts} · “${subj}” · ${job.url.slice(0, 70)}`)
  const media = providerKind(job.provider) === "media"
  const guard = media ? null : await newLinkGuardFor(job, msg) // Send-New-Link is DocuSign's; f8 has no such page
  const r = await fetchDocuments({ url: job.url, provider: job.provider, accessCode: job.access_code || null, jobId: job.id, log, sendNewLink: !guard })
  const shot = r.screenshots?.at(-1) || null
  const openBtn = { text: `${job.kind === "docusign_request" ? "🖊 " : ""}Open in ${label}`, url: job.url }
  if (!r.ok && (r.needs === "payment" || (job.status === "awaiting_payment" && !r.needs && !/share page is gone/i.test(r.error || "")))) {
    // Part B4: HomeSentry's report is behind the invoice + agreement. Park the
    // job (no card — the email already runs the "sign / pay" loop) and retry
    // daily; a transient error while parked keeps it parked rather than
    // burning the 3-attempt budget. 14 days with no release → expired, one card.
    const next = awaitingPaymentNext(attempts)
    if (next.status === "expired") {
      const mid = await tgSend(`⌛ ${label} never released the report for “${esc(subj)}” — ${AWAITING_PAYMENT_MAX_TRIES} days of daily checks (invoice paid? agreement signed?). Open the share page, or tap 🔁 once it is.`, { rows: [[{ text: "Open", url: job.url }, { text: "🔁 Retry", data: `ix:fr:${job.id}` }]], dryRun: DRY })
      if (!DRY) await sb().from("inbox_fetches").update({ status: "expired", attempts: next.attempts, error: next.error, screenshot: shot, tg_message_id: mid, resolved_at: isoNow() }).eq("id", job.id)
      warn(`fetch ${job.id}: expired — ${next.error}${shot ? ` · screenshot ${shot}` : ""}`)
      return
    }
    const error = r.needs === "payment" ? next.error : `${next.error}; last check failed: ${r.error}`
    if (!DRY) await sb().from("inbox_fetches").update({ status: "awaiting_payment", attempts: next.attempts, error, screenshot: shot, next_try_at: next.next_try_at }).eq("id", job.id)
    log(`fetch ${job.id}: awaiting_payment (try ${next.attempts}/${AWAITING_PAYMENT_MAX_TRIES}) — ${error}; next check ${next.next_try_at}${shot ? ` · ${shot}` : ""}`)
    return
  }
  if (!r.ok) {
    // Phase 1b: the link expired. Either this run asked DocuSign for a fresh
    // one, or another job for the same envelope is still waiting on its ask —
    // park this job too, no card; the fresh link's job resolves them both.
    if (r.needs === "new_link" || (r.needs === "expired" && guard?.status === "awaiting_new_link")) {
      const error = r.needs === "new_link" ? NEW_LINK_ERROR : `waiting on the fresh link ${guard.id} asked DocuSign for`
      if (!DRY) await sb().from("inbox_fetches").update({ status: "awaiting_new_link", error, screenshot: shot }).eq("id", job.id)
      log(`fetch ${job.id}: link expired — ${error}; waiting for DocuSign's email (no card)${shot ? ` · ${shot}` : ""}`)
      return
    }
    if (r.needs === "expired") {
      const reason = guard ? "the link has expired and a fresh one was already requested in the last 24 h" : "the link has expired"
      const mid = await expiredCard(job, reason)
      if (!DRY) await sb().from("inbox_fetches").update({ status: "expired", error: r.error, screenshot: shot, tg_message_id: mid, resolved_at: isoNow() }).eq("id", job.id)
      warn(`fetch ${job.id}: expired — ${r.error}${shot ? ` · screenshot ${shot}` : ""}`)
      return
    }
    if (r.needs === "access_code") {
      const text = `🔐 ${label} wants an access code for “${esc(subj)}”. Reply to this card with  code: 1234  and I'll pull the documents.`
      const mid = await tgSend(text, { rows: [[openBtn]], dryRun: DRY })
      if (!DRY) await sb().from("inbox_fetches").update({ status: "needs_code", error: r.error, screenshot: shot, tg_message_id: mid }).eq("id", job.id)
      log(`fetch ${job.id}: needs access code${shot ? ` · ${shot}` : ""}`)
      return
    }
    if (r.needs === "login") {
      const mid = await tgSend(`⚠️ Couldn't pull the documents from ${label} (it wants a login or ID check) — open the link.`, { rows: [[{ text: "Open", url: job.url }, { text: "🔁 Retry", data: `ix:fr:${job.id}` }]], dryRun: DRY })
      if (!DRY) await sb().from("inbox_fetches").update({ status: "needs_login", error: r.error, screenshot: shot, tg_message_id: mid, resolved_at: isoNow() }).eq("id", job.id)
      warn(`fetch ${job.id}: needs_login — ${r.error}${shot ? ` · screenshot ${shot}` : ""}`)
      return
    }
    await failAttempt(job, attempts, r, r.error)
    return
  }
  if (media) return filePhotos(ctx, msg, cls, job, r, attempts)

  // Keep the bytes (a later ✅/✏️/↩️ re-reads them like an attachment), then
  // file through the same pipeline as attachments.
  const files = r.files
  if (DRY) {
    const dir = path.join("/tmp/inbox-fetch", String(job.id), "files")
    fs.mkdirSync(dir, { recursive: true })
    for (const f of files) fs.writeFileSync(path.join(dir, sanitizeFilename(f.filename)), f.bytes)
    log(`fetch ${job.id}: dry run — ${files.length} file(s) in ${dir}`)
  } else {
    for (const f of files) saveFetchedBytes(job.id, f.bytes)
  }
  // The classifier saw an email with no attachments; run it once more with the
  // pulled documents listed so each one gets a doc_type / property like an attachment would.
  const cls2 = files.length ? await classify(ctx, { ...msg, attachments: files.map((f) => ({ filename: f.filename, mime: f.mime, size: f.bytes.length, inline: false })) }) : null
  const merged = { ...(cls || {}), attachments: cls2?.attachments || cls?.attachments || [], property: cls?.property || cls2?.property || null }
  if (!DRY && cls2) await sb().from("inbox_messages").update({ classification: merged }).eq("gmail_id", msg.id)
  const docs = fetchedDocs(files, msg, merged, job.provider)
  const { filed, outcomes } = await fileDocuments(ctx, msg, merged, docs, { source: job.kind === "manual" ? "manual" : job.provider, fetchId: DRY ? null : job.id })
  // Part C (2026-10-17): a FILED HomeSentry report is a completion — the "sign / pay"
  // loops and the results loop for that property are done, whatever the email said.
  if (job.provider === "tapinspect") {
    for (const f of filed) if (f.row.doc_type === "inspection" && f.row.property_label) await resolveByCompletion(ctx, reportFiledEvent(f.row.property_label), msg)
  }

  const lines = [`📥 <b>Pulled ${files.length === 1 ? "1 document" : `${files.length} documents`} from ${label}</b> — “${esc(subj)}”`, ...filedLines(filed)]
  for (const o of outcomes.filter((x) => x.outcome !== "filed")) lines.push(`• ${esc(o.filename)} — ${o.outcome}${o.why ? ` (${esc(shortSubject(o.why, 80))})` : ""}`)
  if (!files.length) lines.push("The envelope opened but held no documents to download.")
  if (filed.length) lines.push(`Reply to this card to move or rename any of them.`)
  const rows = [...(job.kind === "docusign_request" ? [[openBtn]] : []), ...undoRows(filed)]
  // Every pulled file was already on file (a forward of the same share link, an
  // unchanged "updated" report) → nothing to show; a card here is the double alert
  // Ryan saw on 2026-10-16. Log it and finish the job quietly.
  const allDuplicates = files.length > 0 && !filed.length && outcomes.length > 0 && outcomes.every((o) => o.outcome === "duplicate")
  if (allDuplicates) log(`fetch ${job.id}: ${files.length} file(s), all already filed — no card`)
  const mid = allDuplicates ? null : await tgSend(lines.join("\n"), { rows, dryRun: DRY })
  if (!DRY) {
    if (mid && filed.length) await sb().from("inbox_files").update({ tg_message_id: mid }).in("id", filed.map((f) => f.row.id))
    const { data: rowsForJob } = await sb().from("inbox_files").select("id, filename, sha256").eq("fetch_id", job.id)
    const byHash = new Map((rowsForJob || []).map((x) => [x.sha256, x.id]))
    const summary = files.map((f) => {
      const hash = sha256(f.bytes)
      return { filename: f.filename, mime: f.mime, size: f.bytes.length, sha256: hash, inbox_file_id: byHash.get(hash) || null }
    })
    await sb().from("inbox_fetches").update({ status: "done", attempts, files: summary, screenshot: shot, tg_message_id: mid, resolved_at: isoNow(), error: null }).eq("id", job.id)
    await resolveNewLinkWaits(job, msg)
  }
  log(`fetch ${job.id}: done — ${files.length} file(s), ${filed.length} filed`)
}

// ------------------------------------------------------------------ 2c. listing photos (f8)
// Ryan 2026-10-15: both sets (Web/MLS + Print) go to Properties/<full address>/
// Photos/{MLS,Print}, photographer filenames kept, never the same photo twice,
// near-duplicates mentioned on the card, never a silently created property
// folder. The MLS listing sheet the agent emails separately stays unfiled and
// there is no "Marketing" subfolder under a property. No ↩️ Undo for a batch.
const PHOTO_SETS = { MLS: "MLS", Print: "Print" }

/** The property folder for a photo batch: Ryan's reply (proposed_folder on the
 *  ask row) wins; else the classifier's label / the subject, matched against an
 *  EXISTING full-address folder — the hand-made "Halleck" folder never matches
 *  "5764 Halleck Dr" on its own. Never creates a property folder. */
async function photoPropertyFolder(ctx, job, label) {
  await loadTree(ctx)
  if (!DRY && job.id) {
    const { data: asked } = await sb().from("inbox_files").select("proposed_folder").eq("fetch_id", job.id).eq("status", "answered").not("proposed_folder", "is", null).order("resolved_at", { ascending: false }).limit(1)
    const answered = asked?.[0]?.proposed_folder
    if (answered) {
      const byPath = ctx.propFolders.find((f) => f.path.toLowerCase() === answered.toLowerCase())
      const byName = propertyFolderFor(ctx, answered.replace(/^Properties\//i, "").split("/").at(-1))
      // Ryan named it himself — creating that folder is his call, not the agent's guess.
      return { pf: byPath || byName || { id: null, name: answered.split("/").at(-1), path: answered }, answered: true }
    }
  }
  // Full-address convention only: the folder's key must equal the label's key
  // ("5764 Halleck Dr" ↔ "5764 Halleck Drive" both key to 5764halleck) and
  // start with the street number — keysMatch alone would let the hand-made
  // "Halleck" folder claim every Halleck delivery.
  const key = propertyKey(label)
  const pf = key && /^\d/.test(key) ? ctx.propFolders.filter((f) => !/^(19|20)\d{2}$|^old$/i.test(f.name)).find((f) => propertyKey(f.name) === key) || null : null
  return { pf, answered: false }
}

/** One ❓ card on the first image's row; the job parks as needs_property until Ryan replies (or skips). */
async function askPhotoProperty(ctx, msg, job, r, label) {
  const first = r.sets.find((s) => s.files.length)?.files[0]
  const question = `New property? I don't have a folder for ${label || "this listing"} (${r.counts.mls} photos from f8). Reply with the folder, or \`skip\`.`
  const base = { gmail_id: msg.id, thread_id: msg.threadId, attachment_id: first ? `f8:${first.imageId}:MLS` : null, part_id: null, filename: first?.filename || "photos", mime: first?.mime || "image/jpeg", size_bytes: first?.bytes.length || 0, sha256: first ? sha256(first.bytes) : null, source: job.provider, fetch_id: DRY ? null : job.id, sender: msg.from.email, subject: msg.subject, received_at: msg.internalDate, property_key: propertyKey(label), property_label: label, doc_type: "photos", status: "asked" }
  let row = { ...base, id: "dry-run" }
  if (!DRY) {
    const { data, error } = await sb().from("inbox_files").insert(base).select("*").single()
    if (error) throw new Error(`inbox_files insert: ${error.message}`)
    row = data
  }
  await postAskCard(ctx, row, question, null)
  if (!DRY) await sb().from("inbox_fetches").update({ status: "needs_property", error: `no property folder for ${label || "this listing"}`, resolved_at: null }).eq("id", job.id)
  log(`photos ${job.id}: no folder for ${label || "?"} — asked (needs_property)`)
}

/**
 * File a photo delivery (fetchF8 result) into Photos/MLS + Photos/Print, dedupe
 * three ways per file, record inbox_files rows, label the email, post ONE card.
 * Never calls classify / fetchedDocs / fileDocuments / refineDocType / verifyProperty.
 */
async function filePhotos(ctx, msg, cls, job, r, attempts) {
  const label = cls?.property?.label || propertyLabelFromSubject(msg.subject)
  const { pf, answered } = await photoPropertyFolder(ctx, job, label)
  if (!pf) return askPhotoProperty(ctx, msg, job, r, label)
  const property = answered ? pf.name : label
  const key = propertyKey(property)
  if (!DRY && (!ctx.drive || !ctx.rootId)) return failAttempt(job, attempts, { error: `Drive not available — ${ctx.driveErr || "setup incomplete"}` }, "Drive is not available")

  // Dedupe inputs: every sha already on file, every f8 image id already filed for this property.
  const allFiles = r.sets.flatMap((s) => s.files.map((f) => ({ ...f, set: s.set, sha: sha256(f.bytes) })))
  const knownShas = new Set()
  const knownImageIds = new Set()
  for (let i = 0; i < allFiles.length; i += 100) {
    const { data } = await sb().from("inbox_files").select("sha256").in("sha256", allFiles.slice(i, i + 100).map((f) => f.sha)).in("status", DUP_STATUSES)
    for (const x of data || []) knownShas.add(x.sha256)
  }
  if (key) {
    const { data } = await sb().from("inbox_files").select("attachment_id").eq("property_key", key).eq("status", "filed").like("attachment_id", "f8:%")
    for (const x of data || []) knownImageIds.add(x.attachment_id)
  }

  const photosPath = `${pf.path}/Photos`
  const canRead = !!(ctx.drive && ctx.rootId) // a dry run without Drive still reports verdicts
  const photosFolder = canRead ? await resolvePath(ctx.drive, ctx.rootId, photosPath, { create: !DRY }) : { id: null }
  const dryDir = path.join("/tmp/inbox-fetch", String(job.id))
  const stats = {} // set → { new, dup, reedited, differed }
  const rows = []
  const errors = []
  for (const s of r.sets) {
    const destPath = `${photosPath}/${PHOTO_SETS[s.set]}`
    const dest = canRead ? await resolvePath(ctx.drive, ctx.rootId, destPath, { create: !DRY }) : { id: null }
    const folderFiles = dest.id ? (await listChildren(ctx.drive, dest.id)).filter((k) => k.mimeType !== "application/vnd.google-apps.folder").map((k) => ({ name: k.name, size: k.size == null ? null : Number(k.size), id: k.id, webViewLink: k.webViewLink })) : []
    const st = (stats[s.set] = { new: 0, dup: 0, reedited: 0, differed: 0 })
    if (!dest.id) log(`photos ${job.id}: ${destPath} does not exist yet — ${DRY ? "would create it" : "created"}`)
    for (const f of allFiles.filter((x) => x.set === s.set)) {
      const imageKey = `f8:${f.imageId}:${s.set}`
      const v = photoDedupeVerdict({ sha: f.sha, filename: f.filename, size: f.bytes.length, imageId: imageKey }, { knownShas, folderFiles, knownImageIds })
      const base = { gmail_id: msg.id, thread_id: msg.threadId, attachment_id: imageKey, part_id: null, filename: f.filename, mime: f.mime, size_bytes: f.bytes.length, sha256: f.sha, source: job.provider, fetch_id: DRY ? null : job.id, sender: msg.from.email, subject: msg.subject, received_at: msg.internalDate, property_key: key, property_label: property, doc_type: "photos" }
      if (v.verdict === "duplicate") {
        st.dup++
        if (v.reason === "image_id") st.reedited++
        log(`photos ${job.id}: ${s.set}/${f.filename} duplicate (${v.reason})${v.existing ? ` → ${v.existing.id}` : ""}`)
        rows.push({ ...base, status: "duplicate", error: `duplicate: ${v.reason}`, final_folder: destPath, final_name: v.existing?.name || null, drive_file_id: v.existing?.id || null, drive_url: v.existing?.webViewLink || null, resolved_at: isoNow() })
        continue
      }
      const name = v.suffix ? suffixedFilename(f.filename, folderFiles.map((x) => x.name)) : f.filename
      if (v.suffix) st.differed++
      if (DRY) {
        const dir = path.join(dryDir, s.set)
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, sanitizeFilename(name)), f.bytes)
        log(`photos ${job.id}: ${s.set}/${name} → would upload to ${destPath}${v.suffix ? " (same name, different size)" : ""}`)
        st.new++
        folderFiles.push({ name, size: f.bytes.length })
        knownShas.add(f.sha)
        continue
      }
      try {
        const up = await uploadFile(ctx.drive, dest.id, name, f.mime, f.bytes)
        st.new++
        rows.push({ ...base, status: "filed", final_folder: destPath, final_name: name, drive_file_id: up.id, drive_folder_id: dest.id, drive_url: up.webViewLink, filed_at: isoNow(), resolved_at: isoNow() })
        folderFiles.push({ name, size: f.bytes.length, id: up.id, webViewLink: up.webViewLink })
        knownShas.add(f.sha)
        knownImageIds.add(imageKey)
      } catch (e) {
        const error = e?.response?.data?.error?.message || e.message
        errors.push(`${s.set}/${name}: ${error}`)
        warn(`photos ${job.id}: upload ${s.set}/${name} failed — ${error}`)
      }
    }
  }
  const line2 = Object.entries(stats).map(([set, st]) => `${set}: ${st.new} new${st.dup ? `, ${st.dup} skipped as duplicate${st.dup === 1 ? "" : "s"}` : ""}`).join(" · ")
  if (DRY) return log(`photos ${job.id}: dry run — ${line2} · files in ${dryDir} · property ${pf.path}`)

  // Rows first (so a crash after upload still leaves a trace), then the job, the label, the card.
  let inserted = []
  for (let i = 0; i < rows.length; i += 100) {
    const { data, error } = await sb().from("inbox_files").insert(rows.slice(i, i + 100)).select("id, sha256, attachment_id, status")
    if (error) throw new Error(`inbox_files insert: ${error.message}`)
    inserted.push(...(data || []))
  }
  if (errors.length) {
    // Partial upload: the next attempt dedupes what already landed (sha / name+size) and finishes the rest.
    await failAttempt(job, attempts, { error: `${errors.length} of ${allFiles.length} uploads failed — ${errors[0]}` }, `${errors.length} upload${errors.length === 1 ? "" : "s"} failed: ${errors[0]}`)
    return
  }
  if (!/^manual:/.test(msg.id)) await addLabel(ctx.gmail, msg.id, "MC/Filed")
  const reedited = Object.values(stats).reduce((n, st) => n + st.reedited, 0)
  const differed = Object.values(stats).reduce((n, st) => n + st.differed, 0)
  const sites = propertyWebsiteLinks(msg.text)
  const lines = [`📸 <b>Photos filed — ${esc(property)}</b>`, line2]
  if (reedited) lines.push(`⚠️ ${reedited} looked like existing photos (re-edited?) — kept the originals`)
  if (differed) lines.push(`ℹ️ ${differed} looked like a duplicate but differed — uploaded with a (2) suffix`)
  const buttons = [{ text: "Open Photos/", url: photosFolder.id ? `https://drive.google.com/drive/folders/${photosFolder.id}` : job.url }]
  if (sites.branded) buttons.push({ text: "🌐 Branded site", url: sites.branded })
  if (sites.unbranded) buttons.push({ text: "🌐 Unbranded site", url: sites.unbranded })
  const mid = await tgSend(lines.join("\n"), { rows: [buttons.slice(0, 1), ...(buttons.length > 1 ? [buttons.slice(1)] : [])], dryRun: DRY })
  const idByKey = new Map(inserted.map((x) => [`${x.attachment_id}|${x.sha256}`, x.id]))
  const summary = allFiles.map((f) => ({ filename: f.filename, mime: f.mime, size: f.bytes.length, sha256: f.sha, set: f.set, imageId: f.imageId, inbox_file_id: idByKey.get(`f8:${f.imageId}:${f.set}|${f.sha}`) || null }))
  await sb().from("inbox_fetches").update({ status: "done", attempts, files: summary, tg_message_id: mid, resolved_at: isoNow(), error: null }).eq("id", job.id)
  if (mid) await sb().from("inbox_files").update({ tg_message_id: mid }).eq("fetch_id", job.id).eq("status", "filed")
  await sb().from("inbox_files").update({ status: "resolved", resolved_at: isoNow() }).eq("fetch_id", job.id).in("status", ["asked", "answered"])
  log(`photos ${job.id}: done — ${line2} → ${photosPath}`)
}

async function handleMessage(ctx, msg) {
  let cls = await classify(ctx, msg)
  const kind = cls?.kind || "human"
  await insertMessage(msg, kind, cls)
  if (!cls) return
  log(`${msg.from.email} · ${shortSubject(msg.subject, 50)} → ${kind}${cls.property?.label ? ` · ${cls.property.label}` : ""}${cls.needs_reply ? " · needs reply" : ""}`)
  // Ryan 2026-10-17 (Part C): a vendor completion — HomeSentry "Thank you for your
  // payment" / "results … have been updated", FreshBooks "… ($0.00)" — CLOSES the
  // loops and loose ends for that property / invoice and never opens one (the
  // loopEligible gate below sees the same event).
  const completion = completionEvent(msg, cls)
  if (completion) {
    log(`completion event: ${completion.vendor} ${completion.kind}${completion.property ? ` · ${completion.property}` : ""}${completion.invoice ? ` · invoice ${completion.invoice}` : ""}${completion.shareId ? ` · share ${completion.shareId.slice(0, 8)}…` : ""}`)
    await resolveByCompletion(ctx, completion, msg)
  }
  // Ryan 2026-10-05: Kiavi's servicing desk sent the ACH form for the Halleck
  // draws from servicing@ — the classifier said "needs reply" but the kind was
  // "automated" and this return threw the ask away. A system-looking sender that
  // needs something from Ryan is still a loop.
  // Ryan 2026-10-15: f8's "Media Delivery" email is automated — and it is the
  // one carrying the listing photos. A media provider link on a system email
  // (or a classified media_delivery) queues the photo pull and nothing else:
  // no loops, no screens. The provider match is the gate, not the classifier.
  // Ryan 2026-10-16: ITI Direct Mail's invoices / signed proofs / quotes / tax
  // form file into the campaign folder (vendors.mjs) — before the system-email
  // return, because PandaDoc's "Signed copy" relay is machine-sent. The vendor
  // path takes only the vendor doc types; everything else on the email keeps
  // its normal handling (filing pipeline, loops, needs-reply).
  const vendor = matchVendor(msg, vendorRules(await getSetting("vendors")))
  const vendorHandled = vendor ? await fileVendorDocuments(ctx, msg, cls, vendor) : new Set()
  // Ryan 2026-10-15: f8's "Media Delivery" email is automated — and it is the
  // one carrying the listing photos. A media provider link on a system email
  // (or a classified media_delivery) queues the photo pull and nothing else:
  // no loops, no screens. The provider match is the gate, not the classifier.
  // 2026-10-16: HomeSentry's tapinspect share link queues the same way, and a
  // HomeSentry email wakes any report parked behind its invoice (Part B4).
  if (kind === "media_delivery" || ((kind === "automated" || kind === "newsletter" || kind === "skip") && !(cls.needs_reply && !cls.solicitation))) {
    const links = systemLinks(msg, cls)
    if (links.length) await enqueueFetches(ctx, msg, cls, links.some((l) => providerKind(l.provider) === "media") ? "media_delivery" : kind)
    await wakePaymentWaits(msg, cls)
    // 2026-10-16 (South Bay Termite "Termite Report & Receipt | <address>" came
    // back as "automated"): a system-looking email can still carry a whitelisted
    // transaction document on a known property. File those — nothing else runs.
    if (kind !== "media_delivery") {
      const docs = relevantAttachments(msg, cls).filter((a) => !vendorHandled.has(a.filename) && WHITELIST.has(a.doc_type))
      if (docs.length) {
        const { filed } = await fileDocuments(ctx, msg, cls, docs, { source: "attachment" })
        await postFiledConfirmation(ctx, msg, filed)
      }
    }
    return
  }

  // --- attachments → the filing pipeline (shared with documents pulled from links).
  const atts = relevantAttachments(msg, cls).filter((a) => !vendorHandled.has(a.filename))
  const { filed, pdfDocs } = await fileDocuments(ctx, msg, cls, atts, { source: "attachment" })
  await postFiledConfirmation(ctx, msg, filed)

  // --- documents behind links (DocuSign first; briefs/BRIEF_INBOX_LINK_FETCH_2026-10-12.md)
  await enqueueFetches(ctx, msg, cls, kind, atts)
  await wakePaymentWaits(msg, cls)

  // --- secure-portal notices with nothing attached
  if (kind === "zix" && !atts.length && /portal|secure message center|view message|retrieve/i.test(msg.text)) {
    await tgSend(`🔐 Zix secure message from ${esc(msg.from.name || msg.from.email)} — “${esc(shortSubject(msg.subject))}” — no attachment came through; it's waiting in the Zix portal.`, { dryRun: DRY })
  }

  // --- open loops (things Ryan owes someone)
  if (kind === "docusign_completed" || kind === "esign_completed") await resolveSignatureLoops(msg)
  // Ryan 2026-10-03: flyers were reaching him as "Waiting on you" loops — the
  // classifier read "attend the open house Thursday" as an ask. Marketing from
  // someone he hasn't done business with never becomes a loop.
  const isBlast = kind === "broker_blast" || cls.deal?.tier === "blast" || cls.solicitation === true
  const knownSender = isBlast ? await isKnownSender(msg.from.email) : true
  const muted = await isMutedSender(msg.from.email)
  if (muted) {
    log(`muted sender ${msg.from.email}: no loop, no screen`)
    return
  }
  if (isBlast && !knownSender) {
    log(`no loop: marketing from unknown sender (${msg.from.email})`)
  } else {
    // A person who pitched Ryan a deal directly is owed an answer, whatever the screen says.
    if (cls.deal?.tier === "direct" && !cls.needs_reply) cls = { ...cls, needs_reply: true, ask: cls.ask || `Reply to ${cls.counterparty || msg.from.name || msg.from.email} about ${cls.deal.address || "their deal"}`, category: cls.category || "agent" }
    // Ryan 2026-10-12: a "Completed:" envelope never opens a loop — it only closes one (loops.mjs).
    if (loopEligible(kind, msg, cls) && (cls.needs_reply || kind === "docusign_request")) await upsertLoop(ctx, msg, cls, kind)
    else if (!loopEligible(kind, msg, cls)) log(`no loop: ${completion ? `${completion.vendor} ${completion.kind}` : kind} is a completion event`)
  }

  // --- deals
  if (cls.deal && (kind === "deal_lead" || kind === "broker_blast" || cls.deal.tier)) await screenDeal(ctx, msg, cls, pdfDocs)
}

// ------------------------------------------------------------------ loops
// normalizeEnvelope / envelopeMatches / loopEligible live in loops.mjs (unit-tested).
async function upsertLoop(ctx, msg, cls, kind) {
  const isSig = kind === "docusign_request"
  const category = isSig ? "signature" : cls.category || "other"
  const ask = isSig ? `Sign: ${shortSubject(msg.subject.replace(/^(reminder:\s*)?(please sign:?\s*)?/i, ""))}` : cls.ask || cls.summary
  const priority = isSig ? "high" : cls.priority || "normal"
  // 2026-10-17: message_at (Part A), loop_key (Part D) and owed_by (Part F) ride every loop.
  const key = loopKey(msg, cls)
  const owed_by = owedBy(cls)
  // On a refresh, owed_by moves only when the classifier said so explicitly — a null never undoes Ryan's "theirs".
  // Part H: a portal ask (sign/pay outside email) is asked about once in the brief, then parked as `asked`.
  const resolution = resolutionKind(msg, cls, kind)
  const incoming = { gmail_id: msg.id, message_at: msg.internalDate, due_on: cls.due_on || null, priority, ask, loop_key: key, owed_by: cls.owed_by === "them" || cls.owed_by === "ryan" ? cls.owed_by : null }
  // Same thread first, then the same signature envelope, then (Part D) the same ask
  // from the same vendor family for the same property within 48 h — the three Quito
  // emails (HomeSentry booking, "Please sign agreement", Amanda's forward) are one loop.
  // An `asked` loop matches at any age: a vendor reminder reopens it (asked → open).
  const live = ["open", "snoozed", "asked"]
  const { data: open } = await sb().from("inbox_loops").select("*").eq("thread_id", msg.threadId).in("status", live).limit(1)
  let loop = open?.[0] || null
  let how = loop ? "thread" : null
  if (isSig) {
    const { data: sig } = await sb().from("inbox_loops").select("*").eq("category", "signature").in("status", live).limit(50)
    const env = (sig || []).find((l) => normalizeEnvelope(l.subject) === normalizeEnvelope(msg.subject)) || null
    if (env) {
      loop = env
      how = "envelope"
    }
  }
  if (!loop) {
    const since = new Date(Date.now() - LOOP_KEY_WINDOW_MS).toISOString()
    const { data: keyed } = await sb().from("inbox_loops").select("*").eq("loop_key", key).in("status", live).or(`created_at.gte.${since},status.eq.asked`).order("created_at").limit(10)
    loop = loopKeyMatch(keyed || [], key)
    if (loop) how = "key"
  }
  const now = isoNow()
  if (DRY) {
    log(`loop: ${ask} (${priority} · ${owed_by} · ${resolution} · ${key})${loop ? ` — would refresh ${loop.id} (same ${how}${loop.status === "asked" ? ", reopens an asked loop" : ""})` : ""}`)
    return
  }
  if (loop) {
    await sb().from("inbox_loops").update({ ...mergeLoop(loop, incoming, { sameThread: how === "thread" }), ...(loop.resolution ? {} : { resolution }) }).eq("id", loop.id)
    log(`loop ${loop.status === "asked" ? "reopened" : "refreshed"} (same ${how}): ${loop.id} ← ${msg.id}`)
    return
  }
  const { data } = await sb().from("inbox_loops").insert({
    thread_id: msg.threadId, gmail_id: msg.id, subject: msg.subject, counterparty: cls.counterparty || msg.from.name || msg.from.email, counterparty_email: msg.from.email,
    category, ask, due_on: cls.due_on || null, priority, status: "open", message_at: msg.internalDate, loop_key: key, owed_by, resolution,
  }).select("*").single()
  // Ryan 2026-09-25: "I don't need Telegram giving me a second alert on every
  // single email." Loops are tracked silently and surface in the brief /
  // `open`. inbox_settings.agent.loop_alerts: "off" (default) | "deadline"
  // (due within 24h only) | "high" (old behaviour).
  const mode = (await getSetting("agent")).loop_alerts || "off"
  const dueSoon = cls.due_on && new Date(cls.due_on + "T23:59:59-07:00").getTime() - Date.now() < 24 * 3600_000
  const alert = mode === "high" ? priority === "high" : mode === "deadline" ? !!dueSoon : false
  if (data && alert) {
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
  // Ryan 2026-10-12: also closes loops whose subject still carries a leading
  // "Completed:" (every stacked prefix is stripped before comparing).
  const { data: sig } = await sb().from("inbox_loops").select("id, subject, tg_message_id").eq("category", "signature").in("status", LOOP_ACTIVE_STATUSES).limit(50)
  for (const l of sig || []) {
    if (envelopeMatches(l.subject, msg.subject)) {
      log(`loop resolved by completion: ${l.id} (${shortSubject(l.subject, 50)})`)
      await sb().from("inbox_loops").update({ status: "resolved_by_event", resolved_at: isoNow() }).eq("id", l.id)
      await tgClearButtons(l.tg_message_id)
    }
  }
}
/** Ryan's sent mail over the last SENT_LOOKBACK_DAYS, by thread and by recipient — read once per pass (resolveLoops + the digest). */
async function sentFor(ctx) {
  if (!ctx.sent) ctx.sent = await sentSince(ctx.gmail, SENT_LOOKBACK_DAYS)
  return ctx.sent
}
async function resolveLoops(ctx) {
  const { data: open } = await sb().from("inbox_loops").select("id, thread_id, counterparty_email, created_at, message_at, tg_message_id, status, snooze_until").in("status", LOOP_ACTIVE_STATUSES).limit(500)
  if (!open?.length) return
  const sent = await sentFor(ctx)
  const now = isoNow()
  for (const l of open) {
    // Snoozed items and "Got it"-acknowledged items with a due date both carry a
    // snooze_until; when it passes they reopen (acknowledged with no due date has
    // snooze_until null, so it stays muted for good).
    if ((l.status === "snoozed" || l.status === "acknowledged") && l.snooze_until && l.snooze_until <= now) {
      if (!DRY) await sb().from("inbox_loops").update({ status: "open", snooze_until: null }).eq("id", l.id)
    }
    // Parts A + B: a sent message counts when it is newer than the EMAIL (message_at,
    // not the row's created_at), on the loop's thread OR to its counterparty on any thread.
    const how = answeredBy(l, sent)
    if (how) {
      if (!DRY) {
        await sb().from("inbox_loops").update({ status: "resolved_by_reply", resolved_at: now }).eq("id", l.id)
        await tgClearButtons(l.tg_message_id)
      }
      log(`loop resolved by reply (same ${how}): ${l.id}`)
    }
  }
}

// ---- Part C: vendor completions (briefs/BRIEF_INBOX_LOOP_HYGIENE_2026-10-17.md)
/** tapinspect share uuids queued in inbox_fetches over the last 30 days, by thread — the cheap way to tie a loop or an Unanswered thread to an inspection job. */
async function shareIdsByThread(ctx) {
  if (!ctx.shareIdsByThread) {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const { data } = await sb().from("inbox_fetches").select("thread_id, url").eq("provider", "tapinspect").gte("created_at", since).limit(500)
    const map = new Map()
    for (const f of data || []) {
      const id = tapinspectShareId(f.url)
      if (!id || !f.thread_id) continue
      if (!map.has(f.thread_id)) map.set(f.thread_id, [])
      map.get(f.thread_id).push(id)
    }
    ctx.shareIdsByThread = map
  }
  return ctx.shareIdsByThread
}
/** The context completionCloses compares against: share uuids on the loop's thread, the classifier's property, and — only when those don't decide and the event carries a share uuid — the loop email's body from Gmail. */
async function loopContext(ctx, loop, event) {
  const shareIds = loop.thread_id ? (await shareIdsByThread(ctx)).get(loop.thread_id) || [] : []
  let propertyLabel = null
  let text = ""
  if (loop.gmail_id) {
    const { data: m } = await sb().from("inbox_messages").select("classification").eq("gmail_id", loop.gmail_id).maybeSingle()
    propertyLabel = m?.classification?.property?.label || null
    if (event.shareId && !completionCloses(event, loop, { shareIds, propertyLabel })) {
      ctx.bodyCache = ctx.bodyCache || new Map()
      if (!ctx.bodyCache.has(loop.gmail_id)) ctx.bodyCache.set(loop.gmail_id, await getMessage(ctx.gmail, loop.gmail_id).then((x) => x.text || "").catch(() => ""))
      text = ctx.bodyCache.get(loop.gmail_id)
    }
  }
  return { shareIds, propertyLabel, text }
}
/**
 * A completion event closes every matching open/snoozed/acknowledged loop
 * (resolved_by_event, buttons cleared) and dismisses the matching Unanswered
 * threads from the same vendor in the last 10 days via agent.unanswered_dismissed
 * — the map the digest already honours, so it needs no new logic.
 */
async function resolveByCompletion(ctx, event, msg) {
  if (!event) return
  const { data: loops } = await sb().from("inbox_loops").select("*").in("status", LOOP_ACTIVE_STATUSES).limit(500)
  for (const l of loops || []) {
    if (l.gmail_id === msg.id) continue
    const extra = await loopContext(ctx, l, event)
    if (!completionCloses(event, l, extra)) continue
    log(`loop resolved by completion (${event.vendor} ${event.kind}${event.property ? ` · ${event.property}` : ""}): ${l.id} (${shortSubject(l.subject, 50)})`)
    if (DRY) continue
    await sb().from("inbox_loops").update({ status: "resolved_by_event", resolved_at: isoNow() }).eq("id", l.id)
    if (l.tg_message_id) await tgClearButtons(l.tg_message_id)
  }
  const since = new Date(Date.now() - 10 * 86_400_000).toISOString()
  const { data: rows } = await sb().from("inbox_messages").select("gmail_id, thread_id, sender, subject, classification").gte("internal_date", since).neq("gmail_id", msg.id).order("internal_date", { ascending: false }).limit(400)
  const shares = await shareIdsByThread(ctx)
  const agent = await getSetting("agent")
  const dismissed = { ...(agent.unanswered_dismissed || {}) }
  const seen = new Set()
  let added = 0
  for (const r of rows || []) {
    if (!r.thread_id || r.thread_id === msg.threadId || seen.has(r.thread_id) || dismissed[r.thread_id]) continue
    seen.add(r.thread_id)
    if (!completionDismisses(event, r, { shareIds: shares.get(r.thread_id) || [] })) continue
    log(`unanswered dismissed by completion (${event.vendor} ${event.kind}): ${r.thread_id} (${shortSubject(r.subject, 50)})`)
    dismissed[r.thread_id] = isoNow()
    added++
  }
  if (added && !DRY) await setSetting("agent", { unanswered_dismissed: dismissed })
}

// ------------------------------------------------------------------ deals
async function screenDeal(ctx, msg, cls, pdfDocs) {
  const tier = cls.deal.tier || (cls.kind === "deal_lead" ? "direct" : "blast")
  const blob = `${msg.subject}\n${msg.text}\n${cls.deal.address || ""}\n${cls.deal.notes || ""}\n${(cls.attachments || []).map((a) => a.description).join("\n")}`
  const pre = blastSignalsPass(blob)
  const signals = pre.signals
  const known = tier === "direct" ? true : await isKnownSender(msg.from.email)
  // On-market retail dressed up with "fixer" is still retail (Ryan 2026-10-03, Lindy Ngo).
  const retail = pre.onMarket || (cls.deal.is_retail_listing === true && !cls.deal.off_market && !pre.offMarket)
  if (tier !== "direct" && !known && (!signals.length || (cls.deal.address && !pre.inArea) || pre.condo || cls.deal.property_type === "condo_townhome" || retail)) {
    log(`blast ${cls.deal.address || "?"}: hidden (unknown sender; ${!signals.length ? "no signals" : !pre.inArea && cls.deal.address ? "out of area" : pre.condo || cls.deal.property_type === "condo_townhome" ? "condo/townhome" : "on-market retail listing"})`)
    return
  }
  const docs = tier === "direct" ? pdfDocs.slice(0, 2) : pdfDocs.slice(0, 1)
  const { data: past } = await sb().from("inbox_deal_screens").select("address, verdict, ryan_verdict, summary").not("ryan_verdict", "is", null).order("created_at", { ascending: false }).limit(20)
  const calibration = (past || []).map((p) => `- ${p.address || "?"}: model said ${p.verdict}, Ryan said ${p.ryan_verdict}${p.summary ? ` (${p.summary})` : ""}`).join("\n")
  const out = await completeJson({
    model: tier === "direct" ? SONNET : HAIKU, system: SCREEN_SYSTEM + (calibration ? `\n\nCALIBRATION — Ryan's own verdicts on recent screens (match his taste, not the model's):\n${calibration}` : ""),
    prompt: screenPrompt({ tier, msg, deal: cls.deal, attachmentsText: (cls.attachments || []).map((a) => a.description).filter(Boolean).join("; "), signals }),
    docs, maxTokens: 2500, tag: "[screen]", thinking: true,
  })
  if (!out) return
  const facts = out.facts || {}
  const units = Number(facts.units) || Number(cls.deal.units) || null
  let post = tier === "direct"
  let cut = null
  if (tier !== "direct") {
    cut = blastPassesCut(out, cls, known, signals, pre)
    post = cut.ok
    log(`blast ${out.address || "?"}: ${cut.ok ? "SHOW" : "hold"} — ${cut.why}`)
  }
  const allSignals = [...new Set([...signals, ...((facts.signals || []).map((s) => String(s).toLowerCase()))])]
  const money = (n) => {
    if (n === null || n === undefined || n === "") return "not stated"
    const num = typeof n === "number" ? n : Number(String(n).replace(/[$,]/g, ""))
    return Number.isFinite(num) ? `$${Math.round(num).toLocaleString()}` : esc(String(n))
  }
  const unitsLabel = units ?? (facts.units ? esc(String(facts.units)) : "?")
  const lines = [
    `${tier === "direct" ? "🏢 <b>Direct lead</b>" : "📣 <b>Broker blast</b>"} — <b>${esc(out.address || cls.deal.address || "address?")}</b>`,
    `From ${esc(msg.from.name || msg.from.email)}`,
    out.property_type === "sfr" || (!units && (cls.deal.property_type === "sfr"))
      ? `🏠 House · Asking ${money(facts.asking)}${facts.sqft ? ` · ${esc(String(facts.sqft))} sf` : ""}${facts.year_built ? ` · built ${esc(String(facts.year_built))}` : ""}${facts.condition ? ` · ${esc(facts.condition)}` : ""}`
      : `Units ${unitsLabel}${facts.unit_mix ? ` (${esc(facts.unit_mix)})` : ""} · Asking ${money(facts.asking)} · ${facts.price_per_door ? `${money(facts.price_per_door)}/door` : "per-door n/a"}${facts.grm ? ` · GRM ${facts.grm}` : ""}${facts.gross_rent_mo ? ` · gross ${money(facts.gross_rent_mo)}/mo` : ""}`,
    ...(allSignals.length ? [`🔑 ${allSignals.slice(0, 6).map(esc).join(" · ")}`] : []),
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
    const rows = [[{ text: "👀 Look further", data: `ix:sl:${data.id}` }, { text: "🚫 Pass", data: `ix:sp:${data.id}` }, { text: "✉️ Reply", data: `ix:sr:${data.id}` }]]
    if (tier !== "direct") rows.push([{ text: "🔇 Mute sender", data: `ix:ms:${data.id}` }]) // Ryan 2026-10-03: one tap ends a garbage sender for good
    const mid = await tgSend(lines.join("\n"), { rows })
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
  if (rules.status === "generating") {
    const { data: row } = await sb().from("inbox_settings").select("updated_at").eq("key", "rules").maybeSingle()
    if (row && Date.now() - new Date(row.updated_at).getTime() > 5 * 60_000) {
      warn("convention generation looks stuck on Vercel — regenerating here")
      await publishRules(ctx, {})
    }
    return
  }
  if (["approved", "draft", "revise"].includes(rules.status)) return
  const { data: asked } = await sb().from("inbox_interview").select("id, asked_at").eq("status", "asked").not("seq", "is", null).limit(1)
  if (asked?.length) {
    if (daysAgo(asked[0].asked_at) >= 3) log("interview: waiting on Ryan (3+ days)")
    return
  }
  const { data: next } = await sb().from("inbox_interview").select("*, inbox_files(*)").eq("status", "pending").not("seq", "is", null).order("seq").limit(1)
  const { count: total } = await sb().from("inbox_interview").select("id", { count: "exact", head: true }).not("seq", "is", null)
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
  const { count: answered } = await sb().from("inbox_interview").select("id", { count: "exact", head: true }).in("status", ["answered", "skipped"]).not("seq", "is", null)
  if (rules.status === "interview" && answered > 0) await publishRules(ctx, {})
}

async function publishRules(ctx, { feedback, previous }) {
  await loadTree(ctx)
  const { data: ivs } = await sb().from("inbox_interview").select("*, inbox_files(filename, sender, subject, doc_type, property_label)").in("status", ["answered", "skipped", "applied"]).not("seq", "is", null).order("seq")
  const qa = (ivs || []).map((iv) => ({
    doc: `${iv.inbox_files?.filename} (${iv.question || iv.inbox_files?.doc_type}; from ${iv.inbox_files?.sender}; property ${iv.inbox_files?.property_label || "unknown"})`,
    guess: `${iv.guess_folder}/${iv.guess_name}`,
    answer: iv.answer_kind === "accepted" ? "accepted my guess" : iv.answer_kind === "skipped" ? "skipped (don't file this kind)" : iv.answer_text,
  }))
  const corrections = (await fetchAll("inbox_rules", "*")).filter((r) => r.source === "correction").map((r) => `${r.sender_domain} ${r.doc_type} → ${r.folder_template}/${r.filename_template}${r.note ? ` (${r.note})` : ""}`)
  const knowledge = await knowledgeText()
  const md = await complete({ model: SONNET, system: RULES_SYSTEM, prompt: rulesPrompt({ tree: ctx.tree, qa, corrections: [...corrections, ...(knowledge ? [`Things Ryan has told the agent:\n${knowledge}`] : [])], feedback, previous }), maxTokens: 3500, tag: "[rules]", thinking: true })
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
    sb().from("inbox_loops").select("*").in("status", ["open", "asked"]).order("priority").order("created_at"),
    sb().from("inbox_files").select("final_folder, final_name, drive_url").eq("status", "filed").gte("filed_at", dayAgo),
    sb().from("inbox_files").select("filename, property_label").in("status", ["pending", "change_requested"]),
    sb().from("inbox_files").select("id", { count: "exact", head: true }).eq("status", "waiting"),
    sb().from("inbox_files").select("filename").eq("status", "duplicate").gte("created_at", dayAgo),
    sb().from("inbox_deal_screens").select("address, verdict, summary, tier, facts").gte("created_at", dayAgo),
    sb().from("inbox_interview").select("id", { count: "exact", head: true }).eq("status", "asked"),
    getSetting("rules"),
  ])
  const lines = [`☀️ <b>Inbox brief · ${date}</b>`]
  // Ryan 2026-09-25: "check to see if I left any loose ends open." Beyond the
  // flagged asks: any human email from the last 7 days with no reply from Ryan
  // on the thread after it arrived, 2+ days old.
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const { data: recentHuman } = await sb().from("inbox_messages").select("gmail_id, thread_id, sender, sender_name, subject, internal_date, classification").in("kind", ["human", "deal_lead", "zix", "esign_completed"]).gte("internal_date", weekAgo).order("internal_date", { ascending: false }).limit(300)
  const sent = await sentFor(ctx)
  const openThreads = new Set((loops.data || []).map((l) => l.thread_id))
  // Ryan 2026-10-05: "nothing here relevant … a simple button to remove these
  // from the daily brief." 🧹 on the brief dismisses every thread listed that day.
  // 2026-10-17: the rule itself lives in loops.mjs isLooseEnd — relays
  // (RELAY_SENDER_RE) never count, and a reply to the same person on another
  // thread counts as an answer (Parts B + E).
  const dismissed = agent.unanswered_dismissed || {}
  const seenThread = new Set()
  const looseEnds = []
  for (const m of recentHuman || []) {
    if (!m.thread_id || seenThread.has(m.thread_id)) continue
    seenThread.add(m.thread_id)
    if (isLooseEnd(m, { sent, openThreads, dismissed })) looseEnds.push(m)
  }
  // Part F: loops the other party still owes an action on sit in their own block.
  // Part H: portal asks (sign/pay outside email) are asked about ONCE, then parked as
  // `asked` — never re-listed, never counted; `asked` rows come back from the query
  // only so their threads don't surface as loose ends.
  const { mine: open, theirs, ask: portalAsks } = splitLoops(loops.data || [])
  const loopLine = (l) => {
    const age = daysAgo(l.message_at || l.created_at)
    return `${l.priority === "high" ? "🔴" : "•"} ${esc(l.counterparty)} — ${esc(l.ask)}${l.due_on ? ` · due ${esc(l.due_on)}` : ""}${age >= 2 ? ` · ${age}d` : ""}`
  }
  if (open.length) {
    lines.push(`\n<b>Waiting on you (${open.length})</b>`)
    for (const l of open.slice(0, 12)) lines.push(loopLine(l))
    if (open.length > 12) lines.push(`… +${open.length - 12} more`)
  } else lines.push("\n✅ Nothing waiting on you.")
  if (portalAsks.length) {
    lines.push(`\n<i>Can't tell from email — did you handle these?</i>`)
    for (const l of portalAsks.slice(0, 8)) lines.push(loopLine(l))
    if (portalAsks.length > 8) lines.push(`… +${portalAsks.length - 8} more`)
  }
  if (theirs.length) {
    lines.push(`\n<b>Waiting on them (${theirs.length})</b>`)
    for (const l of theirs.slice(0, 8)) lines.push(loopLine(l))
    if (theirs.length > 8) lines.push(`… +${theirs.length - 8} more`)
  }
  if (looseEnds.length) {
    lines.push(`\n<b>Unanswered ${looseEnds.length > 8 ? "(showing 8 of " + looseEnds.length + ")" : ""}</b> — human emails with no reply from you`)
    for (const m of looseEnds.slice(0, 8)) lines.push(`• ${esc(m.sender_name || m.sender)} — “${esc(shortSubject(m.subject, 60))}” · ${daysAgo(m.internal_date)}d`)
  }
  if (pending.data?.length) lines.push(`\n<b>Filing proposals waiting for a tap:</b> ${pending.data.length} (${pending.data.slice(0, 4).map((p) => esc(p.filename)).join(", ")}${pending.data.length > 4 ? "…" : ""})`)
  if (filed.data?.length) lines.push(`\n<b>Filed in the last day:</b> ${filed.data.length}\n` + filed.data.slice(0, 8).map((f) => `• ${esc(f.final_folder)}/${esc(f.final_name)}`).join("\n"))
  if (dups.data?.length) lines.push(`\nSkipped as duplicates: ${dups.data.map((d) => esc(d.filename)).join(", ")}`)
  if (screens.data?.length) {
    const shown = screens.data.filter((s) => s.tier === "direct" || s.facts?.shown)
    const held = screens.data.length - shown.length
    if (shown.length) lines.push(`\n<b>Deals screened:</b>\n` + shown.map((s) => `• ${esc(s.address || "?")} — ${s.verdict === "pass" ? "pass" : s.verdict === "look_further" ? "look further" : "unclear"}${s.summary ? `: ${esc(s.summary)}` : ""}`).join("\n"))
    if (held) log(`digest: ${held} hidden blasts not mentioned (Ryan 2026-10-02: no tally)`)
  }
  // Networking events (briefs/BRIEF_EVENT_WATCHER_2026-10-15.md): new ones only, then one card each after the brief.
  const events = await eventBrief({ dry: DRY }).catch((e) => (warn("digest: event section failed:", e.message), { lines: [], newRows: [] }))
  if (events.lines.length) lines.push("", ...events.lines)
  if (rules.status !== "approved") {
    if (interview.count) lines.push(`\n🗂 A filing setup question is waiting on your answer above.`)
    else if (rules.status === "draft") lines.push(`\n📐 The filing convention is waiting for your 👍 (or changes).`)
    if (waiting.count) lines.push(`${waiting.count} attachment${waiting.count === 1 ? "" : "s"} queued until the convention is approved.`)
  }
  if (ctx.driveErr) lines.push(`\n⚠️ Drive isn't reachable yet: ${esc(ctx.driveErr)}`)
  const briefRows = looseEnds.length ? [[{ text: "🧹 Clear unanswered", data: `ix:uc:${date}` }]] : []
  await tgSend(lines.join("\n"), { rows: briefRows, dryRun: DRY })
  await postEventCards(events.newRows, DRY).catch((e) => warn("digest: event cards failed:", e.message))
  if (!DRY) {
    await setSetting("agent", { last_digest_date: date, last_unanswered_threads: looseEnds.slice(0, 8).map((m) => m.thread_id), last_unanswered_date: date })
    // Ryan 2026-09-27: "the same thing over and over every day … a way to check
    // I'm aware and don't need reminding." The brief was text-only, so open
    // loops rode along every morning with no way to clear them. Post one
    // actionable card per open loop: ✓ Done kills it, 👀 Got it mutes the daily
    // nag (resurfacing once the day before its due date), ⏰ Snooze 2d defers.
    for (const l of open.slice(0, 6)) {
      const card = `${l.priority === "high" ? "🔴" : "•"} <b>${esc(l.counterparty)}</b> — ${esc(l.ask)}${l.due_on ? ` · due ${esc(l.due_on)}` : ""}`
      const mid = await tgSend(card, { rows: [[
        { text: "✓ Done", data: `ix:ld:${l.id}` },
        { text: "👀 Got it", data: `ix:la:${l.id}` },
        { text: "⏰ Snooze 2d", data: `ix:lz:${l.id}` },
      ]] })
      await sb().from("inbox_loops").update({ tg_message_id: mid, last_digest_at: isoNow() }).eq("id", l.id)
    }
    // Part H: the one question for each portal ask — same card, then `asked` so it is never raised again.
    for (const l of portalAsks.slice(0, 8)) {
      const card = `❔ <b>${esc(l.counterparty)}</b> — ${esc(l.ask)}${l.due_on ? ` · due ${esc(l.due_on)}` : ""}\n<i>Can't tell from email whether this is done.</i>`
      const mid = await tgSend(card, { rows: [[
        { text: "✓ Done", data: `ix:ld:${l.id}` },
        { text: "👀 Got it", data: `ix:la:${l.id}` },
        { text: "⏰ Snooze 2d", data: `ix:lz:${l.id}` },
      ]] })
      await sb().from("inbox_loops").update({ status: "asked", snooze_until: null, tg_message_id: mid, last_digest_at: isoNow() }).eq("id", l.id)
      log(`loop asked once (portal): ${l.id} (${shortSubject(l.subject, 50)})`)
    }
  }
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
  for (const [t, col] of [["inbox_messages", "kind"], ["inbox_files", "status"], ["inbox_fetches", "status"], ["inbox_loops", "status"], ["inbox_events", "status"], ["inbox_interview", "status"], ["inbox_rules", "mode"], ["inbox_deal_screens", "verdict"]]) {
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
  if (flag("events-only")) {
    await scanEvents(ctx, { dry: DRY, backfillDays: EVENTS_BACKFILL ? parseDays(EVENTS_BACKFILL) : null, sources: EVENTS_SOURCES, only: EVENTS_MESSAGE })
    const preview = await eventBrief({ dry: true })
    console.log("---- BRIEF SECTION (preview, from rows already in inbox_events) ----\n" + (preview.lines.join("\n") || "(nothing new)"))
    return
  }
  const t0 = Date.now()
  QUIET = { ...QUIET, ...((agent.quiet_hours && typeof agent.quiet_hours === "object") ? agent.quiet_hours : {}) }
  await alertDriveOnce(ctx)
  await noteDriveConnected(ctx)
  await applyAskAnswers(ctx)
  await applyDecisions(ctx)
  await applyEventDecisions({ dry: DRY })
  await postDeferred(ctx)
  if (flag("interview")) await seedInterview(ctx)
  if (!flag("no-poll")) await pollInbox(ctx)
  if (!flag("no-events")) await scanEvents(ctx, { dry: DRY, backfillDays: EVENTS_BACKFILL ? parseDays(EVENTS_BACKFILL) : null })
  await runFetches(ctx)
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
