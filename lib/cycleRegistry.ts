// Market-cycle owned-property registry — the Telegram fallback
// (briefs/BRIEF_MARKET_CYCLE_TRACKER_2026-11-01.md §3.1 item 5). The pure parser
// and planner live in scripts/market-cycle/registry.mjs, shared with the inbox
// agent on the Mac mini. Off unless CYCLE_REGISTRY=on.
import type { SupabaseClient } from "@supabase/supabase-js"
import { getLeadsClient } from "@/lib/leads"
import { applyRegistryEvent, cycleRegistryOn, liveRegistryRows, parseOwnCommand, registryListText } from "../scripts/market-cycle/registry.mjs"

export { cycleRegistryOn, parseOwnCommand }

export type OwnCommand =
  | { kind: "add"; address: string; zip: string; flag: string }
  | { kind: "sold"; address: string }
  | { kind: "list" }
  | { kind: "error"; message: string }

/** Today on Ryan's clock, YYYY-MM-DD. */
export function ptToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
}

/** Run one parsed `own …` command; returns the one-line reply. Throws on a DB error. */
export async function runOwnCommand(cmd: OwnCommand, client: SupabaseClient = getLeadsClient(), today: string = ptToday()): Promise<string> {
  if (cmd.kind === "error") return cmd.message
  if (cmd.kind === "list") return registryListText(await liveRegistryRows(client))
  if (cmd.kind === "add") {
    const out = await applyRegistryEvent(client, { kind: "add", address: cmd.address, zip: cmd.zip, flag: cmd.flag, source: "telegram" })
    return out.line || "Registry: no change."
  }
  const out = await applyRegistryEvent(client, { kind: "sold", address: cmd.address, date: today, source: "telegram" })
  return out.line || "Registry: no change."
}
