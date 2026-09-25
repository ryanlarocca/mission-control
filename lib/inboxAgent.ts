import Anthropic from "@anthropic-ai/sdk"
import { getLeadsClient } from "@/lib/leads"
import { HAIKU, SONNET, completeText, extractJsonObject } from "@/lib/llm"
import { fetchAttachment, fetchInboxMessage, fetchInboxThread, renderThread, searchInbox, sendThreadedReply } from "@/lib/inboxGmail"
import { VOICE_SYSTEM } from "@/lib/reply/draft"

// Inbox Agent — the Vercel half (briefs/BRIEF_INBOX_AGENT_2026-09-24.md).
//
// The Mac mini worker (scripts/inbox-agent/index.mjs) reads ryan@lrghomes.com,
// proposes where each attachment goes in Drive, screens deals, tracks open
// loops, and posts cards to the Marketing Telegram bot. Ryan's taps, replies
// and typed commands land on the bot webhook (app/api/campaign/telegram/
// route.ts), which runs on Vercel and calls this module.
//
// Split of labour: anything that needs Drive or the model + a big PDF the
// worker does on its next pass (≤5 min) after this module records the
// decision in Supabase. Anything Ryan expects an instant answer to
// (commands, questions about a thread, deal follow-ups) is done here.
//
// callback_data namespace — everything starts with "ix:" (no collisions with
// the campaign / reply-planner prefixes):
//   ix:fa:<file>  approve         ix:fc:<file>  change (reply expected)
//   ix:fs:<file>  skip            ix:fm:<file>  make this rule manual again
//   ix:fu:<file>  undo a filing   ix:ba/bp/bs:<gmail_id> batch approve-all / pick / skip-all
//   ix:io:<iv>    setup: use guess   ix:is:<iv>  setup: skip
//   ix:ro / ix:rn convention approved / needs changes
//   ix:ld:<loop>  done            ix:lz:<loop>  snooze 2 days
//   ix:sl:<scr>   look further    ix:sp:<scr>   pass
//   ix:rm:<rule>  rule → manual (weekly teach-back)
//   ix:sr:<scr>   draft a reply to the deal email (slow → route runs it in waitUntil)
//   ix:ds:<draft> send   ix:de:<draft> edit (reply expected)   ix:dd:<draft> dismiss

export const INBOX_CB_PREFIX = "ix:"
const UUID = "[0-9a-f-]{36}"
const GMAIL_ID = "[0-9a-f]{10,20}"
const UNDO_WINDOW_MS = 24 * 3600_000

export interface InboxCallbackResult {
  toast: string
  text?: string
  clearButtons?: boolean
  buttons?: Array<Array<{ text: string; data: string }>>
}

export type InboxRef =
  | { kind: "file"; id: string; status: string; gmail_id: string; thread_id: string | null }
  | { kind: "batch"; gmail_id: string; thread_id: string | null }
  | { kind: "interview"; id: string; status: string; gmail_id: string | null; thread_id: string | null }
  | { kind: "rules" }
  | { kind: "loop"; id: string; gmail_id: string | null; thread_id: string | null }
  | { kind: "screen"; id: string; gmail_id: string | null; thread_id: string | null }
  | { kind: "draft"; id: string; status: string; gmail_id: string | null; thread_id: string | null }
  | { kind: "teachback" }

// ------------------------------------------------------------- settings
async function getSetting(key: string): Promise<Record<string, unknown>> {
  const sb = getLeadsClient()
  const { data } = await sb.from("inbox_settings").select("value").eq("key", key).maybeSingle()
  return (data?.value as Record<string, unknown>) || {}
}
async function setSetting(key: string, value: Record<string, unknown>): Promise<void> {
  const sb = getLeadsClient()
  const merged = { ...(await getSetting(key)), ...value }
  await sb.from("inbox_settings").upsert({ key, value: merged, updated_at: new Date().toISOString() })
}
function ago(iso: string | null | undefined): string {
  if (!iso) return ""
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  return d <= 0 ? "today" : d === 1 ? "1d" : `${d}d`
}
function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// ------------------------------------------------------------- which card?
/** Which inbox-agent card did Ryan reply to? Checked by the webhook before
 *  any branch that could text a lead, exactly like the Reply Planner lookup. */
export async function findInboxByTgMessage(tgMessageId: number): Promise<InboxRef | null> {
  const sb = getLeadsClient()
  const [file, iv, loop, screen, rules, agent, draft] = await Promise.all([
    sb.from("inbox_files").select("id, status, gmail_id, thread_id").eq("tg_message_id", tgMessageId).limit(5),
    sb.from("inbox_interview").select("id, status, inbox_files(gmail_id, thread_id)").eq("tg_message_id", tgMessageId).maybeSingle(),
    sb.from("inbox_loops").select("id, gmail_id, thread_id").eq("tg_message_id", tgMessageId).maybeSingle(),
    sb.from("inbox_deal_screens").select("id, gmail_id").eq("tg_message_id", tgMessageId).maybeSingle(),
    getSetting("rules"),
    getSetting("agent"),
    sb.from("inbox_drafts").select("id, status, gmail_id, thread_id").eq("tg_message_id", tgMessageId).maybeSingle(),
  ])
  if (draft.data) return { kind: "draft", id: draft.data.id, status: draft.data.status, gmail_id: draft.data.gmail_id, thread_id: draft.data.thread_id }
  if (file.data?.length) {
    const f = file.data[0]
    if (file.data.length > 1 || f.status === "batch") return { kind: "batch", gmail_id: f.gmail_id, thread_id: f.thread_id }
    return { kind: "file", id: f.id, status: f.status, gmail_id: f.gmail_id, thread_id: f.thread_id }
  }
  if (iv.data) {
    const f = (iv.data as unknown as { inbox_files?: { gmail_id: string; thread_id: string | null } }).inbox_files
    return { kind: "interview", id: iv.data.id, status: iv.data.status, gmail_id: f?.gmail_id || null, thread_id: f?.thread_id || null }
  }
  if (loop.data) return { kind: "loop", id: loop.data.id, gmail_id: loop.data.gmail_id, thread_id: loop.data.thread_id }
  if (screen.data) return { kind: "screen", id: screen.data.id, gmail_id: screen.data.gmail_id, thread_id: null }
  if (rules && Number(rules.tg_message_id) === tgMessageId) return { kind: "rules" }
  if (agent && Number(agent.teachback_tg_message_id) === tgMessageId) return { kind: "teachback" }
  return null
}

