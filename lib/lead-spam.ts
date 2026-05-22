// Fake-lead detection for inbound leads (Google Ads, direct mail, etc.).
//
// Google Ads form/landing leads attract a steady trickle of junk: bot
// submissions, spoofed caller IDs, keyboard-mashed names, disposable
// emails. This module scores a lead's identity fields and reports the
// red flags it finds — it does NOT auto-archive anything. The intake
// routes use the score to (a) drop a "possible fake lead" warning into
// the Telegram alert Ryan already gets and (b) put a dismissable review
// banner on the lead card. Ryan confirms every junk decision himself.
//
// Deliberately NOT a signal: living in an apartment. Apartment renters
// are prime first-time-buyer / rental leads — penalizing them would
// quietly discard real pipeline. Address is scored ONLY for blatantly
// fake / placeholder values (see scoreAddress), never for unit numbers.

import { isValidPhoneNumber } from "libphonenumber-js/max"

// One red flag against a lead. `code` is the field category (so the
// score counts at most one flag per field); `label` is the human-readable
// reason shown in the Telegram alert and the card's review banner.
export interface SpamSignal {
  code: "phone" | "email" | "name" | "address"
  label: string
}

export interface SpamScore {
  // Number of distinct fields that tripped a red flag (0–4).
  score: number
  signals: SpamSignal[]
  // True once at least one red flag fired — the intake routes alert on this.
  suspicious: boolean
}

// One red flag is enough to ask Ryan to take a look — every flag here is
// individually strong, and the confirm step (Telegram → review in CRMS)
// makes a stray false positive cheap (one glance), so we err toward
// surfacing rather than staying silent.
export const SUSPICIOUS_THRESHOLD = 1

// Vowels for gibberish detection. `y` counts as a vowel on purpose — it
// keeps real-but-vowel-light names (Lynn, Bryn, Tyngsboro) from tripping
// the no-vowel rule. Conservative by design: better to miss a junk name
// than to flag a real one.
const VOWELS = new Set("aeiouy")

// Runs of adjacent keyboard keys — the fingerprint of a mashed-in value.
// 4-char windows: long enough that no real English word/name contains one
// ("asdf", "qwer", "hjkl", "zxcv" …), short enough to catch the canonical
// short mash.
const KEYBOARD_RUNS = [
  "qwer", "wert", "erty", "rtyu", "tyui", "yuio", "uiop",
  "asdf", "sdfg", "dfgh", "fghj", "ghjk", "hjkl",
  "zxcv", "xcvb", "cvbn", "vbnm",
  "1234", "2345", "3456", "4567", "5678", "6789", "7890",
]

// Disposable / throwaway email domains. No real buyer reaches out from
// one of these — a hit here is about as close to certain as junk gets.
// Matched against the domain itself and any subdomain of it. A plain
// array (not a Set) so the subdomain scan iterates under an es5 target.
const DISPOSABLE_EMAIL_DOMAINS = [
  "mailinator.com", "guerrillamail.com", "guerrillamail.info", "grr.la",
  "sharklasers.com", "10minutemail.com", "10minutemail.net", "tempmail.com",
  "temp-mail.org", "tempmailo.com", "tempmail.net", "tempr.email",
  "throwawaymail.com", "throwawaymail.net", "yopmail.com", "yopmail.fr",
  "getnada.com", "nada.email", "dispostable.com", "fakeinbox.com",
  "fakemail.net", "trashmail.com", "trash-mail.com", "mailnesia.com",
  "maildrop.cc", "mintemail.com", "mohmal.com", "mytemp.email",
  "emailondeck.com", "mailcatch.com", "spambog.com", "spam4.me",
  "mailnull.com", "getairmail.com", "inboxbear.com", "discard.email",
  "burnermail.io", "anonbox.net", "33mail.com", "spamgourmet.com",
  "jetable.org", "moakt.com", "cs.email", "harakirimail.com", "tmpmail.org",
]

