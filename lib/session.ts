// Session token helper.
//
// Previously the mc_session cookie value WAS process.env.MC_SESSION_SECRET
// verbatim — so a single leaked cookie was the permanent master key and
// the comparison was a plain string equality. This module replaces that
// with a signed, expiring token:
//
//   token = `${issuedAtMs}.${HMAC_SHA256(secret, issuedAtMs)}`
//
// The cookie is no longer the secret (leaking it doesn't leak
// MC_SESSION_SECRET), it carries an issued-at timestamp so an old leaked
// cookie expires, and verification is constant-time.
//
// Edge-runtime safe — uses ONLY the Web Crypto global (`crypto.subtle`),
// never `node:crypto`, so the same helper works in middleware (Edge) and
// in the /api/auth route handler (Node).

const encoder = new TextEncoder()

export const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30 // 30 days

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

// Constant-time string compare — avoids leaking match position via timing.
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// Mint a fresh signed session token. Called on successful login.
export async function issueSessionToken(secret: string): Promise<string> {
  const issuedAt = Date.now().toString()
  const sig = await hmacHex(secret, issuedAt)
  return `${issuedAt}.${sig}`
}

// Verify a cookie value. Returns false for anything malformed, expired,
// or wrongly signed. Old cookies whose value is the raw secret (the
// pre-fix format) fail here cleanly — they have no `.` separator — so
// every existing session is invalidated once and the user logs in again.
export async function verifySessionToken(
  token: string | undefined | null,
  secret: string | undefined | null
): Promise<boolean> {
  if (!token || !secret) return false
  const dot = token.indexOf(".")
  if (dot <= 0 || dot === token.length - 1) return false
  const issuedAt = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const issuedAtMs = Number(issuedAt)
  if (!Number.isFinite(issuedAtMs)) return false
  // Expiry — a leaked cookie stops working after the max-age window.
  if (Date.now() - issuedAtMs > SESSION_MAX_AGE_S * 1000) return false
  const expected = await hmacHex(secret, issuedAt)
  return safeEqual(sig, expected)
}
