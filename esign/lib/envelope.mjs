// Envelope lifecycle: create → send (in signing order) → open → consent →
// sign → complete (final PDF, Drive, email, Telegram). Completed envelopes
// are locked: no route can change them or their files.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { env } from "./env.mjs"
import { getDb, now, run, one, addEvent, getEnvelope, getSigners, getSigner, getEvents } from "./db.mjs"
import { sha256, inspectPdf, renderPages, buildFinalPdf, buildInterimPdf, checkFields, stampFillIns } from "./pdf.mjs"
import { CONSENT_VERSION } from "./consent.mjs"
import { fontKey } from "./fonts.mjs"
import { sendMail, driveClient, driveDownload, driveMeta, driveResolvePath, driveUpload, driveFolderLink } from "./google.mjs"
import { inviteEmail, completedEmail, inviteText, completedText, noticeText } from "./emails.mjs"
import { sendText, normalizePhone } from "./sms.mjs"
import { notify, esc } from "./notify.mjs"
import { crmEnabled, isSellerContract, reportContract } from "./crm.mjs"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export class UserError extends Error {}

export function envelopeDir(id) {
  return path.join(env.dataDir, "envelopes", id)
}

function readOnly(file) {
  try { fs.chmodSync(file, 0o444) } catch { /* best effort */ }
}

/** envelopes/<id>/interim.pdf when it exists — the document with every signature so far, no certificate. */
export function interimPath(envelope) {
  const p = path.join(envelopeDir(envelope.id), "interim.pdf")
  return fs.existsSync(p) ? p : null
}

/** How many pages the signers see (interim build: original + addendum pages); page_count stays the original's. */
export function viewPageCount(envelope) {
  return envelope.view_page_count || envelope.page_count
}

export function normalizeSigners(input) {
  const out = []
  for (const [i, s] of (input || []).entries()) {
    const name = String(s.name || "").trim().replace(/\s+/g, " ")
    const email = String(s.email || "").trim().toLowerCase()
    const phoneRaw = String(s.phone || "").trim()
    const phone = phoneRaw ? normalizePhone(phoneRaw) : null
    const role = s.role === "buyer" ? "buyer" : "seller"
    const order = Math.max(1, Math.min(9, Number(s.order) || 1))
    let delivery = ["email", "text", "both", "email_notice"].includes(s.delivery) ? s.delivery : "email"
    if (!name && !email && !phoneRaw) continue
    if (!name) throw new UserError(`Signer ${i + 1}: name is required`)
    if (email && !EMAIL_RE.test(email)) throw new UserError(`Signer ${i + 1} (${name}): "${email}" is not a valid email`)
    if (phoneRaw && !phone) throw new UserError(`Signer ${i + 1} (${name}): "${phoneRaw}" is not a 10-digit phone number`)
    if (delivery !== "email" && !phone) throw new UserError(`Signer ${i + 1} (${name}): a phone number is needed to send by text`)
    if (delivery === "email_notice" && !email) throw new UserError(`Signer ${i + 1} (${name}): an email address is needed to email the link`)
    if (delivery !== "text" && !email) {
      if (phone) delivery = "text"
      else throw new UserError(`Signer ${i + 1} (${name}): needs an email address or a phone number`)
    }
    out.push({ name, email, phone, role, order, delivery })
  }
  if (!out.length) throw new UserError("Add at least one signer")
  if (out.length > 8) throw new UserError("At most 8 signers")
  return out
}

/** People who don't sign but are emailed the completed PDF with everyone else. */
export function normalizeCopyTo(input) {
  const out = []
  for (const c of input || []) {
    const name = String(c.name || "").trim().replace(/\s+/g, " ")
    const email = String(c.email || "").trim().toLowerCase()
    if (!name && !email) continue
    if (!EMAIL_RE.test(email)) throw new UserError(`Copy to ${name || "(no name)"}: "${email}" is not a valid email`)
    out.push({ name: name || email, email })
  }
  if (out.length > 4) throw new UserError("At most 4 copy-to people")
  return out
}

/**
 * Create an envelope and send the first round of invitations.
 * `pdfBytes` or `driveFileId` (downloaded through Ryan's Drive) — one of them.
 */
