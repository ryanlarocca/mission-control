// Shared MIME builder for every outbound email (campaign engine, drip engine,
// Telegram replies). 2026-08-21: Gmail hard-wraps text/plain bodies at ~70
// chars on delivery (no format=flowed), regardless of transfer encoding —
// every July campaign email reached agents with mid-sentence line breaks.
// The Gmail UI never has this problem because it sends an HTML alternative,
// which clients render instead. So: multipart/alternative, plain + HTML
// (paragraphs → <div>, newlines → <br>), both base64. No styling, no links
// beyond what the body already contains — it still reads as 1:1 mail.

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n")
}
function boundary(): string {
  return "000mc" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36)
}

/** Body text → HTML the way Gmail's composer would write it. Plain URLs become links. */
export function bodyToHtml(body: string): string {
  const paras = body.replace(/\r\n/g, "\n").trim().split(/\n{2,}/)
  const inner = paras
    .map((p) =>
      `<div>${esc(p)
        .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
        .replace(/\n/g, "<br>")}</div>`
    )
    .join("<div><br></div>")
  return `<div dir="ltr">${inner}</div>`
}

/** Full RFC822 message string. `extraHeaders` go after Subject (threading, List-Unsubscribe…). */
export function buildEmailMime(args: {
  from: string
  to: string
  subject: string
  body: string
  extraHeaders?: string[]
}): string {
  const bd = boundary()
  return [
    `From: ${args.from}`,
    `To: ${args.to}`,
    `Subject: ${args.subject}`,
    ...(args.extraHeaders ?? []),
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${bd}"`,
    "",
    `--${bd}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64(args.body),
    "",
    `--${bd}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64(bodyToHtml(args.body)),
    "",
    `--${bd}--`,
  ].join("\r\n")
}

/** Gmail API `raw` field: base64url of the message. */
export function toGmailRaw(mime: string): string {
  return Buffer.from(mime).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
