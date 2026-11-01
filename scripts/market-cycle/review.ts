// Market-cycle review (briefs/BRIEF_MARKET_CYCLE_TRACKER_2026-11-01.md §3.3-3.6).
// Dry by default: prints the vote tally, the card and the rows it WOULD
// write. Reads .env.local like the other scripts.
//
//   npx tsx scripts/market-cycle/review.ts --kind shakedown --fixture tests/fixtures/market-cycle/readings-2026-11.json
//       → dry run on a fixture, stub proposal (no model call)
//   npx tsx scripts/market-cycle/review.ts --dry-run --llm
//       → dry run on Supabase data WITH one real Opus call (+1 retry if it breaks a rule)
//   npx tsx scripts/market-cycle/review.ts --check --write --send
//       → the daily launchd job: runs only when a checkpoint is due or a
//         tripwire is pending; writes the rows and posts the card
//
// Flags: --check · --kind shakedown|monthly|quarterly|tripwire · --today YYYY-MM-DD
//        --dry-run (default) · --fixture <path> · --llm · --write · --send

import { readFileSync } from "node:fs"
import path from "node:path"

const ENV_PATH = path.join(process.cwd(), ".env.local")
try {
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!m || process.env[m[1]] !== undefined) continue
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    process.env[m[1]] = v
  }
} catch {
  /* no .env.local — rely on the environment */
}

type Kind = "shakedown" | "monthly" | "quarterly" | "tripwire"
const KINDS: Kind[] = ["shakedown", "monthly", "quarterly", "tripwire"]

