import Anthropic from "@anthropic-ai/sdk"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import prices from "@/config/llm-prices.json"

// What every model call costs, and which key pays for it (2026-11-07).
// Ryan's API spend went from ~$0 to $10–13/day after the Nov 2–5 Opus
// features, and nothing recorded which feature spent what. Two Console keys
// now split the bill by job: "drafts" = the writing Ryan reads and sends
// (reply drafts, the coach, call scripts, the CRMS composer); "background"
// = everything else. Each lane falls back to the old ANTHROPIC_API_KEY, so a
// missing lane key never stops a feature. Every call lands one row in
// llm_usage; scripts/llm-spend-report.mjs posts the daily / weekly line.
// The Mac mini scripts do the same through scripts/llm-usage.cjs.

export type LlmLane = "drafts" | "background"

export const LANE_KEY_ENV: Record<LlmLane, string> = {
  drafts: "ANTHROPIC_API_KEY_DRAFTS",
  background: "ANTHROPIC_API_KEY_BACKGROUND",
}

const LANE_LABEL: Record<LlmLane, string> = {
  drafts: "Drafts & coaching",
  background: "Background jobs",
}

export function apiKeyFor(lane: LlmLane): string | undefined {
  const raw = process.env[LANE_KEY_ENV[lane]] || process.env.ANTHROPIC_API_KEY || ""
  return raw.trim() || undefined
}

export interface UsageLike {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }
const PRICES = prices as unknown as Record<string, Price>

/** USD for one response's usage, or null for a model with no price on file. */
export function costUsd(model: string, usage: UsageLike | null | undefined): number | null {
  const p = PRICES[model]
  if (!p || !usage) return p ? 0 : null
  const n = (v: number | null | undefined) => (typeof v === "number" && v > 0 ? v : 0)
  return (
    n(usage.input_tokens) * p.input +
    n(usage.output_tokens) * p.output +
    n(usage.cache_read_input_tokens) * p.cacheRead +
    n(usage.cache_creation_input_tokens) * p.cacheWrite
  ) / 1_000_000
}

/** A refusal for money (credit balance, workspace spend limit) — not a
 *  per-minute rate limit, which clears on its own. */
export function isBillingError(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status
  const msg = e instanceof Error ? e.message : String(e ?? "")
  if (!/credit balance|spend(ing)? limit|usage limit|billing|insufficient (funds|credit)|budget/i.test(msg)) return false
  return status === undefined || status === 400 || status === 402 || status === 403 || status === 429
}

let db: SupabaseClient | null = null
function usageDb(): SupabaseClient | null {
  if (db) return db
  const url = process.env.LRG_SUPABASE_URL
  const key = process.env.LRG_SUPABASE_SERVICE_KEY
  if (!url || !key) return null
  // no-store: see getLeadsClient — Next caches GET fetches otherwise.
  db = createClient(url, key, {
    auth: { persistSession: false },
    global: { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...(init ?? {}), cache: "no-store" }) },
  })
  return db
}

async function telegram(text: string): Promise<void> {
  const token = process.env.CAMPAIGN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) return
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {})
}

// One alert per lane per 6 hours, across every serverless instance and the
// mini: the check reads llm_usage for an earlier billing failure.
async function alertBilling(sb: SupabaseClient, lane: LlmLane, message: string): Promise<void> {
  const since = new Date(Date.now() - 6 * 3600_000).toISOString()
  const { data } = await sb.from("llm_usage").select("id").eq("lane", lane).eq("error_kind", "billing").gte("created_at", since).limit(1)
  if (data && data.length) return
  await telegram(
    `⚠️ <b>${LANE_LABEL[lane]} key was refused by Anthropic</b> — out of credit or over its spending limit.\n` +
    `${lane === "drafts" ? "Drafts, the coach and call scripts" : "Background jobs (judge, inbox, triage, call notes)"} will fail until funds are added in the Console.\n\n` +
    `<i>${message.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;")).slice(0, 300)}</i>`,
  )
}

/** One row per model call. Best-effort: never throws, never waits > 4 s. */
export async function recordLlmUsage(args: { lane: LlmLane; model: string; tag: string; usage?: UsageLike | null; error?: unknown }): Promise<void> {
  const sb = usageDb()
  if (!sb) return
  const work = (async () => {
    const billing = args.error !== undefined && isBillingError(args.error)
    const errMsg = args.error !== undefined ? (args.error instanceof Error ? args.error.message : String(args.error)) : null
    if (billing) await alertBilling(sb, args.lane, errMsg ?? "")
    const u = args.usage ?? {}
    const cost = costUsd(args.model, args.usage)
    const { error } = await sb.from("llm_usage").insert({
      lane: args.lane,
      model: args.model,
      tag: args.tag,
      source: process.env.VERCEL ? "vercel" : "mini",
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_read_tokens: u.cache_read_input_tokens ?? 0,
      cache_write_tokens: u.cache_creation_input_tokens ?? 0,
      cost_usd: cost ?? 0,
      ok: args.error === undefined,
      error_kind: args.error === undefined ? null : billing ? "billing" : "error",
      error: errMsg ? errMsg.slice(0, 500) : null,
    })
    if (error) console.warn(`[llm-usage] insert failed: ${error.message}`)
    if (cost === null) console.warn(`[llm-usage] no price on file for ${args.model} — add it to config/llm-prices.json`)
  })()
  await Promise.race([work.catch((e) => console.warn("[llm-usage] threw:", e instanceof Error ? e.message : String(e))), new Promise((r) => setTimeout(r, 4000))])
}

/** An SDK client on the lane's key whose messages.create records usage —
 *  for the few call sites that build their own request instead of using
 *  completeText. */
export function laneClient(lane: LlmLane, tag: string): Anthropic {
  const client = new Anthropic({ apiKey: apiKeyFor(lane) })
  const messages = client.messages as unknown as { create: (params: { model: string; stream?: boolean }, options?: unknown) => Promise<unknown> }
  const create = messages.create.bind(client.messages)
  messages.create = async (params, options) => {
    if (params.stream) return create(params, options)
    try {
      const res = (await create(params, options)) as Anthropic.Message
      await recordLlmUsage({ lane, model: params.model, tag, usage: res.usage })
      return res
    } catch (e) {
      await recordLlmUsage({ lane, model: params.model, tag, error: e })
      throw e
    }
  }
  return client
}
