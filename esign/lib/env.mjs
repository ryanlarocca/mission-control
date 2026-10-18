// Environment for the e-sign service.
//
// Secrets come from two files, later wins:
//   1. mission-control/.env.local  — GOOGLE_SERVICE_ACCOUNT_KEY (Gmail + Drive
//      domain-wide delegation), CAMPAIGN_BOT_TOKEN / TELEGRAM_CHAT_ID (Marketing
//      bot → Ryan).
//   2. esign/.env.local            — ESIGN_* settings (admin password, API
//      secret, public base URL, port, data dir).
// Values may be single- or double-quoted (the mission-control file is).
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const APP_ROOT = path.resolve(HERE, "..")
const MC_ROOT = path.resolve(APP_ROOT, "..")

function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {}
  const out = {}
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const i = line.indexOf("=")
    if (i < 1) continue
    const key = line.slice(0, i).trim()
    let val = line.slice(i + 1).trim()
    if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) val = val.slice(1, -1)
    out[key] = val
  }
  return out
}

// A git worktree copy of the repo has no .env.local; fall back to the main checkout's.
const MC_MAIN = "/Users/ryanlarocca/Projects/PROJECTS/mission-control"
const mcEnvFile = [path.join(MC_ROOT, ".env.local"), path.join(MC_MAIN, ".env.local")].find((f) => fs.existsSync(f))
const fileEnv = {
  ...(mcEnvFile ? parseEnvFile(mcEnvFile) : {}),
  ...parseEnvFile(path.join(APP_ROOT, ".env.local")),
}
for (const [k, v] of Object.entries(fileEnv)) if (process.env[k] === undefined) process.env[k] = v

function req(name) {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set (esign/.env.local or mission-control/.env.local)`)
  return v
}

export const env = {
  port: Number(process.env.ESIGN_PORT || 5877),
  baseUrl: (process.env.ESIGN_BASE_URL || "https://sign.lrghomes.com").replace(/\/$/, ""),
  dataDir: process.env.ESIGN_DATA_DIR || "/Users/ryanlarocca/Projects/PROJECTS/esign/data",
  adminPassword: () => req("ESIGN_ADMIN_PASSWORD"),
  apiSecret: () => req("ESIGN_API_SECRET"),
  cookieSecret: () => process.env.ESIGN_COOKIE_SECRET || req("ESIGN_ADMIN_PASSWORD"),
  googleKey: () => JSON.parse(req("GOOGLE_SERVICE_ACCOUNT_KEY")),
  telegramToken: () => process.env.CAMPAIGN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: () => process.env.TELEGRAM_CHAT_ID || "",
  senderEmail: process.env.ESIGN_FROM_EMAIL || "ryan@lrghomes.com",
  senderName: process.env.ESIGN_FROM_NAME || "Ryan LaRocca, LRG Homes",
  ownerName: process.env.ESIGN_OWNER_NAME || "Ryan LaRocca",
  ownerPhone: process.env.ESIGN_OWNER_PHONE || "(408) 500-6293",
  businessName: process.env.ESIGN_BUSINESS_NAME || "LRG Homes",
  linkDays: Number(process.env.ESIGN_LINK_DAYS || 14),
  /** Drive: Business Operations root (same as the offer bot). */
  driveRootId: process.env.ESIGN_DRIVE_ROOT_ID || "1FOKTLfIP1cLW3HStneb2IWEvWSfOIzA5",
  driveSubject: process.env.ESIGN_DRIVE_SUBJECT || "ryan@lrghomes.com",
  tz: "America/Los_Angeles",
}

export function ensureDataDirs() {
  for (const d of ["envelopes", "backups", "tmp"]) fs.mkdirSync(path.join(env.dataDir, d), { recursive: true })
}
