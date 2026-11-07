import Anthropic from "@anthropic-ai/sdk"
import { apiKeyFor, recordLlmUsage, type LlmLane } from "./llmUsage"

// Single Anthropic client for every text-completion call in the app
// (2026-09-09). Replaces the nine ad-hoc OpenRouter fetches that were still
// billing Ryan's OpenRouter account after the campaign side moved to the
// Anthropic SDK in August. One place to pick models, one place to handle a
// truncated response — which is what was silently cutting off the call notes
// on long seller conversations (max_tokens hit → half a summary saved).

// Sonnet 5 is the floor for every lead-reading call (2026-10-21, NOO Q4
// pre-wire audit): the Haiku 4.5 constant was removed on purpose so nothing
// can regress to it. Sonnet runs adaptive thinking by default and the
// thinking budget shares max_tokens — short JSON sites pass thinking:false.
export const SONNET = "claude-sonnet-5"
// Coach mode (briefs/BRIEF_COACHED_DRAFT_2026-10-15.md §B): Opus reads the
// whole history plus Ryan's gist. Auto keeps Sonnet.
export const OPUS = "claude-opus-5-5"

export type { LlmLane } from "./llmUsage"

export function hasLlmKey(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY_DRAFTS || process.env.ANTHROPIC_API_KEY_BACKGROUND)
}

export interface CompleteTextArgs {
  prompt: string
  system?: string
  model?: string
  maxTokens: number
  // Sonnet 5 runs adaptive thinking by default and it shares max_tokens with
  // the answer. Short JSON / interactive outputs (triage, the CRMS composer)
  // turn it off so the budget goes to the answer. No sampling params
  // (temperature / top_p) are ever sent — Sonnet 5 rejects them.
  // Opus 5.5 is the same as Sonnet for the budget (thinking shares
  // max_tokens, so coach calls pass >= 8192) but it cannot be switched off:
  // the API rejects thinking:disabled on that model, so the flag is ignored
  // there and the call simply runs with thinking on.
  thinking?: boolean
  // Opus 5.5 only: how hard to think. Its default is "medium"; coach calls
  // ask for "high". Ignored on the other models.
  effort?: "low" | "medium" | "high" | "xhigh" | "max"
  // When the model hits max_tokens, retry once with triple the budget instead
  // of returning a clipped answer. Default on — a truncated JSON blob fails
  // the parse and a truncated paragraph loses the details Ryan cares about.
  retryOnTruncate?: boolean
  // Log prefix, e.g. "[analyze-call]". Also the feature name in llm_usage.
  tag?: string
  // Which Console key pays (2026-11-07, lib/llmUsage.ts): "drafts" for the
  // writing Ryan reads and sends (lib/reply, lib/coach, the CRMS composer),
  // "background" (default) for everything else.
  lane?: LlmLane
}

export interface CompleteTextResult {
  text: string
  stopReason: string | null
  truncated: boolean
}

const clients: Partial<Record<LlmLane, Anthropic>> = {}
function getClient(lane: LlmLane): Anthropic {
  return (clients[lane] ??= new Anthropic({ apiKey: apiKeyFor(lane) }))
}

/** One user-turn completion. Throws `Anthropic.APIError` (or a plain Error on
 *  refusal) — callers already wrap their model calls in try/catch. */
export async function completeText(args: CompleteTextArgs): Promise<CompleteTextResult> {
  const model = args.model ?? SONNET
  const tag = args.tag ?? "[llm]"
  const retry = args.retryOnTruncate ?? true
  const disableThinking = model === SONNET && args.thinking === false
  const effort = model === OPUS ? args.effort : undefined
  const lane: LlmLane = args.lane ?? "background"

  const run = async (maxTokens: number) => {
    let response: Anthropic.Message
    try {
      response = await getClient(lane).messages.create({
        model,
        max_tokens: maxTokens,
        // The system prompt is the fixed part of every call at a site, so it
        // is marked for the prompt cache (reads bill at 5–10% of input). Too
        // short a system prompt simply doesn't cache — no error, no cost.
        ...(args.system ? { system: [{ type: "text" as const, text: args.system, cache_control: { type: "ephemeral" as const } }] } : {}),
        ...(disableThinking ? { thinking: { type: "disabled" as const } } : {}),
        ...(effort ? { output_config: { effort } } : {}),
        messages: [{ role: "user", content: args.prompt }],
      })
    } catch (e) {
      await recordLlmUsage({ lane, model, tag, error: e })
      throw e
    }
    await recordLlmUsage({ lane, model, tag, usage: response.usage })
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
 *  for JSON only. Models occasionally append a sentence after the object. */
export function extractJsonObject(text: string): string {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim()
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  if (start >= 0 && end > start) return cleaned.slice(start, end + 1)
  return cleaned
}
