import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { fetchThread } from "@/lib/relationship-messages"

// One-off lead review screen (/leads/review, first batch 2026-11-23: the people
// leaving Long-term nurture). Ryan reads each person's history and taps a
// decision; this only RECORDS the pick in lead_review_picks. Nothing here
// changes a lead — the picks are applied afterwards, on his say-so.
//
//   GET ?batch=…            the people + what their cards say today
//   GET ?batch=…&key=…      one person's whole history (+ texts on his cell)
//   PATCH {batch, person_key, decision, decision_date, note}

export const dynamic = "force-dynamic"

const DECISIONS = new Set(["followup", "autopilot", "leave", "dead"])

type LeadRow = {
  id: string
  created_at: string
  lead_type: string | null
  twilio_number: string | null
  message: string | null
  ai_summary: string | null
  notes: string | null
  status: string | null
  source: string | null
  recommended_followup_date: string | null
  followup_reason: string | null
  offer_amount: number | null
  call_duration_sec: number | null
  jackie_call: boolean | null
  drip_campaign_type: string | null
}

const COLS = "id, created_at, lead_type, twilio_number, message, ai_summary, notes, status, source, recommended_followup_date, followup_reason, offer_amount, call_duration_sec, jackie_call, drip_campaign_type"

async function clusterRows(pick: { phone: string | null; email: string | null }): Promise<LeadRow[]> {
  const sb = getLeadsClient()
  const q = sb.from("leads").select(COLS).order("created_at", { ascending: true }).limit(500)
  const { data, error } = pick.phone ? await q.eq("caller_phone", pick.phone) : await q.eq("email", pick.email ?? "")
  if (error) throw new Error(error.message)
  return (data ?? []) as LeadRow[]
}

function isFromThem(r: LeadRow): boolean {
  const t = r.lead_type || ""
  if (t.startsWith("drip_")) return false
  if (t === "voicemail" || t.endsWith("_inbound")) return true
  return !!r.twilio_number
}

function label(r: LeadRow): string {
  const t = r.lead_type || ""
  const them = isFromThem(r)
  if (/\[autopilot #\d/.test(r.notes || "")) return "Autopilot text"
  if (r.jackie_call) return "They called — Jackie (AI) answered"
  if (t === "drip_imessage") return "Auto text"
  if (t === "drip_email") return "Auto email"
  if (t === "voicemail") return "Voicemail from them"
  if (t === "call" || t === "outbound_call") return them ? "They called" : "You called"
  if (t.startsWith("email")) return them ? "They emailed" : "You emailed"
  if (t === "sms" || t.startsWith("imessage")) return them ? "They texted" : "You texted"
  return t || "note"
}

export async function GET(req: NextRequest) {
  try {
    const batch = req.nextUrl.searchParams.get("batch") || ""
    const key = req.nextUrl.searchParams.get("key")
    const sb = getLeadsClient()
    if (!batch) {
      const { data } = await sb.from("lead_review_picks").select("batch, created_at").order("created_at", { ascending: false }).limit(1)
      if (!data?.[0]) return NextResponse.json({ error: "no review batch" }, { status: 404 })
      return NextResponse.redirect(new URL(`/api/lead-review?batch=${encodeURIComponent(data[0].batch)}`, req.url))
    }

    if (key) {
      const { data: pick, error } = await sb.from("lead_review_picks").select("*").eq("batch", batch).eq("person_key", key).maybeSingle()
      if (error) throw new Error(error.message)
      if (!pick) return NextResponse.json({ error: "not in this review" }, { status: 404 })
      const rows = await clusterRows(pick)
      const events = rows
        .map((r) => ({
          at: r.created_at,
          kind: label(r),
          fromThem: isFromThem(r),
          text: (r.message || "").trim(),
          summary: (r.ai_summary || "").trim(),
          notes: /^\[autopilot/.test(r.notes || "") ? "" : (r.notes || "").trim(),
          seconds: r.call_duration_sec ? Math.round(r.call_duration_sec) : null,
        }))
        .filter((e) => e.text || e.summary || e.notes)
      let cellOk = false
      if (pick.phone) {
        const thread = await fetchThread(pick.phone, 8000)
        cellOk = thread.length > 0
        for (const m of thread) {
          events.push({ at: m.at, kind: m.fromMe ? "You texted (your cell)" : "They texted your cell", fromThem: !m.fromMe, text: m.text, summary: "", notes: "", seconds: null })
        }
      }
      events.sort((a, b) => a.at.localeCompare(b.at))
      return NextResponse.json({ events, cellTexts: pick.phone ? cellOk : null })
    }

    const { data: picks, error } = await sb.from("lead_review_picks").select("*").eq("batch", batch).order("sort_order")
    if (error) throw new Error(error.message)
    const people = await Promise.all(
      (picks ?? []).map(async (p) => {
        const rows = await clusterRows(p)
        const dated = rows.filter((r) => r.recommended_followup_date).sort((a, b) => a.recommended_followup_date!.localeCompare(b.recommended_followup_date!))
        const fu = dated[dated.length - 1] ?? null
        // Their replies to his own cell count too (Brett only ever texted it).
        const cell = p.phone ? await fetchThread(p.phone, 8000) : []
        const theirs = [...rows.filter(isFromThem).map((r) => r.created_at), ...cell.filter((m) => !m.fromMe).map((m) => m.at)].sort()
        const latest = <K extends keyof LeadRow>(k: K) => { for (let i = rows.length - 1; i >= 0; i--) if (rows[i][k] != null && rows[i][k] !== "") return rows[i][k]; return null }
        return {
          ...p,
          status: rows[rows.length - 1]?.status ?? null,
          source: latest("source"),
          offer: latest("offer_amount"),
          campaign: latest("drip_campaign_type"),
          current_followup: fu?.recommended_followup_date ?? null,
          current_reason: fu?.followup_reason ?? null,
          from_them: theirs.length,
          last_from_them: theirs[theirs.length - 1] ?? null,
          first_at: rows[0]?.created_at ?? null,
        }
      })
    )
    return NextResponse.json({ batch, people })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  let body: { batch?: string; person_key?: string; decision?: string | null; decision_date?: string | null; note?: string | null }
  try { body = await req.json() } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }) }
  if (!body.batch || !body.person_key) return NextResponse.json({ error: "batch and person_key are required" }, { status: 400 })
  const patch: Record<string, unknown> = {}
  if ("decision" in body) {
    if (body.decision !== null && !DECISIONS.has(String(body.decision))) return NextResponse.json({ error: "unknown decision" }, { status: 400 })
    patch.decision = body.decision
    patch.decided_at = body.decision ? new Date().toISOString() : null
  }
  if ("decision_date" in body) {
    if (body.decision_date && !/^\d{4}-\d{2}-\d{2}$/.test(body.decision_date)) return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 })
    patch.decision_date = body.decision_date || null
  }
  if ("note" in body) patch.note = (body.note ?? "").slice(0, 2000) || null
  if (!Object.keys(patch).length) return NextResponse.json({ error: "nothing to save" }, { status: 400 })
  const { data, error } = await getLeadsClient().from("lead_review_picks").update(patch).eq("batch", body.batch).eq("person_key", body.person_key).select("*").maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: "not in this review" }, { status: 404 })
  return NextResponse.json({ pick: data })
}
