// Coach mode dry run (briefs/BRIEF_COACHED_DRAFT_2026-10-15.md §G).
//
//   npx tsx scripts/reply-coach-dryrun.ts <leadId> "<gist>"
//   npx tsx scripts/reply-coach-dryrun.ts b6a07bb7-d478-4646-9090-19794e821cd4 \
//     "I'm at 950, renovated comps 1.2 to 1.3, he's at 1.6, keep the door open"
//
// Runs coachDraft against a real lead and prints the read + the body (and
// the plan, the critic verdict, the exemplar count, the prompt size).
// Reads .env.local for the Supabase + Anthropic keys the way the other
// scripts do. It SENDS NOTHING, records NO reply_drafts row and does NOT
// stamp leads.moment — paste the output into the PR.
//
// Options:
//   --channel=email|sms   (default: the lead's inbound channel, else sms)
//   --refine="shorter"    one refinement turn on top of the first draft
//   --prompt              also print the assembled prompt (long)

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
  console.warn(`(no ${ENV_PATH} — relying on the environment)`)
}

async function main() {
  const args = process.argv.slice(2)
  const flags: Record<string, string | true> = {}
  const positional: string[] = []
  for (const a of args) {
    const m = a.match(/^--([a-z]+)(?:=(.*))?$/)
    if (m) flags[m[1]] = m[2] ?? true
    else positional.push(a)
  }
  const [leadId, gist] = positional
  if (!leadId || !gist) {
    console.error('usage: npx tsx scripts/reply-coach-dryrun.ts <leadId> "<gist>" [--channel=email|sms] [--refine="shorter"] [--prompt]')
    process.exit(2)
  }
  if (!process.env.ANTHROPIC_API_KEY) { console.error("ANTHROPIC_API_KEY missing"); process.exit(2) }

  // Imported after the env is loaded: lib/leads reads its keys at call time,
  // but keep the order obvious.
  const { buildLeadContext, formatThread, describeContact } = await import("@/lib/reply/context")
  const { coachDraft, buildCoachPrompt } = await import("@/lib/reply/coach")
  const { proposePlan } = await import("@/lib/reply/plan")
  const { loadPlaybook, principlesFor } = await import("@/lib/reply/playbook")
  const { loadExemplars, formatExemplars } = await import("@/lib/reply/exemplars")

  const ctx = await buildLeadContext(leadId)
  if (!ctx) { console.error(`lead ${leadId} not found`); process.exit(1) }
  const channel: "email" | "sms" = flags.channel === "email" ? "email" : flags.channel === "sms" ? "sms" : ctx.inboundChannel === "email" ? "email" : "sms"

  const callItems = ctx.thread.filter((t) => t.from === "call")
  console.log(`\n== ${ctx.name || "(no name)"} · ${ctx.property_address || "(no address)"} · channel ${channel}`)
  console.log(`thread items: ${ctx.thread.length} (${callItems.length} call transcript(s), longest ${Math.max(0, ...callItems.map((t) => t.text.length))} chars) · thread chars: ${ctx.thread.reduce((n, t) => n + t.text.length, 0)}`)
  console.log(`\n-- contact block --\n${describeContact(ctx)}`)

  const plan = await proposePlan(ctx)
  if (!plan) { console.error("plan unavailable"); process.exit(1) }
  console.log(`\n-- plan -- ${plan.moment} · ${plan.temperature ?? "-"} · ${plan.next_action} · ${plan.reason}`)

  if (flags.prompt) {
    const pb = loadPlaybook()
    const exemplars = await loadExemplars({ moment: plan.moment, channel, surface: "leads", excludeLeadId: ctx.leadId })
    const prompt = buildCoachPrompt({ ctx, plan, channel, gist, turns: [], principles: principlesFor(pb, plan.moment), exemplarText: formatExemplars(exemplars), today: new Date().toISOString().slice(0, 10) })
    console.log(`\n-- prompt (${prompt.length} chars) --\n${prompt}`)
  } else {
    console.log(`\n-- thread as the coach sees it (${formatThread(ctx, ctx.thread.length).length} chars) --`)
  }

  const t0 = Date.now()
  const out = await coachDraft({ ctx, channel, surface: "eval", gist, plan, skipRecord: true, skipStamp: true })
  if (!out) { console.error("coach returned null"); process.exit(1) }
  console.log(`\n== READ (${Date.now() - t0} ms, ${out.exemplarCount} exemplar(s), playbook ${out.playbookVersion})\n${out.read}`)
  if (out.subject) console.log(`\n== SUBJECT\n${out.subject}`)
  console.log(`\n== BODY\n${out.body}`)
  console.log(`\n-- critic -- ${out.critic ? `${out.critic.ok ? "ok" : "rewritten"}${out.critic.issues.length ? `: ${out.critic.issues.join("; ")}` : ""}` : "skipped"}`)

  const checks = [
    ["mentions the $1.6M floor", /1\.6\s*(m|million)|1,600,000/i.test(out.read + "\n" + out.body)],
    ["mentions the promised text / number", /promis|text(ed)? (him|you|a number)|owe/i.test(out.read)],
    ["read mentions the Offer 1.1 history", /1\.1|1,100,000/.test(out.read)],
    ["body has no bracketed placeholder", !/\[[A-Z][A-Z ]+\]/.test(out.body)],
  ] as const
  console.log("\n-- checks --")
  for (const [label, ok] of checks) console.log(`${ok ? "✓" : "✗"} ${label}`)

  if (typeof flags.refine === "string" && flags.refine.trim()) {
    const t1 = Date.now()
    const two = await coachDraft({ ctx, channel, surface: "eval", gist: flags.refine, turns: [{ gist, body: out.body }], plan, skipRecord: true, skipStamp: true })
    if (!two) { console.error("refine returned null"); process.exit(1) }
    console.log(`\n== REFINED "${flags.refine}" (${Date.now() - t1} ms)\n-- read --\n${two.read}\n-- body --\n${two.body}`)
  }
  console.log("\n(dry run: nothing sent, nothing recorded, moment not stamped)")
}

main().catch((e) => { console.error(e); process.exit(1) })
