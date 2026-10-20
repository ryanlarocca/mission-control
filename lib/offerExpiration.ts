// Offer bot — term 4 "Expiration" (briefs/ESIGN_V2.md, 2026-10-20). Shared
// by the server (parse, card, PDF) and the Mini App page (resolve on blur).
// Dependency-free on purpose, like lib/offerMoney.ts.
//
// Ryan may say "expires Friday", "good for 5 days", a date, or nothing. The
// model turns a day name into a YYYY-MM-DD; a plain number of days is parsed
// here in code; nothing → DEFAULT_EXPIRATION_DAYS calendar days after the
// agreement date (CAR's default). The stored value is either "N days" or
// "YYYY-MM-DD" (or null = default); the PDF always gets the resolved date
// (MM/DD/YYYY) and the day count.

export const DEFAULT_EXPIRATION_DAYS = 3

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const US_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/

function isIso(s: unknown): s is string {
  return typeof s === "string" && ISO_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
}

/** Calendar-date arithmetic in UTC so no timezone can shift the day. */
export function addDays(iso: string, days: number): string {
  const m = ISO_RE.exec(iso)
  if (!m) return iso
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days))
  return d.toISOString().slice(0, 10)
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000)
}

/** "5 days" · "good for 5 days" · "5 day" · "5" · "within 5 days" → 5; anything else → null. */
export function parseExpirationDays(raw: string | number | null | undefined): number | null {
  if (typeof raw === "number") return Number.isInteger(raw) && raw > 0 && raw < 366 ? raw : null
  const s = String(raw ?? "").trim().toLowerCase()
  if (!s) return null
  const m = /^(?:good\s+for\s+|within\s+|in\s+|expires?\s+in\s+)?(\d{1,3})\s*(?:calendar\s+)?(?:days?|d)?\.?$/.exec(s)
  if (!m) return null
  const n = Number(m[1])
  return n > 0 && n < 366 ? n : null
}

/** "10/24/2026" or "2026-10-24" → "2026-10-24"; else null. */
export function parseExpirationDate(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim()
  if (isIso(s)) return s
  const m = US_RE.exec(s)
  if (!m) return null
  const iso = `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`
  return isIso(iso) ? iso : null
}

/**
 * Ryan's (or the model's) phrase → the stored value: "N days", "YYYY-MM-DD",
 * or null for the default. `problem` is set when the phrase can't be read
 * or the date is not after the agreement date — the caller asks about it
 * and the default stands meanwhile.
 */
export function normalizeExpiration(raw: unknown, agreementDate: string): { value: string | null; problem: string | null } {
  if (raw === null || raw === undefined) return { value: null, problem: null }
  const s = typeof raw === "number" ? String(raw) : String(raw).trim()
  if (!s) return { value: null, problem: null }
  const days = parseExpirationDays(s)
  if (days !== null) return { value: `${days} days`, problem: null }
  const date = parseExpirationDate(s)
  if (date !== null) {
    if (daysBetween(agreementDate, date) < 1) {
      return { value: null, problem: `offer expiration: ${s} is not after the agreement date (${agreementDate}) — what date or how many days?` }
    }
    return { value: date, problem: null }
  }
  return { value: null, problem: `offer expiration: "${s}" — give me a number of days (e.g. 5 days) or a date (e.g. 10/24/2026).` }
}

/** The resolved expiration: the date (YYYY-MM-DD) and the day count the PDF shows. */
export function resolveExpiration(fields: { agreement_date: string; expiration: string | null }): { date: string; days: number } {
  const exp = fields.expiration
  if (exp && isIso(exp)) return { date: exp, days: Math.max(1, daysBetween(fields.agreement_date, exp)) }
  const days = parseExpirationDays(exp) ?? DEFAULT_EXPIRATION_DAYS
  return { date: addDays(fields.agreement_date, days), days }
}

/** "2026-10-23" → "10/23/2026" (what the form and the card show). */
export function expirationMMDDYYYY(iso: string): string {
  const m = ISO_RE.exec(iso)
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso
}
