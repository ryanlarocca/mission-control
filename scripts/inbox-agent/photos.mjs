// Inbox Agent — the pure rules behind filing listing photos
// (briefs/BRIEF_INBOX_MEDIA_DELIVERY_2026-10-15.md §4). Dependency-free so the
// unit tests and the worker (index.mjs) agree on every verdict.
//
// Ryan 2026-10-15: "never put the same photo in twice" — and near-duplicates
// are mentioned on the card, never silently dropped.

/**
 * Statuses that count as "already on file" for the sha256 layer — the same
 * set recordAttachment uses, so an attachment and a fetched photo dedupe alike.
 */
export const DUP_STATUSES = ["filed", "pending", "approved", "waiting", "interview", "changed", "change_requested"]

/**
 * Three dedupe layers, in order, for one photo about to go into one Drive folder:
 *   (a) sha256 already recorded in inbox_files            → duplicate / "sha"
 *   (b) same filename AND same size already in the folder → duplicate / "name_size" (carries the existing Drive file)
 *   (c) same imageId already recorded for this property   → duplicate / "image_id" ("re-edited? kept the existing copy")
 *   same filename but a different size                    → new, with a " (2)" style suffix ("looked like a duplicate but differed")
 *   anything else                                         → new
 *
 * `imageId` is whatever key the caller stores in inbox_files.attachment_id
 * (the worker uses `f8:<imageId>:<set>` so the MLS and Print copies of one
 * photo are tracked apart); `knownImageIds` holds the same keys.
 *
 * @param {{ sha: string, filename: string, size: number, imageId?: string|null }} file
 * @param {{ knownShas: Set<string>|string[], folderFiles: Array<{ name: string, size?: number|string|null, id?: string, webViewLink?: string }>, knownImageIds: Set<string>|string[] }} known
 * @returns {{ verdict: "new"|"duplicate", reason: "sha"|"name_size"|"image_id"|null, suffix: boolean, existing: { name: string, size?: number|string|null, id?: string, webViewLink?: string }|null }}
 */
export function photoDedupeVerdict({ sha, filename, size, imageId = null }, { knownShas, folderFiles, knownImageIds }) {
  const shas = knownShas instanceof Set ? knownShas : new Set(knownShas || [])
  const ids = knownImageIds instanceof Set ? knownImageIds : new Set(knownImageIds || [])
  const name = String(filename || "").toLowerCase()
  const sameName = (folderFiles || []).filter((f) => String(f?.name || "").toLowerCase() === name)
  if (sha && shas.has(sha)) return { verdict: "duplicate", reason: "sha", suffix: false, existing: null }
  const sameNameSize = sameName.find((f) => f.size != null && Number(f.size) === Number(size))
  if (sameNameSize) return { verdict: "duplicate", reason: "name_size", suffix: false, existing: sameNameSize }
  if (imageId && ids.has(imageId)) return { verdict: "duplicate", reason: "image_id", suffix: false, existing: null }
  return { verdict: "new", reason: null, suffix: sameName.length > 0, existing: null }
}

/**
 * "name.JPG" → "name (2).JPG", "name (3).JPG", … — the first one not already in `existingNames`.
 * @param {string} filename
 * @param {Iterable<string>} existingNames
 */
export function suffixedFilename(filename, existingNames) {
  const taken = new Set([...(existingNames || [])].map((n) => String(n).toLowerCase()))
  const m = /^(.*?)(\.[a-z0-9]{1,6})?$/i.exec(String(filename || "file"))
  const base = m?.[1] || String(filename)
  const ext = m?.[2] || ""
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} (${n})${ext}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return `${base} (${Date.now()})${ext}`
}

/**
 * Property label from a media-delivery subject when the classifier gave none:
 * "f8 Media Delivery: 5764 Halleck Dr, San Jose, CA 95123" → "5764 Halleck Dr".
 * Takes the text after the first colon (or the whole subject), up to the
 * first comma — city/state/zip stripped — and ignores Re:/Fwd: prefixes.
 * @param {string|null|undefined} subject
 * @returns {string|null}
 */
export function propertyLabelFromSubject(subject) {
  let s = String(subject || "").replace(/\s+/g, " ").trim()
  s = s.replace(/^((re|fw|fwd)\s*:\s*)+/i, "")
  const colon = s.indexOf(":")
  if (colon >= 0) s = s.slice(colon + 1)
  s = s.split(",")[0].replace(/\s*[-–—]\s*$/, "").trim()
  // Written without commas ("93 Ridgeview Ave San Jose CA 95127"): keep number + street up to the suffix word.
  const street = /^(\d+[a-z0-9-]*\s+.+?\s+(ave|avenue|dr|drive|st|street|rd|road|ct|court|ln|lane|blvd|boulevard|way|pl|place|cir|circle|ter|terrace|hwy|highway)\.?)(\s|$)/i.exec(s)
  if (street) s = street[1]
  return s || null
}

/**
 * Ryan's reply to the "New property?" card → a Drive path under the shared root.
 * "Halleck" → "Properties/Halleck"; "Properties/2025/674 Kirkland Dr/" → as is;
 * "skip" (or empty) → null.
 * @param {string|null|undefined} text
 * @returns {string|null}
 */
export function propertyFolderFromReply(text) {
  let s = String(text || "").trim().replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "").trim()
  if (!s || /^(skip|no|none|ignore)\b/i.test(s)) return null
  s = s.replace(/^\/+|\/+$/g, "").replace(/\s*\/\s*/g, "/")
  s = s.replace(/^business operations\//i, "")
  if (!/^properties\//i.test(s)) s = `Properties/${s}`
  return s.replace(/^properties\//i, "Properties/")
}

/** The Gmail deep link the final ⚠️ card carries (Ryan's mailbox, All Mail). */
export function gmailLink(gmailId, mailbox = "ryan@lrghomes.com") {
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(mailbox)}#all/${gmailId}`
}