// Placeholder / obviously-fake address values. A bot or a tire-kicker
// types these into a required field to get past it. NOT an apartment.
const PLACEHOLDER_ADDRESS_VALUES = new Set([
  "n/a", "na", "none", "no", "test", "testing", "asdf", "address",
  "xxx", "x", "1", "123", "12345", ".", "-", "abc", "unknown",
])

// Names that mean "we don't know who this is" — missing data, not spam.
// Skipped entirely so an unidentified caller never gets a fake-lead flag.
const PLACEHOLDER_NAMES = new Set([
  "", "(no name)", "no name", "anonymous", "unknown", "google voice",
  "caller", "lead", "n/a", "na",
])

function hasVowel(s: string): boolean {
  for (const c of s.toLowerCase()) if (VOWELS.has(c)) return true
  return false
}

// Longest run of consecutive consonants in a lowercase letters-only string.
function longestConsonantRun(letters: string): number {
  let max = 0
  let run = 0
  for (const c of letters) {
    if (c >= "a" && c <= "z" && !VOWELS.has(c)) {
      run += 1
      if (run > max) max = run
    } else {
      run = 0
    }
  }
  return max
}

function hasRepeatedChar(s: string, n: number): boolean {
  let run = 1
  for (let i = 1; i < s.length; i++) {
    run = s[i] === s[i - 1] ? run + 1 : 1
    if (run >= n) return true
  }
  return false
}

function hasKeyboardRun(s: string): boolean {
  const lower = s.toLowerCase()
  return KEYBOARD_RUNS.some((run) => lower.includes(run))
}

// Does a free-text token look like keyboard mash rather than a word?
function looksLikeGibberish(token: string): boolean {
  const letters = token.toLowerCase().replace(/[^a-z]/g, "")
  if (letters.length < 5) return false // too short to call with confidence
  if (!hasVowel(letters)) return true
  if (longestConsonantRun(letters) >= 5) return true
  if (hasKeyboardRun(letters)) return true
  if (hasRepeatedChar(letters, 4)) return true
  return false
}

// ── Per-field scorers. Each returns a SpamSignal or null. ──────────────

function scorePhone(phone: string | null | undefined): SpamSignal | null {
  const raw = (phone ?? "").trim()
  // No phone is not a red flag — email-only leads are legitimate.
  if (!raw) return null
  let valid = false
  try {
    // libphonenumber-js/max metadata enumerates real NANP number ranges,
    // so a bogus area code (789-xxx-xxxx) or 555 number fails validation.
    valid = isValidPhoneNumber(raw, "US")
  } catch {
    // A real phone string parses cleanly; a throw means it doesn't.
    valid = false
  }
  if (valid) return null
  return { code: "phone", label: "Phone number is not a valid US number" }
}

function scoreEmail(email: string | null | undefined): SpamSignal | null {
  const raw = (email ?? "").trim().toLowerCase()
  // No email is not a red flag — call/SMS leads have none.
  if (!raw) return null

  const at = raw.lastIndexOf("@")
  // Basic shape: exactly one local part + one dotted domain.
  if (at <= 0 || at === raw.length - 1 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) {
    return { code: "email", label: "Email address is malformed" }
  }
  const local = raw.slice(0, at)
  const domain = raw.slice(at + 1)

  for (const d of DISPOSABLE_EMAIL_DOMAINS) {
    if (domain === d || domain.endsWith("." + d)) {
      return { code: "email", label: "Email uses a disposable / throwaway domain" }
    }
  }

  // Gibberish local part — strip the digits/separators people legitimately
  // use (jsmith.2024, bob_brown) and judge what's left.
  const localLetters = local.replace(/[^a-z]/g, "")
  if (
    (localLetters.length >= 7 && !hasVowel(localLetters)) ||
    longestConsonantRun(localLetters) >= 6 ||
    hasKeyboardRun(local)
  ) {
    return { code: "email", label: "Email local-part looks randomly generated" }
  }
  return null
}

