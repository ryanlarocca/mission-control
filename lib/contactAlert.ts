// Telegram alert header for an inbound call or text (Ryan, 2026-11-09).
//
// Someone already in the system reads "Repeat caller" / "Repeat text", led
// by who they are: their name and the property, or just the property when
// they never gave a name. Someone who asked off the list gets a 🚫 DNC tag
// and the date. A first-time contact keeps the old "New lead …" line.
// The phone always stays in E.164: the Telegram reply handler parses it out
// of the alert to know who a reply or draft: is for.
//
// Pure — the routes look the person up (lib/jackie callerHistory) and pass
// what they found.

export interface AlertContact {
  /** Reached us before by any path Jackie counts (lead card, Relationships, iPhone log). */
  known: boolean
  name: string | null
  address: string | null
  dnc: boolean
  dncSince: string | null
  /** Known only from Ryan's iPhone call log — no card says who they are. */
  iphoneOnly?: boolean
}

const esc = (s: string) => s.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"))

/** "Nov 8, 2026" in Pacific time. */
export function alertDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric" }).format(new Date(iso))
}

/** "Name · 4411 Concerto Dr, San Jose", either half alone, or null. */
export function contactLabel(c: Pick<AlertContact, "name" | "address">): string | null {
  const parts = [c.name?.trim(), c.address?.trim()].filter((v): v is string => !!v)
  // A name that only repeats the phone (some intake paths store the
  // formatted number as the name) adds nothing.
  const real = parts.filter((p) => !/^\+?[\d\s().-]{7,}$/.test(p))
  return real.length ? real.join(" · ") : null
}

/**
 * The header lines. `jackieLine` = a mailer line where a first-time caller
 * reaches Jackie; there a repeat caller is told where a miss goes.
 */
export function contactAlertLines(input: {
  kind: "call" | "text"
  source: string
  phone: string
  contact: AlertContact | null
  jackieLine?: boolean
  /** Appended to the first line (e.g. the §6 reset-to-New note). */
  suffix?: string
}): string[] {
  const { kind, source, phone, contact } = input
  const icon = kind === "call" ? "📞" : "💬"
  const suffix = input.suffix ?? ""
  // An opt-out on the master list means they reached us before, even with
  // no card left to show for it.
  if (!contact?.known && !contact?.dnc) {
    const label = contact ? contactLabel(contact) : null
    const who = label ? `<b>${esc(label)}</b> — ${phone}` : phone
    return [`${icon} New lead ${kind} — <b>${esc(source)}</b> — ${who}${suffix}`]
  }
  const label = contactLabel(contact)
  const head = [
    `${icon} Repeat ${kind === "call" ? "caller" : "text"}${contact.dnc ? " · 🚫 DNC" : ""}`,
    label ? `<b>${esc(label)}</b>` : null,
    esc(source),
  ].filter(Boolean).join(" — ")
  const detail = [
    phone,
    contact.dnc ? (contact.dncSince ? `asked off the list ${alertDate(contact.dncSince)}` : "asked off the list") : null,
    !label && contact.iphoneOnly ? "in your iPhone call history, no card" : null,
  ].filter(Boolean).join(" · ")
  const lines = [`${head}${suffix}`, detail]
  if (kind === "call" && input.jackieLine) lines.push("If you miss it → your voicemail, not Jackie")
  return lines
}
