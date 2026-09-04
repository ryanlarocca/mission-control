// Shared Gmail sender for the agent campaign (engine + test batches).
//
// Two auth paths, picked by mailbox (2026-08-21, deliverability restart):
//   - any Workspace-tenant mailbox (*@lrghomes.com, *@lrghomesbuys.com,
//     *@lrghomesoffers.com) → service account with domain-wide delegation.
//     DWD is per customer, so the secondary domains inherit the grant —
//     verified 2026-09-03 via scripts/check-dwd-scopes.mjs (gmail.modify
//     mints for all three; gmail.send is NOT granted but messages.send
//     works under gmail.modify).
//   - the consumer Gmail in CAMPAIGN_GMAIL_OAUTH_USER → OAuth refresh token
//     (RETIRED 2026-09-01 — env vars removed; branch kept only until the
//     Gmail strip lands in the September rebuild)
//     (DWD cannot impersonate gmail.com). Token minted once via
//     scripts/gmail-oauth-consent.mjs; env CAMPAIGN_GMAIL_OAUTH_{CLIENT_ID,
//     CLIENT_SECRET,REFRESH_TOKEN,USER}. The same token lets the inbox
//     watcher (lib/leads.ts getGmailClient) read that mailbox.
import { createHmac } from "node:crypto"
import { google } from "googleapis"
import emailMime from "./email-mime.js"
const { buildEmailMime } = emailMime

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]

export function oauthUser() {
  return (process.env.CAMPAIGN_GMAIL_OAUTH_USER || "").toLowerCase()
}

export function isOAuthMailbox(mailbox) {
  const u = oauthUser()
  return !!u && String(mailbox || "").toLowerCase() === u
}

export function oauthClient() {
  const { CAMPAIGN_GMAIL_OAUTH_CLIENT_ID: id, CAMPAIGN_GMAIL_OAUTH_CLIENT_SECRET: secret, CAMPAIGN_GMAIL_OAUTH_REFRESH_TOKEN: refresh } = process.env
  if (!id || !secret) throw new Error("CAMPAIGN_GMAIL_OAUTH_CLIENT_ID/SECRET not set")
  const auth = new google.auth.OAuth2(id, secret, "http://127.0.0.1")
  if (refresh) auth.setCredentials({ refresh_token: refresh })
  return auth
}

/** Authenticated Gmail client for `mailbox` (DWD or OAuth, by address). */
export async function gmailClientFor(mailbox) {
  if (isOAuthMailbox(mailbox)) {
    const auth = oauthClient()
    if (!process.env.CAMPAIGN_GMAIL_OAUTH_REFRESH_TOKEN) throw new Error(`no CAMPAIGN_GMAIL_OAUTH_REFRESH_TOKEN for ${mailbox} — run scripts/gmail-oauth-consent.mjs`)
    await auth.getAccessToken() // fail fast on a revoked/expired token
    return google.gmail({ version: "v1", auth })
  }
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY)
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: GMAIL_SCOPES,
    subject: mailbox,
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
