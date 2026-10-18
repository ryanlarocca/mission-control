// Branded transactional emails: the signing invitation and the completed copy.
import { env } from "./env.mjs"
import { fmtLongDatePT } from "./pdf.mjs"

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

function layout({ heading, bodyHtml, button, footnote }) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f4f5"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e4e4e7">
<tr><td style="padding:22px 28px;border-bottom:1px solid #e4e4e7"><img src="${env.baseUrl}/logo.png" alt="${esc(env.businessName)}" height="34" style="height:34px;display:block"></td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 14px;font-size:21px;line-height:1.3">${esc(heading)}</h1>
<div style="font-size:16px;line-height:1.55">${bodyHtml}</div>
${button ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:26px 0 8px"><tr><td style="background:#1d4ed8;border-radius:10px"><a href="${button.href}" style="display:inline-block;padding:16px 28px;color:#ffffff;font-size:18px;font-weight:600;text-decoration:none">${esc(button.label)}</a></td></tr></table>` : ""}
${footnote ? `<p style="margin:18px 0 0;font-size:13px;line-height:1.5;color:#52525b">${footnote}</p>` : ""}
</td></tr>
<tr><td style="padding:16px 28px;background:#fafafa;border-top:1px solid #e4e4e7;font-size:12px;line-height:1.5;color:#71717a">${esc(env.businessName)} · ${esc(env.ownerName)} · ${esc(env.ownerPhone)} · ${esc(env.senderEmail)}<br>Sent securely by ${esc(env.businessName)} e-sign (${env.baseUrl.replace(/^https?:\/\//, "")}).</td></tr>
</table></td></tr></table></body></html>`
}

export function inviteEmail({ envelope, signer, link, expiresAt }) {
  const subject = `Please review and sign: ${envelope.title}`
  const expires = fmtLongDatePT(expiresAt)
  const first = signer.name.split(/\s+/)[0]
  const msg = envelope.message ? `<p style="margin:0 0 14px;padding:12px 14px;background:#f4f4f5;border-radius:8px;white-space:pre-wrap">${esc(envelope.message)}</p>` : ""
  const bodyHtml =
    `<p style="margin:0 0 14px">Hi ${esc(first)},</p>` +
    `<p style="margin:0 0 14px">${esc(env.ownerName)} at ${esc(env.businessName)} has sent you <strong>${esc(envelope.title)}</strong> to review and sign.</p>` +
    msg +
    `<p style="margin:0 0 6px">Tap the button to read the document and sign it on your phone or computer. It takes about two minutes.</p>`
  const footnote = `This link is private to you and works until ${esc(expires)}. If the button doesn't work, copy this address into your browser:<br><a href="${link}" style="color:#1d4ed8;word-break:break-all">${link}</a><br><br>Questions, or prefer a paper copy? Call or text ${esc(env.ownerName)} at ${esc(env.ownerPhone)}.`
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
    `<p style="margin:0 0 14px">${first ? `Hi ${esc(first)},` : "Hello,"}</p>` +
    `<p style="margin:0 0 14px"><strong>${esc(envelope.title)}</strong> has been signed by everyone: ${who}.</p>` +
    `<p style="margin:0 0 14px">The completed document is attached as a PDF, with a Certificate of Completion on the last page showing who signed, when, and from where. Please keep it for your records.</p>` +
    `<p style="margin:0">You can also download it any time at <a href="${env.baseUrl}/verify/${envelope.id}" style="color:#1d4ed8">${env.baseUrl.replace(/^https?:\/\//, "")}/verify/${envelope.id}</a>.</p>`
  const footnote = `Document fingerprint (SHA-256) of the attached file:<br><span style="font-family:Menlo,Consolas,monospace;font-size:11px;word-break:break-all">${finalSha256}</span>`
  const html = layout({ heading: "Your signed copy", bodyHtml, footnote })
  const text =
    `${first ? `Hi ${first},` : "Hello,"}\n\n"${envelope.title}" has been signed by everyone: ${signers.map((s) => `${s.name} (${s.role})`).join(", ")}.\n\n` +
    `The completed PDF is attached, with a Certificate of Completion on the last page. Please keep it for your records.\n\n` +
    `Download any time: ${env.baseUrl}/verify/${envelope.id}\nSHA-256: ${finalSha256}\n\n${env.businessName} · ${env.senderEmail}`
  return { subject, html, text }
}