export async function createEnvelope({ title, propertyAddress, agreementDate, message, pdfBytes, driveFileId, signers, copyTo, createdBy }) {
  const db = getDb()
  const cleanSigners = normalizeSigners(signers)
  const cleanCopyTo = normalizeCopyTo(copyTo)
  let bytes = pdfBytes ? Buffer.from(pdfBytes) : null
  let driveFolderId = null
  if (!bytes && driveFileId) {
    const drive = await driveClient()
    const meta = await driveMeta(drive, driveFileId)
    if (meta.mimeType !== "application/pdf") throw new UserError("That Drive file is not a PDF")
    bytes = await driveDownload(drive, driveFileId)
    driveFolderId = meta.parents?.[0] ?? null
    if (!title) title = meta.name.replace(/\.pdf$/i, "")
  }
  if (!bytes || bytes.length < 100) throw new UserError("A PDF is required")
  if (bytes.subarray(0, 5).toString() !== "%PDF-") throw new UserError("That file is not a PDF")
  title = String(title || "").trim() || "Document"
  const info = await inspectPdf(bytes)

  const id = crypto.randomBytes(8).toString("hex")
  const dir = envelopeDir(id)
  fs.mkdirSync(dir, { recursive: true })
  const originalPath = path.join(dir, "original.pdf")
  fs.writeFileSync(originalPath, bytes)
  readOnly(originalPath)
  const pageCount = await renderPages(originalPath, path.join(dir, "pages"))

  // Placement: first seller + first buyer (by order, then list position) sign
  // on the template's own lines; everyone else on the Signature Addendum.
  const sorted = [...cleanSigners].sort((a, b) => a.order - b.order)
  const firstSeller = info.isTemplate ? sorted.find((s) => s.role === "seller") : null
  const firstBuyer = info.isTemplate ? sorted.find((s) => s.role === "buyer") : null

  const ts = now()
  const insertEnv = db.prepare(`INSERT INTO envelopes (id, title, property_address, agreement_date, message, source, drive_file_id, drive_folder_id,
    original_sha256, original_path, page_count, view_page_count, is_template, status, created_at, created_by, copy_to)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const insertSigner = db.prepare(`INSERT INTO signers (id, envelope_id, order_index, role, name, email, phone, delivery, placement, status) VALUES (?,?,?,?,?,?,?,?,?,?)`)
  db.exec("BEGIN")
  try {
    insertEnv.run(id, title, propertyAddress || null, agreementDate || null, message || null, driveFileId ? "drive" : "upload", driveFileId || null, driveFolderId,
      sha256(bytes), originalPath, pageCount, pageCount, info.isTemplate ? 1 : 0, "in_progress", ts, createdBy || "admin", cleanCopyTo.length ? JSON.stringify(cleanCopyTo) : null)
    for (const s of cleanSigners) {
      const placement = s === firstSeller || s === firstBuyer ? "template" : "addendum"
      insertSigner.run(crypto.randomBytes(6).toString("hex"), id, s.order, s.role, s.name, s.email, s.phone, s.delivery, placement, "waiting")
    }
    db.exec("COMMIT")
  } catch (e) {
    db.exec("ROLLBACK")
    throw e
  }
  addEvent(id, "created", { details: { title, pages: pageCount, template: info.isTemplate, source: driveFileId ? "drive" : "upload", signers: cleanSigners.length, copyTo: cleanCopyTo.map((c) => c.email) } })
  await refreshInterim(id) // the addendum box + page are there from the first signer on
  const sent = await sendPending(id)
  await reportOfferSent(id)
  return { id, sent }
}

/** A purchase agreement went out: the seller's lead card gets the Offer
 *  stage and the written price (lib/crm). Never throws — Ryan hears about a
 *  failure, the envelope itself is fine. */
async function reportOfferSent(id) {
  const envelope = getEnvelope(id)
  const signers = getSigners(id)
  if (!crmEnabled() || !isSellerContract(envelope, signers)) return
  try {
    const out = await reportContract("sent", envelope, signers)
    addEvent(id, "crm_offer", { details: { status: out.status, leadId: out.leadId || null } })
    if (out.status === "no_match") await notify(`⚠️ e-sign: sent <b>${esc(envelope.title)}</b>, but I couldn't tell which lead it's for, so the Offer isn't on a card. Set it by hand if you want it counted.`)
  } catch (e) {
    console.error("[esign] offer report failed:", e)
    await notify(`⚠️ e-sign: sent <b>${esc(envelope.title)}</b>, but the lead card didn't get the Offer: ${esc(e?.message || e)}`)
  }
}

const SAFE = (t) => String(t).replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim()

/**
 * Self-sign: Ryan signs a form someone else sent him, on the form's own lines.
 * The fill-ins (`fields` with kind "text") are typed onto the page before the
 * envelope exists, so what he reviews is exactly what he signs; the date and
 * his signature go on when he signs. No invitation is sent — the caller gets
 * the signing link back. On completion the form as received, the clean signed
 * copy and the signed copy + certificate are filed together in
 * Business Operations/E-Sign/Signed by Ryan/<date> · <street> · <label>/.
 */
