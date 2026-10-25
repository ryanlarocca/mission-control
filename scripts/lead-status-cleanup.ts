// One-time cleanup of the people sitting on Active before automatic status
// is switched on (Ryan 2026-10-24: approve the list first). Runs the same
// rules prod will run — Opus reads each person's history, plus the 30-day
// quiet rule — and writes a proposal list. Nothing changes without --apply.
//
//   npx tsx scripts/lead-status-cleanup.ts                 # proposals → /tmp/lead-status-cleanup.json + .md
//   npx tsx scripts/lead-status-cleanup.ts --apply         # apply the saved proposals (after Ryan's OK)
//   npx tsx scripts/lead-status-cleanup.ts --apply --skip=<leadId>,<leadId>   # minus the ones he vetoed
import { readFileSync, writeFileSync } from "node:fs"
import type { LeadStatus } from "@/lib/leads"
import type { AutoRule } from "@/lib/leadStatus"

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) {
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    process.env[m[1]] = v
  }
}

const OUT_JSON = "/tmp/lead-status-cleanup.json"
const OUT_MD = "/tmp/lead-status-cleanup.md"

interface Proposal { leadId: string; who: string; property: string | null; from: string; to: string; rule: string; reason: string }

async function main() {
  const { getLeadsClient, fetchClusterHistory } = await import("@/lib/leads")
  const L = await import("@/lib/leadStatus")
  const sb = getLeadsClient()
  const apply = process.argv.includes("--apply")
  const skip = new Set((process.argv.find((a) => a.startsWith("--skip=")) ?? "").slice(7).split(",").filter(Boolean))

  if (apply) {
    const proposals = JSON.parse(readFileSync(OUT_JSON, "utf8")) as Proposal[]
    let n = 0
    for (const p of proposals) {
      if (skip.has(p.leadId)) continue
      const { data: row } = await sb.from("leads").select("id, caller_phone, email, gmail_thread_id").eq("id", p.leadId).maybeSingle()
      if (!row) continue
      const rows = await L.fetchClusterRows(sb, row)
      const anchor = L.statusAnchor(rows)
      if (!anchor || anchor.status !== p.from) { console.log(`skip ${p.who}: status is now ${anchor?.status}`); continue }
      const evId = await L.applyStatusChange(sb, { rows, anchor, to: p.to as LeadStatus, source: "auto", rule: p.rule as AutoRule, reason: `cleanup: ${p.reason}` })
      // Ryan approved this list by hand — don't repeat it in tomorrow's summary.
      if (evId) await sb.from("lead_status_events").update({ digested_at: new Date().toISOString() }).eq("id", evId)
      n++
      console.log(`✓ ${p.who}: ${p.from} → ${p.to}`)
    }
    console.log(`applied ${n}`)
    return
  }

  const actives: { id: string; caller_phone: string | null; email: string | null; gmail_thread_id: string | null }[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("leads").select("id, caller_phone, email, gmail_thread_id").eq("status", "active").order("id").range(from, from + 999)
    if (error) throw new Error(error.message)
    actives.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  const seen = new Set<string>()
  const proposals: Proposal[] = []
  const keep: string[] = []
  for (const a of actives) {
    const rows = await L.fetchClusterRows(sb, a)
    const anchor = L.statusAnchor(rows)
    if (!anchor || seen.has(anchor.id) || anchor.status !== "active") continue
    seen.add(anchor.id)
    const who = rows.map((r) => r.name).reverse().find((n) => n && n.trim()) ?? anchor.caller_phone ?? anchor.email ?? anchor.id
    const { data: prop } = await sb.from("leads").select("property_address").in("id", rows.map((r) => r.id)).not("property_address", "is", null).limit(1)
    const property = (prop?.[0]?.property_address as string | undefined) ?? null
    const facts = L.clusterFacts(rows, anchor)
    // Today's hand-set Active is pre-history (status_set_by is new), so the
    // cleanup judges everyone; Ryan reviews the list anyway.
    const f = { ...facts, ryanSetAt: null }
    const history = await fetchClusterHistory(sb, { callerPhone: anchor.caller_phone, email: anchor.email })
    const judged = history ? await L.judgeLeadStage(history) : null
    const stageMove = judged ? L.decideStageMove(f, judged.stage) : null
    const quiet = L.decideQuietMove(rows, f, Date.now())
    const move = stageMove ?? (quiet ? { to: quiet.to, rule: quiet.rule } : null)
    if (move) {
      const reason = stageMove ? judged!.reason : `No reply for ${Math.floor((Date.now() - quiet!.since) / 86_400_000)} days after Ryan reached out`
      proposals.push({ leadId: anchor.id, who: String(who), property, from: anchor.status, to: move.to, rule: move.rule, reason })
      console.log(`→ ${who}: ${move.to} (${move.rule}) — ${reason}`)
    } else {
      keep.push(`${who}${property ? ` (${property})` : ""} — ${judged ? judged.reason : "no history to read"}`)
      console.log(`= ${who}: stays Active`)
    }
  }
  writeFileSync(OUT_JSON, JSON.stringify(proposals, null, 2))
  const md = [
    `# Active list cleanup — ${new Date().toISOString().slice(0, 10)}`,
    "",
    `${seen.size} people on Active. ${proposals.length} proposed moves, ${keep.length} stay Active.`,
    "",
    "## Proposed moves",
    ...proposals.map((p, i) => `${i + 1}. **${p.who}**${p.property ? ` (${p.property})` : ""} → **${p.to}** — ${p.reason}`),
    "",
    "## Stay Active",
    ...keep.map((k) => `- ${k}`),
  ].join("\n")
  writeFileSync(OUT_MD, md)
  console.log(`\nwrote ${OUT_JSON} and ${OUT_MD}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
