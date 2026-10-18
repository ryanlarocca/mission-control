// Server-rendered HTML. Signer pages are built for an older seller on a
// phone: one idea per screen, big type, one big button.
import { env } from "../lib/env.mjs"
import { consentParagraphs } from "../lib/consent.mjs"
import { fmtTsPT, fmtLongDatePT, fmtDatePT } from "../lib/pdf.mjs"
import { geoLabel, deviceLabel } from "../lib/geo.mjs"
import { SIGNATURE_FONTS, DEFAULT_FONT } from "../lib/fonts.mjs"
import { asset } from "../lib/assets.mjs"

export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
const first = (name) => String(name || "").split(/\s+/)[0]

// Every static URL is content-hashed (?v=…) so a deploy never leaves a phone on an old stylesheet.
export function layout({ title, body, who = "", scripts = [] }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)} · ${esc(env.businessName)}</title>
<link rel="icon" href="${asset("/logo.png")}"><link rel="stylesheet" href="${asset("/style.css")}"></head><body>
<header class="brand"><img src="${asset("/logo.png")}" alt="${esc(env.businessName)}">${who ? `<div class="who">${who}</div>` : ""}</header>
<main>${body}</main>${scripts.map((s) => `<script src="${asset(s)}"></script>`).join("")}</body></html>`
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

export function reviewPage({ envelope, signer, token, error, spot }) {
  // spot: { page (1-based), x, lineY, w } in PDF points for template signers; null → addendum.
  const pct = spot ? { left: (spot.x / 612) * 100, top: ((792 - (spot.lineY + 30)) / 792) * 100, width: (spot.w / 612) * 100, height: (34 / 792) * 100 } : null
  const tab = `<button type="button" class="signtab" id="signtab" aria-label="Sign here"><span class="flag">Sign here</span><span class="sigpreview" id="sigpreview"></span></button>`
  const pages = Array.from({ length: envelope.page_count }, (_, i) =>
    `<div class="pagewrap"><img class="page" src="/s/${token}/pages/${i + 1}.png" alt="Page ${i + 1}" loading="${i < 2 ? "eager" : "lazy"}">${pct && spot.page === i + 1 ? `<div class="spot" style="left:${pct.left}%;top:${pct.top}%;width:${pct.width}%;height:${pct.height}%">${tab}</div>` : ""}</div><div class="pageno">Page ${i + 1} of ${envelope.page_count}</div>`).join("")
  const fontFaces = Object.values(SIGNATURE_FONTS).map((f) => `@font-face{font-family:"${f.css}";src:url(${asset(`/fonts/${f.file}`)}) format("truetype");font-display:swap}`).join("")
  const fontCards = Object.entries(SIGNATURE_FONTS).map(([k, f]) => `<label class="fontcard"><input type="radio" name="fontpick" value="${k}" ${k === DEFAULT_FONT ? "checked" : ""}><span class="fontprev" style="font-family:'${f.css}';font-size:${f.webSize}px" data-font="${k}">${esc(signer.name)}</span><span class="fontlabel">${f.label}</span></label>`).join("")
  const roleLabel = signer.role === "buyer" ? "Buyer" : "Seller"
  const addendumCard = !spot ? `<div class="card" id="addcard"><h2>Your signature</h2><p class="muted">Your signature goes on the Signature Addendum attached to this agreement, with the other ${roleLabel.toLowerCase()}s.</p><div class="addline"><div class="spot inline">${tab}</div><div class="linebar"></div><div class="muted" style="font-size:14px">${roleLabel} · ${esc(signer.name)}</div></div></div>` : ""
  return layout({
    title: "Review and sign",
    who: `${esc(signer.name)}<br>${esc(signer.email || signer.phone || "")}`,
    scripts: ["/sign.js"],
    body: `<style>${fontFaces}</style>
<div class="card">
  <div class="step">Step 2 of 2 · Review, then sign</div>
  <h1>${esc(envelope.title)}</h1>
  ${envelope.property_address ? `<p class="muted">${esc(envelope.property_address)}</p>` : ""}
  <p>Read all ${envelope.page_count} page${envelope.page_count === 1 ? "" : "s"}, then tap the yellow <strong>Sign here</strong> tab${spot ? ` on page ${spot.page}` : " below"}. <a class="link" href="/s/${token}/document.pdf" target="_blank">Open as a PDF</a></p>
  ${error ? `<div class="error">${esc(error)}</div>` : ""}
</div>
<div class="pages">${pages}</div>
${addendumCard}
<div class="card" id="finishcard">
  <label class="check"><input type="checkbox" id="agree"> I have read this document and I agree to sign it electronically. I understand this is legally binding.</label>
  <button class="btn green" type="button" id="finish" disabled>Finish</button>
  <p class="muted" id="finishhint" style="margin-top:10px">Tap <strong>Sign here</strong> on the document first.</p>
  <p class="muted" style="margin-top:14px">Changed your mind? Just close this page. Nothing is signed until you tap Finish. Questions: ${esc(env.ownerName)}, ${esc(env.ownerPhone)}.</p>
