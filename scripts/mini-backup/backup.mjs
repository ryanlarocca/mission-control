// Nightly Mac mini backup → Google Drive "Business Operations/System/Mac Mini Backup".
// Plain mirror (Ryan's call, 2026-10-23: no encryption). Uploads only files whose
// sha256 changed since the last run; updates in place so Drive keeps versions.
// Usage: node scripts/mini-backup/backup.mjs [--dry-run] [--status] [--restore-drill [dir]]
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { execSync } from "node:child_process"
import { Readable } from "node:stream"
import { DatabaseSync } from "node:sqlite"
import { HOME, MC_ROOT, PROJECTS_ROOT, STATE_DIR, BACKUP_FOLDER_NAME, BUSINESS_OPS_ID, driveClient, driveChildren, resolveFolder, sendTelegram } from "./lib.mjs"
import { buildInventory } from "./inventory.mjs"

const args = new Set(process.argv.slice(2))
const DRY = args.has("--dry-run")
const MANIFEST = path.join(STATE_DIR, "manifest.json")
const TMP = path.join(STATE_DIR, "tmp")
const MAX_FILE = 2 * 1024 * 1024 * 1024
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const sh = (cmd) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 }).trim()

// ---- what gets backed up: [drive relative dir, local file or dir, options]
function sources() {
  const S = []
  const add = (rel, abs, o = {}) => { if (fs.existsSync(abs)) S.push({ rel, abs, ...o }) }
  const crm = path.join(PROJECTS_ROOT, "PROJECTS/comprehensive-relationship-management")
  // secrets
  add("secrets/mission-control/.env.local", path.join(MC_ROOT, ".env.local"))
  for (const f of fs.readdirSync(MC_ROOT).filter((f) => f.startsWith(".env.local.bak"))) add(`secrets/mission-control/${f}`, path.join(MC_ROOT, f))
  add("secrets/mission-control/.claude.settings.local.json", path.join(MC_ROOT, ".claude/settings.local.json"))
  add("secrets/esign/.env.local", path.join(MC_ROOT, "esign/.env.local"))
  // launchd + tunnels + tool configs + scripts in ~/bin
  add("launchd", path.join(HOME, "Library/LaunchAgents"), { dir: true, filter: (f) => /lrghomes|openclaw|physiq|claude/i.test(f) })
  add("cloudflared", path.join(HOME, ".cloudflared"), { dir: true })
  add("gog/config.json", path.join(HOME, "Library/Application Support/gogcli/config.json"))
  add("ssh", path.join(HOME, ".ssh"), { dir: true, filter: (f) => !f.endsWith(".sock") })
  add("bin", path.join(HOME, "bin"), { dir: true })
  // sidecar (gitignored in ~/Projects) + CRM one-copy data
  add("sidecar", path.join(crm, "phase2"), { dir: true, skip: /node_modules|\.log$/ })
  add("data/iphone_sms.db", path.join(crm, "data/iphone_sms.db"))
  add("data/unified_messages.db", path.join(crm, "data/unified_messages.db"))
  // e-sign: the DB runs in WAL mode (recent rows sit in esign.sqlite-wal), so a
  // raw copy of esign.sqlite is incomplete — back up a VACUUM INTO snapshot.
  // envelopes/ = every request's original/interim/final PDFs + page images.
  const esignData = path.join(PROJECTS_ROOT, "PROJECTS/esign/data")
  const esignSnap = esignSnapshot(path.join(esignData, "esign.sqlite"))
  if (esignSnap) add("esign/esign.sqlite", esignSnap)
  add("esign/envelopes", path.join(esignData, "envelopes"), { dir: true })
  // Claude Code agent: memory, skills, settings
  const projDir = path.join(HOME, ".claude/projects")
  if (fs.existsSync(projDir)) for (const d of fs.readdirSync(projDir)) add(`claude/memory/${d}`, path.join(projDir, d, "memory"), { dir: true })
  add("claude/skills", path.join(HOME, ".claude/skills"), { dir: true, skip: /node_modules|\/skills\/synced\// })  // synced/ re-downloads from Anthropic
  add("claude/settings.json", path.join(HOME, ".claude/settings.json"))
  add("claude/settings.local.json", path.join(HOME, ".claude/settings.local.json"))
  add("claude/CLAUDE.md", path.join(HOME, ".claude/CLAUDE.md"))
  add("claude/keybindings.json", path.join(HOME, ".claude/keybindings.json"))
  // gitignored runtime state in mission-control
  for (const f of fs.readdirSync(path.join(MC_ROOT, "scripts")).filter((f) => /^\..*\.json$/.test(f))) add(`state/mission-control/scripts/${f}`, path.join(MC_ROOT, "scripts", f))
  return S
}

/** Consistent single-file copy of a WAL-mode SQLite DB (into STATE_DIR/tmp); null if absent. */
function esignSnapshot(dbPath) {
  if (!fs.existsSync(dbPath)) return null
  fs.mkdirSync(TMP, { recursive: true })
  const out = path.join(TMP, "esign.sqlite")
  if (fs.existsSync(out)) fs.unlinkSync(out)
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try { db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`) } finally { db.close() }
  return out
}

function walk(abs, rel, o, out) {
  for (const name of fs.readdirSync(abs)) {
    const a = path.join(abs, name)
    if (o.skip && o.skip.test(a)) continue
    let st; try { st = fs.lstatSync(a) } catch { continue }
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) { walk(a, `${rel}/${name}`, o, out); continue }
    if (!st.isFile()) continue
    if (o.filter && !o.filter(name)) continue
    if (st.size > MAX_FILE) { log("skip (too big)", a); continue }
    out.push({ rel: `${rel}/${name}`, abs: a, size: st.size, mtime: st.mtimeMs })
  }
}

function sha256(file) {
  return new Promise((res, rej) => { const h = crypto.createHash("sha256"); fs.createReadStream(file).on("data", (d) => h.update(d)).on("end", () => res(h.digest("hex"))).on("error", rej) })
}

// Git: a bundle of ~/Projects (no remote anywhere) + uncommitted patches of both repos.
// Each artifact has a content key (refs / diff / untracked list+mtimes) so it is only
// rebuilt and re-uploaded when the underlying state changed — tar/bundle bytes are not deterministic.
function gitArtifacts(manifest) {
  fs.mkdirSync(TMP, { recursive: true })
  manifest.keys ||= {}
  const out = []
  const want = (rel, key, build) => {
    if (manifest.keys[rel] === key && manifest.files[rel]?.id) return
    const abs = build()
    const st = fs.statSync(abs)
    out.push({ rel, abs, size: st.size, mtime: st.mtimeMs, key })
  }
  const refsKey = crypto.createHash("sha1").update(sh(`git -C '${PROJECTS_ROOT}' for-each-ref --format='%(objectname) %(refname)'`)).digest("hex")
  want("repos/projects.bundle", refsKey, () => { const b = path.join(TMP, "projects.bundle"); sh(`git -C '${PROJECTS_ROOT}' bundle create '${b}' --all`); return b })
  for (const [name, dir] of [["projects", PROJECTS_ROOT], ["mission-control", MC_ROOT]]) {
    const head = sh(`git -C '${dir}' rev-parse HEAD`)
    const diff = execSync(`git -C '${dir}' diff HEAD --binary`, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
    const untracked = sh(`git -C '${dir}' ls-files --others --exclude-standard`).split("\n").filter(Boolean)
      .filter((u) => !/^(PROJECTS\/)?(_tmp_|_archive)/.test(u))  // scratch + archive trees: campaign exports already live in Drive
      .map((u) => { try { const s = fs.statSync(path.join(dir, u)); return s.isFile() && s.size < 50 * 1024 * 1024 ? { u, s } : null } catch { return null } }).filter(Boolean)
    const patchKey = crypto.createHash("sha1").update(head + diff).digest("hex")
    want(`repos/${name}.uncommitted.patch`, patchKey, () => { const p = path.join(TMP, `${name}.uncommitted.patch`); fs.writeFileSync(p, `# ${name} @ ${head} — uncommitted diff vs HEAD\n` + diff); return p })
    if (untracked.length) {
      const tarKey = crypto.createHash("sha1").update(untracked.map(({ u, s }) => `${u}:${s.size}:${Math.round(s.mtimeMs)}`).join("\n")).digest("hex")
      want(`repos/${name}.untracked.tar.gz`, tarKey, () => {
        const tar = path.join(TMP, `${name}.untracked.tar.gz`), list = path.join(TMP, `${name}.untracked.list`)
        fs.writeFileSync(list, untracked.map(({ u }) => u).join("\n") + "\n")
        sh(`tar -czf '${tar}' -C '${dir}' -T '${list}'`); return tar
      })
    }
  }
  return out
}

async function upload(drive, rootId, file, existingId) {
  const dir = path.posix.dirname(file.rel)
  const name = path.posix.basename(file.rel)
  const folderId = dir === "." ? rootId : await resolveFolder(drive, rootId, dir)
  const media = { mimeType: "application/octet-stream", body: fs.createReadStream(file.abs) }
  if (existingId) {
    try {
      const { data } = await drive.files.update({ fileId: existingId, media, fields: "id", supportsAllDrives: true })
      return data.id
    } catch (e) { if (e?.code !== 404) throw e }
  }
  // dedupe by name inside the folder (first run after a manifest loss)
  const kids = await driveChildren(drive, folderId)
  const hit = kids.find((k) => k.name === name)
  if (hit) { const { data } = await drive.files.update({ fileId: hit.id, media, fields: "id", supportsAllDrives: true }); return data.id }
  const { data } = await drive.files.create({ requestBody: { name, parents: [folderId] }, media, fields: "id", supportsAllDrives: true })
  return data.id
}

async function uploadText(drive, rootId, name, text, manifest) {
  const tmp = path.join(TMP, name); fs.mkdirSync(TMP, { recursive: true }); fs.writeFileSync(tmp, text)
  const id = DRY ? "dry" : await upload(drive, rootId, { rel: name, abs: tmp }, manifest.files[name]?.id)
  manifest.files[name] = { id, sha: crypto.createHash("sha256").update(text).digest("hex"), size: text.length, at: new Date().toISOString() }
}

async function main() {
  const t0 = Date.now()
  fs.mkdirSync(STATE_DIR, { recursive: true })
  const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, "utf8")) : { files: {}, runs: [] }
  if (args.has("--status")) { const r = manifest.runs.at(-1); console.log(r ? JSON.stringify(r, null, 2) : "never run"); return }

  // collect
  const files = []
  for (const s of sources()) { if (s.dir) walk(s.abs, s.rel, s, files); else { const st = fs.statSync(s.abs); files.push({ rel: s.rel, abs: s.abs, size: st.size, mtime: st.mtimeMs }) } }
  files.push(...gitArtifacts(manifest))
  log(`${files.length} files, ${(files.reduce((a, f) => a + f.size, 0) / 1e6).toFixed(1)} MB total`)

  const drive = DRY ? null : await driveClient()
  const rootId = DRY ? "dry" : await resolveFolder(drive, BUSINESS_OPS_ID, BACKUP_FOLDER_NAME)
  let uploaded = 0, bytes = 0, unchanged = 0, failed = []
  for (const f of files) {
    const prev = manifest.files[f.rel]
    // cheap skip: same size + mtime as last time → same file
    if (prev && prev.size === f.size && prev.mtime === f.mtime && prev.id) { unchanged++; continue }
    const sha = await sha256(f.abs)
    if (prev && prev.sha === sha && prev.id) { manifest.files[f.rel] = { ...prev, mtime: f.mtime }; unchanged++; continue }
    try {
      log(`${prev ? "update" : "new   "} ${f.rel} (${(f.size / 1e6).toFixed(1)} MB)`)
      const id = DRY ? "dry" : await upload(drive, rootId, f, prev?.id)
      manifest.files[f.rel] = { id, sha, size: f.size, mtime: f.mtime, at: new Date().toISOString() }
      if (f.key) manifest.keys[f.rel] = f.key
      uploaded++; bytes += f.size
    } catch (e) { failed.push(`${f.rel}: ${e.message}`); log("FAILED", f.rel, e.message) }
  }
  // docs at the root
  await uploadText(drive, rootId, "SYSTEMS_INVENTORY.md", buildInventory(), manifest)
  await uploadText(drive, rootId, "RESTORE_GUIDE.md", fs.readFileSync(path.join(MC_ROOT, "scripts/mini-backup/RESTORE_GUIDE.md"), "utf8"), manifest)
  const run = { at: new Date().toISOString(), files: files.length, uploaded, unchanged, bytes, failed, seconds: Math.round((Date.now() - t0) / 1000) }
  manifest.runs = [...manifest.runs.slice(-60), run]
  manifest.folderId = rootId
  await uploadText(drive, rootId, "LAST_RUN.txt", `${run.at}  files=${run.files} uploaded=${run.uploaded} (${(bytes / 1e6).toFixed(1)} MB) unchanged=${run.unchanged} failed=${failed.length} in ${run.seconds}s\n`, manifest)
  if (!DRY) { fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1)); await uploadText(drive, rootId, "manifest.json", JSON.stringify(manifest, null, 1), manifest) }
  log(`done: uploaded ${uploaded} (${(bytes / 1e6).toFixed(1)} MB), unchanged ${unchanged}, failed ${failed.length}, ${run.seconds}s`)
  if (failed.length) await sendTelegram(`🔴 <b>Mac mini backup</b>: ${failed.length} file(s) failed\n${failed.slice(0, 5).join("\n")}`)
  else if (new Date().getDate() === 1 || args.has("--notify")) await sendTelegram(`🟢 <b>Mac mini backup</b> ran: ${files.length} files mirrored, ${uploaded} updated (${(bytes / 1e6).toFixed(1)} MB), ${run.seconds}s. Folder: Business Operations / ${BACKUP_FOLDER_NAME.replace("/", " / ")}`)
}

