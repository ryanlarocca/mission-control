import type { SupabaseClient } from "@supabase/supabase-js"

// Campaign Telegram alerts — the NO-SILENT-FAILURE version (2026-07-21).
//
// History: lib/leads sendTelegramAlert swallows every failure into
// console.error, which on Vercel is invisible. That cost us Asha's reply
// alert (HTML parse rejection) and made "did the alert send?" unanswerable
// from outside. This wrapper guarantees one of three observable outcomes:
//   1. delivered as HTML, or
//   2. delivered as PLAIN TEXT (auto-retry when Telegram rejects the
//      formatting — degraded but DELIVERED), or
//   3. a campaign_events row (kind 'note', triage 'alert_failure') holding
//      Telegram's exact error — visible in the DB, not a console.
export async function sendCampaignAlert(sb: SupabaseClient, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID

  const recordFailure = async (detail: string) => {
    try {
      await sb.from("campaign_events").insert({
        kind: "note",
        triage: "alert_failure",
        body: `Telegram alert failed: ${detail}\n---\n${text.slice(0, 500)}`,
      })
    } catch {
      // even this failing shouldn't break the pipeline
    }
  }

  if (!token || !chatId) {
    await recordFailure("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing in env")
    return
  }

  const post = async (body: Record<string, unknown>) =>
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

  try {
    const res = await post({ chat_id: chatId, text, parse_mode: "HTML" })
    if (res.ok) return
    const detail = await res.text()
    // Formatting rejection → strip tags, resend plain. Degraded > lost.
    const plain = await post({ chat_id: chatId, text: text.replace(/<[^>]+>/g, "") })
    if (plain.ok) {
      await recordFailure(`HTML rejected (${res.status}: ${detail.slice(0, 200)}) — delivered as plain text instead`)
      return
    }
    await recordFailure(`${res.status}: ${detail.slice(0, 200)} (plain-text retry also failed: ${plain.status})`)
  } catch (e) {
    await recordFailure(e instanceof Error ? e.message : String(e))
  }
}