// ------------------------------------------------------------- questions vs corrections
const QUESTION_RE = /\?\s*$|^(what|what's|whats|when|who|who's|where|why|how|did|does|do|is|are|can|could|was|were|which|has|have|any|tell me|remind me|summar(y|ize|ise)|show me|explain)\b/i
export function looksLikeQuestion(text: string): boolean {
  return QUESTION_RE.test(text.trim())
}

async function threadTextFor(ref: InboxRef): Promise<{ text: string; subject: string; link: string } | null> {
  const threadId = "thread_id" in ref ? ref.thread_id : null
  const gmailId = "gmail_id" in ref ? ref.gmail_id : null
  if (threadId) {
    const msgs = await fetchInboxThread(threadId)
    if (msgs.length) return { text: renderThread(msgs), subject: msgs[0].subject, link: msgs[msgs.length - 1].link }
  }
  if (gmailId) {
    const m = await fetchInboxMessage(gmailId)
    const msgs = m.threadId ? await fetchInboxThread(m.threadId) : [m]
    return { text: renderThread(msgs), subject: m.subject, link: m.link }
  }
  return null
}

/** Ryan asked a question on a card → answer from the underlying thread. */
export async function answerInboxQuestion(ref: InboxRef, question: string): Promise<string> {
  if (ref.kind === "rules") {
    const r = await getSetting("rules")
    const out = await completeText({ model: HAIKU, maxTokens: 500, tag: "[inbox-q]", prompt: `Ryan is asking about his Drive filing convention.\n\nCONVENTION:\n"""\n${String(r.md || "(none yet)")}\n"""\n\nQUESTION: ${question}\n\nAnswer in ≤ 6 short lines, plain text, no markdown.` })
    return out.text || "I don't have an answer for that."
  }
  if (ref.kind === "teachback") return "Reply to a specific card, or type `rules` to see the convention."
  const t = await threadTextFor(ref)
  if (!t) return "I can't find the email behind that card."
  const out = await completeText({
    model: HAIKU, maxTokens: 600, tag: "[inbox-q]",
    system: "You answer Ryan LaRocca's questions about one email thread from his real-estate business. Use only the thread; if it isn't there, say so. Plain text, ≤ 8 short lines, no markdown, no preamble. Quote the exact figure/date when there is one.",
    prompt: `THREAD “${t.subject}”:\n${t.text}\n\nQUESTION: ${question}`,
  })
  return `${out.text || "Nothing in the thread answers that."}\n${t.link}`
}

// ------------------------------------------------------------- replies (corrections / answers)
export async function recordInboxReply(ref: InboxRef, text: string): Promise<string> {
  const sb = getLeadsClient()
  const now = new Date().toISOString()
  const body = text.trim()
  if (!body) return "⚠️ Empty reply — nothing recorded."
  switch (ref.kind) {
    case "file": {
      if (ref.status === "filed") return "That one's already filed — tap ↩️ Undo on the confirmation, or reply to a pending proposal to change it."
      await sb.from("inbox_files").update({ status: "changed", change_text: body, resolved_at: now }).eq("id", ref.id)
      return "✏️ Got it — filing it there on the next pass (≤5 min) and remembering the rule."
    }
    case "batch": {
      await sb.from("inbox_files").update({ status: "changed", change_text: body, resolved_at: now }).eq("gmail_id", ref.gmail_id).in("status", ["batch", "pending", "waiting"])
      return "✏️ Applying that to every file in the batch on the next pass. Tap “Pick individually” first if they should go different places."
    }
    case "interview": {
      const { data: row } = await sb.from("inbox_interview").update({ answer_text: body, answer_kind: "custom", status: "answered", answered_at: now }).eq("id", ref.id).select("seq").maybeSingle()
      return row?.seq == null ? "📝 Got it — I'll remember that and act on it in the next pass." : "📝 Noted. Next one coming up."
    }
    case "rules": {
      await setSetting("rules", { feedback: body, status: "revise", feedback_at: now })
      return "✏️ I'll rework the convention with that and show you the new version."
    }
    case "loop": {
      const lower = body.toLowerCase()
      if (/^(done|handled|did it|resolved|✓|✅)\b/.test(lower)) {
        await sb.from("inbox_loops").update({ status: "done", resolved_at: now }).eq("id", ref.id)
        return "✅ Marked done."
      }
      const snooze = /^snooze\s*(\d+)?\s*(d|day|days|w|week|weeks)?/.exec(lower)
      if (snooze) {
        const n = Number(snooze[1] || 2)
        const days = /^w/.test(snooze[2] || "") ? n * 7 : n
        const until = new Date(Date.now() + days * 86_400_000).toISOString()
        await sb.from("inbox_loops").update({ status: "snoozed", snooze_until: until }).eq("id", ref.id)
        return `⏰ Snoozed ${days} day${days === 1 ? "" : "s"}.`
      }
      await sb.from("inbox_loops").update({ ask: body }).eq("id", ref.id)
      return "📝 Updated the note on that item. (Reply done / snooze 3d to close or defer.)"
    }
    case "screen": {
      return followUpOnScreen(ref.id, body)
    }
    case "draft": {
      if (ref.status === "sent") return "That one already went out."
      if (ref.status !== "draft") return "That draft was replaced — reply to the newest version."
      return redraftDealReply(ref.id, body)
    }
    case "teachback":
      return "Tap a “Make manual” button, or type `rules`."
  }
}

// ------------------------------------------------------------- deal follow-ups (Sonnet + the OM)
const SCREEN_FOLLOWUP_SYSTEM = `You are Ryan LaRocca's deal analyst. He buys small multifamily in Santa Clara County at a discount to nearby per-door comps with hard money and two exits (refi or sell). He already saw the first screen; now he's asking a follow-up on the same deal. Use the OM/flyer and the email thread; say "not stated" when the document lacks a number. Never present your estimates as verified facts. If he asks for questions to send the agent, draft them as a numbered list he can paste — he sends them himself. Plain text, ≤ 14 short lines, no markdown.`

