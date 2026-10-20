// LRG Homes e-sign — HTTP server (Hono on Node). Signer pages at /s/<token>,
// admin at /admin (password cookie), JSON API at /api (bearer secret).
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { Hono } from "hono"
import { serve } from "@hono/node-server"
import { getConnInfo } from "@hono/node-server/conninfo"
import { getCookie, setCookie, deleteCookie } from "hono/cookie"
import { env, ensureDataDirs } from "./lib/env.mjs"
import { getDb, getEnvelope, getSigners, getSigner, getEvents, listEnvelopes, addEvent } from "./lib/db.mjs"
import { geoLookup, geoLabel, clientIp, deviceLabel } from "./lib/geo.mjs"
import { notify, esc as tesc } from "./lib/notify.mjs"
import { driveClient, listRecentOffers } from "./lib/google.mjs"
import * as E from "./lib/envelope.mjs"
import * as V from "./views/pages.mjs"
import { SIGNATURE_FONTS } from "./lib/fonts.mjs"
import { TEMPLATE } from "./lib/pdf.mjs"
import { loadAssets, assetResponse } from "./lib/assets.mjs"

ensureDataDirs()
getDb()
loadAssets()
const app = new Hono()

// ------------------------------------------------------------ helpers

/** Content-hashed static file: immutable when ?v= matches, no-cache otherwise (lib/assets.mjs). */
const staticFile = (c, urlPath) => assetResponse(urlPath, c.req.query("v")) ?? c.notFound()

const geoCache = new Map()
async function ctxOf(c) {
  let addr = null
  try { addr = getConnInfo(c).remote?.address ?? null } catch { addr = null }
  const ip = clientIp(c.req.raw.headers, addr)
  const ua = c.req.header("user-agent") || null
  let geo = null
  if (ip) {
    const hit = geoCache.get(ip)
    if (hit && hit.t > Date.now() - 10 * 60e3) geo = hit.geo
    else { geo = await geoLookup(ip); geoCache.set(ip, { geo, t: Date.now() }) }
  }
  return { ip, ua, geo, geoLabel: geoLabel(geo), device: deviceLabel(ua) }
}

// Bad-token throttle: 30 misses per IP per 10 minutes.
const misses = new Map()
function tooManyMisses(ip) {
  const k = ip || "?"
  const m = misses.get(k) || { n: 0, t: Date.now() }
  if (m.t < Date.now() - 10 * 60e3) { m.n = 0; m.t = Date.now() }
  m.n++
  misses.set(k, m)
  return m.n > 30
}

const html = (c, body, status = 200) => c.html(body, status)
/** Header values must be ASCII (a title like "Purchase Agreement – 1234 Main St" crashed writeHead); the full name rides along RFC 5987-encoded. */
function contentDisposition(name, inline) {
  const ascii = String(name).replace(/[\u2010-\u2015]/g, "-").replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "").trim() || "document.pdf"
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}
const pdfResponse = (file, name, inline = false) => new Response(fs.readFileSync(file), {
  headers: { "content-type": "application/pdf", "content-disposition": contentDisposition(name, inline), "cache-control": "private, no-store" },
})

function sign(v) { return crypto.createHmac("sha256", env.cookieSecret()).update(v).digest("base64url") }
function adminOk(c) {
  const cookie = getCookie(c, "esign_admin")
  if (!cookie) return false
  const [exp, mac] = cookie.split(".")
  if (!exp || !mac || Number(exp) < Date.now()) return false
  const want = sign(exp)
  return mac.length === want.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))
}
function setAdminCookie(c) {
  const exp = String(Date.now() + 30 * 86400e3)
  setCookie(c, "esign_admin", `${exp}.${sign(exp)}`, { httpOnly: true, secure: env.baseUrl.startsWith("https"), sameSite: "Lax", path: "/", maxAge: 30 * 86400 })
}
const loginAttempts = new Map()

async function parseForm(c) {
  const body = await c.req.parseBody({ all: true })
  const arr = (k) => { const v = body[k]; return v === undefined ? [] : Array.isArray(v) ? v : [v] }
  const str = (k) => { const v = body[k]; return (Array.isArray(v) ? v[0] : v) ?? "" }
  return { body, arr, str }
}

