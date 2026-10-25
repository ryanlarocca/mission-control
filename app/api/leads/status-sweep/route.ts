import { NextResponse } from "next/server"
import { getLeadsClient, sendTelegramAlert } from "@/lib/leads"
import { autoStatusEnabled, runQuietSweep, type PersonalTexts } from "@/lib/leadStatus"
import { sendStatusDigest } from "@/lib/leadStatusDigest"

// Daily lead-status pass (launchd com.lrghomes.lead-status-sweep on the Mac
// mini, 8:05am PT, via scripts/lead-status-sweep.mjs → cookie login like
// the rescue sweep's Phase C). Auth-gated by middleware.
//   1. 30-day quiet rule: Active people who never answered Ryan → Nurture.
//   2. One Telegram summary of every automatic move since the last one
//      (none on a day nothing moved), each with an undo button.
// With LEAD_AUTO_STATUS off both steps are shadow / skipped.
export const dynamic = "force-dynamic"
export const maxDuration = 300

// Body (optional): { personal: { "<last10>": { inbound: [iso], outbound: [iso] } } }
// — Ryan's personal-cell texts per Active person, read from The Pile by the
// mini script, so a seller he texts from his own phone is never "quiet".
export async function POST(request: Request) {
  const sb = getLeadsClient()
  try {
    let personalByPhone: Record<string, PersonalTexts> | undefined
    try {
      const body = (await request.json()) as { personal?: Record<string, { inbound?: string[]; outbound?: string[] }> }
      if (body?.personal && typeof body.personal === "object") {
        personalByPhone = {}
        for (const [k, v] of Object.entries(body.personal)) {
          const ts = (a?: string[]) => (Array.isArray(a) ? a.map((x) => Date.parse(x)).filter((n) => Number.isFinite(n)) : [])
          personalByPhone[k.replace(/\D/g, "").slice(-10)] = { inbound: ts(v?.inbound), outbound: ts(v?.outbound) }
        }
      }
    } catch {
      /* no body — Supabase rows only */
    }
    const quiet = await runQuietSweep(sb, { personalByPhone })
    const digest = autoStatusEnabled() ? await sendStatusDigest(sb) : { sent: false, count: 0 }
    return NextResponse.json({ enabled: autoStatusEnabled(), quiet, digest })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[status-sweep] failed:", msg)
    await sendTelegramAlert(`⚠️ Daily lead-status pass failed — ${msg.slice(0, 200)}`).catch(() => {})
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
