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
export const PROMPT_VERSION = "v4-2026-08-27"
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

/**
 * Ryan's standing copy rules (campaign_copy_rules, active only, oldest
 * first). Typed by Ryan in the queue UI — never inferred from edits. Every
 * compose path (engine, regenerate, regenerate-all) reads them.
 * @returns {Promise<string[]>}
 */
export async function loadCopyRules(sb) {
  const { data } = await sb
    .from("campaign_copy_rules")
    .select("rule")
    .eq("active", true)
    .order("created_at", { ascending: true })
    .limit(30)
  return (data ?? []).map((r) => (r.rule ?? "").trim()).filter(Boolean)
}

/**
 * Phrases that assert a relationship the contact may not remember. To a
 * stranger these read as a lie and trigger spam reports (Ryan 2026-08-27).
 * Allowed only when the contact is a known relationship
 * (import_flags has relationships_overlap).
 */
const RELATIONSHIP_CLAIMS = [
  /crossed paths/i, /paths (have )?crossed/i, /worked together/i, /we('ve| have)? (spoken|talked|chatted|met|connected)/i,
  /as (we )?discussed/i, /(nice|good|great) (to )?(reconnect|catch(ing)? up)/i, /\breconnect(ing)?\b/i, /(since|when) we last/i,
  /been (a )?while since/i, /(our|the) last (call|conversation|deal|transaction)/i, /(from|since) (our|the) (deal|transaction|closing)/i,
  /remember me/i, /you may (recall|remember)/i, /get(ting)? back in touch/i, /back in touch/i, /follow(ing)? up on our/i,
]
export function isKnownRelationship(contact) {
  return Array.isArray(contact?.import_flags) && contact.import_flags.includes("relationships_overlap")
}
/** @returns {string|null} the offending phrase, or null when clean / allowed */
export function relationshipClaim(text, contact) {
  if (isKnownRelationship(contact)) return null
  for (const re of RELATIONSHIP_CLAIMS) {
    const m = text.match(re)
    if (m) return m[0]
  }
  return null
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
/** Bay Area region from the phone area code — factual, no history claimed. */
const REGIONS = { "408": "the South Bay", "669": "the South Bay", "650": "the Peninsula", "510": "the East Bay", "925": "the East Bay", "415": "San Francisco", "628": "San Francisco", "831": "the Santa Cruz area" }
export function regionFor(phone) {
  const d = (phone ?? "").replace(/\D/g, "").replace(/^1/, "")
  return d.length === 10 ? REGIONS[d.slice(0, 3)] ?? null : null
}
export function brokerageFor(email) {
  const d = (email ?? "").split("@")[1]?.toLowerCase() ?? ""
  for (const [k, v] of Object.entries(BROKERAGES)) if (d === k.toLowerCase() || d.endsWith("." + k.toLowerCase())) return v
  return null
}

/**
 * Hard lint. Returns [] when clean, else the list of violations. A body that
 * fails is NEVER queued — the contact is skipped and counted in the ping.
 */
/** @param {{ subject: string, body: string, firstName: string, contact?: any }} opts */
export function lintBody({ subject, body, firstName, contact = null }) {
  const errs = []
  const claim = relationshipClaim(`${subject}\n${body}`, contact)
  if (claim) errs.push(`claims a relationship ("${claim}") with a contact who is not a known relationship`)
  if (/\{\{|\}\}/.test(body) || /\{\{|\}\}/.test(subject)) errs.push("unfilled merge token")
  if (!new RegExp(`^(Hi|Hey|Hello) ${firstName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},`, "m").test(body)) errs.push("missing 'Hi <first name>,' greeting")
  if (!body.includes(AGENTS_LINE_DISPLAY)) errs.push("missing agents-line phone")
  if (!/Ryan LaRocca/.test(body)) errs.push("missing signature name")
  if (!/reply "remove"/i.test(body) && !/reply remove/i.test(body)) errs.push("missing 'reply remove' opt-out line")
  if (body.length < 250) errs.push(`too short (${body.length})`)
  if (body.length > 1400) errs.push(`too long (${body.length})`)
  if (subject.length > 60) errs.push(`subject too long (${subject.length})`)
  if (/\b(guarantee|100%|free money|act now|limited time|!!)/i.test(body)) errs.push("spammy phrase")
  if (/https?:\/\//i.test(body)) errs.push("link in body")
  return errs
}

const COMPOSE_RULES = `You lightly vary one outreach email for Ryan LaRocca, a real estate investor at LRG Homes, so that it is not word-for-word identical to the template while reading exactly like the template.
He buys single-family homes and 2-15 unit multifamily in the Bay Area (South Bay focus: San Jose, Sunnyvale, Santa Clara) under $4M. As-is, quick close, proof of funds with every offer. He is writing cold to a real-estate agent. Assume NO prior relationship: never say or imply they have met, spoken, worked together, or are reconnecting, unless CONTEXT says the agent is a known relationship.

Hard rules:
- Output ONLY the email body. No subject, no preamble, no commentary, no signature (it is appended automatically).
- Start with exactly the greeting line given in the template (Hi + the recipient's first name + comma) on its own line, then a blank line. Never change the name in the greeting.
- Keep the template's sentences and order. Reword the first sentence and at least one other sentence, change a few word choices elsewhere, and optionally swap the order of two sentences. Same meaning, same length (within about 10 percent), same paragraph count.
- Keep every factual claim and the same ask (call to action). Do not add sentences, openers, reassurances, qualifiers, or references that are not in the template or the CONTEXT block. Do not remove the ask.
- If personalization is requested and CONTEXT gives a region or brokerage, fold ONE short clause into the ask, e.g. "if anything comes across in the East Bay, send it my way" or "anything over at Intero that fits". Never claim history with the person. If CONTEXT has neither, write it without personalization.
- No links. Dashes, bullets, and emojis are allowed only when they read naturally; default to plain punctuation.

VOICE RULES (Ryan's, non-negotiable):
{{voice}}

STANDING RULES (typed by Ryan in the queue; they override the template wherever they conflict — rewrite the template's sentence rather than break a rule):
{{rules}}

If CORRECTIONS are provided below, they are Ryan's own edits to earlier drafts. Match the style of the AFTER side and never re-introduce phrasing he deleted. They are style guidance only: the template above still decides content and required elements.
If RYAN'S NOTE ON THIS DRAFT is provided, it is his reason for rejecting the previous draft of this exact email. Fix exactly what it says; it outranks the template.`

let client = null
function anthropic() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set")
  return (client ??= new Anthropic())
}

function sanitize(text) {
  return text.replace(/^["'`]+|["'`]+$/g, "").trim()
}

/**
 * Compose a unique body for one contact from a variant template.
 * Returns { subject, body } with the signature appended and merge filled,
 * or throws. Caller lints + hashes.
 */
/**
 * @param {{ variant: any, contact: any, seed: string, examples?: Array<{ body_before: string, body_after: string }>, avoid?: string[], rules?: string[], note?: string }} opts
 *   rules — Ryan's standing copy rules (loadCopyRules); note — his one-off reason for rejecting the draft being replaced.
 * @returns {Promise<{ subject: string, body: string, firstName: string }>}
 */
export async function composeVariantBody({ variant, contact, seed, examples = [], avoid = [], rules = [], note = "" }) {
  const first = (contact.first_name || contact.name || "").trim().split(/\s+/)[0] || "there"
  const brokerage = brokerageFor(contact.email)
  const ctx = []
  if (brokerage) ctx.push(`Brokerage: ${brokerage}`)
  const region = variant.personalize ? regionFor(contact.phone) : null
  if (variant.personalize && region) ctx.push(`Region they work (from their phone area code): ${region}`)
  ctx.push(isKnownRelationship(contact) ? "Known relationship: yes (Ryan has a real history with this agent)" : "Known relationship: NO (cold — do not claim any history)")
  const user = [
    `TEMPLATE (subject: "${variant.subject}"):`,
    variant.body.replaceAll("{{first_name}}", first),
    "",
    `CONTEXT:`,
    ctx.length ? ctx.join("\n") : "(none)",
    `Personalization requested: ${variant.personalize ? "yes" : "no"}`,
    `Variation seed: ${seed} (use it to pick a different first-sentence wording than other drafts)`,
    ...(avoid.length
      ? ["", "EARLIER DRAFTS TO AVOID (same template; use different wording in every sentence so this one is not a near copy of any of them):", ...avoid.slice(-4).map((b, i) => `--- avoid ${i + 1} ---\n${b.split("\n\nRyan LaRocca, LRG")[0]}`)]
      : []),
    ...(examples.length
      ? ["", "CORRECTIONS (Ryan's edits, newest first):", ...examples.map((e, i) => `--- ${i + 1} BEFORE ---\n${e.body_before}\n--- ${i + 1} AFTER ---\n${e.body_after}`)]
      : []),
    ...(note.trim() ? ["", "RYAN'S NOTE ON THIS DRAFT:", note.trim()] : []),
  ].join("\n")
  const rulesText = rules.length ? rules.map((r, i) => `${i + 1}. ${r}`).join("\n") : "(none)"
  const res = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 4096, // adaptive thinking shares this budget on Sonnet 5; 1024 starved the text
    system: COMPOSE_RULES.replace("{{voice}}", loadVoiceRules() || "(none on file)").replace("{{rules}}", rulesText),
    messages: [{ role: "user", content: user }],
  })
  if (res.stop_reason === "refusal") throw new Error("model declined")
  const text = sanitize(res.content.find((b) => b.type === "text")?.text ?? "")
  if (!text) throw new Error(`empty composition (stop_reason=${res.stop_reason})`)
  const fill = (s) => s.replaceAll("{{first_name}}", first)
  const body = fill(text).replace(/^(Hi|Hey|Hello) [^\n]*,/, `Hi ${first},`) // greeting is never the model's call
  return { subject: fill(variant.subject).trim(), body: `${body}\n\n${makeSignature()}`, firstName: first }
}
