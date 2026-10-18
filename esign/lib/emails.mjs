// Branded transactional emails: the signing invitation and the completed copy.
import { env } from "./env.mjs"
import { fmtLongDatePT } from "./pdf.mjs"
import { asset } from "./assets.mjs"

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

// Dark-mode safe: Gmail/Apple Mail recolour backgrounds they consider "light",
// so every cell carries an explicit bgcolor + background and every run of text
// an explicit color. The logo is black marks on transparent — it goes on its
// own opaque white tile (logo-email.png is also flattened onto white) so it
// never disappears into a recoloured header.
const INK = "#18181b", MUTED = "#52525b", FAINT = "#71717a", LINE = "#e4e4e7", BLUE = "#1d4ed8"
function layout({ heading, bodyHtml, button, footnote }) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"></head>
<body bgcolor="#f4f4f5" style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${INK}">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#f4f4f5" style="background:#f4f4f5"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#ffffff" style="max-width:560px;background:#ffffff;border-radius:12px;border:1px solid ${LINE}">
<tr><td bgcolor="#ffffff" style="background:#ffffff;padding:18px 28px;border-bottom:1px solid ${LINE}">
  <table role="presentation" cellspacing="0" cellpadding="0"><tr><td bgcolor="#ffffff" style="background:#ffffff;padding:10px 14px;border-radius:8px;border:1px solid ${LINE}"><img src="${env.baseUrl}${asset("/logo-email.png")}" alt="${esc(env.businessName)}" height="44" style="height:44px;display:block;border:0"></td></tr></table>
</td></tr>
<tr><td bgcolor="#ffffff" style="background:#ffffff;padding:28px;color:${INK}">
<h1 style="margin:0 0 14px;font-size:21px;line-height:1.3;color:${INK}">${esc(heading)}</h1>
<div style="font-size:16px;line-height:1.55;color:${INK}">${bodyHtml}</div>
${button ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:26px 0 8px"><tr><td bgcolor="${BLUE}" style="background:${BLUE};border-radius:10px"><a href="${button.href}" style="display:inline-block;padding:16px 28px;color:#ffffff;font-size:18px;font-weight:600;text-decoration:none"><font color="#ffffff">${esc(button.label)}</font></a></td></tr></table>` : ""}
${footnote ? `<p style="margin:18px 0 0;font-size:13px;line-height:1.5;color:${MUTED}">${footnote}</p>` : ""}
</td></tr>
<tr><td bgcolor="#fafafa" style="background:#fafafa;padding:16px 28px;border-top:1px solid ${LINE};font-size:12px;line-height:1.5;color:${FAINT}">${esc(env.businessName)} · ${esc(env.ownerName)} · ${esc(env.ownerPhone)} · ${esc(env.senderEmail)}<br>Sent securely by ${esc(env.businessName)} e-sign (${env.baseUrl.replace(/^https?:\/\//, "")}).</td></tr>
</table></td></tr></table></body></html>`
}

export function inviteEmail({ envelope, signer, link, expiresAt }) {
  const subject = `Please review and sign: ${envelope.title}`
  const expires = fmtLongDatePT(expiresAt)
  const first = signer.name.split(/\s+/)[0]
  const msg = envelope.message ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 14px"><tr><td bgcolor="#f4f4f5" style="background:#f4f4f5;color:${INK};padding:12px 14px;border-radius:8px;white-space:pre-wrap">${esc(envelope.message)}</td></tr></table>` : ""
  const bodyHtml =
    `<p style="margin:0 0 14px;color:${INK}">Hi ${esc(first)},</p>` +
    `<p style="margin:0 0 14px;color:${INK}">${esc(env.ownerName)} at ${esc(env.businessName)} has sent you <strong>${esc(envelope.title)}</strong> to review and sign.</p>` +
    msg +
    `<p style="margin:0 0 6px;color:${INK}">Tap the button to read the document and sign it on your phone or computer. It takes about two minutes.</p>`
  const footnote = `This link is private to you and works until ${esc(expires)}. If the button doesn't work, copy this address into your browser:<br><a href="${link}" style="color:${BLUE};word-break:break-all">${link}</a><br><br>Questions, or prefer a paper copy? Call or text ${esc(env.ownerName)} at ${esc(env.ownerPhone)}.`
  const html = layout({ heading: "A document for you to sign", bodyHtml, button: { href: link, label: "Review & sign" }, footnote })
  const text =
    `Hi ${first},\n\n${env.ownerName} at ${env.businessName} has sent you "${envelope.title}" to review and sign.\n\n` +
    (envelope.message ? `${envelope.message}\n\n` : "") +
    `Open this private link to read and sign it (works until ${expires}):\n${link}\n\n` +
    `Questions, or prefer a paper copy? Call or text ${env.ownerName} at ${env.ownerPhone}.\n\n${env.businessName} · ${env.senderEmail}`
  return { subject, html, text }
}

export function completedEmail({ envelope, signers, recipientName, finalSha256 }) {
  const subject = `Completed: ${envelope.title}`
  const first = (recipientName || "").split(/\s+/)[0]
  const who = signers.map((s) => `${esc(s.name)} (${s.role === "buyer" ? "Buyer" : "Seller"})`).join(", ")
  const bodyHtml =
    `<p style="margin:0 0 14px;color:${INK}">${first ? `Hi ${esc(first)},` : "Hello,"}</p>` +
    `<p style="margin:0 0 14px;color:${INK}"><strong>${esc(envelope.title)}</strong> has been signed by everyone: ${who}.</p>` +
    `<p style="margin:0 0 14px;color:${INK}">The completed document is attached as a PDF, with a Certificate of Completion on the last page showing who signed, when, and from where. Please keep it for your records.</p>` +
    `<p style="margin:0;color:${INK}">You can also download it any time at <a href="${env.baseUrl}/verify/${envelope.id}" style="color:${BLUE}">${env.baseUrl.replace(/^https?:\/\//, "")}/verify/${envelope.id}</a>.</p>`
  const footnote = `Document fingerprint (SHA-256) of the attached file:<br><span style="font-family:Menlo,Consolas,monospace;font-size:11px;word-break:break-all;color:${MUTED}">${finalSha256}</span>`
  const html = layout({ heading: "Your signed copy", bodyHtml, footnote })
  const text =
    `${first ? `Hi ${first},` : "Hello,"}\n\n"${envelope.title}" has been signed by everyone: ${signers.map((s) => `${s.name} (${s.role})`).join(", ")}.\n\n` +
    `The completed PDF is attached, with a Certificate of Completion on the last page. Please keep it for your records.\n\n` +
    `Download any time: ${env.baseUrl}/verify/${envelope.id}\nSHA-256: ${finalSha256}\n\n${env.businessName} · ${env.senderEmail}`
  return { subject, html, text }
}

/** The invitation as a text message (iMessage/SMS from Ryan's cell). */
export function inviteText({ envelope, signer, link, expiresAt }) {
  const first = signer.name.split(/\s+/)[0]
  return `Hi ${first}, it's ${env.ownerName} with ${env.businessName}. Here's the ${envelope.title} to review and sign on your phone:\n${link}\nThe link is just for you and works until ${fmtLongDatePT(expiresAt)}. Call or text me with any questions.`
}

export function completedText({ envelope, signer }) {
  const first = signer.name.split(/\s+/)[0]
  return `Hi ${first}, ${envelope.title} is now signed by everyone. Your copy (with the signing certificate) is here:\n${env.baseUrl}/verify/${envelope.id}\nThank you! — ${env.ownerName}, ${env.businessName}`
}
