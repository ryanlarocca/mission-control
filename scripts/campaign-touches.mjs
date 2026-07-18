/**
 * Agent email-drip campaign — the 11-touch sequence (content locked with
 * Ryan 2026-07-17, briefs/EMAIL_DRIP_CAMPAIGN_2026-07-17.md).
 *
 * Deterministic merge templates for v1 — no per-contact AI on drafts, so
 * what Ryan approves in the queue is exactly what sends. Merge fields:
 *   {{first_name}}  → contact first name, falls back to "there"
 *
 * Touch 10 is a deliberate placeholder: market commentary written fresh at
 * send time (stale canned commentary is the newsletter smell we're
 * avoiding). The engine refuses to draft it until the copy is filled in.
 *
 * dayOffset = days after the PREVIOUS touch (touch 1 fires at import).
 */

export const AGENTS_LINE_DISPLAY = "(650) 910-4007"

// Signature: no postal address by Ryan's explicit call (2026-07-18) — the
// list is professional colleagues he knows, and he accepts the CAN-SPAM
// exposure (advised: the statute has no acquaintance exemption; the
// working opt-out line below stays and is the substantive protection).
export function makeSignature() {
  return `Ryan LaRocca · LRG Homes\nCall/text: ${AGENTS_LINE_DISPLAY}\nReply "remove" anytime to opt out.`
}

export const TOUCHES = [
  {
    touch: 1,
    dayOffset: 0,
    label: "South Bay reintro + buy box",
    subject: "buying again in the South Bay — quick reintro",
    body: `Hi {{first_name}} — Ryan LaRocca with LRG Homes. We've crossed paths before, so I wanted to reconnect: I'm actively buying single-family homes and 2–15 unit multifamily. South Bay is home turf — San Jose, Sunnyvale, Santa Clara — but I'll go anywhere in the Bay under $4M. As-is, quick close, no drama.

If you've got a listing that fits — especially one that's rough, stuck, or getting no love — I'd genuinely like a look. Just reply here or text me at ${AGENTS_LINE_DISPLAY}.`,
  },
  {
    touch: 2,
    dayOffset: 14,
    label: "Why agents send me deals",
    subject: "the buyer who actually closes",
    body: `Hi {{first_name}} — quick follow-up on my note a couple weeks back. When I say I make it easy, here's what I mean: proof of funds with every offer, no repair negotiations, no financing contingencies to sweat, and if it's your listing you're welcome to both sides. I close what I put under contract — that's the whole reputation I'm trying to keep.

One relationship, multiple closings. Keep me in mind next time something fits.`,
  },
  {
    touch: 3,
    dayOffset: 21,
    label: "Proof of real (Kirkland / Ridgeview / Limewood)",
    subject: "a few recent ones",
    body: `Hi {{first_name}} — in case it helps to know I'm not just talk, a few recent purchases: 674 Kirkland Ave in Sunnyvale (6 units), 93 Ridgeview Ave and 1958 Limewood Dr in San Jose. Different stories, same pattern: bought as-is, closed quick, everyone moved on with their lives.

Not chasing volume — just the right ones. If something similar crosses your desk, I'm a text away.`,
  },
  {
    touch: 4,
    dayOffset: 35,
    label: "Send me your headaches",
    subject: "I want your worst listing",
    body: `Hi {{first_name}} — every agent has one: the hoarder house, the tenants who won't allow showings, the unpermitted addition, the one that's been sitting for 90 days. Those are honestly my favorite deals — condition and complications don't scare me off, they're usually why the numbers work.

Before you spend another weekend holding it open, send it my way.`,
  },
  {
    touch: 5,
    dayOffset: 35,
    label: "Fell out of escrow",
    subject: "if your buyer walks",
    body: `Hi {{first_name}} — filing this away for when you need it: if a deal falls out of escrow, text me before you put it back on. I'll give you a real number within 24 hours, and your seller skips the back-on-market stigma entirely.

Hope you never need this email. But you probably will.`,
  },
  {
    touch: 6,
    dayOffset: 35,
    label: "Buy-box refresher, SFH-forward",
    subject: "not just apartments",
    body: `Hi {{first_name}} — quick reminder since most of your business is residential: I buy single-family too, not just units. Estates, tenant-occupied, dated, fire-damaged, fine — anywhere in the Bay under $4M.

Same deal as always: as-is, fast, easy. What are you working on these days?`,
  },
  {
    touch: 7,
    dayOffset: 35,
    label: "Mid-year human check-in (no pitch)",
    subject: "checking in",
    body: `Hi {{first_name}} — no pitch this time, just checking in. How's your year treating you?

If anything's sitting on your desk you're not sure what to do with, happy to be a second set of eyes on it, even if I'm not the buyer.`,
  },
  {
    touch: 8,
    dayOffset: 35,
    label: "Off-market / pre-MLS",
    subject: "before it hits the MLS",
    body: `Hi {{first_name}} — got a coming-soon, a seller who dreads showings, or a pocket listing? I'll make an offer before it ever hits the market — you keep your full commission and skip the photos-staging-open-house grind.

Worth a text before the sign goes up.`,
  },
  {
    touch: 9,
    dayOffset: 35,
    label: "Probate / trust / estate",
    subject: "the complicated ones",
    body: `Hi {{first_name}} — probate, trusts, estates, divorce sales: the deals with messy paperwork and messier timelines. I've closed them, I'm patient with courts, and thirty years of deferred maintenance is fine by me.

If you've got one of these in your pipeline, I'm probably the easiest phone call you'll make on it.`,
  },
  {
    touch: 10,
    dayOffset: 40,
    label: "Market observation (WRITE FRESH AT SEND TIME)",
    subject: null, // placeholder — engine refuses to draft until filled in
    body: null,
  },
  {
    touch: 11,
    dayOffset: 45,
    label: "Year-end thanks (pitch-free)",
    subject: "thanks",
    body: `{{first_name}} — as the year wraps up, just wanted to say thanks for staying connected. This business runs on relationships and I don't take them for granted.

Have a great holiday season. I'll be buying again in the new year — talk soon.`,
  },
]

export function renderTouch(touchNumber, contact) {
  const t = TOUCHES.find((x) => x.touch === touchNumber)
  if (!t) return null
  if (!t.subject || !t.body) return { placeholder: true, label: t.label }
  const first = (contact.first_name || contact.name || "").trim().split(/\s+/)[0] || "there"
  const fill = (s) => s.replaceAll("{{first_name}}", first)
  return {
    placeholder: false,
    label: t.label,
    subject: fill(t.subject),
    body: `${fill(t.body)}\n\n${makeSignature()}`,
  }
}

export function nextOffsetDays(touchJustSent) {
  const next = TOUCHES.find((x) => x.touch === touchJustSent + 1)
  return next ? next.dayOffset : null // null → sequence complete
}
