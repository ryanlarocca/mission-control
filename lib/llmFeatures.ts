// Plain names for AI-spend features (llm_usage.tag) and keys (lane), for the
// Health page (2026-11-10). The feature table is the same one
// scripts/llm-spend-report.mjs uses for the Telegram spend line — kept as a
// copy so the Next build never bundles that script (it reads .env.local);
// tests/health.unit.test.ts checks the two give the same names.
// Pure, no imports: safe for the browser.

const FEATURES: [RegExp, string][] = [
  [/^\[reply\/auto\]$/, "Auto drafts"],
  [/^\[reply\/coach\]$/, "Coached drafts"],
  [/^\[reply\/(plan|facts|critic)\]$/, "Draft checks"],
  [/^\[coach\/rate\]$/, "Call ratings"],
  [/^\[coach\/script\]$/, "Call scripts"],
  [/^\[(crms\/generate|draft-message)\]$/, "Card composer"],
  [/^\[judge\]$/, "The judge"],
  [/^\[lead-stage\]$/, "Stage reader"],
  [/^\[drip(\/[a-z]+)?\]$/, "Drip engine"],
  [/^\[(analyze-call|summarize|summary|detect-offer|extract-followup|history-line|crms\/call [a-z]+|jackie-review)\]$/, "Call notes"],
  [/^\[(triage-email|campaign-inbox triage|vendor-pitch|ladder)\]$/, "Email & lead triage"],
  [/^\[(inbox-agent|classify|verify|event|screen|rules|propose|change|stmt-diff|inbox-[a-z-]+|backfill-[a-z]+)\]$/, "Inbox agent"],
  [/^\[(contact-intake|calendar-intake)\]$/, "Telegram intake"],
  [/^\[(campaign-[a-z]+|reply-review)\]$/, "Campaigns & reviews"],
  [/^\[market-cycle\]$/, "Market cycle"],
]

export function featureName(tag: string | null | undefined): string {
  for (const [re, name] of FEATURES) if (re.test(tag || "")) return name
  return String(tag || "other").replace(/^\[|\]$/g, "")
}

/** The two Console keys (lib/llmUsage.ts LANE_LABEL). */
export const LANE_LABEL: Record<string, string> = {
  drafts: "Drafts & coaching",
  background: "Background jobs",
}

export function laneLabel(lane: string | null | undefined): string {
  return LANE_LABEL[lane ?? ""] ?? (lane || "Other")
}
