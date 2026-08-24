// Phase B composition guardrails (2026-08-21): every T1 body is unique per
// recipient (Claude paraphrases the variant template; Gmail fingerprints
// repeated text as bulk), linted against hard rules before it can be
// queued, and hashed so an identical body can never send twice.
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import Anthropic from "@anthropic-ai/sdk"

const MODEL = "claude-sonnet-5"
// Bump when COMPOSE_RULES / temperature / example policy changes so reply
// rate can be attributed per prompt (stamped on campaign_sends.prompt_version).
export const PROMPT_VERSION = "v2-2026-08-24"
// Sonnet 5 rejects sampling params (temperature/top_p); variation is
// constrained by the prompt rules + seed instead.
const MIN_EXAMPLES = 3 // one outlier edit must not steer the model
const MAX_EXAMPLES = 8

/** briefs/CAMPAIGN_VOICE.md RULES block (Ryan-editable). Cached per process. */
let voiceCache = null
export function loadVoiceRules() {
  if (voiceCache !== null) return voiceCache
  const candidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../briefs/CAMPAIGN_VOICE.md"),
    path.join(process.cwd(), "briefs/CAMPAIGN_VOICE.md"),
  ]
  for (const p of candidates) {
    try {
      const m = fs.readFileSync(p, "utf-8").match(/<!-- RULES START -->([\s\S]*?)<!-- RULES END -->/)
      if (m) return (voiceCache = m[1].trim())
    } catch {}
  }
  return (voiceCache = "")
}

/**
 * Ryan's recent corrections (campaign_send_edits) for one touch, newest
 * first. Style signal only: the prompt is told the template's required
 * elements still win (an edit that deleted the personalization must not
 * collapse variant C into B). Returns [] below MIN_EXAMPLES.
 */
export async function loadEditExamples(sb, touchNumber) {
  const { data } = await sb
    .from("campaign_send_edits")
    .select("body_before, body_after, variant, kind")
    .eq("touch_number", touchNumber)
    .eq("kind", "edit")
    .order("created_at", { ascending: false })
    .limit(MAX_EXAMPLES)
  const rows = (data ?? []).filter((r) => r.body_before && r.body_after && r.body_before !== r.body_after)
  return rows.length >= MIN_EXAMPLES ? rows : []
}
const AGENTS_LINE_DISPLAY = "(650) 910-4007"

export function makeSignature() {
  return `Ryan LaRocca, LRG Homes\nCall or text: ${AGENTS_LINE_DISPLAY}\nReply "remove" anytime to opt out.`
}

export function bodyHash(body) {
  return createHash("sha256").update(body.replace(/\s+/g, " ").trim().toLowerCase()).digest("hex")
}

/** Brokerage guess from the email domain — only well-known brands, else null (never invent). */
const BROKERAGES = {
  "intero.com": "Intero", "compass.com": "Compass", "cbrealty.com": "Coldwell Banker", "cbnorcal.com": "Coldwell Banker",
  "kw.com": "Keller Williams", "sereno.com": "Sereno", "apr.com": "Alain Pinel", "goldengateSIR.com": "Sotheby's",
  "sothebysrealty.com": "Sotheby's", "exprealty.com": "eXp", "redfin.com": "Redfin", "bhhsdrysdale.com": "Berkshire Hathaway",
  "christiesrealestate.com": "Christie's", "corcorangl.com": "Corcoran", "remax.net": "RE/MAX", "century21.com": "Century 21",
}
/** "1173 Shamrock DR" → "1173 Shamrock Dr" (dialer export shouts suffixes). */
export function prettyAddress(a) {
  return (a ?? "").replace(/\s+/g, " ").trim().replace(/\b([A-Z]{2,4})\b/g, (w) => (/^(N|S|E|W|NE|NW|SE|SW|CA)$/.test(w) ? w : w[0] + w.slice(1).toLowerCase()))
}
export function brokerageFor(email) {
  const d = (email ?? "").split("@")[1]?.toLowerCase() ?? ""
  for (const [k, v] of Object.entries(BROKERAGES)) if (d === k.toLowerCase() || d.endsWith("." + k.toLowerCase())) return v
  return null
}

// Phrases Ryan has deleted or flagged (briefs/CAMPAIGN_VOICE.md). Hard reject.
export const VOICE_BANNED = ["random thought", "hop on a call", "reach out", "reaching out", "circle back", "touch base", "been meaning to", "hope this finds", "hope you're well", "hope you are well", "i'd love to", "i would love to", "excited", "no drama", "actually closes", "last minute renegotiat", "going back and forth", "let's just"]

/**
 * Hard lint. Returns [] when clean, else the list of violations. A body that
 * fails is NEVER queued — the contact is skipped and counted in the ping.
 */