export async function createSelfSign({ pdfBytes, driveFileId, docLabel, street, propertyAddress, receivedFrom, fields }) {
  const db = getDb()
  let bytes = pdfBytes ? Buffer.from(pdfBytes) : null
  if (!bytes && driveFileId) {
    const drive = await driveClient()
    const meta = await driveMeta(drive, driveFileId)
    if (meta.mimeType !== "application/pdf") throw new UserError("That Drive file is not a PDF")
    bytes = await driveDownload(drive, driveFileId)
    if (!docLabel) docLabel = meta.name.replace(/\.pdf$/i, "")
  }
  if (!bytes || bytes.subarray(0, 5).toString() !== "%PDF-") throw new UserError("A PDF is required")
  docLabel = SAFE(docLabel || "Document")
  street = street ? SAFE(street) : null
  const checked = await checkFields(bytes, fields)
  const prepared = await stampFillIns(bytes, checked)

  const id = crypto.randomBytes(8).toString("hex")
  const dir = envelopeDir(id)
  fs.mkdirSync(dir, { recursive: true })
  const sourcePath = path.join(dir, "source.pdf")
  const originalPath = path.join(dir, "original.pdf")
  fs.writeFileSync(sourcePath, bytes); readOnly(sourcePath)
  fs.writeFileSync(originalPath, prepared); readOnly(originalPath)
  const pageCount = await renderPages(originalPath, path.join(dir, "pages"))

  const ts = now()
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: env.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
  const filingFolder = `${env.selfSignPath}/${[day, street, docLabel].filter(Boolean).join(" · ")}`
  const title = street ? `${street} · ${docLabel}` : docLabel
  const signerId = crypto.randomBytes(6).toString("hex")
  db.exec("BEGIN")
  try {
    db.prepare(`INSERT INTO envelopes (id, title, property_address, message, source, drive_file_id, original_sha256, original_path, page_count, view_page_count,
      is_template, status, created_at, created_by, kind, fields_json, source_path, source_sha256, filing_folder, doc_label)
      VALUES (?,?,?,?,?,?,?,?,?,?,0,'in_progress',?,'self-sign','self',?,?,?,?,?)`).run(
      id, title, propertyAddress || null, receivedFrom ? `form from ${receivedFrom}` : null, driveFileId ? "drive" : "upload", driveFileId || null,
      sha256(prepared), originalPath, pageCount, pageCount, ts, JSON.stringify(checked), sourcePath, sha256(bytes), filingFolder, docLabel)
    db.prepare(`INSERT INTO signers (id, envelope_id, order_index, role, name, email, phone, delivery, placement, status) VALUES (?,?,1,'buyer',?,?,NULL,'email','fields','waiting')`)
      .run(signerId, id, env.ownerName, env.senderEmail)
    db.exec("COMMIT")
  } catch (e) {
    db.exec("ROLLBACK")
    throw e
  }
  addEvent(id, "created", { details: { title, pages: pageCount, kind: "self", source: driveFileId ? "drive" : "upload", fields: checked.map(({ kind, value, label }) => ({ kind, value, label })), receivedFrom: receivedFrom || null } })
  await refreshInterim(id) // shows today's date on the date lines
  const { link, expiresAt } = await freshLink(id, signerId)
  return { id, link, expiresAt, filingFolder }
}

/**
 * Rebuild envelopes/<id>/interim.pdf (original + every signature so far; the
 * addendum box ticked and the addendum page listed as soon as the envelope has
 * addendum signers) and re-render the page images from it. Nothing to show
 * yet → leaves the original's render in place. Never throws: the signature
 * that triggered it is already recorded, so a failure is logged and the next
 * signer simply reviews the previous render.
 */
export async function refreshInterim(envelopeId) {
  const envelope = getEnvelope(envelopeId)
  if (!envelope || envelope.status !== "in_progress") return null
  const signers = getSigners(envelopeId)
  if (!envelope.fields_json && !signers.some((s) => s.status === "signed" || s.placement === "addendum")) return null
  try {
    const originalBytes = fs.readFileSync(envelope.original_path)
    if (sha256(originalBytes) !== envelope.original_sha256) throw new Error("Original document fingerprint mismatch — refusing to build")
    const { bytes, pageCount } = await buildInterimPdf({ originalBytes, envelope, signers })
    const dir = envelopeDir(envelopeId)
    const file = path.join(dir, "interim.pdf")
    fs.writeFileSync(file, bytes)
    // Render into a fresh folder and swap, so a signer mid-review never sees a half-written set.
    const fresh = path.join(dir, "pages.new"), pages = path.join(dir, "pages"), old = path.join(dir, "pages.old")
    fs.rmSync(fresh, { recursive: true, force: true })
    const n = await renderPages(file, fresh)
    fs.rmSync(old, { recursive: true, force: true })
    if (fs.existsSync(pages)) fs.renameSync(pages, old)
    fs.renameSync(fresh, pages)
    fs.rmSync(old, { recursive: true, force: true })
    run("UPDATE envelopes SET view_page_count = ? WHERE id = ?", n, envelopeId)
    return { file, pageCount: n }
  } catch (e) {
    console.error("[esign] interim build failed:", e)
    addEvent(envelopeId, "interim_failed", { details: { error: String(e?.message || e) } })
    return null
  }
}

