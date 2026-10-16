// Offer bot — the money / phone helpers shared by the server (parse, card,
// PDF) and the Mini App page (format on blur). Dependency-free on purpose:
// lib/offerContract.ts pulls in pdf-lib + the Anthropic SDK, which must not
// reach the browser bundle.

// ------------------------------------------------------------ money

/**
 * Dollar shorthand → number (dollars). Handled in CODE, never by the model:
 *   1.52M · 1.52mm · $1.52 million · 1.2 mil · 1520k · 10 thousand ·
 *   1,520,000 · 1520000 · $10,000 · 1,520,000.00
 * Returns null for anything else — percentages ("2.5%"), words, and bare
 * numbers under 1,000 with no suffix ("1.2" could be 1.2M or $1.20: ask).
 */
export function parseMoney(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? round2(raw) : null
  let s = String(raw).trim().toLowerCase()
  if (!s) return null
  if (s.includes("%")) return null
  s = s.replace(/^(usd|us\$|\$)\s*/, "").replace(/\s*(usd|dollars?)$/, "").trim()
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(mm|m|mil|million|k|thousand)?$/.exec(s)
  if (!m) return null
  const whole = m[1].replace(/,/g, "")
  const frac = m[2] ?? ""
  const suffix = m[3]
  const base = Number(`${whole}${frac ? `.${frac}` : ""}`)
  if (!Number.isFinite(base) || base <= 0) return null
  let value: number
  if (!suffix) {
    if (base < 1000) return null
    value = base
  } else if (suffix === "k" || suffix === "thousand") {
    value = base * 1_000
  } else {
    value = base * 1_000_000
  }
  return round2(value)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** 1520000 → "1,520,000.00" (no `$` — the form prints its own). */
export function formatMoney(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** "408-555-1234" / "+1 (408) 555 1234" → "(408) 555-1234". Anything that
 *  isn't a 10-digit US number comes back trimmed as typed; null stays null. */
export function formatPhone(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  const trimmed = String(raw).trim()
  if (!trimmed) return null
  let digits = trimmed.replace(/\D/g, "")
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1)
  if (digits.length !== 10) return trimmed
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
}

