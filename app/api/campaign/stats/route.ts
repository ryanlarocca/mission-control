import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// Campaign Performance tab data: health counts, the send-time experiment
// (reply rate by PT send hour since 7/31), touch funnel, recent replies.
// Session-gated (not in middleware PUBLIC_PATHS). All fetches paged —
// PostgREST silently caps selects at 1000 rows.

export const dynamic = "force-dynamic"

const EXPERIMENT_START = "2026-07-31"
const REPLY_WINDOW_MS = 14 * 86_400_000

type SendRow = { contact_id: string | null; touch_number: number; sent_at: string | null }

async function pageAll<T>(fetchPage: (offset: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const all: T[] = []
  for (let off = 0; ; off += 1000) {
    const { data, error } = await fetchPage(off)
    if (error) throw new Error(error.message)
    all.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  return all
}

export async function GET() {
  try {
    const sb = getLeadsClient()

    const contacts = await pageAll<{ status: string }>((off) =>
      sb.from("campaign_contacts").select("status").range(off, off + 999)
    )
    const contactsByStatus: Record<string, number> = {}
    for (const c of contacts) contactsByStatus[c.status] = (contactsByStatus[c.status] ?? 0) + 1

    const sends = await pageAll<SendRow>((off) =>
      sb.from("campaign_sends").select("contact_id, touch_number, sent_at").eq("status", "sent").range(off, off + 999)
    )
    // triage null = genuine replies only (auto_reply / dead_mailbox /
    // unsubscribe rows are also kind=email_reply and must not count).
    const replies = await pageAll<{ contact_id: string | null; occurred_at: string }>((off) =>
      sb.from("campaign_events").select("contact_id, occurred_at").eq("kind", "email_reply").is("triage", null).range(off, off + 999)
    )
    const replyTimes = new Map<string, number[]>()
    for (const r of replies) {
      if (!r.contact_id) continue
      const arr = replyTimes.get(r.contact_id) ?? []
      arr.push(new Date(r.occurred_at).getTime())
      replyTimes.set(r.contact_id, arr)
    }
    const repliedWithin = (s: SendRow): boolean => {
      if (!s.contact_id || !s.sent_at) return false
      const t = new Date(s.sent_at).getTime()
      return (replyTimes.get(s.contact_id) ?? []).some((rt) => rt > t && rt - t < REPLY_WINDOW_MS)
    }

    // Touch funnel
    const touches: Record<number, { sent: number; replied: number }> = {}
    for (const s of sends) {
      const b = (touches[s.touch_number] ??= { sent: 0, replied: 0 })
      b.sent++
      if (repliedWithin(s)) b.replied++
    }

    // Send-time experiment: PT-hour bins since EXPERIMENT_START
    const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false })
    const hours: Record<number, { sent: number; replied: number }> = {}
    for (const s of sends) {
      if (!s.sent_at || s.sent_at < EXPERIMENT_START) continue
      const h = Number(hourFmt.format(new Date(s.sent_at))) % 24
      const b = (hours[h] ??= { sent: 0, replied: 0 })
      b.sent++
      if (repliedWithin(s)) b.replied++
    }

    const { count: draftCount } = await sb.from("campaign_sends").select("id", { count: "exact", head: true }).eq("status", "draft")
    const { count: approvedCount } = await sb.from("campaign_sends").select("id", { count: "exact", head: true }).eq("status", "approved")
    const todayPt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
    const sentToday = sends.filter((s) => {
      if (!s.sent_at) return false
      return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(s.sent_at)) === todayPt
    }).length

    const { data: recent } = await sb
      .from("campaign_events")
      .select("body, occurred_at, contact:campaign_contacts (name)")
      .eq("kind", "email_reply")
      .is("triage", null)
      .order("occurred_at", { ascending: false })
      .limit(10)

    const totalSent = sends.length
    const totalReplied = sends.filter(repliedWithin).length

    return NextResponse.json({
      experiment_start: EXPERIMENT_START,
      contacts: contactsByStatus,
      totals: {
        sent: totalSent,
        replied: totalReplied,
        reply_rate: totalSent ? totalReplied / totalSent : 0,
        bounced: contactsByStatus["bounced"] ?? 0,
        unsubscribed: contactsByStatus["unsubscribed"] ?? 0,
        sent_today: sentToday,
        queue_draft: draftCount ?? 0,
        queue_approved: approvedCount ?? 0,
      },
      touches,
      hours,
      recent_replies: (recent ?? []).map((r) => ({
        name: (r.contact as { name?: string } | null)?.name ?? "unknown",
        when: r.occurred_at,
        snippet: (r.body ?? "").slice(0, 140),
      })),
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
