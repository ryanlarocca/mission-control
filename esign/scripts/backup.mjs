// RETIRED 2026-10-24 as a nightly job — the Mac mini backup (scripts/mini-backup/)
// now snapshots esign.sqlite + data/envelopes/. Kept for a manual one-off run.
// Offsite backup → Google Drive (Business Operations/E-Sign Backups).
//   - a consistent SQLite snapshot (VACUUM INTO), one per day, kept 14 days locally
//   - every envelope file (original.pdf, signed.pdf, final.pdf, pages, a JSON
//     export of the rows + events) uploaded once, tracked in the `backups` table
// Telegram alert only on failure (silent-failure rule). Run: node scripts/backup.mjs
import fs from "node:fs"
import path from "node:path"
import { env, ensureDataDirs } from "../lib/env.mjs"
import { getDb, all, run, one, now } from "../lib/db.mjs"
import { sha256 } from "../lib/pdf.mjs"
import { driveClient, driveResolvePath, driveUpload, driveChildren, FOLDER_MIME } from "../lib/google.mjs"
import { notify, esc } from "../lib/notify.mjs"

const BACKUP_ROOT = "E-Sign Backups"
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: env.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())

async function main() {
  ensureDataDirs()
  const db = getDb()
  const drive = await driveClient()
  const rootId = await driveResolvePath(drive, env.driveRootId, BACKUP_ROOT)
  let uploaded = 0

  // 1. Database snapshot.
  const snapName = `esign-${today()}.sqlite`
  const snapPath = path.join(env.dataDir, "backups", snapName)
  if (fs.existsSync(snapPath)) fs.unlinkSync(snapPath)
  db.exec(`VACUUM INTO '${snapPath.replace(/'/g, "''")}'`)
  const dbFolder = await driveResolvePath(drive, rootId, "database")
  const existing = await driveChildren(drive, dbFolder)
  const prior = existing.find((f) => f.name === snapName)
  if (prior) await drive.files.delete({ fileId: prior.id, supportsAllDrives: true })
  await driveUpload(drive, dbFolder, snapName, fs.readFileSync(snapPath), "application/vnd.sqlite3")
  uploaded++
  // prune local snapshots older than 14 days
  for (const f of fs.readdirSync(path.join(env.dataDir, "backups"))) {
    const p = path.join(env.dataDir, "backups", f)
    if (Date.now() - fs.statSync(p).mtimeMs > 14 * 86400e3) fs.unlinkSync(p)
  }

  // 2. Envelope files, each once.
  const envDir = path.join(env.dataDir, "envelopes")
  const envelopes = all("SELECT id, title, status FROM envelopes")
  for (const e of envelopes) {
    const dir = path.join(envDir, e.id)
    if (!fs.existsSync(dir)) continue
    // JSON export of the rows + events (refreshed whenever its content changes)
    const exportPath = path.join(dir, "record.json")
    const record = {
      envelope: one("SELECT * FROM envelopes WHERE id = ?", e.id),
      signers: all("SELECT id, envelope_id, order_index, role, name, email, phone, placement, status, sent_at, send_count, opened_at, open_ip, open_ua, open_geo, consented_at, consent_version, consent_ip, consent_ua, consent_geo, signed_at, sign_ip, sign_ua, sign_geo, typed_name, signature_method, declined_at, decline_reason, sms_verified FROM signers WHERE envelope_id = ? ORDER BY order_index", e.id),
      events: all("SELECT * FROM events WHERE envelope_id = ? ORDER BY id", e.id),
      exported_at: now(),
    }
    const json = JSON.stringify(record, null, 2)
    const jsonHash = sha256(Buffer.from(json))
    const prev = one("SELECT sha256 FROM backups WHERE path = ?", exportPath)
    if (!prev || prev.sha256 !== jsonHash) fs.writeFileSync(exportPath, json)

    const files = ["original.pdf", "signed.pdf", "final.pdf", "record.json"].filter((f) => fs.existsSync(path.join(dir, f)))
    let folderId = null
    for (const f of files) {
      const p = path.join(dir, f)
      const bytes = fs.readFileSync(p)
      const h = sha256(bytes)
      const row = one("SELECT sha256, drive_file_id FROM backups WHERE path = ?", p)
      if (row && row.sha256 === h) continue
      folderId ??= await driveResolvePath(drive, rootId, `envelopes/${e.id}`)
      if (row) { try { await drive.files.delete({ fileId: row.drive_file_id, supportsAllDrives: true }) } catch { /* already gone */ } }
      const up = await driveUpload(drive, folderId, f, bytes, f.endsWith(".json") ? "application/json" : "application/pdf")
      run("INSERT INTO backups (path, sha256, drive_file_id, uploaded_at) VALUES (?,?,?,?) ON CONFLICT(path) DO UPDATE SET sha256 = excluded.sha256, drive_file_id = excluded.drive_file_id, uploaded_at = excluded.uploaded_at", p, h, up.id, now())
      uploaded++
    }
  }
  console.log(`[esign-backup] ${today()} ok — ${uploaded} file(s) uploaded, ${envelopes.length} envelope(s) on record`)
}

main().catch(async (e) => {
  console.error("[esign-backup] FAILED:", e)
  await notify(`🔴 e-sign nightly backup FAILED: ${esc(e?.message || e)}\nRun by hand: node esign/scripts/backup.mjs`)
  process.exit(1)
})
