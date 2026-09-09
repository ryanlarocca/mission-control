import Anthropic from "@anthropic-ai/sdk"

// Single Anthropic client for every text-completion call in the app
// (2026-09-09). Replaces the nine ad-hoc OpenRouter fetches that were still
// billing Ryan's OpenRouter account after the campaign side moved to the
// Anthropic SDK in August. One place to pick models, one place to handle a
// truncated response — which is what was silently cutting off the call notes
// on long seller conversations (max_tokens hit → half a summary saved).

export const HAIKU = "claude-haiku-4-5"
export const SONNET = "claude-sonnet-5"

export function hasLlmKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY
}

export interface CompleteTextArgs {
  prompt: string
  system?: string
  model?: string
  maxTokens: number
  // Sonnet 5 runs adaptive thinking by default and it shares max_tokens with
  // the answer. Short, interactive outputs (the CRMS composer) turn it off;
  // Haiku 4.5 never thinks unless asked, so the flag is a no-op there.
  thinking?: boolean
  // When the model hits max_tokens, retry once with triple the budget instead
  // of returning a clipped answer. Default on — a truncated JSON blob fails
  // the parse and a truncated paragraph loses the details Ryan cares about.
  retryOnTruncate?: boolean
  // Log prefix, e.g. "[analyze-call]".
  tag?: string
}

export interface CompleteTextResult {
  text: string
  stopReason: string | null
  truncated: boolean
}

let client: Anthropic | null = null
function getClient(): Anthropic {
  if (!client) client = new Anthropic()
  return client
}

/** One user-turn completion. Throws `Anthropic.APIError` (or a plain Error on
 *  refusal) — callers already wrap their model calls in try/catch. */
export async function completeText(args: CompleteTextArgs): Promise<CompleteTextResult> {
  const model = args.model ?? HAIKU
  const tag = args.tag ?? "[llm]"
  const retry = args.retryOnTruncate ?? true
  const disableThinking = model === SONNET && args.thinking === false

  const run = async (maxTokens: number) => {
    const response = await getClient().messages.create({
      model,
      max_tokens: maxTokens,
      ...(args.system ? { system: args.system } : {}),
      ...(disableThinking ? { thinking: { type: "disabled" as const } } : {}),
      messages: [{ role: "user", content: args.prompt }],
    })
    if (response.stop_reason === "refusal") throw new Error(`${tag} model declined the request`)
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim()
    return { text, stopReason: response.stop_reason ?? null }
  }

  let out = await run(args.maxTokens)
  if (out.stopReason === "max_tokens" && retry) {
    const bigger = args.maxTokens * 3
    console.warn(`${tag} response hit max_tokens=${args.maxTokens}; retrying at ${bigger}`)
    out = await run(bigger)
  }
  const truncated = out.stopReason === "max_tokens"
  if (truncated) console.error(`${tag} response still truncated after retry (max_tokens=${args.maxTokens * (retry ? 3 : 1)})`)
  return { ...out, truncated }
}

/** Strip ``` fences and return the first {...} block, for prompts that ask
 *  for JSON only. Haiku occasionally appends a sentence after the object. */
export function extractJsonObject(text: string): string {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim()
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  if (start >= 0 && end > start) return cleaned.slice(start, end + 1)
  return cleaned
}
