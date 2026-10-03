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
export interface AlertButton {
  text: string
  data: string // callback_data delivered to /api/campaign/telegram
}

/** Returns the Telegram message_id when delivered (so a follow-up, e.g. an
 * attachment, can thread under it), null when it failed or went plain. */
export async function sendCampaignAlert(
  sb: SupabaseClient,
  text: string,
  opts?: { buttons?: AlertButton[] }
): Promise<number | null> {
  // Dedicated campaign bot when configured (zero-token button actions);
  // falls back to the shared Thadius bot until Ryan creates it.
  const token = process.env.CAMPAIGN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN
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
    return null
  }

  const post = async (body: Record<string, unknown>) =>
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

  // Buttons only work once the dedicated campaign bot owns the traffic —
  // on the fallback (Thadius) bot, taps would go to OpenClaw's poller and
  // die. Suppress them until CAMPAIGN_BOT_TOKEN exists.
  const markup = opts?.buttons?.length && process.env.CAMPAIGN_BOT_TOKEN
    ? { reply_markup: { inline_keyboard: [opts.buttons.map((b) => ({ text: b.text, callback_data: b.data }))] } }
    : {}

  try {
    const res = await post({ chat_id: chatId, text, parse_mode: "HTML", ...markup })
    if (res.ok) {
      const json = (await res.json().catch(() => null)) as { result?: { message_id?: number } } | null
      return json?.result?.message_id ?? null
    }
    const detail = await res.text()
    // Formatting rejection → strip tags, resend plain. Degraded > lost.
    const plain = await post({ chat_id: chatId, text: text.replace(/<[^>]+>/g, ""), ...markup })
    if (plain.ok) {
      await recordFailure(`HTML rejected (${res.status}: ${detail.slice(0, 200)}) — delivered as plain text instead`)
      return null
    }
    await recordFailure(`${res.status}: ${detail.slice(0, 200)} (plain-text retry also failed: ${plain.status})`)
  } catch (e) {
    await recordFailure(e instanceof Error ? e.message : String(e))
  }
  return null
}

/**
 * Post a file to the campaign Telegram chat (agent reply attachments,
 * 2026-10-02 — Grail's 707 Hyde flyer was invisible in the alert). Images go
 * as photos (inline preview), everything else as a document. Threads under
 * `replyTo` (the reply alert's message_id) when given. Telegram's bot upload
 * cap is 50 MB; larger files are reported, not sent. Same no-silent-failure
 * contract as sendCampaignAlert.
 */
export async function sendCampaignDocument(
  sb: SupabaseClient,
  file: { filename: string; mime: string; bytes: Buffer },
  caption: string,
  opts?: { replyTo?: number | null }
): Promise<boolean> {
  const token = process.env.CAMPAIGN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  const recordFailure = async (detail: string) => {
    try {
      await sb.from("campaign_events").insert({ kind: "note", triage: "alert_failure", body: `Telegram attachment failed (${file.filename}): ${detail}\n---\n${caption.slice(0, 300)}` })
    } catch { /* never break the pipeline */ }
  }
  if (!token || !chatId) { await recordFailure("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing in env"); return false }
  if (file.bytes.length > 49 * 1024 * 1024) {
    await sendCampaignAlert(sb, `📎 ${caption} — ${(file.bytes.length / 1048576).toFixed(0)} MB, over Telegram's 50 MB bot limit; open it in Gmail.`, undefined)
    return false
  }
  const isImage = /^image\/(jpeg|png|gif|webp)$/i.test(file.mime) && file.bytes.length < 10 * 1024 * 1024
  const method = isImage ? "sendPhoto" : "sendDocument"
  const form = new FormData()
  form.append("chat_id", chatId)
  form.append(isImage ? "photo" : "document", new Blob([new Uint8Array(file.bytes)], { type: file.mime || "application/octet-stream" }), file.filename)
  form.append("caption", caption.slice(0, 1000))
  if (opts?.replyTo) form.append("reply_to_message_id", String(opts.replyTo))
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", body: form })
    if (res.ok) return true
    const detail = await res.text()
    if (isImage) {
      // Telegram rejects some images as photos (dimensions/ratio); fall back to a plain file.
      const form2 = new FormData()
      form2.append("chat_id", chatId)
      form2.append("document", new Blob([new Uint8Array(file.bytes)], { type: file.mime }), file.filename)
      form2.append("caption", caption.slice(0, 1000))
      if (opts?.replyTo) form2.append("reply_to_message_id", String(opts.replyTo))
      const res2 = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: form2 })
      if (res2.ok) return true
      await recordFailure(`${res.status}: ${detail.slice(0, 200)} (document retry: ${res2.status})`)
      return false
    }
    await recordFailure(`${res.status}: ${detail.slice(0, 200)}`)
  } catch (e) {
    await recordFailure(e instanceof Error ? e.message : String(e))
  }
  return false
}
