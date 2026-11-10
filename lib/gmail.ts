// Server-only Gmail client. Split out of lib/leads.ts (2026-11-10) so the ~100
// routes that import lib/leads no longer load googleapis on a cold start.
// NEVER import this from a file the browser can reach (lib/mailMatch,
// lib/next-touch, lib/card-line, …) — googleapis in the client bundle fails
// the build.
import { google, gmail_v1 } from "googleapis"

// Build a Gmail API client that impersonates the given mailbox owner via
// Google Workspace domain-wide delegation. DWD on the lrghomes Workspace
// tenant is authorized for gmail.modify only — gmail.readonly returns 401
// `unauthorized_client`, gmail.send is also unauthorized. gmail.modify
// includes the read AND send perms we need (see Phase 7.4 in the CRMS memo).
// The grant is per Workspace customer, so the secondary sending domains
// (lrghomesbuys.com, lrghomesoffers.com) inherit it — verified 2026-09-03
// with scripts/check-dwd-scopes.mjs (re-run it before trusting a new domain).
// Used by both /api/leads/email (for inbound thread fetch) and
// /api/leads/email-reply (for outbound send).
// DWD only: the consumer-Gmail OAuth branch (ryan.lrghomes@gmail.com,
// 2026-08-21) was retired 2026-09-01 and removed 2026-09-06 — that mailbox
// never sends again and its CAMPAIGN_GMAIL_OAUTH_* env vars are gone.
export function getGmailClient(userEmail: string): gmail_v1.Gmail {
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!key) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set")
  const credentials = JSON.parse(key)
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    subject: userEmail,
  })
  return google.gmail({ version: "v1", auth })
}
