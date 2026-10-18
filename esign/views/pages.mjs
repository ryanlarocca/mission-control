// Server-rendered HTML. Signer pages are built for an older seller on a
// phone: one idea per screen, big type, one big button.
import { env } from "../lib/env.mjs"
import { consentParagraphs } from "../lib/consent.mjs"
import { fmtTsPT, fmtLongDatePT, fmtDatePT } from "../lib/pdf.mjs"
import { geoLabel, deviceLabel } from "../lib/geo.mjs"

export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
const first = (name) => String(name || "").split(/\s+/)[0]

export function layout({ title, body, who = "", scripts = [] }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)} · ${esc(env.businessName)}</title>
<link rel="icon" href="/logo.png"><link rel="stylesheet" href="/style.css"></head><body>
<header class="brand"><img src="/logo.png" alt="${esc(env.businessName)}">${who ? `<div class="who">${who}</div>` : ""}</header>
<main>${body}</main>${scripts.map((s) => `<script src="${s}"></script>`).join("")}</body></html>`
}

export function errorPage(title, text) {
  return layout({ title, body: `<div class="card"><h1>${esc(title)}</h1><p>${esc(text)}</p><p class="muted">Questions? Call or text ${esc(env.ownerName)} at ${esc(env.ownerPhone)}.</p></div>` })
}

export function expiredPage() {
  return layout({ title: "Link expired", body: `<div class="card"><h1>This signing link has expired</h1><p>For your security, signing links only work for ${env.linkDays} days.</p><p>${esc(env.ownerName)} has been notified and can send you a fresh link. You can also call or text ${esc(env.ownerPhone)}.</p></div>` })
}

export function closedPage(envelope, signer) {
  const msg = envelope.status === "completed"
    ? "This document has been fully signed. Your copy was emailed to you."
    : envelope.status === "voided" ? "This signing request was cancelled by the sender." : "This signing request is closed."
  const dl = envelope.status === "completed" && signer?.token ? `<a class="btn" href="/s/${signer.token}/final.pdf">Download the signed PDF</a>` : ""
  return layout({ title: "Closed", body: `<div class="card"><h1>${esc(envelope.title)}</h1><p>${msg}</p>${dl}</div>` })
}

export function consentPage({ envelope, signer, token, error }) {
  const paras = consentParagraphs().map((p) => `<p>${esc(p)}</p>`).join("")
  return layout({
    title: "Sign electronically?",
    who: `${esc(signer.name)}<br>${esc(signer.email)}`,
    body: `
<div class="card">
  <div class="step">Step 1 of 2 · Before you start</div>
  <h1>Hi ${esc(first(signer.name))}, ${esc(env.ownerName)} sent you a document to sign</h1>
  <p><strong>${esc(envelope.title)}</strong>${envelope.property_address ? `<br><span class="muted">${esc(envelope.property_address)}</span>` : ""}</p>
</div>
<div class="card consent">
  <h2>Signing electronically</h2>
  ${paras}
  ${error ? `<div class="error">${esc(error)}</div>` : ""}
  <form method="post" action="/s/${token}/consent" id="consentform">
    <label class="check"><input type="checkbox" name="agree" value="1" required id="cagree"> I agree to receive this document and sign it electronically. I know I can ask for a paper copy and can withdraw this consent before I sign.</label>
    <button class="btn" type="submit">Continue to the document</button>
  </form>
  <form method="post" action="/s/${token}/decline" onsubmit="return confirm('Ask ${esc(env.ownerName)} for a paper copy instead?')">
    <button class="btn secondary" type="submit">I'd rather sign on paper</button>
  </form>