function signersFromForm(arr) {
  const names = arr("s_name[]"), emails = arr("s_email[]"), phones = arr("s_phone[]"), roles = arr("s_role[]"), orders = arr("s_order[]"), deliveries = arr("s_delivery[]")
  return names.map((name, i) => ({ name, email: emails[i], phone: phones[i], role: roles[i], order: orders[i], delivery: deliveries[i] }))
}

/** Where this signer's "Sign here" tab sits on the page images (template signers only). */
function signSpot(envelope, signer) {
  if (!envelope.is_template || signer.placement !== "template") return null
  const t = TEMPLATE[signer.role]
  return t ? { page: TEMPLATE.page + 1, x: t.x, lineY: t.lineY, w: t.w } : null
}

// ------------------------------------------------------------ static + health

app.get("/", (c) => c.redirect("/admin"))
app.get("/healthz", (c) => c.json({ ok: true, at: new Date().toISOString() }))
app.get("/logo.png", (c) => staticFile(c, "/logo.png"))
app.get("/logo-email.png", (c) => staticFile(c, "/logo-email.png")) // logo on opaque white, for dark-mode mail clients
app.get("/style.css", (c) => staticFile(c, "/style.css"))
app.get("/sign.js", (c) => staticFile(c, "/sign.js"))
app.get("/admin.js", (c) => staticFile(c, "/admin.js"))
app.get("/fonts/:file", (c) => {
  const f = Object.values(SIGNATURE_FONTS).find((x) => x.file === c.req.param("file"))
  if (!f) return c.notFound()
  return staticFile(c, `/fonts/${f.file}`)
})
app.get("/robots.txt", (c) => c.text("User-agent: *\nDisallow: /\n"))

// ------------------------------------------------------------ signer flow

async function loadToken(c) {
  const token = c.req.param("token")
  const hit = E.lookupToken(token)
  if (!hit) {
    const ctx = await ctxOf(c)
    if (tooManyMisses(ctx.ip)) return { resp: c.text("Too many attempts", 429) }
    return { resp: html(c, V.errorPage("Link not found", "This signing link isn't valid. It may have been replaced by a newer one — check your email for the latest message."), 404) }
  }
  const { signer, envelope, expired } = hit
  if (envelope.status !== "in_progress") {
    if (signer.status === "signed" && envelope.status === "completed") return { token, signer: { ...signer, token }, envelope, done: true }
    return { resp: html(c, V.closedPage(envelope, { ...signer, token })) }
  }
  if (expired) {
    addEvent(envelope.id, "expired_link_opened", { signerId: signer.id })
    const last = getEvents(envelope.id).filter((e) => e.kind === "expired_link_opened").length
    if (last === 1) await notify(`⏰ <b>${tesc(signer.name)}</b> opened an expired link for <b>${tesc(envelope.title)}</b>. Resend from ${env.baseUrl}/admin/e/${envelope.id}`)
    return { resp: html(c, V.expiredPage(), 410) }
  }
  return { token, signer, envelope }
}

app.get("/s/:token", async (c) => {
  const r = await loadToken(c)
  if (r.resp) return r.resp
  const { token, signer, envelope } = r
  if (signer.status === "signed") return html(c, V.donePage({ envelope, signer, token }))
  const ctx = await ctxOf(c)
  await E.recordOpen(signer, envelope, ctx)
  if (!signer.consented_at) return html(c, V.consentPage({ envelope, signer, token }))
  return html(c, V.reviewPage({ envelope, signer, token, spot: signSpot(envelope, signer) }))
})

app.post("/s/:token/consent", async (c) => {
  const r = await loadToken(c)
  if (r.resp) return r.resp
  const { token, signer, envelope } = r
  const { str } = await parseForm(c)
  if (str("agree") !== "1") return html(c, V.consentPage({ envelope, signer, token, error: "Please tick the box to continue." }))
  await E.recordConsent(signer, envelope, await ctxOf(c))
  return c.redirect(`/s/${token}`)
})

