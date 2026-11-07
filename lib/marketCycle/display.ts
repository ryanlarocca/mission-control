// How each dial reads on /cycle (Ryan 2026-11-07 walkthrough, mockup
// PROJECTS/market-cycle-tracker/mockups/full-page-v2.png): a plain name with no
// source prefix, one short gray line saying what it is, a group for the scroll
// box, and a rank for the key numbers on top. Dials not listed here are not
// shown (they are still collected and still vote).

export type DisplayFormat = "pct" | "pct_signed" | "usd" | "usd_m" | "int" | "num" | "ratio" | "pts"

export interface DialDisplay {
  label: string
  /** What it is, in a few words (the cadence and date are added by the page). */
  what?: string
  group: DisplayGroup
  format: DisplayFormat
  /** Position among the key numbers on top (1 = first); absent = scroll box only. */
  key?: number
  /** Display-only context: always gray, never good/bad. */
  context?: boolean
}

export type DisplayGroup =
  | "Home prices"
  | "Supply & pace"
  | "Distress & rent"
  | "Local jobs"
  | "Rates"
  | "Inflation & oil"
  | "US economy"
  | "Stocks & credit"
  | "Context — never votes"

export const GROUP_ORDER: DisplayGroup[] = [
  "Home prices",
  "Supply & pace",
  "Distress & rent",
  "Local jobs",
  "Rates",
  "Inflation & oil",
  "US economy",
  "Stocks & credit",
  "Context — never votes",
]

