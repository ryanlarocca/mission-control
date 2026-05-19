// Shared CRMS contact-category definitions. Previously duplicated across
// app/api/crms/contacts/route.ts, app/api/crms/category/route.ts,
// app/api/leads/[id]/promote-to-relationship/route.ts, and the picker in
// LeadsTab.tsx — adding a new category meant editing four places and the
// odds of missing one were high. Single source of truth lives here.

export type RelationshipCategory =
  | "Agent"
  | "Vendor"
  | "Personal"
  | "PM"
  | "Investor"
  | "PrivateMoney"
  | "Seller"

export const RELATIONSHIP_CATEGORIES: readonly RelationshipCategory[] = [
  "Agent",
  "Vendor",
  "Personal",
  "PM",
  "Investor",
  "PrivateMoney",
  "Seller",
] as const

// Display labels for the UI picker. "PM" → "Property Mgr" so users don't
// have to remember the abbreviation; the underlying value stays "PM" to
// keep the Sheet1 column-E values short.
export const RELATIONSHIP_CATEGORY_LABELS: Record<RelationshipCategory, string> = {
  Agent:    "Agent",
  Vendor:   "Vendor",
  Personal: "Personal",
  PM:       "Property Mgr",
  Investor: "Investor",
  PrivateMoney: "Private Money",
  Seller:   "Seller",
}

// Order shown in the inline picker on the Leads tab Promote button. Most
// common at the top so Ryan doesn't have to scan.
export const RELATIONSHIP_CATEGORY_PICKER_ORDER: readonly RelationshipCategory[] = [
  "Agent",
  "Vendor",
  "Investor",
  "PrivateMoney",
  "PM",
  "Personal",
  "Seller",
] as const

export function isValidCategory(s: string): s is RelationshipCategory {
  return (RELATIONSHIP_CATEGORIES as readonly string[]).includes(s)
}

// Normalize legacy / verbose labels the BoB sheet sometimes carries
// ("Property Manager", "Personal Contact") into the canonical enum.
export function normalizeCategory(raw: string): RelationshipCategory {
  const s = (raw || "").trim()
  if (s === "Property Manager") return "PM"
  if (s === "Personal Contact") return "Personal"
  if (s === "Private Money" || s === "Private money") return "PrivateMoney"
  if (isValidCategory(s)) return s
  return "Agent"
}
