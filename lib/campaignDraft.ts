import Anthropic from "@anthropic-ai/sdk"
import { laneClient } from "@/lib/llmUsage"
import { getLeadsClient } from "@/lib/leads"
import { sendCampaignEmailReply } from "@/lib/campaignEmail"

// AI-drafted email replies, commanded from Telegram (2026-07-27, Ryan:
// "notify the system to draft an email based on some general guidance").
//
// Flow: reply "draft: <guidance>" to an AGENT REPLY alert → Claude composes
// a full email in Ryan's voice from the agent's actual reply + guidance →
// draft posted to Telegram with [✅ Send] [❌ Discard] buttons. NOTHING
// sends without the ✅ tap (which goes through sendCampaignEmailReply).
//
// Revisions (2026-07-29, Pamela 4plex/8plex mixup): replying to the draft
// message itself is revision guidance — Claude rewrites with the previous
// draft + feedback, the old draft is superseded (buttons cleared), and a
// fresh v2 posts with new buttons. Only ever one live draft per thread.
//
// Brain: Claude Sonnet via the Anthropic API directly (ANTHROPIC_API_KEY —
// same key OpenClaw uses; NOT OpenRouter). Zero tokens unless invoked.
// Every failure surfaces as ⚠️ with the reason — never silence.

const MODEL = "claude-sonnet-5"

const VOICE_RULES = `You draft email replies for Ryan LaRocca, a real estate investor at LRG Homes.
He buys single-family homes and 2-15 unit multifamily buildings in the Bay Area (South Bay focus) under $4M, and he is writing to real estate agents he knows from past deals.

Hard rules:
- Write ONLY the email body. No subject line, no preamble, no explanation of what you wrote.
- Sound like a busy investor texting a colleague: warm, direct, plain words, short sentences.
- Keep it short. Under 120 words unless the guidance clearly needs more.
- NEVER use em dashes, en dashes, bullet points, or typographic ornaments. Plain punctuation only.
- Make no commitments on price, terms, or timelines unless the guidance explicitly states them. If the guidance is vague on a number, stay non-committal.
- Sign off with just "Ryan" on its own line.
- Do not invent facts about properties or past conversations that are not in the context or guidance.`

function sanitize(text: string): string {
  return text
    .replace(/—|–/g, ", ")
    .replace(/ ,/g, ",")
    .replace(/,\s*,/g, ",")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim()
}

async function buildThread(
  sb: ReturnType<typeof getLeadsClient>,
  contactId: string,
  contactName: string
): Promise<string> {
  const { data: events } = await sb
    .from("campaign_events")
    .select("kind, body, occurred_at")
    .eq("contact_id", contactId)
    .in("kind", ["email_reply", "email_out"])
    .order("occurred_at", { ascending: false })
    .limit(4)
  return (events ?? [])
    .reverse()
    .map((e) => `${e.kind === "email_reply" ? `FROM ${contactName}` : "FROM Ryan"}:\n${(e.body ?? "").slice(0, 1200)}`)
    .join("\n\n---\n\n")
}

async function composeWithClaude(userContent: string): Promise<{ draft?: string; error?: string }> {
  if (!process.env.ANTHROPIC_API_KEY) return { error: "ANTHROPIC_API_KEY not set" }
  const client = laneClient("background", "[campaign-draft]")
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: VOICE_RULES,
      messages: [{ role: "user", content: userContent }],
    })
    if (response.stop_reason === "refusal") return { error: "model declined to draft this" }
    const textBlock = response.content.find((b) => b.type === "text")
    const draft = sanitize(textBlock && "text" in textBlock ? textBlock.text : "")
    return draft ? { draft } : { error: "model returned an empty draft" }
  } catch (e) {
    return { error: `Claude API: ${e instanceof Error ? e.message : String(e)}` }
  }
}

export interface DraftResult {
  success: boolean
  error?: string
  draft?: string
  label?: string
  eventId?: string
  /** Telegram message_id of the superseded draft (revisions only) — clear its buttons. */
  oldTgMessageId?: number
}