app.post("/s/:token/decline", async (c) => {
  const r = await loadToken(c)
  if (r.resp) return r.resp
  const { signer, envelope } = r
  if (signer.status === "signed") return c.redirect(`/s/${r.token}`)
  await E.recordDecline(signer, envelope, "asked for a paper copy", await ctxOf(c))
  return html(c, V.declinedPage(signer))
})

app.post("/s/:token/sign", async (c) => {
  const r = await loadToken(c)
  if (r.resp) return r.resp
  const { token, signer, envelope } = r
  if (signer.status === "signed") return c.redirect(`/s/${token}`)
  const { str } = await parseForm(c)
  const spot = signSpot(envelope, signer)
  if (str("agree") !== "1") return html(c, V.reviewPage({ envelope, signer, token, spot, error: "Please tick the box to confirm you've read the document." }))
  try {
    await E.recordSign(signer, envelope, { typedName: str("typed_name"), method: str("method"), signaturePng: str("signature_png"), font: str("font") }, await ctxOf(c))
  } catch (e) {
    if (e instanceof E.UserError) return html(c, V.reviewPage({ envelope, signer, token, spot, error: e.message }), 400)
    console.error("[esign] sign failed:", e)
    await notify(`🔴 e-sign: signing failed for ${tesc(signer.name)} on <b>${tesc(envelope.title)}</b>: ${tesc(e?.message || e)}`)
    return html(c, V.reviewPage({ envelope, signer, token, spot, error: "Something went wrong on our side. Please try again in a minute, or call " + env.ownerPhone + "." }), 500)
  }
  return c.redirect(`/s/${token}`)
})

app.get("/s/:token/pages/:n", async (c) => {
  const r = await loadToken(c)
  if (r.resp) return r.resp
  const n = Number(String(c.req.param("n")).replace(/\.png$/, ""))
  if (!Number.isInteger(n) || n < 1 || n > E.viewPageCount(r.envelope)) return c.notFound()
  const file = path.join(E.envelopeDir(r.envelope.id), "pages", `page-${n}.png`)
  if (!fs.existsSync(file)) return c.notFound()
  return new Response(fs.readFileSync(file), { headers: { "content-type": "image/png", "cache-control": "private, max-age=600" } })
})

app.get("/s/:token/document.pdf", async (c) => {
  const r = await loadToken(c)
  if (r.resp) return r.resp
  const e = r.envelope
  // Completed → the final; in progress → the interim (every signature so far) when there is one, else the original as sent.
  const file = e.status === "completed" && e.final_path ? e.final_path : E.interimPath(e) || e.original_path
  return pdfResponse(file, `${e.title}${e.status === "completed" ? " - SIGNED" : ""}.pdf`, true)
})
app.get("/s/:token/final.pdf", async (c) => {
  const r = await loadToken(c)
  if (r.resp) return r.resp
  const e = r.envelope
  if (e.status !== "completed" || !e.final_path) return c.redirect(`/s/${r.token}/document.pdf`)
  return pdfResponse(e.final_path, `${e.title} - SIGNED.pdf`)
})

// ------------------------------------------------------------ public record

app.get("/verify/:id", (c) => {
  const envelope = getEnvelope(c.req.param("id"))
  if (!envelope) return html(c, V.errorPage("Not found", "No document record with that id."), 404)
  return html(c, V.verifyPage({ envelope, signers: getSigners(envelope.id) }))
})
app.get("/verify/:id/final.pdf", (c) => {
  const e = getEnvelope(c.req.param("id"))
  if (!e || e.status !== "completed" || !e.final_path) return c.notFound()
  return pdfResponse(e.final_path, `${e.title} - SIGNED.pdf`)
})

// ------------------------------------------------------------ admin

