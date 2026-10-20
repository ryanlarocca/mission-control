// Offer bot — term 4 "Expiration" (briefs/ESIGN_V2.md, 2026-10-20). Shared
// by the server (parse, card, PDF) and the Mini App page (resolve on blur).
// Dependency-free on purpose, like lib/offerMoney.ts.
//
// Ryan may say "expires Friday at noon", "good for 5 days", "by 5pm
// Wednesday", "end of day 10/24", a date, or nothing. The model turns a day
// name into a YYYY-MM-DD; a plain number of days is parsed here in code;
// nothing → DEFAULT_EXPIRATION_DAYS calendar days after the agreement date
// (CAR's default). The stored date value is either "N days" or "YYYY-MM-DD"
// (or null = default); the time is "HH:MM" 24h (or null = 5:00 p.m.). The
// PDF gets the resolved date (MM/DD/YYYY) and the time as "5:00 p.m.".

export const DEFAULT_EXPIRATION_DAYS = 3
/** Term 4 default time of day, 24h. */
export const DEFAULT_EXPIRATION_TIME = "17:00"

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

// ------------------------------------------------------------ time of day

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
const pad2 = (n: number) => String(n).padStart(2, "0")

/**
 * "noon" · "5pm" · "5 pm" · "5:00 p.m." · "end of day" / "EOD" / "midnight"
 * · "9am" · "17:00" → "HH:MM" 24h; anything else → null (the caller asks).
 * A bare clock time without am/pm is accepted only when it can only be
 * 24-hour ("17:00", "00:30", "12:00"); "5:00" alone is ambiguous.
 */
export function parseExpirationTime(raw: string | null | undefined): string | null {
  let s = String(raw ?? "").trim().toLowerCase()
  if (!s) return null
  s = s.replace(/^(?:by|at|before|until|no later than|expires?(?:\s+at)?)\s+/, "")
  s = s.replace(/\s*(?:\(?pacific(?:\s+time)?\)?|\(?p[sd]?t\)?)\.?$/, "")
  s = s.replace(/\b([ap])\.\s*m\.?/g, "$1m").replace(/\s+/g, " ").replace(/\.$/, "").trim()
  if (/^(?:12 )?noon$/.test(s)) return "12:00"
  if (/^(?:midnight|end of (?:the )?(?:day|business)|eod|cob|close of business)$/.test(s)) return "23:59"
  let m = /^(\d{1,2})(?::(\d{2}))? ?([ap])m$/.exec(s)
  if (m) {
    const h = Number(m[1])
    const min = Number(m[2] ?? "0")
    if (h < 1 || h > 12 || min > 59) return null
    const hh = m[3] === "p" ? (h === 12 ? 12 : h + 12) : h === 12 ? 0 : h
    return `${pad2(hh)}:${pad2(min)}`
  }
  m = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (m) {
    const h = Number(m[1])
    const min = Number(m[2])
    if (h > 23 || min > 59) return null
    if (h >= 13 || h === 0 || h === 12) return `${pad2(h)}:${pad2(min)}`
    return null
  }
  return null
}

/** Ryan's (or the model's) phrase → "HH:MM", or null for the default; `problem` when it can't be read. */
export function normalizeExpirationTime(raw: unknown): { value: string | null; problem: string | null } {
  if (raw === null || raw === undefined) return { value: null, problem: null }
  const s = String(raw).trim()
  if (!s) return { value: null, problem: null }
  const t = parseExpirationTime(s)
  if (t !== null) return { value: t, problem: null }
  return { value: null, problem: `offer expiration time: "${s}" — give me a time of day (e.g. 5pm, noon, end of day).` }
}

/** "17:00" → "5:00 p.m." · "12:00" → "12:00 p.m." · "23:59" → "11:59 p.m." · "09:00" → "9:00 a.m." (the PDF, the card and the form). */
export function formatExpirationTime(hhmm: string): string {
  const m = HHMM_RE.exec(hhmm)
  if (!m) return hhmm
  const h = Number(m[1])
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? "a.m." : "p.m."}`
}

// ------------------------------------------------------------ resolve

export interface ExpirationInput {
  agreement_date: string
  expiration: string | null
  /** "HH:MM" 24h or null (= DEFAULT_EXPIRATION_TIME) */
  expiration_time?: string | null
}

/** The resolved expiration: the date (YYYY-MM-DD), the day count and the time ("HH:MM") the PDF shows. */
export function resolveExpiration(fields: ExpirationInput): { date: string; days: number; time: string } {
  const exp = fields.expiration
  const time = fields.expiration_time && HHMM_RE.test(fields.expiration_time) ? fields.expiration_time : DEFAULT_EXPIRATION_TIME
  if (exp && isIso(exp)) return { date: exp, days: Math.max(1, daysBetween(fields.agreement_date, exp)), time }
  const days = parseExpirationDays(exp) ?? DEFAULT_EXPIRATION_DAYS
  return { date: addDays(fields.agreement_date, days), days, time }
}

/** "2026-10-23" → "10/23/2026" (what the form and the card show). */
export function expirationMMDDYYYY(iso: string): string {
  const m = ISO_RE.exec(iso)
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso
}

/** "10/22/2026 at 5:00 p.m." — the review card line and the form hint. */
export function expirationLabel(fields: ExpirationInput): string {
  const r = resolveExpiration(fields)
  return `${expirationMMDDYYYY(r.date)} at ${formatExpirationTime(r.time)}`
}
