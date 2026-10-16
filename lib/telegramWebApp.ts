import { createHmac, timingSafeEqual } from "node:crypto"

// Telegram Mini App `initData` validation (offer bot brief, 2026-10-15).
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//   secret = HMAC_SHA256(key = "WebAppData", msg = bot token)
//   hash   = HMAC_SHA256(key = secret, msg = data_check_string)
// data_check_string = every pair except `hash`, sorted by key, "k=v" joined
// with "\n". Dependency-free so it unit-tests with a fake token.

export interface TelegramWebAppUser {
  id: number
  first_name?: string
  last_name?: string
  username?: string
}

export type InitDataResult =
  | { ok: true; user: TelegramWebAppUser; authDate: number; params: Record<string, string> }
  | { ok: false; error: string }

export const INIT_DATA_MAX_AGE_SEC = 24 * 60 * 60

function dataCheckString(params: Record<string, string>): string {
  return Object.keys(params)
    .filter((k) => k !== "hash")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("\n")
}

function computeHash(params: Record<string, string>, botToken: string): string {
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest()
  return createHmac("sha256", secret).update(dataCheckString(params)).digest("hex")
}

/** Parse the query-string form Telegram hands the page (`window.Telegram.WebApp.initData`). */
export function parseInitData(initData: string): Record<string, string> {
  const out: Record<string, string> = {}
  new URLSearchParams(initData).forEach((v, k) => { out[k] = v })
  return out
}

export function validateTelegramInitData(
  initData: string,
  botToken: string,
  opts: { nowSec?: number; maxAgeSec?: number } = {}
): InitDataResult {
  if (!botToken) return { ok: false, error: "bot token not configured" }
  if (!initData || typeof initData !== "string") return { ok: false, error: "missing initData" }
  const params = parseInitData(initData)
  const given = params.hash
  if (!given || !/^[0-9a-f]{64}$/i.test(given)) return { ok: false, error: "missing hash" }
  const expected = computeHash(params, botToken)
  const a = Buffer.from(given.toLowerCase(), "hex")
  const b = Buffer.from(expected, "hex")
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: "bad signature" }
  const authDate = Number(params.auth_date)
  if (!Number.isFinite(authDate) || authDate <= 0) return { ok: false, error: "missing auth_date" }
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000)
  const maxAge = opts.maxAgeSec ?? INIT_DATA_MAX_AGE_SEC
  if (now - authDate > maxAge) return { ok: false, error: "initData expired" }
  let user: TelegramWebAppUser
  try {
    user = JSON.parse(params.user ?? "") as TelegramWebAppUser
  } catch {
    return { ok: false, error: "missing user" }
  }
  if (!user || typeof user.id !== "number") return { ok: false, error: "missing user" }
  return { ok: true, user, authDate, params }
}

/** Build a signed initData string — for tests and the dry-run script only. */
export function signTelegramInitData(params: Record<string, string>, botToken: string): string {
  const withoutHash: Record<string, string> = {}
  for (const [k, v] of Object.entries(params)) if (k !== "hash") withoutHash[k] = v
  const hash = computeHash(withoutHash, botToken)
  const qs = new URLSearchParams({ ...withoutHash, hash })
  return qs.toString()
}