/** Email every signer in the lowest unsigned order tier that hasn't been sent yet. */
export async function sendPending(envelopeId) {
  const envelope = getEnvelope(envelopeId)
  if (!envelope || envelope.status !== "in_progress") return []
  const signers = getSigners(envelopeId)
  const open = signers.filter((s) => s.status !== "signed")
  if (!open.length) return []
  const tier = Math.min(...open.map((s) => s.order_index))
  const sent = []
  for (const s of open.filter((s) => s.order_index === tier && s.status === "waiting")) {
    await sendToSigner(envelope, s)
    sent.push(s.name)
  }
  return sent
}

function newToken() {
  const token = crypto.randomBytes(32).toString("base64url")
  return { token, hash: sha256(token) }
}

export async function sendToSigner(envelope, signer, { resend = false } = {}) {
  const { token, hash } = newToken()
  const expiresAt = new Date(Date.now() + env.linkDays * 86400e3).toISOString()
  const link = `${env.baseUrl}/s/${token}`
  const channels = []
  const wantEmail = signer.delivery !== "text" && signer.email
  const wantText = (signer.delivery === "text" || signer.delivery === "both") && signer.phone
  // Email first; if it fails and a text is also wanted, the text still goes.
  let emailErr = null
  if (wantEmail) {
    try {
      const mail = inviteEmail({ envelope, signer, link, expiresAt })
      const gmailId = await sendMail({ to: `"${signer.name.replace(/"/g, "")}" <${signer.email}>`, subject: mail.subject, text: mail.text, html: mail.html })
      channels.push(`email:${signer.email}`)
      addEvent(envelope.id, resend ? "link_resent" : "invitation_sent", { signerId: signer.id, details: { channel: "email", to: signer.email, gmailId, expiresAt } })
    } catch (e) { emailErr = e }
  }
  // email_notice: the link went by email; a short text from Ryan's cell (no link) tells them to look for it.
  if (signer.delivery === "email_notice" && signer.phone && !emailErr && !resend) {
    try {
      await sendText(signer.phone, noticeText({ envelope, signer }))
      addEvent(envelope.id, "notice_text_sent", { signerId: signer.id, details: { to: signer.phone } })
    } catch (e) {
      addEvent(envelope.id, "text_failed", { signerId: signer.id, details: { error: String(e?.message || e) } })
      await notify(`⚠️ e-sign: the link was emailed to ${esc(signer.name)}, but the heads-up text did not go: ${esc(e?.message || e)}`)
    }
  }
  if (wantText) {
    try {
      await sendText(signer.phone, inviteText({ envelope, signer, link, expiresAt }))
      channels.push(`text:${signer.phone}`)
      addEvent(envelope.id, resend ? "link_resent" : "invitation_sent", { signerId: signer.id, details: { channel: "text", to: signer.phone, expiresAt } })
    } catch (e) {
      if (!channels.length) throw emailErr ? new Error(`${emailErr.message}; ${e.message}`) : e
      addEvent(envelope.id, "text_failed", { signerId: signer.id, details: { error: String(e?.message || e) } })
      await notify(`⚠️ e-sign: email went to ${esc(signer.name)} but the text did not: ${esc(e?.message || e)}`)
    }
  }
  if (!channels.length) throw emailErr || new Error(`${signer.name} has no way to be reached`)
  if (emailErr) {
    addEvent(envelope.id, "email_failed", { signerId: signer.id, details: { error: String(emailErr.message) } })
    await notify(`⚠️ e-sign: text went to ${esc(signer.name)} but the email did not: ${esc(emailErr.message)}`)
  }
  const ts = now()
  run(`UPDATE signers SET token_hash = ?, token_expires_at = ?, status = CASE WHEN status = 'waiting' THEN 'sent' ELSE status END,
       sent_at = COALESCE(sent_at, ?), send_count = send_count + 1 WHERE id = ?`, hash, expiresAt, ts, signer.id)
  return { link, expiresAt, channels }
}

