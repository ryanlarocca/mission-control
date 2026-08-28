import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { saveCopyRule } from "@/lib/campaignRegenerate"

// Ryan's standing copy rules for the drip compose prompt.
//   GET            → { rules: [{ id, rule, active, created_at }] } (active only)
//   POST {rule}    → add
//   DELETE {id}    → retire (kept for history; prompt stops reading it)

export async function GET() {
  const sb = getLeadsClient()
  const { data, error } = await sb
    .from("campaign_copy_rules")
    .select("id, rule, active, created_at")
    .eq("active", true)
    .order("created_at", { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ rules: data ?? [] })
}

export async function POST(req: NextRequest) {
  let body: { rule?: string } = {}
  try { body = await req.json() } catch { return NextResponse.json({ error: "json body required" }, { status: 400 }) }
  try {
    const id = await saveCopyRule(getLeadsClient(), body.rule ?? "")
    return NextResponse.json({ ok: true, id })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 })
  }
}

export async function DELETE(req: NextRequest) {
  let body: { id?: string } = {}
  try { body = await req.json() } catch { return NextResponse.json({ error: "json body required" }, { status: 400 }) }
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 })
  const { error } = await getLeadsClient()
    .from("campaign_copy_rules")
    .update({ active: false, retired_at: new Date().toISOString() })
    .eq("id", body.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