</div>
<script>document.getElementById('cagree').addEventListener('change',function(){this.parentNode.classList.toggle('on',this.checked)})</script>`,
  })
}

export function reviewPage({ envelope, signer, token, error }) {
  const pages = Array.from({ length: envelope.page_count }, (_, i) =>
    `<img class="page" src="/s/${token}/pages/${i + 1}.png" alt="Page ${i + 1}" loading="${i < 2 ? "eager" : "lazy"}"><div class="pageno">Page ${i + 1} of ${envelope.page_count}</div>`).join("")
  return layout({
    title: "Review and sign",
    who: `${esc(signer.name)}<br>${esc(signer.email)}`,
    scripts: ["/sign.js"],
    body: `
<div class="card">
  <div class="step">Step 2 of 2 · Review, then sign at the bottom</div>
  <h1>${esc(envelope.title)}</h1>
  ${envelope.property_address ? `<p class="muted">${esc(envelope.property_address)}</p>` : ""}
  <p>Please read all ${envelope.page_count} page${envelope.page_count === 1 ? "" : "s"} below. You sign at the very bottom. <a class="link" href="/s/${token}/document.pdf" target="_blank">Open as a PDF</a></p>
</div>
<div class="pages">${pages}</div>
<div class="card" id="sign">
  <h2>Sign as ${esc(signer.role === "buyer" ? "Buyer" : "Seller")}</h2>
  ${error ? `<div class="error">${esc(error)}</div>` : ""}
  <form method="post" action="/s/${token}/sign" id="signform" autocomplete="off">
    <label class="field"><span>Type your full legal name</span><input type="text" name="typed_name" id="typed_name" placeholder="${esc(signer.name)}" autocapitalize="words" autocomplete="name" required maxlength="80"></label>
    <p class="muted" style="margin-top:-6px">Your typed name is your signature. ${signer.placement === "template" ? "It will be placed on the agreement's signature line." : "It will be placed on the signature page with the other parties."}</p>
    <p><button class="link" id="drawtoggle" type="button">Draw my signature instead (optional)</button></p>
    <div id="padwrap" style="display:none">
      <canvas class="sigpad" id="pad"></canvas>
      <div class="sigrow"><span>Sign above with your finger</span><button class="link" id="clearpad" type="button">Clear</button></div>
    </div>
    <input type="hidden" name="method" id="method" value="typed"><input type="hidden" name="signature_png" id="signature_png" value="">
    <label class="check"><input type="checkbox" id="agree" name="agree" value="1" required> I have read this document and I agree to sign it electronically. I understand this is legally binding.</label>
    <button class="btn green" type="submit" id="signbtn" disabled>I agree and sign</button>
  </form>
  <p class="muted" style="margin-top:14px">Changed your mind? Just close this page. Nothing is signed until you tap the green button. Questions: ${esc(env.ownerName)}, ${esc(env.ownerPhone)}.</p>
</div>`,
  })
}

export function donePage({ envelope, signer, token }) {
  const completed = envelope.status === "completed"
  return layout({
    title: "Signed",
    who: `${esc(signer.name)}`,
    body: `
<div class="card">
  <div class="bigcheck">✅</div>
  <h1 style="text-align:center">Thank you, ${esc(first(signer.name))} — you're done</h1>
  <p style="text-align:center">You signed <strong>${esc(envelope.title)}</strong> on ${esc(fmtLongDatePT(signer.signed_at))}.</p>
  ${completed
    ? `<p style="text-align:center">Everyone has signed. The completed PDF has been emailed to you, and you can download it here any time.</p><a class="btn" href="/s/${token}/final.pdf">Download the signed PDF</a>`
    : `<p style="text-align:center">Once everyone has signed, the completed PDF will be emailed to you at <strong>${esc(signer.email)}</strong>.</p><a class="btn secondary" href="/s/${token}/document.pdf">Download the document as it stands</a>`}
  <p class="muted" style="text-align:center;margin-top:16px">Questions? Call or text ${esc(env.ownerName)} at ${esc(env.ownerPhone)}.</p>