function scoreName(name: string | null | undefined): SpamSignal | null {
  const raw = (name ?? "").trim()
  if (PLACEHOLDER_NAMES.has(raw.toLowerCase())) return null // missing data, not spam

  // Real names don't carry digits, URLs, or marketing copy.
  if (/\d/.test(raw)) {
    return { code: "name", label: "Name contains digits" }
  }
  if (/https?:|www\.|\.com|\.net|:\/\//i.test(raw)) {
    return { code: "name", label: "Name contains a URL / promo text" }
  }
  // Unusual symbols. Matched as a known bad set (rather than "any
  // non-letter") so accented letters in real names — José, Muñoz, Søren —
  // are tolerated; marketing / bot names tend to splatter $ # * etc.
  const symbols = (raw.match(/[!@#$%^&*()_+=\[\]{}|\\/<>~"`;:?]/g) || []).length
  if (symbols >= 2) {
    return { code: "name", label: "Name contains unusual symbols" }
  }
  // Keyboard mash — checked per token. NOT across the whole name: joining
  // tokens fabricates a consonant run over the word boundary (the tail of
  // one name + the head of the next), which false-flags real names like
  // "Hans Schmidt".
  if (raw.split(/\s+/).some(looksLikeGibberish)) {
    return { code: "name", label: "Name looks like keyboard mash" }
  }
  return null
}

function scoreAddress(address: string | null | undefined): SpamSignal | null {
  const raw = (address ?? "").trim()
  if (!raw) return null // no address is not a red flag
  const norm = raw.toLowerCase().replace(/[.,]/g, "").trim()

  // Apartment / unit numbers are explicitly NOT a signal — see file header.
  if (PLACEHOLDER_ADDRESS_VALUES.has(norm)) {
    return { code: "address", label: "Address is a placeholder value" }
  }
  // A real address has a number AND a street word. Pure keyboard mash with
  // no spaces (asdfasdf) or a single repeated token is fake.
  if (looksLikeGibberish(norm) && !/\s/.test(norm)) {
    return { code: "address", label: "Address looks like keyboard mash" }
  }
  return null
}

// Score a lead's identity fields. Every field is optional — pass whatever
// the intake path actually has (call/SMS routes only know the phone).
export function scoreLeadSpam(input: {
  name?: string | null
  email?: string | null
  phone?: string | null
  address?: string | null
}): SpamScore {
  const signals: SpamSignal[] = []
  for (const signal of [
    scorePhone(input.phone),
    scoreEmail(input.email),
    scoreName(input.name),
    scoreAddress(input.address),
  ]) {
    if (signal) signals.push(signal)
  }
  return {
    score: signals.length,
    signals,
    suspicious: signals.length >= SUSPICIOUS_THRESHOLD,
  }
}

// Columns to merge into a lead insert/update when a lead looks suspicious.
// Reuses the existing suggested_status machinery: the lead card already
// renders a dismissable "AI suggestion" banner off suggested_status +
// suggested_status_reason, which is exactly the review prompt we want.
// Returns {} when the lead is clean, so it spreads harmlessly either way.
export function spamReviewColumns(
  result: SpamScore
): { suggested_status?: "dead"; suggested_status_reason?: string } {
  if (!result.suspicious) return {}
  const reasons = result.signals.map((s) => s.label).join("; ")
  return {
    suggested_status: "dead",
    suggested_status_reason: `Possible fake lead — ${reasons}. Junk if confirmed.`,
  }
}

// HTML lines for the Telegram alert. Empty when the lead is clean, so the
// caller can spread it straight into the existing alert's `lines` array.
export function spamAlertLines(result: SpamScore): string[] {
  if (!result.suspicious) return []
  const flagWord = result.score === 1 ? "red flag" : "red flags"
  return [
    `⚠️ <b>POSSIBLE FAKE LEAD</b> — ${result.score} ${flagWord}:`,
    ...result.signals.map((s) => `• ${s.label}`),
    "Review &amp; junk it in CRMS if you agree.",
  ]
}