function parseArgs(argv: string[]) {
  const a = { check: false, kind: undefined as Kind | undefined, today: undefined as string | undefined, dryRunFlag: false, fixture: undefined as string | undefined, llm: false, write: false, send: false }
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i]
    if (f === "--check") a.check = true
    else if (f === "--dry-run") a.dryRunFlag = true
    else if (f === "--llm") a.llm = true
    else if (f === "--write") a.write = true
    else if (f === "--send") a.send = true
    else if (f === "--kind") {
      const k = argv[++i] as Kind
      if (!KINDS.includes(k)) throw new Error(`--kind must be one of ${KINDS.join("|")}`)
      a.kind = k
    } else if (f === "--today") {
      a.today = argv[++i]
      if (!/^\d{4}-\d{2}-\d{2}$/.test(a.today ?? "")) throw new Error("--today must be YYYY-MM-DD")
    } else if (f === "--fixture") a.fixture = argv[++i]
    else throw new Error(`unknown flag ${f}`)
  }
  return a
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  // Dry unless --write is given (and never when --dry-run is explicit).
  const dryRun = args.dryRunFlag || !args.write
  if (args.send && dryRun) throw new Error("--send needs --write (the card's Disagree button points at the stored checkpoint row)")
  if (args.fixture && !dryRun) throw new Error("--fixture is dry-run only — fixture data never goes to Supabase")

  const { runReview, sendCardToTelegram } = await import("@/lib/marketCycle/review")
  const { loadFromSupabase, stateFromFixture, supabaseWriter } = await import("@/lib/marketCycle/data")
  const { formatValue } = await import("@/lib/marketCycle/votes")

  const needDb = !args.fixture
  const sb = needDb ? (await import("@/lib/leads")).getLeadsClient() : null
  const loadState = args.fixture
    ? async () => stateFromFixture(JSON.parse(readFileSync(path.resolve(args.fixture as string), "utf8")), args.today)
    : async () => loadFromSupabase(sb!, args.today)

  const useModel = !dryRun || args.llm
  const callModel = useModel
    ? async (system: string, prompt: string) => {
        const { completeText, OPUS } = await import("@/lib/llm")
        const out = await completeText({ model: OPUS, system, prompt, maxTokens: 16_000, effort: "high", tag: "[market-cycle]" })
        if (out.truncated) throw new Error("model response truncated")
        return out.text
      }
    : undefined

  const res = await runReview(
    { dryRun, kind: args.kind, today: args.today, check: args.check, llm: args.llm, log: (l) => console.log(`· ${l}`) },
    {
      loadState,
      callModel,
      writer: !dryRun && sb ? supabaseWriter(sb) : undefined,
      sendCard: args.send ? sendCardToTelegram : undefined,
    },
  )

  const mode = dryRun ? `DRY RUN${args.llm ? " + real model call" : " (stub proposal, no model call)"}` : `LIVE${args.send ? " write + send" : " write only"}`
  console.log(`\n=== market-cycle review — ${mode}${args.fixture ? ` — fixture ${args.fixture}` : ""}`)
  console.log(`due: ${res.due.due} (${res.due.reason})`)
  if (res.skipped) {
    console.log("nothing due — exiting.")
    return
  }
  console.log(`kind: ${res.kind}`)

  console.log("\n--- votes")
  const t = res.tally!
  console.log(`totals: bear ${t.totals.bear} · base ${t.totals.base} · bull ${t.totals.bull} · unexplained ${t.totals.unexplained} · none ${t.totals.none}`)
  for (const [cat, v] of Object.entries(t.byCategory)) {
    console.log(`  ${cat.padEnd(14)} bear [${v.bear.join(", ")}] base [${v.base.join(", ")}] bull [${v.bull.join(", ")}] unexplained [${v.unexplained.join(", ")}]`)
  }
  const show = res.votes.filter((v) => v.reading !== null && (v.vote !== "none" || v.outside !== null))
  for (const v of show) console.log(`  ${v.vote.padEnd(11)} ${v.dial_id.padEnd(32)} ${formatValue(v.reading!.value).padStart(8)} @ ${v.reading!.as_of}  band ${v.band}${v.z !== null ? `  z=${v.z}` : ""} — ${v.reason}`)
  const inBand = res.votes.filter((v) => v.reading && v.vote === "none" && v.outside === null)
  for (const v of inBand) console.log(`  ${"none".padEnd(11)} ${v.dial_id.padEnd(32)} ${formatValue(v.reading!.value).padStart(8)} @ ${v.reading!.as_of}  — ${v.reason}`)

  console.log(`\n--- proposal (${res.proposalSource})`)
  if (res.modelRaw.length) res.modelRaw.forEach((r, i) => console.log(`model reply #${i + 1}:\n${r}\n`))
  console.log(JSON.stringify(res.proposal, null, 2))
  console.log("\n--- rules verdict")
  console.log(JSON.stringify({ ok: res.verdict!.ok, weights: res.verdict!.weights, moved: res.verdict!.moved, direction: res.verdict!.direction, cap: res.verdict!.cap, violations: res.verdict!.violations, adjustments: res.verdict!.adjustments }, null, 2))

  console.log("\n--- card (Telegram HTML)")
  console.log(res.card!.text)
  console.log(`[lines: ${res.card!.text.split("\n").length}] buttons: ${JSON.stringify(res.card!.buttons)}`)

  console.log(`\n--- ${dryRun ? "would-be rows" : "rows written"}`)
  console.log(JSON.stringify(res.rows, null, 2))
  if (!dryRun) console.log(`\ncheckpoint ${res.checkpointId} · telegram message ${res.telegramMessageId ?? "(not sent)"}`)
}

main().catch(async (e) => {
  const msg = e instanceof Error ? e.message : String(e)
  console.error(`[market-cycle] review failed: ${msg}`)
  // Silent failures must alert Telegram — but only from the live job.
  if (process.argv.includes("--send")) {
    try {
      const { sendTelegramAlert } = await import("@/lib/leads")
      await sendTelegramAlert(`⚠️ Market-cycle review failed: ${msg.replace(/[<>&]/g, "")}`)
    } catch {
      /* best effort */
    }
  }
  process.exit(1)
})
