import type { SupabaseClient } from "@supabase/supabase-js"

// Master DNC suppression list (2026-07-17 email-campaign brief, Phase 1).
//
// One table unifies every "do not contact" signal: lead DNC flags and
// dnc_list rows sync in via DB triggers (see
// scripts/2026-07-17-suppression-triggers.sql); campaign unsubscribes and
// ad-hoc adds insert directly. Relationships rotation-removals are
// deliberately NOT suppression — Ryan's rule: BoB status never blocks the
// campaign drip.
//
// Match rule: a contact is suppressed for a send when email OR phone
// matches AND the entry's channel is 'all' or equals the send's channel.
//
// Conventions (must match the triggers + backfill): email lowercased and
// trimmed; phone reduced to its last 10 digits.

export type SuppressionChannel = "mail" | "email" | "sms" | "call" | "all"

export interface SuppressionEntry {
  email?: string | null
  phone?: string | null
  name?: string | null
  reason?: string | null
  source: string
  source_ref?: string | null
  channel: SuppressionChannel
  audience?: string | null
}

export function normalizeSuppressionEmail(raw: unknown): string | null {
  const s = String(raw ?? "").trim().toLowerCase()
  return s.includes("@") ? s : null
}

export function normalizeSuppressionPhone(raw: unknown): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "")
  return digits.length >= 10 ? digits.slice(-10) : null
}

/** True when the given identity is suppressed for the given channel. */
export async function isSuppressed(
  sb: SupabaseClient,
  opts: { email?: string | null; phone?: string | null; channel: SuppressionChannel }
): Promise<boolean> {
  const email = normalizeSuppressionEmail(opts.email)
  const phone = normalizeSuppressionPhone(opts.phone)
  if (!email && !phone) return false

  const identity: string[] = []
  if (email) identity.push(`email.eq.${email}`)
  if (phone) identity.push(`phone.eq.${phone}`)

  const { data, error } = await sb
    .from("suppression")
    .select("id")
    .or(identity.join(","))
    .in("channel", opts.channel === "all" ? ["all"] : [opts.channel, "all"])
    .limit(1)
  if (error) throw new Error(`suppression lookup failed: ${error.message}`)
  return (data ?? []).length > 0
}

/**
 * Full suppression sets for batch work (import scrubs, engine passes).
 * The table is small; one fetch beats a per-contact query storm.
 */
export async function fetchSuppressionSets(
  sb: SupabaseClient,
  channel: SuppressionChannel
): Promise<{ emails: Set<string>; phones: Set<string> }> {
  const { data, error } = await sb
    .from("suppression")
    .select("email, phone")
    .in("channel", channel === "all" ? ["all"] : [channel, "all"])
  if (error) throw new Error(`suppression fetch failed: ${error.message}`)
  const emails = new Set<string>()
  const phones = new Set<string>()
  for (const row of data ?? []) {
    const e = normalizeSuppressionEmail(row.email)
    const p = normalizeSuppressionPhone(row.phone)
    if (e) emails.add(e)
    if (p) phones.add(p)
  }
  return { emails, phones }
}

/** Insert a suppression entry (unsubscribes, ad-hoc adds). Idempotent per (source, source_ref). */
export async function addSuppression(sb: SupabaseClient, entry: SuppressionEntry): Promise<void> {
  const row = {
    email: normalizeSuppressionEmail(entry.email),
    phone: normalizeSuppressionPhone(entry.phone),
    name: entry.name ?? null,
    reason: entry.reason ?? null,
    source: entry.source,
    source_ref: entry.source_ref ?? null,
    channel: entry.channel,
    audience: entry.audience ?? "unknown",
  }
  if (!row.email && !row.phone) {
    throw new Error("suppression entry needs at least one of email/phone")
  }
  // The (source, source_ref) unique index is partial, which PostgREST upserts
  // can't target — check-then-insert instead. The DB index still backstops a
  // race with a hard error, which the caller can treat as "already there".
  if (row.source_ref) {
    const { data: existing, error: selErr } = await sb
      .from("suppression")
      .select("id")
      .eq("source", row.source)
      .eq("source_ref", row.source_ref)
      .limit(1)
    if (selErr) throw new Error(`suppression lookup failed: ${selErr.message}`)
    if ((existing ?? []).length > 0) return
  }
  const { error } = await sb.from("suppression").insert(row)
  if (error && !/duplicate key/i.test(error.message)) {
    throw new Error(`suppression insert failed: ${error.message}`)
  }
}
