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
  const out: Exemplar[] = []
  if (args.moment) {
    try {
      const sb = getLeadsClient()
      let q = sb
        .from("reply_drafts")
        .select("moment, channel, sent_body, lead_id, relationship_id, surface")
        .eq("moment", args.moment)
        .not("sent_body", "is", null)
        .neq("surface", "eval")
        .order("sent_at", { ascending: false })
        .limit(limit * 2)
      if (args.excludeLeadId) q = q.neq("lead_id", args.excludeLeadId)
      const { data } = await q
      for (const r of data || []) {
        if (args.surface === "leads" && !r.lead_id) continue
        if (args.surface === "relationships" && !r.relationship_id) continue
        if (r.sent_body) out.push({ moment: r.moment, channel: r.channel, inbound: null, reply: r.sent_body, source: "sent" })
        if (out.length >= limit) break
      }
    } catch { /* table may be empty / unreachable — fall through */ }
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
  return ex
    .map((e, i) => `Example ${i + 1}${e.inbound ? `\n  They wrote: ${e.inbound.replace(/\s+/g, " ").slice(0, 300)}` : ""}\n  Ryan replied: ${e.reply.replace(/\s+/g, " ").slice(0, 600)}`)
    .join("\n")
}
