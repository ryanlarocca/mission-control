#!/usr/bin/env node
// Reply Planner Phase 6 — the weekly review (briefs/BRIEF_REPLY_PLANNER_2026-09-24.md).
//
//   node scripts/reply-review.mjs            # report + Telegram summary, marks whys reviewed
//   node scripts/reply-review.mjs --dry-run  # report only, nothing marked, no Telegram
//
// 1. Scoreboard: share of drafts sent untouched, per surface × moment
//    (last 7 days and all-time) — the one production number.
// 2. New whys since the last review, grouped by moment.
// 3. Candidate principles: Haiku clusters each moment's whys into themes;
//    a theme with ≥3 whys is proposed. Nothing is written to the playbook —
//    the agent brings candidates to Ryan and edits REPLY_PLAYBOOK.md on his yes.
// Output: briefs/tests/reply-review-<date>.md + a Telegram summary.
import { createClient } from "@supabase/supabase-js"
import Anthropic from "@anthropic-ai/sdk"
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
const DRY = process.argv.includes("--dry-run")
const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY)
const today = new Date().toISOString().slice(0, 10)
const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString()

async function all(q) {
  const rows = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q.range(from, from + 999)
    if (error) throw error
    rows.push(...data)
    if (data.length < 1000) break
  }
  return rows
}

// ── 1. scoreboard ──────────────────────────────────────────────────────────
const sent = await all(sb.from("reply_drafts").select("surface, moment, sent_at, was_edited, why_text, parent_draft_id, created_at").not("sent_at", "is", null).neq("surface", "eval").order("sent_at", { ascending: true }))
function score(rows) {
  const by = {}
  for (const r of rows) {
    const k = `${r.surface}|${r.moment || "?"}`
    by[k] ??= { sent: 0, untouched: 0 }
    by[k].sent++
    if (r.was_edited === false) by[k].untouched++
  }
  return by
}
const weekRows = sent.filter((r) => r.sent_at >= weekAgo)
const scoreWeek = score(weekRows), scoreAll = score(sent)
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "–")

// ── 2. new whys ────────────────────────────────────────────────────────────
const whys = await all(sb.from("reply_drafts").select("id, surface, moment, why_text, created_at, lead_id, relationship_id").not("why_text", "is", null).is("reviewed_at", null).neq("surface", "eval").order("created_at", { ascending: true }))
const whysByMoment = {}
for (const w of whys) (whysByMoment[w.moment || "?"] ??= []).push(w)

// ── 3. candidate principles (all unreviewed + reviewed whys per moment, so ≥3 accumulates across weeks) ──
const allWhys = await all(sb.from("reply_drafts").select("moment, why_text, created_at").not("why_text", "is", null).neq("surface", "eval").order("created_at", { ascending: true }))
const allByMoment = {}
for (const w of allWhys) (allByMoment[w.moment || "?"] ??= []).push(w.why_text)
const candidates = []
if (process.env.ANTHROPIC_API_KEY) {
  const client = new Anthropic()
  for (const [moment, list] of Object.entries(allByMoment)) {
    if (list.length < 3) continue
    const prompt = `These are Ryan's one-sentence notes on why an AI-drafted reply was wrong, all for the same kind of moment ("${moment}"). Group them into themes. For each theme give a short name, the count, the indices of the notes in it, and — only when the count is 3 or more — a one-sentence principle, phrased as a rule for how to write (never as an example sentence).

NOTES
${list.map((t, i) => `${i + 1}. ${t}`).join("\n")}

Respond in JSON only: { "themes": [ { "name": "...", "count": n, "indices": [..], "principle": "..." | null } ] }`
    try {
      const res = await client.messages.create({ model: "claude-haiku-4-5", max_tokens: 1200, messages: [{ role: "user", content: prompt }] })
      const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("")
      const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "")
      const parsed = JSON.parse(cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1))
      for (const t of parsed.themes || []) {
        if ((t.count || 0) >= 3 && t.principle) candidates.push({ moment, name: t.name, count: t.count, principle: t.principle, notes: (t.indices || []).map((i) => list[i - 1]).filter(Boolean) })
      }
    } catch (e) {
      console.warn(`[review] theme clustering failed for ${moment}:`, e.message)
    }
  }
}

// ── report ─────────────────────────────────────────────────────────────────
let md = `# Reply review — ${today}\n\n`
md += `## Scoreboard — drafts sent untouched\n\n| surface · moment | last 7d | all-time |\n|---|---|---|\n`
const keys = [...new Set([...Object.keys(scoreAll)])].sort()
for (const k of keys) {
  const w = scoreWeek[k], a = scoreAll[k]
  md += `| ${k.replace("|", " · ")} | ${w ? `${pct(w.untouched, w.sent)} (${w.untouched}/${w.sent})` : "–"} | ${pct(a.untouched, a.sent)} (${a.untouched}/${a.sent}) |\n`
}
const totW = weekRows.length, untW = weekRows.filter((r) => r.was_edited === false).length
const totA = sent.length, untA = sent.filter((r) => r.was_edited === false).length
md += `| **all** | **${pct(untW, totW)} (${untW}/${totW})** | **${pct(untA, totA)} (${untA}/${totA})** |\n\n`
md += `## New whys since the last review (${whys.length})\n\n`
if (!whys.length) md += "(none)\n\n"
for (const [moment, list] of Object.entries(whysByMoment)) {
  md += `### ${moment} (${list.length})\n`
  for (const w of list) md += `- ${w.created_at.slice(0, 10)} · ${w.surface}: "${w.why_text}"\n`
  md += "\n"
}
md += `## Candidate principles (themes with ≥3 whys)\n\n`
if (!candidates.length) md += "(none yet — a principle needs three whys that rhyme)\n\n"
for (const c of candidates) {
  md += `### ${c.moment} — ${c.name} (${c.count})\n**Proposed principle:** ${c.principle}\n\nFrom:\n${c.notes.map((n) => `- "${n}"`).join("\n")}\n\n`
}
md += `Bring candidates to Ryan in one sentence each; on his yes, add the principle to \`briefs/REPLY_PLAYBOOK.md\` (bump \`version\`) and re-run \`scripts/reply-eval.mjs\` before shipping.\n`
const out = new URL(`../briefs/tests/reply-review-${today}.md`, import.meta.url)
writeFileSync(out, md)
console.log(md)
console.log(`wrote ${out.pathname}`)

if (!DRY) {
  if (whys.length) {
    const { error } = await sb.from("reply_drafts").update({ reviewed_at: new Date().toISOString() }).in("id", whys.map((w) => w.id))
    if (error) console.error("[review] mark reviewed failed:", error.message)
  }
  const token = process.env.CAMPAIGN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN
  const chat = process.env.TELEGRAM_CHAT_ID
  if (token && chat) {
    const lines = [
      `📊 Reply Planner — weekly review ${today}`,
      `Sent untouched: ${pct(untW, totW)} this week (${untW}/${totW}) · ${pct(untA, totA)} all-time (${untA}/${totA})`,
      `New whys: ${whys.length}${whys.length ? " — " + Object.entries(whysByMoment).map(([m, l]) => `${m} ${l.length}`).join(", ") : ""}`,
      candidates.length ? `Candidate principles: ${candidates.length} — ${candidates.map((c) => `${c.moment}: ${c.name}`).join("; ")}. I'll bring them to you one sentence each.` : "Candidate principles: none yet (needs 3 whys that rhyme).",
    ]
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat, text: lines.join("\n") }) }).catch((e) => console.error("[review] telegram failed:", e.message))
  }
}