export async function resend(envelopeId, signerId) {
  const envelope = getEnvelope(envelopeId)
  const signer = getSigner(signerId)
  if (!envelope || !signer || signer.envelope_id !== envelopeId) throw new UserError("Not found")
  if (envelope.status !== "in_progress") throw new UserError("This request is no longer open")
  if (signer.status === "signed") throw new UserError(`${signer.name} already signed`)
  const tier = Math.min(...getSigners(envelopeId).filter((s) => s.status !== "signed").map((s) => s.order_index))
  if (signer.order_index > tier) throw new UserError(`${signer.name} is later in the signing order — earlier signers haven't finished`)
  return sendToSigner(envelope, signer, { resend: true })
}

/** A fresh link for texting by hand (same expiry rules). Invalidates the emailed one. */
export async function freshLink(envelopeId, signerId) {
  const envelope = getEnvelope(envelopeId)
  const signer = getSigner(signerId)
  if (!envelope || !signer || signer.envelope_id !== envelopeId) throw new UserError("Not found")
  if (envelope.status !== "in_progress" || signer.status === "signed") throw new UserError("Not open for signing")
  const { token, hash } = newToken()
  const expiresAt = new Date(Date.now() + env.linkDays * 86400e3).toISOString()
  run("UPDATE signers SET token_hash = ?, token_expires_at = ?, status = CASE WHEN status = 'waiting' THEN 'sent' ELSE status END, sent_at = COALESCE(sent_at, ?) WHERE id = ?", hash, expiresAt, now(), signer.id)
  addEvent(envelopeId, "link_generated", { signerId, details: { by: "admin", expiresAt } })
  return { link: `${env.baseUrl}/s/${token}`, expiresAt }
}

export function lookupToken(token) {
  if (!token || token.length < 20) return null
  const signer = one("SELECT * FROM signers WHERE token_hash = ?", sha256(token))
  if (!signer) return null
  const envelope = getEnvelope(signer.envelope_id)
  const expired = !signer.token_expires_at || Date.parse(signer.token_expires_at) < Date.now()
  return { signer, envelope, expired }
}

export async function recordOpen(signer, envelope, ctx) {
  const first = !signer.opened_at
  if (first) {
    run("UPDATE signers SET status = CASE WHEN status = 'sent' THEN 'opened' ELSE status END, opened_at = ?, open_ip = ?, open_ua = ?, open_geo = ? WHERE id = ?",
      now(), ctx.ip, ctx.ua, ctx.geo ? JSON.stringify(ctx.geo) : null, signer.id)
    addEvent(envelope.id, "opened", { signerId: signer.id, ip: ctx.ip, ua: ctx.ua, geo: ctx.geo })
    await notify(`👀 <b>${esc(signer.name)}</b> opened <b>${esc(envelope.title)}</b>\n${esc(ctx.geoLabel)} · ${esc(ctx.device)}`)
  } else {
    addEvent(envelope.id, "viewed", { signerId: signer.id, ip: ctx.ip, ua: ctx.ua, geo: ctx.geo })
  }
}

export async function recordConsent(signer, envelope, ctx) {
  if (signer.consented_at) return
  run("UPDATE signers SET status = CASE WHEN status IN ('sent','opened') THEN 'consented' ELSE status END, consented_at = ?, consent_version = ?, consent_ip = ?, consent_ua = ?, consent_geo = ? WHERE id = ?",
    now(), CONSENT_VERSION, ctx.ip, ctx.ua, ctx.geo ? JSON.stringify(ctx.geo) : null, signer.id)
  addEvent(envelope.id, "consented", { signerId: signer.id, ip: ctx.ip, ua: ctx.ua, geo: ctx.geo, details: { version: CONSENT_VERSION } })
}

export async function recordDecline(signer, envelope, reason, ctx) {
  if (signer.status === "signed" || envelope.status !== "in_progress") throw new UserError("Not open")
  const ts = now()
  run("UPDATE signers SET status = 'declined', declined_at = ?, decline_reason = ?, token_hash = NULL WHERE id = ?", ts, reason || null, signer.id)
  run("UPDATE envelopes SET status = 'declined' WHERE id = ?", envelope.id)
  addEvent(envelope.id, "declined", { signerId: signer.id, ip: ctx.ip, ua: ctx.ua, geo: ctx.geo, details: { reason } })
  await notify(`✋ <b>${esc(signer.name)}</b> declined to sign <b>${esc(envelope.title)}</b> electronically${reason ? `: ${esc(reason)}` : ""}.\nThey asked for a paper copy — call them at ${esc(signer.phone || "(no phone on file)")}.`)
}

