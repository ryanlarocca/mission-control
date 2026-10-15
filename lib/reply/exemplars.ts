// Ryan's own past replies for the same moment — the register the drafter
// matches. Two sources: reply_drafts rows that were actually sent (the
// live loop) and, for cold start, the graded eval set in
// briefs/tests/reply-eval-set.json (items Ryan marked "keep", or ungraded
// items whose reference is something he really sent).

import { readFileSync } from "node:fs"
import path from "node:path"
import { getLeadsClient } from "@/lib/leads"

export interface Exemplar {
  moment: string
  channel: string | null
  inbound: string | null
  reply: string
  source: "sent" | "eval"
  // Coached send (mode = 'coach'): the gist Ryan gave. Rendered with the
  // reply so the register example carries the intent (brief §F1).
  gist?: string | null
}

/** A reply_drafts row that was actually sent, as the ranking needs it. */
export interface SentDraftRow {
  moment: string | null
  channel: string | null
  sent_body: string | null
  sent_at?: string | null
  lead_id?: string | null
  relationship_id?: string | null
  mode?: string | null
  gist?: string | null
}

/** Coached sends first (same channel before other channels, newest first
 *  within each band), then Auto sends newest first. Dedupes by reply text.
 *  Pure, so the unit test can pin the order. */
export function rankSentExemplars(rows: SentDraftRow[], args: { surface: "leads" | "relationships"; channel: string | null; limit: number }): Exemplar[] {
  const band = (r: SentDraftRow): number => {
    const coached = r.mode === "coach" && !!(r.gist || "").trim()
    if (!coached) return 2
    return !args.channel || r.channel === args.channel ? 0 : 1
  }
  const at = (r: SentDraftRow) => r.sent_at || ""
  const sorted = [...rows].sort((a, b) => band(a) - band(b) || at(b).localeCompare(at(a)))
  const out: Exemplar[] = []
  for (const r of sorted) {
    if (args.surface === "leads" && !r.lead_id) continue
    if (args.surface === "relationships" && !r.relationship_id) continue
    const reply = (r.sent_body || "").trim()
    if (!reply || out.some((o) => o.reply === reply)) continue
    const coached = band(r) < 2
    out.push({ moment: r.moment || "", channel: r.channel, inbound: null, reply, source: "sent", gist: coached ? (r.gist || "").trim() : null })
    if (out.length >= args.limit) break
  }
  return out
}

const EVAL_PATH = path.join(process.cwd(), "briefs", "tests", "reply-eval-set.json")
let evalCache: Exemplar[] | null = null

function evalExemplars(): Exemplar[] {
  if (evalCache) return evalCache
  try {
    const set = JSON.parse(readFileSync(EVAL_PATH, "utf8")) as {
      items: { moment: string; channel: string | null; inbound?: { text: string }; reference_reply: string | null; reference_source: string | null; grade: string | null }[]
    }
    evalCache = set.items
      .filter((it) => it.reference_reply && it.grade !== "skip" && it.grade !== "fix")
      .filter((it) => it.grade === "keep" || it.reference_source === "ryan_sent" || it.reference_source === "ryan_sent_edited" || it.reference_source === "agreed_2026-09-24")
      .map((it) => ({ moment: it.moment, channel: it.channel, inbound: it.inbound?.text ?? null, reply: it.reference_reply!, source: "eval" as const }))
  } catch {
    evalCache = []
  }
  return evalCache
}

