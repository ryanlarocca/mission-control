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
      fields: "nextPageToken, files(id, name, mimeType, modifiedTime, size, md5Checksum, webViewLink)",
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

// Ryan 2026-10-02: marketing lists (Chicago Title farm lists etc.) live in the
// sibling top-level folder "Marketing", which he shared with ryan@lrghomes.com
// the same night. Paths starting with "Marketing/" resolve against that root.
const EXTRA_ROOTS = {} // lower-case first segment → folder id
export async function findExtraRoots(drive) {
  const s = await getSetting("drive")
  const wanted = ["Marketing"]
  for (const name of wanted) {
    const key = name.toLowerCase()
    const cached = s.extra_roots?.[key]
    if (cached) {
      try {
        await drive.files.get({ fileId: cached, fields: "id", supportsAllDrives: true })
        EXTRA_ROOTS[key] = cached
        continue
      } catch {
        /* re-search */
      }
    }
    const { data } = await drive.files.list({
      q: `name = '${q(name)}' and mimeType = '${FOLDER}' and trashed = false and sharedWithMe = true`,
      fields: "files(id, name, owners(emailAddress), sharedWithMeTime)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageSize: 10,
    })
    const pick = (data.files || [])[0]
    if (pick) EXTRA_ROOTS[key] = pick.id
  }
  await setSetting("drive", { extra_roots: { ...EXTRA_ROOTS } })
  return { ...EXTRA_ROOTS }
}
export function extraRoots() {
  return { ...EXTRA_ROOTS }
}

/** "Properties/93 Ridgeview" → folder id under root, creating as needed.
 *  "Marketing/2026/…" resolves against the shared Marketing root when known. */
export async function resolvePath(drive, rootId, relPath, { create = false } = {}) {
  const segs = String(relPath || "").split("/").map((s) => s.trim()).filter(Boolean)
  // Tolerate the root name being included in the path.
  if (segs[0] && segs[0].toLowerCase() === DRIVE_ROOT_NAME.toLowerCase()) segs.shift()
  let parent = rootId
  if (segs[0] && EXTRA_ROOTS[segs[0].toLowerCase()]) {
    parent = EXTRA_ROOTS[segs[0].toLowerCase()]
    segs.shift()
  }
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
  for (const [key, id] of Object.entries(EXTRA_ROOTS)) {
    lines.push(`${key[0].toUpperCase()}${key.slice(1)}/  (separate shared folder — paths start with "${key[0].toUpperCase()}${key.slice(1)}/")`)
    await rec(id, "  ", 2)
  }
  return lines.join("\n")
}

/** Google-native files (Docs, Sheets, …) have no md5Checksum and no bytes to compare against. */
const GOOGLE_NATIVE_RE = /^application\/vnd\.google-apps\./
export const WALK_MAX_FILES = 2000

/**
 * Every non-folder descendant of a folder (Part G of briefs/BRIEF_INBOX_LOOP_HYGIENE_2026-10-17.md):
 * [{ id, name, size, md5Checksum, webViewLink, path }], `path` relative to the
 * walked folder ("NOO October2026/Raw/v2 2026-10-14 - ALL SC Co NOO SFR 11+ yr.csv"),
 * prefixed with `pathPrefix` when given. Breadth-first, `maxDepth` levels deep,
 * capped at ~2,000 files; Google-native types are skipped (no md5 to match).
 */
export async function walkFolder(drive, folderId, { maxDepth = 4, maxFiles = WALK_MAX_FILES, pathPrefix = "" } = {}) {
  const out = []
  const queue = [{ id: folderId, prefix: pathPrefix ? `${pathPrefix}/` : "", depth: 1 }]
  while (queue.length && out.length < maxFiles) {
    const { id, prefix, depth } = queue.shift()
    const kids = await listChildren(drive, id)
    for (const k of kids) {
      if (k.mimeType === FOLDER) {
        if (depth < maxDepth) queue.push({ id: k.id, prefix: `${prefix}${k.name}/`, depth: depth + 1 })
        continue
      }
      if (GOOGLE_NATIVE_RE.test(k.mimeType || "")) continue
      out.push({ id: k.id, name: k.name, size: k.size != null ? Number(k.size) : null, md5Checksum: k.md5Checksum || null, webViewLink: k.webViewLink || null, path: `${prefix}${k.name}` })
      if (out.length >= maxFiles) break
    }
  }
  return out
}