app.get("/admin/login", (c) => html(c, V.adminLogin({ next: c.req.query("next") })))
app.post("/admin/login", async (c) => {
  const ctx = await ctxOf(c)
  const k = ctx.ip || "?"
  const a = loginAttempts.get(k) || { n: 0, t: Date.now() }
  if (a.t < Date.now() - 15 * 60e3) { a.n = 0; a.t = Date.now() }
  if (a.n >= 8) return html(c, V.adminLogin({ error: "Too many tries. Wait 15 minutes." }), 429)
  const { str } = await parseForm(c)
  const pw = str("password"), want = env.adminPassword()
  const ok = pw.length === want.length && crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(want))
  if (!ok) { a.n++; loginAttempts.set(k, a); return html(c, V.adminLogin({ error: "Wrong password." }), 401) }
  loginAttempts.delete(k)
  setAdminCookie(c)
  const next = str("next")
  return c.redirect(next.startsWith("/admin") ? next : "/admin")
})
app.get("/admin/logout", (c) => { deleteCookie(c, "esign_admin", { path: "/" }); return c.redirect("/admin/login") })

app.use("/admin/*", async (c, next) => {
  if (c.req.path === "/admin/login") return next()
  if (!adminOk(c)) return c.redirect(`/admin/login?next=${encodeURIComponent(c.req.path + (c.req.url.includes("?") ? "?" + c.req.url.split("?")[1] : ""))}`)
  return next()
})
app.get("/admin", (c) => {
  if (!adminOk(c)) return c.redirect("/admin/login")
  const envelopes = listEnvelopes(200)
  const signersByEnv = Object.fromEntries(envelopes.map((e) => [e.id, getSigners(e.id)]))
  return html(c, V.adminList({ envelopes, signersByEnv, flash: c.req.query("flash") }))
})

app.get("/admin/new", async (c) => {
  const q = (k) => c.req.query(k) || ""
  const prefill = { drive: q("drive"), title: q("title"), address: q("address"), date: q("date"), message: q("message"), source: q("source") }
  if (q("name") || q("email")) prefill.signers = [{ name: q("name"), email: q("email"), phone: q("phone"), role: "seller", order: 1 }, { name: env.ownerName, email: env.senderEmail, role: "buyer", order: 2 }]
  let offers = [], offersError = null
  try { offers = await listRecentOffers(await driveClient()) } catch (e) { offersError = e?.message || String(e) }
  if (prefill.drive && !offers.some((o) => o.id === prefill.drive)) offers.unshift({ id: prefill.drive, name: prefill.title || "Selected offer PDF", folder: prefill.address || "Drive" })
  return html(c, V.adminNew({ prefill, offers, offersError }))
})

app.post("/admin/envelopes", async (c) => {
  const { body, arr, str } = await parseForm(c)
  const signers = signersFromForm(arr)
  const source = str("source")
  let pdfBytes = null, driveFileId = null
  if (source === "upload") {
    const f = body.pdf
    const file = Array.isArray(f) ? f[0] : f
    if (file && typeof file === "object" && "arrayBuffer" in file) pdfBytes = Buffer.from(await file.arrayBuffer())
  } else driveFileId = str("drive_file_id") || null
  try {
    const { id, sent } = await E.createEnvelope({
      title: str("title"), propertyAddress: str("property_address"), agreementDate: str("agreement_date") || null, message: str("message"),
      pdfBytes, driveFileId, signers, createdBy: "admin",
    })
    await notify(`📨 Sent <b>${tesc(getEnvelope(id).title)}</b> for signature → ${tesc(sent.join(", "))}\n${env.baseUrl}/admin/e/${id}`)
    return c.redirect(`/admin/e/${id}?flash=${encodeURIComponent(`Sent to ${sent.join(", ")}`)}`)
  } catch (e) {
    const msg = e instanceof E.UserError ? e.message : `Couldn't create the request: ${e?.message || e}`
    if (!(e instanceof E.UserError)) console.error("[esign] create failed:", e)
    let offers = []
    try { offers = await listRecentOffers(await driveClient()) } catch { /* shown empty */ }
    return html(c, V.adminNew({ prefill: { title: str("title"), address: str("property_address"), date: str("agreement_date"), message: str("message"), drive: driveFileId, source, signers }, offers, error: msg }), 400)
  }
})

