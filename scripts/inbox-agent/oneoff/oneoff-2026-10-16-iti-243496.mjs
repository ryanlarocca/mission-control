// Ryan 2026-10-16: the agreed ITI invoice 243496 lived only in Gmail. File it into the
// NOO Q4 2026 campaign's "3 - MAIL HOUSE" folder, mark the disputed 243481 SUPERSEDED,
// and move the ITI invoice-audit workbook in beside them. Idempotent; bytes untouched on moves.
import { gmailClient } from "../gmail.mjs"
import { driveClient, listChildren, uploadFile, moveFile } from "../drive.mjs"

const MAIL_HOUSE = "1xBrFye93LmOZ81s2UHsJ6vS1LUVupXrI"
const WORKBOOK = "1OSuc7w4ZjTJyrIgL5BURNufA05R8oeJjndrKT24eWa4"
const MSG = "1a14686438fae4d0" // Juan 2026-10-16 "best we could do" — 243496, total $10,385.57
const NEW_NAME = "ITI invoice 243496 - 2026-10-16 - $10,385.57.pdf"
const OLD_PREFIX = "ITI invoice 243481 - 2026-10-14 - $11,197.11"
const OLD_NEW_NAME = `${OLD_PREFIX} SUPERSEDED.pdf`

const gmail = await gmailClient("ryan@lrghomes.com")
const drive = await driveClient()
const kids = await listChildren(drive, MAIL_HOUSE)
const log = (...a) => console.log(...a)

// 1. invoice 243496 from Gmail → Drive
if (kids.find((k) => k.name === NEW_NAME)) log("exists |", NEW_NAME)
else {
  const { data } = await gmail.users.messages.get({ userId: "me", id: MSG, format: "full" })
  const walk = (p, acc = []) => { if (p.filename && p.body?.attachmentId) acc.push(p); for (const c of p.parts ?? []) walk(c, acc); return acc }
  const part = walk(data.payload).find((p) => /^243496_.*\.pdf$/i.test(p.filename))
  if (!part) throw new Error("243496 PDF not found on the message")
  const { data: a } = await gmail.users.messages.attachments.get({ userId: "me", messageId: MSG, id: part.body.attachmentId })
  const buf = Buffer.from(a.data, "base64url")
  const r = await uploadFile(drive, MAIL_HOUSE, NEW_NAME, "application/pdf", buf)
  log("uploaded |", NEW_NAME, "| bytes", buf.length, "| id", r?.id || JSON.stringify(r))
}

// 2. 243481 → SUPERSEDED
const old = kids.find((k) => k.name.startsWith(OLD_PREFIX) && !/SUPERSEDED/.test(k.name))
if (old) { await drive.files.update({ fileId: old.id, requestBody: { name: OLD_NEW_NAME }, fields: "id", supportsAllDrives: true }); log("renamed |", old.name, "→", OLD_NEW_NAME) }
else log("243481 already marked or absent")

// 3. audit workbook → MAIL HOUSE
const { data: wb } = await drive.files.get({ fileId: WORKBOOK, fields: "name,parents", supportsAllDrives: true })
if ((wb.parents || []).includes(MAIL_HOUSE)) log("workbook already in place |", wb.name)
else { await moveFile(drive, WORKBOOK, MAIL_HOUSE); log("moved |", wb.name, "→ 3 - MAIL HOUSE") }

for (const k of await listChildren(drive, MAIL_HOUSE)) log("  ·", k.name)