export async function recordSign(signer, envelope, { typedName, method, signaturePng, font }, ctx) {
  if (envelope.status !== "in_progress") throw new UserError("This document is no longer open for signing")
  if (signer.status === "signed") throw new UserError("You already signed this document")
  if (!signer.consented_at) throw new UserError("Please accept the electronic signature consent first")
  const name = String(typedName || "").trim().replace(/\s+/g, " ")
  if (name.length < 2 || name.length > 80) throw new UserError("Please type your full legal name")
  if (!name.includes(" ")) throw new UserError("Please type your full name (first and last)")
  let png = null
  if (method === "drawn") {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(signaturePng || ""))
    if (!m) throw new UserError("Your drawn signature didn't come through — try again or use the typed signature")
    png = Buffer.from(m[1], "base64")
    if (png.length > 400_000) throw new UserError("Drawn signature is too large")
  }
  const ts = now()
  const fontK = fontKey(font)
  const r = run(`UPDATE signers SET status = 'signed', signed_at = ?, sign_ip = ?, sign_ua = ?, sign_geo = ?, typed_name = ?, signature_method = ?, signature_png = ?, signature_font = ?
     WHERE id = ? AND status != 'signed'`, ts, ctx.ip, ctx.ua, ctx.geo ? JSON.stringify(ctx.geo) : null, name, png ? "drawn" : "typed", png, fontK, signer.id)
  if (!r.changes) throw new UserError("You already signed this document")
  addEvent(envelope.id, "signed", { signerId: signer.id, ip: ctx.ip, ua: ctx.ua, geo: ctx.geo, details: { typedName: name, method: png ? "drawn" : "typed", font: png ? null : fontK } })
  await notify(`✍️ <b>${esc(signer.name)}</b> signed <b>${esc(envelope.title)}</b>\n${esc(ctx.geoLabel)} · ${esc(ctx.device)}`)
  // Advance: finish or invite the next tier. Failures here must not undo the signature.
  try {
    const remaining = getSigners(envelope.id).filter((s) => s.status !== "signed")
    if (!remaining.length) await completeEnvelope(envelope.id)
    else {
      await refreshInterim(envelope.id) // later signers review the document with this signature on it
      const sent = await sendPending(envelope.id)
      if (sent.length) await notify(`➡️ Next up on <b>${esc(envelope.title)}</b>: ${esc(sent.join(", "))} (invitation sent)`)
    }
  } catch (e) {
    console.error("[esign] advance failed:", e)
    addEvent(envelope.id, "advance_failed", { details: { error: String(e?.message || e) } })
    await notify(`🔴 e-sign: <b>${esc(envelope.title)}</b> — ${esc(signer.name)} signed, but the next step failed: ${esc(e?.message || e)}\nOpen ${env.baseUrl}/admin/e/${envelope.id} and use "Retry completion".`)
  }
}

export async function completeEnvelope(envelopeId) {
  const envelope = getEnvelope(envelopeId)
  if (!envelope) throw new UserError("Not found")
  const signers = getSigners(envelopeId)
  if (signers.some((s) => s.status !== "signed")) throw new UserError("Not everyone has signed")
  if (envelope.locked && envelope.final_path && fs.existsSync(envelope.final_path)) {
    // Already built — only redo the delivery steps that failed.
    return deliver(envelopeId)
  }
  const originalBytes = fs.readFileSync(envelope.original_path)
  if (sha256(originalBytes) !== envelope.original_sha256) throw new Error("Original document fingerprint mismatch — refusing to build")
  const ts = now()
  const draft = { ...envelope, status: "completed", completed_at: ts }
  const events = getEvents(envelopeId)
  const built = await buildFinalPdf({ originalBytes, envelope: draft, signers, events })
  const dir = envelopeDir(envelopeId)
  const signedPath = path.join(dir, "signed.pdf")
  const finalPath = path.join(dir, "final.pdf")
  fs.writeFileSync(signedPath, built.signedBytes)
  fs.writeFileSync(finalPath, built.finalBytes)
  readOnly(signedPath); readOnly(finalPath)
  run("UPDATE envelopes SET status = 'completed', completed_at = ?, signed_sha256 = ?, final_sha256 = ?, final_path = ?, locked = 1 WHERE id = ?",
    ts, built.signedSha256, built.finalSha256, finalPath, envelopeId)
  addEvent(envelopeId, "completed", { details: { signed_sha256: built.signedSha256, final_sha256: built.finalSha256 } })
  return deliver(envelopeId)
}

