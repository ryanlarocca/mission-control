# Brief: secondary sending domain for the agent drip (2026-08-25)

Ryan's decision (2026-08-25): build our own deliverability stack instead of
paying a platform to wrap. Research summary in agent-email-v2 CHANGELOG
2026-08-25. The consumer gmail.com sender stays only for the Phase B cohort
test; the drip moves to a secondary domain with Google's own measurement
(Postmaster Tools) once it is warm.

## Design
- Domain: `lrghomesbuys.com` (available 2026-08-25; alternates lrghomes.co,
  lrghomesoffers.com, buylrghomes.com, lrgbuys.com). Registered at Cloudflare
  (same registrar as lrghomes.com).
- Mail: added as a **secondary domain of the existing lrghomes Workspace**
  (Admin → Account → Domains → Add a domain). One user `ryan@lrghomesbuys.com`
  (~$7/mo). Because it is the same tenant, the existing service-account
  Domain-Wide Delegation covers it — no OAuth consent, no 7-day token expiry.
- DNS on the new zone: MX (Google), SPF `v=spf1 include:_spf.google.com -all`,
  DKIM (2048-bit, generated in Admin → Apps → Gmail → Authenticate email),
  DMARC `v=DMARC1; p=quarantine; rua=mailto:dmarc@lrghomes.com; pct=100`,
  Postmaster Tools verification TXT. Reply-To on every send = ryan@lrghomes.com.
- Engine: multi-sender rotation (`CAMPAIGN_SENDERS` list, per-sender daily
  cap), engagement-first ramp (known repliers + Relationships agents before
  cohort strangers), daily canary with auto-pause, Postmaster reputation
  pulled daily into the health card once the v2 API is authorized.

## Warm-up plan (4 weeks, no warm-up network)
| Week | Volume/day | Who |
|---|---|---|
| 1 | 5–10 | agents who replied in July (37), Ryan's team, Relationships tier-1 agents — copy asks a question that invites a reply |
| 2 | 10–20 | remaining Relationships agents + repliers' follow-ups |
| 3 | 20–35 | cohort variants begin (same A/B/C test) |
| 4+ | 35–50 per mailbox | steady state; add a 2nd mailbox before exceeding 50/day |
Gate to advance: Postmaster domain reputation High/Medium, spam rate <0.1%,
canary Primary 3 days running, bounces <2%.

## Ryan's to-do (in order)
1. Register `lrghomesbuys.com` at Cloudflare (Domain Registration → Register).
2. Workspace Admin → Account → Domains → **Add a domain** → secondary domain →
   verify (Google gives a TXT record; add it in Cloudflare DNS).
3. Admin → Directory → Users → add user `ryan@lrghomesbuys.com` (assign a seat).
4. Admin → Apps → Google Workspace → Gmail → Authenticate email → select the
   new domain → Generate new record (2048) → copy the DKIM TXT.
5. Cloudflare: give the agent a scoped API token (Zone → DNS → Edit, only
   the new zone) so DNS records get written and verified from here — or
   paste the records yourself from this brief.
6. postmaster.google.com → Add domain → copy the verification TXT (same
   Cloudflare step).

Agent does everything else: DNS records, DKIM/SPF/DMARC verification,
engine sender rotation, engagement-first ramp, canary, Postmaster ingestion,
first send tests to Ryan's own inboxes.