/** Download a Drive file's bytes (for settlement-statement diffs). */
export async function downloadFile(drive, fileId) {
  const res = await drive.files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" })
  return Buffer.from(res.data)
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

// ---- campaign folders (briefs/BRIEF_INBOX_VENDOR_FILING_TAPINSPECT_2026-10-16.md, Part A2)
// A campaign's Drive folder is pinned by id (campaigns.drive_folder_id — "My
// Hard Drive / Marketing / 2026 / NOO October2026"), not resolved by path; the
// vendor subfolder inside it is found by name prefix ("3 - MAIL HOUSE" matches
// "3 - MAIL HOUSE (quote, invoice, proofs)") and created bare when missing.

/** {id, name, webViewLink, parents} of a folder/file by id, or null when it is not visible to the agent. */
export async function getFile(drive, fileId) {
  try {
    const { data } = await drive.files.get({ fileId, fields: "id, name, mimeType, webViewLink, parents", supportsAllDrives: true })
    return data
  } catch {
    return null
  }
}

/** The child folder whose name starts with `prefix` (case-insensitive), the shortest match first; created as `prefix` when missing and `create`. */
export async function childFolderByPrefix(drive, parentId, prefix, { create = false } = {}) {
  const want = String(prefix || "").trim().toLowerCase()
  const kids = (await listChildren(drive, parentId)).filter((k) => k.mimeType === FOLDER && k.name.toLowerCase().startsWith(want))
  const hit = kids.sort((a, b) => a.name.length - b.name.length)[0]
  if (hit) return { id: hit.id, name: hit.name, created: false }
  if (!create) return { id: null, name: null, created: false }
  const { data } = await drive.files.create({ requestBody: { name: prefix, mimeType: FOLDER, parents: [parentId] }, fields: "id, name", supportsAllDrives: true })
  return { id: data.id, name: data.name, created: true }
}

/**
 * "Marketing/2026/NOO October2026/3 - MAIL HOUSE (…)" for a folder id: walk the
 * parents up to a known root (the shared Marketing / Business Operations
 * folders) or the top of what the agent can see. Bounded to 12 levels.
 */
export async function folderPathOf(drive, folderId, rootId = null) {
  const roots = new Map(Object.entries(EXTRA_ROOTS).map(([key, id]) => [id, key[0].toUpperCase() + key.slice(1)]))
  if (rootId) roots.set(rootId, DRIVE_ROOT_NAME)
  const segs = []
  let id = folderId
  for (let i = 0; id && i < 12; i++) {
    if (roots.has(id)) {
      const label = roots.get(id)
      if (label !== DRIVE_ROOT_NAME) segs.unshift(label)
      break
    }
    const f = await getFile(drive, id)
    if (!f) break
    segs.unshift(f.name)
    id = f.parents?.[0] || null
  }
  return segs.join("/")
}

/** Rename a Drive file in place (ITI invoices: … SUPERSEDED / … PAID). */
export async function renameFile(drive, fileId, name) {
  const { data } = await drive.files.update({ fileId, requestBody: { name }, fields: "id, name, webViewLink", supportsAllDrives: true })
  return data
}

/** Replace a Drive file's bytes in place, same id and links (StyleMe: the paid copy of an invoice replaces the outstanding one — Part D of the 2026-10-17 staging brief). */
export async function updateFileContent(drive, fileId, mime, buffer) {
  const { data } = await drive.files.update({
    fileId,
    media: { mimeType: mime || "application/octet-stream", body: Readable.from(buffer) },
    fields: "id, name, webViewLink, size, md5Checksum",
    supportsAllDrives: true,
  })
  return data
}

/** Move a file between folders (undo → Properties/_Unsorted). */
export async function moveFile(drive, fileId, toFolderId) {
  const { data } = await drive.files.get({ fileId, fields: "parents", supportsAllDrives: true })
  await drive.files.update({
    fileId,
    addParents: toFolderId,
    removeParents: (data.parents || []).join(","),
    fields: "id, webViewLink",
    supportsAllDrives: true,
  })
}
