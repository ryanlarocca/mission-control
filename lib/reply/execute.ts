// "Send executes the plan" — server side (Telegram sends). Mirrors
// lib/reply-client.ts executePlan: nurture / drip go through the same route
// handlers the card calls; status changes go straight to Supabase.

import { NextRequest } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import type { Plan } from "./plan"
import { pacificDatePlusDays } from "@/lib/pacificDate"

export async function executePlanServer(leadId: string, plan: Plan | null | undefined): Promise<string | null> {
  if (!leadId || !plan) return null
  const sb = getLeadsClient()
  const callRoute = async (mod: Promise<{ POST: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response> }>) => {
    const { POST } = await mod
    const req = new NextRequest(`http://internal/api/leads/${leadId}`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } })
    return POST(req, { params: Promise.resolve({ id: leadId }) })
  }
  switch (plan.next_action) {
    case "long_term_nurture": {
      const res = await callRoute(import("@/app/api/leads/[id]/long-term-nurture/route"))
      if (!res.ok && res.status !== 409) throw new Error(`nurture HTTP ${res.status}`)
      return "moved to long-term nurture"
    }
    case "drip": {
      const res = await callRoute(import("@/app/api/leads/[id]/apply-drip/route"))
      if (!res.ok) {
        const err = ((await res.json().catch(() => ({}))) as { error?: string }).error || ""
        if (!/already/i.test(err)) throw new Error(err || `drip HTTP ${res.status}`)
      }
      return "drip running"
    }
    case "schedule_call": {
      const { error } = await sb.from("leads").update({ recommended_followup_date: pacificDatePlusDays(1), followup_reason: "Call them (Reply Planner)" }).eq("id", leadId)
      if (error) throw new Error(error.message)
      return "call reminder set for tomorrow"
    }
    case "close_dead": {
      return closeLeadDead(leadId)
    }
    case "junk": {
      const { error } = await sb.from("leads").update({ is_junk: true, status: "dead" }).eq("id", leadId)
      if (error) throw new Error(error.message)
      return "marked junk"
    }
    default:
      return null
  }
}

/**
 * Close (dead). When their latest message is an explicit remove request (or
 * the contact is already DNC), this is a DNC, not just a close — the whole
 * cluster is flagged, the address goes on the do-not-contact list and queued
 * outreach stops. "Not selling" closes stay mailable (Ryan's rule).
 */
export async function closeLeadDead(leadId: string): Promise<string> {
  const sb = getLeadsClient()
  const { data: lead } = await sb.from("leads").select("id, caller_phone, email").eq("id", leadId).maybeSingle()
  if (!lead) throw new Error("lead not found")
  const { checkContactDnc, explicitOptOutPhrase, markContactDnc } = await import("@/lib/dnc")
  const ors = [`id.eq.${leadId}`]
  if (lead.caller_phone) ors.push(`caller_phone.eq.${lead.caller_phone}`)
  if (lead.email) ors.push(`email.ilike.${String(lead.email).toLowerCase()}`)
  const { data: lastIn } = await sb
    .from("leads")
    .select("message")
    .or(ors.join(","))
    .not("twilio_number", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
  const optOut = explicitOptOutPhrase((lastIn?.[0]?.message as string | null) ?? null)
  const already = (await checkContactDnc(sb, { phone: lead.caller_phone, email: lead.email }, "all").catch(() => ({ dnc: false }))).dnc
  if (optOut || already) {
    const out = await markContactDnc(sb, leadId, { addedBy: "ryan" })
    if (!out.ok) throw new Error(out.error || "DNC failed")
    return "closed · DNC (off the list)"
  }
  const { error } = await sb.from("leads").update({ status: "dead" }).eq("id", leadId)
  if (error) throw new Error(error.message)
  return "closed"
}
