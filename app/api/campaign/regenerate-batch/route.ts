import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { loadRegenContext, regenerateSend, saveCopyRule } from "@/lib/campaignRegenerate"

// Regenerate every waiting Phase B draft (or the given ids) with one note
// applied to all of them (Ryan 2026-08-27: "I'll have comments, but I have
// all these different emails"). Body: { ids?: string[], note?: string, saveAsRule?: boolean }
// Sequential — each is a Claude call; ~5s apiece. Returns per-draft outcomes.

export const maxDuration = 300
const MAX_BATCH = 40

export async function POST(req: NextRequest) {
  let body: { ids?: string[]; note?: string; saveAsRule?: boolean } = {}
  try { body = await req.json() } catch { /* body optional */ }
  const note = typeof body.note === "string" ? body.note.trim() : ""
  try {
    const sb = getLeadsClient()
    let ruleId: string | null = null
    if (body.saveAsRule && note) ruleId = await saveCopyRule(sb, note)

    let ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === "string") : []
    if (ids.length === 0) {
      const { data, error } = await sb
        .from("campaign_sends")
        .select("id")
        .eq("status", "draft")
        .not("variant", "is", null)
        .order("created_at", { ascending: true })
        .limit(MAX_BATCH)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      ids = (data ?? []).map((r) => r.id)
    }
    ids = ids.slice(0, MAX_BATCH)

    const regen = await loadRegenContext(sb)
    const results = []
    for (let i = 0; i < ids.length; i++) results.push(await regenerateSend(sb, ids[i], note, regen, `b${i}-`))
    const ok = results.filter((r) => r.ok).length
    return NextResponse.json({ ok: true, total: ids.length, regenerated: ok, failed: results.filter((r) => !r.ok), ruleId })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