export async function followUpOnScreen(screenId: string, ask: string): Promise<string> {
  const sb = getLeadsClient()
  const { data: scr } = await sb.from("inbox_deal_screens").select("*").eq("id", screenId).maybeSingle()
  if (!scr) return "Can't find that screen."
  if (!scr.gmail_id) return "That screen has no email behind it."
  const msg = await fetchInboxMessage(scr.gmail_id)
  const thread = msg.threadId ? await fetchInboxThread(msg.threadId) : [msg]
  const content: Anthropic.MessageParam["content"] = []
  let bytes = 0
  for (const a of msg.attachments.filter((x) => /pdf$/i.test(x.mime) || /\.pdf$/i.test(x.filename)).slice(0, 2)) {
    if (a.size > 12 * 1024 * 1024 || bytes + a.size > 20 * 1024 * 1024) continue
    const buf = await fetchAttachment(msg.id, a.attachmentId)
    bytes += buf.length
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") }, title: a.filename })
  }
  const facts = (scr.facts as Record<string, unknown>) || {}
  const prior = Array.isArray(facts.followups) ? (facts.followups as Array<{ q: string; a: string }>) : []
  content.push({
    type: "text",
    text: `DEAL: ${scr.address || "?"} (${scr.tier}) · first screen: ${scr.verdict} — ${scr.summary}\nFACTS FROM FIRST SCREEN: ${JSON.stringify({ ...facts, followups: undefined })}\n${prior.length ? `EARLIER FOLLOW-UPS:\n${prior.map((p) => `Q: ${p.q}\nA: ${p.a}`).join("\n")}\n` : ""}\nEMAIL THREAD:\n${renderThread(thread, 8000)}\n\nRYAN'S FOLLOW-UP: ${ask}`,
  })
  const client = new Anthropic()
  const res = await client.messages.create({ model: SONNET, max_tokens: 4096, system: SCREEN_FOLLOWUP_SYSTEM, messages: [{ role: "user", content }] })
  const answer = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("").trim() || "No answer."
  await sb.from("inbox_deal_screens").update({ facts: { ...facts, followups: [...prior, { q: ask, a: answer, at: new Date().toISOString() }] } }).eq("id", screenId)
  return answer
}

// ------------------------------------------------------------- button taps
export async function handleInboxCallback(data: string): Promise<InboxCallbackResult> {
  const sb = getLeadsClient()
  const now = new Date().toISOString()
  let m: RegExpExecArray | null

  if ((m = new RegExp(`^ix:fa:(${UUID})$`).exec(data))) {
    const { data: row } = await sb.from("inbox_files").select("status, proposed_folder, proposed_name").eq("id", m[1]).maybeSingle()
    if (!row) return { toast: "Not found" }
    if (row.status === "filed") return { toast: "Already filed", clearButtons: true }
    if (!["pending", "waiting", "batch"].includes(row.status)) return { toast: `Already ${row.status}`, clearButtons: true }
    await sb.from("inbox_files").update({ status: "approved", resolved_at: now }).eq("id", m[1])
    return { toast: "Approved", clearButtons: true, text: `✅ Filing → ${row.proposed_folder}/${row.proposed_name} (next pass, ≤5 min)` }
  }
  if ((m = new RegExp(`^ix:fc:(${UUID})$`).exec(data))) {
    await sb.from("inbox_files").update({ status: "change_requested" }).eq("id", m[1]).in("status", ["pending", "waiting", "batch"])
    return { toast: "Reply with the folder + name", text: "✏️ Reply to the proposal with where it goes and what to call it — e.g. “Properties/93 Ridgeview/Addendum A.pdf”, or just “Halleck folder, keep the name”." }
  }
  if ((m = new RegExp(`^ix:fs:(${UUID})$`).exec(data))) {
    await sb.from("inbox_files").update({ status: "skipped", resolved_at: now }).eq("id", m[1]).in("status", ["pending", "waiting", "change_requested", "batch"])
    return { toast: "Skipped", clearButtons: true, text: "⏭ Skipped — not filed." }
  }
  if ((m = new RegExp(`^ix:fm:(${UUID})$`).exec(data))) {
    const { data: row } = await sb.from("inbox_files").select("rule_id").eq("id", m[1]).maybeSingle()
    if (row?.rule_id) {
      await sb.from("inbox_rules").update({ mode: "manual", approvals_in_row: 0, updated_at: now }).eq("id", row.rule_id)
      return { toast: "Rule is manual again", clearButtons: true, text: "↩️ That rule is back to manual — I'll ask before filing those." }
    }
    return { toast: "No rule attached", clearButtons: true }
  }
  if ((m = new RegExp(`^ix:fu:(${UUID})$`).exec(data))) {
    const { data: row } = await sb.from("inbox_files").select("status, filed_at, final_name").eq("id", m[1]).maybeSingle()
    if (!row || row.status !== "filed") return { toast: row ? `Already ${row.status}` : "Not found", clearButtons: true }
    if (row.filed_at && Date.now() - new Date(row.filed_at).getTime() > UNDO_WINDOW_MS) return { toast: "Undo window (24h) passed", clearButtons: true }
    await sb.from("inbox_files").update({ status: "undo_requested" }).eq("id", m[1])
    return { toast: "Undoing", clearButtons: true, text: `↩️ Moving “${row.final_name}” to Properties/_Unsorted and forgetting what it taught (next pass).` }
  }
  if ((m = new RegExp(`^ix:ba:(${GMAIL_ID})$`).exec(data))) {
    const { data: rows } = await sb.from("inbox_files").update({ status: "approved", resolved_at: now }).eq("gmail_id", m[1]).eq("status", "batch").select("id")
    return { toast: `Approved ${rows?.length ?? 0}`, clearButtons: true, text: `✅ Filing all ${rows?.length ?? 0} on the next pass.` }
  }
  if ((m = new RegExp(`^ix:bp:(${GMAIL_ID})$`).exec(data))) {
    await sb.from("inbox_files").update({ status: "pending_post", tg_message_id: null }).eq("gmail_id", m[1]).eq("status", "batch")
    return { toast: "Splitting", clearButtons: true, text: "🗂 One card per file coming on the next pass." }
  }
  if ((m = new RegExp(`^ix:bs:(${GMAIL_ID})$`).exec(data))) {
    await sb.from("inbox_files").update({ status: "skipped", resolved_at: now }).eq("gmail_id", m[1]).eq("status", "batch")
    return { toast: "Skipped all", clearButtons: true }
  }
  if ((m = new RegExp(`^ix:io:(${UUID})$`).exec(data))) {
    await sb.from("inbox_interview").update({ answer_kind: "accepted", status: "answered", answered_at: now }).eq("id", m[1])
    return { toast: "Got it", clearButtons: true, text: "👍 Using my guess. Next one coming up." }
  }
  if ((m = new RegExp(`^ix:is:(${UUID})$`).exec(data))) {
    await sb.from("inbox_interview").update({ answer_kind: "skipped", status: "skipped", answered_at: now }).eq("id", m[1])
    return { toast: "Skipped", clearButtons: true }
  }
  if (data === "ix:ro") {
    await setSetting("rules", { status: "approved", approved_at: now })
    return { toast: "Rules approved", clearButtons: true, text: "📐 Convention locked in. Filing proposals start on the next pass — training mode, I'll ask before every upload." }
  }
  if (data === "ix:rn") return { toast: "Reply with the changes", text: "✏️ Reply to the convention message with what's off and I'll redo it." }
  if ((m = new RegExp(`^ix:ld:(${UUID})$`).exec(data))) {
    await sb.from("inbox_loops").update({ status: "done", resolved_at: now }).eq("id", m[1])
    return { toast: "Done", clearButtons: true }
  }
  if ((m = new RegExp(`^ix:lz:(${UUID})$`).exec(data))) {
    const until = new Date(Date.now() + 2 * 86_400_000).toISOString()
    await sb.from("inbox_loops").update({ status: "snoozed", snooze_until: until }).eq("id", m[1])
    return { toast: "Snoozed 2 days", clearButtons: true }
  }
  if ((m = new RegExp(`^ix:sl:(${UUID})$`).exec(data))) {
    await sb.from("inbox_deal_screens").update({ ryan_verdict: "look" }).eq("id", m[1])
    return { toast: "Marked: look further", text: "👀 Marked “look further”. Reply to the card with what you want dug into — rents, comps, questions for the agent — and I'll come back on this thread." }
  }
  if ((m = new RegExp(`^ix:sp:(${UUID})$`).exec(data))) {
    await sb.from("inbox_deal_screens").update({ ryan_verdict: "pass" }).eq("id", m[1])
    return { toast: "Pass (nothing sent)", clearButtons: true }
  }
  if ((m = new RegExp(`^ix:ds:(${UUID})$`).exec(data))) {
    const out = await sendInboxDraft(m[1])
    return out.ok ? { toast: "Sent", clearButtons: true, text: `✅ Sent to ${out.to}. ${out.link}` } : { toast: "Not sent", text: `⚠️ Not sent — ${out.error}` }
  }
  if ((m = new RegExp(`^ix:de:(${UUID})$`).exec(data))) {
    return { toast: "Reply with the changes", text: "✏️ Reply to the draft with what to change (\"shorter\", \"mention I can close in 14 days\", or paste your own wording) and I'll post v2." }
  }
  if ((m = new RegExp(`^ix:dd:(${UUID})$`).exec(data))) {
    await sb.from("inbox_drafts").update({ status: "dismissed" }).eq("id", m[1]).eq("status", "draft")
    return { toast: "Dismissed", clearButtons: true }
  }
  if ((m = new RegExp(`^ix:rm:(${UUID})$`).exec(data))) {
    await sb.from("inbox_rules").update({ mode: "manual", approvals_in_row: 0, updated_at: now }).eq("id", m[1])
    return { toast: "Rule is manual again", text: "↩️ Back to asking for that pattern." }
  }
  return { toast: "Unknown inbox action" }
}

