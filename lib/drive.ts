import { Readable } from "node:stream"
import { google, type drive_v3 } from "googleapis"

// Google Drive via domain-wide delegation, impersonating ryan@lrghomes.com —
// the TypeScript port of scripts/inbox-agent/drive.mjs (offer bot brief,
// 2026-10-15). Same arrangement: Ryan shares "Business Operations" from his
// personal Drive with ryan@lrghomes.com (Editor); the service account
// impersonates that mailbox with the full `drive` scope; uploads land in the
// shared folder. Never calls permissions.create — nothing here shares a file.

export const DRIVE_SUBJECT = "ryan@lrghomes.com"
const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive"]
export const FOLDER_MIME = "application/vnd.google-apps.folder"

export type Drive = drive_v3.Drive

export interface DriveChild {
  id: string
  name: string
  mimeType: string
  webViewLink?: string | null
}

export async function driveClient(subject: string = DRIVE_SUBJECT): Promise<Drive> {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!keyJson) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set")
  const credentials = JSON.parse(keyJson) as { client_email: string; private_key: string }
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: DRIVE_SCOPES,
    subject,
  })
  await auth.authorize()
  return google.drive({ version: "v3", auth })
}

/** Download a file's bytes (`files.get` with `alt=media`). */
export async function downloadDriveFile(drive: Drive, fileId: string): Promise<Buffer> {
  const res = await drive.files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" })
  return Buffer.from(res.data as ArrayBuffer)
}

/** Every non-trashed child of a folder, name-sorted. */
export async function listDriveChildren(drive: Drive, folderId: string): Promise<DriveChild[]> {
  const out: DriveChild[] = []
  let pageToken: string | undefined
  do {
    const { data } = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, webViewLink)",
      pageSize: 200,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })
    for (const f of data.files ?? []) {
      if (f.id && f.name) out.push({ id: f.id, name: f.name, mimeType: f.mimeType ?? "", webViewLink: f.webViewLink })
    }
    pageToken = data.nextPageToken ?? undefined
  } while (pageToken)
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** "Offers/Drafts/1234 Main St" → folder id under `rootId`, creating missing levels
 *  when `create` is set. Case-insensitive name match, like the .mjs original. */
export async function resolveDrivePath(
  drive: Drive,
  rootId: string,
  relPath: string,
  opts: { create?: boolean } = {}
): Promise<{ id: string | null; created: string[]; missing: string | null }> {
  const segs = String(relPath || "").split("/").map((s) => s.trim()).filter(Boolean)
  let parent = rootId
  const created: string[] = []
  for (const name of segs) {
    const kids = await listDriveChildren(drive, parent)
    const hit = kids.find((k) => k.mimeType === FOLDER_MIME && k.name.toLowerCase() === name.toLowerCase())
    if (hit) {
      parent = hit.id
      continue
    }
    if (!opts.create) return { id: null, created, missing: name }
    const { data } = await drive.files.create({
      requestBody: { name, mimeType: FOLDER_MIME, parents: [parent] },
      fields: "id",
      supportsAllDrives: true,
    })
    if (!data.id) throw new Error(`Drive: creating folder "${name}" returned no id`)
    created.push(name)
    parent = data.id
  }
  return { id: parent, created, missing: null }
}

/** Upload bytes as a new file in `folderId`. Returns id + webViewLink. */
export async function uploadDriveFile(
  drive: Drive,
  folderId: string,
  name: string,
  mime: string,
  bytes: Buffer | Uint8Array
): Promise<{ id: string; webViewLink: string | null; name: string }> {
  const { data } = await drive.files.create({
    requestBody: { name, parents: [folderId] },
    media: { mimeType: mime || "application/octet-stream", body: Readable.from(Buffer.from(bytes)) },
    fields: "id, webViewLink, name",
    supportsAllDrives: true,
  })
  if (!data.id) throw new Error(`Drive: upload of "${name}" returned no id`)
  return { id: data.id, webViewLink: data.webViewLink ?? null, name: data.name ?? name }
}