export const DISPLAY: Record<string, DialDisplay> = {
  // ---- key numbers (also live in their group, but shown once: on top)
  zhvi_scc_drawdown: { label: "Drop from peak", what: "Typical SCC house vs the Jan 2025 peak", group: "Home prices", format: "pct_signed", key: 1 },
  mls_scc_active_sfr: { label: "Homes for sale", what: "Single-family, this week", group: "Supply & pace", format: "int", key: 2 },
  realtor_price_reduced_share_scc: { label: "Price cuts", what: "Share of listings with a cut", group: "Supply & pace", format: "pct", key: 3 },
  realtor_pending_ratio_scc: { label: "Buyer pace", what: "Homes going into contract per home for sale", group: "Supply & pace", format: "ratio", key: 4 },
  mortgage30: { label: "Mortgage rate", what: "30-year fixed", group: "Rates", format: "pct", key: 5 },
  brent: { label: "Oil (Brent)", what: "Per barrel", group: "Inflation & oil", format: "usd", key: 6 },
  sp500: { label: "S&P 500", group: "Stocks & credit", format: "int", key: 7 },
  nasdaq: { label: "NASDAQ", group: "Stocks & credit", format: "int", key: 8 },
  sj_msa_nonfarm_yoy: { label: "San Jose job growth", what: "Jobs vs a year ago", group: "Local jobs", format: "pct_signed", key: 9 },

  // ---- home prices
  zhvi_scc: { label: "Typical SCC home value", what: "Single-family", group: "Home prices", format: "usd" },
  zhvi_scc_yoy: { label: "Home value vs last year", group: "Home prices", format: "pct_signed" },
  zhvi_scc_top_yoy: { label: "High-end homes vs last year", group: "Home prices", format: "pct_signed" },
  zhvi_scc_bottom_yoy: { label: "Lower-end homes vs last year", group: "Home prices", format: "pct_signed" },
  realtor_median_list_price_scc: { label: "Asking prices vs last year", what: "Median list price, all types", group: "Home prices", format: "pct_signed" },
  mls_scc_list_to_sale: { label: "Sale-to-list price", what: "Recent sales vs asking", group: "Home prices", format: "pct" },
  zhvi_scc_condo_yoy: { label: "Condos/townhomes vs last year", what: "Context only", group: "Home prices", format: "pct_signed", context: true },

  // ---- supply & pace (MLS weekly is the headline; Realtor.com monthly is the "normal" yardstick)
  mls_scc_new_listings_7d: { label: "New listings", what: "This week", group: "Supply & pace", format: "int" },
  mls_scc_median_dos: { label: "Days on market", what: "Median, this week", group: "Supply & pace", format: "int" },
  scc_months_supply: { label: "Months of supply", what: "Time to sell every listing", group: "Supply & pace", format: "num" },
  car_scc_sfr_sales: { label: "Closed sales", what: "Single-family", group: "Supply & pace", format: "int" },
  mls_scc_withdrawn_share: { label: "Withdrawn / relisted", what: "Share of listings", group: "Supply & pace", format: "pct" },
  realtor_active_scc: { label: "Homes for sale (all types)", what: "Monthly; the yardstick for 'normal'", group: "Supply & pace", format: "int" },

  // ---- distress & rent
  scc_nod_count: { label: "Notices of default", what: "Owners behind on their mortgage, weekly", group: "Distress & rent", format: "int" },
  sj_rent_yoy: { label: "San Jose rent vs last year", group: "Distress & rent", format: "pct_signed" },

  // ---- local jobs
  scc_warn_workers_30d: { label: "Layoff notices, last 30 days", what: "Workers in SCC layoff filings", group: "Local jobs", format: "int" },
  scc_unemployment: { label: "SCC unemployment", group: "Local jobs", format: "pct" },
  indeed_postings_sj: { label: "San Jose job postings", what: "Indeed, Feb 2020 = 100", group: "Local jobs", format: "num" },
  indeed_software_us: { label: "Software job postings (US)", what: "Indeed, Feb 2020 = 100", group: "Local jobs", format: "num" },

  // ---- rates
  ust10y: { label: "10-year Treasury", group: "Rates", format: "pct" },
  ust2y: { label: "2-year Treasury", group: "Rates", format: "pct" },
  curve_2s10s: { label: "10-yr minus 2-yr", what: "Below 0 has come before recessions", group: "Rates", format: "pts" },
  mortgage_spread: { label: "Mortgage spread", what: "Mortgage rate over the 10-year, basis points", group: "Rates", format: "int" },
  fed_funds_target_upper: { label: "Fed rate", what: "Changes only at Fed meetings", group: "Rates", format: "pct" },

  // ---- inflation & oil
  cpi_yoy: { label: "Inflation (CPI)", what: "vs a year ago", group: "Inflation & oil", format: "pct" },
  core_cpi_yoy: { label: "Core inflation (CPI)", what: "Without food & gas", group: "Inflation & oil", format: "pct" },
  pce_yoy: { label: "Inflation (PCE)", what: "The Fed's measure", group: "Inflation & oil", format: "pct" },
  core_pce_yoy: { label: "Core inflation (PCE)", what: "Without food & gas", group: "Inflation & oil", format: "pct" },

  // ---- US economy
  payrolls_mom: { label: "Jobs added (US)", what: "Thousands, per month", group: "US economy", format: "int" },
  unrate_us: { label: "US unemployment", group: "US economy", format: "pct" },
  initial_claims_4wk: { label: "New jobless claims", what: "4-week average", group: "US economy", format: "int" },
  sahm_gap: { label: "Recession alarm (Sahm)", what: "Trips at 0.50", group: "US economy", format: "num" },
  us_real_gdp_qoq: { label: "GDP growth", what: "Annual rate", group: "US economy", format: "pct" },

  // ---- stocks & credit
  basket_index: { label: "Bay Area tech employers", what: "Big local employers' stocks, combined", group: "Stocks & credit", format: "num" },
  ccc_oas: { label: "Junk-bond risk premium", what: "Extra interest the riskiest companies pay", group: "Stocks & credit", format: "pts" },

  // ---- context
  cs_national: { label: "US home prices", what: "Case-Shiller index", group: "Context — never votes", format: "num", context: true },
  cs_sf_metro: { label: "SF metro home prices vs last year", group: "Context — never votes", format: "pct_signed", context: true },
  car_sf_sfr_median_yoy: { label: "SF single-family median vs last year", group: "Context — never votes", format: "pct_signed", context: true },
  fhfa_hpi_sj: { label: "San Jose home prices (FHFA)", what: "Quarterly", group: "Context — never votes", format: "pct_signed", context: true },
}

/** Nearby markets card (Zillow only), in order. */
export const NEARBY: { dial: string; label: string; note?: string }[] = [
  { dial: "zhvi_scc", label: "Santa Clara County", note: "for comparison" },
  { dial: "zhvi_area_san_mateo", label: "San Mateo County" },
  { dial: "zhvi_area_sf", label: "San Francisco" },
  { dial: "zhvi_area_santa_cruz", label: "Santa Cruz County" },
  { dial: "zhvi_area_fremont", label: "Fremont" },
]

/** Price bands for the table: MLS tier dials. */
export const PRICE_BANDS: { label: string; active: string; cuts: string }[] = [
  { label: "Under $1.3M", active: "mls_scc_tier_lt_1_3m_active_sfr", cuts: "mls_scc_tier_lt_1_3m_price_cut_share" },
  { label: "$1.3–2M", active: "mls_scc_tier_1_3m_2m_active_sfr", cuts: "mls_scc_tier_1_3m_2m_price_cut_share" },
  { label: "$2–3M", active: "mls_scc_tier_2m_3m_active_sfr", cuts: "mls_scc_tier_2m_3m_price_cut_share" },
  { label: "$3M+", active: "mls_scc_tier_3m_plus_active_sfr", cuts: "mls_scc_tier_3m_plus_price_cut_share" },
]
