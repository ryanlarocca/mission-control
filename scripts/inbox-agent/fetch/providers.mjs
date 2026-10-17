// Inbox Agent — which links hide documents? (briefs/BRIEF_INBOX_LINK_FETCH_2026-10-12.md)
//
// Pure, dependency-free on purpose: the Mac mini worker (scripts/inbox-agent/
// index.mjs) and the Vercel webhook (lib/inboxAgent.ts) both import this file,
// so a link is judged the same way whether the email arrives or Ryan types
// `fetch <url>`. Nothing here touches a browser.
//
// Ryan 2026-10-12: the DocuSign link is "an ongoing friction point" — the
// Completed email often arrives without the PDF, only the EmailStart link.
// DocuSign is the only document provider in v1; Disclosures.io / Glide / Zix /
// Authentisign are later phases.
//
// Ryan 2026-10-15: listing photos arrive the same way — as a link, not an
// attachment. f8 Real Estate Media (Aryeo) is the first "media" provider
// (briefs/BRIEF_INBOX_MEDIA_DELIVERY_2026-10-15.md): the Download Center link
// is the one that matters; portal / property-website / app-store links on the
// same email are not documents.

// Ryan 2026-10-16: HomeSentry Inspections delivers home-inspection reports as
// a public share link (https://app.tapinspect.com/shares/<uuid>) with no PDF
// attached. Only the share page is a document link; the rest of tapinspect.com
// (login, marketing, agreements) is noise. The report is gated until the
// invoice is paid and the agreement signed — the worker parks the job as
// `awaiting_payment` and never pays anything.

// Ryan 2026-10-17: "The one thing I do like to keep is staging contracts, just
// off of what happened at Ridgeview." StyleMe Home Staging bills through
// FreshBooks: no attachment, only a client link on my.freshbooks.com whose
// hash route (#/link/estimate/<jwt>?… for a proposal, #/link/<jwt>?… for an
// invoice) renders the document with a Download PDF button. The link queues
// only when the email matches a `destination: "property"` vendor rule
// (vendors.mjs) — another vendor's FreshBooks notice is not a document Ryan
// keeps. XO Staging (QuickBooks) is the next seam: a second provider here and a
// second rule there.

/** @typedef {"docusign"|"f8"|"tapinspect"|"freshbooks"} Provider */
/** @typedef {"document"|"media"} ProviderKind */

