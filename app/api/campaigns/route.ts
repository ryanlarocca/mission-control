import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// Campaigns CRUD — Campaign Performance tab uses GET for the campaign
// list (parent rollups + children) and POST for the "+ New Campaign"
// modal. DELETE / PATCH are intentionally absent for v1 — Ryan corrects
// via Supabase Studio for now.

export interface Campaign {
  id: string
  name: string
  channel: "direct_mail" | "google_ads"
  drop_date: string | null
  pieces_sent: number | null
  total_cost: number | null
  variant: string | null
  parent_campaign_id: string | null
  notes: string | null
  created_at: string
}

export async function GET() {
  try {
    const sb = getLeadsClient()
    const { data, error } = await sb
      .from("campaigns")
      .select("*")
      .order("drop_date", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ campaigns: (data ?? []) as Campaign[] })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

const VALID_CHANNELS = new Set(["direct_mail", "google_ads"])

export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const name = typeof body.name === "string" ? body.name.trim() : ""
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 })

  const channel = typeof body.channel === "string" ? body.channel : ""
  if (!VALID_CHANNELS.has(channel)) {
    return NextResponse.json({ error: "channel must be 'direct_mail' or 'google_ads'" }, { status: 400 })
  }

  const row: Record<string, unknown> = { name, channel }
  if (typeof body.drop_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.drop_date)) {
    row.drop_date = body.drop_date
  }
  if (typeof body.pieces_sent === "number" && body.pieces_sent >= 0) {
    row.pieces_sent = Math.round(body.pieces_sent)
  }
  if (typeof body.total_cost === "number" && body.total_cost >= 0) {
    row.total_cost = body.total_cost
  }
  if (typeof body.variant === "string" && body.variant.trim()) {
    row.variant = body.variant.trim()
  }
  if (typeof body.parent_campaign_id === "string" && /^[0-9a-f-]{36}$/i.test(body.parent_campaign_id)) {
    row.parent_campaign_id = body.parent_campaign_id
  }
  if (typeof body.notes === "string" && body.notes.trim()) {
    row.notes = body.notes.trim()
  }

  try {
    const sb = getLeadsClient()
    const { data, error } = await sb.from("campaigns").insert(row).select().single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ campaign: data as Campaign })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
