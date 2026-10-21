// Atomic email-lead dedupe (BRIEF_TRIAGE_SONNET_DEDUPE_MATCHLINK_2026-10-21
// §3). Both email paths used to dedupe by read-then-insert (select the
// sender's last-hour rows, compare the first 200 chars, insert) and two
// Gmail notifications for the same message raced through it — two identical
// rows 0.2 s apart, same gmail_thread_id. The partial unique index on
// leads.gmail_message_id (supabase/migrations/2026-10-21_leads_gmail_message_id.sql)
// makes the second insert fail with 23505; this module turns that into
// "duplicate, skip" so the route logs and returns instead of alerting.
import { createHash } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"

/** Postgres unique_violation. */
export const UNIQUE_VIOLATION = "23505"

/**
 * Apps Script payloads carry no Gmail message id. Derive one from what the
 * two deliveries of the same mail share so the same unique index covers
 * them: "as:" + sha1(sender|subject|first 200 chars of body).
 */
export function appsScriptMessageId(sender: string, subject: string, body: string): string {
  const key = `${sender.trim().toLowerCase()}|${subject}|${body.slice(0, 200)}`
  return `as:${createHash("sha1").update(key).digest("hex")}`
}

export function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: unknown }).code === UNIQUE_VIOLATION
}

export interface EmailLeadInsertResult {
  id: string | null
  /** True when the unique index rejected the row — the message is already a lead. */
  duplicate: boolean
  error: { message: string; code?: string } | null
}

/**
 * Insert an email-lead row. A unique violation on gmail_message_id is the
 * normal "second notification for one message" case: returned as
 * `duplicate: true`, never thrown, never alerted. Any other error is
 * returned as-is for the caller to log.
 */
export async function insertEmailLead(
  sb: SupabaseClient,
  row: Record<string, unknown> & { gmail_message_id?: string | null }
): Promise<EmailLeadInsertResult> {
  const { data, error } = await sb.from("leads").insert(row).select("id").single()
  if (error) {
    if (isUniqueViolation(error)) return { id: null, duplicate: true, error: null }
    return { id: null, duplicate: false, error: { message: error.message, code: (error as { code?: string }).code } }
  }
  return { id: (data as { id?: string } | null)?.id ?? null, duplicate: false, error: null }
}
