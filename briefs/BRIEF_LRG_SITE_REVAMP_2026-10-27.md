# BRIEF — lrghomes.com revamp + "Ryan LaRocca" search clean-up

**Status (2026-10-28, evening):** website LIVE and wrapped (`lrg-homes-website` `d78e72b`);
Mission Control Website-line change merged (`277516d`). §5 profile copy and §6 takedown drafts are
still DRAFTS — nothing sent; they belong to the next project (web presence). Current state lives in
`PROJECTS/lrg-public-web/PROJECT_MEMO.md`, not here.
Owner project: `PROJECTS/lrg-public-web/`.

## 1. The job of the site (Ryan, 2026-10-27)

lrghomes.com is the top result for "LRG Homes". Its job is **credibility when anyone looks
Ryan up** — letter/email recipients, agents, people from social media. Not lead-gen.
Old site = a cash-offer form with words around it (Ryan's quick stopgap). New site = videos,
stories, reviews, people who've happily worked with him. Searching his *name* still surfaces
agent-era profiles (Zillow #1) and he is no longer licensed — those get shut down **after**
the new site is live, so there's never a moment where his name turns up less than today.

## 2. What was built tonight

Repo: `~/Projects/lrg-homes-website` (Vercel project `lrg-homes-website`, CLI deploys only —
no Git integration; production changes only with `vercel deploy --prod`).

- `styles.css` — one design system, two looks via CSS tokens: **Daylight** (warm off-white,
  terracotta) and **Night** (near-black, amber). `<html data-theme="night">` switches.
  Legacy class names kept so `blog/*.html` restyle for free.
- `index.html` — hero (intro-video slot + one-line pitch, no form) → proof strip (5.0 Google,
  12+ yrs, 24-hr offer, 5-day close) → "Yes, it's really me — how to check" → three stories
  (Halleck / Ridgeview / Quito, real Drive photos, Rob & Diana + Bill D quotes) → video
  testimonial slots → review wall (Rob & Diana, Bill D, Cynthia Riddle; Google + Yelp badges)
  → About Ryan + team (Amanda Bakshi named, DRE 02110753) → 3-step process → "For agents"
  → contact (phone, email, form at the very bottom).
- `about.html` — the **"Ryan LaRocca" name page** (Person schema, FAQ incl. "Are you an
  agent?" → "Not anymore"). `/ryan-larocca` and `/ryan` redirect here (vercel.json).
- `how-it-works.html` — 5 steps, "what you don't have to do", FAQ (FAQPage schema). Claims
  fixed to what Ryan confirmed: offer within 24 h **after seeing the house**, close as fast as
  5 days, 12+ years, no project count.
- `thank-you.html`, `blog.html` (now "Articles", out of the main nav), 6 posts restyled.
- Photos: `assets/images/stories/{halleck,ridgeview,quito}/*.jpg` from Drive
  `Properties/<addr>/Photos/MLS` (Ridgeview: `Photos`), 1600 px, mozjpeg q74, 4.1 MB total.
- Form (`api/submit-lead.js`): asks **what it's about** (sell / deal / other). Source is now
  `Website` / `website`. Only *sell + text-consent checkbox* enrolls in the `google_ads_form`
  cadence (the cadence keeps its old name); the lead SMS also needs consent (A2P gap closed).
  Alert SMS to Ryan now says `WEBSITE — <about>` and whether texts are OK.
- Preview-only **Look switch** (bottom-left pill) on every page. Remove before go-live.
- Removed: Santa Clara street address and the cross-source AggregateRating from schema;
  stock photos; emoji icons; "Get Offer" buttons; the two in-page offer forms.

### Mission Control (branch, not merged)
`lib/leads.ts`: `+16506703914` label `Google` → `Website`; `GOOGLE_ADS_LANDING_NUMBER` →
`WEBSITE_NUMBER`. `voice`/`sms` routes: `source_type=website`, **no drip stamp on intake**.
`send-email`: website leads reply from info@. `drip-campaigns.pickCampaignType`: Website →
`google_ads_form` when Ryan taps Apply Drip. `tsc --noEmit` clean. Twilio friendly name of
the line changed "Landing Page" → "Website (lrghomes.com)" (done, live, harmless).

### Vercel
Preview deployments were SSO-protected (Ryan couldn't open them on his phone). Project
setting `ssoProtection` set to **null** on 2026-10-28 so the preview link works. Production
was already public. Re-enable later if wanted (one API call / dashboard toggle).

## 3. Open for Ryan (morning)

1. **Pick a look** — Daylight or Night (or "Daylight but …").
2. **Who is Paula?** Assumed the sister whose estate Halleck was. If so the Halleck story gets
   her name; if not, tell me.
3. **Videos** — intro video for the hero; testimonial slots are labelled "Coming soon".
4. **Before photos** — none in Drive; phone pics of Halleck/Quito pre-refresh would make the
   stories land.
5. **Approve go-live**, then the sequence in §4.

## 4. Go-live sequence (do in this order)

1. Remove the look switch, hard-set the chosen look as default, delete the other one's
   tokens or leave them (harmless).
2. `vercel deploy --prod` from `~/Projects/lrg-homes-website`; commit + push the repo.
3. Merge the Mission Control branch to `main` (Vercel auto-deploys MC).
4. Smoke: submit the form once as "Something else" (no drip, no lead SMS) and once as
   "Selling" with consent → check the Leads tab shows source **Website**.
5. Update Google Business Profile, Facebook, LinkedIn (copy in §5).
6. Only then: send the takedown requests (§6). Re-search the name a week later.

## 5. Profile copy (paste-ready)

### Google Business Profile  (business.google.com, account 15180149274481616608)
- **Business name:** LRG Homes
- **Category:** Property investment company (keep). Secondary: Real estate consultant — *skip*
  (sounds like an agent).
- **Address → Service-area business.** Clear the Santa Clara street address ("Hide my address"
  / "I deliver goods and services to my customers") and set service areas: San Jose,
  Santa Clara County, San Mateo County. This is Google's standard fix for a "stuck" address.
- **Phone:** leave blank (Ryan's choice — spam). Optional later: the website line.
- **Website:** https://www.lrghomes.com
- **Description (≤750 chars):**
  > LRG Homes is Ryan LaRocca's San Jose company. We buy single-family homes and small
  > multifamily buildings across the South Bay — estates, inherited houses, fixers,
  > tenant-occupied, any condition — then renovate them properly and sell them to families.
  > Written cash offer within 24 hours of seeing the house; close in as little as 5 days or
  > on your timeline. No repairs, no commissions, no open houses. Ryan grew up in San Jose,
  > started in the trades, and has done this full-time since 2017. LRG Homes LLC is a real
  > estate investment company, not a brokerage; our listings are handled by Amanda Bakshi,
  > TSG Premier Realty.
- **Reply to Rob & Diana's review (unanswered since Oct 5):**
  > Rob and Diana — thank you. Settling a family home from out of state is a lot, and you
  > made it easy on our end. Glad the weekly updates helped. — Ryan

### Facebook page  (facebook.com/lrghomesbayarea — Ryan is admin)
- **Category:** Real Estate Investment Firm (remove "Real Estate Agent").
- **Intro (≤101 chars):** `We buy and renovate houses in San Jose & the South Bay. Ryan LaRocca, since 2017.`
- **About:** same as the GBP description above.
- **Email:** info@lrghomes.com (replace info@ryanlarocca.com — that domain is no longer
  Ryan's; a stranger registered it Jan 2026).
- **Location:** remove Santa Clara; set "San Jose, California" with no street address.
- **Remove** the "top 1% of agents" line and the 2022 "JUST LISTED" post if he wants a clean
  slate (optional).

### LinkedIn  (linkedin.com/in/ryanlarocca)
- **Headline:** `Founder, LRG Homes — I buy and renovate houses in San Jose & the South Bay`
- **About:**
  > I grew up in San Jose, started in commercial HVAC, spent several years as an agent with
  > Keller Williams and Intero, and since 2017 have bought and renovated South Bay houses
  > full-time through LRG Homes. Estates, inherited homes, fixers, tenant-occupied — any
  > condition. Agents: bring me the house nobody wants to list. lrghomes.com
- Experience: make sure the KW / Intero agent roles have end dates.

### Yelp  (keep; it's good proof) — if there's an editable "From the business" blurb, use the
GBP description. Category stays.

## 6. Takedown requests (DRAFTS — send after go-live)

Ryan's old DRE license number is needed for Realtor.com / Homes.com / LoopNet; fill `[DRE #]`.
All four are agent profiles built from MLS/brokerage feeds; the lever is "I am no longer a
licensed agent and the profile is inaccurate."

**Zillow** — profile `zillow.com/profile/ryanlarocca9` (+ a second `/profile/info12127`).
Fastest: log into the Zillow account that owns it → Profile → "Deactivate" (or support
chat). If no access: Zillow Help → "Agent profile" → request removal:
> Subject: Remove inactive agent profile — Ryan LaRocca (zillow.com/profile/ryanlarocca9)
> I am no longer a licensed real estate agent and this profile presents me as one. Please
> remove the profile at zillow.com/profile/ryanlarocca9 (and any duplicate under my name,
> e.g. zillow.com/profile/info12127). I can verify ownership via the email on the account.
> — Ryan LaRocca, LRG Homes LLC, San Jose

**Realtor.com** — profile `realtor.com/realestateagents/58ff92434337d30010fa26…` (San Jose
95123). Realtor.com Customer Care (support form / 1-800-878-4166):
> Subject: Remove agent profile — license no longer active — Ryan LaRocca
> My California license [DRE #] is no longer active and I no longer practice as an agent.
> Please remove my agent profile (Ryan Larocca, San Jose, CA 95123) from realtor.com.
> — Ryan LaRocca

**Homes.com (CoStar)** — profile `homes.com/real-estate-agents/ryan-larocca/18vrgl5`
("TSG Premier Realty, Rocklin"). Homes.com support → agent profile removal:
> Subject: Remove inactive agent profile — Ryan Larocca (18vrgl5)
> I am not a licensed agent and am not affiliated with TSG Premier Realty as an agent. The
> profile at homes.com/real-estate-agents/ryan-larocca/18vrgl5 is inaccurate; please remove it.
> License [DRE #] is inactive. — Ryan LaRocca

**LoopNet (CoStar)** — broker profile "Ryan Larocca | LRG Homes | Santa Clara". LoopNet
support (same parent as Homes.com; one ticket can reference both):
> Subject: Remove broker profile — not a licensed broker — Ryan Larocca / LRG Homes
> I'm a principal buyer, not a broker, and hold no active license. Please remove the
> LoopNet broker profile for Ryan Larocca (LRG Homes, Santa Clara, CA). — Ryan LaRocca

**Leave alone:** Yelp, Yahoo Local, MapQuest (business listings, accurate enough); Bizapedia /
bizprofile / sfranalytics (public LLC records). Other Ryan LaRoccas (Beach Point analyst,
CDF labor lawyer, MUFG) can't be removed — the name page (`/about`, `/ryan-larocca`) is
how we outrank them.

## 7. Search audit, 2026-10-27 (DuckDuckGo; Google blocks headless)

"Ryan LaRocca": 1 Zillow agent profile · 2 Beach Point (other person) · 3 LinkedIn ·
4 lrghomes.com/about · 5 Yelp · 6 CDF Labor Law (other) · 7 LoopNet · 8 Homes.com ·
9 lrghomes.com · 10 LinkedIn (MUFG, other). "LRG Homes": site #1–2, then Louie Realty
Group (lrg.homes), Bizapedia, Facebook, Yelp.
