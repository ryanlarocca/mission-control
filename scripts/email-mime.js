// CJS twin of lib/emailMime.ts for the launchd engines (keep in sync).
// Why multipart/alternative: Gmail hard-wraps text/plain at ~70 chars on
// delivery; clients render the HTML part instead. 2026-08-21.
function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") }
function b64(s) { return Buffer.from(s, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n") }
function boundary() { return "000mc" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36) }
function bodyToHtml(body) {
  const paras = body.replace(/\r\n/g, "\n").trim().split(/\n{2,}/)
  const inner = paras.map((p) => `<div>${esc(p).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, "<br>")}</div>`).join("<div><br></div>")
  return `<div dir="ltr">${inner}</div>`
}
function buildEmailMime({ from, to, subject, body, extraHeaders = [] }) {
  const bd = boundary()
  return [
    `From: ${from}`, `To: ${to}`, `Subject: ${subject}`, ...extraHeaders,
    "MIME-Version: 1.0", `Content-Type: multipart/alternative; boundary="${bd}"`, "",
    `--${bd}`, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", b64(body), "",
    `--${bd}`, 'Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", b64(bodyToHtml(body)), "",
    `--${bd}--`,
  ].join("\r\n")
}
module.exports = { bodyToHtml, buildEmailMime }
