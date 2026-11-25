// Blocked / withheld caller-ID detection. Lives in its own dependency-free
// module (NOT lib/leads.ts — that pulls in googleapis, which can't be
// bundled into client components) so both server routes and the client-side
// LeadsTab can share one matcher.
//
// Twilio sends a non-E.164 placeholder for blocked caller ID — "Anonymous",
// "Restricted", "Unavailable", "unknown", "Private", or the keypad-spelled
// +266696687 ("ANONYMOUS"). Every blocked caller collapses into the same
// value, so it's not a usable contact key: intake junks these by default +
// skips cluster inheritance, groupLeads keys them by row id (one card per
// call, never merged), and a substantive voicemail re-promotes the row.
const ANONYMOUS_CALLER_VALUES = new Set([
  "anonymous", "restricted", "unavailable", "unknown", "private", "+266696687",
])

export function isAnonymousCaller(phone: string | null | undefined): boolean {
  if (!phone) return false
  return ANONYMOUS_CALLER_VALUES.has(phone.trim().toLowerCase())
}

/**
 * The caller_phone as a contact key: null for a blocked caller ID. Use it
 * anywhere rows are grouped "by phone" (cluster history, DNC, dead/junk,
 * drips, offers, summaries) — every blocked caller shares the placeholder,
 * so matching on it treats strangers as one person (2026-11-25: a hidden-ID
 * call got another caller's "stop mailing me" history and was DNC'd).
 */
export function contactPhone(phone: string | null | undefined): string | null {
  if (!phone || isAnonymousCaller(phone)) return null
  return phone
}
