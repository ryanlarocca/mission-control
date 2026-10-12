// Inbox Agent — open-loop rules shared by the worker and its tests.
//
// Ryan 2026-10-12: the 93 Ridgeview card he still sees came from loop
// 25a67d93… created BY the "Completed:" email (kind=docusign_completed, the
// classifier said needs_reply=true), so the agent nagged him to sign something
// he had already signed. A completion is an event that CLOSES a signature
// loop; it never opens one.

/** Message kinds that may never reach upsertLoop. */
export const COMPLETION_KINDS = new Set(["docusign_completed", "esign_completed"])
export function loopEligible(kind) {
  return !COMPLETION_KINDS.has(String(kind || ""))
}

const PREFIX_RE = /^(?:re|fw|fwd|completed|declined|reminder|final reminder|please sign|please docusign|signing complete|please review and sign|please review|action required)\b:?\s*/i

/** "Completed: Please Sign: 93 Ridgeview Ave - Disclosures" → "93ridgeviewavedisclosures".
 *  Every leading prefix is stripped, however many are stacked. */
export function normalizeEnvelope(subject) {
  let s = String(subject || "").trim()
  for (let i = 0; i < 6; i++) {
    const next = s.replace(PREFIX_RE, "")
    if (next === s) break
    s = next.trim()
  }
  return s.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/** Does a completion email close this signature loop? */
export function envelopeMatches(loopSubject, messageSubject) {
  const a = normalizeEnvelope(loopSubject)
  const b = normalizeEnvelope(messageSubject)
  return !!a && !!b && a === b
}