export async function draftCampaignEmail(args: {
  contactName?: string | null
  /** campaign_contacts.id, found through the alert's card (2026-11-11) —
   * wins over the name, which two contacts can share. The draft row
   * remembers it so ✅ sends to the same contact. */
  contactId?: string | null
  guidance: string
}): Promise<DraftResult> {
  const { guidance } = args
  const contactName = (args.contactName ?? "").trim()
  if (!guidance.trim()) return { success: false, error: "empty guidance — say what the email should do" }
  const sb = getLeadsClient()

  let contact: { id: string; name: string; email: string | null }
  if (args.contactId) {
    const { data, error } = await sb.from("campaign_contacts").select("id, name, email").eq("id", args.contactId).limit(1)
    if (error) return { success: false, error: `contact lookup failed: ${error.message}` }
    if (!data?.length) return { success: false, error: "that campaign contact no longer exists" }
    contact = { ...data[0], name: data[0].name ?? (contactName || data[0].email || "agent") }
  } else {
    const { data: contacts } = await sb
      .from("campaign_contacts")
      .select("id, name, email")
      .ilike("name", contactName)
      .limit(2)
    if (!contacts?.length) return { success: false, error: `no contact named "${contactName}"` }
    if (contacts.length > 1) return { success: false, error: `two contacts named "${contactName}" — reply from Gmail` }
    contact = contacts[0]
  }

  const thread = await buildThread(sb, contact.id, contact.name)
  const { draft, error } = await composeWithClaude(
    `${thread ? `Recent email thread with ${contact.name}:\n\n${thread}\n\n` : `(No prior thread on file with ${contact.name}.)\n\n`}Ryan's guidance for this reply: ${guidance.trim()}\n\nWrite the reply email body now.`
  )
  if (!draft) return { success: false, error }

  const { data: row, error: insErr } = await sb
    .from("campaign_events")
    .insert({
      contact_id: contact.id,
      kind: "note",
      triage: "pending_draft",
      body: `AI draft awaiting approval (guidance: ${guidance.trim().slice(0, 300)})`,
      raw: { via: "telegram_draft", contact_name: contact.name, ...(args.contactId ? { contact_id: contact.id } : {}), guidance: guidance.trim(), draft },
    })
    .select("id")
    .single()
  if (insErr || !row?.id) return { success: false, error: `draft save failed: ${insErr?.message ?? "no id returned"}` }

  return { success: true, draft, label: contact.name, eventId: String(row.id) }
}

/** The Telegram message for a draft (new or revised): the text Ryan has
 * seen since 2026-07-29, with [✅ Send] [❌ Discard]. Pure. */
export function campaignDraftMessage(out: Pick<DraftResult, "label" | "draft" | "eventId">): { text: string; reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } } {
  return {
    text: `📝 Draft for ${out.label}:\n\n${out.draft}\n\nReply to THIS message with changes and I'll revise. Nothing sends until you tap ✅.`,
    reply_markup: {
      inline_keyboard: [[
        { text: "✅ Send", callback_data: `dsend:${out.eventId}` },
        { text: "❌ Discard", callback_data: `ddisc:${out.eventId}` },
      ]],
    },
  }
}

/** Post a draft with its action buttons and link the Telegram message back
 * to the draft row so reply-to-draft revising works. Moved here from the
 * Telegram route (2026-11-11) so lib/alertReply posts a card-found AGENT
 * REPLY draft exactly the way the route posts a name-found one. */
export async function postCampaignDraft(out: DraftResult, replyToMessageId?: number | null, chatId: number | string | undefined = process.env.TELEGRAM_CHAT_ID): Promise<void> {
  const token = process.env.CAMPAIGN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN
  if (!token || !chatId) return
  const send = async (body: Record<string, unknown>): Promise<{ ok?: boolean; result?: { message_id?: number } } | null> => {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      })
      return (await res.json()) as { ok?: boolean; result?: { message_id?: number } }
    } catch (e) {
      console.error("[campaign-draft] sendMessage failed:", e instanceof Error ? e.message : String(e))
      return null
    }
  }
  const payload = { chat_id: chatId, ...campaignDraftMessage(out) }
  // allow_sending_without_reply: a dead reply target (deleted message, or a
  // synthetic test update) must never eat the draft — post it standalone.
  let sent = await send({
    ...payload,
    ...(replyToMessageId ? { reply_to_message_id: replyToMessageId, allow_sending_without_reply: true } : {}),
  })
  if (!sent?.ok) sent = await send(payload) // belt-and-suspenders retry without the reply link
  const tgId = sent?.result?.message_id
  if (out.eventId && typeof tgId === "number") await attachDraftMessageId(out.eventId, tgId)
}

/** Link the posted Telegram message to its draft so reply-to-draft can find it. */
export async function attachDraftMessageId(eventId: string, tgMessageId: number): Promise<void> {
  const sb = getLeadsClient()
  const { data: ev } = await sb.from("campaign_events").select("raw").eq("id", eventId).maybeSingle()
  if (!ev) return
  await sb
    .from("campaign_events")
    .update({ raw: { ...(ev.raw as Record<string, unknown>), tg_message_id: tgMessageId } })
    .eq("id", eventId)
}

export interface DraftLookup {
  eventId: string
  triage: string
  contactName: string
  /** For copy-preview messages: which touch the preview was about. */
  touch: number | null
}

/** Is this Telegram message one of our posted drafts? (reply-to-draft routing) */
export async function findDraftByTgMessage(tgMessageId: number): Promise<DraftLookup | null> {
  const sb = getLeadsClient()
  const { data } = await sb
    .from("campaign_events")
    .select("id, triage, raw")
    .filter("raw->>tg_message_id", "eq", String(tgMessageId))
    .limit(1)
  if (!data?.length) return null
  const raw = (data[0].raw ?? {}) as { contact_name?: string; touch?: number }
  return {
    eventId: String(data[0].id),
    triage: data[0].triage ?? "",
    contactName: raw.contact_name ?? "",
    touch: typeof raw.touch === "number" ? raw.touch : null,
  }
}