const URL_RE = /https?:\/\/[^\s<>"'()\[\]]+/gi
// Trailing punctuation that plain-text mail wraps around a URL ("…link.", "(…link)").
const TRAIL_RE = /[.,;:!?'"»”’]+$/

/** Hosts under docusign.* that never carry an envelope: protection/preview
 *  proxies, support, marketing, the account-settings pages in footers. */
const DOCUSIGN_NOISE_HOST_RE = /^(protect\.docusign\.net|support\.docusign\.com|www\.docusign\.com|docusign\.com|go\.docusign\.com|trust\.docusign\.com|community\.docusign\.com|developers\.docusign\.com|account\.docusign\.com|account-d\.docusign\.com)$/i
const DOCUSIGN_SIGNING_HOST_RE = /^([a-z0-9-]+\.)?docusign\.net$/i
const DOCUSIGN_APP_HOST_RE = /^app(-d|-s)?\.docusign\.com$/i
const DOCUSIGN_SIGNING_PATH_RE = /^\/signing\/(emailstart\.aspx|startinsession\.aspx)?(\?|$)/i
const UNSUBSCRIBE_RE = /unsubscribe|optout|opt-out|preferences|privacy|terms|reportabuse|report-abuse/i
// f8 (Aryeo white label): https://f8.f8re.com/listings/<uuid>/download-center?signature=…
// Only the Download Center opens photos; /portal, /sites/<slug>/branded,
// www.f8re.com/… and the app-store links are noise.
const F8_HOST_RE = /^f8\.f8re\.com$/i
const F8_DOWNLOAD_CENTER_RE = /^\/listings\/[0-9a-f-]{20,}\/download-center\/?$/i
const F8_SITE_RE = /^\/sites\/([^/?#]+)\/(branded|unbranded)\/?$/i
// Postmark click tracking wraps every link in the f8 email:
// https://track.pstmrk.it/3ts/<urlencoded target>/<junk>. The target keeps
// its scheme only sometimes ("f8.f8re.com/listings/…" came through bare).
const POSTMARK_HOST_RE = /^track\.pstmrk\.it$/i
// HomeSentry / Tap Inspect: https://app.tapinspect.com/shares/<uuid> — public, no login.
const TAPINSPECT_HOST_RE = /^app\.tapinspect\.com$/i
const TAPINSPECT_SHARE_RE = /^\/shares\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i
// FreshBooks client links: https://my.freshbooks.com/#/link/estimate/<jwt>?companyName=…&entityName=proposal&estimateNumber=SS01174&…
// and https://my.freshbooks.com/#/link/<jwt>?companyName=…&invoiceNumber=080223VA&…  (the query lives INSIDE the hash).
const FRESHBOOKS_HOST_RE = /^my\.freshbooks\.com$/i
const FRESHBOOKS_LINK_RE = /^#\/link\/(estimate\/)?([A-Za-z0-9._~-]{8,})(?:\?|$)/i

/**
 * "docusign" when the URL opens an envelope, null for everything else
 * (footer links, support pages, unknown providers, not a URL).
 * @param {string|null|undefined} url
 * @returns {Provider|null}
 */
export function detectProvider(url) {
  let u
  try {
    u = new URL(String(url || "").trim())
  } catch {
    return null
  }
  if (!/^https?:$/.test(u.protocol)) return null
  const host = u.hostname.toLowerCase()
  if (DOCUSIGN_NOISE_HOST_RE.test(host)) return null
  if (UNSUBSCRIBE_RE.test(u.pathname)) return null
  // Recipient links: https://na4.docusign.net/Signing/EmailStart.aspx?a=…&etti=…&r=…
  // and the in-session form https://na4.docusign.net/Signing/?ti=…
  if (DOCUSIGN_SIGNING_HOST_RE.test(host) && DOCUSIGN_SIGNING_PATH_RE.test(u.pathname + u.search)) return "docusign"
  // Account links: https://app.docusign.com/documents/details/<envelope id>
  if (DOCUSIGN_APP_HOST_RE.test(host) && /^\/(documents|envelopes|signing)\b/i.test(u.pathname)) return "docusign"
  // f8 Download Center (photos). Everything else on f8re.com is null.
  if (F8_HOST_RE.test(host) && F8_DOWNLOAD_CENTER_RE.test(u.pathname)) return "f8"
  // HomeSentry inspection report share page. Everything else on tapinspect.com is null.
  if (TAPINSPECT_HOST_RE.test(host) && TAPINSPECT_SHARE_RE.test(u.pathname)) return "tapinspect"
  // FreshBooks client link (StyleMe proposals / invoices). Login, marketing, the rest of the app: null.
  if (FRESHBOOKS_HOST_RE.test(host) && /^\/?$/.test(u.pathname) && FRESHBOOKS_LINK_RE.test(u.hash)) return "freshbooks"
  return null
}

/** The query inside a FreshBooks link's hash (`#/link/…?companyName=…&invoiceNumber=…`) as URLSearchParams; empty when it is not one. */
function freshbooksParams(url) {
  let u
  try {
    u = new URL(String(url || "").trim())
  } catch {
    return new URLSearchParams()
  }
  if (!FRESHBOOKS_HOST_RE.test(u.hostname)) return new URLSearchParams()
  const q = u.hash.indexOf("?")
  return new URLSearchParams(q >= 0 ? u.hash.slice(q + 1) : "")
}

/** "proposal" (#/link/estimate/… or entityName=proposal) | "invoice" (#/link/<jwt> or invoiceNumber=) | null when the link is not a FreshBooks document. */
export function freshbooksKind(url) {
  if (detectProvider(url) !== "freshbooks") return null
  const u = new URL(String(url).trim())
  const params = freshbooksParams(url)
  if (/^#\/link\/estimate\//i.test(u.hash) || /^(proposal|estimate)$/i.test(params.get("entityName") || "") || params.has("estimateNumber")) return "proposal"
  if (params.has("invoiceNumber") || /^#\/link\/[A-Za-z0-9._~-]+/.test(u.hash)) return "invoice"
  return null
}

/** The document number carried in the link (`estimateNumber=SS01174` / `invoiceNumber=080223VA`), else null. */
export function freshbooksNumber(url) {
  if (detectProvider(url) !== "freshbooks") return null
  const params = freshbooksParams(url)
  const n = (params.get("invoiceNumber") || params.get("estimateNumber") || "").trim()
  return n || null
}

/** The share uuid in a tapinspect link (HomeSentry reuses the SAME share URL for "results updated"), else null. */
export function tapinspectShareId(url) {
  let u
  try {
    u = new URL(String(url || "").trim())
  } catch {
    return null
  }
  if (!TAPINSPECT_HOST_RE.test(u.hostname)) return null
  const m = TAPINSPECT_SHARE_RE.exec(u.pathname)
  return m ? m[1].toLowerCase() : null
}

const ADDRESS_RE = /\b(\d{1,6}[a-z]?)\s+([A-Za-z][A-Za-z0-9.' -]{0,40}?)\s+(ave|avenue|dr|drive|st|street|rd|road|ct|court|ln|lane|blvd|boulevard|way|pl|place|cir|circle|ter|terrace|hwy|highway)\b\.?/i
/** "Inspection results for 5764 Halleck Dr, San Jose, CA 95123" → "5764 Halleck Dr" (number + street, anywhere in the text), else null.
 *  Lives here (dependency-free) so loops.mjs can use it without importing the browser-side dispatcher. */
export function addressIn(text) {
  const m = ADDRESS_RE.exec(String(text || ""))
  return m ? `${m[1]} ${m[2].trim()} ${m[3]}` : null
}

/** "document" providers go through the PDF filing pipeline; "media" providers (photos) go to Photos/. */
export function providerKind(provider) {
  return provider === "f8" ? "media" : "document"
}

/**
 * Providers whose links queue even on a system ("automated") email: the f8
 * delivery and HomeSentry's results notice are both machine-sent, and the
 * link is the only thing that matters. DocuSign keeps its kind-based gate.
 */
export function queuesOnSystemEmail(provider) {
  return provider === "f8" || provider === "tapinspect" || provider === "freshbooks"
}

/**
 * Some providers are shared billing systems: a FreshBooks link is a document
 * Ryan keeps only when the email matched a vendor rule that files into a
 * property folder (StyleMe). Every other provider queues on its own.
 * @param {Provider|string|null|undefined} provider
 * @param {{ destination?: string }|null|undefined} rule the matched vendor rule, or null
 */
export function queuesForVendor(provider, rule) {
  if (provider !== "freshbooks") return true
  return rule?.destination === "property"
}

/**
 * A Postmark click-tracking link → the link it wraps; anything else passes
 * through untouched. Rule (brief 2026-10-15): take the path segment right
 * after `/3ts/`, URL-decode it, and if it starts with `f8.f8re.com/` (or any
 * bare host) prefix `https://`.
 * @param {string|null|undefined} url
 * @returns {string}
 */
export function unwrapTrackingUrl(url) {
  const raw = String(url || "").trim()
  let u
  try {
    u = new URL(raw)
  } catch {
    return raw
  }
  if (!POSTMARK_HOST_RE.test(u.hostname)) return raw
  const m = /^\/3ts\/([^/]+)/.exec(u.pathname)
  if (!m) return raw
  let target
  try {
    target = decodeURIComponent(m[1])
  } catch {
    return raw
  }
  if (!/^https?:\/\//i.test(target)) target = `https://${target}`
  try {
    return new URL(target).href
  } catch {
    return raw
  }
}

/** Every http(s) URL in a blob of text, in order, trailing punctuation stripped,
 *  tracking wrappers unwrapped, de-duplicated (so a wrapped and a plain copy of
 *  the same Download Center link count once). */
export function extractUrls(text) {
  const out = []
  const seen = new Set()
  for (const raw of String(text || "").match(URL_RE) || []) {
    const url = unwrapTrackingUrl(raw.replace(TRAIL_RE, ""))
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

/**
 * Document links in one email: the body's URLs plus anything the classifier
 * reported (`document_links`), kept only when a provider claims them.
 * @param {{ text?: string, snippet?: string }} msg
 * @param {string[]} [extra] classifier-reported links
 * @returns {Array<{ url: string, provider: Provider }>}
 */
export function documentLinks(msg, extra = []) {
  const out = []
  const seen = new Set()
  for (const url of [...extractUrls(msg?.text), ...(Array.isArray(extra) ? extra : []).map((u) => unwrapTrackingUrl(u))]) {
    const provider = detectProvider(url)
    if (!provider || seen.has(url)) continue
    seen.add(url)
    out.push({ url, provider })
  }
  return out
}

/** Human label for cards. */
export function providerLabel(provider) {
  return provider === "docusign" ? "DocuSign" : provider === "f8" ? "f8" : provider === "tapinspect" ? "HomeSentry (Tap Inspect)" : provider === "freshbooks" ? "FreshBooks" : provider || "the link"
}

/**
 * The branded / unbranded property-website links in an f8 delivery email
 * (`https://f8.f8re.com/sites/<slug>/branded`, `/sites/<code>/unbranded`),
 * tracking wrappers removed. Each is null when absent. They go on the card,
 * never on the queue.
 * @param {string|null|undefined} text
 * @returns {{ branded: string|null, unbranded: string|null }}
 */
export function propertyWebsiteLinks(text) {
  const out = { branded: null, unbranded: null }
  for (const url of extractUrls(text)) {
    let u
    try {
      u = new URL(url)
    } catch {
      continue
    }
    if (!F8_HOST_RE.test(u.hostname)) continue
    const m = F8_SITE_RE.exec(u.pathname)
    if (!m) continue
    const which = m[2].toLowerCase()
    if (!out[which]) out[which] = url
  }
  return out
}
