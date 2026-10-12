// Inbox Agent — which links hide documents? (briefs/BRIEF_INBOX_LINK_FETCH_2026-10-12.md)
//
// Pure, dependency-free on purpose: the Mac mini worker (scripts/inbox-agent/
// index.mjs) and the Vercel webhook (lib/inboxAgent.ts) both import this file,
// so a link is judged the same way whether the email arrives or Ryan types
// `fetch <url>`. Nothing here touches a browser.
//
// Ryan 2026-10-12: the DocuSign link is "an ongoing friction point" — the
// Completed email often arrives without the PDF, only the EmailStart link.
// DocuSign is the only provider in v1; Disclosures.io / Glide / Zix /
// Authentisign are later phases.

/** @typedef {"docusign"} Provider */

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
  return null
}

/** Every http(s) URL in a blob of text, in order, trailing punctuation stripped, de-duplicated. */
export function extractUrls(text) {
  const out = []
  const seen = new Set()
  for (const raw of String(text || "").match(URL_RE) || []) {
    const url = raw.replace(TRAIL_RE, "")
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
  for (const url of [...extractUrls(msg?.text), ...(Array.isArray(extra) ? extra : [])]) {
    const provider = detectProvider(url)
    if (!provider || seen.has(url)) continue
    seen.add(url)
    out.push({ url, provider })
  }
  return out
}

/** Human label for cards. */
export function providerLabel(provider) {
  return provider === "docusign" ? "DocuSign" : provider || "the link"
}
