// Phase B composition guardrails (2026-08-21): every T1 body is unique per
// recipient (Claude paraphrases the variant template; Gmail fingerprints
// repeated text as bulk), linted against hard rules before it can be
// queued, and hashed so an identical body can never send twice.
import { createHash } from "node:crypto"
import Anthropic from "@anthropic-ai/sdk"

const MODEL = "claude-sonnet-5"
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
export function brokerageFor(email) {
  const d = (email ?? "").split("@")[1]?.toLowerCase() ?? ""
  for (const [k, v] of Object.entries(BROKERAGES)) if (d === k.toLowerCase() || d.endsWith("." + k.toLowerCase())) return v
  return null
}

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
  return errs
}

const COMPOSE_RULES = `You rewrite one outreach email for Ryan LaRocca, a real estate investor at LRG Homes, so that it reads naturally and is worded differently from the template while saying the same things.
He buys single-family homes and 2-15 unit multifamily in the Bay Area (South Bay focus: San Jose, Sunnyvale, Santa Clara) under $4M. As-is, quick close, proof of funds with every offer. He is writing to a real-estate agent he has crossed paths with before.

Hard rules:
- Output ONLY the email body. No subject, no preamble, no commentary, no signature (it is appended automatically).
- Start with exactly "Hi {{first_name}}," on its own line, then a blank line.
- Keep every factual claim from the template. Do not add claims, numbers, property names, or past interactions that are not in the template or the CONTEXT block.
- Keep the same ask (the call to action) as the template, in your own words.
- Reword substantially: different sentence structure and word choices, same meaning, similar length (within about 20 percent).
- Plain, warm, direct. Short sentences. Like a busy investor typing to a colleague. No hype, no exclamation points.
- NEVER use em dashes, en dashes, bullet points, emojis, or links. Plain punctuation only.
- If the CONTEXT block contains a brokerage or property and personalization is requested, weave ONE natural reference to it (e.g. "over at Intero", "the place on Opal Dr"). Never invent details about the property.`

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
export async function composeVariantBody({ variant, contact, seed }) {
  const first = (contact.first_name || contact.name || "").trim().split(/\s+/)[0] || "there"
  const brokerage = brokerageFor(contact.email)
  const ctx = []
  if (brokerage) ctx.push(`Brokerage: ${brokerage}`)
  if (variant.personalize && contact.property_address) ctx.push(`Property address associated with them from a PAST listing (may be long sold; do NOT say it is currently listed, say e.g. "the place on ..." or "your listing a while back on ..."): ${contact.property_address}`)
  const user = [
    `TEMPLATE (subject: "${variant.subject}"):`,
    variant.body,
    "",
    `CONTEXT:`,
    ctx.length ? ctx.join("\n") : "(none)",
    `Personalization requested: ${variant.personalize ? "yes" : "no"}`,
    `Variation seed: ${seed} (use it to pick a different opening and rhythm than other rewrites)`,
  ].join("\n")
  const res = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 1024,
    temperature: 1,
    system: COMPOSE_RULES,
    messages: [{ role: "user", content: user }],
  })
  if (res.stop_reason === "refusal") throw new Error("model declined")
  const text = sanitize(res.content.find((b) => b.type === "text")?.text ?? "")
  if (!text) throw new Error("empty composition")
  const fill = (s) => s.replaceAll("{{first_name}}", first)
  return { subject: fill(variant.subject).trim(), body: `${fill(text)}\n\n${makeSignature()}`, firstName: first }
}
