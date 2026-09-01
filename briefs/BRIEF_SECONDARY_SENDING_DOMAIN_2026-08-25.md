# Brief: secondary sending domain for the agent drip (2026-08-25)

Ryan's decision (2026-08-25): build our own deliverability stack instead of
paying a platform to wrap. Research summary in agent-email-v2 CHANGELOG
2026-08-25. The consumer gmail.com sender stays only for the Phase B cohort
test; the drip moves to a secondary domain with Google's own measurement
(Postmaster Tools) once it is warm.

## Design
- Domain: `lrghomesbuys.com` (available 2026-08-25, re-verified 2026-08-31;
  alternates lrghomes.co, lrghomesoffers.com, buylrghomes.com, lrgbuys.com).
  Registered at Cloudflare. (Correction 2026-08-31: lrghomes.com is NOT at
  Cloudflare — it is still registered at Squarespace on legacy Google Cloud
  DNS, expiring 2026-09-29. This will be Ryan's first Cloudflare zone.)
- Mail: added as a **secondary domain of the existing lrghomes Workspace**
  (Admin → Account → Domains → Add a domain). One user `ryan@lrghomesbuys.com`
  (~$7/mo). Same tenant, so no separate OAuth consent / 7-day token expiry.
  ⚠️ Caution (2026-08-31 audit): the existing DWD grant is authorized for
  `gmail.modify` ONLY — `gmail.send` is recorded as unauthorized
  (`lib/leads.ts:157`), and `scripts/add-email-mailbox.mjs` hard-rejects
  non-`@lrghomes.com` addresses. Verify/extend the DWD scope grant and relax
  the CLI's domain check before assuming sends work from the new domain.
- DNS on the new zone: MX (Google), SPF `v=spf1 include:_spf.google.com -all`,
  DKIM (2048-bit, generated in Admin → Apps → Gmail → Authenticate email),
  DMARC `v=DMARC1; p=quarantine; rua=mailto:dmarc@lrghomes.com; pct=100`,
  Postmaster Tools verification TXT. Reply-To on every send = ryan@lrghomes.com.
- Engine: multi-sender rotation (`CAMPAIGN_SENDERS` list, per-sender daily
  cap), engagement-first ramp (known repliers + Relationships agents before
  cohort strangers), daily canary with auto-pause, Postmaster reputation
  pulled daily into the health card once the v2 API is authorized.

## Warm-up plan (revised 2026-08-31 after deep research — see provenance below)

**Verdict from research: gradual ramp with real mail is provider-confirmed
(Google sender guidelines: "Increase sending volume slowly"; Microsoft
graylisting docs; M3AAWG BCP). Automated warm-up networks (Mailreach /
Instantly / Smartlead pools faking opens+replies) are the opposite: zero
controlled evidence, Google killed API-based warmup in 2023, Spamhaus lists
them as a blocklisting tactic, M3AAWG calls fake engagement "particularly
egregious". Hard rule: NO warm-up network tools, ever.**

Phase 0 — **domain aging (~2–4 weeks, before the first send):** register
immediately, put DNS/SPF/DKIM/DMARC + a simple redirect page live from day
one, then let the domain sit. Spamhaus ZRD auto-lists domains <24h old and
Spam Resource recommends ~30 days of age before commercial mail. Aging runs
concurrently with the Workspace/DNS setup steps, so it costs no extra time
if the domain is bought now.

| Week (of sending) | Volume/day | Who |
|---|---|---|
| 1 | 5–10 | agents who replied in July (37), Ryan's team, Relationships tier-1 agents — copy asks a question that invites a reply |
| 2 | 10–20 | remaining Relationships agents + repliers' follow-ups |
| 3–4 | 20–35 | cohort variants begin (same A/B/C test) |
| 5–6+ | 35–50 per mailbox | steady state; add a 2nd mailbox before exceeding 50/day |

Ramp rules (research-backed):
- **Gates are the ONLY advancement mechanism** — the week column is a floor,
  never a trigger. Gate to advance: Postmaster domain reputation High/Medium,
  spam rate <0.1%, canary Primary 3 days running, bounces <2%, and genuine
  replies still arriving. M3AAWG's average warm-up is ~6 weeks; Spam Resource
  has observed 5–8. Plan for 6, celebrate if gates clear faster.
- **Never more than double week-over-week** (Google: "immediately doubling
  previously sent volumes could result in rate limiting or reputation drops").
- **Consistency beats volume:** send every weekday, no gaps — provider
  reputation memory is ~30 days and lapses reset progress (M3AAWG, Braze).
- **Expect some spam-foldering in week 1** — Spam Resource says first-week
  junk placement during warm-up is normal and resolves; don't kill the ramp
  over day-3 placement, let the canary protocol (2-in-a-row rule) decide.
- IP warm-up is irrelevant here — Workspace sends on shared Google IPs;
  domain reputation is the only asset being built (Postmark, Google docs).

Audience framing (Ryan, 2026-08-31): this list is **re-engagement, not cold** —
he has marketed to these agents for years and has had real conversations with
many. That recognition is exactly what reputation systems reward, and it's why
the engagement-first ordering (repliers → relationships → cohort) leads. The
CAMPAIGN_VOICE ban on per-person history claims stands regardless — compose
can't verify which individual recipient actually spoke with Ryan.

Research provenance (2026-08-31, three independent sweeps — first-party docs,
neutral deliverability experts, cold-email ecosystem): Google sender
guidelines (support.google.com/a/answer/81126) + FAQ (a/answer/14229414);
M3AAWG Sending Domains BCP (m3aawg.org/SendingDomsBCP) + Position on Cold
Email (Nov 2025); Microsoft EXO graylisting doc; Yahoo Sender Hub; Word to
the Wise (wordtothewise.com 2014–2024 warm-up posts); Spam Resource
(spamresource.com domain-warming/aging/Workspace posts); Postmark, SendGrid,
Mailgun, AWS SES, Braze ramp docs; GMass warmup shutdown post-mortem
(gmass.co/blog/warmup-shutting-down); Spamhaus cold-email position (Jun 2025).
No provider publishes a numeric schedule — all day-by-day tables online are
vendor inventions; the numbers above are ours, run under provider-stated
constraints (spam <0.1%/0.3%, no sudden doubling, engaged-first, consistency).

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
