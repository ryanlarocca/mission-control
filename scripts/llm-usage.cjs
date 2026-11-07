// Mac mini side of lib/llmUsage.ts (2026-11-07 API cost audit). The launchd
// scripts (judge, drip engine, inbox agent, reply review, campaign compose)
// call Anthropic directly; this gives them the background-lane key and one
// llm_usage row per call, priced from the same config/llm-prices.json the
// app uses. CommonJS so both the .js and the .mjs scripts can load it.
//
//   const { anthropicClient } = require("./llm-usage.cjs")
//   const anthropic = anthropicClient({ tag: "[judge]" })
//   await anthropic.messages.create({ ...params, __tag: "[judge/x]" })  // optional per-call tag
//
// Reads process.env lazily, so a script may load .env.local after require().

const path = require("node:path")
const PRICES = require(path.join(__dirname, "..", "config", "llm-prices.json"))

const LANE_KEY_ENV = { drafts: "ANTHROPIC_API_KEY_DRAFTS", background: "ANTHROPIC_API_KEY_BACKGROUND" }
const LANE_LABEL = { drafts: "Drafts & coaching", background: "Background jobs" }

function apiKeyFor(lane) {
  const raw = process.env[LANE_KEY_ENV[lane]] || process.env.ANTHROPIC_API_KEY || ""
  return raw.trim().replace(/^(['"])(.*)\1$/, "$2") || undefined
}

function costUsd(model, usage) {
  const p = PRICES[model]
  if (!p || !usage) return p ? 0 : null
  const n = (v) => (typeof v === "number" && v > 0 ? v : 0)
  return (n(usage.input_tokens) * p.input + n(usage.output_tokens) * p.output +
    n(usage.cache_read_input_tokens) * p.cacheRead + n(usage.cache_creation_input_tokens) * p.cacheWrite) / 1_000_000
}

function isBillingError(e) {
  const status = e && e.status
  const msg = e instanceof Error ? e.message : String(e == null ? "" : e)
  if (!/credit balance|spend(ing)? limit|usage limit|billing|insufficient (funds|credit)|budget/i.test(msg)) return false
  return status === undefined || status === 400 || status === 402 || status === 403 || status === 429
}

let db = null
function usageDb() {
  if (db) return db
  const url = process.env.LRG_SUPABASE_URL
  const key = (process.env.LRG_SUPABASE_SERVICE_KEY || "").replace(/^(['"])(.*)\1$/, "$2")
  if (!url || !key) return null
  const { createClient } = require("@supabase/supabase-js")
  db = createClient(url, key, { auth: { persistSession: false } })
  return db
}

async function telegram(text) {
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

async function alertBilling(sb, lane, message) {
  const since = new Date(Date.now() - 6 * 3600_000).toISOString()
  const { data } = await sb.from("llm_usage").select("id").eq("lane", lane).eq("error_kind", "billing").gte("created_at", since).limit(1)
  if (data && data.length) return
  const esc = (s) => String(s).replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"))
  await telegram(
    `⚠️ <b>${LANE_LABEL[lane]} key was refused by Anthropic</b> — out of credit or over its spending limit.\n` +
    `${lane === "drafts" ? "Drafts, the coach and call scripts" : "Background jobs (judge, inbox, triage, call notes)"} will fail until funds are added in the Console.\n\n` +
    `<i>${esc(message).slice(0, 300)}</i>`,
  )
}

/** One row per model call. Never throws, never waits more than 4 s. */
async function recordUsage({ lane = "background", model, tag, usage, error }) {
  const sb = usageDb()
  if (!sb) return
  const work = (async () => {
    const failed = error !== undefined
    const billing = failed && isBillingError(error)
    const errMsg = failed ? (error instanceof Error ? error.message : String(error)) : null
    if (billing) await alertBilling(sb, lane, errMsg || "")
    const u = usage || {}
    const cost = costUsd(model, usage)
    const { error: insErr } = await sb.from("llm_usage").insert({
      lane, model, tag, source: "mini",
      input_tokens: u.input_tokens || 0,
      output_tokens: u.output_tokens || 0,
      cache_read_tokens: u.cache_read_input_tokens || 0,
      cache_write_tokens: u.cache_creation_input_tokens || 0,
      cost_usd: cost || 0,
      ok: !failed,
      error_kind: failed ? (billing ? "billing" : "error") : null,
      error: errMsg ? errMsg.slice(0, 500) : null,
    })
    if (insErr) console.warn(`[llm-usage] insert failed: ${insErr.message}`)
    if (cost === null) console.warn(`[llm-usage] no price on file for ${model} — add it to config/llm-prices.json`)
  })()
  await Promise.race([
    work.catch((e) => console.warn("[llm-usage] threw:", e && e.message ? e.message : String(e))),
    new Promise((r) => setTimeout(r, 4000)),
  ])
}

/** Anthropic SDK client on the lane's key whose messages.create records
 *  usage. A per-call `__tag` in the params overrides the client's tag and is
 *  stripped before the request goes out. */
function anthropicClient({ tag = "[llm]", lane = "background" } = {}) {
  const mod = require("@anthropic-ai/sdk")
  const Anthropic = mod.Anthropic || mod.default || mod
  const client = new Anthropic({ apiKey: apiKeyFor(lane) })
  const create = client.messages.create.bind(client.messages)
  client.messages.create = async (params, options) => {
    const { __tag, ...body } = params || {}
    if (body.stream) return create(body, options)
    const t = __tag || tag
    try {
      const res = await create(body, options)
      await recordUsage({ lane, model: body.model, tag: t, usage: res && res.usage })
      return res
    } catch (e) {
      await recordUsage({ lane, model: body.model, tag: t, error: e })
      throw e
    }
  }
  return client
}

module.exports = { anthropicClient, recordUsage, costUsd, isBillingError, apiKeyFor, PRICES }
