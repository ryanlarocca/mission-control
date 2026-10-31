// Listing status stamped on leads.listing by scripts/listing-status.py
// (public MLSListings search). Shared by the Leads list, the lead card and
// the Follow Ups worklist.
export interface LeadListing {
  status: "Active" | "Active Under Contract" | "Pending" | "Contingent" | "not_listed" | string
  price?: number | null
  dom?: number | null
  type?: string | null
  mls?: string | null
  url?: string | null
  source?: string
  checked_at?: string
}

export const ON_MARKET_STATUSES = new Set(["Active", "Active Under Contract", "Pending", "Contingent"])

export function isOnMarket(l: LeadListing | null | undefined): boolean {
  return !!l && ON_MARKET_STATUSES.has(l.status)
}

export function fmtListingPrice(n: number | null | undefined): string {
  if (!n) return ""
  return n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M` : `$${Math.round(n / 1000)}k`
}

// "ON MARKET · $2.85M · 69d" / "PENDING · $2.5M"
export function listingChipLabel(l: LeadListing): string {
  const head = l.status === "Active" ? "On market" : l.status
  return [head, fmtListingPrice(l.price), l.dom != null ? `${l.dom}d` : ""].filter(Boolean).join(" · ")
}