/** Rewrite a pending draft from Ryan's feedback; supersedes the old one. */
export async function reviseCampaignDraft(args: {
  eventId: string
  feedback: string
}): Promise<DraftResult> {
  const { eventId, feedback } = args
  if (!feedback.trim()) return { success: false, error: "empty feedback — say what to change" }
  const sb = getLeadsClient()

  const { data: ev } = await sb
    .from("campaign_events")
    .select("id, contact_id, triage, raw")
    .eq("id", eventId)
    .maybeSingle()
  if (!ev) return { success: false, error: "draft not found" }
  if (ev.triage === "draft_sent") return { success: false, error: "that draft already sent — reply to the agent's alert with draft: for a new email" }
  if (ev.triage === "draft_discarded") return { success: false, error: "that draft was discarded — start fresh with draft: on the agent's alert" }
  if (ev.triage === "draft_superseded") return { success: false, error: "that draft was already revised — reply to the newest version" }
  if (ev.triage !== "pending_draft") return { success: false, error: `unexpected draft state (${ev.triage})` }
  const raw = (ev.raw ?? {}) as { contact_name?: string; contact_id?: string; guidance?: string; draft?: string; tg_message_id?: number }
  if (!raw.contact_name || !raw.draft || !ev.contact_id) return { success: false, error: "draft record is incomplete" }

  const thread = await buildThread(sb, String(ev.contact_id), raw.contact_name)
  const feedbackClean = feedback.trim().replace(/^draft:\s*/i, "")
  const { draft, error } = await composeWithClaude(
    `${thread ? `Recent email thread with ${raw.contact_name}:\n\n${thread}\n\n` : ""}Previous draft of Ryan's reply:\n${raw.draft}\n\nRyan's revision feedback: ${feedbackClean}\n\nRewrite the email applying the feedback. Keep everything the feedback did not criticize. If the feedback reads like replacement wording rather than an instruction, incorporate it directly. Write the reply email body now.`
  )
  if (!draft) return { success: false, error }

  const { data: row, error: insErr } = await sb
    .from("campaign_events")
    .insert({
      contact_id: ev.contact_id,
      kind: "note",
      triage: "pending_draft",
      body: `AI draft awaiting approval (revision: ${feedbackClean.slice(0, 300)})`,
      raw: {
        via: "telegram_draft",
        contact_name: raw.contact_name,
        // A card-found draft stays card-found through every revision.
        ...(raw.contact_id ? { contact_id: raw.contact_id } : {}),
        guidance: raw.guidance ?? "",
        feedback: feedbackClean,
        draft,
        revision_of: eventId,
      },
    })
    .select("id")
    .single()
  if (insErr || !row?.id) return { success: false, error: `revised draft save failed: ${insErr?.message ?? "no id returned"}` }

  await sb.from("campaign_events").update({ triage: "draft_superseded" }).eq("id", eventId)
  return { success: true, draft, label: raw.contact_name, eventId: String(row.id), oldTgMessageId: raw.tg_message_id }
}

export async function sendPendingDraft(eventId: string): Promise<{ success: boolean; error?: string; label?: string; mailbox?: string }> {
  const sb = getLeadsClient()
  const { data: ev } = await sb
    .from("campaign_events")
    .select("id, triage, raw")
    .eq("id", eventId)
    .maybeSingle()
  if (!ev) return { success: false, error: "draft not found" }
  if (ev.triage !== "pending_draft") {
    if (ev.triage === "draft_sent") return { success: false, error: "already sent" }
    if (ev.triage === "draft_superseded") return { success: false, error: "this version was revised — use the newest draft's buttons" }
    return { success: false, error: "draft was discarded" }
  }
  const raw = (ev.raw ?? {}) as { contact_name?: string; contact_id?: string; draft?: string }
  if (!raw.contact_name || !raw.draft) return { success: false, error: "draft record is incomplete" }

  // Drafts from before 2026-11-11 (or from an alert with no card) carry only the name.
  const out = await sendCampaignEmailReply({ contactName: raw.contact_name, contactId: raw.contact_id ?? null, body: raw.draft })
  if (!out.success) return { success: false, error: out.error }

  await sb.from("campaign_events").update({ triage: "draft_sent" }).eq("id", eventId)
  return { success: true, label: out.label, mailbox: out.mailbox }
}

export async function discardPendingDraft(eventId: string): Promise<{ success: boolean; error?: string }> {
  const sb = getLeadsClient()
  const { data: ev } = await sb
    .from("campaign_events")
    .select("id, triage")
    .eq("id", eventId)
    .maybeSingle()
  if (!ev) return { success: false, error: "draft not found" }
  if (ev.triage !== "pending_draft") {
    if (ev.triage === "draft_sent") return { success: false, error: "already sent — nothing to discard" }
    if (ev.triage === "draft_superseded") return { success: false, error: "this version was revised — discard the newest draft instead" }
    return { success: false, error: "already discarded" }
  }
  await sb.from("campaign_events").update({ triage: "draft_discarded" }).eq("id", eventId)
  return { success: true }
}
