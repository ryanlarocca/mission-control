#!/usr/bin/env node
// Run the Reply Planner over the graded eval set and write a side-by-side
// report. Drives POST /api/reply/eval on a running Mission Control (local
// dev server by default) so the exact production code path is exercised.
//
//   node scripts/reply-eval.mjs                 # all items, propose plans
//   node scripts/reply-eval.mjs --no-plan       # use each item's known moment
//   node scripts/reply-eval.mjs --ids soft_no:Dennis_Connally:2026-05-11,...
//   MC_URL=https://mission-control-three-chi.vercel.app node scripts/reply-eval.mjs
//
// Output: briefs/tests/reply-eval-run-<date>.md (+ .json). Auth: MC_PASSWORD
// from .env.local via POST /api/auth (see memory: local auth testing).
import { readFileSync, writeFileSync } from "node:fs"

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) {
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    process.env[m[1]] = v
  }
}
const base = (process.env.MC_URL || "http://localhost:3000").replace(/\/+$/, "")
const args = process.argv.slice(2)
const noPlan = args.includes("--no-plan")
const idsArg = args[args.indexOf("--ids") + 1]
const ids = args.includes("--ids") && idsArg ? idsArg.split(",") : null

const auth = await fetch(`${base}/api/auth`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: process.env.MC_PASSWORD }) })
if (!auth.ok) { console.error("auth failed", auth.status, await auth.text()); process.exit(1) }
const cookie = (auth.headers.get("set-cookie") || "").split(";")[0]

const t0 = Date.now()
const res = await fetch(`${base}/api/reply/eval`, { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ ids, plan: !noPlan }) })
if (!res.ok) { console.error("eval failed", res.status, await res.text()); process.exit(1) }
const out = await res.json()
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")
writeFileSync(new URL(`../briefs/tests/reply-eval-run-${stamp}.json`, import.meta.url), JSON.stringify(out, null, 2))

let md = `# Reply eval run — ${new Date().toISOString().slice(0, 16)}\n\nplaybook ${out.playbook_version} · ${out.count} items · ${((Date.now() - t0) / 1000).toFixed(0)}s · plan ${noPlan ? "from item" : "proposed"}\n\n`
let planHits = 0, criticRewrites = 0
for (const r of out.results) {
  if (r.plan_matches) planHits++
  if (r.draft?.critic?.rewritten) criticRewrites++
  md += `---\n\n## ${r.id}\n\n`
  md += `Plan: **${r.plan.moment}**${r.plan.temperature ? ` · ${r.plan.temperature}` : ""} · ${r.plan.next_action}${r.plan_matches ? "" : `  ⚠️ expected ${r.moment_expected}`}  \n`
  if (r.plan.reason) md += `Reason: ${r.plan.reason}  \n`
  if (r.grade) md += `Ryan's grade on the reference: **${r.grade}**${r.why ? ` — ${r.why}` : ""}  \n`
  md += `\n**New draft**${r.draft?.critic?.rewritten ? ` (critic rewrote: ${r.draft.critic.issues.join("; ")})` : ""}\n\n`
  md += r.draft ? `> ${r.draft.subject ? `Subject: ${r.draft.subject}\n> \n> ` : ""}${r.draft.body.replace(/\n/g, "\n> ")}\n\n` : `> (draft failed)\n\n`
  md += `**Reference** (what Ryan sent / agreed)\n\n> ${(r.reference || "(none)").replace(/\n/g, "\n> ")}\n\n`
}
md = md.replace("\n\n---", `\nPlan matched the expected moment on ${planHits}/${out.count}. Critic rewrote ${criticRewrites}.\n\n---`)
const mdPath = new URL(`../briefs/tests/reply-eval-run-${stamp}.md`, import.meta.url)
writeFileSync(mdPath, md)
console.log(`wrote ${mdPath.pathname}`)
console.log(`plan matched ${planHits}/${out.count}; critic rewrote ${criticRewrites}`)
