import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { normalizeCategory } from "@/lib/crms"
import { fetchAllRelationships, to10Digit } from "@/lib/relationships"

// Book-of-Business contact CRUD. Used by the COI Addition skill (add a
// contact from a screenshot / business card) now that the BoB lives in the
// Supabase `relationships` table instead of the Google Sheet.
//
//   GET    ?name=&phone=&email=   duplicate search
//   POST   { name, phone?, email?, source?, type?, tier?, notes? }   create
//   PATCH  { id, ...fields }       update an existing contact
export const dynamic = "force-dynamic"

const VALID_TIERS = new Set(["A", "B", "C", "D", "E"])

// Auth: this route stays behind the normal mc_session middleware. The COI
// Addition scripts (no browser session) mint a fresh session token from
// MC_SESSION_SECRET — no separate API key / Vercel env var needed.

function normName(s: unknown): string {
  return String(s ?? "").toLowerCase().split(/\s+/).filter(Boolean).join(" ")
}

function toE164(phone: unknown): string | null {
  const d = String(phone ?? "").replace(/\D/g, "")
  return d.length >= 10 ? `+1${d.slice(-10)}` : null
}

// GET — duplicate search by name (exact/partial), phone (last-10), email.
// Mirrors the old check-duplicate.py semantics.
export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const qName = normName(url.searchParams.get("name"))
    const qPhone = to10Digit(url.searchParams.get("phone"))
    const qEmail = String(url.searchParams.get("email") ?? "").toLowerCase().trim()
    if (!qName && !qPhone && !qEmail) {
      return NextResponse.json({ error: "provide at least one of: name, phone, email" }, { status: 400 })
    }

    const supabase = getLeadsClient()
    const rows = await fetchAllRelationships(supabase)

    const matches = []
    for (const r of rows) {
      const fields: string[] = []
      const rName = normName(r.name)
      if (qName && rName === qName) fields.push("name")
      else if (qName && rName.includes(qName)) fields.push("name_partial")
      if (qPhone.length >= 7 && to10Digit(r.phone) === qPhone) fields.push("phone")
      if (qEmail && String(r.email ?? "").toLowerCase().trim() === qEmail) fields.push("email")
      if (fields.length > 0) {
        const notes = String(r.notes ?? "")
        matches.push({
          id: r.id,
          name: r.name,
          phone: r.phone,
          email: r.email,
          source: r.source,
          type: r.category,
          tier: r.tier,
          last_contacted: r.last_contacted_at,
          notes: notes.length > 200 ? notes.slice(0, 200) + "…" : notes,
          match_fields: fields,
        })
      }
    }
    return NextResponse.json({ matches })
  } catch (err) {
    console.error("relationships GET error:", err)
    return NextResponse.json({ error: "lookup failed" }, { status: 500 })
  }
}

// POST — create a contact. Caller is expected to have run the GET dedup
// check first (the COI Addition skill does).
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const name = String(body.name ?? "").trim()
    if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 })

    const phone = toE164(body.phone)
    const email = String(body.email ?? "").trim() || null
    if (!phone && !email) {
      return NextResponse.json({ error: "at least one of phone or email is required" }, { status: 400 })
    }

    const category = normalizeCategory(String(body.category ?? body.type ?? "Agent"))
    const tierIn = String(body.tier ?? "C").trim().toUpperCase()
    const tier = VALID_TIERS.has(tierIn) ? tierIn : "C"

    const supabase = getLeadsClient()
    const { data, error } = await supabase
      .from("relationships")
      .insert({
        name,
        phone,
        email,
        source: String(body.source ?? "").trim() || null,
        category,
        tier,
        notes: String(body.notes ?? "").trim() || null,
      })
      .select("id, name, phone, email, source, category, tier, notes")
      .single()
    if (error) throw error

    return NextResponse.json({ success: true, id: data.id, contact: data })
  } catch (err) {
    console.error("relationships POST error:", err)
    return NextResponse.json({ error: "create failed" }, { status: 500 })
  }
}

// PATCH — update fields on an existing contact (fix a missing phone/email,
// rename, re-tier). Only the fields present in the body are touched.
export async function PATCH(request: Request) {
  try {
    const body = await request.json()
    const id = String(body.id ?? "")
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 })

    const update: Record<string, unknown> = {}
    if (body.name !== undefined) {
      const n = String(body.name).trim()
      if (!n) return NextResponse.json({ error: "name cannot be blank" }, { status: 400 })
      update.name = n
    }
    if (body.phone !== undefined) {
      const p = toE164(body.phone)
      if (!p) return NextResponse.json({ error: "phone must be a 10-digit number" }, { status: 400 })
      update.phone = p
    }
    if (body.email !== undefined) update.email = String(body.email).trim() || null
    if (body.notes !== undefined) update.notes = String(body.notes).trim() || null
    if (body.source !== undefined) update.source = String(body.source).trim() || null
    if (body.category !== undefined || body.type !== undefined) {
      update.category = normalizeCategory(String(body.category ?? body.type))
    }
    if (body.tier !== undefined) {
      const t = String(body.tier).trim().toUpperCase()
      if (!VALID_TIERS.has(t)) return NextResponse.json({ error: "invalid tier" }, { status: 400 })
      update.tier = t
    }
    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "no fields to update" }, { status: 400 })
    }

    const supabase = getLeadsClient()
    const { data, error } = await supabase
      .from("relationships")
      .update(update)
      .eq("id", id)
      .select("id, name, phone, email, source, category, tier")
      .single()
    if (error) throw error

    return NextResponse.json({ success: true, contact: data })
  } catch (err) {
    console.error("relationships PATCH error:", err)
    return NextResponse.json({ error: "update failed" }, { status: 500 })
  }
}