// Pull the whole Drive folder down and check it against the manifest — proves the backup restores.
async function restoreDrill() {
  const dest = [...args].find((a) => !a.startsWith("--")) || "/tmp/mini-restore-drill"
  fs.mkdirSync(dest, { recursive: true })
  const drive = await driveClient()
  const rootId = await resolveFolder(drive, BUSINESS_OPS_ID, BACKUP_FOLDER_NAME, { create: false })
  if (!rootId) throw new Error("backup folder not found")
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"))
  let ok = 0, bad = []
  for (const [rel, m] of Object.entries(manifest.files)) {
    const out = path.join(dest, rel); fs.mkdirSync(path.dirname(out), { recursive: true })
    const res = await drive.files.get({ fileId: m.id, alt: "media", supportsAllDrives: true }, { responseType: "stream" })
    await new Promise((r, j) => res.data.pipe(fs.createWriteStream(out)).on("finish", r).on("error", j))
    const sha = await sha256(out)
    if (sha === m.sha) ok++; else bad.push(rel)
  }
  const bundleOk = sh(`git bundle verify '${path.join(dest, "repos/projects.bundle")}' 2>&1 | tail -1`)
  console.log(`restore drill → ${dest}: ${ok} files verified, ${bad.length} mismatched ${bad.length ? bad.join(", ") : ""}\nbundle: ${bundleOk}`)
  if (bad.length) process.exit(1)
}

;(args.has("--restore-drill") ? restoreDrill() : main()).catch(async (e) => {
  console.error("backup failed:", e)
  if (!DRY) await sendTelegram(`🔴 <b>Mac mini backup failed</b>: ${String(e.message || e).slice(0, 300)}`)
  process.exit(1)
})
