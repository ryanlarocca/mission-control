import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { CONTEXT_LABEL, loadCycleContextData, renderCycleContext } from "@/lib/cycleContext"
import { ptToday } from "@/lib/cycleRegistry"

// Market-cycle macro context for comps (briefs/BRIEF_MARKET_CYCLE_TRACKER_2026-11-01.md §3.7).
// GET /api/cycle/context?zip=95123&price=1150000[&exit_month=2027-04]
// → { ok, label, zip, price, exit_month, as_of, lines: string[], text }
// Same block as scripts/market-cycle/cycle-context.py. Context, never a substitute
// for pocket comps. Auth: the session cookie, like every non-webhook route
// (middleware.ts); reads only.
export const dynamic = "force-dynamic"
export const revalidate = 0

export async function GET(request: Request) {
  const url = new URL(request.url)
  const zip = (url.searchParams.get("zip") || "").trim()
  const price = Number(url.searchParams.get("price"))
  const exitMonth = (url.searchParams.get("exit_month") || "").trim() || null
  if (!/^\d{5}$/.test(zip)) return NextResponse.json({ ok: false, error: "zip must be 5 digits" }, { status: 400 })
  if (!Number.isFinite(price) || price <= 0) return NextResponse.json({ ok: false, error: "price must be a positive number" }, { status: 400 })
  if (exitMonth && !/^\d{4}-(0[1-9]|1[0-2])$/.test(exitMonth)) return NextResponse.json({ ok: false, error: "exit_month must be YYYY-MM" }, { status: 400 })
  try {
    const today = ptToday()
    const data = await loadCycleContextData(getLeadsClient(), zip, price, today)
    const lines = renderCycleContext(data, { zip, price, exitMonth, today })
    return NextResponse.json({ ok: true, label: CONTEXT_LABEL, zip, price, exit_month: exitMonth, as_of: today, lines, text: lines.join("\n") })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
