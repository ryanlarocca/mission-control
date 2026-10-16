// 2026-10-16: hand over the hand-filed 243496 copy to the watcher. The live replay of Juan's
// email files it with an inbox_files row and the ↩️ Undo / 💸 Paid card; the manual copy
// (uploaded earlier today by oneoff-2026-10-16-iti-243496.mjs) goes to Drive trash so the
// folder does not end up with two 243496 PDFs. 243481 "… SUPERSEDED.pdf" stays.
import { driveClient, listChildren } from "../drive.mjs"
const MAIL_HOUSE = "1xBrFye93LmOZ81s2UHsJ6vS1LUVupXrI"
const NAME = "ITI invoice 243496 - 2026-10-16 - $10,385.57.pdf"
const drive = await driveClient()
const k = (await listChildren(drive, MAIL_HOUSE)).find((x) => x.name === NAME)
if (!k) { console.log("not present:", NAME); process.exit(0) }
await drive.files.update({ fileId: k.id, requestBody: { trashed: true }, fields: "id", supportsAllDrives: true })
console.log("trashed (recoverable from Drive trash):", NAME, k.id)
