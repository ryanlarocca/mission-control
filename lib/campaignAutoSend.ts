import { getLeadsClient } from "@/lib/leads"
import { PROMPT_VERSION } from "../scripts/campaign-compose.mjs"
import * as gates from "../scripts/campaign-gates.mjs"

// Auto-approve switch for the agent drip (autopilot brief, 2026-10-15,
// Task 1). The engine owns the logic (scripts/campaign-gates.mjs
// resolveAutoSend / withTouchAuto); this is the Vercel-side mirror the
// Telegram route uses to read and flip the same campaign_settings row:
//
//   auto T1 on      → touch 1 drafts straight to approved, pinned to the
//                     CURRENT PROMPT_VERSION (a later prompt change re-gates)
//   auto T1 off     → touch 1 waits for Ryan's ✅ again
//   auto status     → one line: which touches are auto, pinned to what, why

export interface AutoSendRow {
  touches: number[]
  pinned_prompt_version: string | null
  engine_prompt_version?: string | null
  regated_touches?: number[]
  changed_by?: string
  changed_at?: string
  reason?: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { AUTO_SEND_KEY, withTouchAuto } = gates as unknown as Record<string, any>

export async function getAutoSend(): Promise<AutoSendRow | null> {
  const sb = getLeadsClient()
  const { data } = await sb.from("campaign_settings").select("value").eq("key", AUTO_SEND_KEY).maybeSingle()
  return (data?.value as AutoSendRow | null) ?? null
}

/** Flip one touch. `on` re-pins the row to the current PROMPT_VERSION. */
export async function setAutoTouch(touch: number, on: boolean, by = "ryan"): Promise<AutoSendRow> {
  if (!Number.isInteger(touch) || touch < 1 || touch > 11) throw new Error(`touch must be 1..11, got ${touch}`)
  const sb = getLeadsClient()
  const cur = await getAutoSend()
  const next = withTouchAuto(cur, touch, on, { promptVersion: PROMPT_VERSION, by }) as AutoSendRow
  const { error } = await sb.from("campaign_settings").upsert({ key: AUTO_SEND_KEY, value: next, updated_at: new Date().toISOString() })
  if (error) throw new Error(`save ${AUTO_SEND_KEY}: ${error.message}`)
  return next
}

export function describeAutoSend(row: AutoSendRow | null): string {
  if (!row) return `auto: none (no ${AUTO_SEND_KEY} row yet — the engine seeds it from the env on its next pass)`
  const touches = (row.touches ?? []).map((t) => `T${t}`).join("/") || "none"
  const pin = row.pinned_prompt_version ? `pinned ${row.pinned_prompt_version}` : "unpinned"
  const live = row.engine_prompt_version && row.engine_prompt_version !== row.pinned_prompt_version ? ` · engine is on ${row.engine_prompt_version} — "auto T<n> on" re-pins` : ""
  const when = row.changed_at ? ` · ${row.changed_by ?? "?"} ${row.changed_at.slice(0, 10)}` : ""
  const why = row.reason ? ` · ${row.reason}` : ""
  const regated = row.regated_touches?.length ? ` · re-gated: ${row.regated_touches.map((t) => `T${t}`).join("/")}` : ""
  return `auto: ${touches} (${pin})${live}${regated}${when}${why}`
}

export async function autoSendStatusLine(): Promise<string> {
  return describeAutoSend(await getAutoSend())
}