export function lintBody({ subject, body, firstName }) {
  const errs = []
  if (/\{\{|\}\}/.test(body) || /\{\{|\}\}/.test(subject)) errs.push("unfilled merge token")
  if (!new RegExp(`^(Hi|Hey|Hello) ${firstName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},`, "m").test(body)) errs.push("missing 'Hi <first name>,' greeting")
  if (!body.includes(AGENTS_LINE_DISPLAY)) errs.push("missing agents-line phone")
  if (!/Ryan LaRocca/.test(body)) errs.push("missing signature name")
  if (!/reply "remove"/i.test(body) && !/reply remove/i.test(body)) errs.push("missing 'reply remove' opt-out line")
  if (/—|–/.test(body) || /—|–/.test(subject)) errs.push("em/en dash")
  if (/^\s*[-*•]\s/m.test(body)) errs.push("bullet list")
  if (body.length < 250) errs.push(`too short (${body.length})`)
  if (body.length > 1400) errs.push(`too long (${body.length})`)
  if (subject.length > 60) errs.push(`subject too long (${subject.length})`)
  if (/\b(guarantee|100%|free money|act now|limited time|!!)/i.test(body)) errs.push("spammy phrase")
  if (/https?:\/\//i.test(body)) errs.push("link in body")
  const banned = VOICE_BANNED.filter((p) => body.toLowerCase().includes(p))
  if (banned.length) errs.push(`banned phrase: ${banned.join(", ")}`)
  return errs
}

const COMPOSE_RULES = `You lightly vary one outreach email for Ryan LaRocca, a real estate investor at LRG Homes, so that it is not word-for-word identical to the template while reading exactly like the template.
He buys single-family homes and 2-15 unit multifamily in the Bay Area (South Bay focus: San Jose, Sunnyvale, Santa Clara) under $4M. As-is, quick close, proof of funds with every offer. He is writing to a real-estate agent he has crossed paths with.

Hard rules:
- Output ONLY the email body. No subject, no preamble, no commentary, no signature (it is appended automatically).
- Start with exactly the greeting line given in the template (Hi + the recipient's first name + comma) on its own line, then a blank line. Never change the name in the greeting.
- Keep the template's sentences and order. Vary ONLY: the wording of the first sentence, a few word choices elsewhere, and optionally swap the order of two sentences. Same meaning, same length (within about 10 percent), same paragraph count.
- Keep every factual claim and the same ask (call to action). Do not add sentences, openers, reassurances, qualifiers, or references that are not in the template or the CONTEXT block. Do not remove the ask.
- If the CONTEXT block contains a brokerage or property and personalization is requested, fold ONE short clause into the FIRST sentence as the reason you know each other, e.g. "This is Ryan LaRocca with LRG Homes, we crossed paths around your listing on Opal Dr." or "... back when you were at Intero." This is required when requested. Never invent details about it, never say it is currently listed, never put it in the question or the close.
- NEVER use em dashes, en dashes, bullet points, exclamation points, emojis, or links. Plain punctuation only.

VOICE RULES (Ryan's, non-negotiable):
{{voice}}

If CORRECTIONS are provided below, they are Ryan's own edits to earlier drafts. Match the style of the AFTER side and never re-introduce phrasing he deleted. They are style guidance only: the template above still decides content and required elements.`

let client = null
function anthropic() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set")
  return (client ??= new Anthropic())
}

function sanitize(text) {
  return text.replace(/—|–/g, ", ").replace(/ ,/g, ",").replace(/,\s*,/g, ",").replace(/^["'`]+|["'`]+$/g, "").trim()
}

/**
 * Compose a unique body for one contact from a variant template.
 * Returns { subject, body } with the signature appended and merge filled,
 * or throws. Caller lints + hashes.
 */
export async function composeVariantBody({ variant, contact, seed, examples = [] }) {
  const first = (contact.first_name || contact.name || "").trim().split(/\s+/)[0] || "there"
  const brokerage = brokerageFor(contact.email)
  const ctx = []
  if (brokerage) ctx.push(`Brokerage: ${brokerage}`)
  if (variant.personalize && contact.property_address) ctx.push(`Past listing of theirs (use as the first-sentence nod, e.g. "your listing on ${prettyAddress(contact.property_address)}"). Property address associated with them from a PAST listing (may be long sold; do NOT say it is currently listed, say e.g. "the place on ..." or "your listing a while back on ..."): ${prettyAddress(contact.property_address)}`)
  const user = [
    `TEMPLATE (subject: "${variant.subject}"):`,
    variant.body.replaceAll("{{first_name}}", first),
    "",
    `CONTEXT:`,
    ctx.length ? ctx.join("\n") : "(none)",
    `Personalization requested: ${variant.personalize ? "yes" : "no"}`,
    `Variation seed: ${seed} (use it to pick a different first-sentence wording than other drafts)`,
    ...(examples.length
      ? ["", "CORRECTIONS (Ryan's edits, newest first):", ...examples.map((e, i) => `--- ${i + 1} BEFORE ---\n${e.body_before}\n--- ${i + 1} AFTER ---\n${e.body_after}`)]
      : []),
  ].join("\n")
  const res = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 4096, // adaptive thinking shares this budget on Sonnet 5; 1024 starved the text
    system: COMPOSE_RULES.replace("{{voice}}", loadVoiceRules() || "(none on file)"),
    messages: [{ role: "user", content: user }],
  })
  if (res.stop_reason === "refusal") throw new Error("model declined")
  const text = sanitize(res.content.find((b) => b.type === "text")?.text ?? "")
  if (!text) throw new Error(`empty composition (stop_reason=${res.stop_reason})`)
  const fill = (s) => s.replaceAll("{{first_name}}", first)
  const body = fill(text).replace(/^(Hi|Hey|Hello) [^\n]*,/, `Hi ${first},`) // greeting is never the model's call
  return { subject: fill(variant.subject).trim(), body: `${body}\n\n${makeSignature()}`, firstName: first }
}