/** Drive filing + completion emails + Telegram. Idempotent per step. */
export async function deliver(envelopeId) {
  const envelope = getEnvelope(envelopeId)
  const signers = getSigners(envelopeId)
  const finalBytes = fs.readFileSync(envelope.final_path)
  if (sha256(finalBytes) !== envelope.final_sha256) throw new Error("Final document fingerprint mismatch")
  const filename = `${envelope.title.replace(/[\\/:*?"<>|]+/g, "-")} - SIGNED.pdf`
  const problems = []

  if (envelope.kind === "self") {
    if (!envelope.drive_final_id) {
      try {
        await fileSelfSign(envelope, finalBytes)
      } catch (e) {
        problems.push(`Drive: ${e?.message || e}`)
        console.error("[esign] drive upload failed:", e)
      }
    }
  } else if (!envelope.drive_final_id) {
    try {
      const drive = await driveClient()
      // Signed copies live in Offers/Signed/<street>/, mirroring the draft's
      // Offers/Drafts/<street>/ folder (drive_folder_id = the draft's folder until filed).
      let street = (envelope.property_address || envelope.title).split(",")[0].trim()
      if (envelope.source === "drive" && envelope.drive_folder_id) {
        const draftFolder = await driveMeta(drive, envelope.drive_folder_id).catch(() => null)
        const name = draftFolder?.name?.trim()
        if (name && name.toLowerCase() !== env.draftsPath.split("/").pop().toLowerCase()) street = name
      }
      const folderId = await driveResolvePath(drive, env.driveRootId, `${env.signedPath}/${street.replace(/[\\/:*?"<>|]+/g, "-")}`)
      const up = await driveUpload(drive, folderId, filename, finalBytes)
      run("UPDATE envelopes SET drive_final_id = ?, drive_final_link = ?, drive_folder_id = ? WHERE id = ?", up.id, up.webViewLink, folderId, envelopeId)
      addEvent(envelopeId, "filed_to_drive", { details: { fileId: up.id, link: up.webViewLink } })
    } catch (e) {
      problems.push(`Drive: ${e?.message || e}`)
      console.error("[esign] drive upload failed:", e)
    }
  }

  const already = new Set(getEvents(envelopeId).filter((e) => e.kind === "completion_email_sent" || e.kind === "completion_text_sent").map((e) => JSON.parse(e.details || "{}").to))
  for (const s of signers) {
    if ((s.delivery !== "text" && s.delivery !== "both") || !s.phone || already.has(s.phone)) continue
    try {
      await sendText(s.phone, completedText({ envelope, signer: s }))
      addEvent(envelopeId, "completion_text_sent", { details: { to: s.phone } })
    } catch (e) {
      problems.push(`Text to ${s.phone}: ${e?.message || e}`)
    }
  }
  const copyTo = envelope.copy_to ? JSON.parse(envelope.copy_to) : []
  const recipients = [...signers.filter((s) => s.email && s.delivery !== "text").map((s) => ({ name: s.name, email: s.email })), ...copyTo, { name: env.ownerName, email: env.senderEmail }]
  const seen = new Set()
  for (const r of recipients) {
    if (seen.has(r.email) || already.has(r.email)) continue
    seen.add(r.email)
    try {
      const mail = completedEmail({ envelope, signers, recipientName: r.name, finalSha256: envelope.final_sha256 })
      await sendMail({ to: `"${r.name.replace(/"/g, "")}" <${r.email}>`, subject: mail.subject, text: mail.text, html: mail.html, attachments: [{ filename, bytes: finalBytes }] })
      addEvent(envelopeId, "completion_email_sent", { details: { to: r.email } })
    } catch (e) {
      problems.push(`Email to ${r.email}: ${e?.message || e}`)
      console.error("[esign] completion email failed:", r.email, e)
    }
  }

  // The seller's lead card in Mission Control: Pending + the terms (lib/crm).
  // Runs once; a failure is a delivery problem, so "Retry completion" redoes it.
  let crmLine = ""
  let crmButtons
  if (crmEnabled() && isSellerContract(envelope, signers) && !getEvents(envelopeId).some((e) => e.kind === "crm_synced")) {
    try {
      const out = await reportContract("signed", getEnvelope(envelopeId), signers)
      addEvent(envelopeId, "crm_synced", { details: { status: out.status, leadId: out.leadId || null, closeBy: out.closeBy || null } })
      if (out.line) crmLine = `\n${out.line}`
      if (out.undo) crmButtons = [[{ text: "↩️ Undo lead card", data: out.undo }]]
    } catch (e) {
      problems.push(`Lead card: ${e?.message || e}`)
      console.error("[esign] lead card update failed:", e)
    }
  }

  const fresh = getEnvelope(envelopeId)
  const link = fresh.kind === "self" && fresh.drive_folder_link
    ? `\n📁 <a href="${fresh.drive_folder_link}">Folder in Drive</a> · <a href="${fresh.drive_signed_link}">signed copy</a>`
    : fresh.drive_final_link ? `\n📁 <a href="${fresh.drive_final_link}">Open in Drive</a>` : ""
  if (problems.length) {
    await notify(`🔴 e-sign: <b>${esc(envelope.title)}</b> is fully signed, but delivery had problems:\n• ${problems.map(esc).join("\n• ")}\nRetry from ${env.baseUrl}/admin/e/${envelopeId}`)
  } else if (!getEvents(envelopeId).some((e) => e.kind === "completion_notified")) {
    await notify(`✅ <b>${esc(envelope.title)}</b> is fully signed by ${esc(signers.map((s) => s.name).join(", "))}.\nCompleted PDF emailed to everyone${copyTo.length ? ` (copy to ${esc(copyTo.map((c) => c.name).join(", "))})` : ""}.${link}${crmLine}\nSHA-256 <code>${envelope.final_sha256.slice(0, 16)}…</code>`, { buttons: crmButtons })
    addEvent(envelopeId, "completion_notified")
  } else if (crmLine) {
    // A retry that only redid the lead card: the signed notice already went out.
    await notify(`<b>${esc(envelope.title)}</b>${crmLine}`, { buttons: crmButtons })
  }
  return { problems }
}