// ------------------------------------------------------------- typed commands
const HELP = [
  "📬 Inbox agent commands:",
  "inbox — status line",
  "open — everything waiting on you",
  "file <address> — what's filed for a property",
  "find <words or a description> — search the inbox (“the net sheet Lisa sent last week”)",
  "rules — resend the filing convention",
  "screen <pasted listing text> — screen a deal",
  "inbox pause / inbox resume",
  "inbox alerts off|deadline|high — per-email pings for things people need from you (default off)",
  "Reply to any card with a question and I'll answer from the thread.",
].join("\n")

/** Returns the reply text for a typed command, or null if `body` isn't one. */
export async function handleInboxCommand(body: string): Promise<{ text: string; buttons?: Array<Array<{ text: string; data: string }>> } | null> {
  const sb = getLeadsClient()
  const t = body.trim()
  let m: RegExpExecArray | null

  if (/^(inbox|inbox help|inbox\?)$/i.test(t) || /^inbox status$/i.test(t)) {
    const [agent, rules, drive, loops, pending, waiting, iv] = await Promise.all([
      getSetting("agent"), getSetting("rules"), getSetting("drive"),
      sb.from("inbox_loops").select("id", { count: "exact", head: true }).eq("status", "open"),
      sb.from("inbox_files").select("id", { count: "exact", head: true }).in("status", ["pending", "batch", "change_requested"]),
      sb.from("inbox_files").select("id", { count: "exact", head: true }).eq("status", "waiting"),
      sb.from("inbox_interview").select("id", { count: "exact", head: true }).in("status", ["pending", "asked"]),
    ])
    const lines = [
      `📬 <b>Inbox agent</b> — ${agent.paused ? "⏸ paused" : "▶️ running"} · watching since ${String(agent.started_at || "?").slice(0, 10)}`,
      `Convention: ${rules.status || "not started"}${iv.count ? ` · ${iv.count} setup question${iv.count === 1 ? "" : "s"} left` : ""}`,
      `Drive: ${drive.root_id ? "connected" : "not connected yet (share + scope)"}`,
      `Waiting on you: ${loops.count ?? 0} open · ${pending.count ?? 0} filing proposal${pending.count === 1 ? "" : "s"}${waiting.count ? ` · ${waiting.count} queued for the convention` : ""}`,
      "",
      HELP,
    ]
    return { text: lines.join("\n") }
  }
  if (/^inbox (pause|stop)$/i.test(t) || /^(pause|stop) inbox$/i.test(t)) {
    await setSetting("agent", { paused: true, paused_at: new Date().toISOString() })
    return { text: "⏸ Inbox agent paused. Cards already posted still work; nothing new until you say “inbox resume”." }
  }
  if ((m = /^inbox alerts\s+(off|deadline|high)$/i.exec(t))) {
    await setSetting("agent", { loop_alerts: m[1].toLowerCase() })
    const why = { off: "no per-email pings — open items show in the 7:30 brief and `open`", deadline: "ping only when something is due within 24 hours", high: "ping on every high-priority ask" }[m[1].toLowerCase() as "off" | "deadline" | "high"]
    return { text: `🔔 Loop alerts: <b>${m[1].toLowerCase()}</b> — ${why}.` }
  }
  if (/^inbox (resume|start)$/i.test(t) || /^(resume|start) inbox$/i.test(t)) {
    await setSetting("agent", { paused: false })
    return { text: "▶️ Inbox agent resumed." }
  }
  if (/^open$/i.test(t) || /^(what's|whats|what is) (open|waiting)/i.test(t)) {
    const { data } = await sb.from("inbox_loops").select("*").eq("status", "open").order("priority").order("created_at")
    if (!data?.length) return { text: "✅ Nothing waiting on you." }
    const lines = [`<b>Waiting on you (${data.length})</b>`]
    for (const l of data.slice(0, 15)) lines.push(`${l.priority === "high" ? "🔴" : "•"} ${esc(l.counterparty)} — ${esc(l.ask)}${l.due_on ? ` · due ${esc(l.due_on)}` : ""} · ${ago(l.created_at)}`)
    if (data.length > 15) lines.push(`… +${data.length - 15} more`)
    lines.push("Reply “done” or “snooze 3d” on the original card, or tap its buttons.")
    return { text: lines.join("\n") }
  }
  if (/^rules$/i.test(t)) {
    const r = await getSetting("rules")
    if (!r.md) return { text: `📐 No convention yet — status: ${r.status || "not started"}. Answer the setup questions and I'll write it.` }
    const md = String(r.md)
    return { text: `📐 <b>Filing convention</b> (${r.status})\n<pre>${esc(md.slice(0, 3500))}</pre>${md.length > 3500 ? "\n…(truncated — full copy in briefs/INBOX_FILING_RULES.md)" : ""}` }
  }
  if ((m = /^file\s+(.+)$/i.exec(t))) {
    const q = m[1].trim()
    const { data } = await sb.from("inbox_files").select("final_folder, final_name, drive_url, filed_at, property_label, doc_type, status, proposed_folder, proposed_name").or(`property_label.ilike.%${q}%,final_folder.ilike.%${q}%,filename.ilike.%${q}%`).order("received_at", { ascending: false }).limit(25)
    if (!data?.length) return { text: `Nothing filed or pending for “${esc(q)}”.` }
    const filed = data.filter((f) => f.status === "filed")
    const pending = data.filter((f) => ["pending", "batch", "waiting", "change_requested"].includes(f.status))
    const lines = [`🗂 <b>${esc(q)}</b>`]
    for (const f of filed) lines.push(`• <a href="${f.drive_url}">${esc(f.final_name)}</a> — ${esc(f.final_folder)} · ${ago(f.filed_at)}`)
    if (pending.length) lines.push(`Pending: ${pending.map((p) => esc(p.proposed_name || p.final_name || "?")).join(", ")}`)
    return { text: lines.join("\n") }
  }
  if ((m = /^find\s+(.+)$/i.exec(t))) {
    // Plain-English descriptions ("the net sheet Lisa sent last week") are
    // turned into a Gmail query by Haiku; anything that already looks like
    // Gmail syntax (from:, has:, quotes, newer_than:) runs as-is.
    const ask = m[1].trim()
    const looksLikeSyntax = /\b(from|to|subject|has|filename|newer_than|older_than|after|before|label|in|is):/i.test(ask) || ask.split(/\s+/).length <= 2
    let q = ask
    if (!looksLikeSyntax) {
      const today = new Date().toISOString().slice(0, 10)
      const out = await completeText({
        model: HAIKU, maxTokens: 200, tag: "[inbox-find]",
        system: `Translate a plain-English description of an email into ONE Gmail search query. Today is ${today}. Use from:, to:, subject:, has:attachment, filename:, newer_than:Nd, after:YYYY/MM/DD and quoted phrases. Prefer few, distinctive terms over many. People: use a name fragment (from:lisa) not a guessed address. Escrow/title people are at ctt.com; lenders kiavi.com. Respond with the query only.`,
        prompt: ask,
      })
      q = out.text.trim().replace(/^`+|`+$/g, "") || ask
    }
    const rows = await searchInbox(q, 8)
    if (!rows.length) return { text: `No emails match “${esc(ask)}” (searched: <code>${esc(q)}</code>). Try different words or Gmail syntax like from:lisa newer_than:14d.` }
    const lines = [`🔎 <b>${esc(ask)}</b>${q !== ask ? ` · <code>${esc(q)}</code>` : ""}`]
    for (const r of rows) lines.push(`• <a href="${r.link}">${esc(r.subject || "(no subject)")}</a> — ${esc(r.from.replace(/<.*>/, "").trim())} · ${ago(r.date)}${r.attachments.length ? ` · 📎 ${esc(r.attachments.slice(0, 3).join(", "))}` : ""}`)
    return { text: lines.join("\n") }
  }
  if ((m = /^screen\s+([\s\S]{20,})$/i.exec(t))) {
    const out = await completeText({
      model: SONNET, maxTokens: 1500, tag: "[inbox-screen]",
      system: "You are Ryan LaRocca's deal screener for small multifamily in Santa Clara County. Screen: units + mix; price per door vs the 2026 ladder (downtown SJ ≈ $200k/door target; Milpitas 2/1 4-plex $300–325k; Sunnyvale 6-plex $358k in / $445k out); 4→5 unit lending cliff; GRM (~10–12× for 5+); 1% rule as aspiration; rent-increase room; ≥10% cushion to comp. Retail-priced = straight pass in one line. Never present your estimates as verified. Respond in JSON only: {\"address\":\"\",\"units\":null,\"asking\":null,\"price_per_door\":null,\"verdict\":\"pass|look_further|unknown\",\"one_liner\":\"\",\"reasons\":[]}",
      prompt: `LISTING TEXT:\n${m[1].trim().slice(0, 6000)}`,
    })
    try {
      const j = JSON.parse(extractJsonObject(out.text)) as { address?: string; units?: number; asking?: number; price_per_door?: number; verdict?: string; one_liner?: string; reasons?: string[] }
      const money = (n?: number | null) => (n ? `$${Math.round(n).toLocaleString()}` : "n/a")
      const { data } = await sb.from("inbox_deal_screens").insert({ address: j.address || null, tier: "manual", facts: j, verdict: j.verdict || "unknown", summary: j.one_liner || null }).select("id").single()
      const lines = [`🧮 <b>${esc(j.address || "?")}</b> · ${j.units ?? "?"} units · asking ${money(j.asking)} · ${money(j.price_per_door)}/door`, `<b>${j.verdict === "pass" ? "PASS" : j.verdict === "look_further" ? "LOOK FURTHER" : "UNCLEAR"}</b> — ${esc(j.one_liner || "")}`, ...(j.reasons || []).slice(0, 4).map((r) => `• ${esc(r)}`)]
      return { text: lines.join("\n"), buttons: data ? [[{ text: "👀 Look further", data: `ix:sl:${data.id}` }, { text: "🚫 Pass", data: `ix:sp:${data.id}` }]] : undefined }
    } catch {
      return { text: out.text.slice(0, 3000) }
    }
  }
  return null
}

// ------------------------------------------------------------- setup questions, instantly
// The worker asks one setup question per pass (5 min), which felt slow to
// Ryan (2026-09-24). So the webhook advances the queue itself the moment he
// answers: post the next question now; when the queue is empty, write the
// convention (Sonnet, ~30-60 s, run inside waitUntil) and post it as a file.
// The worker's interviewStep stays as the fallback and skips anything already
// "asked" / "generating".

function tgToken(): string | undefined {
  return process.env.CAMPAIGN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN
}
async function tgSendHtml(text: string, buttons?: Array<Array<{ text: string; data: string }>>): Promise<number | null> {
  const token = tgToken()
  const chat = process.env.TELEGRAM_CHAT_ID
  if (!token || !chat) return null
  const body: Record<string, unknown> = { chat_id: chat, text: text.slice(0, 4000), parse_mode: "HTML", disable_web_page_preview: true }
  if (buttons?.length) body.reply_markup = { inline_keyboard: buttons.map((r) => r.map((b) => ({ text: b.text, callback_data: b.data }))) }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  const json = (await res.json()) as { ok?: boolean; result?: { message_id?: number } }
  return json.ok ? json.result?.message_id ?? null : null
}
async function tgSendMarkdownFile(filename: string, content: string, caption: string, buttons: Array<Array<{ text: string; data: string }>>): Promise<number | null> {
  const token = tgToken()
  const chat = process.env.TELEGRAM_CHAT_ID
  if (!token || !chat) return null
  const form = new FormData()
  form.append("chat_id", chat)
  form.append("document", new Blob([content], { type: "text/markdown" }), filename)
  form.append("caption", caption.slice(0, 1000))
  form.append("reply_markup", JSON.stringify({ inline_keyboard: buttons.map((r) => r.map((b) => ({ text: b.text, callback_data: b.data }))) }))
  const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: form })
  const json = (await res.json()) as { ok?: boolean; result?: { message_id?: number } }
  return json.ok ? json.result?.message_id ?? null : null
}
function dateLabel(iso: string | null | undefined): string {
  if (!iso) return "?"
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" }).format(new Date(iso))
}

