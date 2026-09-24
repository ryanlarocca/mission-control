// "Send executes the plan" — server side (Telegram sends). Mirrors
// lib/reply-client.ts executePlan: nurture / drip go through the same route
// handlers the card calls; status changes go straight to Supabase.

import { NextRequest } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import type { Plan } from "./plan"

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
      const d = new Date(); d.setDate(d.getDate() + 1)
      const { error } = await sb.from("leads").update({ recommended_followup_date: d.toISOString().slice(0, 10), followup_reason: "Call them (Reply Planner)" }).eq("id", leadId)
      if (error) throw new Error(error.message)
      return "call reminder set for tomorrow"
    }
    case "close_dead": {
      const { error } = await sb.from("leads").update({ status: "dead" }).eq("id", leadId)
      if (error) throw new Error(error.message)
      return "closed"
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
