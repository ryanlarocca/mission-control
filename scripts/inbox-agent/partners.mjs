// Inbox Agent — partners@lrghomes.com watcher. partners@ is an alias on ryan@
// (Gmail filter: label "Partners", skip the inbox), printed on the 261 Bieber
// rent notice as the contact email. Nothing reads that label, so every message
// to it gets one Telegram line. Seen ids live in inbox_settings "partners_watch".
import { getMessage, listMessageIds } from "./gmail.mjs"
import { getSetting, log, setSetting, warn } from "./env.mjs"
import { esc, tgSend } from "./telegram.mjs"
import { gmailLink } from "./photos.mjs"

const ADDRESS = "partners@lrghomes.com"
const QUERY = `(deliveredto:${ADDRESS} OR to:${ADDRESS} OR cc:${ADDRESS}) -from:me newer_than:7d`
const SEEN_CAP = 300

export async function watchPartners(ctx, { dry = false } = {}) {
  const state = await getSetting("partners_watch")
  const seen = new Set(state.seen || [])
  const ids = await listMessageIds(ctx.gmail, QUERY, 50)
  const fresh = ids.filter((id) => !seen.has(id)).reverse() // oldest first
  if (!fresh.length) return
  for (const id of fresh) {
    try {
      const m = await getMessage(ctx.gmail, id)
      const who = m.from.name ? `${m.from.name} (${m.from.email})` : m.from.email
      const body = (m.text || m.snippet || "").replace(/\s+/g, " ").trim().slice(0, 300)
      const lines = [
        `📬 <b>partners@ email</b> from ${esc(who)}`,
        `<b>${esc(m.subject || "(no subject)")}</b>`,
        body ? esc(body) : null,
        `<a href="${gmailLink(m.id)}">Open in Gmail</a>`,
      ].filter(Boolean)
      if (dry) console.log("---- PARTNERS TELEGRAM (dry run) ----\n" + lines.join("\n"))
      else if ((await tgSend(lines.join("\n"))) == null) throw new Error("telegram send failed — retry next pass")
      seen.add(id)
    } catch (e) {
      warn("partners watch:", id, e.message)
    }
  }
  if (!dry) await setSetting("partners_watch", { seen: [...seen].slice(-SEEN_CAP), checked_at: new Date().toISOString() })
  log(`partners watch: ${fresh.length} new`)
}
