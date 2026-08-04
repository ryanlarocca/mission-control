# Squarespace Severance Runbook — 2026-07-27

**Goal:** completely sever ties with Squarespace while keeping Google Workspace
email (all history intact) and all live systems (Vercel sites, Twilio, campaign
engine) running without interruption.

**End state:** Workspace billed directly by Google · lrghomes.com registered at
Cloudflare · Squarespace account holds nothing · $276 refund requested.

---

## What Squarespace currently holds (audited 2026-07-27)

| Subscription | Detail | Fate |
|---|---|---|
| Website plan (Business, annual) | `reindeer-oriole-paaw.squarespace.com` — the OLD site, zero traffic since ~May 2025. Renewed **Jul 25, 2026** for $276 (invoice #244095400), paid through Jul 2027. Next renewal $331. | Cancel + request refund |
| Domain `lrghomes.com` | ~$20/yr, renews **Sep 29, 2026**. Nameservers: legacy Google Cloud DNS (`ns-cloud-c*.googledomains.com`). | Transfer to Cloudflare |
| Google Workspace Business Starter | **10 licenses**, reseller-billed via Squarespace since Nov 20 2025. Runs ryan@, info@ (campaign engine sender, Gmail API + service-account DWD). | Move billing to Google direct |

**What does NOT depend on Squarespace:** live site www.lrghomes.com (Vercel),
landing page (Vercel), Mission Control (Vercel), Twilio, Supabase, email
*data* (lives in Google's tenant — Squarespace only bills).

**Verified facts:**
- MX → Google (aspmx.l.google.com + alts). DKIM (`google._domainkey`) present.
- SPF: `v=spf1 include:_spf.google.com ~all`. Campaign engine sends via Gmail
  API as info@ — **not** Brevo. Brevo DNS remnants are stale (old trial).
- Squarespace subscriptions are independent — cancelling one cannot cancel
  another (their documented policy).

---

## Phase 0 — Safety net (Day 1, before touching anything)

- [ ] **Google Takeout backup of ryan@** — takeout.google.com → deselect all →
      Mail → export. Runs in background (hours); download the archive when the
      email arrives. Zero-risk posture: even a worst-case screwup can't lose
      history once this exists. Repeat for any other mailbox that matters.
- [ ] **Admin hygiene** (the old assistant-setup knot): admin.google.com →
      Directory → Users → confirm **ryan@ is Super Admin**; check
      Account → Admin roles for any stale admin (assistant's address) — demote
      or secure it. Set recovery email + phone on ryan@.
- [ ] Confirm a current payment card is ready for Google billing.

## Phase 1 — Workspace billing: Squarespace → Google (Day 1, one 20-min sitting)

Cancelling Workspace **in Squarespace** IS the transfer mechanism (per
Squarespace + Google docs). No downtime; 7-day grace to add billing at Google.

- [ ] Squarespace → Billing → Subscriptions → **Google Workspace** → Cancel.
- [ ] **Immediately** admin.google.com → Billing → set up direct payment.
- [ ] Send/receive a test email. Confirm subscription shows "billed by Google."
- [ ] One-way door (can't return to Squarespace billing) — that's the goal.

## Phase 2 — Trim the 10 seats (Day 1–2, after Phase 1)

- [ ] List users in Directory. Likely need 2–3 paid seats (ryan@, info@, ?).
- [ ] **Never delete info@** (campaign engine sender).
- [ ] For defunct addresses that should still receive mail: delete user →
      re-add address as a free **alias** on ryan@. Deleting a user deletes its
      mailbox — Takeout that mailbox first if its history matters.
- [ ] ~$8.40/user/mo direct → trimming 10 → 3 saves ~$60/mo.

## Phase 3 — Refund attempt + website plan (Day 1, parallel)

- [ ] Squarespace live chat (Help → Contact Us): *"Invoice #244095400 renewed
      my Business website plan Jul 25 for $276. The site has had no traffic
      since mid-2025 — my domain points elsewhere. I missed the renewal by two
      days; please cancel the website subscription and refund the renewal. I am
      keeping my domain (and Workspace, until its transfer completes)."*
- [ ] Refused? Toggle **auto-renew OFF**, walk away (paid through Jul 2027).
- [ ] **NO credit-card chargeback** while the domain still sits at Squarespace
      — a dispute can freeze the whole account. Support request only.

## Phase 4 — Domain → Cloudflare (Days 2–10; complete before ~Sep 15)

DNS-first, transfer-second — email never blips because records exist at
Cloudflare before anything switches.

- [ ] **Pre-check:** if the registrant contact/ownership changed within the
      last 60 days, ICANN's transfer lock may apply — check for a lock notice
      in Squarespace domain settings before starting.
- [ ] Create Cloudflare account → Add site `lrghomes.com` (free plan) → it
      auto-scans DNS. Verify/enter the full zone (below). Set Vercel records
      to **DNS-only (grey cloud), NOT proxied**.
- [ ] At Squarespace: change nameservers to the two Cloudflare-assigned ones.
- [ ] Wait for Cloudflare "active" (usually <24 h). **Verify:** send/receive
      email, load www.lrghomes.com, submit a test lead form.
- [ ] Run 2–3 days on Cloudflare DNS to be sure. Then: Squarespace → domain →
      unlock transfer → get auth/EPP code → Cloudflare → Domain Registration →
      Transfer in (~$10.44, adds +1 yr past Sep 29). Approve the confirmation
      email to skip the 5-day wait.
- [ ] After transfer completes: Squarespace holds nothing. Optionally close
      the account (only after refund resolution + Workspace shows Google-billed).

### DNS zone to recreate at Cloudflare (from live audit 2026-07-27)

| Type | Name | Value | Note |
|---|---|---|---|
| MX | @ | `1 aspmx.l.google.com` | |
| MX | @ | `5 alt1.aspmx.l.google.com` | |
| MX | @ | `5 alt2.aspmx.l.google.com` | |
| MX | @ | `10 alt3.aspmx.l.google.com` | |
| MX | @ | `10 alt4.aspmx.l.google.com` | |
| TXT | @ | `v=spf1 include:_spf.google.com ~all` | |
| TXT | `google._domainkey` | (copy full DKIM value from current DNS — starts `v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A...`) | dig it fresh at migration time |
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:ryan@lrghomes.com` | **updated 2026-08-04** — p=quarantine (deliverability audit: p=none costs inbox placement; SPF authorizes only Google + only google DKIM selector exists, so quarantine is safe). Change at Squarespace NOW, don't wait for migration. |
| TXT | @ | (google-site-verification=… from postmaster.google.com setup) | Postmaster Tools verification — value generated when Ryan adds lrghomes.com at postmaster.google.com |
| A | @ | `76.76.21.21` | Vercel — DNS-only |
| CNAME | `www` | `cname.vercel-dns.com` | Vercel — DNS-only |
| ~~TXT~~ | @ | ~~`brevo-code:635f8fdb...`~~ | **drop** — stale Brevo trial |

## Verify checklist (after each phase)

- Email in/out from ryan@ ✓ · www.lrghomes.com loads ✓ · landing page form →
  CRMS ✓ · campaign engine sends as info@ ✓ (check next scheduled batch)

## Out of scope here (separate effort)

- Google Voice → Twilio ports (the ~$200/mo Google spend) — inventory Voice
  numbers, port keepers to Twilio BEFORE dropping Voice licenses.
