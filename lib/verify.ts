// Kickbox verification — typed façade over scripts/campaign-verify.mjs (the
// canonical implementation, shared with the Mac mini engine; autopilot brief
// 2026-10-15, Task 5). Imports are read-only re-exports: no Supabase, no
// network at module load. New imports are NOT verified here — they land
// with verified_at = null and the engine's morning verifyPass picks them up
// (the simpler of the brief's two options; see the PR).

import * as verifyModule from "../scripts/campaign-verify.mjs"

export type KickboxResult = "deliverable" | "undeliverable" | "risky" | "unknown"

export interface VerifyVerdict {
  result: KickboxResult
  reason: string
  accept_all: boolean
  sendex: number | null
  checked_at: string
  role: boolean
  free: boolean
  disposable: boolean
  did_you_mean: string | null
  domain: string | null
  balance?: number | null
}

export type VerifyBucket = "deliverable" | "catch_all" | "risky" | "unknown" | "undeliverable"

export interface VerifyActionResult {
  action: "eligible" | "hold" | "suppress"
  bucket: VerifyBucket
  source?: "verify_undeliverable"
  status?: "invalid"
}

export interface VerifiableContact {
  verified_at?: string | null
  verify_result?: string | null
  verify_accept_all?: boolean | null
}

export interface VerifyOptions {
  apiKey?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  maxRetries?: number
  sleep?: (ms: number) => Promise<void>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const m = verifyModule as unknown as Record<string, any>

export const KICKBOX_URL: string = m.KICKBOX_URL
export const VERIFY_FRESH_DAYS: number = m.VERIFY_FRESH_DAYS
export const VERIFY_UNKNOWN_RETRY_DAYS: number = m.VERIFY_UNKNOWN_RETRY_DAYS
export const VERIFY_DAILY_MAX_DEFAULT: number = m.VERIFY_DAILY_MAX_DEFAULT

/** GET https://api.kickbox.com/v2/verify?email=&apikey=&timeout=10000 → the mapped verdict. */
export function verifyEmail(email: string, opts: VerifyOptions = {}): Promise<VerifyVerdict> {
  return m.verifyEmail(email, opts) as Promise<VerifyVerdict>
}

export function mapKickbox(json: unknown, now?: Date): VerifyVerdict {
  return m.mapKickbox(json, now) as VerifyVerdict
}

export function verifyAction(v: Pick<VerifyVerdict, "result" | "accept_all">): VerifyActionResult {
  return m.verifyAction(v) as VerifyActionResult
}

export function isDraftEligible(contact: VerifiableContact, opts: { required?: boolean; now?: Date } = {}): { eligible: boolean; why: string; bucket: string } {
  return m.isDraftEligible(contact, opts) as { eligible: boolean; why: string; bucket: string }
}

export function isSandboxKey(apiKey: string | undefined): boolean {
  return m.isSandboxKey(apiKey) as boolean
}