const RULES_SYSTEM = `You design and document the Google Drive filing convention for Ryan LaRocca, a real-estate investor (flips + small multifamily, Santa Clara County). Inputs: how his Drive is organized today, his answers to setup questions about real documents, and corrections he made while filing. Ryan has said the agent can probably organize this better than he does and that he is open to suggestions — so PROPOSE a clean structure, don't just transcribe his tree. Keep what he asked for explicitly (those answers are law); improve the rest and say what you changed and why in a short "Proposed changes" section at the top.
Design rules: one folder per property under Properties/, named "<number> <street>" (e.g. "5764 Halleck Dr"); active deals sit directly under Properties/, closed deals move into Properties/<year closed>/; inside each property folder a fixed set of subfolders — "Purchase & Sale" (RPA, addenda, counters, disclosures, escrow, title/prelim, net sheets, closing statements), "Loan & Insurance" (lender docs, evidence of insurance, policies), "Contractor Bids & Invoices", "Photos", "Tenants" (when applicable); a top-level Properties/Pitched Listings/<address>/ for OMs, flyers and deal packages that are not yet Ryan's; tax forms (1099-S, 1098, returns) go to Taxes/<year>/ not the property folder. File names: "<number street> — <document type> — <YYYY-MM-DD>.pdf" unless Ryan said to keep an original name (DocuSign-bracketed forms keep their bracketed names).
Output: Markdown, ≤ 1000 words. Sections in this order: Proposed changes (bullets), Folder structure (a tree), Naming convention (patterns + one example per document type from the setup questions), Special cases (DocuSign completions, Zix/escrow packets, pitched listings/OMs, flyers, bids/invoices, tax/insurance, contractor docs), What NOT to file, Migration notes (what existing folders to rename/move, e.g. "Halleck" → "5764 Halleck Dr", "93 Ridgeview" → "93 Ridgeview Ave"; the agent will do these only after Ryan approves). Where a document type was never covered, write "ASK" so the agent asks Ryan instead of guessing.`

