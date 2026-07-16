import { NextResponse } from "next/server"
import type { SupabaseClient } from "@supabase/supabase-js"
import { getLeadsClient } from "@/lib/leads"
import { fetchAllRelationships, toApiContact } from "@/lib/relationships"
import type { CleanupVerdict } from "@/lib/relationships"

// Cleanup mode — bulk triage of the full Book of Business.
//
// GET  → every contact + "avoidance" counts from relationship_touches
//        (skips + Mark-Done-without-sending), sorted unreviewed-first then
//        most-avoided-first so the worst offenders surface immediately.
// POST → record a verdict for one contact:
//        keep  = leave as-is           (stamps reviewed)
//        vague = demote to tier D + snooze 365d — WITHOUT the snooze a vague
//                contact whose last touch predates the tier-D cadence (most
//                of them) would be due again immediately, defeating the
//                one-time-triage intent. The clock starts at the verdict.
//        never = status do_not_contact (out of the queue for good)
//        undo  = back to active, verdict + snooze cleared (queue Undo toast)
export const dynamic = "force-dynamic"
export const revalidate = 0

// Mark Done writes this literal message when no iMessage was actually sent
// (see CRMSTab handleMarkDone) — it's the fingerprint for pseudo-skips.
const MANUAL_DONE_MESSAGE = "[marked contacted manually]"

interface TouchRow {
  relationship_id: string | null
  action: string | null
  message: string | null
}

// Page through relationship_touches (PostgREST caps responses at 1000 rows).
async function fetchAllTouches(supabase: SupabaseClient): Promise<TouchRow[]> {
  const PAGE = 1000
  const out: TouchRow[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("relationship_touches")
      .select("relationship_id, action, message")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    const rows = (data ?? []) as TouchRow[]
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

export async function GET() {
  try {
    const supabase = getLeadsClient()
    const [rows, touches] = await Promise.all([
      fetchAllRelationships(supabase),
      fetchAllTouches(supabase),
    ])

    const skips: Record<string, number> = {}
    const manualDones: Record<string, number> = {}
    for (const t of touches) {
      if (!t.relationship_id) continue
      if (t.action === "skipped") {
        skips[t.relationship_id] = (skips[t.relationship_id] ?? 0) + 1
      } else if (t.action === "sent" && t.message === MANUAL_DONE_MESSAGE) {
        manualDones[t.relationship_id] = (manualDones[t.relationship_id] ?? 0) + 1
      }
    }

    const contacts = rows
      .map(row => {
        const c = toApiContact(row)
        const s = skips[row.id] ?? 0
        const d = manualDones[row.id] ?? 0
        return { ...c, skips: s, manualDones: d, avoidance: s + d }
      })
      .sort((a, b) => {
        const aReviewed = a.cleanupReviewedAt ? 1 : 0
        const bReviewed = b.cleanupReviewedAt ? 1 : 0
        if (aReviewed !== bReviewed) return aReviewed - bReviewed // unreviewed first
        if (b.avoidance !== a.avoidance) return b.avoidance - a.avoidance
        return b.daysOverdue - a.daysOverdue
      })

    const reviewed = contacts.filter(c => c.cleanupReviewedAt).length
    return NextResponse.json({ contacts, total: contacts.length, reviewed })
  } catch (err) {
    console.error("crms/cleanup GET error:", err)
    return NextResponse.json({ error: "Failed to fetch cleanup list" }, { status: 500 })
  }
}

const VERDICTS = new Set<string>(["keep", "vague", "never", "undo"])

export async function POST(request: Request) {
  try {
    const { id, verdict } = await request.json()
    if (!id || typeof id !== "string") {
      return NextResponse.json({ error: "id required" }, { status: 400 })
    }
    if (typeof verdict !== "string" || !VERDICTS.has(verdict)) {
      return NextResponse.json({ error: "verdict must be keep, vague, never, or undo" }, { status: 400 })
    }

    const patch: Record<string, unknown> =
      verdict === "undo"
        ? { status: "active", cleanup_verdict: null, cleanup_reviewed_at: null, snooze_until: null }
        : {
            status: verdict === "never" ? "do_not_contact" : "active",
            cleanup_verdict: verdict as CleanupVerdict,
            cleanup_reviewed_at: new Date().toISOString(),
            ...(verdict === "vague"
              ? { tier: "D", snooze_until: new Date(Date.now() + 365 * 86400000).toISOString() }
              : {}),
          }

    const supabase = getLeadsClient()
    const { error } = await supabase.from("relationships").update(patch).eq("id", id)
    if (error) throw error

    return NextResponse.json({ ok: true, verdict })
  } catch (err) {
    console.error("crms/cleanup POST error:", err)
    return NextResponse.json({ error: "Failed to save verdict" }, { status: 500 })
  }
}
