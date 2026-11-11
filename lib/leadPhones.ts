import type { SupabaseClient } from "@supabase/supabase-js"

// A lead's best number (2026-11-10, supabase/migrations/2026-11-10_lead_best_numbers.sql).
//
// The card is keyed on the number a person first reached us from. Sometimes
// that isn't theirs — a seller called from her daughter's office and gave her
// own cell on the call. lead_best_numbers holds the ONE other number for the
// person:
//   - going out (Call button, texts, drips): reachNumber() swaps it in at the
//     transport, so the row still logs under the card's number
//   - coming in (voice / sms webhooks): personPhoneFor() maps it back, so a
//     call or text from the cell lands on the same card
//
// Every lookup fails open to the number it was given — a missing table or a
// Supabase blip must never block a call, a text or an inbound webhook.
//
// Kept free of lib/leads imports so lib/leads can use it.

export interface BestNumber {
  person_phone: string
  best_phone: string
  source: "judge" | "ryan"
  heard: string | null
}

function e164(raw: string): string | null {
  const trimmed = String(raw || "").trim()
  if (trimmed.startsWith("+") && /^\+\d{10,15}$/.test(trimmed)) return trimmed
  const digits = trimmed.replace(/\D/g, "")
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`
  return null
}

/** The number to ring / text for this card: their best number, else the card's own. */
export async function reachNumber(sb: SupabaseClient, personPhone: string): Promise<string> {
  try {
    const { data } = await sb.from("lead_best_numbers").select("best_phone").eq("person_phone", personPhone).maybeSingle()
    return (data?.best_phone as string | undefined) || personPhone
  } catch {
    return personPhone
  }
}

/** The card a number belongs to: a best number maps back to its person, anything else is itself. */
export async function personPhoneFor(client: SupabaseClient | (() => SupabaseClient), phone: string): Promise<string> {
  if (!phone) return phone
  try {
    // Webhooks pass the factory so a client that can't be built also fails open.
    const sb = typeof client === "function" ? client() : client
    const { data } = await sb.from("lead_best_numbers").select("person_phone").eq("best_phone", phone).maybeSingle()
    return (data?.person_phone as string | undefined) || phone
  } catch {
    return phone
  }
}

/** Best numbers for a page of cards, keyed by the card's number. */
export async function bestNumbersFor(sb: SupabaseClient, personPhones: string[]): Promise<Map<string, BestNumber>> {
  const out = new Map<string, BestNumber>()
  if (!personPhones.length) return out
  // One per rare lead — the whole table is smaller than an IN list of every card.
  const { data, error } = await sb.from("lead_best_numbers").select("person_phone, best_phone, source, heard").limit(1000)
  if (error) throw new Error(error.message)
  const wanted = new Set(personPhones)
  for (const r of (data ?? []) as BestNumber[]) if (wanted.has(r.person_phone)) out.set(r.person_phone, r)
  return out
}

export async function setBestNumber(
  sb: SupabaseClient,
  input: { personPhone: string; bestPhone: string; source: "judge" | "ryan"; heard?: string | null },
): Promise<{ ok: true; best: BestNumber } | { ok: false; error: string }> {
  const person = e164(input.personPhone)
  const best = e164(input.bestPhone)
  if (!person) return { ok: false, error: "This card has no phone number to attach another one to." }
  if (!best) return { ok: false, error: `"${input.bestPhone}" isn't a full phone number.` }
  if (best === person) return { ok: false, error: "That's the number already on the card." }
  const { data: taken } = await sb.from("lead_best_numbers").select("person_phone").eq("best_phone", best).neq("person_phone", person).maybeSingle()
  if (taken) return { ok: false, error: "That number is already the best number on another lead's card." }
  const row = { person_phone: person, best_phone: best, source: input.source, heard: input.heard?.trim().slice(0, 300) || null, created_at: new Date().toISOString() }
  const { error } = await sb.from("lead_best_numbers").upsert(row)
  if (error) return { ok: false, error: error.message }
  return { ok: true, best: { person_phone: person, best_phone: best, source: input.source, heard: row.heard } }
}

export async function clearBestNumber(sb: SupabaseClient, personPhone: string): Promise<{ ok: boolean; error?: string }> {
  const { error } = await sb.from("lead_best_numbers").delete().eq("person_phone", personPhone)
  return error ? { ok: false, error: error.message } : { ok: true }
}
