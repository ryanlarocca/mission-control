// Reply Planner — Relationships-side guidance. The CRMS tab's two knobs
// (intent × familiarity) plus the contact's category become the plan for a
// relationship touch. This distils the instruction content of the old
// /api/crms/generate prompt table into per-(category, intent) guidance —
// rules only, no example sentences (those ship verbatim).

export type RelIntent = "CatchUp" | "Deal" | "Referral" | "Portfolio"
export type RelFamiliarity = "Knows" | "Reintro"

export function normalizeCategory(c: string | null | undefined): string {
  const s = (c || "").trim()
  if (s === "Property Manager") return "PM"
  if (s === "Personal Contact") return "Personal"
  if (/^private money$/i.test(s)) return "PrivateMoney"
  return s || "Agent"
}

export function intentForMoment(moment: string | null | undefined): RelIntent {
  switch (moment) {
    case "check_in":
    case "life_event":
    case "reply_to_them": return "CatchUp"
    case "referral_ask": return "Referral"
    default: return "Deal"
  }
}

export function relationshipGuidance(args: {
  category: string
  intent: RelIntent
  familiarity: RelFamiliarity
  everContacted: boolean
  moment: string
}): string {
  const { category, intent, familiarity, everContacted, moment } = args
  const lines: string[] = []

  // Opener
  if (!everContacted) {
    lines.push("FIRST-EVER OUTREACH: Ryan has never contacted this person through the CRMS. Do not imply a prior conversation (no \"been a while\", \"since we last connected\", \"reaching back out\"). A genuine first note.")
  } else if (familiarity === "Knows") {
    lines.push("They know Ryan. Do not introduce him or explain who he is. Open warm, first name only, like texting someone you already know.")
  } else {
    lines.push("They may not remember Ryan. Open with his full name once. If the notes show real history it is fine to say it has been a while; otherwise say he had their contact saved. One short line of reintroduction, no backstory.")
  }

  // Intent × category
  const business = ["Agent", "Investor", "Seller", "PrivateMoney", "PM"].includes(category)
  if (moment === "reply_to_them") {
    lines.push("They wrote last. Answer what they actually said or asked before anything else. Do not restart the conversation.")
  } else if (moment === "life_event") {
    lines.push("Something happened for them (a sale, a baby, a move). Acknowledge that specifically and warmly; no business ask in the same message.")
  } else if (intent === "CatchUp") {
    lines.push(category === "Personal"
      ? "Close friend. Not a business message: no deals, no real estate. Genuine how-are-you energy, forward-looking, no \"I know it's been a while\"."
      : "A genuine check-in, not prospecting. Ask how they are or how business is; reference something current from the notes if there is something good. Do not pitch, do not ask about deals or properties, do not mention that Ryan is buying.")
  } else if (intent === "Referral") {
    lines.push("A direct referral ask; get to the point, no \"just checking in\". Ryan is actively buying in the Bay Area and pays a share of the profit on a referral that closes; ask them to send any owner looking to sell (a fixer, a tired rental, an estate) his way. Confident, not salesy.")
  } else if (intent === "Portfolio" || category === "PM") {
    lines.push("Property manager. Ask whether anything in their portfolio has come up for sale or any owners are thinking about selling. Short.")
  } else if (category === "Vendor") {
    lines.push("Vendor or tradesperson. Check in on them and their work; ask whether they are still taking on jobs. Ryan may have work coming up. Not a real-estate prospecting message: no \"deals\", \"properties coming up\", \"anything interesting\".")
  } else if (category === "PrivateMoney") {
    lines.push("Capital partner. Check in, then signal that Ryan is actively finding deals and would like to partner on a project. Peer to peer, not a pitch deck. Never the phrase \"fixers and value-add\".")
  } else if (business) {
    lines.push("Agent or investor Ryan works with. Check in first, then say plainly that Ryan is looking for a project or deal to work on together, the casual way he says it (\"looking for a project right now\", \"let me know if you come across anything\"). Not an investor pitch.")
  } else {
    lines.push("Warm reconnect. No business talk unless the notes make it natural.")
  }

  lines.push("Length: 1 to 3 short sentences. No sign-off, no emojis. \"Hey\" not \"Hi\".")
  return lines.map((l) => `- ${l}`).join("\n")
}