/**
 * Self-sign filing: one folder per document with the three versions. Each
 * upload is recorded as it lands, so a retry only uploads what is missing.
 */
async function fileSelfSign(envelope, finalBytes) {
  const drive = await driveClient()
  const folderId = await driveResolvePath(drive, env.driveRootId, envelope.filing_folder)
  if (!envelope.drive_folder_link) run("UPDATE envelopes SET drive_folder_id = ?, drive_folder_link = ? WHERE id = ?", folderId, driveFolderLink(folderId), envelope.id)
  const dir = envelopeDir(envelope.id)
  const label = envelope.doc_label || "Document"
  if (!envelope.drive_source_id) {
    const up = await driveUpload(drive, folderId, `${label} - original.pdf`, fs.readFileSync(envelope.source_path))
    run("UPDATE envelopes SET drive_source_id = ? WHERE id = ?", up.id, envelope.id)
  }
  if (!envelope.drive_signed_id) {
    const signedBytes = fs.readFileSync(path.join(dir, "signed.pdf"))
    if (sha256(signedBytes) !== envelope.signed_sha256) throw new Error("Signed document fingerprint mismatch")
    const up = await driveUpload(drive, folderId, `${label} - signed.pdf`, signedBytes)
    run("UPDATE envelopes SET drive_signed_id = ?, drive_signed_link = ? WHERE id = ?", up.id, up.webViewLink, envelope.id)
  }
  const up = await driveUpload(drive, folderId, `${label} - signed + certificate.pdf`, finalBytes)
  run("UPDATE envelopes SET drive_final_id = ?, drive_final_link = ? WHERE id = ?", up.id, up.webViewLink, envelope.id)
  addEvent(envelope.id, "filed_to_drive", { details: { folder: envelope.filing_folder, folderId, fileId: up.id } })
}

/**
 * Share the clean signed copy (never the folder, never the certificate copy)
 * view-only with one email address. No Google notification email — Ryan
 * sends the link himself. Returns the link to send.
 */
export async function shareSigned(envelopeId, email) {
  const envelope = getEnvelope(envelopeId)
  if (!envelope || envelope.kind !== "self") throw new UserError("Not a self-sign envelope")
  if (!envelope.drive_signed_id) throw new UserError("The signed copy isn't in Drive yet")
  email = String(email || "").trim().toLowerCase()
  if (!EMAIL_RE.test(email)) throw new UserError(`"${email}" is not a valid email`)
  const drive = await driveClient()
  await drive.permissions.create({
    fileId: envelope.drive_signed_id, sendNotificationEmail: false, supportsAllDrives: true,
    requestBody: { type: "user", role: "reader", emailAddress: email },
  })
  addEvent(envelopeId, "shared", { details: { fileId: envelope.drive_signed_id, with: email, role: "reader" } })
  return { link: envelope.drive_signed_link }
}

export async function voidEnvelope(envelopeId, reason) {
  const envelope = getEnvelope(envelopeId)
  if (!envelope) throw new UserError("Not found")
  if (envelope.locked || envelope.status === "completed") throw new UserError("Completed documents cannot be voided")
  if (envelope.status === "voided") return
  run("UPDATE envelopes SET status = 'voided', voided_at = ?, void_reason = ? WHERE id = ?", now(), reason || null, envelopeId)
  run("UPDATE signers SET token_hash = NULL WHERE envelope_id = ?", envelopeId)
  addEvent(envelopeId, "voided", { details: { reason } })
}