/** Post the next pending setup question, or (queue empty) write + post the convention. */
export async function advanceSetup(): Promise<void> {
  const sb = getLeadsClient()
  const rules = await getSetting("rules")
  if (["approved", "draft", "revise", "generating"].includes(String(rules.status))) return
  const { data: asked } = await sb.from("inbox_interview").select("id").eq("status", "asked").limit(1)
  if (asked?.length) return
  const { data: next } = await sb.from("inbox_interview").select("*, inbox_files(*)").eq("status", "pending").not("seq", "is", null).order("seq").limit(1)
  const { count: total } = await sb.from("inbox_interview").select("id", { count: "exact", head: true }).not("seq", "is", null)
  if (next?.length) {
    const iv = next[0] as { id: string; seq: number; question: string | null; guess_folder: string; guess_name: string; inbox_files: { filename: string; sender: string; subject: string; received_at: string | null; doc_type: string | null } }
    const f = iv.inbox_files
    const text = [
      `🗂 <b>Setup question ${iv.seq}/${total}</b> — teaching me your filing`,
      `<b>${esc(f.filename)}</b> — ${esc(iv.question || f.doc_type)}`,
      `From ${esc(f.sender)} · ${dateLabel(f.received_at)} · “${esc((f.subject || "").slice(0, 70))}”`,
      `My guess: <b>${esc(iv.guess_folder)}/</b>${esc(iv.guess_name)}`,
      `Where would you put it and what would you call it? Tap ✅ if my guess is right, or reply to this message with the folder + name.`,
    ].join("\n")
    const mid = await tgSendHtml(text, [[{ text: "✅ Use my guess", data: `ix:io:${iv.id}` }, { text: "⏭ Skip", data: `ix:is:${iv.id}` }]])
    await sb.from("inbox_interview").update({ status: "asked", asked_at: new Date().toISOString(), tg_message_id: mid }).eq("id", iv.id)
    return
  }
  // Queue empty → convention.
  const { count: answered } = await sb.from("inbox_interview").select("id", { count: "exact", head: true }).in("status", ["answered", "skipped"]).not("seq", "is", null)
  if (!answered) return
  await setSetting("rules", { status: "generating" })
  await tgSendHtml(`📐 That's all ${total} — writing up your filing convention now (about a minute).`)
  try {
    const { data: ivs } = await sb.from("inbox_interview").select("*, inbox_files(filename, sender, subject, doc_type, property_label)").in("status", ["answered", "skipped"]).not("seq", "is", null).order("seq")
    const qa = (ivs || []).map((iv) => {
      const f = (iv as { inbox_files?: { filename: string; sender: string; doc_type: string | null; property_label: string | null } }).inbox_files
      return `${iv.seq}. DOC: ${f?.filename} (${iv.question || f?.doc_type}; from ${f?.sender}; property ${f?.property_label || "unknown"}) · GUESS: ${iv.guess_folder}/${iv.guess_name} · RYAN: ${iv.answer_kind === "accepted" ? "accepted my guess" : iv.answer_kind === "skipped" ? "skipped (don't file this kind)" : iv.answer_text}`
    })
    const { data: corr } = await sb.from("inbox_rules").select("*").eq("source", "correction")
    const drive = await getSetting("drive")
    const prompt = `EXISTING DRIVE TREE (relative to the shared "Business Operations" root):\n${String(drive.tree_cache || "(unknown)")}\n\nSETUP QUESTIONS (one document at a time; "accepted my guess" means the guess IS his answer):\n${qa.join("\n") || "(none)"}\n\nCORRECTIONS HE MADE WHILE FILING:\n${(corr || []).map((r) => `- ${r.sender_domain} ${r.doc_type} → ${r.folder_template}/${r.filename_template}${r.note ? ` (${r.note})` : ""}`).join("\n") || "(none)"}\n\nWrite the convention document now (markdown only, no preamble).`
    const out = await completeText({ model: SONNET, system: RULES_SYSTEM, prompt, maxTokens: 3500, thinking: false, tag: "[inbox-rules]" })
    if (!out.text) throw new Error("empty convention")
    const mid = await tgSendMarkdownFile("INBOX_FILING_RULES.md", out.text, "📐 Here's the filing convention I learned from your answers. Tap 👍 if it's right, or reply to this message with changes.", [[{ text: "👍 That's right", data: "ix:ro" }, { text: "✏️ Needs changes", data: "ix:rn" }]])
    await setSetting("rules", { md: out.text, status: "draft", tg_message_id: mid, published_at: new Date().toISOString(), feedback: null, version: Number(rules.version || 0) + 1 })
  } catch (e) {
    await setSetting("rules", { status: "interview" })
    await tgSendHtml(`⚠️ Couldn't write the convention — ${esc(e instanceof Error ? e.message : String(e))}. The worker will retry on its next pass.`)
  }
}