</div>`,
  })
}

export function declinedPage(signer) {
  return layout({ title: "Paper copy", body: `<div class="card"><h1>No problem, ${esc(first(signer.name))}</h1><p>${esc(env.ownerName)} has been told you'd prefer to sign on paper and will be in touch${signer.phone ? ` at ${esc(signer.phone)}` : ""}.</p><p class="muted">You can also reach ${esc(env.ownerName)} at ${esc(env.ownerPhone)}.</p></div>` })
}

export function verifyPage({ envelope, signers }) {
  const done = envelope.status === "completed"
  return layout({
    title: "Document record",
    body: `<div class="card"><h1>${esc(envelope.title)}</h1>
<p><span class="pill ${envelope.status}">${esc(envelope.status.replace("_", " "))}</span>${done ? ` · completed ${esc(fmtTsPT(envelope.completed_at))}` : ""}</p>
<table class="list"><tr><th>Signer</th><th>Role</th><th>Status</th></tr>${signers.map((s) => `<tr><td>${esc(s.name)}</td><td>${s.role}</td><td><span class="pill ${s.status}">${s.status}</span>${s.signed_at ? `<div class="ev">${esc(fmtTsPT(s.signed_at))}</div>` : ""}</td></tr>`).join("")}</table>
${done ? `<p style="margin-top:16px"><a class="btn" href="/verify/${envelope.id}/final.pdf">Download the signed PDF</a></p>
<h2 style="margin-top:18px">Fingerprints (SHA-256)</h2><p class="muted">Compare these against your copy to confirm it hasn't been altered.</p>
<p><strong>Original:</strong><br><code>${envelope.original_sha256}</code></p><p><strong>Final (with certificate):</strong><br><code>${envelope.final_sha256}</code></p>` : ""}
</div>`,
  })
}

// ------------------------------------------------------------------ admin

export function adminLogin({ error, next }) {
  return layout({ title: "Sign in", body: `<div class="card"><h1>${esc(env.businessName)} e-sign</h1>${error ? `<div class="error">${esc(error)}</div>` : ""}<form method="post" action="/admin/login"><input type="hidden" name="next" value="${esc(next || "/admin")}"><label class="field"><span>Password</span><input type="password" name="password" autofocus required></label><button class="btn" type="submit">Sign in</button></form></div>` })
}

const adminNav = `<p class="row"><a class="btn small" href="/admin/new">+ New signing request</a><a class="btn small secondary" href="/admin">All requests</a></p>`

export function adminList({ envelopes, signersByEnv, flash }) {
  const rows = envelopes.map((e) => {
    const ss = signersByEnv[e.id] || []
    const prog = ss.map((s) => `<span class="pill ${s.status}" title="${esc(s.email)}">${esc(first(s.name))}: ${s.status}</span>`).join(" ")
    return `<tr><td><a href="/admin/e/${e.id}"><strong>${esc(e.title)}</strong></a><div class="ev">${esc(e.property_address || "")} · ${esc(fmtDatePT(e.created_at))}</div></td><td><span class="pill ${e.status}">${e.status.replace("_", " ")}</span></td><td>${prog}</td></tr>`
  }).join("")
  return layout({ title: "Signing requests", who: `<a href="/admin/logout">sign out</a>`, body: `${flash ? `<div class="ok">${esc(flash)}</div>` : ""}${adminNav}<div class="card"><h1>Signing requests</h1>${envelopes.length ? `<table class="list"><tr><th>Document</th><th>Status</th><th>Signers</th></tr>${rows}</table>` : "<p class='muted'>Nothing yet. Create your first request.</p>"}</div>` })
}