export async function loadExemplars(args: {
  moment: string | null
  channel: string | null
  surface: "leads" | "relationships"
  // Relationships: narrow Ryan's edited sends by category (Agent, Vendor…).
  category?: string | null
  excludeLeadId?: string | null
  // Eval runs pass the item's own reference so it can't leak into its exemplars.
  excludeReply?: string | null
  limit?: number
}): Promise<Exemplar[]> {
  const limit = args.limit ?? 5
  let out: Exemplar[] = []
  if (args.moment) {
    const rows: SentDraftRow[] = []
    // Coached sends (brief §F1) rank first. Their own query, so a database
    // that has not had 2026-10-15_reply_drafts_coach.sql applied yet still
    // serves the Auto exemplars below.
    try {
      const sb = getLeadsClient()
      let q = sb
        .from("reply_drafts")
        .select("moment, channel, sent_body, sent_at, lead_id, relationship_id, mode, gist")
        .eq("moment", args.moment)
        .eq("mode", "coach")
        .not("sent_body", "is", null)
        .neq("surface", "eval")
        .order("sent_at", { ascending: false })
        .limit(limit * 2)
      if (args.excludeLeadId) q = q.neq("lead_id", args.excludeLeadId)
      const { data } = await q
      for (const r of (data || []) as SentDraftRow[]) rows.push({ ...r, mode: "coach" })
    } catch { /* column may not exist yet — fall through */ }
    try {
      const sb = getLeadsClient()
      let q = sb
        .from("reply_drafts")
        .select("moment, channel, sent_body, sent_at, lead_id, relationship_id, surface")
        .eq("moment", args.moment)
        .not("sent_body", "is", null)
        .neq("surface", "eval")
        .order("sent_at", { ascending: false })
        .limit(limit * 2)
      if (args.excludeLeadId) q = q.neq("lead_id", args.excludeLeadId)
      const { data } = await q
      for (const r of (data || []) as SentDraftRow[]) {
        // The coached query above already carries these with their gist.
        if (rows.some((c) => (c.sent_body || "").trim() === (r.sent_body || "").trim())) continue
        rows.push({ ...r, mode: "auto" })
      }
    } catch { /* table may be empty / unreachable — fall through */ }
    out = rankSentExemplars(rows, { surface: args.surface, channel: args.channel, limit })
  }
  const norm = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase()
  const excluded = args.excludeReply ? norm(args.excludeReply) : null
  // Relationships: the sends Ryan edited before sending are his register
  // (drafts sent untouched are excluded on purpose — they're the model's
  // voice, not his). Same rule the old /api/crms/generate few-shot used.
  if (args.surface === "relationships" && out.length < limit) {
    try {
      const sb = getLeadsClient()
      let q = sb
        .from("relationship_touches")
        .select("message, generated_message, category_at_touch, modality, occurred_at")
        .eq("action", "sent")
        .not("generated_message", "is", null)
        .neq("generated_message", "")
        .order("occurred_at", { ascending: false })
        .limit(80)
      if (args.category) q = q.eq("category_at_touch", args.category)
      const { data } = await q
      const banned = /fixers?\s+and\s+value-?add|value-?add\s+(deals?|properties)/i
      for (const r of data || []) {
        const sent = (r.message || "").trim()
        if (!sent || sent === (r.generated_message || "").trim()) continue
        if (banned.test(sent) || /\[marked contacted/i.test(sent)) continue
        if (out.some((o) => o.reply === sent)) continue
        out.push({ moment: args.moment || "re_engagement", channel: "imessage", inbound: null, reply: sent, source: "sent" })
        if (out.length >= limit) break
      }
    } catch { /* fall through */ }
  }
  if (out.length < limit) {
    const pool = evalExemplars().filter((e) => (!args.moment || e.moment === args.moment) && (!excluded || norm(e.reply) !== excluded))
    const sameChannel = pool.filter((e) => !args.channel || e.channel === args.channel)
    for (const e of [...sameChannel, ...pool.filter((e) => !sameChannel.includes(e))]) {
      if (out.length >= limit) break
      if (!out.some((o) => o.reply === e.reply)) out.push(e)
    }
  }
  return out
}

export function formatExemplars(ex: Exemplar[]): string {
  if (!ex.length) return "(none yet)"
  const one = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n)
  return ex
    .map((e, i) => {
      if (e.gist) {
        // Coached send: the intent travels with the register example.
        return `Example ${i + 1} (coached)\n  Ryan's gist: ${one(e.gist, 300)} → what he sent: ${one(e.reply, 600)}`
      }
      return `Example ${i + 1}${e.inbound ? `\n  They wrote: ${one(e.inbound, 300)}` : ""}\n  Ryan replied: ${one(e.reply, 600)}`
    })
    .join("\n")
}
