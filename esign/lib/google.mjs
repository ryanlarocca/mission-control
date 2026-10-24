// Gmail + Drive through the Workspace service account (domain-wide
// delegation, impersonating ryan@lrghomes.com). Same arrangement Mission
// Control uses: `gmail.modify` is the granted scope (send works under it);
// Drive uploads land in Ryan's own folders.
import { Readable } from "node:stream"
import { google } from "googleapis"
import MailComposer from "nodemailer/lib/mail-composer/index.js"
import { env } from "./env.mjs"

function jwt(scopes, subject) {
  const cred = env.googleKey()
  return new google.auth.JWT({ email: cred.client_email, key: cred.private_key, scopes, subject })
}

export async function gmailClient() {
  const auth = jwt(["https://www.googleapis.com/auth/gmail.modify"], env.senderEmail)
  await auth.authorize()
  return google.gmail({ version: "v1", auth })
}

export async function driveClient() {
  const auth = jwt(["https://www.googleapis.com/auth/drive"], env.driveSubject)
  await auth.authorize()
  return google.drive({ version: "v3", auth })
}

/**
 * Send a multipart (text + HTML [+ attachments]) email from Ryan's mailbox.
 * Returns the Gmail message id. Throws on failure — callers decide.
 */
export async function sendMail({ to, cc, subject, text, html, attachments = [], replyTo }) {
  const composer = new MailComposer({
    from: `"${env.senderName.replace(/"/g, "")}" <${env.senderEmail}>`,
    to,
    cc,
    replyTo: replyTo || env.senderEmail,
    subject,
    text,
    html,
    attachments: attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.bytes), contentType: a.contentType || "application/pdf" })),
  })
  const raw = await composer.compile().build()
  if (process.env.ESIGN_DRY_MAIL === "1") {
    console.log(`[esign] DRY MAIL to=${Array.isArray(to) ? to.join(",") : to} subject=${JSON.stringify(subject)}\n${text}`)
    return "dry-run"
  }
  const gmail = await gmailClient()
  const { data } = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: raw.toString("base64url") },
  })
  return data.id
}

export const FOLDER_MIME = "application/vnd.google-apps.folder"

export async function driveDownload(drive, fileId) {
  const res = await drive.files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" })
  return Buffer.from(res.data)
}

export async function driveMeta(drive, fileId) {
  const { data } = await drive.files.get({ fileId, fields: "id, name, mimeType, parents, webViewLink", supportsAllDrives: true })
  return data
}

export async function driveChildren(drive, folderId, { mime, orderBy = "name" } = {}) {
  const out = []
  let pageToken
  do {
    const q = [`'${folderId}' in parents`, "trashed = false", mime ? `mimeType = '${mime}'` : null].filter(Boolean).join(" and ")
    const { data } = await drive.files.list({
      q, fields: "nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink)", pageSize: 200, pageToken, orderBy,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    })
    out.push(...(data.files ?? []))
    pageToken = data.nextPageToken ?? undefined
  } while (pageToken)
  return out
}

/** "Offers/Drafts/1234 Main St" under rootId; creates missing levels. */
export async function driveResolvePath(drive, rootId, relPath, { create = true } = {}) {
  let parent = rootId
  for (const name of String(relPath).split("/").map((s) => s.trim()).filter(Boolean)) {
    const kids = await driveChildren(drive, parent, { mime: FOLDER_MIME })
    const hit = kids.find((k) => k.name.toLowerCase() === name.toLowerCase())
    if (hit) { parent = hit.id; continue }
    if (!create) return null
    const { data } = await drive.files.create({ requestBody: { name, mimeType: FOLDER_MIME, parents: [parent] }, fields: "id", supportsAllDrives: true })
    parent = data.id
  }
  return parent
}

export async function driveUpload(drive, folderId, name, bytes, mime = "application/pdf") {
  const { data } = await drive.files.create({
    requestBody: { name, parents: [folderId] },
    media: { mimeType: mime, body: Readable.from(Buffer.from(bytes)) },
    fields: "id, webViewLink, name",
    supportsAllDrives: true,
  })
  return { id: data.id, webViewLink: data.webViewLink ?? null, name: data.name ?? name }
}

/** Recent PDFs under Business Operations/Offers/Drafts/<street>/ for the admin picker. */
export async function listRecentOffers(drive, limit = 25) {
  const offersId = await driveResolvePath(drive, env.driveRootId, env.draftsPath, { create: false })
  if (!offersId) return []
  const folders = await driveChildren(drive, offersId, { mime: FOLDER_MIME, orderBy: "modifiedTime desc" })
  const out = []
  for (const f of folders.slice(0, 15)) {
    const pdfs = await driveChildren(drive, f.id, { mime: "application/pdf", orderBy: "modifiedTime desc" })
    for (const p of pdfs) out.push({ id: p.id, name: p.name, folder: f.name, folderId: f.id, modifiedTime: p.modifiedTime })
    if (out.length >= limit) break
  }
  return out.sort((a, b) => (a.modifiedTime < b.modifiedTime ? 1 : -1)).slice(0, limit)
}
