import { describe, it, expect, afterEach } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { costUsd, isBillingError, apiKeyFor } from "@/lib/llmUsage"

// 2026-11-07 API cost audit: two Console keys by job, one llm_usage row per
// call, and the drip engine never pays for a draft it can't send.
const require = createRequire(import.meta.url)
const mini = require("../scripts/llm-usage.cjs")
const ROOT = path.resolve(__dirname, "..")
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8")

describe("pricing", () => {
  const usage = { input_tokens: 10_000, output_tokens: 2_000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 4_000 }

  it("prices Opus 5.5 and Sonnet 5 from the list prices", () => {
    // 10k×$4 + 2k×$20 + 50k×$0.20 + 4k×$5 per million
    expect(costUsd("claude-opus-5-5", usage)).toBeCloseTo(0.04 + 0.04 + 0.01 + 0.02, 6)
    // 10k×$2 + 2k×$10 + 50k×$0.20 + 4k×$2.50 per million
    expect(costUsd("claude-sonnet-5", usage)).toBeCloseTo(0.02 + 0.02 + 0.01 + 0.01, 6)
  })

  it("the Mac mini helper prices a call exactly like the app", () => {
    for (const model of ["claude-opus-5-5", "claude-sonnet-5"]) {
      expect(mini.costUsd(model, usage)).toBeCloseTo(costUsd(model, usage) as number, 9)
    }
  })

  it("returns null for a model with no price, so the gap gets logged", () => {
    expect(costUsd("claude-unknown-1", usage)).toBeNull()
    expect(mini.costUsd("claude-unknown-1", usage)).toBeNull()
  })

  it("every model the code calls has a price on file", () => {
    const prices = JSON.parse(read("config/llm-prices.json")) as Record<string, unknown>
    const used = new Set<string>()
    const walk = (dir: string) => {
      for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name)
        if (e.isDirectory()) { if (!/^(_archive|archive|node_modules|__pycache__)$/.test(e.name)) walk(rel); continue }
        if (!/\.(ts|tsx|js|mjs|cjs)$/.test(e.name)) continue
        for (const m of Array.from(read(rel).matchAll(/["'](claude-(?:opus|sonnet|fable)-[0-9a-z-]+)["']/g))) used.add(m[1])
      }
    }
    for (const d of ["lib", "app", "scripts"]) walk(d)
    for (const model of Array.from(used)) expect(prices, `add ${model} to config/llm-prices.json`).toHaveProperty(model)
  })
})

describe("billing refusals", () => {
  const apiErr = (status: number, message: string) => Object.assign(new Error(message), { status })

  it("flags credit and spend-limit refusals", () => {
    const credit = apiErr(400, "400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"Your credit balance is too low to access the Anthropic API.\"}}")
    expect(isBillingError(credit)).toBe(true)
    expect(isBillingError(apiErr(429, "You have reached your specified workspace spend limit"))).toBe(true)
    expect(mini.isBillingError(credit)).toBe(true)
  })

  it("does not flag ordinary rate limits or bad requests", () => {
    expect(isBillingError(apiErr(429, "Number of request tokens has exceeded your per-minute rate limit"))).toBe(false)
    expect(isBillingError(apiErr(400, "max_tokens: must be at most 128000"))).toBe(false)
    expect(isBillingError(apiErr(529, "Overloaded"))).toBe(false)
  })
})

describe("keys by lane", () => {
  const saved = { ...process.env }
  afterEach(() => { process.env = { ...saved } })

  it("uses the lane key, falling back to the old ANTHROPIC_API_KEY", () => {
    process.env.ANTHROPIC_API_KEY = "old"
    process.env.ANTHROPIC_API_KEY_DRAFTS = "drafts-key"
    delete process.env.ANTHROPIC_API_KEY_BACKGROUND
    expect(apiKeyFor("drafts")).toBe("drafts-key")
    expect(apiKeyFor("background")).toBe("old")
    expect(mini.apiKeyFor("background")).toBe("old")
  })

  it("every model call in lib/reply and lib/coach bills the drafts key", () => {
    for (const f of ["lib/reply/coach.ts", "lib/reply/plan.ts", "lib/reply/facts.ts", "lib/reply/critic.ts", "lib/coach/rate.ts", "lib/coach/script.ts"]) {
      const calls = read(f).split("completeText({").slice(1).map((c) => c.slice(0, 600))
      expect(calls.length, f).toBeGreaterThan(0)
      for (const c of calls) expect(c, f).toMatch(/lane: "drafts"/)
    }
  })

  it("no script builds a bare SDK client that skips the usage log", () => {
    for (const f of ["scripts/judge.js", "scripts/drip-engine.js", "scripts/inbox-agent/llm.mjs", "scripts/reply-review.mjs", "scripts/campaign-compose.mjs", "lib/llm.ts"]) {
      expect(read(f), f).not.toMatch(/new Anthropic\(\)/)
    }
  })
})

describe("drip engine: cheap checks before the writer", () => {
  process.env.DRIP_REGEN_SKIP_MAIN = "1"
  const drip = require("../scripts/drip-engine.js")

  it("names why a touch can't go out", () => {
    expect(drip.cannotSendOn("email", { email: null, caller_phone: "+14085551234" })).toBe("channel_email_no_address")
    expect(drip.cannotSendOn("imessage", { email: "a@b.co", caller_phone: null })).toBe("channel_imessage_no_phone")
    expect(drip.cannotSendOn("email", { email: "a@b.co" })).toBeNull()
  })

  it("checks the channel before any model call (72 thrown-away Opus drafts a day, 2026-11-07)", () => {
    const src = read("scripts/drip-engine.js")
    const guard = src.indexOf("cannotSendOn(activeChannel, lead)")
    expect(guard).toBeGreaterThan(0)
    expect(guard).toBeLessThan(src.indexOf("await writeTouchWithOpus(genArgs)"))
    expect(guard).toBeLessThan(src.indexOf("await generateMessage(genArgs)"))
  })
})

describe("spend report", async () => {
  const report = await import("../scripts/llm-spend-report.mjs")

  it("rolls features up under plain names", () => {
    const s = report.summarize([
      { lane: "drafts", tag: "[reply/auto]", model: "claude-opus-5-5", calls: 10, failures: 0, cost_usd: "1.50", input_tokens: 1000, output_tokens: 0, cache_read_tokens: 1000, cache_write_tokens: 0 },
      { lane: "drafts", tag: "[reply/critic]", model: "claude-sonnet-5", calls: 10, failures: 1, cost_usd: "0.10", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
      { lane: "background", tag: "[classify]", model: "claude-sonnet-5", calls: 4, failures: 0, cost_usd: "0.20", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    ])
    expect(s.total).toBeCloseTo(1.8, 6)
    expect(s.lanes.drafts).toBeCloseTo(1.6, 6)
    expect(s.failures).toBe(1)
    expect(s.top[0][0]).toBe("Auto drafts")
    expect(report.featureName("[classify]")).toBe("Inbox agent")
    expect(report.featureName("[drip/critic]")).toBe("Drip engine")
    const text = report.dailyText("2026-11-08", s)
    expect(text).toContain("Sun, Nov 8, 2026")
    expect(text).toContain("Read from cache: 50%")
  })

  it("uses Pacific midnight for day boundaries, across the DST change", () => {
    expect(report.pacificMidnight("2026-10-31").toISOString()).toBe("2026-10-31T07:00:00.000Z") // PDT
    expect(report.pacificMidnight("2026-11-07").toISOString()).toBe("2026-11-07T08:00:00.000Z") // PST (DST ended Nov 1)
    expect(report.addDays("2026-11-30", 1)).toBe("2026-12-01")
  })
})
