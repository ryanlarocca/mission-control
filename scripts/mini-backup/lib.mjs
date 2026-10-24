// Shared helpers for the Mac mini backup: env loading, Drive client, Telegram.
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { google } from "googleapis"

export const HOME = os.homedir()
export const MC_ROOT = "/Users/ryanlarocca/Projects/PROJECTS/mission-control"
export const PROJECTS_ROOT = "/Users/ryanlarocca/Projects"
export const STATE_DIR = path.join(HOME, ".mini-backup")
// Business Operations/System/Mac Mini Backup (moved under System/ 2026-10-24).
export const BACKUP_FOLDER_NAME = "System/Mac Mini Backup"
// Business Operations (owned by Ryan's personal Drive, shared Editor to ryan@).
export const BUSINESS_OPS_ID = process.env.ESIGN_DRIVE_ROOT_ID || "1FOKTLfIP1cLW3HStneb2IWEvWSfOIzA5"
export const FOLDER_MIME = "application/vnd.google-apps.folder"

/** Parse KEY=value lines; strips one layer of matching quotes (values are single-quoted in .env.local). */
export function loadEnvFile(file) {
  const out = {}
  if (!fs.existsSync(file)) return out
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const m = raw.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

export function env() {
  const e = loadEnvFile(path.join(MC_ROOT, ".env.local"))
  for (const [k, v] of Object.entries(e)) if (process.env[k] === undefined) process.env[k] = v
  return process.env
}

export async function driveClient() {
  env()
  const cred = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY)
  const auth = new google.auth.JWT({
    email: cred.client_email, key: cred.private_key,
    scopes: ["https://www.googleapis.com/auth/drive"], subject: "ryan@lrghomes.com",
  })
  await auth.authorize()
  return google.drive({ version: "v3", auth })
}

export async function driveChildren(drive, folderId, { mime } = {}) {
  const out = []
  let pageToken
  do {
    const q = [`'${folderId}' in parents`, "trashed = false", mime ? `mimeType = '${mime}'` : null].filter(Boolean).join(" and ")
    const { data } = await drive.files.list({ q, fields: "nextPageToken, files(id, name, mimeType, size, md5Checksum, modifiedTime)", pageSize: 1000, pageToken, supportsAllDrives: true, includeItemsFromAllDrives: true })
    out.push(...(data.files || []))
    pageToken = data.nextPageToken
  } while (pageToken)
  return out
}

const folderCache = new Map()
export async function resolveFolder(drive, rootId, relPath, { create = true } = {}) {
  let parent = rootId
  let key = rootId
  for (const name of String(relPath).split("/").map((s) => s.trim()).filter(Boolean)) {
    key += "/" + name
    if (folderCache.has(key)) { parent = folderCache.get(key); continue }
    const kids = await driveChildren(drive, parent, { mime: FOLDER_MIME })
    const hit = kids.find((k) => k.name.toLowerCase() === name.toLowerCase())
    if (hit) { parent = hit.id; folderCache.set(key, parent); continue }
    if (!create) return null
    const { data } = await drive.files.create({ requestBody: { name, mimeType: FOLDER_MIME, parents: [parent] }, fields: "id", supportsAllDrives: true })
    parent = data.id
    folderCache.set(key, parent)
  }
  return parent
}

export async function sendTelegram(text) {
  env()
  const token = process.env.CAMPAIGN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) { console.warn("[telegram] no token/chat id"); return }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    })
    if (!res.ok) console.error(`[telegram] ${res.status} ${await res.text()}`)
  } catch (e) { console.error("[telegram] failed:", e.message) }
}

export function sh(cmd, opts = {}) {
  const { execSync } = require_("node:child_process")
  try { return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, ...opts }).trim() }
  catch (e) { return opts.soft ? "" : (() => { throw e })() }
}
import { createRequire } from "node:module"
const require_ = createRequire(import.meta.url)
