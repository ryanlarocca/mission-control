// Inbox Agent — Google Drive via DWD, impersonating ryan@lrghomes.com.
//
// Ryan's working Drive ("My PC / My Hard Drive / Business Operations /
// Properties / <address>") lives in his PERSONAL Google account
// (ryanlarocca1219@gmail.com), which DWD can't impersonate. The arrangement:
// Ryan shares "Business Operations" with ryan@lrghomes.com (Editor), the
// service account impersonates ryan@lrghomes.com with the full `drive` scope,
// and uploads land in the shared folder. Files are owned by ryan@lrghomes.com
// but live where Ryan looks for them. Two one-time setup steps, both Ryan's:
//   1. Drive → Business Operations → Share → ryan@lrghomes.com, Editor.
//   2. admin.google.com → Security → API controls → Domain-wide delegation →
//      client 118033894408819500850 → add https://www.googleapis.com/auth/drive
// `node scripts/check-dwd-scopes.mjs ryan@lrghomes.com --scopes=https://www.googleapis.com/auth/drive`
// proves step 2; `node scripts/inbox-agent/index.mjs --drive-check` proves both.
import { Readable } from "node:stream"
import { google } from "googleapis"
import { DRIVE_ROOT_NAME, MAILBOX, getSetting, setSetting } from "./env.mjs"

const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive"]
const FOLDER = "application/vnd.google-apps.folder"

export async function driveClient(mailbox = MAILBOX) {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!keyJson) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set")
  const credentials = JSON.parse(keyJson)
  const auth = new google.auth.JWT({ email: credentials.client_email, key: credentials.private_key, scopes: DRIVE_SCOPES, subject: mailbox })
  await auth.authorize()
  return google.drive({ version: "v3", auth })
}

function q(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")
}

export async function listChildren(drive, folderId) {
  const out = []
  let pageToken
  do {
    const { data } = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, modifiedTime, size, webViewLink)",
      pageSize: 200,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })
    out.push(...(data.files || []))
    pageToken = data.nextPageToken || undefined
  } while (pageToken)
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** The shared "Business Operations" folder id (cached in inbox_settings.drive). */
export async function findRoot(drive) {
  const s = await getSetting("drive")
  if (process.env.INBOX_DRIVE_ROOT_ID) return process.env.INBOX_DRIVE_ROOT_ID
  if (s.root_id) {
    try {
      await drive.files.get({ fileId: s.root_id, fields: "id", supportsAllDrives: true })
      return s.root_id
    } catch {
      /* fall through and search again */
    }
  }
  const { data } = await drive.files.list({
    q: `name = '${q(DRIVE_ROOT_NAME)}' and mimeType = '${FOLDER}' and trashed = false`,
    fields: "files(id, name, owners(emailAddress), sharedWithMeTime)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    pageSize: 10,
  })
  const files = data.files || []
  if (!files.length) {
    throw new Error(`Drive folder "${DRIVE_ROOT_NAME}" is not visible to ${MAILBOX} — share it with that account (Editor) from the personal Drive.`)
  }
  const pick = files.find((f) => f.sharedWithMeTime) || files[0]
  await setSetting("drive", { root_id: pick.id, root_owner: pick.owners?.[0]?.emailAddress || null, found_at: new Date().toISOString() })
  return pick.id
}

/** "Properties/93 Ridgeview" → folder id under root, creating as needed. */
export async function resolvePath(drive, rootId, relPath, { create = false } = {}) {
  const segs = String(relPath || "").split("/").map((s) => s.trim()).filter(Boolean)
  // Tolerate the root name being included in the path.
  if (segs[0] && segs[0].toLowerCase() === DRIVE_ROOT_NAME.toLowerCase()) segs.shift()
  let parent = rootId
  const created = []
  for (const name of segs) {
    const kids = await listChildren(drive, parent)
    const hit = kids.find((k) => k.mimeType === FOLDER && k.name.toLowerCase() === name.toLowerCase())
    if (hit) {
      parent = hit.id
      continue
    }
    if (!create) return { id: null, created, missing: name }
    const { data } = await drive.files.create({
      requestBody: { name, mimeType: FOLDER, parents: [parent] },
      fields: "id",
      supportsAllDrives: true,
    })
    created.push(name)
    parent = data.id
  }
  return { id: parent, created, missing: null }
}

/** Text rendering of Properties (2 levels) for prompts + interview guesses. */
export async function folderTree(drive, rootId, { maxDepth = 3 } = {}) {
  const lines = []
  async function rec(folderId, prefix, depth) {
    const kids = await listChildren(drive, folderId)
    const folders = kids.filter((k) => k.mimeType === FOLDER)
    const files = kids.filter((k) => k.mimeType !== FOLDER)
    for (const f of folders) {
      lines.push(`${prefix}${f.name}/`)
      if (depth < maxDepth) await rec(f.id, prefix + "  ", depth + 1)
    }
    const shown = files.slice(0, 12)
    for (const f of shown) lines.push(`${prefix}${f.name}`)
    if (files.length > shown.length) lines.push(`${prefix}… +${files.length - shown.length} more files`)
  }
  lines.push(`${DRIVE_ROOT_NAME}/`)
  await rec(rootId, "  ", 1)
  return lines.join("\n")
}

/** Property folders directly under Properties/ and one level down (year buckets). */
export async function propertyFolders(drive, rootId) {
  const props = await resolvePath(drive, rootId, "Properties")
  if (!props.id) return []
  const out = []
  const top = await listChildren(drive, props.id)
  for (const k of top) {
    if (k.mimeType !== FOLDER) continue
    out.push({ id: k.id, name: k.name, path: `Properties/${k.name}` })
    if (/^(19|20)\d{2}$|^old$/i.test(k.name)) {
      for (const g of await listChildren(drive, k.id)) {
        if (g.mimeType === FOLDER) out.push({ id: g.id, name: g.name, path: `Properties/${k.name}/${g.name}` })
      }
    }
  }
  return out
}

export async function findFileByName(drive, folderId, name) {
  const kids = await listChildren(drive, folderId)
  return kids.find((k) => k.mimeType !== FOLDER && k.name.toLowerCase() === name.toLowerCase()) || null
}

export async function uploadFile(drive, folderId, name, mime, buffer) {
  const { data } = await drive.files.create({
    requestBody: { name, parents: [folderId] },
    media: { mimeType: mime || "application/octet-stream", body: Readable.from(buffer) },
    fields: "id, webViewLink, name",
    supportsAllDrives: true,
  })
  return data
}
