import Anthropic from "@anthropic-ai/sdk"
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
// Brain: Claude Sonnet via the Anthropic API directly (ANTHROPIC_API_KEY —
// same key OpenClaw uses; NOT OpenRouter). Zero tokens unless "draft:" is
// typed. Every failure surfaces as ⚠️ with the reason — never silence.

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

export interface DraftResult {
  success: boolean
  error?: string
  draft?: string
  label?: string
  eventId?: string
}

export async function draftCampaignEmail(args: {
  contactName: string
  guidance: string
}): Promise<DraftResult> {
  const { contactName, guidance } = args
  if (!guidance.trim()) return { success: false, error: "empty guidance — say what the email should do" }
  if (!process.env.ANTHROPIC_API_KEY) return { success: false, error: "ANTHROPIC_API_KEY not set" }
  const sb = getLeadsClient()

  const { data: contacts } = await sb
    .from("campaign_contacts")
    .select("id, name, email")
    .ilike("name", contactName)
    .limit(2)
  if (!contacts?.length) return { success: false, error: `no contact named "${contactName}"` }
  if (contacts.length > 1) return { success: false, error: `two contacts named "${contactName}" — reply from Gmail` }
  const contact = contacts[0]

  // Context: their latest reply plus recent back-and-forth on the timeline.
  const { data: events } = await sb
    .from("campaign_events")
    .select("kind, body, occurred_at, raw")
    .eq("contact_id", contact.id)
    .in("kind", ["email_reply", "email_out"])
    .order("occurred_at", { ascending: false })
    .limit(4)
  const thread = (events ?? [])
    .reverse()
    .map((e) => `${e.kind === "email_reply" ? `FROM ${contact.name}` : "FROM Ryan"}:\n${(e.body ?? "").slice(0, 1200)}`)
    .join("\n\n---\n\n")

  const client = new Anthropic()
  let draft = ""
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: VOICE_RULES,
      messages: [
        {
          role: "user",
          content: `${thread ? `Recent email thread with ${contact.name}:\n\n${thread}\n\n` : `(No prior thread on file with ${contact.name}.)\n\n`}Ryan's guidance for this reply: ${guidance.trim()}\n\nWrite the reply email body now.`,
        },
      ],
    })
    if (response.stop_reason === "refusal") return { success: false, error: "model declined to draft this" }
    const textBlock = response.content.find((b) => b.type === "text")
    draft = sanitize(textBlock && "text" in textBlock ? textBlock.text : "")
  } catch (e) {
    return { success: false, error: `Claude API: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!draft) return { success: false, error: "model returned an empty draft" }

  const { data: row, error: insErr } = await sb
    .from("campaign_events")
    .insert({
      contact_id: contact.id,
      kind: "note",
      triage: "pending_draft",
      body: `AI draft awaiting approval (guidance: ${guidance.trim().slice(0, 300)})`,
      raw: { via: "telegram_draft", contact_name: contact.name, guidance: guidance.trim(), draft },
    })
    .select("id")
    .single()
  if (insErr || !row?.id) return { success: false, error: `draft saved failed: ${insErr?.message ?? "no id returned"}` }

  return { success: true, draft, label: contact.name, eventId: String(row.id) }
}

export async function sendPendingDraft(eventId: string): Promise<{ success: boolean; error?: string; label?: string }> {
  const sb = getLeadsClient()
  const { data: ev } = await sb
    .from("campaign_events")
    .select("id, triage, raw")
    .eq("id", eventId)
    .maybeSingle()
  if (!ev) return { success: false, error: "draft not found" }
  if (ev.triage !== "pending_draft") {
    return { success: false, error: ev.triage === "draft_sent" ? "already sent" : "draft was discarded" }
  }
  const raw = (ev.raw ?? {}) as { contact_name?: string; draft?: string }
  if (!raw.contact_name || !raw.draft) return { success: false, error: "draft record is incomplete" }

  const out = await sendCampaignEmailReply({ contactName: raw.contact_name, body: raw.draft })
  if (!out.success) return { success: false, error: out.error }

  await sb.from("campaign_events").update({ triage: "draft_sent" }).eq("id", eventId)
  return { success: true, label: out.label }
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
    return { success: false, error: ev.triage === "draft_sent" ? "already sent — nothing to discard" : "already discarded" }
  }
  await sb.from("campaign_events").update({ triage: "draft_discarded" }).eq("id", eventId)
  return { success: true }
}
