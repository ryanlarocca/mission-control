// Envelope lifecycle: create → send (in signing order) → open → consent →
// sign → complete (final PDF, Drive, email, Telegram). Completed envelopes
// are locked: no route can change them or their files.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { env } from "./env.mjs"
import { getDb, now, run, one, addEvent, getEnvelope, getSigners, getSigner, getEvents } from "./db.mjs"
import { sha256, inspectPdf, renderPages, buildFinalPdf } from "./pdf.mjs"
import { CONSENT_VERSION } from "./consent.mjs"
import { fontKey } from "./fonts.mjs"
import { sendMail, driveClient, driveDownload, driveMeta, driveResolvePath, driveUpload } from "./google.mjs"
import { inviteEmail, completedEmail, inviteText, completedText } from "./emails.mjs"
import { sendText, normalizePhone } from "./sms.mjs"
import { notify, esc } from "./notify.mjs"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export class UserError extends Error {}

export function envelopeDir(id) {
  return path.join(env.dataDir, "envelopes", id)
}

function readOnly(file) {
  try { fs.chmodSync(file, 0o444) } catch { /* best effort */ }
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
    let delivery = ["email", "text", "both"].includes(s.delivery) ? s.delivery : "email"
    if (!name && !email && !phoneRaw) continue
    if (!name) throw new UserError(`Signer ${i + 1}: name is required`)
    if (email && !EMAIL_RE.test(email)) throw new UserError(`Signer ${i + 1} (${name}): "${email}" is not a valid email`)
    if (phoneRaw && !phone) throw new UserError(`Signer ${i + 1} (${name}): "${phoneRaw}" is not a 10-digit phone number`)
    if (delivery !== "email" && !phone) throw new UserError(`Signer ${i + 1} (${name}): a phone number is needed to send by text`)
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

/**
 * Create an envelope and send the first round of invitations.
 * `pdfBytes` or `driveFileId` (downloaded through Ryan's Drive) — one of them.
 */
export async function createEnvelope({ title, propertyAddress, agreementDate, message, pdfBytes, driveFileId, signers, createdBy }) {
  const db = getDb()
  const cleanSigners = normalizeSigners(signers)
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
    original_sha256, original_path, page_count, is_template, status, created_at, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const insertSigner = db.prepare(`INSERT INTO signers (id, envelope_id, order_index, role, name, email, phone, delivery, placement, status) VALUES (?,?,?,?,?,?,?,?,?,?)`)
  db.exec("BEGIN")
  try {
    insertEnv.run(id, title, propertyAddress || null, agreementDate || null, message || null, driveFileId ? "drive" : "upload", driveFileId || null, driveFolderId,
      sha256(bytes), originalPath, pageCount, info.isTemplate ? 1 : 0, "in_progress", ts, createdBy || "admin")
    for (const s of cleanSigners) {
      const placement = s === firstSeller || s === firstBuyer ? "template" : "addendum"
      insertSigner.run(crypto.randomBytes(6).toString("hex"), id, s.order, s.role, s.name, s.email, s.phone, s.delivery, placement, "waiting")
    }
    db.exec("COMMIT")
  } catch (e) {
    db.exec("ROLLBACK")
    throw e
  }
  addEvent(id, "created", { details: { title, pages: pageCount, template: info.isTemplate, source: driveFileId ? "drive" : "upload", signers: cleanSigners.length } })
  const sent = await sendPending(id)
  return { id, sent }
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
  const wantText = signer.delivery !== "email" && signer.phone
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

  if (!envelope.drive_final_id) {
    try {
      const drive = await driveClient()
      let folderId = envelope.drive_folder_id
      if (!folderId) {
        const street = (envelope.property_address || envelope.title).split(",")[0].trim().replace(/[\\/:*?"<>|]+/g, "-")
        folderId = await driveResolvePath(drive, env.driveRootId, `E-Sign/${street}`)
      }
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
    if (s.delivery === "email" || !s.phone || already.has(s.phone)) continue
    try {
      await sendText(s.phone, completedText({ envelope, signer: s }))
      addEvent(envelopeId, "completion_text_sent", { details: { to: s.phone } })
    } catch (e) {
      problems.push(`Text to ${s.phone}: ${e?.message || e}`)
    }
  }
  const recipients = [...signers.filter((s) => s.email && s.delivery !== "text").map((s) => ({ name: s.name, email: s.email })), { name: env.ownerName, email: env.senderEmail }]
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

  const fresh = getEnvelope(envelopeId)
  const link = fresh.drive_final_link ? `\n📁 <a href="${fresh.drive_final_link}">Open in Drive</a>` : ""
  if (problems.length) {
    await notify(`🔴 e-sign: <b>${esc(envelope.title)}</b> is fully signed, but delivery had problems:\n• ${problems.map(esc).join("\n• ")}\nRetry from ${env.baseUrl}/admin/e/${envelopeId}`)
  } else if (!getEvents(envelopeId).some((e) => e.kind === "completion_notified")) {
    await notify(`✅ <b>${esc(envelope.title)}</b> is fully signed by ${esc(signers.map((s) => s.name).join(", "))}.\nCompleted PDF emailed to everyone.${link}\nSHA-256 <code>${envelope.final_sha256.slice(0, 16)}…</code>`)
    addEvent(envelopeId, "completion_notified")
  }
  return { problems }
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