export function adminNew({ prefill = {}, offers = [], error, offersError }) {
  const opts = offers.map((o) => `<option value="${esc(o.id)}" data-name="${esc(o.name.replace(/\.pdf$/i, ""))}" data-folder="${esc(o.folder)}" ${prefill.drive === o.id ? "selected" : ""}>${esc(o.folder)} — ${esc(o.name)}</option>`).join("")
  const pre = JSON.stringify(prefill.signers || [])
  return layout({
    title: "New signing request", who: `<a href="/admin">all requests</a>`, scripts: ["/admin.js"],
    body: `<div class="card"><h1>New signing request</h1>${error ? `<div class="error">${esc(error)}</div>` : ""}
<form method="post" action="/admin/envelopes" enctype="multipart/form-data" id="newform">
  <div class="field"><span>Document</span>
    <label class="check" style="margin:6px 0"><input type="radio" name="source" value="drive" ${prefill.source !== "upload" ? "checked" : ""}> From Drive — recent offers</label>
    <div id="src-drive">${offersError ? `<div class="error">Couldn't list Drive: ${esc(offersError)}</div>` : `<select name="drive_file_id" id="drive_file_id"><option value="">— pick a PDF from Business Operations/Offers —</option>${opts}</select>`}</div>
    <label class="check" style="margin:6px 0"><input type="radio" name="source" value="upload" ${prefill.source === "upload" ? "checked" : ""}> Upload a PDF</label>
    <div id="src-upload"><input type="file" name="pdf" accept="application/pdf"></div>
  </div>
  <label class="field"><span>Title (what the signer sees)</span><input type="text" name="title" id="title" value="${esc(prefill.title || "")}" placeholder="Purchase Agreement – 1234 Main St"></label>
  <label class="field"><span>Property address</span><input type="text" name="property_address" id="property_address" value="${esc(prefill.address || "")}"></label>
  <label class="field"><span>Agreement date (as written on the contract)</span><input type="date" name="agreement_date" value="${esc(prefill.date || "")}"></label>
  <label class="field"><span>Note to signers (optional)</span><textarea name="message" rows="2" placeholder="Hi — here's the agreement we discussed. Call me with any questions.">${esc(prefill.message || "")}</textarea></label>
  <div class="field"><span>Signers — lower order numbers sign first; same number = at the same time</span>
    <div id="signers"></div>
    <button class="btn small secondary" id="addsigner" type="button">+ Add signer</button>
  </div>
  <button class="btn" type="submit">Send for signature</button>
</form></div>
<template id="signer-tpl"><input type="text" name="s_name[]" placeholder="Full legal name" class="full"><input type="email" name="s_email[]" placeholder="Email"><input type="tel" name="s_phone[]" placeholder="Phone (optional)"><select name="s_role[]"><option value="seller">Seller</option><option value="buyer">Buyer (me / partner)</option></select><div class="row"><select name="s_order[]"><option value="1">Signs 1st</option><option value="2">Signs 2nd</option><option value="3">Signs 3rd</option><option value="4">Signs 4th</option></select><button class="link rm" type="button">remove</button></div></template>
<script>window.PREFILL=${pre}</script>`,
  })
}

export function adminDetail({ envelope, signers, events, flash, error, freshLinks = {} }) {
  const open = envelope.status === "in_progress"
  const tier = Math.min(...signers.filter((s) => s.status !== "signed").map((s) => s.order_index), Infinity)
  const rows = signers.map((s) => {
    const canSend = open && s.status !== "signed" && s.order_index <= tier
    const link = freshLinks[s.id]
    return `<tr><td><strong>${esc(s.name)}</strong><div class="ev">${esc(s.email)}${s.phone ? ` · ${esc(s.phone)}` : ""}<br>${s.role} · order ${s.order_index} · ${s.placement === "template" ? "on the agreement" : "on the addendum"}</div></td>
<td><span class="pill ${s.status}">${s.status}</span><div class="ev">${s.sent_at ? `sent ${esc(fmtTsPT(s.sent_at))}${s.send_count > 1 ? ` (×${s.send_count})` : ""}<br>` : ""}${s.opened_at ? `opened ${esc(fmtTsPT(s.opened_at))} · ${esc(geoLabel(s.open_geo))} · ${esc(deviceLabel(s.open_ua))}<br>` : ""}${s.signed_at ? `signed ${esc(fmtTsPT(s.signed_at))} · ${esc(geoLabel(s.sign_geo))}` : ""}</div></td>
<td>${canSend ? `<form method="post" action="/admin/e/${envelope.id}/resend/${s.id}" style="display:inline"><button class="btn small secondary" type="submit">Resend email</button></form><form method="post" action="/admin/e/${envelope.id}/link/${s.id}" style="display:inline"><button class="btn small secondary" type="submit">Get link to text</button></form>` : ""}${link ? `<div class="ev">Fresh link (expires ${esc(fmtDatePT(link.expiresAt))}):<br><code>${esc(link.link)}</code> <button class="link" data-copy="${esc(link.link)}">copy</button></div>` : ""}</td></tr>`
  }).join("")
  const byId = Object.fromEntries(signers.map((s) => [s.id, s.name]))
  const ev = events.map((e) => `<div class="ev">${esc(fmtTsPT(e.at))} — <strong>${esc(e.kind.replace(/_/g, " "))}</strong> ${e.signer_id ? esc(byId[e.signer_id] || "") : ""} ${e.ip ? `· ${esc(e.ip)}` : ""}${e.geo ? ` · ${esc(geoLabel(e.geo))}` : ""}</div>`).join("")
  const files = `<p class="row"><a class="btn small secondary" href="/admin/e/${envelope.id}/original.pdf">Original PDF</a>${envelope.final_path ? `<a class="btn small" href="/admin/e/${envelope.id}/final.pdf">Signed PDF + certificate</a><a class="btn small secondary" href="/admin/e/${envelope.id}/signed.pdf">Signed PDF (no certificate)</a>` : ""}${envelope.drive_final_link ? `<a class="btn small secondary" href="${esc(envelope.drive_final_link)}" target="_blank">Open in Drive</a>` : ""}</p>`
  const actions = open
    ? `<form method="post" action="/admin/e/${envelope.id}/void" onsubmit="return confirm('Cancel this signing request? Links stop working.')"><button class="btn small danger" type="submit">Cancel request</button></form>`
    : envelope.status === "completed" && !envelope.drive_final_id ? `<form method="post" action="/admin/e/${envelope.id}/retry"><button class="btn small secondary" type="submit">Retry delivery (Drive / email)</button></form>` : ""
  const retryBuild = open && signers.every((s) => s.status === "signed") ? `<form method="post" action="/admin/e/${envelope.id}/retry"><button class="btn small" type="submit">Retry completion</button></form>` : ""
  return layout({
    title: envelope.title, who: `<a href="/admin">all requests</a>`, scripts: ["/admin.js"],
    body: `${flash ? `<div class="ok">${esc(flash)}</div>` : ""}${error ? `<div class="error">${esc(error)}</div>` : ""}${adminNav}
<div class="card"><h1>${esc(envelope.title)}</h1>
<p><span class="pill ${envelope.status}">${envelope.status.replace("_", " ")}</span> · ${esc(envelope.property_address || "")} · created ${esc(fmtTsPT(envelope.created_at))}${envelope.completed_at ? ` · completed ${esc(fmtTsPT(envelope.completed_at))}` : ""}${envelope.is_template ? " · LRG purchase agreement template" : ""}</p>
${files}<div class="row">${actions}${retryBuild}</div>
<table class="list" style="margin-top:14px"><tr><th>Signer</th><th>Status</th><th></th></tr>${rows}</table>
<h2 style="margin-top:20px">Fingerprints</h2><p class="ev">Original SHA-256: <code>${envelope.original_sha256}</code></p>${envelope.final_sha256 ? `<p class="ev">Final SHA-256: <code>${envelope.final_sha256}</code></p>` : ""}
<p class="ev">Envelope <code>${envelope.id}</code> · public record page: <a href="/verify/${envelope.id}">/verify/${envelope.id}</a></p>
<h2 style="margin-top:20px">Event log</h2>${ev}</div>`,
  })
}
