import { NextResponse } from "next/server"
import { getLeadsClient, sendTelegramAlert } from "@/lib/leads"
import { autoStatusEnabled, runQuietSweep } from "@/lib/leadStatus"
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

export async function POST() {
  const sb = getLeadsClient()
  try {
    const quiet = await runQuietSweep(sb)
    const digest = autoStatusEnabled() ? await sendStatusDigest(sb) : { sent: false, count: 0 }
    return NextResponse.json({ enabled: autoStatusEnabled(), quiet, digest })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[status-sweep] failed:", msg)
    await sendTelegramAlert(`⚠️ Daily lead-status pass failed — ${msg.slice(0, 200)}`).catch(() => {})
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