</div>
<form method="post" action="/s/${token}/sign" id="signform" style="display:none">
  <input type="hidden" name="typed_name" id="f_typed_name"><input type="hidden" name="method" id="f_method" value="typed"><input type="hidden" name="font" id="f_font" value="${DEFAULT_FONT}"><input type="hidden" name="signature_png" id="f_png"><input type="hidden" name="agree" id="f_agree" value="">
</form>
<div class="sheet" id="sheet" hidden>
  <div class="sheetin">
    <h2>Your signature</h2>
    <label class="field"><span>Type your full legal name</span><input type="text" id="typed_name" placeholder="${esc(signer.name)}" autocapitalize="words" autocomplete="name" maxlength="80"></label>
    <div class="tabs"><button type="button" class="tabbtn on" data-tab="type">Choose a style</button><button type="button" class="tabbtn" data-tab="draw">Draw with your finger</button></div>
    <div id="tab-type" class="fontgrid">${fontCards}</div>
    <div id="tab-draw" hidden><canvas class="sigpad" id="pad"></canvas><div class="sigrow"><span>Sign above with your finger</span><button class="link" id="clearpad" type="button">Clear</button></div></div>
    <div class="error" id="sheeterr" hidden></div>
    <button class="btn green" type="button" id="adopt">Adopt and sign</button>
    <button class="btn secondary" type="button" id="cancelsheet">Cancel</button>
  </div>
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
  <div class="field"><span>Signers — lower order numbers sign first; same number = at the same time. Each signer needs an email or a cell number.</span>
    <div id="signers"></div>
    <button class="btn small secondary" id="addsigner" type="button">+ Add signer</button>
  </div>
  <button class="btn" type="submit">Send for signature</button>
</form></div>
<template id="signer-tpl"><input type="text" name="s_name[]" placeholder="Full legal name" class="full"><input type="email" name="s_email[]" placeholder="Email"><input type="tel" name="s_phone[]" placeholder="Cell phone"><select name="s_role[]"><option value="seller">Seller</option><option value="buyer">Buyer (me / partner)</option></select><select name="s_delivery[]"><option value="email">Send by email</option><option value="text">Send by text (my cell)</option><option value="both">Email + text</option></select><div class="row full"><select name="s_order[]"><option value="1">Signs 1st</option><option value="2">Signs 2nd</option><option value="3">Signs 3rd</option><option value="4">Signs 4th</option></select><button class="link rm" type="button">remove</button></div></template>
<script>window.PREFILL=${pre}</script>`,
  })
}

export function adminDetail({ envelope, signers, events, flash, error, freshLinks = {} }) {
  const open = envelope.status === "in_progress"
  const tier = Math.min(...signers.filter((s) => s.status !== "signed").map((s) => s.order_index), Infinity)
  const rows = signers.map((s) => {
    const canSend = open && s.status !== "signed" && s.order_index <= tier
    const link = freshLinks[s.id]
    return `<tr><td><strong>${esc(s.name)}</strong><div class="ev">${[s.email, s.phone].filter(Boolean).map(esc).join(" · ")}<br>${s.role} · order ${s.order_index} · by ${s.delivery === "both" ? "email + text" : s.delivery} · ${s.placement === "template" ? "on the agreement" : "on the addendum"}</div></td>
<td><span class="pill ${s.status}">${s.status}</span><div class="ev">${s.sent_at ? `sent ${esc(fmtTsPT(s.sent_at))}${s.send_count > 1 ? ` (×${s.send_count})` : ""}<br>` : ""}${s.opened_at ? `opened ${esc(fmtTsPT(s.opened_at))} · ${esc(geoLabel(s.open_geo))} · ${esc(deviceLabel(s.open_ua))}<br>` : ""}${s.signed_at ? `signed ${esc(fmtTsPT(s.signed_at))} · ${esc(geoLabel(s.sign_geo))}` : ""}</div></td>
<td>${canSend ? `<form method="post" action="/admin/e/${envelope.id}/resend/${s.id}" style="display:inline"><button class="btn small secondary" type="submit">Resend</button></form><form method="post" action="/admin/e/${envelope.id}/link/${s.id}" style="display:inline"><button class="btn small secondary" type="submit">Get link to text</button></form>` : ""}${link ? `<div class="ev">Fresh link (expires ${esc(fmtDatePT(link.expiresAt))}):<br><code>${esc(link.link)}</code> <button class="link" data-copy="${esc(link.link)}">copy</button></div>` : ""}</td></tr>`
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