// ------------------------------------------------------------- ✉️ replies to deal emails
// Ryan 2026-09-24: "we need to be replying to these emails that are direct"
// and to blasts the filter surfaced. Draft in his voice (Reply Planner's
// VOICE_SYSTEM) from the thread + the screen + his verdict; post with
// Send / Edit / Dismiss. Only a Send tap sends, from ryan@lrghomes.com,
// threaded onto the original. No auto-send, ever.

const DEAL_REPLY_RULES = `Context: an agent or owner emailed Ryan about a property they want him to buy. Ryan already screened it. Write the reply he would send.
- If Ryan's verdict is PASS: a warm, honest decline that keeps the door open. Give the real reason in one plain sentence (price per door / rents vs price / not his area / asset type) without lecturing or negotiating, thank them for thinking of him, and say what he does buy so the next one fits. Never ask them to lower the price unless Ryan's instructions say so.
- If Ryan's verdict is LOOK FURTHER (or no verdict yet): thank them, say he's interested enough to dig in, and ask the 2-4 specific questions the screen raised (rents, expenses, condition, seller timing, why selling). Ask for the rent roll / T12 if the OM lacks them. No offer, no number.
- If the sender is someone Ryan has met or worked with (the thread shows it), match that familiarity.
- Keep the thread's subject with "Re: ". Body ends with "Ryan" on its own line. Never mention a screen, a model, or an assistant.
Return JSON { "subject": "...", "body": "..." } and nothing else.`

