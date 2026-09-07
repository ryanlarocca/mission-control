// Shared Gmail sender for the agent campaign (engine + test batches).
//
// One auth path: service account with domain-wide delegation, impersonating a
// mailbox on the lrghomes Workspace tenant (*@lrghomes.com,
// *@lrghomesbuys.com, *@lrghomesoffers.com). DWD is per customer, so the
// secondary domains inherit the grant — verified 2026-09-03 via
// scripts/check-dwd-scopes.mjs (gmail.modify mints for all three;
// gmail.send is NOT granted but messages.send works under gmail.modify).
//
// The consumer-Gmail OAuth path (ryan.lrghomes@gmail.com, 2026-08-21) was
// retired 2026-09-01 and removed 2026-09-06 (September rebuild, item 4). That
// address never sends again; a request to authenticate as any mailbox outside
// the tenant is refused here, before any credential is touched.
import { createHmac } from "node:crypto"
import { google } from "googleapis"
import emailMime from "./email-mime.js"
const { buildEmailMime } = emailMime

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]

/** Domains the DWD grant can impersonate. Keep in sync with OWN_DOMAINS in lib/campaignInbox.ts and ALLOWED_DOMAINS in scripts/add-email-mailbox.mjs. */
export const TENANT_DOMAINS = ["lrghomes.com", "lrghomesbuys.com", "lrghomesoffers.com"]

export function isTenantMailbox(mailbox) {
  const m = String(mailbox || "").trim().toLowerCase()
  const at = m.lastIndexOf("@")
  return at > 0 && TENANT_DOMAINS.includes(m.slice(at + 1))
}

/** Authenticated Gmail client for `mailbox` (DWD; tenant mailboxes only). */
export async function gmailClientFor(mailbox) {
  if (!isTenantMailbox(mailbox)) {
    throw new Error(`refusing to authenticate as ${mailbox}: not on the lrghomes Workspace tenant (${TENANT_DOMAINS.join(", ")}) — the consumer-Gmail sender was retired 2026-09-01`)
  }
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!keyJson) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set")
  const credentials = JSON.parse(keyJson)
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: GMAIL_SCOPES,
    subject: String(mailbox).trim().toLowerCase(),
  })
  await auth.authorize()
  return google.gmail({ version: "v1", auth })
}

export function unsubToken(contactId) {
  const secret = process.env.CAMPAIGN_UNSUB_SECRET || ""
  return `${contactId}.${createHmac("sha256", secret).update(contactId).digest("hex").slice(0, 32)}`
}

/**
 * Full RFC822 message for a campaign send. `contactId` + CAMPAIGN_UNSUB_SECRET
 * → RFC 8058 one-click List-Unsubscribe headers; pass `unsubHeaders:false`
 * to suppress them (T1 plan, 2026-08-21: headers alone flipped Primary →
 * Promotions; body "reply remove" line only on touch 1).
 */
export function buildCampaignMime({ from, to, subject, body, contactId, unsubHeaders = true, extraHeaders = [] }) {
  const headers = [...extraHeaders]
  if (unsubHeaders && contactId && process.env.CAMPAIGN_UNSUB_SECRET) {
    const url = `https://mission-control-three-chi.vercel.app/api/campaign/unsub/${unsubToken(contactId)}`
    headers.push(`List-Unsubscribe: <mailto:${from}?subject=unsubscribe>, <${url}>`)
    headers.push("List-Unsubscribe-Post: List-Unsubscribe=One-Click")
  }
  return buildEmailMime({ from: `Ryan LaRocca <${from}>`, to, subject, body, extraHeaders: headers })
}

export function b64url(s) {
  return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Send one message as `from`. Returns Gmail's {id, threadId}. */
export async function sendCampaignMessage(gmail, args) {
  const raw = b64url(buildCampaignMime(args))
  const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw } })
  return res.data
}
