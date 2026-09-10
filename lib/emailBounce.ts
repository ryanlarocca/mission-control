// Bounce (DSN) recognition + parsing for the lead mailboxes (2026-09-09).
//
// Until now /api/leads/email recognised mailer-daemon bounces only to SKIP
// them, so a failed send to a lead vanished silently — Bill Koester's
// 2359 Galloway email bounced on 5/16 ("552 mailbox not found") and Ryan
// found out from the seller on the next call. This module pulls the failed
// recipient + reason out of the DSN so the route can stamp the lead and
// alert Telegram.
//
// Dependency-free on purpose (no googleapis) so it unit-tests cheaply.

export interface ParsedBounce {
  recipient: string | null
  reason: string | null
}

// Recognize bounce notifications (mailer-daemon, postmaster DSNs, "Undelivered
// Mail Returned to Sender"). Sender-address check catches the standard
// Gmail/Workspace envelope; the subject patterns are the belt-and-suspenders
// for forwarders that rewrite the From header.
export function isBounceEmail(senderEmail: string, subject: string): boolean {
  const addr = senderEmail.toLowerCase()
  if (/^(mailer-daemon|postmaster|noreply-dsn|bounce(s|d)?)@/.test(addr)) return true
  const sub = subject.toLowerCase()
  return (
    sub.includes("delivery status notification") ||
    sub.includes("undelivered mail returned") ||
    sub.includes("undeliverable") ||
    sub.includes("mail delivery failed") ||
    sub.includes("returned mail") ||
    sub.startsWith("failure notice")
  )
}

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/

/** Pull the failed recipient + the remote server's reason out of a DSN.
 *  `failedRecipientsHeader` is Gmail's `X-Failed-Recipients` header when the
 *  caller has raw headers (Pub/Sub path); the Apps Script path only has the
 *  body text, which Gmail phrases as "Your message wasn't delivered to X
 *  because …" followed by "The response from the remote server was: …". */
export function parseBounce(args: {
  body: string
  failedRecipientsHeader?: string | null
}): ParsedBounce {
  const body = args.body || ""
  let recipient: string | null = null

  const hdr = (args.failedRecipientsHeader || "").match(EMAIL_RE)
  if (hdr) recipient = hdr[0].toLowerCase()

  if (!recipient) {
    const patterns = [
      /wasn't delivered to\s*<?([\w.+-]+@[\w-]+(?:\.[\w-]+)+)>?/i,
      /was not delivered to\s*<?([\w.+-]+@[\w-]+(?:\.[\w-]+)+)>?/i,
      /couldn't be delivered to\s*<?([\w.+-]+@[\w-]+(?:\.[\w-]+)+)>?/i,
      /could not be delivered to\s*<?([\w.+-]+@[\w-]+(?:\.[\w-]+)+)>?/i,
      /Final-Recipient:\s*rfc822;\s*<?([\w.+-]+@[\w-]+(?:\.[\w-]+)+)>?/i,
      /Original-Recipient:\s*rfc822;\s*<?([\w.+-]+@[\w-]+(?:\.[\w-]+)+)>?/i,
      /delivery to the following recipient(?:s)? failed[^\n]*\n+\s*<?([\w.+-]+@[\w-]+(?:\.[\w-]+)+)>?/i,
      /<([\w.+-]+@[\w-]+(?:\.[\w-]+)+)>:\s/i, // qmail / exim "<addr>: reason"
    ]
    for (const re of patterns) {
      const m = re.exec(body)
      if (m?.[1]) {
        recipient = m[1].toLowerCase()
        break
      }
    }
  }

  let reason: string | null = null
  // Gmail's human-readable line first ("because the address couldn't be
  // found, or is unable to receive mail."), then the SMTP status line.
  const because = /delivered to\s*<?[\w.+-]+@[\w.-]+>?\s*because\s+([^\n]+)/i.exec(body)
  const smtp = /(?:response from the remote server was:|Diagnostic-Code:\s*smtp;|said:)\s*\n?\s*([45]\d\d[^\n]{0,200})/i.exec(body)
  if (because?.[1]) reason = because[1].trim().replace(/\s+/g, " ")
  if (smtp?.[1]) reason = reason ? `${reason} (${smtp[1].trim()})` : smtp[1].trim()
  if (!reason) {
    const status = /\b([45]\.\d\.\d+)\b/.exec(body)
    if (status) reason = `status ${status[1]}`
  }

  return { recipient, reason }
}