const detail = (c, id, extra = {}) => {
  const envelope = getEnvelope(id)
  if (!envelope) return html(c, V.errorPage("Not found", "No such signing request."), 404)
  return html(c, V.adminDetail({ envelope, signers: getSigners(id), events: getEvents(id), flash: c.req.query("flash"), hasInterim: !!E.interimPath(envelope), ...extra }))
}
app.get("/admin/e/:id", (c) => detail(c, c.req.param("id")))
app.get("/admin/e/:id/:file{(original|interim|signed|final)\\.pdf}", (c) => {
  const e = getEnvelope(c.req.param("id"))
  if (!e) return c.notFound()
  const which = c.req.param("file").replace(".pdf", "")
  const file = which === "original" ? e.original_path : which === "interim" ? E.interimPath(e) : which === "final" ? e.final_path : e.final_path && path.join(E.envelopeDir(e.id), "signed.pdf")
  if (!file || !fs.existsSync(file)) return c.notFound()
  return pdfResponse(file, `${e.title}${which === "original" ? "" : which === "interim" ? " - signed so far" : " - SIGNED"}${which === "signed" ? " (no certificate)" : ""}.pdf`)
})
app.post("/admin/e/:id/resend/:sid", async (c) => {
  const id = c.req.param("id")
  try { await E.resend(id, c.req.param("sid")); return c.redirect(`/admin/e/${id}?flash=${encodeURIComponent("Invitation re-sent")}`) }
  catch (e) { return detail(c, id, { error: e.message }) }
})
app.post("/admin/e/:id/link/:sid", async (c) => {
  const id = c.req.param("id"), sid = c.req.param("sid")
  try { const l = await E.freshLink(id, sid); return detail(c, id, { freshLinks: { [sid]: l }, flash: "Fresh link made — text it to them. The emailed link no longer works." }) }
  catch (e) { return detail(c, id, { error: e.message }) }
})
app.post("/admin/e/:id/void", async (c) => {
  const id = c.req.param("id")
  try { await E.voidEnvelope(id, "cancelled by sender"); return c.redirect(`/admin/e/${id}?flash=${encodeURIComponent("Request cancelled")}`) }
  catch (e) { return detail(c, id, { error: e.message }) }
})
app.post("/admin/e/:id/retry", async (c) => {
  const id = c.req.param("id")
  try { const r = await E.completeEnvelope(id); return c.redirect(`/admin/e/${id}?flash=${encodeURIComponent(r.problems.length ? `Problems: ${r.problems.join("; ")}` : "Completed and delivered")}`) }
  catch (e) { console.error("[esign] retry failed:", e); return detail(c, id, { error: e.message }) }
})

// ------------------------------------------------------------ JSON API (offer bot / scripts)

app.post("/api/envelopes", async (c) => {
  const auth = c.req.header("authorization") || ""
  const want = `Bearer ${env.apiSecret()}`
  if (auth.length !== want.length || !crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(want))) return c.json({ error: "unauthorized" }, 401)
  let j
  try { j = await c.req.json() } catch { return c.json({ error: "bad json" }, 400) }
  try {
    const { id, sent } = await E.createEnvelope({
      title: j.title, propertyAddress: j.property_address, agreementDate: j.agreement_date, message: j.message,
      pdfBytes: j.pdf_base64 ? Buffer.from(j.pdf_base64, "base64") : null, driveFileId: j.drive_file_id || null,
      signers: j.signers, createdBy: j.created_by || "api",
    })
    await notify(`📨 Sent <b>${tesc(getEnvelope(id).title)}</b> for signature → ${tesc(sent.join(", "))}\n${env.baseUrl}/admin/e/${id}`)
    return c.json({ id, sent, admin_url: `${env.baseUrl}/admin/e/${id}` })
  } catch (e) {
    if (e instanceof E.UserError) return c.json({ error: e.message }, 400)
    console.error("[esign] api create failed:", e)
    return c.json({ error: e?.message || "failed" }, 500)
  }
})

app.onError((err, c) => {
  console.error("[esign] unhandled:", err)
  return html(c, V.errorPage("Something went wrong", "Please try again in a minute."), 500)
})

serve({ fetch: app.fetch, port: env.port, hostname: "127.0.0.1" }, (info) => {
  console.log(`[esign] listening on http://127.0.0.1:${info.port} — public ${env.baseUrl} — data ${env.dataDir}`)
})