async function composeDealReply(screenId: string, opts: { instructions?: string; previous?: { subject: string; body: string } }): Promise<{ subject: string; body: string; to: string; toName: string; msg: Awaited<ReturnType<typeof fetchInboxMessage>>; scr: Record<string, unknown> }> {
  const sb = getLeadsClient()
  const { data: scr } = await sb.from("inbox_deal_screens").select("*").eq("id", screenId).maybeSingle()
  if (!scr?.gmail_id) throw new Error("no email behind that screen")
  const msg = await fetchInboxMessage(scr.gmail_id)
  const thread = msg.threadId ? await fetchInboxThread(msg.threadId) : [msg]
  const fromMatch = /^(.*?)\s*<([^>]+)>\s*$/.exec(msg.from)
  const to = (fromMatch ? fromMatch[2] : msg.from).trim()
  const toName = (fromMatch ? fromMatch[1] : "").replace(/["']/g, "").trim()
  const facts = (scr.facts as Record<string, unknown>) || {}
  const verdict = scr.ryan_verdict === "pass" ? "PASS" : scr.ryan_verdict === "look" ? "LOOK FURTHER" : scr.verdict === "pass" ? "PASS (model; Ryan has not tapped yet)" : "LOOK FURTHER (model; Ryan has not tapped yet)"
  const prompt = [
    DEAL_REPLY_RULES,
    `\nTHREAD (“${msg.subject}”):\n${renderThread(thread, 9000)}`,
    `\nSCREEN: ${scr.address || "?"} · verdict ${verdict} · ${scr.summary || ""}\nFACTS: ${JSON.stringify({ ...facts, followups: undefined, card_lines: undefined })}`,
    Array.isArray(facts.followups) && facts.followups.length ? `\nRYAN'S FOLLOW-UP NOTES: ${JSON.stringify(facts.followups)}` : "",
    opts.previous ? `\nPREVIOUS DRAFT:\nSubject: ${opts.previous.subject}\n${opts.previous.body}\n\nRYAN'S EDIT INSTRUCTIONS: ${opts.instructions}\nRewrite applying the instructions. If he pasted his own wording, use it verbatim and only fix threading/sign-off.` : opts.instructions ? `\nRYAN'S INSTRUCTIONS: ${opts.instructions}` : "",
  ].join("\n")
  const out = await completeText({ model: SONNET, system: VOICE_SYSTEM, prompt, maxTokens: 2000, thinking: false, tag: "[inbox-reply]" })
  const j = JSON.parse(extractJsonObject(out.text)) as { subject?: string; body?: string }
  if (!j.body) throw new Error("empty draft")
  const subject = j.subject || (/^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`)
  return { subject, body: j.body.trim(), to, toName, msg, scr: scr as Record<string, unknown> }
}

async function postDraftCard(draft: { id: string; to_name: string | null; to_email: string; subject: string; body: string; version: number }): Promise<number | null> {
  const text = [
    `✉️ <b>Draft to ${esc(draft.to_name || draft.to_email)}</b>${draft.version > 1 ? ` (v${draft.version})` : ""}`,
    `<i>${esc(draft.subject)}</i>`,
    "",
    esc(draft.body),
    "",
    "Nothing sends until you tap ✅. Reply to this card with changes for v2.",
  ].join("\n")
  return tgSendHtml(text, [[{ text: "✅ Send", data: `ix:ds:${draft.id}` }, { text: "✏️ Edit", data: `ix:de:${draft.id}` }, { text: "❌ Dismiss", data: `ix:dd:${draft.id}` }]])
}

/** ✉️ on a deal card → draft v1 and post it. Returns the posted draft id. */
export async function draftDealReply(screenId: string, instructions?: string): Promise<{ ok: boolean; error?: string }> {
  const sb = getLeadsClient()
  try {
    const c = await composeDealReply(screenId, { instructions })
    const intent = c.scr.ryan_verdict === "pass" ? "pass" : c.scr.ryan_verdict === "look" ? "look" : "custom"
    await sb.from("inbox_drafts").update({ status: "superseded" }).eq("screen_id", screenId).eq("status", "draft")
    const { data } = await sb.from("inbox_drafts").insert({ screen_id: screenId, gmail_id: c.msg.id, thread_id: c.msg.threadId, to_email: c.to, to_name: c.toName || null, subject: c.subject, body: c.body, intent, instructions: instructions || null, version: 1 }).select("*").single()
    if (!data) throw new Error("could not save draft")
    const mid = await postDraftCard(data)
    await sb.from("inbox_drafts").update({ tg_message_id: mid }).eq("id", data.id)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Reply-text on a draft card → v(n+1). */
export async function redraftDealReply(draftId: string, instructions: string): Promise<string> {
  const sb = getLeadsClient()
  const { data: prev } = await sb.from("inbox_drafts").select("*").eq("id", draftId).maybeSingle()
  if (!prev) return "Can't find that draft."
  if (!prev.screen_id) return "That draft has no deal behind it."
  try {
    const c = await composeDealReply(prev.screen_id, { instructions, previous: { subject: prev.subject, body: prev.body } })
    await sb.from("inbox_drafts").update({ status: "superseded" }).eq("id", draftId)
    const { data } = await sb.from("inbox_drafts").insert({ screen_id: prev.screen_id, gmail_id: prev.gmail_id, thread_id: prev.thread_id, to_email: prev.to_email, to_name: prev.to_name, subject: c.subject, body: c.body, intent: prev.intent, instructions, version: (prev.version || 1) + 1, parent_id: draftId }).select("*").single()
    if (!data) throw new Error("could not save v2")
    const mid = await postDraftCard(data)
    await sb.from("inbox_drafts").update({ tg_message_id: mid }).eq("id", data.id)
    // clear the old card's buttons
    const token = tgToken()
    if (token && prev.tg_message_id) await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, message_id: prev.tg_message_id, reply_markup: { inline_keyboard: [] } }) }).catch(() => null)
    return `✏️ v${data.version} posted above.`
  } catch (e) {
    return `⚠️ Couldn't redraft — ${e instanceof Error ? e.message : String(e)}`
  }
}

/** ✅ on a draft card. The only path that sends email. */
export async function sendInboxDraft(draftId: string): Promise<{ ok: boolean; to?: string; link?: string; error?: string }> {
  const sb = getLeadsClient()
  const { data: d } = await sb.from("inbox_drafts").select("*").eq("id", draftId).maybeSingle()
  if (!d) return { ok: false, error: "draft not found" }
  if (d.status === "sent") return { ok: false, error: "already sent" }
  if (d.status !== "draft") return { ok: false, error: "that version was replaced — send the newest one" }
  if (!d.gmail_id) return { ok: false, error: "no original email to reply to" }
  try {
    const original = await fetchInboxMessage(d.gmail_id)
    const sent = await sendThreadedReply(original, { to: d.to_name ? `${d.to_name} <${d.to_email}>` : d.to_email, subject: d.subject, body: d.body })
    await sb.from("inbox_drafts").update({ status: "sent", sent_at: new Date().toISOString(), sent_gmail_id: sent.id }).eq("id", draftId)
    if (d.thread_id) await sb.from("inbox_loops").update({ status: "resolved_by_reply", resolved_at: new Date().toISOString() }).eq("thread_id", d.thread_id).in("status", ["open", "snoozed"])
    return { ok: true, to: d.to_name || d.to_email, link: `https://mail.google.com/mail/u/0/#all/${sent.id}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
