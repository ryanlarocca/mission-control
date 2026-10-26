import type { SupabaseClient } from "@supabase/supabase-js"

// The business-card line, (408) 458-5442 ("Office — Ryan"). A Relationships
// contact with the Card # toggle on (relationships.use_card_line) is called
// and texted from here instead of Ryan's cell, so their callbacks land on a
// line we capture (office-line routing, lib/office-inbound.ts) — 2026-10-26.
// Dependency-free so client components can import it; lib/leads re-exports.
export const CARD_LINE = "+14084585442"
export const CARD_LINE_DISPLAY = "(408) 458-5442"

// "+14084585442" → "458-5442" — the short tag on business-line bubbles.
export function lineTag(e164: string | null | undefined): string {
  const d = String(e164 ?? "").replace(/\D/g, "")
  return d.length >= 10 ? `${d.slice(-7, -4)}-${d.slice(-4)}` : "business line"
}

// "+14084585442" → "(408) 458-5442".
export function displayLine(e164: string): string {
  const d = e164.replace(/\D/g, "").slice(-10)
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : e164
}

// Whether calls/texts to this contact go from the card line. False on any
// error (logged) — the safe default is today's behaviour.
export async function getCardLineFlag(sb: SupabaseClient, relationshipId: string): Promise<boolean> {
  try {
    const { data, error } = await sb
      .from("relationships")
      .select("use_card_line")
      .eq("id", relationshipId)
      .maybeSingle<{ use_card_line: boolean | null }>()
    if (error) {
      console.error("[card-line] flag read failed:", error.message)
      return false
    }
    return data?.use_card_line === true
  } catch (e) {
    console.error("[card-line] flag read threw:", e instanceof Error ? e.message : String(e))
    return false
  }
}
