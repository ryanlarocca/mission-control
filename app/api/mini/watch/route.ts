import { NextResponse } from "next/server"
import { getLeadsClient, sendTelegramAlert } from "@/lib/leads"

// Outside watcher for the Mac mini (2026-11-06). Every other alert about the
// mini runs on the mini itself, so when it was off, frozen or offline nothing
// could say so. The mini checks in every minute (~/bin/mini-heartbeat.sh →
// mini_heartbeat row 'mini'); Supabase pg_cron calls this route every minute
// (supabase/migrations/2026-11-06_mini_heartbeat.sql):
//   * no check-in for QUIET_MS        → one 🔴, then one ✅ when check-ins resume
//   * mini alive but the bridge watchdog (claude-remote-ctl.py tick, every
//     5 min) silent for WATCHDOG_MS   → one 🟡, then one ✅
// Public (pg_cron has no session cookie) — middleware PUBLIC_PATHS. It reads
// one row and sends at most one message per state change; the alert marks are
// claimed with a conditional update so overlapping calls can't double-send.

export const dynamic = "force-dynamic"

const QUIET_MS = 4 * 60_000
const WATCHDOG_MS = 20 * 60_000

type Row = {
  beat_at: string
  watchdog_at: string | null
  info: { quiet_until?: string } | null
  down_alerted_at: string | null
  watchdog_alerted_at: string | null
}

function pacific(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000)
  return m < 90 ? `${m} min` : `${Math.round(m / 6) / 10} h`
}

/** Set (or clear) an alert mark only if it still holds `expected`; true = this call won the claim. */
async function claim(col: "down_alerted_at" | "watchdog_alerted_at", expected: string | null, value: string | null): Promise<boolean> {
  const q = getLeadsClient().from("mini_heartbeat").update({ [col]: value }).eq("id", "mini")
  const { data } = await (expected === null ? q.is(col, null) : q.eq(col, expected)).select("id")
  return !!data?.length
}

export async function GET() {
  const { data: row, error } = await getLeadsClient()
    .from("mini_heartbeat")
    .select("beat_at, watchdog_at, info, down_alerted_at, watchdog_alerted_at")
    .eq("id", "mini")
    .maybeSingle<Row>()
  if (error || !row) {
    if (error) console.error("[mini/watch] read failed:", error.message)
    return NextResponse.json({ ok: false })
  }
  const now = Date.now()
  const nowIso = new Date(now).toISOString()
  const sinceBeat = now - Date.parse(row.beat_at)
  const quietUntil = row.info?.quiet_until ? Date.parse(row.info.quiet_until) : 0
  const quiet = sinceBeat > QUIET_MS && now > quietUntil

  if (quiet && !row.down_alerted_at) {
    if (await claim("down_alerted_at", null, nowIso)) {
      await sendTelegramAlert(
        `🔴 <b>Mac mini has gone quiet</b> — no check-in for ${minutes(sinceBeat)} (last: ${pacific(row.beat_at)}).\n\n` +
          `If it's off, frozen or offline, everything that runs on it is down too (inbox agent, lead and text syncs, campaign engine, Mac mini chats).\n\n` +
          `Send “mini status”: if it answers, the mini is fine and only its check-in broke. If it doesn't, the mini or the office internet needs a look in person.`
      )
    }
  } else if (!quiet && row.down_alerted_at && sinceBeat <= QUIET_MS) {
    if (await claim("down_alerted_at", row.down_alerted_at, null)) {
      const downFor = Date.parse(row.beat_at) - Date.parse(row.down_alerted_at) + QUIET_MS
      await sendTelegramAlert(`✅ <b>Mac mini is back</b> — checking in again (quiet for about ${minutes(Math.max(downFor, QUIET_MS))}).`)
    }
  }

  // Watchdog silent while the mini itself is alive (only judged on a fresh beat).
  if (!quiet && sinceBeat <= QUIET_MS && row.watchdog_at) {
    const sinceTick = now - Date.parse(row.watchdog_at)
    if (sinceTick > WATCHDOG_MS && !row.watchdog_alerted_at) {
      if (await claim("watchdog_alerted_at", null, nowIso)) {
        await sendTelegramAlert(
          `🟡 <b>Mac mini watchdog stopped</b> — the mini is up, but the bridge watchdog hasn't run for ${minutes(sinceTick)}. ` +
            `Idle chats aren't being cleaned up and new chats may stop opening. Send “mini status”; “mini restart” if it's red.`
        )
      }
    } else if (sinceTick <= WATCHDOG_MS && row.watchdog_alerted_at) {
      if (await claim("watchdog_alerted_at", row.watchdog_alerted_at, null)) {
        await sendTelegramAlert("✅ Mac mini watchdog is running again.")
      }
    }
  }

  return NextResponse.json({ ok: true })
}
